// The operator's enable list (TASK-043 TDD 7, unit half): vault is
// refused by name before anything is written (board was lifted from the list
// in the board wave of 2026-11-11); an unknown id too. TASK-044
// deleted the interim operatorAllowGate (an attestation id as both
// references): every enable goes through lifecycle/enable-gate (module-gate.ts,
// module-gate.test.ts); this deny list stays as belt and braces.
import { describe, expect, it } from 'vitest'
import { assertEnableList, DEFAULT_DENY, ProvisioningError } from '../src/index.ts'
import * as provisioning from '../src/index.ts'

/** The refusal of assertEnableList as plain data (null: no refusal). */
function refusal(ids: readonly string[], known: readonly string[]): { provisioning: boolean; code: string; message: string } | null {
  try {
    assertEnableList(ids, known)
  } catch (e) {
    if (e instanceof ProvisioningError) return { provisioning: true, code: e.code, message: e.message }
    return { provisioning: false, code: 'OTHER', message: String(e) }
  }
  return null
}

describe('assertEnableList', () => {
  const known = ['board', 'calendar', 'publishing', 'vault', 'votes']

  it('accepts known, non-denied ids and returns them sorted and unique', () => {
    expect(assertEnableList(['votes', 'calendar', 'votes'], known)).toEqual(['calendar', 'votes'])
    expect(assertEnableList([], known)).toEqual([])
  })

  it('accepts board: it is no longer refused by name (its isolation case gates it instead)', () => {
    expect(assertEnableList(['calendar', 'board'], known)).toEqual(['board', 'calendar'])
    expect(refusal(['board'], known)).toBeNull()
    expect(DEFAULT_DENY.has('board')).toBe(false)
  })

  it('the deny list is exactly vault', () => {
    expect([...DEFAULT_DENY]).toEqual(['vault'])
  })

  it('refuses vault by name (R30 addendum A1; PRD-PLAT-012 / PRD-REC-003: vault stays off for the pilot)', () => {
    const r = refusal(['calendar', 'vault'], known)
    expect(r).toMatchObject({ provisioning: true, code: 'MODULE_DENIED' })
    expect(r?.message).toMatch(/module vault cannot be enabled/)
    expect(r?.message).toMatch(/PRD-PLAT-012/)
    expect(DEFAULT_DENY.has('vault')).toBe(true)
  })

  it('the refusal names the reason of the module it refuses, not another one', () => {
    expect(refusal(['vault'], known)?.message).not.toMatch(/board/)
    expect(refusal(['vault'], known)?.message).toMatch(/password vault/)
  })

  it('refuses an id the catalogue does not know', () => {
    expect(() => assertEnableList(['nope'], known)).toThrow(/nope/)
    expect(() => assertEnableList(['Calendar'], known)).toThrow(ProvisioningError)
  })
})

describe('TASK-044: the interim gate is gone', () => {
  it('the package exports no operatorAllowGate, no INTERIM_GATE_BASIS and no attestation adapter', () => {
    const names = Object.keys(provisioning)
    for (const gone of ['operatorAllowGate', 'INTERIM_GATE_BASIS', 'pgAttestations']) expect(names).not.toContain(gone)
    expect(names).toEqual(expect.arrayContaining(['enableCustomerModule', 'pgGate', 'EnableRefused', 'recordDpiaDecision', 'recordIsolationResults', 'unprovenEnablements', 'regateEnablement']))
  })
})
