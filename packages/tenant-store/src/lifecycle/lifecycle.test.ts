// @gremion/tenant-store/lifecycle — the no-database half: target guards,
// the gate's default-deny, input refusals before any statement, the platform
// migration folder, and the export verification (a recording/fake exporter).
// The database half is test/integration/lifecycle-*.test.ts.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import type { Sql } from '@gremion/db'
import { readVerifiedMigrations } from '../manifest.js'
import { tenantModuleDbName } from '../names.js'
import { pinBaseline, pinnedPhaseFor, resolvePhase } from '../phase.js'
import { PINNED_BASELINE } from '../phase-baseline.js'
import { splitStatements } from '../strip-outer-transaction.js'
import * as lifecycle from './index.js'
import { PLATFORM_CHAIN } from './platform.js'

/** The kernel checkout (src/lifecycle -> four up); the unit suite runs from one. */
const REPO = fileURLToPath(new URL('../../../../', import.meta.url))
import {
  assertTenantModuleTarget,
  disableModule,
  enableModule,
  exportDatabase,
  exportStamp,
  LifecycleError,
  moduleRoles,
  PLATFORM_MIGRATIONS_DIR,
  scramSha256Verifier,
  type Exporter,
  type LifecycleDeps,
  type LifecycleModule,
} from './index.js'

const T = '0192f0c1-2b3c-7d4e-8f00-112233445566'
const U = '0192f0c1-2b3c-7d4e-8f00-665544332211'
const ACTOR = { kind: 'operator' as const, id: '0192f0c1-2b3c-7d4e-9000-000000000001' }
const SCRATCH = join(fileURLToPath(new URL('../../../../.scratch/', import.meta.url)), `t021-unit-${process.pid}`)
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }))

const mod = (id: string, database = true): LifecycleModule => ({
  id,
  dir: '/nonexistent',
  moduleJson: {
    schemaVersion: 1,
    id,
    extractionSource: 'f276af5925abacdcfd05f6613fc11afff2d804c5',
    runtime: {
      version: '1.0.0',
      database: database ? { postgresService: `${id}-postgres`, migrations: 'migrations' } : null,
      export: database ? { kind: 'pg_dump', retentionProfile: 'rp-fix-module-data' } : null,
      timedJobs: [],
      platformServer: null,
    },
  },
})

/** A deps object whose every database handle throws on first use: proves a refusal ran no SQL. */
function untouchableDeps(overrides: Partial<LifecycleDeps> = {}): { deps: LifecycleDeps; touched: string[] } {
  const touched: string[] = []
  const trap = (name: string) =>
    new Proxy(function () {}, {
      apply() {
        touched.push(name)
        throw new Error(`${name} was used`)
      },
      get(_t, prop) {
        touched.push(`${name}.${String(prop)}`)
        throw new Error(`${name}.${String(prop)} was used`)
      },
    }) as unknown as Sql
  const deps: LifecycleDeps = {
    platform: trap('platform'),
    server: (service) => {
      touched.push(`server(${service})`)
      return { admin: trap('admin'), open: () => trap('open') }
    },
    enableGate: () => ({ isolationTestResultId: T, dpiaDecisionId: U }),
    secrets: { appPassword: () => 'x'.repeat(24) },
    exporter: { dump: async () => touched.push('dump') as unknown as void, list: async () => '' },
    exportDir: SCRATCH,
    ...overrides,
  }
  return { deps, touched }
}

describe('the lifecycle subpath', () => {
  it('exports enableModule, disableModule and inspectTenantDatabases (the package root does not)', () => {
    for (const name of ['enableModule', 'disableModule', 'inspectTenantDatabases', 'migratePlatform', 'pgDumpExporter']) expect(lifecycle, name).toHaveProperty(name)
  })
})

