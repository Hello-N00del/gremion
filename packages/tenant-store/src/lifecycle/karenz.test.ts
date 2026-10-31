// Task 3 (module Karenz), the no-database half: the constants, the deletion
// switch and the export path guard. The database half is
// test/integration/lifecycle-karenz.test.ts.
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tenantModuleDbName } from '../names.js'
import { assertKarenzExportPath, finalDeletionEnabled, KARENZ_DAYS } from './karenz.js'

const T = '0192f0c1-2b3c-7d4e-8f00-112233445566'
const U = '0192f0c1-2b3c-7d4e-8f00-665544332211'

describe('karenz constants and the deletion switch', () => {
  it('KARENZ_DAYS is 30', () => {
    expect(KARENZ_DAYS).toBe(30)
  })

  it('finalDeletionEnabled is true only for the exact string on (ON, true, 1, empty are false)', () => {
    expect(finalDeletionEnabled({ KARENZ_FINAL_DELETION: 'on' })).toBe(true)
    for (const v of ['ON', 'On', 'true', '1', 'yes', '', ' on', 'on ', 'off', undefined]) {
      expect(finalDeletionEnabled({ KARENZ_FINAL_DELETION: v }), JSON.stringify(v)).toBe(false)
    }
    expect(finalDeletionEnabled({})).toBe(false)
  })

  it('finalDeletionEnabled reads process.env by default and nothing else', () => {
    const before = process.env.KARENZ_FINAL_DELETION
    try {
      process.env.KARENZ_FINAL_DELETION = 'on'
      expect(finalDeletionEnabled()).toBe(true)
      process.env.KARENZ_FINAL_DELETION = 'off'
      expect(finalDeletionEnabled()).toBe(false)
    } finally {
      if (before === undefined) delete process.env.KARENZ_FINAL_DELETION
      else process.env.KARENZ_FINAL_DELETION = before
    }
  })
})

describe('the export path guard', () => {
  const dir = join('/exports')
  const ok = join(dir, T, 'lcfix', '20261031T000000000Z.dump')

  it('accepts a file directly under <exportDir>/<tenant>/<module>/', () => {
    expect(assertKarenzExportPath(ok, dir, T, 'lcfix')).toBe(ok)
  })

  it('refuses a path outside <exportDir>/<tenant>/<module>/', () => {
    for (const bad of [
      join(dir, U, 'lcfix', 'x.dump'), // another tenant
      join(dir, T, 'board', 'x.dump'), // another module
      join(dir, T, 'lcfix', '..', 'board', 'x.dump'), // traversal
      join(dir, T, 'lcfix', 'sub', 'x.dump'), // not directly inside
      join(dir, T, 'lcfix'), // the directory itself
      '/etc/passwd',
      '',
    ]) {
      expect(() => assertKarenzExportPath(bad, dir, T, 'lcfix'), JSON.stringify(bad)).toThrow(expect.objectContaining({ code: 'TARGET_REFUSED' }))
    }
  })

  it('refuses a database name as a path and a sidecar-looking target that is not a dump', () => {
    expect(() => assertKarenzExportPath(tenantModuleDbName(T, 'lcfix'), dir, T, 'lcfix')).toThrow(expect.objectContaining({ code: 'TARGET_REFUSED' }))
    expect(() => assertKarenzExportPath(join(dir, T, 'lcfix', 'x.txt'), dir, T, 'lcfix')).toThrow(expect.objectContaining({ code: 'TARGET_REFUSED' }))
  })
})
