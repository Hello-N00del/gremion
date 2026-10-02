// @vitest-environment node
// R29-F104-KTWIN (kernel twin of F1-FIX-04 / S3#33, D-3): the /members
// directory listed every person's memberships, committee_only units included,
// to every Member -- the same roster the committee pages and the members API
// hide from a Member outside the unit. The basic (non-admin) directory drops
// the memberships of units the viewer may not see, and a person whose every
// membership is hidden is not listed at all (listing them with no visible unit
// would tell the viewer that they sit in a hidden one).
//
// The role helper ($lib/auth) is REAL here on purpose.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Role } from '$lib/auth/types'

const UNITS: Record<string, { id: string; name: string; visibility: 'all_members' | 'committee_only' }> = {
  'u-closed': { id: 'u-closed', name: 'Closed', visibility: 'committee_only' },
  'u-open': { id: 'u-open', name: 'Open', visibility: 'all_members' },
}
// user id -> org units
const MEMBERSHIPS: Record<string, string[]> = {
  'uuid-anna': ['u-closed', 'u-open'],
  'viewer-insider': ['u-closed'],
  'uuid-ben': ['u-closed'],
}

const h = vi.hoisted(() => ({ getOrgUnitIdsForUser: vi.fn(), tlog: vi.fn() }))

const ANNA = { id: 'uuid-anna', username: 'anna', firstName: 'Anna', lastName: 'B', email: 'a@example.org', enabled: true }
const BEN = { id: 'uuid-ben', username: 'ben', firstName: 'Ben', lastName: 'C', email: 'b@example.org', enabled: true }

const kc = {
  listUserRoles: vi.fn(async () => [{ name: 'member' }]),
  listUserGroups: vi.fn(async () => [] as Array<{ name: string }>),
  listUsers: vi.fn(async () => [ANNA]),
}
vi.mock('$lib/server/keycloak-admin', () => ({
  getKeycloakAdminClient: () => kc,
  getKeycloakAdminClientForCurrentTenant: () => kc,
}))
vi.mock('$lib/server/governance/org-units-db', () => ({
  getOrgUnitIdsForUser: h.getOrgUnitIdsForUser,
  getOrgUnit: vi.fn(async (id: string) => UNITS[id] ?? null),
  isMemberOf: vi.fn(async (unitId: string, userId: string) => (MEMBERSHIPS[userId] ?? []).includes(unitId)),
  listOrgUnitMembers: vi.fn(async () => [
    { user_keycloak_id: 'uuid-anna', membership_type: 'elected', term_start: null, term_end: null },
  ]),
}))
vi.mock('$lib/server/observability/tenant-log', () => ({ tlog: h.tlog }))

import { listMembers } from './member-view'

const STRANGER = { id: 'viewer-stranger', roles: [Role.Member] }
const INSIDER = { id: 'viewer-insider', roles: [Role.Member] }

async function unitsSeenBy(viewer: { id: string; roles: Role[] }): Promise<string[]> {
  const members = await listMembers({ adminView: false, viewer })
  return members.flatMap((m) => m.memberships.map((x) => x.ou_key)).sort()
}

beforeEach(() => {
  kc.listUsers.mockReset().mockResolvedValue([ANNA])
  h.tlog.mockReset()
  h.getOrgUnitIdsForUser.mockReset().mockImplementation(async (id: string) => MEMBERSHIPS[id] ?? [])
})

describe('/members directory memberships follow D-3', () => {
  it('a Member outside a committee_only unit does not see who is in it', async () => {
    expect(await unitsSeenBy(STRANGER)).toEqual(['u-open'])
  })

  it('a member of the committee_only unit sees its memberships', async () => {
    expect(await unitsSeenBy(INSIDER)).toEqual(['u-closed', 'u-open'])
  })

  it('the person stays listed while a membership stays visible', async () => {
    const members = await listMembers({ adminView: false, viewer: STRANGER })
    expect(members.map((m) => m.id)).toEqual(['anna'])
  })

  it('a person placed only in a hidden unit is not listed to a Member outside it, but is to an insider', async () => {
    kc.listUsers.mockResolvedValue([ANNA, BEN])
    expect((await listMembers({ adminView: false, viewer: STRANGER })).map((m) => m.id)).toEqual(['anna'])
    expect((await listMembers({ adminView: false, viewer: INSIDER })).map((m) => m.id)).toEqual(['anna', 'ben'])
  })

  it('a failed lookup of the viewer\'s own units hides the committee_only memberships (fail closed) and is logged', async () => {
    h.getOrgUnitIdsForUser.mockImplementation(async (id: string) => {
      if (id.startsWith('viewer-')) throw new Error('db down')
      return MEMBERSHIPS[id] ?? []
    })
    expect(await unitsSeenBy(INSIDER)).toEqual(['u-open'])
    expect(h.tlog).toHaveBeenCalledWith('warn', expect.stringContaining('viewer unit lookup failed'), expect.anything())
  })

  it('no session sees no membership', async () => {
    expect(await listMembers({ adminView: false, viewer: null })).toEqual([])
  })

  it('the admin view keeps every membership', async () => {
    const members = await listMembers({ adminView: true, viewer: { id: 'admin', roles: [Role.CouncilAdmin] } })
    expect(members.flatMap((m) => m.memberships.map((x) => x.ou_key)).sort()).toEqual(['u-closed', 'u-open'])
  })
})
