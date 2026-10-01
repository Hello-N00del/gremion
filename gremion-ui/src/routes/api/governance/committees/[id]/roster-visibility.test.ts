// R29-F104-KTWIN (kernel twin of F1-FIX-04 / S3#33, operator decision D-3): the
// committee roster endpoints answered ANY Member for ANY unit, committee_only
// included:
//   - GET .../[id]          the unit with its members, role holders and children
//   - GET .../[id]/members  member ids, names AND email addresses
//   - GET .../[id]/roles    role holders with their user ids
//   - GET .../[id]/history  the unit's membership history
// Now a committee_only unit's roster goes only to its members and CouncilAdmins;
// a hidden unit answers 404 exactly like a missing one, before any roster read.
// Email addresses go only to members of the same unit or a CouncilAdmin (data
// minimisation, DSGVO Art. 5(1)(c)).
//
// The role helper ($lib/auth) is REAL here on purpose.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Role } from '$lib/auth/types'

const UNITS: Record<string, { id: string; name: string; visibility: 'all_members' | 'committee_only' }> = {
  'u-closed': { id: 'u-closed', name: 'Closed', visibility: 'committee_only' },
  'u-open': { id: 'u-open', name: 'Open', visibility: 'all_members' },
}
const MEMBERSHIPS: Record<string, string[]> = { 'unit-member': ['u-closed'] }

const h = vi.hoisted(() => ({
  listRoles: vi.fn(),
  listHistory: vi.fn(),
  listOrgUnitMembers: vi.fn(),
  getChildOrgUnits: vi.fn(),
  getUser: vi.fn(),
}))

vi.mock('$lib/server/governance/org-units-db', () => ({
  getOrgUnit: vi.fn(async (id: string) => UNITS[id] ?? null),
  isMemberOf: vi.fn(async (unitId: string, userId: string) => (MEMBERSHIPS[userId] ?? []).includes(unitId)),
  getOrgUnitIdsForUser: vi.fn(async (userId: string) => MEMBERSHIPS[userId] ?? []),
  listOrgUnitMembers: h.listOrgUnitMembers,
  getChildOrgUnits: h.getChildOrgUnits,
  updateOrgUnit: vi.fn(),
  deleteOrgUnit: vi.fn(),
  hasMembers: vi.fn(),
  hasElections: vi.fn(),
  hasProtocols: vi.fn(),
}))
vi.mock('$lib/server/governance/governance-db', () => ({
  listRoles: h.listRoles,
  getActiveAssignment: vi.fn(async () => ({ user_keycloak_id: 'kc-holder' })),
  createRole: vi.fn(),
  listHistory: h.listHistory,
}))
vi.mock('$lib/server/governance/provisioning/orchestrator', () => ({
  deprovisionOrgUnit: vi.fn(),
  addMember: vi.fn(),
}))
vi.mock('$lib/server/audit-db', () => ({ writeAuditEntry: vi.fn() }))
vi.mock('$lib/server/keycloak-admin', () => ({
  getKeycloakAdminClient: () => ({ getUser: h.getUser }),
}))

import { GET as detailGET } from './+server'
import { GET as membersGET } from './members/+server'
import { GET as rolesGET } from './roles/+server'
import { GET as historyGET } from './history/+server'

const GUEST = { id: 'guest', roles: [Role.Guest] }
const STRANGER = { id: 'stranger', roles: [Role.Member] }
const UNIT_MEMBER = { id: 'unit-member', roles: [Role.Member] }
const ADMIN = { id: 'admin', roles: [Role.CouncilAdmin] }

type Handler = (e: never) => Promise<Response> | Response

function ev(user: unknown, id: string) {
  return { params: { id }, locals: { auth: async () => ({ user }), tenant: undefined } } as never
}

