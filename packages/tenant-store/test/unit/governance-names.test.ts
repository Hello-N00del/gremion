// TASK-084-a Task 1: the governance database and role names (no database).
import { describe, expect, it } from 'vitest'
import {
  GOVERNANCE_GROUP_ROLES,
  GOVERNANCE_LEDGER,
  GOVERNANCE_MODULE,
  governanceDbName,
  governanceRoles,
} from '../../src/lifecycle/governance.js'
import { assertLifecycleModuleId, LifecycleError } from '../../src/lifecycle/guards.js'

const ID = '01927f00-0000-7000-8000-000000000001'
const HEX = '01927f00000070008000000000000001'

describe('governance names', () => {
  it('the module and ledger constants', () => {
    expect(GOVERNANCE_MODULE).toBe('governance')
    expect(GOVERNANCE_LEDGER).toBe('gov.schema_migration')
  })

  it('governanceDbName is t_<hex32>__governance', () => {
    expect(governanceDbName(ID)).toBe(`t_${HEX}__governance`)
  })

  it('governanceRoles are g_<hex32>_owner, _app and _purger', () => {
    expect(governanceRoles(ID)).toEqual({ owner: `g_${HEX}_owner`, app: `g_${HEX}_app`, purger: `g_${HEX}_purger` })
  })

  it('every name is at most 63 bytes and lower-case [a-z0-9_]', () => {
    const roles = governanceRoles(ID)
    for (const n of [governanceDbName(ID), roles.owner, roles.app, roles.purger]) {
      expect(Buffer.byteLength(n)).toBeLessThanOrEqual(63)
      expect(n).toMatch(/^[a-z0-9_]+$/)
    }
  })

  it.each([
    ['empty', ''],
    ['not a uuid', 'not-a-uuid'],
    ['a v4 uuid', '01927f00-0000-4000-8000-000000000001'],
    ['upper case', '01927F00-0000-7000-8000-000000000001'],
  ])('both functions refuse %s with INVALID_INPUT', (_label, bad) => {
    for (const fn of [governanceDbName, governanceRoles]) {
      let err: unknown
      try {
        fn(bad)
      } catch (e) {
        err = e
      }
      expect(err).toBeInstanceOf(LifecycleError)
      expect((err as LifecycleError).code).toBe('INVALID_INPUT')
    }
  })

  it('governance is a reserved module id: assertLifecycleModuleId refuses it with INVALID_INPUT', () => {
    let err: unknown
    try {
      assertLifecycleModuleId('governance')
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(LifecycleError)
    expect((err as LifecycleError).code).toBe('INVALID_INPUT')
  })

  it('GOVERNANCE_GROUP_ROLES is frozen with keys app and purger', () => {
    expect(Object.isFrozen(GOVERNANCE_GROUP_ROLES)).toBe(true)
    expect(Object.keys(GOVERNANCE_GROUP_ROLES)).toEqual(['app', 'purger'])
    expect(GOVERNANCE_GROUP_ROLES).toEqual({ app: 'gov_app', purger: 'gov_purger' })
  })
})