describe('assertTenantModuleTarget (§9: the only names the lifecycle creates, opens or drops)', () => {
  it('accepts exactly tenantModuleDbName(tenant, module)', () => {
    expect(assertTenantModuleTarget(tenantModuleDbName(T, 'board'), T, 'board')).toBe(tenantModuleDbName(T, 'board'))
  })

  it.each([
    ['control', 'the legacy control database'],
    ['gremion_platform', 'the platform catalogue'],
    ['synapse', 'a platform server database (Amendment R27 test 9)'],
    ['postgres', 'the maintenance database'],
    ['t_x', 'a short t_ name'],
  ])('refuses %s (%s)', (name) => {
    expect(() => assertTenantModuleTarget(name, T, 'board')).toThrow(LifecycleError)
  })

  it("refuses the tenant's kernel database, another tenant's and another module's", () => {
    expect(() => assertTenantModuleTarget(tenantModuleDbName(T, 'kernel'), T, 'board')).toThrow(/kernel database/)
    expect(() => assertTenantModuleTarget(tenantModuleDbName(U, 'board'), T, 'board')).toThrow(/owns/)
    expect(() => assertTenantModuleTarget(tenantModuleDbName(T, 'calendar'), T, 'board')).toThrow(/owns/)
  })

  it('module id kernel and an injection id are refused as modules', () => {
    expect(() => moduleRoles('kernel')).toThrow(/reserved/)
    expect(() => moduleRoles('x"; DROP DATABASE control; --')).toThrow(LifecycleError)
    expect(moduleRoles('board')).toEqual({ owner: 'm_board', app: 'm_board_app' })
  })
})

