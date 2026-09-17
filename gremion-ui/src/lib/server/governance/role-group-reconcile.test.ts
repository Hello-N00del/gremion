// role-group-reconcile.test.ts — audit 420 (item 1): role → flat-group grants
// must be RECONCILING, not add-only. Unit-tests the PURE decision (union /
// plan) through the REAL registration seam.
//
// PORT ADAPTATION (B5): the frozen StuRa test drove the decision with the
// finance module's own mapping (`../finance/officer-groups`,
// `$lib/modules/finance/capabilities`). Neither exists in the governance-only
// kernel — finance was carved out — so the same six decisions are asserted
// through a resolver registered on the kernel's public seam
// (registerRoleGroupGrantResolver), which is exactly what a module does in its
// register.server.ts. The mapping shape is preserved: two roles sharing one
// base group, each adding one role-specific group, plus one manually-assigned
// group that no role ever grants (outside the universe).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  registerRoleGroupGrantResolver,
  _resetRuntimeRegistryForTests,
} from '$lib/server/modules/runtime-registry'
import { unionRoleGroupGrants, planGroupReconcile } from './role-group-reconcile'

/** Stand-in for a module's capability group constants. */
const GROUPS = {
  base: 'gremium-basis',
  hv: 'gremium-vorsitz',
  kv: 'gremium-referat',
  /** Manually assigned; no governance role grants it — outside the universe. */
  manual: 'gremium-belege',
} as const

const VORSITZ = 'Vorsitz' // base + hv
const REFERENT = 'Referent·in' // base + kv

/** The mapping a module registers in its register.server.ts. */
function moduleFlatGroupsForRole(roleName: string): readonly string[] {
  if (roleName === VORSITZ) return [GROUPS.base, GROUPS.hv]
  if (roleName === REFERENT) return [GROUPS.base, GROUPS.kv]
  return []
}

describe('role-group grant reconciliation (audit 420 item 1)', () => {
  beforeEach(() => {
    _resetRuntimeRegistryForTests()
    // Same registration a module performs in register.server.ts.
    registerRoleGroupGrantResolver(moduleFlatGroupsForRole)
  })
  afterEach(() => {
    _resetRuntimeRegistryForTests()
  })

  describe('unionRoleGroupGrants', () => {
    it('unions grants across role names, deduplicated', () => {
      expect(unionRoleGroupGrants([VORSITZ, REFERENT]).sort()).toEqual(
        [GROUPS.base, GROUPS.hv, GROUPS.kv].sort(),
      )
    })

    it('returns [] for a role name no resolver maps', () => {
      expect(unionRoleGroupGrants(['Protokollant·in'])).toEqual([])
    })
  })

  describe('planGroupReconcile', () => {
    it("grant on assign: the incoming holder receives the role's flat groups", () => {
      const universe = unionRoleGroupGrants([VORSITZ, REFERENT])
      const derived = unionRoleGroupGrants([VORSITZ])
      const plan = planGroupReconcile(universe, derived, [])
      expect(plan.toAdd.sort()).toEqual([GROUPS.base, GROUPS.hv].sort())
      expect(plan.toRemove).toEqual([])
    })

    it('revoke on unassign: an outgoing holder with no other role loses every granted group', () => {
      const universe = unionRoleGroupGrants([VORSITZ, REFERENT])
      const derived: string[] = [] // no remaining active roles
      const current = [GROUPS.base, GROUPS.hv]
      const plan = planGroupReconcile(universe, derived, current)
      expect(plan.toRemove.sort()).toEqual([GROUPS.base, GROUPS.hv].sort())
      expect(plan.toAdd).toEqual([])
    })

    it('no-revoke-when-held-elsewhere: shared base kept, only the vacated extra is removed', () => {
      const universe = unionRoleGroupGrants([VORSITZ, REFERENT])
      // Outgoing user is ALSO an active Referent·in (base + kv).
      const derived = unionRoleGroupGrants([REFERENT])
      const current = [GROUPS.base, GROUPS.hv] // held Vorsitz's groups
      const plan = planGroupReconcile(universe, derived, current)
      expect(plan.toRemove).toEqual([GROUPS.hv])
      expect(plan.toRemove).not.toContain(GROUPS.base)
      expect(plan.toAdd).toEqual([GROUPS.kv])
    })

    it('never removes a group outside the universe (manually assigned, no governance-role hook)', () => {
      const universe = unionRoleGroupGrants([VORSITZ, REFERENT])
      const derived: string[] = []
      const current = [GROUPS.manual]
      const plan = planGroupReconcile(universe, derived, current)
      expect(plan.toRemove).toEqual([])
      expect(plan.toRemove).not.toContain(GROUPS.manual)
    })

    it('is a no-op when current already equals derived', () => {
      const universe = unionRoleGroupGrants([VORSITZ])
      const derived = unionRoleGroupGrants([VORSITZ])
      const plan = planGroupReconcile(universe, derived, derived)
      expect(plan.toAdd).toEqual([])
      expect(plan.toRemove).toEqual([])
    })
  })
})
