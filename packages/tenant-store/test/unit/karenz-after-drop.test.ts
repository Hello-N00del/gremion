// CD stage 1, unit U6g: finalizeDueKarenz gets ONE optional dependency, afterDrop(tenantId, moduleKey, dbName), so a
// live pre-migration dump of a database the day-30 job drops is retired with it (a failed catch-up leaves the dump
// live on purpose; it must not outlive its database). It is driven from the ROW and not from what this run did:
// called on every pass of a row whose module database row is `dropped`, before the export step, so a crash between
// the drop's state write and the call is repaired by the next hourly run. The platform and the module server are
// recording fakes that keep the little state the decision reads (as karenz.test.ts does), so a run can be crashed
// and repeated without a database. The throwaway-Postgres half is test/integration/enable-catchup.test.ts.
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStorageBackend } from '@gremion/storage'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { finalizeDueKarenz, type FinalizeDeps } from '../../src/lifecycle/karenz.js'
import type { LifecycleModule } from '../../src/lifecycle/types.js'
import { tenantModuleDbName } from '../../src/names.js'

const T = '0192f0c1-2b3c-7d4e-8f00-112233445566'
const content = 'dump bytes'
const sha = createHash('sha256').update(content).digest('hex')
const root = mkdtempSync(join(tmpdir(), 'karenz after drop '))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const FINAL_AT = new Date('2026-12-01T10:00:00Z')
const NOW = new Date('2026-12-02T10:00:00Z')
const DB = tenantModuleDbName(T, 'lcfix')

type KState = 'open' | 'finalizing'

function harness(fix: { state: KState; db: 'blocked' | 'dropped'; declaresDatabase?: boolean }, over: Partial<FinalizeDeps> = {}) {
  const exportDir = join(root, `case-${Math.random().toString(36).slice(2)}`)
  const dump = join(exportDir, T, 'lcfix', 'a.dump')
  mkdirSync(join(exportDir, T, 'lcfix'), { recursive: true })
  writeFileSync(dump, content)
  writeFileSync(`${dump}.sha256`, `${sha}  a.dump\n`)
  const row = {
    karenz_id: 'k1', customer_id: T, module_id: 'm1', module_key: 'lcfix', state: fix.state as string, export_path: dump, export_sha256: sha,
    export_deleted_at: null as Date | null, platform_done_at: null as Date | null, tenant_done_at: null, retained_ok_at: null, final_at: FINAL_AT, export_kept_until: null,
  }
  const md = { state: fix.db as string }
  const events: string[] = []
  const queries = async (strings: TemplateStringsArray): Promise<unknown[]> => {
    const text = strings.join('?')
    if (/FROM plt\.module_karenz k JOIN/.test(text)) return [{ ...row }]
    if (/SELECT db_name, state/.test(text)) return [{ db_name: DB, state: md.state, export_path: dump, export_sha256: sha, exported_at: new Date() }]
    if (/UPDATE plt\.module_database/.test(text)) {
      md.state = 'dropped'
      events.push('cas-dropped')
      return [{}]
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
      if (text.startsWith('SELECT pg_catalog.format')) return [{ stmt: 'DROP DATABASE IF EXISTS x' }]
      events.push('db-dropped')
      return []
    },
  }
  const module = fix.declaresDatabase === false ? { database: null } : { database: { postgresService: 'pgm' } }
  const deps = {
    platform,
    server: () => ({ admin, open: () => { throw new Error('unused') } }),
    catalogue: [{ id: 'lcfix', moduleJson: { runtime: module } }] as unknown as LifecycleModule[],
    exportDir,
    exportStorage: (tenant: string) => {
      const s = new MemoryStorageBackend(tenant)
      s.delete = async () => {
        events.push('export-removed')
      }
      return Object.assign(s, { root: exportDir })
    },
    finalDeletion: true,
    now: () => NOW,
    ...over,
  } as unknown as FinalizeDeps
  return { deps, row, md, events }
}

