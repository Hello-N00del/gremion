import { describe, test, expect } from 'vitest'
import { LOA, acrToLoa, evaluateStepUp } from './step-up'

describe('acrToLoa', () => {
  test.each([['loa2', 2], ['loa1', 1], ['2', 2], ['1', 1], [null, 0], [undefined, 0], ['nope', 0]] as const)(
    '%s → %s', (acr, loa) => expect(acrToLoa(acr)).toBe(loa))
})

describe('evaluateStepUp', () => {
  const now = 1_000_000_000_000
  const fresh = { nowMs: now, freshnessSeconds: 300 }
  test('requiredLoa<=1 always ok', () =>
    expect(evaluateStepUp({ loa: 0, authTime: 0 }, 1, fresh)).toEqual({ ok: true }))
  test('loa below required → not ok (loa)', () =>
    expect(evaluateStepUp({ loa: 1, authTime: now / 1000 }, 2, fresh)).toEqual({ ok: false, requiredLoa: 2, reason: 'loa' }))
  test('loa ok + fresh → ok', () =>
    expect(evaluateStepUp({ loa: 2, authTime: now / 1000 }, 2, fresh)).toEqual({ ok: true }))
  test('loa ok but stale → not ok (stale)', () =>
    expect(evaluateStepUp({ loa: 2, authTime: now / 1000 - 301 }, 2, fresh)).toEqual({ ok: false, requiredLoa: 2, reason: 'stale' }))
})
