// Task 3 (module Karenz), the no-database half: the constants, the deletion
// switch and the export path guard. The database half is
// test/integration/lifecycle-karenz.test.ts.
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { tenantModuleDbName } from '../names.js'
import { assertKarenzExportPath, finalDeletionEnabled, KARENZ_DAYS, verifyRowExport, type DueRow } from './karenz.js'

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

describe('verifyRowExport: what the day-30 delete will refuse, it refuses before the database is dropped', () => {
  const content = 'dump bytes'
  const sha = createHash('sha256').update(content).digest('hex')
  const root = mkdtempSync(join(tmpdir(), 'karenz verify '))
  afterAll(() => rmSync(root, { recursive: true, force: true }))
  const row = (path: string): DueRow => ({
    karenz_id: 'k1',
    customer_id: T,
    module_id: 'm1',
    module_key: 'lcfix',
    state: 'open',
    export_path: path,
    export_sha256: sha,
    export_deleted_at: null,
    platform_done_at: null,
    tenant_done_at: null,
    retained_ok_at: null,
  })

  it('accepts the row\'s own regular file with the recorded sha256', async () => {
    const d = join(root, 'plain', T, 'lcfix')
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'a.dump'), content)
    await expect(verifyRowExport(join(root, 'plain'), row(join(d, 'a.dump')))).resolves.toBeUndefined()
  })

  it('refuses a file whose sha256 differs from the recorded one, and a missing file: EXPORT_MISSING', async () => {
    const d = join(root, 'sha', T, 'lcfix')
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'a.dump'), `${content} changed`)
    await expect(verifyRowExport(join(root, 'sha'), row(join(d, 'a.dump')))).rejects.toMatchObject({ code: 'EXPORT_MISSING' })
    await expect(verifyRowExport(join(root, 'sha'), row(join(d, 'b.dump')))).rejects.toMatchObject({ code: 'EXPORT_MISSING' })
  })

  it('refuses a row that records no export or no sha256: EXPORT_MISSING', async () => {
    await expect(verifyRowExport(join(root, 'plain'), { ...row(join(root, 'plain', T, 'lcfix', 'a.dump')), export_sha256: null })).rejects.toMatchObject({ code: 'EXPORT_MISSING' })
    await expect(verifyRowExport(join(root, 'plain'), { ...row(''), export_path: null })).rejects.toMatchObject({ code: 'EXPORT_MISSING' })
  })

  it('refuses a link on the way (the storage seam refuses it at delete time, after the drop): TARGET_REFUSED', async () => {
    const exportDir = join(root, 'linked')
    const elsewhere = join(root, 'linked-target')
    mkdirSync(join(exportDir, T), { recursive: true })
    mkdirSync(elsewhere, { recursive: true })
    writeFileSync(join(elsewhere, 'a.dump'), content)
    // a junction needs no privilege on Windows and is a directory link on POSIX
    symlinkSync(elsewhere, join(exportDir, T, 'lcfix'), 'junction')
    await expect(verifyRowExport(exportDir, row(join(exportDir, T, 'lcfix', 'a.dump')))).rejects.toMatchObject({ code: 'TARGET_REFUSED' })
  })

  it('refuses a link at <dump>.sha256, which the day-30 delete removes through the seam too: TARGET_REFUSED', async () => {
    const exportDir = join(root, 'sidecar')
    const d = join(exportDir, T, 'lcfix')
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'a.dump'), content)
    const elsewhere = join(root, 'sidecar-target')
    mkdirSync(elsewhere, { recursive: true })
    symlinkSync(elsewhere, join(d, 'a.dump.sha256'), 'junction')
    await expect(verifyRowExport(exportDir, row(join(d, 'a.dump')))).rejects.toMatchObject({ code: 'TARGET_REFUSED' })
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
