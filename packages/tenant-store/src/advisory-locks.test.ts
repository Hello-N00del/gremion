import { describe, expect, it } from 'vitest'
import { ADVISORY_LOCK_CLASS_ID, ADVISORY_LOCKS, assertDistinctLockKeys } from './advisory-locks.js'

describe('ADVISORY_LOCKS registry', () => {
  it('reserves the kernel class id 1735029614, which fits a signed int4', () => {
    expect(ADVISORY_LOCK_CLASS_ID).toBe(1735029614)
    expect(ADVISORY_LOCK_CLASS_ID).toBeLessThanOrEqual(2 ** 31 - 1)
  })

  it('has one row per purpose, and no two rows share a (classid, objid)', () => {
    expect(() => assertDistinctLockKeys(ADVISORY_LOCKS)).not.toThrow()
    const purposes = Object.values(ADVISORY_LOCKS).map((r) => r.purpose)
    expect(new Set(purposes).size).toBe(purposes.length)
  })

  it('names the migration lock under the kernel class id', () => {
    expect(ADVISORY_LOCKS.migration.classid).toBe(ADVISORY_LOCK_CLASS_ID)
    expect(Number.isInteger(ADVISORY_LOCKS.migration.objid)).toBe(true)
  })

  it('fails on a duplicate (classid, objid), naming both rows', () => {
    const dup = {
      migration: { classid: ADVISORY_LOCK_CLASS_ID, objid: 1, purpose: 'a' },
      other: { classid: ADVISORY_LOCK_CLASS_ID, objid: 1, purpose: 'b' },
    }
    expect(() => assertDistinctLockKeys(dup)).toThrow(/migration.*other|other.*migration/)
  })

  it('fails on a key outside the signed int4 range', () => {
    expect(() => assertDistinctLockKeys({ x: { classid: 2 ** 31, objid: 1, purpose: 'x' } })).toThrow(/int4/)
    expect(() => assertDistinctLockKeys({ x: { classid: 1, objid: 1.5, purpose: 'x' } })).toThrow(/int4/)
  })
})
