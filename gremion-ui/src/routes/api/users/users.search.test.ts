// @vitest-environment node
// What the member search finds, measured at the request Keycloak receives.
//
// The route runs through the real KeycloakAdminClient; only `fetch` is replaced, by a stand-in that answers
// GET /admin/realms/<realm>/users the way Keycloak 26 does (checked against a running 26.6.1):
//   - `search` is split on whitespace and every word must match one of username, e-mail, first or last name;
//   - a plain word matches the START of a field, `*word*` matches anywhere in it, `"word"` the whole field,
//     case-insensitively, and `%` and `_` are ordinary characters;
//   - a request that carries `search` never returns service accounts, one without it does;
//   - `enabled`, `first` and `max` are applied by Keycloak.
// A test here fails when the query string the route sends would not find the person in a real realm.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const BASE = 'http://kc-test:8080'

vi.mock('$lib/server/keycloak-admin', async (importActual) => {
  const actual = await importActual<typeof import('$lib/server/keycloak-admin')>()
  const clients = new Map<string, InstanceType<typeof actual.KeycloakAdminClient>>()
  return {
    ...actual,
    // As the real registry: one client per tenant id, on that tenant's realm.
    getKeycloakAdminClient: (t: { id: string; realmName: string }) => {
      let c = clients.get(t.id)
      if (!c) {
        c = new actual.KeycloakAdminClient(BASE, t.realmName, 'cid', 'secret')
        clients.set(t.id, c)
      }
      return c
    },
  }
})

import { GET } from './+server'

type FakeUser = { id: string; username: string; email?: string; firstName?: string; lastName?: string; enabled: boolean }

const REALMS: Record<string, FakeUser[]> = {
  'realm-a': [
    { id: 'a-test', username: 'test', firstName: 'test', lastName: 'test', email: 'test@alpha.example.org', enabled: true },
    { id: 'a-mira', username: 'm.kowalski', firstName: 'Mira', lastName: 'Kowalski', email: 'mira@council-sample.example.org', enabled: true },
    { id: 'a-joerg', username: 'u_score', firstName: 'Jörg', lastName: 'Müller-Öz', email: 'j_m@pct.example.org', enabled: true },
    { id: 'a-off', username: 'offline', firstName: 'Erika', lastName: 'Aus', email: 'erika@alpha.example.org', enabled: false },
    { id: 'a-sa', username: 'service-account-kernel-admin', enabled: true },
  ],
  'realm-b': [
    { id: 'b-canary', username: 'canary', firstName: 'Test', lastName: 'Elsewhere', email: 'canary@alpha.example.org', enabled: true },
  ],
}

const escapeRegExp = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')

function wordMatches(word: string, u: FakeUser): boolean {
  const fields = [u.username, u.email ?? '', u.firstName ?? '', u.lastName ?? ''].map((f) => f.toLowerCase())
  const w = word.toLowerCase()
  if (w.length >= 2 && w.startsWith('"') && w.endsWith('"')) return fields.includes(w.slice(1, -1))
  const like = w.endsWith('*') ? w : `${w}*`
  const re = new RegExp(`^${like.split('*').map(escapeRegExp).join('.*')}$`)
  return fields.some((f) => re.test(f))
}

function keycloakUsers(realm: string, q: URLSearchParams): FakeUser[] {
  let rows = [...(REALMS[realm] ?? [])].sort((a, b) => a.username.localeCompare(b.username))
  const search = q.get('search')
  if (search !== null) {
    const words = search.trim().split(/\s+/).filter(Boolean)
    rows = rows.filter((u) => !u.username.startsWith('service-account-') && words.every((w) => wordMatches(w, u)))
  }
  if (q.has('enabled')) rows = rows.filter((u) => String(u.enabled) === q.get('enabled'))
  const first = Number(q.get('first') ?? 0)
  const max = Number(q.get('max') ?? 100)
  return rows.slice(first, first + max)
}

let adminUrls: string[] = []

beforeEach(() => {
  adminUrls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.includes('/protocol/openid-connect/token')) {
        return new Response(JSON.stringify({ access_token: 't', expires_in: 300 }), { status: 200 })
      }
      adminUrls.push(url)
      const m = /\/admin\/realms\/([^/]+)\/users\?(.*)$/.exec(url)
      if (!m) return new Response('not found', { status: 404 })
      return new Response(JSON.stringify(keycloakUsers(decodeURIComponent(m[1]), new URLSearchParams(m[2]))), { status: 200 })
    }),
  )
})
afterEach(() => vi.unstubAllGlobals())

function event(query: string, tenant: 'a' | 'b' = 'a') {
  return {
    url: new URL(`http://x/api/users${query}`),
    locals: {
      auth: async () => ({ user: { id: 'caller', roles: ['it-admin'] } }),
      tenant: { id: `tenant-${tenant}`, realmName: `realm-${tenant}` },
    },
  } as never
}