async function call(handler: Handler, user: unknown, id: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = (await handler(ev(user, id))) as Response
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

function clearReads() {
  h.listRoles.mockClear()
  h.listHistory.mockClear()
  h.listOrgUnitMembers.mockClear()
  h.getChildOrgUnits.mockClear()
  h.getUser.mockClear()
}

beforeEach(() => {
  h.listRoles.mockReset().mockResolvedValue([{ id: 'role-1', name: 'Vorsitz' }])
  h.listHistory.mockReset().mockResolvedValue([{ id: 'h1', user_keycloak_id: 'kc-1' }])
  h.listOrgUnitMembers.mockReset().mockImplementation(async (unitId: string) => [
    { id: 'm1', org_unit_id: unitId, user_keycloak_id: 'kc-1', membership_type: 'elected', voting: true },
    { id: 'm2', org_unit_id: unitId, user_keycloak_id: 'unit-member', membership_type: 'elected', voting: true },
  ])
  h.getChildOrgUnits.mockReset().mockResolvedValue([])
  h.getUser.mockReset().mockImplementation(async (id: string) => ({
    id, email: `${id}@example.org`, firstName: 'F', lastName: id, username: id,
  }))
})

const ROSTER: Array<[string, Handler]> = [
  ['detail', detailGET as Handler],
  ['members', membersGET as Handler],
  ['roles', rolesGET as Handler],
  ['history', historyGET as Handler],
]

describe('committee roster endpoints follow D-3', () => {
  it.each(ROSTER)('%s: a Member outside a committee_only unit gets 404 and nothing is read', async (_n, handler) => {
    clearReads()
    const { status, body } = await call(handler, STRANGER, 'u-closed')
    expect(status).toBe(404)
    expect(body.success).toBe(false)
    expect(body.data).toBeUndefined()
    expect(h.listOrgUnitMembers).not.toHaveBeenCalled()
    expect(h.listRoles).not.toHaveBeenCalled()
    expect(h.listHistory).not.toHaveBeenCalled()
    expect(h.getChildOrgUnits).not.toHaveBeenCalled()
    expect(h.getUser).not.toHaveBeenCalled()
  })

  it.each(ROSTER)('%s: the 404 for a hidden unit equals the one for a missing unit', async (_n, handler) => {
    const hidden = await call(handler, STRANGER, 'u-closed')
    const missing = await call(handler, STRANGER, 'u-missing')
    expect(hidden).toEqual(missing)
  })

  it.each(ROSTER)('%s: a Member outside an all_members unit still reads it', async (_n, handler) => {
    expect((await call(handler, STRANGER, 'u-open')).status).toBe(200)
  })

  it.each(ROSTER)('%s: a member of the committee_only unit and a CouncilAdmin read it', async (_n, handler) => {
    for (const user of [UNIT_MEMBER, ADMIN]) {
      expect((await call(handler, user, 'u-closed')).status).toBe(200)
    }
  })

  it.each(ROSTER)('%s: a Guest gets 403 before any read', async (_n, handler) => {
    clearReads()
    expect((await call(handler, GUEST, 'u-open')).status).toBe(403)
    expect(h.listOrgUnitMembers).not.toHaveBeenCalled()
  })

  it('a CouncilAdmin needs no membership query for the detail', async () => {
    const { isMemberOf } = await import('$lib/server/governance/org-units-db')
    vi.mocked(isMemberOf).mockClear()
    await call(detailGET as Handler, ADMIN, 'u-closed')
    expect(isMemberOf).not.toHaveBeenCalled()
  })
})

describe('GET .../members: email addresses only for the unit and CouncilAdmins', () => {
  it('a Member outside an all_members unit sees the members but NO email address', async () => {
    const { status, body } = await call(membersGET as Handler, STRANGER, 'u-open')
    expect(status).toBe(200)
    const data = body.data as Array<Record<string, unknown>>
    expect(data).toHaveLength(2)
    for (const m of data) expect(m.email ?? null).toBeNull()
    expect(data.map((m) => m.name)).toEqual(['F kc-1', 'F unit-member'])
  })

  it('a member of the unit and a CouncilAdmin see the email addresses', async () => {
    for (const user of [UNIT_MEMBER, ADMIN]) {
      const { status, body } = await call(membersGET as Handler, user, 'u-closed')
      expect(status).toBe(200)
      expect((body.data as Array<{ email: string }>).map((m) => m.email)).toEqual([
        'kc-1@example.org',
        'unit-member@example.org',
      ])
    }
  })
})
