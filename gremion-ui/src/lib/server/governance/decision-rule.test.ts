import { describe, it, expect } from 'vitest'
import { evaluateMajority } from './decision-rule'

describe('evaluateMajority', () => {
  it('simple: passes when yes > no, fails on a tie', () => {
    expect(evaluateMajority(2, 1, 'simple', 10)).toBe(true)
    expect(evaluateMajority(2, 2, 'simple', 10)).toBe(false)
    expect(evaluateMajority(0, 0, 'simple', 10)).toBe(false)
  })

  it('two_thirds: passes at exactly 2/3 of cast (yes >= 2*no)', () => {
    expect(evaluateMajority(2, 1, 'two_thirds', 10)).toBe(true) // 2 of 3 cast
    expect(evaluateMajority(3, 2, 'two_thirds', 10)).toBe(false) // 3 of 5 = 0.6
    expect(evaluateMajority(4, 2, 'two_thirds', 10)).toBe(true)
  })

  it('absolute: passes only with more than half of ALL eligible members', () => {
    expect(evaluateMajority(6, 0, 'absolute', 10)).toBe(true)
    expect(evaluateMajority(5, 0, 'absolute', 10)).toBe(false) // exactly half is not enough
    expect(evaluateMajority(5, 4, 'absolute', 9)).toBe(true)
  })
})
