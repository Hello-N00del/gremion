// assign.reconcile.test.ts — audit 420 (item 1): committee role → flat-Keycloak-
// group grants must RECONCILE (add missing, revoke no-longer-derivable), not
// stay add-only. Drives the ROUTE with a mocked KC admin client + mocked
// governance-db, but the REAL role-group-reconcile.ts + runtime-registry
// resolveRoleGroupGrants (with the real finance role→group mapping registered),
// so the reconcile decision itself is exercised end-to-end, not stubbed out.
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
  createAssignment: vi.fn(),
  getActiveAssignment: vi.fn(),
  archiveAssignment: vi.fn(),
  scheduleNotifications: vi.fn(),
  listActiveRoleNamesForUser: vi.fn(),
  listAllRoleNames: vi.fn(),
  listOrgUnitMembers: vi.fn(),
  getKcClient: vi.fn(),
  listGroups: vi.fn(),
  listUserGroups: vi.fn(),
  addUserToGroup: vi.fn(),
  removeUserFromGroup: vi.fn(),
}))

vi.mock('$lib/server/governance/governance-db', () => ({
  createAssignment: h.createAssignment,
  getActiveAssignment: h.getActiveAssignment,
  archiveAssignment: h.archiveAssignment,
  scheduleNotifications: h.scheduleNotifications,
  listActiveRoleNamesForUser: h.listActiveRoleNamesForUser,
  listAllRoleNames: h.listAllRoleNames,
}))
vi.mock('$lib/server/governance/org-units-db', () => ({
  listOrgUnitMembers: h.listOrgUnitMembers,
}))
vi.mock('$lib/server/keycloak-admin', () => ({
  getKeycloakAdminClientForCurrentTenant: h.getKcClient,
}))

const { POST } = await import('./+server')

const ADMIN = { id: 'admin', roles: [Role.CouncilAdmin], groups: [], email: 'a@example.org', name: 'a' }

// The universe this whole suite reconciles against: two finance roles mapping
// to base/hv/kv, exactly like the real financeManifest.
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

