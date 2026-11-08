// TASK-084-a: the panel's copy of the provisioning step kinds. It stays a copy
// (the panel imports no workspace package); this test pins nine kinds and makes
// the next drift against @gremion/provisioning fail instead of showing 8/9.
import { describe, expect, it } from 'vitest'
import { EXECUTION_ORDER as PROVISIONING_ORDER } from '../../../../../packages/provisioning/src/steps'
import { LEDGER_STEP_LABEL } from '../request-state'
import { EXECUTION_ORDER } from './customers'

describe('the panel copy of the ledger step kinds', () => {
  it('holds the nine kinds, governance_database_created second after database_created', () => {
    expect(EXECUTION_ORDER).toHaveLength(9)
    expect(EXECUTION_ORDER.indexOf('governance_database_created')).toBe(EXECUTION_ORDER.indexOf('database_created') + 1)
    expect(EXECUTION_ORDER[2]).toBe('governance_database_created')
  })

  it('equals the EXECUTION_ORDER of @gremion/provisioning', () => {
    expect([...EXECUTION_ORDER]).toEqual([...PROVISIONING_ORDER])
  })

  it('labels every kind, governance in words', () => {
    expect(LEDGER_STEP_LABEL.governance_database_created).toBe('Governance-Datenbank angelegt und migriert')
    expect(Object.keys(LEDGER_STEP_LABEL).sort()).toEqual([...EXECUTION_ORDER].sort())
  })
})