async function find(term: string, tenant: 'a' | 'b' = 'a'): Promise<string[]> {
  const res = await GET(event(`?search=${encodeURIComponent(term)}&slim=true&max=10`, tenant))
  expect(res.status, term).toBe(200)
  return ((await res.json()) as { data: { id: string }[] }).data.map((u) => u.id).sort()
}

/** The `search` value of the one request Keycloak received. */
const sentSearch = () => new URL(adminUrls.at(-1)!).searchParams.get('search')

describe('member search: any part of a name or an e-mail address finds the person', () => {
  it('a single letter from the middle of a name finds everyone who carries it', async () => {
    expect(await find('e')).toEqual(['a-joerg', 'a-mira', 'a-test'])
  })

  it('the request sent for one letter is an infix search for enabled users of the caller\'s realm', async () => {
    await find('e')
    expect(adminUrls).toHaveLength(1)
    const u = new URL(adminUrls[0])
    expect(u.pathname).toBe('/admin/realms/realm-a/users')
    expect(Object.fromEntries(u.searchParams)).toEqual({ first: '0', max: '10', search: '*e*', enabled: 'true' })
  })

  it('a part of the e-mail domain finds the person', async () => {
    expect(await find('sample')).toEqual(['a-mira'])
    expect(await find('council-sam')).toEqual(['a-mira'])
    expect(await find('alpha.example')).toEqual(['a-test'])
  })

  it('a fragment from the middle or the end of a first or last name finds the person', async () => {
    expect(await find('owal')).toEqual(['a-mira'])
    expect(await find('ira')).toEqual(['a-mira'])
    expect(await find('ski')).toEqual(['a-mira'])
  })

  it('the start of a name still finds the person, as does the whole address', async () => {
    expect(await find('test')).toEqual(['a-test'])
    expect(await find('Mir')).toEqual(['a-mira'])
    expect(await find('mira@council-sample.example.org')).toEqual(['a-mira'])
  })

  it('upper and lower case and umlauts make no difference', async () => {
    expect(await find('KOWAL')).toEqual(['a-mira'])
    expect(await find('ö')).toEqual(['a-joerg'])
    expect(await find('ÜLLER')).toEqual(['a-joerg'])
  })

  it('several words must all match, in any order, each anywhere in a field', async () => {
    expect(await find('owalski ira')).toEqual(['a-mira'])
    expect(sentSearch()).toBe('*owalski* *ira*')
    expect(await find('ira   zzz')).toEqual([])
  })
})

describe('member search: characters with a meaning in Keycloak\'s search', () => {
  it('a term of only wildcards or quotes returns nothing and does not ask Keycloak (no realm dump)', async () => {
    for (const term of ['*', '**', '* *', '"', '""', '"*"', ' " * " ']) {
      expect(await find(term), term).toEqual([])
    }
    expect(adminUrls).toEqual([])
  })

  it('a typed * is not passed on as a wildcard and a typed quote does not switch to whole-field matching', async () => {
    expect(await find('m*i')).toEqual(['a-mira'])
    expect(sentSearch()).toBe('*m* *i*')
    expect(await find('"owal"')).toEqual(['a-mira'])
    expect(sentSearch()).toBe('*owal*')
    expect(await find('*est*')).toEqual(['a-test'])
    expect(sentSearch()).toBe('*est*')
  })

  it('% and _ are ordinary characters', async () => {
    expect(await find('_')).toEqual(['a-joerg'])
    expect(await find('%')).toEqual([])
  })

  it('a word typed twice is sent once', async () => {
    await find('ira IRA ira')
    expect(sentSearch()).toBe('*ira*')
  })

  it('more than eight words is a 400 and Keycloak is not asked', async () => {
    const res = await GET(event(`?search=${encodeURIComponent('a b c d e f g h i')}`))
    expect(res.status).toBe(400)
    expect(adminUrls).toEqual([])
    expect(await find('a b c d e f g h')).toEqual([])
  })
})

describe('member search: who is never returned', () => {
  it('a disabled account and a service account are left out, whatever matches', async () => {
    expect(await find('erika')).toEqual([])
    expect(await find('service')).toEqual([])
    expect(await find('a')).not.toContain('a-off')
    expect(await find('a')).not.toContain('a-sa')
  })

  it('a term that matches a person of another customer finds only the caller\'s own', async () => {
    expect(await find('alpha')).toEqual(['a-test'])
    expect(adminUrls.every((u) => u.startsWith(`${BASE}/admin/realms/realm-a/`))).toBe(true)
    expect(await find('alpha', 'b')).toEqual(['b-canary'])
  })

  it('no search term returns nothing and does not ask Keycloak', async () => {
    const res = await GET(event('?slim=true&max=10'))
    expect(((await res.json()) as { data: unknown[] }).data).toEqual([])
    expect(adminUrls).toEqual([])
  })
})
