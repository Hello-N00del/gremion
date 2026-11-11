// assign.admin-only.test.ts -- E2E finding 6(b): the office-assignment call is the one the committee page
// uses. An admin gets 201 and the stored assignment back; anyone else gets 403 and nothing is written.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Role } from '$lib/auth'

const h = vi.hoisted(() => ({
  createAssignment: vi.fn(),
  getActiveAssignment: vi.fn(),
  archiveAssignment: vi.fn(),
  scheduleNotifications: vi.fn(),
  listOrgUnitMembers: vi.fn(),
  reconcile: vi.fn(),
  kc: vi.fn(),
}))

vi.mock('$lib/server/governance/governance-db', () => ({
  createAssignment: h.createAssignment,
  getActiveAssignment: h.getActiveAssignment,
  archiveAssignment: h.archiveAssignment,
  scheduleNotifications: h.scheduleNotifications,
}))
vi.mock('$lib/server/governance/org-units-db', () => ({ listOrgUnitMembers: h.listOrgUnitMembers }))
vi.mock('$lib/server/governance/role-group-reconcile', () => ({ reconcileUserRoleGroups: h.reconcile }))
vi.mock('$lib/server/keycloak-admin', () => ({ getKeycloakAdminClientForCurrentTenant: h.kc }))

const { POST } = await import('./+server')

const user = (roles: string[]) => ({ id: 'caller', roles, groups: [], email: 'c@example.org', name: 'c' })
const body = { userKeycloakId: 'u-ben', startDate: '2026-11-11', endDate: '2027-11-11' }

function event(roles: string[] | null) {
  return {
    params: { id: 'ou-1', roleId: 'role-1' },
    request: new Request('http://stura.test/api/governance/committees/ou-1/roles/role-1/assign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    locals: { auth: async () => (roles ? { user: user(roles) } : null) },
  } as never
}

beforeEach(() => {
  vi.clearAllMocks()
  h.getActiveAssignment.mockResolvedValue(null)
  h.listOrgUnitMembers.mockResolvedValue([])
  h.kc.mockReturnValue({ listGroups: async () => [] })
  h.reconcile.mockResolvedValue(undefined)
  h.createAssignment.mockImplementation(async (d: { roleId: string; userKeycloakId: string }) => ({
    id: 'a-1', role_id: d.roleId, user_keycloak_id: d.userKeycloakId, status: 'active',
  }))
})

describe('POST /api/governance/committees/[id]/roles/[roleId]/assign', () => {
  it('lets a CouncilAdmin assign the office and returns the stored assignment', async () => {
    const res = await POST(event([Role.CouncilAdmin]))
    expect(res.status).toBe(201)
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(json.data).toMatchObject({ role_id: 'role-1', user_keycloak_id: 'u-ben', status: 'active' })
    expect(h.createAssignment).toHaveBeenCalledTimes(1)
  })

  it('answers 403 to a plain member and writes nothing', async () => {
    const res = await POST(event([Role.Member]))
    expect(res.status).toBe(403)
    expect(h.createAssignment).not.toHaveBeenCalled()
    expect(h.archiveAssignment).not.toHaveBeenCalled()
  })

  it('answers 403 without a session and writes nothing', async () => {
    const res = await POST(event(null))
    expect(res.status).toBe(403)
    expect(h.createAssignment).not.toHaveBeenCalled()
  })
})