describe('refusals run no SQL at all', () => {
  it('Q3: enableModule without an enableGate refuses before touching any database', async () => {
    const { deps, touched } = untouchableDeps()
    const noGate = { ...deps, enableGate: undefined } as unknown as LifecycleDeps
    await expect(enableModule(T, mod('board'), ACTOR, noGate)).rejects.toMatchObject({ code: 'GATE_REFUSED' })
    expect(touched).toEqual([])
  })

  it('a bad tenant id, a kernel module, a mismatched module.json and a bad actor are refused before any statement', async () => {
    const { deps, touched } = untouchableDeps()
    await expect(enableModule('not-a-uuid', mod('board'), ACTOR, deps)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(enableModule(T, mod('kernel'), ACTOR, deps)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    const lying = mod('board')
    lying.moduleJson.id = 'calendar'
    await expect(enableModule(T, lying, ACTOR, deps)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(enableModule(T, mod('board'), { kind: 'system' as 'person', id: ACTOR.id }, deps)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(disableModule(T, mod('kernel'), ACTOR, deps)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(touched).toEqual([])
  })

  it('TASK-075 G1b: an enable of a module with a database and no releaseRef (or a bad one) is refused before any statement', async () => {
    const { deps, touched } = untouchableDeps()
    for (const releaseRef of [undefined, '', 'x'.repeat(65), 'a\nb']) {
      const d = { ...deps, releaseRef } as unknown as LifecycleDeps
      await expect(enableModule(T, mod('board'), ACTOR, d)).rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringMatching(/releaseRef/) })
    }
    expect(touched).toEqual([])
  })
})

describe('the platform migration folder (gremion_platform, schema plt)', () => {
  const files = readVerifiedMigrations(PLATFORM_MIGRATIONS_DIR)

  it('is verified against its sha256 manifest: 0001 setup, 0002 module tables, 0003 module_database, 0004 provisioning ledger (TASK-043), 0005 request queue (TASK-043d)', () => {
    expect(files.map((f) => f.file)).toEqual(['0001_plt_setup.sql', '0002_plt_module.sql', '0003_plt_module_database.sql', '0004_plt_provisioning_step.sql', '0005_plt_provisioning_request.sql'])
    for (const f of files) expect(() => splitStatements(f.text)).not.toThrow()
  })

  it('TASK-075 G1b: migratePlatform\'s default phase lookup (the baseline this package ships) knows every locked platform file', () => {
    const phaseFor = pinnedPhaseFor(PLATFORM_CHAIN, PINNED_BASELINE)
    expect(files.map((f) => resolvePhase(f.file, f.text, phaseFor).phase)).toEqual(['contract', 'expand', 'expand', 'expand', 'expand'])
  })

  // TASK-075 r2: enableModule's default (no deps.phaseFor, as tenant-create
  // runs it) must phase every migration of every kernel module with a
  // database from the shipped baseline alone (headerless locked files) or
  // from the file's own header (files added later).
  it('TASK-075 r2: enableModule\'s default phase lookup resolves every module database migration of the kernel tree', () => {
    const modulesRoot = join(REPO, 'modules')
    const resolved: string[] = []
    for (const id of readdirSync(modulesRoot).sort()) {
      const mj = join(modulesRoot, id, 'module.json')
      if (!existsSync(mj)) continue
      const database = (JSON.parse(readFileSync(mj, 'utf8')) as { runtime?: { database?: { migrations: string } | null } }).runtime?.database
      if (!database) continue
      const phaseFor = pinnedPhaseFor(`module-${id}`, PINNED_BASELINE)
      for (const f of readVerifiedMigrations(join(modulesRoot, id, database.migrations))) {
        expect(() => resolvePhase(f.file, f.text, phaseFor), `${id}/${f.file}`).not.toThrow()
        resolved.push(`${id}/${f.file}`)
      }
    }
    expect(resolved.length).toBeGreaterThan(0)
    expect(resolved).toContain('board/001_init.sql')
  })

  it('TASK-075 r2: the shipped baseline is the kernel baseline joined with applied.lock.json (no drift)', () => {
    const read = (...p: string[]) => JSON.parse(readFileSync(join(REPO, ...p), 'utf8')) as never
    expect(PINNED_BASELINE).toEqual(pinBaseline(read('scripts', 'migrations', 'runner', 'expand-contract-baseline.json'), read('scripts', 'migrations', 'applied.lock.json')))
  })

  it('0004 is SCHEMA DB-PLT-PROVISIONING-STEP with exactly two appended kinds (TASK-043 Q2) and stays append-only', () => {
    const text = files[3]!.text
    expect(text).toContain('CREATE TABLE plt.provisioning_step (')
    expect(text).toMatch(/WHEN 'broker_account_created' THEN 7 WHEN 'mail_principal_issued' THEN 8/)
    expect(text).toMatch(/CREATE UNIQUE INDEX provisioning_step_customer_id_step_kind_key ON plt\.provisioning_step \(customer_id, step_kind\)\s+WHERE status = 'done'/)
    // UPDATE, DELETE and TRUNCATE all refused (review B1, r2), on both tables
    for (const t of ['provisioning_step', 'operator_enable_attestation']) {
      expect(text).toMatch(new RegExp(`${t}_append_only_trg BEFORE UPDATE OR DELETE ON plt\\.${t}\\s+FOR EACH ROW EXECUTE FUNCTION plt\\.refuse_update\\(\\)`))
      expect(text).toMatch(new RegExp(`${t}_no_truncate_trg BEFORE TRUNCATE ON plt\\.${t}\\s+FOR EACH STATEMENT EXECUTE FUNCTION plt\\.refuse_update\\(\\)`))
    }
  })

  it('0002 carries the three SCHEMA tables with the level-1 gate check, and omits only the isolation-test FKs', () => {
    const text = files[1]!.text
    for (const t of ['plt.module (', 'plt.module_version (', 'plt.module_enablement (']) expect(text).toContain(`CREATE TABLE ${t}`)
    expect(text).toMatch(/CONSTRAINT module_enablement_gate_check CHECK \(state <> 'enabled'\s+OR \(isolation_test_result_id IS NOT NULL AND dpia_decision_id IS NOT NULL\s+AND enabled_by IS NOT NULL AND enabled_at IS NOT NULL\)\)/)
    const code = text.replace(/--[^\n]*/g, '')
    expect(code).not.toMatch(/REFERENCES plt\.isolation_test_result/)
    expect(code).toMatch(/GENERATED ALWAYS AS \('cross_customer'\) STORED/)
  })

  it('0003 refuses a dropped row without a recorded export, in the database itself', () => {
    expect(files[2]!.text).toMatch(/CONSTRAINT module_database_dropped_export_check CHECK \(state <> 'dropped' OR exported_at IS NOT NULL\)/)
  })
})

describe('scramSha256Verifier', () => {
  it('writes the PostgreSQL SCRAM-SHA-256 stored format, deterministic for a fixed salt', () => {
    const salt = Buffer.alloc(16, 7)
    const v = scramSha256Verifier('a-generated-secret-123', { salt })
    expect(v).toMatch(/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]{24}\$[A-Za-z0-9+/=]{44}:[A-Za-z0-9+/=]{44}$/)
    expect(scramSha256Verifier('a-generated-secret-123', { salt })).toBe(v)
    expect(scramSha256Verifier('a-generated-secret-124', { salt })).not.toBe(v)
  })

  it('refuses a short or non-ASCII password', () => {
    expect(() => scramSha256Verifier('short')).toThrow(/16-256 printable ASCII/)
    expect(() => scramSha256Verifier('ä'.repeat(20))).toThrow(/16-256 printable ASCII/)
  })
})

describe('exportDatabase — verify before anything may be dropped (TDD 8, no database)', () => {
  const target = { service: 'board-postgres', database: tenantModuleDbName(T, 'board') }
  const where = { exportDir: SCRATCH, tenantId: T, moduleId: 'board' }
  let tick = 0
  const at = () => new Date(Date.UTC(2026, 8, 28, 6, 0, 0, tick++))
  const TOC = `;\n; Archive created at 2026-09-28 06:00:00 UTC\n;     dbname: ${target.database}\n;     TOC Entries: 3\n`
  const writing = (bytes: string, toc: string | Error): Exporter => ({
    dump: async (_t, file) => writeFileSync(file, bytes),
    list: async () => {
      if (toc instanceof Error) throw toc
      return toc
    },
  })

  it('a verified export: the file, its size, its sha256 and a .sha256 beside it', async () => {
    const r = await exportDatabase(writing('PGDMP-fake-archive', TOC), target, where, at())
    expect(r.bytes).toBe('PGDMP-fake-archive'.length)
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(readFileSync(`${r.path}.sha256`, 'utf8')).toBe(`${r.sha256}  ${r.path.split(/[\\/]/).pop()}\n`)
    expect(r.path.startsWith(join(SCRATCH, T, 'board'))).toBe(true)
    // mode 0600 (Q7); Windows has no POSIX group/other bits to assert on
    const groupOtherBits = process.platform === 'win32' ? 0 : statSync(r.path).mode & 0o077
    expect(groupOtherBits).toBe(0)
  })

  it('an exporter that throws -> EXPORT_FAILED', async () => {
    const boom: Exporter = { dump: async () => { throw new Error('pg_dump: connection refused') }, list: async () => TOC }
    await expect(exportDatabase(boom, target, where, at())).rejects.toMatchObject({ code: 'EXPORT_FAILED' })
  })

  it('an exporter that writes 0 bytes -> EXPORT_UNVERIFIED', async () => {
    await expect(exportDatabase(writing('', TOC), target, where, at())).rejects.toMatchObject({ code: 'EXPORT_UNVERIFIED' })
  })

  it('an archive pg_restore cannot list, or one of another database -> EXPORT_UNVERIFIED', async () => {
    await expect(exportDatabase(writing('garbage', new Error('pg_restore: input file does not appear to be a valid archive')), target, where, at())).rejects.toMatchObject({ code: 'EXPORT_UNVERIFIED' })
    await expect(exportDatabase(writing('PGDMP', TOC.replace(target.database, tenantModuleDbName(U, 'board'))), target, where, at())).rejects.toMatchObject({ code: 'EXPORT_UNVERIFIED' })
  })

  it('an existing export file is never overwritten', async () => {
    const now = at()
    const dir = join(SCRATCH, T, 'board')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${exportStamp(now)}.dump`), 'earlier export')
    const overwrite: Exporter = { dump: async (_t, file) => writeFileSync(file, 'new', { flag: 'wx' }), list: async () => TOC }
    await expect(exportDatabase(overwrite, target, where, now)).rejects.toMatchObject({ code: 'EXPORT_FAILED' })
    expect(readFileSync(join(dir, `${exportStamp(now)}.dump`), 'utf8')).toBe('earlier export')
    expect(existsSync(join(dir, `${exportStamp(now)}.dump.sha256`))).toBe(false)
  })

  it('exportStamp is sortable UTC without separators', () => {
    expect(exportStamp(new Date(Date.UTC(2026, 8, 28, 6, 30, 0, 123)))).toBe('20260928T063000123Z')
  })
})
