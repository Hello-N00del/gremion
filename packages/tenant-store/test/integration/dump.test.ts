// TASK-075 on Postgres 18 (the scratch stack): the pre-migration dump under
// the real runner (TDD 7), the restore rehearsal (TDD 9, TRD-206's test), the
// member-import dump (TDD 10) and the scratch e2e (TDD 11): a serving colour
// answers 200 through the next release's expand, a simulated switch deletes
// the dump and logs it, nothing of the release is left.
//
// pg_dump/pg_restore run INSIDE the scratch server's container (cli.ts
// dumpTools with a container: the server's own pg_dump 18). The host tool
// infra/host/bin/gremion-migration-dump runs under bash (Git Bash on Windows,
// never WSL) with a logger shim; its dir mode/owner checks belong to `take`,
// which these specs drive through the node side. On Windows (no uid, NTFS
// modes) the node side's POSIX dir checks are replaced by a stand-in that
// reports a 0700 dir owned by this process; on Linux they run for real.
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'
import { chainPreApply } from '../../../../scripts/migrations/pre-apply.mjs'
import { dumpTools, runCli } from '../../src/dump/cli.js'
import { composePreApply, dumpHook } from '../../src/dump/hook.js'
import { readEvents, type DumpEvent } from '../../src/dump/ledger.js'
import { defaultDumpFs, type DumpFs } from '../../src/dump/take.js'
import { envResolveTarget, tenantModuleDbName } from '../../src/names.js'
import { MigrationRunnerError, runMigrations } from '../../src/runner.js'
import { schemaGate } from '../../src/schema-gate.js'
import { createTenantStore } from '../../src/store.js'
import { assertNonProductionDbUrl, connect, dbUrl, ddlLog, ledgerFiles, resetWithProbe, serverUrl, stack } from '../harness/db.js'
import { cleanupFixtures, copyFixture, FIXTURE_RELEASE, writeManifest } from '../harness/migrations.js'
import { createFixtureService } from '../fixtures/service.js'

const WORKTREE = fileURLToPath(new URL('../../../../', import.meta.url))
const TOOL = join(WORKTREE, 'infra', 'host', 'bin', 'gremion-migration-dump')
const SCRATCH = join(WORKTREE, '.scratch', `t075-dump-${process.pid}`)
const phaseFor = FIXTURE_RELEASE.phaseFor

/** Windows has no uid and NTFS reports no POSIX modes: stand in for them there only. */
const FS: DumpFs = process.platform === 'win32' ? { ...defaultDumpFs, statDir: () => ({ isDirectory: true, mode: 0o700, uid: 0 }), uid: 0 } : defaultDumpFs

function gitBash(): string {
  if (process.platform !== 'win32') return 'bash'
  for (const p of ['C:/Program Files/Git/bin/bash.exe', 'C:/Program Files/Git/usr/bin/bash.exe']) if (existsSync(p)) return p
  throw new Error('[t075] Git Bash not found (WSL bash is never used)')
}

const container = () => `t020-${stack().sha8}-pg`

let n = 0
function freshDumpDir(): string {
  const d = join(SCRATCH, `dumps-${++n}`)
  mkdirSync(d, { recursive: true, mode: 0o700 })
  chmodSync(d, 0o700)
  return d
}