describe('finalizeDueKarenz: afterDrop', () => {
  it('is called once with (tenant, module, database name) when this run drops the database, after the state write and before the export step', async () => {
    const h = harness({ state: 'open', db: 'blocked' })
    const afterDrop = vi.fn(async (_t: string, _m: string, _db: string) => {
      h.events.push('after-drop')
    })
    h.deps.afterDrop = afterDrop
    const r = await finalizeDueKarenz(h.deps)
    expect(r).toMatchObject({ finalized: 1, errors: [] })
    expect(afterDrop).toHaveBeenCalledTimes(1)
    expect(afterDrop).toHaveBeenCalledWith(T, 'lcfix', DB)
    expect(h.events.indexOf('after-drop')).toBeGreaterThan(h.events.indexOf('cas-dropped'))
    expect(h.events.indexOf('after-drop')).toBeLessThan(h.events.indexOf('export-removed'))
  })

  it('the crash case: a throw at cas-dropped (before afterDrop) and a second run: the row is finalizing with the database row dropped, and afterDrop is called FROM THE ROW', async () => {
    let crash = true
    const h = harness({ state: 'open', db: 'blocked' }, {
      hooks: {
        afterStep: (step) => {
          if (step === 'cas-dropped' && crash) throw new Error('the process died after the state write')
        },
      },
    })
    const afterDrop = vi.fn()
    h.deps.afterDrop = afterDrop
    const first = await finalizeDueKarenz(h.deps)
    expect(first.errors).toHaveLength(1)
    expect(h.md.state).toBe('dropped')
    expect(afterDrop).not.toHaveBeenCalled()
    crash = false
    const second = await finalizeDueKarenz(h.deps)
    expect(second).toMatchObject({ finalized: 1, errors: [] })
    expect(h.row.state).toBe('finalizing')
    expect(afterDrop).toHaveBeenCalledTimes(1)
    expect(afterDrop).toHaveBeenCalledWith(T, 'lcfix', DB)
  })

  it('is called on every pass of a row whose database is dropped, so it must be (and is, in the retire) idempotent', async () => {
    const afterDrop = vi.fn()
    const h = harness({ state: 'finalizing', db: 'dropped' }, { afterDrop, exportHold: () => new Date('2027-12-01T00:00:00Z') })
    await finalizeDueKarenz(h.deps)
    h.row.platform_done_at = null
    await finalizeDueKarenz(h.deps)
    expect(afterDrop).toHaveBeenCalledTimes(2)
    expect(afterDrop).toHaveBeenNthCalledWith(1, T, 'lcfix', DB)
  })

  it('a throw from afterDrop is logged with the Karenz id and never stops the finalize: the export step and the platform side still complete', async () => {
    const log: string[] = []
    const h = harness({ state: 'open', db: 'blocked' }, { afterDrop: async () => { throw new Error('LEDGER_LOCKED: a stale lock') }, log: (l) => log.push(l) })
    const r = await finalizeDueKarenz(h.deps)
    expect(r).toMatchObject({ finalized: 1, errors: [] })
    expect(h.events).toContain('export-removed')
    expect(h.events).toContain('platform-done')
    expect(log.join('\n')).toMatch(/could not be retired for Karenz k1 \(LEDGER_LOCKED: a stale lock\)/)
    // the database name never reaches the retire's own log line
    expect(log.filter((l) => /could not be retired/.test(l)).join('\n')).not.toContain(DB)
  })

  it('is not called while the database is still blocked (the drop did not happen), for a module with no database, or in a dry run', async () => {
    const afterDrop = vi.fn()
    const noDb = harness({ state: 'open', db: 'blocked', declaresDatabase: false }, { afterDrop })
    await finalizeDueKarenz(noDb.deps)
    const dry = harness({ state: 'open', db: 'blocked' }, { afterDrop, finalDeletion: false })
    await finalizeDueKarenz(dry.deps)
    // a drop that fails leaves the row blocked: nothing is called
    const failing = harness({ state: 'open', db: 'blocked' }, { afterDrop })
    failing.deps.server = () => ({ admin: { unsafe: async () => { throw new Error('the server is down') } }, open: () => { throw new Error('unused') } }) as never
    const r = await finalizeDueKarenz(failing.deps)
    expect(r.errors).toHaveLength(1)
    expect(failing.md.state).toBe('blocked')
    expect(afterDrop).not.toHaveBeenCalled()
  })

  it('without the dependency nothing changes (every existing caller)', async () => {
    const h = harness({ state: 'open', db: 'blocked' })
    const r = await finalizeDueKarenz(h.deps)
    expect(r).toMatchObject({ finalized: 1, errors: [] })
  })
})
