import { describe, it, expect } from 'vitest'
import { getRunner, type SqlRunner } from './tx'

const pool = { tag: 'pool' } as unknown as SqlRunner
const tx = { tag: 'tx' } as unknown as Parameters<typeof getRunner>[0]

describe('getRunner (neutral)', () => {
  it('returns the supplied tx handle and does NOT resolve the fallback (laziness)', () => {
    let called = false
    expect(getRunner(tx, () => { called = true; return pool })).toBe(tx)
    expect(called).toBe(false)
  })

  it('lazily resolves the fallback pool when tx is undefined', () => {
    expect(getRunner(undefined, () => pool)).toBe(pool)
  })
})
