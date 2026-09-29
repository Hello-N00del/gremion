// revoke.reconcile.test.ts — #320 Phase 3 / INV-3 recall: ending a mandate is a
// recorded, attributable governance act (charter §INV-3), and the revoked
// holder's flat-Keycloak-group grants must be reconciled through the SAME
// role-group-reconcile module the assign route uses — the new route must not
// duplicate any reconcile logic. Mirrors assign.reconcile.test.ts: mocked KC
// admin client + mocked governance-db, REAL role-group-reconcile.ts (wrapped in
// a passthrough spy so delegation is provable) + runtime-registry
// resolveRoleGroupGrants with the real finance role→group mapping registered.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Role } from '$lib/auth'
import {
  registerRoleGroupGrantResolver,
  _resetRuntimeRegistryForTests,
} from '$lib/server/modules/runtime-registry'

// TASK-206-A adapted port (1c): the source imported the finance module's
// financeFlatGroupsForRole / FINANCE_GROUPS, which the governance-only kernel
// does not carry. A local stub resolver with the same role -> group data is
// registered in-test instead; TASK-205's finance lane keeps the real mapping.
const FINANCE_GROUPS = {
  base: 'ref-finanzen',
  kv: 'ref-finanzen-kv',
  hv: 'ref-finanzen-hv',
  belege: 'ref-finanzen-belege',
} as const
const FINANCE_ROLE_FLAT_GROUPS: ReadonlyMap<string, readonly string[]> = new Map([
  ['Finanzvorstand', [FINANCE_GROUPS.base, FINANCE_GROUPS.hv]],
  ['Referent·in Finanzen', [FINANCE_GROUPS.base, FINANCE_GROUPS.kv]],
])
function financeFlatGroupsForRole(roleName: string): readonly string[] {
  return FINANCE_ROLE_FLAT_GROUPS.get(roleName) ?? []
}

const h = vi.hoisted(() => ({
  getActiveAssignment: vi.fn(),
  revokeMandate: vi.fn(),
  listActiveRoleNamesForUser: vi.fn(),
  listAllRoleNames: vi.fn(),
  getKcClient: vi.fn(),
  listGroups: vi.fn(),
  listUserGroups: vi.fn(),
  addUserToGroup: vi.fn(),
  removeUserFromGroup: vi.fn(),
}))

// Keep the REAL module surface (incl. UnarchivableAssignmentError) and mock
// only the functions the route touches — the real class must flow through so
// the route's instanceof mapping to a clean 4xx is exercised for real.
vi.mock('$lib/server/governance/governance-db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/server/governance/governance-db')>()
  return {
    ...actual,
    getActiveAssignment: h.getActiveAssignment,
    revokeMandate: h.revokeMandate,
    listActiveRoleNamesForUser: h.listActiveRoleNamesForUser,
    listAllRoleNames: h.listAllRoleNames,
  }
})
// REAL reconcile logic, wrapped in a passthrough spy: the route must delegate
// to THIS module (the same one the assign route uses) — no duplicated
// reconcile logic in the revoke route.
vi.mock('$lib/server/governance/role-group-reconcile', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/server/governance/role-group-reconcile')>()
  return { ...actual, reconcileUserRoleGroups: vi.fn(actual.reconcileUserRoleGroups) }
})
vi.mock('$lib/server/keycloak-admin', () => ({
  getKeycloakAdminClientForCurrentTenant: h.getKcClient,
}))

const { reconcileUserRoleGroups } = await import('$lib/server/governance/role-group-reconcile')
const { UnarchivableAssignmentError } = await import('$lib/server/governance/governance-db')
const { POST } = await import('./+server')

const ADMIN = { id: 'admin', roles: [Role.CouncilAdmin], groups: [], email: 'a@example.org', name: 'a' }
const MEMBER = { id: 'member', roles: [], groups: [], email: 'm@example.org', name: 'm' }

const ALL_ROLE_NAMES = ['Finanzvorstand', 'Referent·in Finanzen']
const ALL_GROUPS = [
  { id: 'g-base', name: FINANCE_GROUPS.base },
  { id: 'g-hv', name: FINANCE_GROUPS.hv },
  { id: 'g-kv', name: FINANCE_GROUPS.kv },
  { id: 'g-belege', name: FINANCE_GROUPS.belege }, // manual, never in any role's grant set
]

function kcGroups(names: readonly string[]) {
  return ALL_GROUPS.filter((g) => names.includes(g.name))
}

const ACTIVE_ASSIGNMENT = {
  id: 'assign-1',
  role_id: 'role-1',
  user_keycloak_id: 'holder-1',
  start_date: new Date('2026-01-01'),
  end_date: new Date('2027-01-01'),
  status: 'active',
  assigned_by_keycloak_id: 'admin',
  helios_election_id: null,
  created_at: new Date('2026-01-01'),
}

