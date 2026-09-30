// TASK-206-0 guard for the role-assignment group-grant seam (74ae2780): the
// kernel unions every module resolver's flat groups for a role name, drops names
// that are not plain group names, and the test reset really clears the
// resolvers (and the decision-rule registry) between files.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  registerRoleGroupGrantResolver,
  resolveRoleGroupGrants,
  registerDecisionRule,
  getModuleDecisionRule,
  _resetRuntimeRegistryForTests,
} from './runtime-registry'

describe('resolveRoleGroupGrants', () => {
  beforeEach(() => {
    _resetRuntimeRegistryForTests()
    vi.restoreAllMocks()
  })

  it('no resolver registered -> no grants', () => {
    expect(resolveRoleGroupGrants('Kassenwart')).toEqual([])
  })

  it('unions and de-duplicates every resolver, [] for unmapped roles', () => {
    registerRoleGroupGrantResolver((role) => (role === 'Kassenwart' ? ['grp-a', 'grp-b'] : []))
    registerRoleGroupGrantResolver((role) => (role === 'Kassenwart' ? ['grp-b', 'grp-c'] : []))
    expect([...resolveRoleGroupGrants('Kassenwart')].sort()).toEqual(['grp-a', 'grp-b', 'grp-c'])
    expect(resolveRoleGroupGrants('Beisitz')).toEqual([])
  })

  it('drops (and reports) names that are not plain group names', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    registerRoleGroupGrantResolver(() => ['', '/admin', 'a/b', ' grp', 'grp-ok'])
    expect(resolveRoleGroupGrants('any')).toEqual(['grp-ok'])
    expect(err).toHaveBeenCalled()
  })

  it('_resetRuntimeRegistryForTests clears resolvers and module decision rules', () => {
    registerRoleGroupGrantResolver(() => ['grp-a'])
    registerDecisionRule('module_rule', () => true)
    _resetRuntimeRegistryForTests()
    expect(resolveRoleGroupGrants('any')).toEqual([])
    expect(getModuleDecisionRule('module_rule')).toBeUndefined()
  })
})
