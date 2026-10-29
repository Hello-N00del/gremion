// AUTHZ_SWEEP_INTERVAL_MS: unset = 60 s, a non-negative integer = that many ms (0 = off),
// anything else refuses the boot (a typo must not silently turn the sweep off).
import { describe, expect, it } from 'vitest'
import { DEFAULT_SWEEP_INTERVAL_MS, describeSweepInterval, parseSweepInterval } from '../../src/authz/sweep-interval.ts'

describe('parseSweepInterval', () => {
  it('unset is the 60 s default', () => {
    expect(parseSweepInterval(undefined)).toBe(60_000)
    expect(DEFAULT_SWEEP_INTERVAL_MS).toBe(60_000)
  })
  it('0 is off; a positive integer is itself; the largest timer delay is accepted', () => {
    expect(parseSweepInterval('0')).toBe(0)
    expect(parseSweepInterval('1')).toBe(1)
    expect(parseSweepInterval('15000')).toBe(15_000)
    expect(parseSweepInterval('2147483647')).toBe(2_147_483_647)
  })
  it.each(['', ' ', 'abc', '60s', '1.5', '-1', '+5', '1e3', '0x10', ' 100', '100 ', 'NaN', 'Infinity', '2147483648', '99999999999999999999'])('%j refuses the boot with a message naming the variable', (v) => {
    expect(() => parseSweepInterval(v)).toThrow(/AUTHZ_SWEEP_INTERVAL_MS/)
  })
  it('the refusal quotes the offending value', () => {
    expect(() => parseSweepInterval('60s')).toThrow(/"60s"/)
  })
})

describe('describeSweepInterval', () => {
  it('names the off state with the variable, and the effective interval otherwise', () => {
    expect(describeSweepInterval(0)).toBe('authz sweep: off (AUTHZ_SWEEP_INTERVAL_MS=0)')
    expect(describeSweepInterval(60_000)).toBe('authz sweep: every 60000 ms')
  })
})
