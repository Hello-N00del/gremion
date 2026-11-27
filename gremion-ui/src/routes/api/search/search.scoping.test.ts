// @vitest-environment node
// One customer never finds another customer's items through the palette search.
//
// search.test.ts stands in for the data functions; this file does not. The real searchProtocols,
// listOrgUnits and getOrgUnitIdsForUser run through the real getDb() and pool registry, down to the
// pool of the current tenant. Two customers' pools are two fake SQL runners with different rows (the
// "canary" rows belong to customer B). A request resolved for customer A must read A's pool only, and
// the rows that come back must be A's.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Role } from '$lib/auth/types'

const h = vi.hoisted(() => ({
  tenant: { id: 'tenant-a', dbUrl: 'postgres://a', dbMax: 1, dbPrepare: false } as { id: string; dbUrl: string; dbMax: number; dbPrepare: boolean },
  queried: [] as string[],
}))

vi.mock('$lib/server/tenant/context', () => ({ requireTenant: () => h.tenant, currentTenantId: () => h.tenant.id }))
vi.mock('$lib/server/config', async (orig) => ({
  ...(await orig<typeof import('$lib/server/config')>()),
  readConfig: () => ({ modules: { calendar: true } }),
}))
vi.mock('$lib/server/keycloak-admin', async (importActual) => {
  const actual = await importActual<typeof import('$lib/server/keycloak-admin')>()
  return {
    ...actual,
    getKeycloakAdminClient: () => ({ listUsers: async () => [] }),
  }
})

interface Data {
  units: Array<{ id: string; name: string; visibility: 'all_members' | 'committee_only' }>
  protocols: Array<{ id: string; title: string; unit: string }>
  memberships: Record<string, string[]>
}
const DATA: Record<string, Data> = {
  'postgres://a': {
    units: [{ id: 'a-unit', name: 'Finanzen Alpha', visibility: 'all_members' }],
    protocols: [{ id: 'a-proto', title: 'Haushalt Alpha', unit: 'a-unit' }],
    memberships: {},
  },
  'postgres://b': {
    units: [{ id: 'b-unit', name: 'Finanzen Beta', visibility: 'all_members' }],
    protocols: [{ id: 'b-proto', title: 'Haushalt Beta', unit: 'b-unit' }],
    memberships: {},
  },
}

// A SQL runner that answers by the text of the statement, from one customer's rows.
function fakeSql(url: string) {
  const data = DATA[url]!
  return Object.assign(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      h.queried.push(url)
      const text = strings.join('?')
      if (text.includes('FROM protocols p')) {
        // The title match of the real statement: the pattern is the first parameter.
        const needle = String(values[0]).replace(/^%|%$/g, '').toLowerCase()
        return data.protocols.filter((p) => p.title.toLowerCase().includes(needle)).map((p) => {
          const u = data.units.find((x) => x.id === p.unit)!
          return { id: p.id, title: p.title, meetingDate: '2026-05-12', status: 'published', committeeId: u.id, committeeName: u.name, visibility: u.visibility }
        })
      }
      if (text.includes('FROM org_units ORDER BY name')) return data.units
      if (text.includes('FROM org_unit_members WHERE user_keycloak_id')) {
        return (data.memberships[String(values[0])] ?? []).map((id) => ({ org_unit_id: id }))
      }
      throw new Error(`unexpected statement: ${text}`)
    },
    { end: async () => undefined },
  )
}
vi.mock('@gremion/db', () => ({ createDb: (profile: { url: string }) => fakeSql(profile.url) }))

import { GET } from './+server'
import { _resetPoolRegistryForTests } from '$lib/server/db/pool-registry'

function event(q: string) {
  return {
    url: new URL(`http://x/api/search?q=${encodeURIComponent(q)}`),
    locals: {
      auth: async () => ({ user: { id: 'caller', roles: [Role.Member], groups: [], email: '', name: '' } }),
      tenant: { id: h.tenant.id, realmName: 'realm', config: {} },
    },
  } as never
}

async function search(q: string) {
  const res = await GET(event(q))
  expect(res.status).toBe(200)
  return ((await res.json()) as { data: { minutes: Array<{ id: string }>; units: Array<{ id: string }> } }).data
}

beforeEach(() => {
  _resetPoolRegistryForTests()
  h.queried = []
})

describe('palette search is scoped to the caller\'s customer', () => {
  it('customer A finds A\'s minutes and units and reads only A\'s pool', async () => {
    h.tenant = { id: 'tenant-a', dbUrl: 'postgres://a', dbMax: 1, dbPrepare: false }
    const found = await search('alpha')
    expect(found.minutes.map((m) => m.id)).toEqual(['a-proto'])
    expect(found.units.map((u) => u.id)).toEqual(['a-unit'])
    expect(new Set(h.queried)).toEqual(new Set(['postgres://a']))
  })

  it('customer B finds B\'s rows, and customer A\'s are never in them', async () => {
    h.tenant = { id: 'tenant-b', dbUrl: 'postgres://b', dbMax: 1, dbPrepare: false }
    const found = await search('haushalt')
    expect(found.minutes.map((m) => m.id)).toEqual(['b-proto'])
    expect((await search('finanzen')).units.map((u) => u.id)).toEqual(['b-unit'])
    expect(new Set(h.queried)).toEqual(new Set(['postgres://b']))
  })

  it('a search for the other customer\'s item finds nothing for the caller', async () => {
    h.tenant = { id: 'tenant-a', dbUrl: 'postgres://a', dbMax: 1, dbPrepare: false }
    // "Beta" is only in customer B's rows: A's caller finds nothing, and only A's pool was read.
    const found = await search('beta')
    expect(found.minutes).toEqual([])
    expect(found.units).toEqual([])
    expect(new Set(h.queried)).toEqual(new Set(['postgres://a']))
  })
})
