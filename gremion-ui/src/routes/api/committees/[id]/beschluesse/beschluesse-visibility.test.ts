// R29-F104-KTWIN (kernel twin of F1-FIX-04 / S3#39, operator decision D-3): the
// Beschlussregister of a unit answered any signed-in user, Guests included, for
// every unit (committee_only too). Now the register of a committee_only unit is
// visible only to its members and CouncilAdmins, and a Guest sees the published
// resolutions of an all_members unit. A hidden unit answers like a missing one.
//
// The role helper ($lib/auth) is REAL here on purpose.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Role } from '$lib/auth/types'

const UNITS: Record<string, { id: string; visibility: 'all_members' | 'committee_only' }> = {
  'u-closed': { id: 'u-closed', visibility: 'committee_only' },
  'u-open': { id: 'u-open', visibility: 'all_members' },
}
const MEMBERSHIPS: Record<string, string[]> = { 'unit-member': ['u-closed'] }

const h = vi.hoisted(() => ({ sqlCalls: 0, settingsCalls: 0 }))

vi.mock('$lib/server/governance/org-units-db', () => ({
  getOrgUnit: vi.fn(async (id: string) => UNITS[id] ?? null),
  isMemberOf: vi.fn(async (unitId: string, userId: string) => (MEMBERSHIPS[userId] ?? []).includes(unitId)),
}))
vi.mock('$lib/server/protocols/protocol-db', () => ({
  getBeschlussregisterSettings: vi.fn(async (committeeId: string) => {
    h.settingsCalls++
    return { committee_id: committeeId, include_protocols: true, include_polls: false, include_elections: true }
  }),
}))
vi.mock('$lib/server/db', () => ({
  getDb: () => (() => {
    h.sqlCalls++
    return Promise.resolve([{ id: 'r1', type: 'beschluss', text: 'Beschluss' }])
  }),
}))

import { GET } from './+server'

const GUEST = { id: 'guest', roles: [Role.Guest], groups: [], email: 'g@example.org', name: 'g' }
const STRANGER = { id: 'stranger', roles: [Role.Member], groups: [], email: 's@example.org', name: 's' }
const UNIT_MEMBER = { id: 'unit-member', roles: [Role.Member], groups: [], email: 'm@example.org', name: 'm' }
const ADMIN = { id: 'admin', roles: [Role.CouncilAdmin], groups: [], email: 'a@example.org', name: 'a' }

function ev(user: unknown, id: string) {
  return {
    params: { id },
    locals: { user },
    url: new URL(`http://localhost/api/committees/${id}/beschluesse`),
  } as never
}

async function statusOf(run: () => Promise<Response>): Promise<number> {
  try {
    return (await run()).status
  } catch (e) {
    return (e as { status?: number })?.status ?? -1
  }
}

beforeEach(() => {
  h.sqlCalls = 0
  h.settingsCalls = 0
})

describe('GET /api/committees/[id]/beschluesse -- visibility (D-3)', () => {
  it('a Guest and a non-member Member get a 404 for a committee_only unit, and nothing is read', async () => {
    for (const user of [GUEST, STRANGER]) {
      expect(await statusOf(() => GET(ev(user, 'u-closed')))).toBe(404)
    }
    expect(h.sqlCalls).toBe(0)
    expect(h.settingsCalls).toBe(0)
  })

  it('a Guest sees the published resolutions of an all_members unit', async () => {
    const res = await GET(ev(GUEST, 'u-open'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { entries: Array<{ type: string }> }
    expect(body.entries.map((e) => e.type)).toEqual(['beschluss'])
  })

  it('a member of the committee_only unit and a CouncilAdmin read its register', async () => {
    for (const user of [UNIT_MEMBER, ADMIN]) {
      expect(await statusOf(() => GET(ev(user, 'u-closed')))).toBe(200)
    }
  })

  it('an unknown unit is a 404, the same answer as a hidden one', async () => {
    expect(await statusOf(() => GET(ev(ADMIN, 'u-missing')))).toBe(404)
  })
})
