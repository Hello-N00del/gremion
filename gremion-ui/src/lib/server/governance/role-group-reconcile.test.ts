// role-group-reconcile.test.ts — audit 420 (item 1): role → flat-group grants
// must be RECONCILING, not add-only. Unit-tests the PURE decision (union /
// plan) using the REAL finance role→group mapping. Route-level coverage of the
// I/O wrapper (reconcileUserRoleGroups) lives in assign.reconcile.test.ts, which
// exercises it end-to-end through the role-assign route with a mocked KC client.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  registerRoleGroupGrantResolver,
  _resetRuntimeRegistryForTests,
} from '$lib/server/modules/runtime-registry'
import { unionRoleGroupGrants, planGroupReconcile } from './role-group-reconcile'

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

const FINANZVORSTAND = 'Finanzvorstand' // base + hv
const REFERENT_FINANZEN = 'Referent·in Finanzen' // base + kv

describe('role-group grant reconciliation (audit 420 item 1)', () => {
  beforeEach(() => {
    _resetRuntimeRegistryForTests()
    // Same registration the finance module performs in register.server.ts.
    registerRoleGroupGrantResolver(financeFlatGroupsForRole)
  })
  afterEach(() => {
    _resetRuntimeRegistryForTests()
  })

  describe('unionRoleGroupGrants', () => {
    it('unions grants across role names, deduplicated', () => {
      expect(unionRoleGroupGrants([FINANZVORSTAND, REFERENT_FINANZEN]).sort()).toEqual(
        [FINANCE_GROUPS.base, FINANCE_GROUPS.hv, FINANCE_GROUPS.kv].sort(),
      )
    })

    it('returns [] for a role name no resolver maps', () => {
      expect(unionRoleGroupGrants(['Protokollant·in'])).toEqual([])
    })
  })

  describe('planGroupReconcile', () => {
    it('grant on assign: the incoming holder receives the role\'s flat groups', () => {
      const universe = unionRoleGroupGrants([FINANZVORSTAND, REFERENT_FINANZEN])
      const derived = unionRoleGroupGrants([FINANZVORSTAND])
      const plan = planGroupReconcile(universe, derived, [])
      expect(plan.toAdd.sort()).toEqual([FINANCE_GROUPS.base, FINANCE_GROUPS.hv].sort())
      expect(plan.toRemove).toEqual([])
    })

    it('revoke on unassign: an outgoing holder with no other role loses every granted group', () => {
      const universe = unionRoleGroupGrants([FINANZVORSTAND, REFERENT_FINANZEN])
      const derived: string[] = [] // no remaining active roles
      const current = [FINANCE_GROUPS.base, FINANCE_GROUPS.hv]
      const plan = planGroupReconcile(universe, derived, current)
      expect(plan.toRemove.sort()).toEqual([FINANCE_GROUPS.base, FINANCE_GROUPS.hv].sort())
      expect(plan.toAdd).toEqual([])
    })

    it('no-revoke-when-held-elsewhere: shared base kept, only the vacated extra is removed', () => {
      const universe = unionRoleGroupGrants([FINANZVORSTAND, REFERENT_FINANZEN])
      // Outgoing user is ALSO an active Referent·in Finanzen (base + kv).
      const derived = unionRoleGroupGrants([REFERENT_FINANZEN])
      const current = [FINANCE_GROUPS.base, FINANCE_GROUPS.hv] // held Finanzvorstand's groups
      const plan = planGroupReconcile(universe, derived, current)
      expect(plan.toRemove).toEqual([FINANCE_GROUPS.hv])
      expect(plan.toRemove).not.toContain(FINANCE_GROUPS.base)
      expect(plan.toAdd).toEqual([FINANCE_GROUPS.kv])
    })

    it('never removes a group outside the universe (manual -belege, no governance-role hook)', () => {
      const universe = unionRoleGroupGrants([FINANZVORSTAND, REFERENT_FINANZEN])
      const derived: string[] = []
      const current = [FINANCE_GROUPS.belege]
      const plan = planGroupReconcile(universe, derived, current)
      expect(plan.toRemove).toEqual([])
      expect(plan.toRemove).not.toContain(FINANCE_GROUPS.belege)
    })

    it('is a no-op when current already equals derived', () => {
      const universe = unionRoleGroupGrants([FINANZVORSTAND])
      const derived = unionRoleGroupGrants([FINANZVORSTAND])
      const plan = planGroupReconcile(universe, derived, derived)
      expect(plan.toAdd).toEqual([])
      expect(plan.toRemove).toEqual([])
    })
  })
})