/** The host tool, as gremion-deploy would call it, against the scratch server. */
function hostTool(dumpDir: string, args: string[]): { status: number | null; out: string; logger: string[] } {
  const shims = join(SCRATCH, 'shims')
  const loggerLog = join(SCRATCH, `logger-${n}.log`)
  mkdirSync(shims, { recursive: true })
  writeFileSync(join(shims, 'logger'), '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$T075_LOGGER_LOG"\n', { mode: 0o755 })
  rmSync(loggerLog, { force: true })
  const fwd = (p: string) => p.replaceAll('\\', '/')
  // Windows spells it Path: drop every casing before setting ours, or the child sees two.
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toUpperCase() !== 'PATH'))
  const r = spawnSync(gitBash(), [fwd(TOOL), ...args], {
    encoding: 'utf8',
    env: {
      ...base,
      PATH: `${shims}${delimiter}${process.env.PATH ?? ''}`,
      GREMION_ROOT: fwd(join(SCRATCH, 'root')),
      GREMION_MIGRATION_DUMP_DIR: fwd(dumpDir),
      GREMION_MIGRATION_DUMP_PG_CONTAINER: container(),
      POSTGRES_USER: stack().user,
      T075_LOGGER_LOG: fwd(loggerLog),
      MSYS_NO_PATHCONV: '1',
    },
    timeout: 120_000,
  })
  const logger = existsSync(loggerLog) ? readFileSync(loggerLog, 'utf8').trim().split('\n').filter(Boolean) : []
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, logger }
}

const events = (dir: string) => readEvents(dir).map((e: DumpEvent) => e.event)
const dumpFiles = (dir: string, release: string) => (existsSync(join(dir, release)) ? readdirSync(join(dir, release)).filter((f) => f.endsWith('.dump')) : [])

