// TDD 7 (unit half, TASK-043 Q19): the interim operator gate. It answers only
// for an id the operator passed with --enable that is not denied, with the ONE
// persisted attestation id for (customer, module) as both references; board
// and vault are refused by name before anything is written.
import { describe, expect, it } from 'vitest'
import { assertEnableList, DEFAULT_DENY, operatorAllowGate, ProvisioningError } from '../src/index.ts'

const T = '01927f00-0000-7000-8000-000000000001'
const ATT = '01927f00-0000-7000-8000-00000000abcd'

function thrown(fn: () => unknown): unknown {
  try {
    fn()
  } catch (e) {
    return e
  }
  return undefined
}

describe('assertEnableList', () => {
  const known = ['board', 'calendar', 'publishing', 'vault', 'votes']

  it('accepts known, non-denied ids and returns them sorted and unique', () => {
    expect(assertEnableList(['votes', 'calendar', 'votes'], known)).toEqual(['calendar', 'votes'])
    expect(assertEnableList([], known)).toEqual([])
  })

  it('refuses board by name (R29-I1: not tenant-isolated until TASK-058)', () => {
    const err = thrown(() => assertEnableList(['calendar', 'board'], known))
    expect(err).toBeInstanceOf(ProvisioningError)
    expect((err as ProvisioningError).code).toBe('MODULE_DENIED')
    expect((err as Error).message).toMatch(/board/)
    expect(DEFAULT_DENY.has('board')).toBe(true)
  })

  it('refuses vault by name (R30 addendum A1; PRD-PLAT-012 / PRD-REC-003: board and vault stay off for the pilot)', () => {
    const err = thrown(() => assertEnableList(['calendar', 'vault'], known))
    expect(err).toBeInstanceOf(ProvisioningError)
    expect((err as ProvisioningError).code).toBe('MODULE_DENIED')
    expect((err as Error).message).toMatch(/module vault cannot be enabled/)
    expect((err as Error).message).toMatch(/PRD-PLAT-012/)
    expect(DEFAULT_DENY.has('vault')).toBe(true)
  })

  it('the refusal names the reason of the module it refuses, not another one', () => {
    expect((thrown(() => assertEnableList(['board'], known)) as Error).message).not.toMatch(/vault/)
    expect((thrown(() => assertEnableList(['vault'], known)) as Error).message).not.toMatch(/board/)
  })

  it('refuses an id the catalogue does not know', () => {
    expect(() => assertEnableList(['nope'], known)).toThrow(/nope/)
    expect(() => assertEnableList(['Calendar'], known)).toThrow(ProvisioningError)
  })
})

describe('operatorAllowGate', () => {
  it('answers an enabled id with the persisted attestation as both references', async () => {
    const gate = operatorAllowGate(new Set(['calendar']), async () => ATT)
    expect(await gate(T, 'calendar')).toEqual({ isolationTestResultId: ATT, dpiaDecisionId: ATT })
  })

  it('an id outside --enable gets null (the lifecycle then refuses GATE_REFUSED)', async () => {
    let looked = false
    const gate = operatorAllowGate(new Set(['calendar']), async () => ((looked = true), ATT))
    expect(await gate(T, 'votes')).toBeNull()
    expect(looked).toBe(false)
  })

  it('a denied id gets null even when the operator passed it', async () => {
    const gate = operatorAllowGate(new Set(['board']), async () => ATT)
    expect(await gate(T, 'board')).toBeNull()
  })

  it('vault gets null even when the operator passed it and an attestation exists (R30 addendum A1)', async () => {
    let looked = false
    const gate = operatorAllowGate(new Set(['vault']), async () => ((looked = true), ATT))
    expect(await gate(T, 'vault')).toBeNull()
    expect(looked).toBe(false)
  })

  it('no persisted attestation -> null, never a fresh random id', async () => {
    const gate = operatorAllowGate(new Set(['calendar']), async () => null)
    expect(await gate(T, 'calendar')).toBeNull()
  })

  it('the same attestation is returned on every call (resume re-reads it)', async () => {
    const gate = operatorAllowGate(new Set(['calendar']), async () => ATT)
    const a = await gate(T, 'calendar')
    const b = await gate(T, 'calendar')
    expect(a).toEqual(b)
  })
})