function event(body: unknown, user: typeof ADMIN | typeof MEMBER = ADMIN) {
  return {
    params: { id: 'ou-1', roleId: 'role-1' },
    request: new Request('http://stura.test/api/governance/committees/ou-1/roles/role-1/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    locals: { auth: async () => ({ user }) },
  } as never
}

describe('POST /api/governance/committees/[id]/roles/[roleId]/revoke — INV-3 recall', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetRuntimeRegistryForTests()
    registerRoleGroupGrantResolver(financeFlatGroupsForRole)

    h.getActiveAssignment.mockResolvedValue(ACTIVE_ASSIGNMENT)
    h.revokeMandate.mockResolvedValue(undefined)
    h.listAllRoleNames.mockResolvedValue(ALL_ROLE_NAMES)
    // After the recall the holder has NO remaining active roles anywhere.
    h.listActiveRoleNamesForUser.mockResolvedValue([])

    h.listGroups.mockResolvedValue(ALL_GROUPS)
    h.listUserGroups.mockResolvedValue([])
    h.addUserToGroup.mockResolvedValue(undefined)
    h.removeUserFromGroup.mockResolvedValue(undefined)
    h.getKcClient.mockReturnValue({
      listGroups: h.listGroups,
      listUserGroups: h.listUserGroups,
      addUserToGroup: h.addUserToGroup,
      removeUserFromGroup: h.removeUserFromGroup,
    })
  })
  afterEach(() => {
    _resetRuntimeRegistryForTests()
  })

  it('(a) CouncilAdmin recall with a reason → 200; revokeMandate runs and the holder is reconciled via the SAME reconcile module as assign', async () => {
    // The revoked holder still carries the finance groups their (now ended)
    // Finanzvorstand mandate granted — reconcile must strip them.
    h.listUserGroups.mockImplementation(async (userId: string) =>
      userId === 'holder-1' ? kcGroups([FINANCE_GROUPS.base, FINANCE_GROUPS.hv]) : [],
    )

    const res = await POST(event({ reason: 'Amtsmissbrauch — Beschluss 2026/42' }))
    expect(res.status, await res.clone().text()).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)

    // The recorded governance act ran with the acting admin + free-text reason.
    expect(h.revokeMandate).toHaveBeenCalledTimes(1)
    expect(h.revokeMandate).toHaveBeenCalledWith(
      ACTIVE_ASSIGNMENT, 'Amtsmissbrauch — Beschluss 2026/42', 'admin',
    )

    // Delegation proof: the route called the shared reconcile module for the
    // revoked holder (no duplicated reconcile logic in the route)...
    expect(vi.mocked(reconcileUserRoleGroups)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(reconcileUserRoleGroups).mock.calls[0]![0]).toBe('holder-1')
    // ...and the REAL reconcile decision executed: no remaining active roles →
    // both auto-managed groups stripped, nothing added.
    expect(h.removeUserFromGroup).toHaveBeenCalledWith('holder-1', 'g-base')
    expect(h.removeUserFromGroup).toHaveBeenCalledWith('holder-1', 'g-hv')
    expect(h.removeUserFromGroup).toHaveBeenCalledTimes(2)
    expect(h.addUserToGroup).not.toHaveBeenCalled()
  })

  it('(b) non-admin → 403 and nothing is revoked', async () => {
    const res = await POST(event({ reason: 'x' }, MEMBER))
    expect(res.status).toBe(403)
    expect(h.revokeMandate).not.toHaveBeenCalled()
    expect(vi.mocked(reconcileUserRoleGroups)).not.toHaveBeenCalled()
  })

  it('(c) missing reason → 400; empty reason → 400 (a recall is only valid WITH a recorded reason)', async () => {
    const missing = await POST(event({}))
    expect(missing.status, await missing.clone().text()).toBe(400)

    const empty = await POST(event({ reason: '' }))
    expect(empty.status, await empty.clone().text()).toBe(400)

    expect(h.revokeMandate).not.toHaveBeenCalled()
    expect(vi.mocked(reconcileUserRoleGroups)).not.toHaveBeenCalled()
  })

  it('(d) no active assignment for the role → 404', async () => {
    h.getActiveAssignment.mockResolvedValue(null)
    const res = await POST(event({ reason: 'x' }))
    expect(res.status, await res.clone().text()).toBe(404)
    expect(h.revokeMandate).not.toHaveBeenCalled()
    expect(vi.mocked(reconcileUserRoleGroups)).not.toHaveBeenCalled()
  })

  it('(e) an assignment archiveAssignment refuses (NULL dates) surfaces as a clean 4xx, not a 500', async () => {
    h.revokeMandate.mockRejectedValue(
      new UnarchivableAssignmentError('Cannot archive assignment assign-1: start_date or end_date is null'),
    )
    const res = await POST(event({ reason: 'x' }))
    expect(res.status, await res.clone().text()).toBe(409)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(body.error).toMatch(/start_date or end_date is null/)
    // The mandate was NOT revoked → no reconcile side effects either.
    expect(vi.mocked(reconcileUserRoleGroups)).not.toHaveBeenCalled()
  })

  // TASK-206-A review: the recall stands (it is committed and recorded), but a
  // failed group cleanup is REPORTED, never a silent 200 — the recalled holder
  // may still carry module groups until someone reconciles them.
  it('(f) a Keycloak failure during reconcile keeps the recall but reports groupsReconciled: false and logs', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.listUserGroups.mockRejectedValue(new Error('kc unreachable'))
    const res = await POST(event({ reason: 'x' }))
    expect(res.status, await res.clone().text()).toBe(200)
    expect(await res.json()).toEqual({ success: true, groupsReconciled: false })
    expect(err).toHaveBeenCalled()
    expect(h.revokeMandate).toHaveBeenCalledTimes(1)
    expect(h.addUserToGroup).not.toHaveBeenCalled()
    expect(h.removeUserFromGroup).not.toHaveBeenCalled()
    err.mockRestore()
  })

  it('(f2) a clean reconcile reports groupsReconciled: true', async () => {
    const res = await POST(event({ reason: 'x' }))
    expect(res.status, await res.clone().text()).toBe(200)
    expect(await res.json()).toEqual({ success: true, groupsReconciled: true })
  })
})