describe('TASK-075: the pre-migration dump on Postgres 18', () => {
  const { A } = inject('tenants')
  const dbA = tenantModuleDbName(A, 'fixture')
  let a: ReturnType<typeof connect>
  let watcher: ReturnType<typeof connect>

  beforeAll(() => {
    mkdirSync(join(SCRATCH, 'root'), { recursive: true })
  })

  beforeEach(async () => {
    await a?.end({ timeout: 5 }).catch(() => {})
    await watcher?.end({ timeout: 5 }).catch(() => {})
    await resetWithProbe(dbA)
    a = connect(dbA)
    watcher = connect(dbA, { max: 1 })
  })

  afterAll(async () => {
    await a?.end({ timeout: 5 }).catch(() => {})
    await watcher?.end({ timeout: 5 }).catch(() => {})
    cleanupFixtures()
    rmSync(SCRATCH, { recursive: true, force: true })
    await resetWithProbe(dbA)
  })

  /** Applies 001 only, then empties the DDL probe: two files (002, 003) pend. */
  async function onlyInit() {
    await runMigrations({ sql: a, dir: copyFixture({ only: ['001_init.sql'] }), ...FIXTURE_RELEASE, log: () => {} })
    await a`TRUNCATE t020_probe.ddl_log`
  }

  function hookFor(dumpDir: string, release: string, seen: { ddlAtDump?: number; ledgerAtDump?: string[]; lockHeldByOther?: boolean; calls: number }, chainFiles = ['001_init.sql', '002_item_state.sql', '003_item_state_idx.sql']) {
    const tools = dumpTools(new URL(dbUrl(dbA)), container())
    const exporter = {
      async dump(target: { service: string; database: string }, file: string) {
        seen.calls++
        seen.ddlAtDump = (await ddlLog(watcher)).length
        seen.ledgerAtDump = await ledgerFiles(watcher)
        const [l] = await watcher<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND granted AND pid <> pg_backend_pid()`
        seen.lockHeldByOther = (l?.n ?? 0) > 0
        return tools.exporter.dump(target, file)
      },
      list: (file: string) => tools.exporter.list(file),
    }
    return composePreApply(
      chainPreApply({ chainFiles }),
      dumpHook({ dir: dumpDir, release, exporter, pgDumpMajor: tools.pgDumpMajor, fs: FS, audit: () => {} }),
    )
  }

  it('two pending files: ONE pg_dump under the migration lock before the first BEGIN (DDL log empty), one `created` line; nothing pending: no dump', async () => {
    await onlyInit()
    const dumpDir = freshDumpDir()
    const seen = { calls: 0 } as { ddlAtDump?: number; ledgerAtDump?: string[]; lockHeldByOther?: boolean; calls: number }
    const r = await runMigrations({ sql: a, dir: copyFixture(), releaseRef: 'dist-v1.1.0', phaseFor, log: () => {}, hooks: { preApply: hookFor(dumpDir, 'dist-v1.1.0', seen) } })
    expect(r.applied).toEqual(['002_item_state.sql', '003_item_state_idx.sql'])
    expect(seen).toMatchObject({ calls: 1, ddlAtDump: 0, ledgerAtDump: ['001_init.sql'], lockHeldByOther: true })
    const ev = readEvents(dumpDir)
    expect(ev.map((e) => e.event)).toEqual(['created'])
    expect(ev[0]).toMatchObject({ release: 'dist-v1.1.0', scope: 'customer', customer_id: A, module_id: 'fixture', database: dbA })
    expect(dumpFiles(dumpDir, 'dist-v1.1.0')).toHaveLength(1)
    // the ledger rows carry phase and release_ref
    const rows = await a<{ filename: string; phase: string; release_ref: string; contract_after: string | null }[]>`SELECT filename, phase, release_ref, contract_after FROM public.schema_migrations ORDER BY filename`
    expect(rows.slice(1)).toEqual([
      { filename: '002_item_state.sql', phase: 'expand', release_ref: 'dist-v1.1.0', contract_after: null },
      { filename: '003_item_state_idx.sql', phase: 'expand', release_ref: 'dist-v1.1.0', contract_after: null },
    ])
    // nothing pending: no dump, no line
    const again = { calls: 0 }
    expect((await runMigrations({ sql: a, dir: copyFixture(), releaseRef: 'dist-v1.2.0', phaseFor, log: () => {}, hooks: { preApply: hookFor(dumpDir, 'dist-v1.2.0', again) } })).applied).toEqual([])
    expect(again.calls).toBe(0)
    expect(events(dumpDir)).toEqual(['created'])
  }, 120_000)

  it('a chain refusal (a pad-3 ledger name the pad-4 chain lacks) takes no dump: no `created` line, empty DDL log', async () => {
    await onlyInit()
    const dumpDir = freshDumpDir()
    const seen = { calls: 0 }
    const err = await runMigrations({ sql: a, dir: copyFixture(), releaseRef: 'dist-v1.1.0', phaseFor, log: () => {}, hooks: { preApply: hookFor(dumpDir, 'dist-v1.1.0', seen, ['0001_init.sql', '0002_item_state.sql', '0003_item_state_idx.sql']) } }).catch((e: unknown) => e)
    expect((err as MigrationRunnerError).code).toBe('PRE_APPLY_FAILED')
    expect(String(((err as Error).cause as Error).message)).toMatch(/LEDGER_NAME_NOT_IN_CHAIN/)
    expect(seen.calls).toBe(0)
    expect(events(dumpDir)).toEqual([])
    expect(await ddlLog(watcher)).toEqual([])
    expect(await ledgerFiles(watcher)).toEqual(['001_init.sql'])
  }, 120_000)

  it('PHASE_MISSING refuses before any hook: no dump, empty DDL log', async () => {
    await onlyInit()
    const dumpDir = freshDumpDir()
    const seen = { calls: 0 }
    const err = await runMigrations({ sql: a, dir: copyFixture(), releaseRef: 'dist-v1.1.0', log: () => {}, hooks: { preApply: hookFor(dumpDir, 'dist-v1.1.0', seen) } }).catch((e: unknown) => e)
    expect((err as MigrationRunnerError).code).toBe('PHASE_MISSING')
    expect(seen.calls).toBe(0)
    expect(events(dumpDir)).toEqual([])
    expect(await ddlLog(watcher)).toEqual([])
  }, 120_000)

  it('restore rehearsal (TRD-206): the second file fails; restore --accept-loss-since returns schema and seeded rows to the pre-run state and logs `restored`; the dump stays until discard', async () => {
    await onlyInit()
    await a`INSERT INTO item (note) VALUES ('seeded-before-the-release')`
    const dir = copyFixture()
    writeFileSync(join(dir, '003_item_state_idx.sql'), '-- the failing second file\nCREATE INDEX broken_idx ON no_such_table (x);\n')
    writeManifest(dir)
    const dumpDir = freshDumpDir()
    const err = await runMigrations({ sql: a, dir, releaseRef: 'dist-v1.1.0', phaseFor, log: () => {}, hooks: { preApply: hookFor(dumpDir, 'dist-v1.1.0', { calls: 0 }) } }).catch((e: unknown) => e)
    expect((err as MigrationRunnerError).code).toBe('APPLY_FAILED')
    // the first file of the run is applied: the column exists now
    expect(await ledgerFiles(watcher)).toEqual(['001_init.sql', '002_item_state.sql'])
    await a.end({ timeout: 5 })
    await watcher.end({ timeout: 5 })

    expect(hostTool(dumpDir, ['restore', '--release', 'dist-v1.1.0', '--db', dbA]).status).toBe(2)
    const r = hostTool(dumpDir, ['restore', '--release', 'dist-v1.1.0', '--db', dbA, '--accept-loss-since', '2026-09-29T03:00:00Z'])
    expect(r.status, r.out).toBe(0)
    expect(r.out).toMatch(/RESTORE-OK release=dist-v1\.1\.0/)
    expect(r.logger.join('\n')).toMatch(/-t premigration-dump -- premigration-dump restored/)

    a = connect(dbA)
    watcher = connect(dbA, { max: 1 })
    expect(await ledgerFiles(watcher)).toEqual(['001_init.sql'])
    const cols = await watcher<{ column_name: string }[]>`SELECT column_name FROM information_schema.columns WHERE table_name = 'item' ORDER BY column_name`
    expect(cols.map((c) => c.column_name)).toEqual(['id', 'note'])
    expect((await watcher<{ note: string }[]>`SELECT note FROM item`).map((x) => x.note)).toEqual(['seeded-before-the-release'])
    expect(events(dumpDir)).toEqual(['created', 'restored'])
    expect(dumpFiles(dumpDir, 'dist-v1.1.0')).toHaveLength(1)

    const d = hostTool(dumpDir, ['discard', '--release', 'dist-v1.1.0', '--reason', 'release abandoned after restore'])
    expect(d.status, d.out).toBe(0)
    expect(events(dumpDir)).toEqual(['created', 'restored', 'deleted'])
    expect(readEvents(dumpDir)[2]).toMatchObject({ reason: 'release abandoned after restore', by_kind: 'operator' })
    expect(dumpFiles(dumpDir, 'dist-v1.1.0')).toEqual([])
  }, 240_000)

  it('member import (TASK-031 handoff): take, one INSERT and one DELETE, discard --reason import-verified: exactly one created, one deleted', async () => {
    await onlyInit()
    await a`INSERT INTO item (note) VALUES ('member-1'), ('member-2')`
    const dumpDir = freshDumpDir()
    const lines: string[] = []
    const io = { out: (l: string) => lines.push(l), err: (l: string) => lines.push(l) }
    const code = await runCli(['take', '--release', 'import-job1', '--db', dbA, '--pg-dump-container', container()], { GREMION_MIGRATE_URL: dbUrl(dbA), GREMION_MIGRATION_DUMP_DIR: dumpDir }, io, { fs: FS })
    expect(code, lines.join('\n')).toBe(0)
    expect(lines.join('\n')).toMatch(/TAKE-RESULT release=import-job1 .* status=created/)
    await a`INSERT INTO item (note) VALUES ('imported')`
    await a`DELETE FROM item WHERE note = 'member-1'`
    const d = hostTool(dumpDir, ['discard', '--release', 'import-job1', '--reason', 'import-verified'])
    expect(d.status, d.out).toBe(0)
    expect(events(dumpDir)).toEqual(['created', 'deleted'])
    expect(readEvents(dumpDir)[1]).toMatchObject({ reason: 'import-verified' })
    expect(dumpFiles(dumpDir, 'import-job1')).toEqual([])
  }, 180_000)

  it('scratch e2e: the serving colour (manifest {001,002}, dist-v1.0.0) answers 200 through the next release\'s expand; the simulated switch deletes the dump and logs it; nothing of the release is left', async () => {
    const serving = copyFixture({ only: ['001_init.sql', '002_item_state.sql'] })
    await runMigrations({ sql: a, dir: serving, releaseRef: 'dist-v1.0.0', phaseFor, log: () => {} })
    const env = envResolveTarget({ GREMION_FIXTURE_PG_URL: serverUrl() })
    const store = createTenantStore({ resolveTarget: (t, m) => { const x = env(t, m); assertNonProductionDbUrl(x.url); return x } })
    const gate = schemaGate({ dir: serving, openDb: (t) => store.openTenantDb(t, 'fixture'), releaseRef: 'dist-v1.0.0', cacheTtlMs: 0, log: () => {} })
    const server = createFixtureService({ store, gate, tenants: new Set([A]) })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/t/${A}/items`
    try {
      expect((await fetch(url)).status).toBe(200)
      const dumpDir = freshDumpDir()
      const statuses: number[] = []
      const r = await runMigrations({
        sql: a,
        dir: copyFixture(),
        releaseRef: 'dist-v1.1.0',
        phaseFor,
        log: () => {},
        hooks: { preApply: composePreApply(hookFor(dumpDir, 'dist-v1.1.0', { calls: 0 }), async () => void statuses.push((await fetch(url)).status)) },
      })
      expect(r.applied).toEqual(['003_item_state_idx.sql'])
      statuses.push((await fetch(url)).status)
      expect(statuses).toEqual([200, 200])
      expect(events(dumpDir)).toEqual(['created'])

      // the simulated switch: step 11 passed, gremion-deploy calls `switched`
      const s = hostTool(dumpDir, ['switched', '--release', 'dist-v1.1.0'])
      expect(s.status, s.out).toBe(0)
      expect(s.out).toMatch(/premigration-dump deleted id=\S+ release=dist-v1\.1\.0/)
      expect(s.out).toMatch(/SWITCHED-OK release=dist-v1\.1\.0 deleted=1/)
      expect(s.logger.join('\n')).toMatch(/-t premigration-dump -- premigration-dump deleted/)
      expect(events(dumpDir)).toEqual(['created', 'deleted'])
      expect(existsSync(join(dumpDir, 'dist-v1.1.0'))).toBe(false)
      expect((await fetch(url)).status).toBe(200)
      // switched again: nothing of R remains, exit 0
      const again = hostTool(dumpDir, ['switched', '--release', 'dist-v1.1.0'])
      expect(again.status).toBe(0)
      expect(again.out).toMatch(/no-dump dist-v1\.1\.0/)
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
      await store.close()
    }
  }, 240_000)

  it('cli migrate --chain platform on the real catalogue: chain check + dump composed; nothing pending -> no dump', async () => {
    const dumpDir = freshDumpDir()
    const lines: string[] = []
    const io = { out: (l: string) => lines.push(l), err: (l: string) => lines.push(l) }
    const code = await runCli(['migrate', '--chain', 'platform', '--release', 'dist-v0.0.2', '--pg-dump-container', container()], { GREMION_MIGRATE_URL: dbUrl('gremion_platform'), GREMION_MIGRATION_DUMP_DIR: dumpDir }, io, { fs: FS })
    expect(code, lines.join('\n')).toBe(0)
    expect(lines.join('\n')).toMatch(/MIGRATE-RESULT chain=platform release=dist-v0\.0\.2 applied=0 already=3 dump=none/)
    expect(events(dumpDir)).toEqual([])
  }, 120_000)
})
