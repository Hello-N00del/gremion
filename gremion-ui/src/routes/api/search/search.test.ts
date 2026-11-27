// @vitest-environment node
// The command palette's search endpoint: GET /api/search?q=...
//
// What a signed-in person finds is exactly what the target pages would show them:
//   minutes   Member and up, through the ONE visibility rule (governance/visibility.ts, real here)
//   units     Member and up, the units the unit page lets them open
//   people    Member and up, enabled and placed people with a visible unit; e-mail only for admins
//   events    the calendar page's own role and the calendar module's own on/off switch
// The role helper and the visibility rule are REAL on purpose (a mocked hasRole makes every caller an admin).
// Keycloak is the real admin client with `fetch` replaced, as in users.search.test.ts, so a realm canary
// shows which realm the request went to.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Role } from '$lib/auth/types'

const BASE = 'http://kc-test:8080'

const h = vi.hoisted(() => ({
  config: { modules: { calendar: true } } as { modules: Record<string, boolean> },
}))

vi.mock('$lib/server/config', async (orig) => ({
  ...(await orig<typeof import('$lib/server/config')>()),
  readConfig: () => h.config,
}))

vi.mock('$lib/server/keycloak-admin', async (importActual) => {
  const actual = await importActual<typeof import('$lib/server/keycloak-admin')>()
  const clients = new Map<string, InstanceType<typeof actual.KeycloakAdminClient>>()
  return {
    ...actual,
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

type Status = 'draft' | 'submitted' | 'published'
interface Unit { id: string; name: string; visibility: 'all_members' | 'committee_only' }

const UNITS: Record<string, Unit> = {
  'u-fin': { id: 'u-fin', name: 'Finanzen', visibility: 'all_members' },
  'u-closed': { id: 'u-closed', name: 'Vorstandsklausur', visibility: 'committee_only' },
}
const MEMBERSHIPS: Record<string, string[]> = {
  insider: ['u-closed'],
  'a-mira': ['u-fin'],
  'a-secret': ['u-closed'],
  'a-both': ['u-closed', 'u-fin'],
  'a-off': ['u-fin'],
}
interface Proto { id: string; title: string; body: string; date: string; status: Status; unit: string }
const PROTOCOLS: Proto[] = [
  { id: 'p1', title: 'Haushaltsplan 2026', body: '<p>Der Etat wurde beschlossen</p>', date: '2026-05-12', status: 'published', unit: 'u-fin' },
  { id: 'p2', title: 'Haushaltsentwurf', body: '', date: '2026-04-01', status: 'draft', unit: 'u-fin' },
  { id: 'p3', title: 'Haushalt Vorstand intern', body: '', date: '2026-03-01', status: 'published', unit: 'u-closed' },
  { id: 'p4', title: 'Haushalt Klausur Entwurf', body: '', date: '2026-02-01', status: 'draft', unit: 'u-closed' },
]
const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')

vi.mock('$lib/server/governance/protocols-db', () => ({
  // The real function filters in SQL; this stand-in applies the same fields: title, body text, date.
  searchProtocols: vi.fn(async (query: string, limit: number) =>
    PROTOCOLS.filter((p) => {
      const hay = fold(`${p.title} ${p.body.replace(/<[^>]*>/g, ' ')} ${p.date} ${p.date.split('-').reverse().join('.')}`)
      return hay.includes(fold(query))
    })
      .slice(0, limit)
      .map((p) => ({
        id: p.id,
        title: p.title,
        meetingDate: p.date,
        status: p.status,
        committeeId: p.unit,
        committeeName: UNITS[p.unit]!.name,
        visibility: UNITS[p.unit]!.visibility,
      })),
  ),
}))

vi.mock('$lib/server/governance/org-units-db', () => ({
  listOrgUnits: vi.fn(async () => Object.values(UNITS)),
  getOrgUnit: vi.fn(async (id: string) => UNITS[id] ?? null),
  isMemberOf: vi.fn(async (unitId: string, userId: string) => (MEMBERSHIPS[userId] ?? []).includes(unitId)),
  getOrgUnitIdsForUser: vi.fn(async (userId: string) => MEMBERSHIPS[userId] ?? []),
}))

import { GET } from './+server'
import {
  registerDataProvider,
  _resetRuntimeRegistryForTests,
} from '$lib/server/modules/runtime-registry'
import { searchProtocols } from '$lib/server/governance/protocols-db'
import { getOrgUnitIdsForUser } from '$lib/server/governance/org-units-db'
import { searchForPalette } from '$lib/server/search/palette-search'

type FakeUser = { id: string; username: string; email: string; firstName: string; lastName: string; enabled: boolean }
const user = (id: string, first: string, last: string, enabled = true): FakeUser => ({
  id,
  username: id,
  email: `${id}@council-sample.example.org`,
  firstName: first,
  lastName: last,
  enabled,
})
const REALMS: Record<string, FakeUser[]> = {
  'realm-a': [
    user('a-mira', 'Mira', 'Kowalski'),
    user('a-secret', 'Selma', 'Geheim'),
    user('a-both', 'Boris', 'Beides'),
    user('a-unplaced', 'Ulf', 'Ungesetzt'),
    user('a-off', 'Olga', 'Offline', false),
    { id: 'a-sa', username: 'service-account-kernel-admin', email: '', firstName: '', lastName: '', enabled: true },
  ],
  'realm-b': [user('b-canary', 'Mira', 'Elsewhere')],
}
const escapeRegExp = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
function wordMatches(word: string, u: FakeUser): boolean {
  const fields = [u.username, u.email, u.firstName, u.lastName].map((f) => f.toLowerCase())
  const w = word.toLowerCase()
  const re = new RegExp(`^${w.split('*').map(escapeRegExp).join('.*')}$`)
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

const GUEST = { id: 'guest', roles: [Role.Guest] }
const STRANGER = { id: 'stranger', roles: [Role.Member] }
const INSIDER = { id: 'insider', roles: [Role.Member] }
const ADMIN = { id: 'admin', roles: [Role.CouncilAdmin] }
type Caller = { id: string; roles: Role[] }

beforeEach(() => {
  adminUrls = []
  h.config = { modules: { calendar: true } }
  _resetRuntimeRegistryForTests()
  vi.mocked(searchProtocols).mockClear()
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

function event(q: string | null, caller: Caller | null = STRANGER, tenant: 'a' | 'b' | null = 'a') {
  return {
    url: new URL(`http://x/api/search${q === null ? '' : `?q=${encodeURIComponent(q)}`}`),
    locals: {
      auth: async () => (caller ? { user: { ...caller, groups: [], email: '', name: '' } } : null),
      tenant: tenant ? { id: `tenant-${tenant}`, realmName: `realm-${tenant}`, config: {} } : undefined,
    },
  } as never
}

interface Hit { id: string; label: string; hint: string | null; href: string }
interface Found { minutes: Hit[]; events: Hit[]; units: Hit[]; people: Hit[] }

async function search(q: string, caller: Caller | null = STRANGER, tenant: 'a' | 'b' | null = 'a'): Promise<Found> {
  const res = await GET(event(q, caller, tenant))
  expect(res.status, q).toBe(200)
  const body = (await res.json()) as { success: boolean; data: Found }
  expect(body.success).toBe(true)
  return body.data
}
const ids = (hits: Hit[]) => hits.map((h) => h.id).sort()

describe('guards and bounds', () => {
  it('401 without a session', async () => {
    expect((await GET(event('haushalt', null))).status).toBe(401)
  })

  it('403 without a tenant', async () => {
    expect((await GET(event('haushalt', STRANGER, null))).status).toBe(403)
  })

  it('a query under two characters, missing or blank asks nobody and answers empty', async () => {
    const provider = vi.fn(async () => [])
    registerDataProvider('calendar:search-events', provider)
    for (const q of ['', ' ', 'h', ' h ', '  ']) {
      expect(await search(q)).toEqual({ minutes: [], events: [], units: [], people: [] })
    }
    const res = await GET(event(null))
    expect(res.status).toBe(200)
    expect(searchProtocols).not.toHaveBeenCalled()
    expect(provider).not.toHaveBeenCalled()
    expect(adminUrls).toEqual([])
  })

  it('a query over 100 characters is a 400', async () => {
    expect((await GET(event('x'.repeat(101)))).status).toBe(400)
  })

  it('a query of 100 characters is accepted', async () => {
    expect((await GET(event('x'.repeat(100)))).status).toBe(200)
  })
})

describe('minutes', () => {
  it('a Member finds title, body text and date, with a link to the protocol page', async () => {
    const byTitle = await search('haushaltsplan')
    expect(byTitle.minutes).toEqual([
      { id: 'p1', label: 'Haushaltsplan 2026', hint: '12.05.2026 · Finanzen', href: '/members/committees/u-fin/protokolle/p1' },
    ])
    expect(ids((await search('etat wurde')).minutes)).toEqual(['p1'])
    expect(ids((await search('12.05.2026')).minutes)).toEqual(['p1'])
    expect(ids((await search('2026-05-12')).minutes)).toEqual(['p1'])
  })

  it('markup in the body is not searched', async () => {
    expect((await search('<p>')).minutes).toEqual([])
  })

  it('a Member who is in no unit finds the all_members drafts and published minutes, never a committee_only unit\'s', async () => {
    expect(ids((await search('haushalt', STRANGER)).minutes)).toEqual(['p1', 'p2'])
  })

  it('a unit member also finds the minutes of their committee_only unit', async () => {
    expect(ids((await search('haushalt', INSIDER)).minutes)).toEqual(['p1', 'p2', 'p3', 'p4'])
  })

  it('an admin finds everything', async () => {
    expect(ids((await search('haushalt', ADMIN)).minutes)).toEqual(['p1', 'p2', 'p3', 'p4'])
  })

  it('a Guest finds no minutes: the protocol page is a Member page', async () => {
    expect((await search('haushalt', GUEST)).minutes).toEqual([])
    expect(searchProtocols).not.toHaveBeenCalled()
  })

  it('the cap applies AFTER the visibility filter, so hidden rows do not use up a person\'s results', async () => {
    const many: Proto[] = Array.from({ length: 30 }, (_, i) => ({
      id: `h${i}`, title: `Haushalt hidden ${i}`, body: '', date: '2026-01-01', status: 'published' as Status, unit: 'u-closed',
    }))
    PROTOCOLS.unshift(...many)
    try {
      expect(ids((await search('haushalt', STRANGER)).minutes)).toEqual(['p1', 'p2'])
    } finally {
      PROTOCOLS.splice(0, many.length)
    }
  })
})

describe('units', () => {
  it('a Member finds an all_members unit by name, with a link to the unit page', async () => {
    expect((await search('finanz')).units).toEqual([
      { id: 'u-fin', label: 'Finanzen', hint: null, href: '/members/committees/u-fin' },
    ])
  })

  it('a committee_only unit is found by its members and admins only', async () => {
    expect((await search('vorstand', STRANGER)).units).toEqual([])
    expect(ids((await search('vorstand', INSIDER)).units)).toEqual(['u-closed'])
    expect(ids((await search('vorstand', ADMIN)).units)).toEqual(['u-closed'])
  })

  it('a Guest finds no units: the unit page is a Member page', async () => {
    expect((await search('finanz', GUEST)).units).toEqual([])
  })
})

describe('people', () => {
  it('finds a placed person by a part of the name, shows the visible unit, never an e-mail address', async () => {
    const found = await search('kowal')
    expect(found.people).toEqual([{ id: 'a-mira', label: 'Mira Kowalski', hint: 'Finanzen', href: '/members?member=a-mira' }])
    expect(JSON.stringify(found)).not.toContain('@')
    expect(JSON.stringify(found)).not.toContain('council-sample')
  })

  it('a non-admin cannot find a person by e-mail address, not even by a fragment of it', async () => {
    expect((await search('mira@council-sample.example.org')).people).toEqual([])
    expect((await search('council-sample')).people).toEqual([])
    expect((await search('a-mira')).people).toEqual([])
  })

  it('a query of more words than the people list allows asks Keycloak for nobody; eight words still do', async () => {
    const nine = 'a1 b2 c3 d4 e5 f6 g7 h8 i9'
    expect((await search(nine, ADMIN)).people).toEqual([])
    expect(adminUrls.filter((u) => u.includes('/users?'))).toEqual([])
    expect((await search(nine.split(' ').slice(0, 8).join(' '), ADMIN)).people).toEqual([])
    expect(adminUrls.filter((u) => u.includes('/users?'))).toHaveLength(1)
  })

  it('several words must all be part of the name, in any order', async () => {
    expect(ids((await search('kowalski mira')).people)).toEqual(['a-mira'])
    expect((await search('mira geheim')).people).toEqual([])
  })

  it('a person whose only unit is hidden from the caller is not found, one with a visible unit as well is', async () => {
    expect((await search('geheim', STRANGER)).people).toEqual([])
    expect(ids((await search('geheim', INSIDER)).people)).toEqual(['a-secret'])
    const both = (await search('beides', STRANGER)).people
    expect(both).toEqual([{ id: 'a-both', label: 'Boris Beides', hint: 'Finanzen', href: '/members?member=a-both' }])
  })

  it('an unplaced person, a disabled one and a service account are not found by a non-admin', async () => {
    expect((await search('ungesetzt')).people).toEqual([])
    expect((await search('offline')).people).toEqual([])
    expect((await search('kernel')).people).toEqual([])
  })

  it('an admin finds unplaced and disabled people too, by name or by e-mail, and sees the e-mail address', async () => {
    const byName = await search('ungesetzt', ADMIN)
    expect(byName.people).toEqual([
      { id: 'a-unplaced', label: 'Ulf Ungesetzt', hint: 'a-unplaced@council-sample.example.org', href: '/members?member=a-unplaced' },
    ])
    expect(ids((await search('offline', ADMIN)).people)).toEqual(['a-off'])
    expect(ids((await search('a-mira@council', ADMIN)).people)).toEqual(['a-mira'])
    expect(ids((await search('kernel', ADMIN)).people)).toEqual([])
  })

  it('an account whose user name is an e-mail address never leaks it to a non-admin: not in the label, the id or the link', async () => {
    REALMS['realm-a']!.push(
      { id: 'a-mail', username: 'jan.beispiel@council-sample.example.org', email: 'jan.beispiel@council-sample.example.org', firstName: 'Jan', lastName: 'Beispiel', enabled: true },
      { id: 'a-nameless', username: 'nameless.person@council-sample.example.org', email: 'nameless.person@council-sample.example.org', firstName: '', lastName: '', enabled: true },
    )
    MEMBERSHIPS['a-mail'] = ['u-fin']
    MEMBERSHIPS['a-nameless'] = ['u-fin']
    try {
      const found = await search('beispiel')
      expect(found.people).toHaveLength(1)
      expect(found.people[0]!.label).toBe('Jan Beispiel')
      expect(found.people[0]!.href).toBe('/members')
      expect(JSON.stringify(found)).not.toContain('@')
      // A person with no name at all cannot be shown without the address: not found.
      expect((await search('nameless')).people).toEqual([])
      expect(JSON.stringify(await search('nameless'))).not.toContain('@')
      // An admin sees the directory as it is.
      expect((await search('beispiel', ADMIN)).people[0]!.href).toContain('/members?member=')
    } finally {
      REALMS['realm-a']!.splice(-2)
      delete MEMBERSHIPS['a-mail']
      delete MEMBERSHIPS['a-nameless']
    }
  })

  it('a Guest finds no people: the member directory is a Member page', async () => {
    expect((await search('kowal', GUEST)).people).toEqual([])
    expect(adminUrls).toEqual([])
  })

  it('asks the caller\'s realm only: the other customer\'s person is never found', async () => {
    expect(ids((await search('mira', ADMIN, 'a')).people)).toEqual(['a-mira'])
    expect(new URL(adminUrls.at(-1)!).pathname).toBe('/admin/realms/realm-a/users')
    expect(ids((await search('mira', ADMIN, 'b')).people)).toEqual(['b-canary'])
    expect(new URL(adminUrls.at(-1)!).pathname).toBe('/admin/realms/realm-b/users')
    expect(ids((await search('elsewhere', ADMIN, 'a')).people)).toEqual([])
  })

  it('a * or a " typed into the query never reaches Keycloak as a wildcard or a quote', async () => {
    expect((await search('**')).people).toEqual([])
    expect(adminUrls).toEqual([])
    await search('m*ra')
    expect(new URL(adminUrls.at(-1)!).searchParams.get('search')).toBe('*m* *ra*')
  })

  it('at most five people come back', async () => {
    REALMS['realm-a']!.push(...Array.from({ length: 9 }, (_, i) => user(`a-many${i}`, 'Vielfach', `Nummer${i}`)))
    for (let i = 0; i < 9; i++) MEMBERSHIPS[`a-many${i}`] = ['u-fin']
    try {
      expect((await search('vielfach')).people).toHaveLength(5)
    } finally {
      REALMS['realm-a']!.splice(-9)
      for (let i = 0; i < 9; i++) delete MEMBERSHIPS[`a-many${i}`]
    }
  })
})

describe('events', () => {
  const rows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `e${i}`,
      title: `Plenum ${i}`,
      startAt: new Date(Date.UTC(2026, 11, 3, 17, 0) + i * 86_400_000),
      allDay: false,
    }))

  it('asks the calendar provider and links to the calendar on the event\'s day, with the German date', async () => {
    const provider = vi.fn(async () => rows(1))
    registerDataProvider('calendar:search-events', provider)
    const found = await search('plenum')
    expect(provider).toHaveBeenCalledWith({ query: 'plenum', limit: 5 })
    expect(found.events).toEqual([{ id: 'e0', label: 'Plenum 0', hint: '03.12.2026', href: '/calendar?date=2026-12-03' }])
  })

  it('a Guest may search events: the calendar page is open to a Guest', async () => {
    registerDataProvider('calendar:search-events', async () => rows(1))
    expect(ids((await search('plenum', GUEST)).events)).toEqual(['e0'])
  })

  it('at most five events come back even when the provider hands back more', async () => {
    registerDataProvider('calendar:search-events', async () => rows(9))
    expect((await search('plenum')).events).toHaveLength(5)
  })

  it('a calendar the customer switched off yields no events and the provider is not asked', async () => {
    const provider = vi.fn(async () => rows(2))
    registerDataProvider('calendar:search-events', provider)
    h.config = { modules: { calendar: false } }
    expect((await search('plenum')).events).toEqual([])
    expect(provider).not.toHaveBeenCalled()
  })

  it('no calendar module (no provider) yields no events', async () => {
    expect((await search('plenum')).events).toEqual([])
  })

  it('a build without the calendar module (no calendar page entry) yields no events and the other kinds still answer', async () => {
    // canAccess throws for an unknown page key in development; a missing calendar must not fail the search.
    const provider = vi.fn(async () => rows(1))
    registerDataProvider('calendar:search-events', provider)
    const kc = { listUsers: async () => [] } as never
    const found = await searchForPalette({
      query: 'haushaltsplan',
      user: STRANGER,
      kc,
      pageAccess: { members: Role.Member },
      calendarOn: true,
    })
    expect(found.events).toEqual([])
    expect(ids(found.minutes)).toEqual(['p1'])
    expect(provider).not.toHaveBeenCalled()
  })

  it('a provider that throws degrades to no events and the other kinds still answer', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    registerDataProvider('calendar:search-events', async () => {
      throw new Error('db down: secret-term')
    })
    const found = await search('haushaltsplan')
    expect(found.events).toEqual([])
    expect(ids(found.minutes)).toEqual(['p1'])
    expect(JSON.stringify(err.mock.calls)).not.toContain('haushaltsplan')
    err.mockRestore()
  })
})

describe('result cap', () => {
  it('at most five minutes and five units', async () => {
    const many: Proto[] = Array.from({ length: 9 }, (_, i) => ({
      id: `m${i}`, title: `Sammelprotokoll ${i}`, body: '', date: '2026-01-01', status: 'published' as Status, unit: 'u-fin',
    }))
    PROTOCOLS.push(...many)
    const unitIds = Array.from({ length: 9 }, (_, i) => `u-s${i}`)
    for (const id of unitIds) UNITS[id] = { id, name: `Sammelgruppe ${id}`, visibility: 'all_members' }
    try {
      const found = await search('sammel')
      expect(found.minutes).toHaveLength(5)
      expect(found.units).toHaveLength(5)
    } finally {
      PROTOCOLS.splice(-9)
      for (const id of unitIds) delete UNITS[id]
    }
  })
})

describe('a failed membership lookup', () => {
  // The caller belongs to the committee_only unit, but asking which units they belong to fails.
  // Every kind then answers as it would for a person with no unit: nothing committee_only.
  it('shows only what needs no membership, in all three kinds', async () => {
    const real = vi.mocked(getOrgUnitIdsForUser).getMockImplementation()!
    vi.mocked(getOrgUnitIdsForUser).mockImplementation(async (id: string) => {
      if (id === 'insider') throw new Error('lookup failed')
      return real(id)
    })
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      expect(ids((await search('haushalt', INSIDER)).minutes)).toEqual(['p1', 'p2'])
      expect((await search('vorstandsklausur', INSIDER)).units).toEqual([])
      expect(ids((await search('finanzen', INSIDER)).units)).toEqual(['u-fin'])
      expect((await search('geheim', INSIDER)).people).toEqual([])
      expect(ids((await search('beides', INSIDER)).people)).toEqual(['a-both'])
    } finally {
      vi.mocked(getOrgUnitIdsForUser).mockImplementation(real)
      quiet.mockRestore()
    }
  })
})
