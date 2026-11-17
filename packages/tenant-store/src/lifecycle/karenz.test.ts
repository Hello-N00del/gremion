// Task 3 (module Karenz), the no-database half: the constants, the deletion
// switch and the export path guard. The database half is
// test/integration/lifecycle-karenz.test.ts.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStorageBackend } from '@gremion/storage'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { tenantModuleDbName } from '../names.js'
import {
  assertKarenzExportPath,
  finalDeletionEnabled,
  finalizeDueKarenz,
  KARENZ_DAYS,
  verifyRowExport,
  type DueRow,
  type ExportHoldContext,
  type FinalizeDeps,
  type KarenzState,
} from './karenz.js'
import type { LifecycleModule } from './types.js'

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
    final_at: new Date('2026-11-01T00:00:00Z'),
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

// The export hold: whether the day-30 run keeps a switched-off module's export is decided from the ROW (its
// state, whether the module database is already dropped, its final_at), never from what this run happened to do.
// The platform and the module server are recording fakes that keep the little state the decision reads, so a
// run can be crashed and repeated without a database.
describe('finalizeDueKarenz: the export hold is decided from the row', () => {
  const content = 'dump bytes'
  const sha = createHash('sha256').update(content).digest('hex')
  const root = mkdtempSync(join(tmpdir(), 'karenz hold '))
  afterAll(() => rmSync(root, { recursive: true, force: true }))
  const FINAL_AT = new Date('2026-12-01T10:00:00Z')
  const NOW = new Date('2026-12-02T10:00:00Z')
  const FUTURE = new Date('2027-12-01T10:00:00Z')
  const BOTH = [`${T}/lcfix/a.dump`, `${T}/lcfix/a.dump.sha256`]
  type Hold = NonNullable<FinalizeDeps['exportHold']>

  type Fix = { state: KarenzState; db: 'blocked' | 'dropped' | 'enabled'; platformDone?: Date | null }
  function holdHarness(fix: Fix, hold: FinalizeDeps['exportHold'], over: Partial<FinalizeDeps> = {}) {
    const exportDir = join(root, `case-${Math.random().toString(36).slice(2)}`)
    const dump = join(exportDir, T, 'lcfix', 'a.dump')
    mkdirSync(join(exportDir, T, 'lcfix'), { recursive: true })
    writeFileSync(dump, content)
    writeFileSync(`${dump}.sha256`, `${sha}  a.dump\n`)
    const row = {
      karenz_id: 'k1',
      customer_id: T,
      module_id: 'm1',
      module_key: 'lcfix',
      state: fix.state,
      export_path: dump,
      export_sha256: sha,
      export_deleted_at: null as Date | null,
      platform_done_at: (fix.platformDone ?? null) as Date | null,
      tenant_done_at: null,
      retained_ok_at: null,
      final_at: FINAL_AT,
    }
    const md = { state: fix.db }
    const events: string[] = []
    const deleted: string[] = []
    const written = { keptUntil: null as Date | null }
    const queries = async (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
      const text = strings.join('?')
      if (/AS p FROM/.test(text)) return []
      if (/FROM plt\.module_karenz k JOIN/.test(text)) return [{ ...row }]
      if (/SELECT db_name, state/.test(text)) return [{ db_name: tenantModuleDbName(T, 'lcfix'), state: md.state, export_path: dump, export_sha256: sha, exported_at: new Date() }]
      if (/UPDATE plt\.module_database/.test(text)) {
        md.state = 'dropped'
        events.push('cas-dropped')
        return [{}]
      }
      if (/SET export_kept_until/.test(text)) {
        events.push('kept')
        written.keptUntil = values[0] as Date
        return []
      }
      if (/SET export_deleted_at/.test(text)) {
        events.push('export-deleted')
        return []
      }
      if (/SET platform_done_at/.test(text)) {
        events.push('platform-done')
        row.platform_done_at = NOW
        return []
      }
      if (/FOR UPDATE SKIP LOCKED/.test(text)) return [{ state: row.state }]
      return []
    }
    const platform = Object.assign(queries, {
      begin: async (fn: (tx: typeof queries) => Promise<unknown>) => {
        const out = await fn(queries)
        row.state = 'finalizing'
        return out
      },
    })
    const admin = {
      unsafe: async (text: string) => {
        if (/^SELECT pg_catalog\.format/.test(text)) return [{ stmt: 'DROP DATABASE IF EXISTS x' }]
        events.push('db-dropped')
        return []
      },
    }
    const deps = {
      platform,
      server: () => ({
        admin,
        open: () => {
          throw new Error('unused')
        },
      }),
      catalogue: [{ id: 'lcfix', moduleJson: { runtime: { database: { postgresService: 'pgm' } } } }] as unknown as LifecycleModule[],
      exportDir,
      exportStorage: (tenant: string) => {
        const s = new MemoryStorageBackend(tenant)
        s.delete = async (handle: string) => {
          deleted.push(handle)
        }
        return Object.assign(s, { root: exportDir })
      },
      finalDeletion: true,
      now: () => NOW,
      exportHold: hold,
      ...over,
    } as unknown as FinalizeDeps
    return { deps, row, md, events, deleted, written }
  }

  it('a row left half done after the drop is asked again, with the database read as dropped, and its export is kept', async () => {
    // the state a crash at the step after the drop leaves: finalizing, platform side not done, database row dropped
    const hold = vi.fn<Hold>(() => FUTURE)
    const h = holdHarness({ state: 'finalizing', db: 'dropped' }, hold)
    const r = await finalizeDueKarenz(h.deps)
    expect(r).toMatchObject({ finalized: 1, kept: 1, errors: [] })
    expect(hold).toHaveBeenCalledTimes(1)
    expect(hold).toHaveBeenCalledWith(T, 'lcfix', { karenzState: 'finalizing', databaseDropped: true, finalAt: FINAL_AT })
    expect(h.written.keptUntil).toEqual(FUTURE)
    expect(h.deleted).toEqual([])
    expect(h.events).toEqual(['kept', 'platform-done'])
    expect(existsSync(h.row.export_path)).toBe(true)
  })

  it('a run that drops the database asks for the hold with the row state it read and databaseDropped true', async () => {
    const hold = vi.fn<Hold>(() => FUTURE)
    const h = holdHarness({ state: 'open', db: 'blocked' }, hold)
    const r = await finalizeDueKarenz(h.deps)
    expect(r).toMatchObject({ finalized: 1, kept: 1, errors: [] })
    expect(h.events).toEqual(['db-dropped', 'cas-dropped', 'kept', 'platform-done'])
    expect(hold).toHaveBeenCalledWith(T, 'lcfix', { karenzState: 'open', databaseDropped: true, finalAt: FINAL_AT })
    expect(h.deleted).toEqual([])
  })

  it('a throw from the hold after the drop keeps the export; the next run, which reads the database as dropped, keeps it with the hold', async () => {
    let calls = 0
    const hold = vi.fn<Hold>(() => {
      calls += 1
      if (calls === 1) throw new Error('the hold table could not be read')
      return FUTURE
    })
    const h = holdHarness({ state: 'open', db: 'blocked' }, hold)
    const first = await finalizeDueKarenz(h.deps)
    expect(first.errors).toHaveLength(1)
    expect(first.errors[0]?.message).toMatch(/hold table/)
    expect(h.md.state).toBe('dropped')
    expect(h.deleted).toEqual([])
    expect(h.row.platform_done_at).toBeNull()
    expect(existsSync(h.row.export_path)).toBe(true)
    const second = await finalizeDueKarenz(h.deps)
    expect(second).toMatchObject({ finalized: 1, kept: 1, errors: [] })
    expect(hold).toHaveBeenLastCalledWith(T, 'lcfix', { karenzState: 'finalizing', databaseDropped: true, finalAt: FINAL_AT })
    expect(h.deleted).toEqual([])
  })

  it('a hold date that is not a valid date is an error and the export stays', async () => {
    for (const bad of [new Date('not a date'), 'tomorrow' as unknown as Date]) {
      const h = holdHarness({ state: 'finalizing', db: 'dropped' }, () => bad)
      const r = await finalizeDueKarenz(h.deps)
      expect(r.errors).toHaveLength(1)
      expect(r.errors[0]?.message).toMatch(/hold/i)
      expect(h.deleted).toEqual([])
      expect(h.events).toEqual([])
    }
  })

  it('a restored Karenz does not consult the hold and its export is deleted: nothing was lost', async () => {
    const hold = vi.fn<Hold>(() => FUTURE)
    const h = holdHarness({ state: 'restored', db: 'enabled' }, hold)
    const r = await finalizeDueKarenz(h.deps)
    expect(r).toMatchObject({ finalized: 0, kept: 0, errors: [] })
    expect(hold).not.toHaveBeenCalled()
    expect(h.deleted).toEqual(BOTH)
    expect(h.events).toEqual(['export-deleted'])
  })

  it('a hold that has passed, or none, deletes the export', async () => {
    for (const hold of [() => new Date('2026-12-02T10:00:00Z'), () => new Date('2020-01-01T00:00:00Z'), () => null, undefined]) {
      const h = holdHarness({ state: 'finalizing', db: 'dropped' }, hold)
      const r = await finalizeDueKarenz(h.deps)
      expect(r).toMatchObject({ finalized: 1, kept: 0, errors: [] })
      expect(h.deleted).toEqual(BOTH)
    }
  })

  it('the second pass, after the kept date, asks again from the finalized row and deletes the export', async () => {
    const hold = vi.fn<Hold>((_t, _m, c) => new Date(c.finalAt.getTime() + 1000))
    const h = holdHarness({ state: 'finalized', db: 'dropped', platformDone: new Date('2026-12-01T11:00:00Z') }, hold)
    const r = await finalizeDueKarenz(h.deps)
    expect(r).toMatchObject({ due: 1, finalized: 0, kept: 0, errors: [] })
    expect(hold).toHaveBeenCalledWith(T, 'lcfix', { karenzState: 'finalized', databaseDropped: true, finalAt: FINAL_AT })
    expect(h.deleted).toEqual(BOTH)
    expect(h.events).toEqual(['export-deleted'])
  })

  it('a dry run drops nothing, deletes nothing and never asks the hold', async () => {
    const hold = vi.fn<Hold>(() => FUTURE)
    const h = holdHarness({ state: 'open', db: 'blocked' }, hold, { finalDeletion: false })
    const r = await finalizeDueKarenz(h.deps)
    expect(r).toMatchObject({ due: 1, finalized: 0, kept: 0, dryRun: true })
    expect(hold).not.toHaveBeenCalled()
    expect(h.events).toEqual([])
    expect(h.deleted).toEqual([])
  })
})
