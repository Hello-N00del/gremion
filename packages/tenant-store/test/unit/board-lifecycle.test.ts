// Board has a module database of its own (runtime.database on board-postgres) and an export under the
// retention profile rp-brd-module-data. These guards run the REAL enableModule, disableModule and
// finalizeDueKarenz against the REAL modules/board/module.json, with a module server and an exporter that
// RECORD every touch, and assert that each of them WAS touched: the roles and the tenant's board database
// are created on board-postgres, the owner session is opened, the dump is taken before the block, the app
// role loses CONNECT, and at day 30 the blocked database is dropped and the export is deleted when no hold
// applies. The chain apply and the enablement row run for real in modules/board/test/lifecycle.integration.test.ts
// (scratch Postgres), which also reads the shipped module.json; a stateful fake cannot carry the migration runner.
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { disableModule } from '../../src/lifecycle/disable.js'
import { enableModule } from '../../src/lifecycle/enable.js'
import { finalizeDueKarenz, type FinalizeDeps } from '../../src/lifecycle/karenz.js'
import type { Exporter, LifecycleDeps, LifecycleModule, ModuleServer } from '../../src/lifecycle/types.js'
import { tenantModuleDbName } from '../../src/names.js'

const TENANT = '0192f0c1-2b3c-7d4e-8f00-112233445566'
const MODULE_ROW = '0192f0c1-2b3c-7d4e-8f00-aaaaaaaaaaaa'
const VERSION_ROW = '0192f0c1-2b3c-7d4e-8f00-bbbbbbbbbbbb'
const ISOLATION_ROW = '0192f0c1-2b3c-7d4e-8f00-cccccccccccc'
const DPIA_ROW = '0192f0c1-2b3c-7d4e-8f00-dddddddddddd'
const KARENZ_ROW = '0192f0c1-2b3c-7d4e-8f00-ffffffffffff'
const ACTOR = { kind: 'operator', id: '0192f0c1-2b3c-7d4e-8f00-eeeeeeeeeeee' } as never
const DB = tenantModuleDbName(TENANT, 'board')
const STOP = new Error('stop: the owner session was opened')

const BOARD_DIR = fileURLToPath(new URL('../../../../modules/board', import.meta.url))
const EXPORT_DIR = mkdtempSync(join(tmpdir(), 'board-lifecycle-'))
afterAll(() => rmSync(EXPORT_DIR, { recursive: true, force: true }))

function boardModule(): LifecycleModule {
  const moduleJson = JSON.parse(readFileSync(`${BOARD_DIR}/module.json`, 'utf8')) as LifecycleModule['moduleJson']
  return { id: 'board', dir: BOARD_DIR, moduleJson }
}