function event(body: unknown) {
  return {
    params: { id: 'ou-1', roleId: 'role-1' },
    request: new Request('http://stura.test/api/governance/committees/ou-1/roles/role-1/assign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    locals: { auth: async () => ({ user: ADMIN }) },
  } as never
}

const VALID_BODY = {
  userKeycloakId: 'incoming',
  startDate: '2026-01-01',
  endDate: '2027-01-01',
  heliosElectionId: null,
}

describe('POST /api/governance/committees/[id]/roles/[roleId]/assign — flat-group reconciliation (audit 420)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetRuntimeRegistryForTests()
    registerRoleGroupGrantResolver(financeFlatGroupsForRole)

    h.createAssignment.mockResolvedValue({ id: 'assign-1', role_id: 'role-1', user_keycloak_id: 'incoming' })
    h.scheduleNotifications.mockResolvedValue(undefined)
    h.listOrgUnitMembers.mockResolvedValue([])
    h.listAllRoleNames.mockResolvedValue(ALL_ROLE_NAMES)
    h.getActiveAssignment.mockResolvedValue(null)
    h.archiveAssignment.mockResolvedValue(undefined)

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

  it('(a) assign grants the mapped groups to the incoming holder', async () => {
    h.listActiveRoleNamesForUser.mockImplementation(async (userId: string) =>
      userId === 'incoming' ? ['Finanzvorstand'] : [],
    )
    h.listUserGroups.mockImplementation(async () => [])

    const res = await POST(event(VALID_BODY))
    expect(res.status, await res.clone().text()).toBe(201)

    expect(h.addUserToGroup).toHaveBeenCalledWith('incoming', 'g-base')
    expect(h.addUserToGroup).toHaveBeenCalledWith('incoming', 'g-hv')
    expect(h.addUserToGroup).toHaveBeenCalledTimes(2)
    expect(h.removeUserFromGroup).not.toHaveBeenCalled()
  })

  it('(b) unassign: reassigning to a new holder removes groups the outgoing holder can no longer derive', async () => {
    h.getActiveAssignment.mockResolvedValue({
      id: 'assign-0', role_id: 'role-1', user_keycloak_id: 'outgoing',
      start_date: new Date('2025-01-01'), end_date: new Date('2026-01-01'),
    })
    // Outgoing holder loses their only role; incoming gains it.
    h.listActiveRoleNamesForUser.mockImplementation(async (userId: string) =>
      userId === 'incoming' ? ['Finanzvorstand'] : [],
    )
    h.listUserGroups.mockImplementation(async (userId: string) =>
      userId === 'outgoing' ? kcGroups([FINANCE_GROUPS.base, FINANCE_GROUPS.hv]) : [],
    )

    const res = await POST(event(VALID_BODY))
    expect(res.status, await res.clone().text()).toBe(201)

    expect(h.archiveAssignment).toHaveBeenCalledTimes(1)
    expect(h.addUserToGroup).toHaveBeenCalledWith('incoming', 'g-base')
    expect(h.addUserToGroup).toHaveBeenCalledWith('incoming', 'g-hv')
    expect(h.removeUserFromGroup).toHaveBeenCalledWith('outgoing', 'g-base')
    expect(h.removeUserFromGroup).toHaveBeenCalledWith('outgoing', 'g-hv')
    expect(h.removeUserFromGroup).toHaveBeenCalledTimes(2)
  })

  it('(c) a group held via a SECOND active assignment survives losing the first', async () => {
    h.getActiveAssignment.mockResolvedValue({
      id: 'assign-0', role_id: 'role-1', user_keycloak_id: 'outgoing',
      start_date: new Date('2025-01-01'), end_date: new Date('2026-01-01'),
    })
    // Outgoing holder is losing Finanzvorstand but is STILL an active
    // Referent·in Finanzen elsewhere (base + kv) — so base survives, only hv goes.
    h.listActiveRoleNamesForUser.mockImplementation(async (userId: string) => {
      if (userId === 'incoming') return ['Finanzvorstand']
      if (userId === 'outgoing') return ['Referent·in Finanzen']
      return []
    })
    h.listUserGroups.mockImplementation(async (userId: string) =>
      userId === 'outgoing'
        ? kcGroups([FINANCE_GROUPS.base, FINANCE_GROUPS.hv, FINANCE_GROUPS.kv])
        : [],
    )

    const res = await POST(event(VALID_BODY))
    expect(res.status, await res.clone().text()).toBe(201)

    // Only hv is removed — base is re-derived from the surviving role, kv is
    // already held (no redundant add), and neither is ever removed.
    expect(h.removeUserFromGroup).toHaveBeenCalledWith('outgoing', 'g-hv')
    expect(h.removeUserFromGroup).toHaveBeenCalledTimes(1)
    expect(h.removeUserFromGroup).not.toHaveBeenCalledWith('outgoing', 'g-base')
    expect(h.removeUserFromGroup).not.toHaveBeenCalledWith('outgoing', 'g-kv')
  })

  it('(d) a group outside the auto-managed universe (manual -belege) is never removed', async () => {
    h.getActiveAssignment.mockResolvedValue({
      id: 'assign-0', role_id: 'role-1', user_keycloak_id: 'outgoing',
      start_date: new Date('2025-01-01'), end_date: new Date('2026-01-01'),
    })
    // Outgoing holder loses their only role AND separately holds the manually
    // assigned receipts-clerk group, which no role's grant set ever names.
    h.listActiveRoleNamesForUser.mockImplementation(async (userId: string) =>
      userId === 'incoming' ? ['Finanzvorstand'] : [],
    )
    h.listUserGroups.mockImplementation(async (userId: string) =>
      userId === 'outgoing'
        ? kcGroups([FINANCE_GROUPS.base, FINANCE_GROUPS.hv, FINANCE_GROUPS.belege])
        : [],
    )

    const res = await POST(event(VALID_BODY))
    expect(res.status, await res.clone().text()).toBe(201)

    expect(h.removeUserFromGroup).toHaveBeenCalledWith('outgoing', 'g-base')
    expect(h.removeUserFromGroup).toHaveBeenCalledWith('outgoing', 'g-hv')
    expect(h.removeUserFromGroup).not.toHaveBeenCalledWith('outgoing', 'g-belege')
    expect(h.removeUserFromGroup).toHaveBeenCalledTimes(2)
  })

  it('(e) a Keycloak failure during reconcile is swallowed — the assignment still succeeds', async () => {
    h.listActiveRoleNamesForUser.mockImplementation(async () => ['Finanzvorstand'])
    // Fails INSIDE reconcileUserRoleGroups (not the earlier groupIdByName fetch).
    h.listUserGroups.mockRejectedValue(new Error('kc unreachable'))

    const res = await POST(event(VALID_BODY))
    expect(res.status, await res.clone().text()).toBe(201)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(h.createAssignment).toHaveBeenCalled()
    expect(h.scheduleNotifications).toHaveBeenCalled()
    // Nothing could be granted since the group directory lookup itself failed.
    expect(h.addUserToGroup).not.toHaveBeenCalled()
  })
})