interface Statement {
  text: string
  values: unknown[]
}
type Answer = (s: Statement) => unknown[]
type FakeSql = ((strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>) & {
  unsafe: (text: string, values?: unknown[]) => Promise<unknown[]>
  begin: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>
}

/** A connection that records every statement and answers through `answer`; the server's format() is evaluated here. */
function fakeSql(statements: Statement[], answer: Answer): FakeSql {
  const record = (text: string, values: unknown[]): Statement => {
    const s = { text: text.replace(/\s+/g, ' ').trim(), values }
    statements.push(s)
    return s
  }
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => Promise.resolve(answer(record(strings.join('?'), values)))
  const unsafe = (text: string, values: unknown[] = []) => {
    if (/pg_catalog\.format\(/.test(text)) {
      const [template, ...args] = values as string[]
      let i = 0
      const stmt = template!.replace(/%([IL])/g, (_m, kind: string) => (kind === 'I' ? `"${args[i++]}"` : `'${args[i++]}'`))
      return Promise.resolve([{ stmt }])
    }
    return Promise.resolve(answer(record(text, values)))
  }
  return Object.assign(run, { unsafe, begin: async (fn: (tx: unknown) => Promise<unknown>) => fn(run) }) as FakeSql
}

/** The module server for board-postgres: every statement of its admin connection is recorded. */
function recordingServer(admin: Statement[], opened: { database: string; role?: string }[], asked: string[]) {
  const adminSql = fakeSql(admin, (s) => {
    if (/FROM pg_database d JOIN pg_roles r/.test(s.text)) return admin.some((a) => a.text.startsWith('CREATE DATABASE ')) ? [{ owner: 'm_board' }] : []
    if (/FROM pg_database WHERE datname/.test(s.text)) return [{ '?column?': 1 }]
    if (/count\(\*\)::int AS n FROM pg_stat_activity/.test(s.text)) return [{ n: 0 }]
    if (/has_database_privilege/.test(s.text)) return [{ can: false }]
    return []
  })
  const server: ModuleServer = {
    admin: adminSql as never,
    open: (database, options) => {
      opened.push({ database, ...(options?.role ? { role: options.role } : {}) })
      throw STOP
    },
  }
  return {
    server: (service: string) => {
      asked.push(service)
      return server
    },
  }
}

/** The platform rows that these paths read and write, kept in memory. */
function platformWorld(statements: Statement[]) {
  const db = { present: false, state: 'enabling', exportPath: null as string | null, exportSha: null as string | null, exportedAt: null as Date | null }
  const karenz = { present: false, finalAt: new Date('2026-12-11T00:00:00Z') }
  const sql = fakeSql(statements, (s) => {
    const t = s.text
    if (/current_database\(\)/.test(t)) return [{ db: 'gremion_platform' }]
    if (/FROM plt\.module m JOIN plt\.module_version v/.test(t)) return [{ module_id: MODULE_ROW, module_version_id: VERSION_ROW }]
    if (/SELECT module_id::text FROM plt\.module WHERE module_key/.test(t)) return [{ module_id: MODULE_ROW }]
    if (t.startsWith('INSERT INTO plt.module_database')) {
      db.present = true
      return []
    }
    if (t.startsWith('SELECT db_name')) {
      return db.present ? [{ db_name: DB, state: db.state, export_path: db.exportPath, export_sha256: db.exportSha, exported_at: db.exportedAt }] : []
    }
    if (t.startsWith('UPDATE plt.module_database SET state = ')) {
      db.state = s.values[0] as string
      return [{ '?column?': 1 }]
    }
    if (t.startsWith('UPDATE plt.module_database SET export_path = ')) {
      db.exportPath = s.values[0] as string
      db.exportSha = s.values[1] as string
      db.exportedAt = new Date()
      return [{ '?column?': 1 }]
    }
    if (t.startsWith('UPDATE plt.module_enablement')) return [{ '?column?': 1 }]
    if (t.startsWith('INSERT INTO plt.module_karenz')) {
      karenz.present = true
      return []
    }
    if (t.startsWith('SELECT karenz_id::text, state, final_at')) {
      return karenz.present ? [{ karenz_id: KARENZ_ROW, state: 'open', final_at: karenz.finalAt, tenant_done_at: null }] : []
    }
    return []
  })
  return { sql, db, karenz }
}

describe('board has a module database of its own (the shipped module.json)', () => {
  it('declares the database on board-postgres with its migrations and the export under rp-brd-module-data, and no withhold list', () => {
    const runtime = boardModule().moduleJson.runtime
    expect(runtime.database).toEqual({ postgresService: 'board-postgres', migrations: 'migrations' })
    expect(runtime.export).toEqual({ kind: 'pg_dump', retentionProfile: 'rp-brd-module-data' })
  })

  it('enableModule asks board-postgres, creates the owner and app roles and the tenant board database, then opens it as the owner', async () => {
    const statements: Statement[] = []
    const platform = platformWorld(statements)
    const adminStatements: Statement[] = []
    const opened: { database: string; role?: string }[] = []
    const asked: string[] = []
    const deps = {
      platform: platform.sql,
      enableGate: async () => ({ isolationTestResultId: ISOLATION_ROW, dpiaDecisionId: DPIA_ROW }),
      secrets: { appPassword: () => 'a-test-password-of-sufficient-length' },
      releaseRef: 'dist-v0.0.1',
      ...recordingServer(adminStatements, opened, asked),
    } as unknown as LifecycleDeps

    await expect(enableModule(TENANT, boardModule(), ACTOR, deps)).rejects.toBe(STOP)

    expect(asked).toEqual(['board-postgres'])
    const text = adminStatements.map((s) => s.text)
    expect(text.some((s) => s.startsWith('CREATE ROLE "m_board" NOLOGIN'))).toBe(true)
    expect(text.some((s) => s.startsWith('CREATE ROLE "m_board_app" LOGIN'))).toBe(true)
    expect(text).toContain(`CREATE DATABASE "${DB}" OWNER "m_board"`)
    expect(text).toContain(`GRANT CONNECT ON DATABASE "${DB}" TO "m_board_app"`)
    expect(opened).toEqual([{ database: DB, role: 'm_board' }])
    // the visible, resumable state is written first, with the board's own database name
    expect(statements.find((s) => s.text.startsWith('INSERT INTO plt.module_database'))?.values).toContain(DB)
  })

  it('disableModule exports the board database with the exporter, then blocks it: the app role loses CONNECT, and a Karenz row is opened with that export', async () => {
    const statements: Statement[] = []
    const platform = platformWorld(statements)
    platform.db.present = true
    platform.db.state = 'enabled'
    const adminStatements: Statement[] = []
    const asked: string[] = []
    const dumped: { service: string; database: string }[] = []
    const exporter: Exporter = {
      dump: async (target, file) => {
        dumped.push(target)
        writeFileSync(file, 'PGDMP board fixture', { flag: 'wx', mode: 0o600 })
      },
      list: async () => `; Archive created at 2026-11-18 10:00:00 UTC\n;     dbname: ${DB}\n`,
    }
    const deps = { platform: platform.sql, exportDir: EXPORT_DIR, exporter, ...recordingServer(adminStatements, [], asked) } as unknown as LifecycleDeps

    const r = await disableModule(TENANT, boardModule(), ACTOR, deps)

    expect(dumped).toEqual([{ service: 'board-postgres', database: DB }])
    expect(asked).toContain('board-postgres')
    expect(r).toMatchObject({ tenantId: TENANT, moduleId: 'board', database: DB, dropped: false, blocked: true, noop: false })
    expect(r.export?.bytes).toBeGreaterThan(0)
    expect(r.export?.path.endsWith('.dump')).toBe(true)
    expect(r.karenz?.karenzId).toBe(KARENZ_ROW)
    expect(adminStatements.map((s) => s.text)).toContain(`REVOKE CONNECT ON DATABASE "${DB}" FROM "m_board_app"`)
    // the export is recorded before the block, and the Karenz row carries the export of this switch-off
    expect(statements.some((s) => s.text.startsWith('UPDATE plt.module_database SET export_path'))).toBe(true)
    const karenzInsert = statements.find((s) => s.text.startsWith('INSERT INTO plt.module_karenz'))
    expect(karenzInsert?.values.slice(-2)).toEqual([r.export?.path, r.export?.sha256])
    expect(platform.db.state).toBe('blocked')
  })

  it('finalizeDueKarenz at day 30 drops the blocked board database and deletes its export when no hold applies', async () => {
    const statements: Statement[] = []
    const dbRow = { state: 'blocked' }
    // the export of a switch-off: a real file whose sha256 the row records
    const dir = join(EXPORT_DIR, TENANT, 'board')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, '20261111T000000000Z.dump')
    writeFileSync(path, 'PGDMP board day 30')
    writeFileSync(`${path}.sha256`, 'x')
    const sha = createHash('sha256').update('PGDMP board day 30').digest('hex')
    const row = {
      karenz_id: KARENZ_ROW,
      customer_id: TENANT,
      module_id: MODULE_ROW,
      module_key: 'board',
      state: 'open',
      export_path: path,
      export_sha256: sha,
      export_deleted_at: null,
      platform_done_at: null,
      tenant_done_at: null,
      retained_ok_at: null,
      final_at: new Date('2026-12-11T00:00:00Z'),
      export_kept_until: null,
    }
    const sql = fakeSql(statements, (s) => {
      if (s.text.startsWith('SELECT k.karenz_id::text')) return [row]
      if (/SELECT state FROM plt\.module_karenz WHERE karenz_id/.test(s.text)) return [{ state: 'open' }]
      if (s.text.startsWith('SELECT db_name')) return [{ db_name: DB, state: dbRow.state, export_path: path, export_sha256: sha, exported_at: new Date() }]
      if (s.text.startsWith('UPDATE plt.module_database SET state = ')) {
        dbRow.state = s.values[0] as string
        return [{ '?column?': 1 }]
      }
      return []
    })
    const adminStatements: Statement[] = []
    const asked: string[] = []
    const deleted: string[] = []
    const steps: string[] = []
    const deps = {
      platform: sql,
      catalogue: [boardModule()],
      exportDir: EXPORT_DIR,
      exportStorage: (tenantId: string) => ({
        tenantId,
        put: async () => {
          throw new Error('put is not expected')
        },
        read: async () => {
          throw new Error('read is not expected')
        },
        delete: async (h: string) => void deleted.push(h),
        list: async () => [],
      }),
      finalDeletion: true,
      now: () => new Date('2026-12-12T00:00:00Z'),
      hooks: { afterStep: (step: string) => void steps.push(step) },
      ...recordingServer(adminStatements, [], asked),
    } as unknown as FinalizeDeps

    const r = await finalizeDueKarenz(deps)

    expect(r.errors).toEqual([])
    expect(r).toMatchObject({ due: 1, finalized: 1, kept: 0, dryRun: false })
    expect(asked).toEqual(['board-postgres'])
    expect(adminStatements.map((s) => s.text)).toContain(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`)
    expect(dbRow.state).toBe('dropped')
    expect(deleted).toEqual([`${TENANT}/board/20261111T000000000Z.dump`, `${TENANT}/board/20261111T000000000Z.dump.sha256`])
    expect(steps).toEqual(['export-verified', 'cas-finalizing', 'db-dropped', 'cas-dropped', 'export-deleted', 'platform-done'])
  })
})
