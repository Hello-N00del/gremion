// TASK-029 TDD 7 (TRD-353) on Postgres 18 with TASK-020's runner and the
// fixture service: the boot verifies applied row sha256 = manifest = file
// before it listens. RED B is recorded first (the pre-TASK-029 service boots
// with an edited applied file + regenerated manifest); then the boot process
// exits non-zero naming the file with nothing listening and no DDL, and boots
// again once the file is restored. Plus the runtime hook under the real
// runner: refused under the lock, before any DDL.
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { chainPreApply } from '../../../../scripts/migrations/pre-apply.mjs'
import { envResolveTarget, tenantModuleDbName } from '../../src/names.js'
import { MigrationRunnerError, runMigrations } from '../../src/runner.js'
import { schemaGate } from '../../src/schema-gate.js'
import { createTenantStore } from '../../src/store.js'
import { assertNonProductionDbUrl, connect, ddlLog, ledgerFiles, resetWithProbe, serverUrl } from '../harness/db.js'
import { cleanupFixtures, copyFixture, FIXTURE_RELEASE, writeManifest } from '../harness/migrations.js'
import { createFixtureService } from '../fixtures/service.js'

const BOOT = fileURLToPath(new URL('../fixtures/boot.ts', import.meta.url))
const quiet = { log: () => {}, ...FIXTURE_RELEASE }

function boot(dir: string, tenants: string[]): Promise<{ code: number | null; stdout: string; stderr: string; port?: number; stop: () => Promise<void> }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', BOOT], { env: { ...process.env, T029_DIR: dir, T029_TENANTS: tenants.join(',') } })
    let stdout = ''
    let stderr = ''
    let settled = false
    const stop = () => new Promise<void>((r) => (child.exitCode !== null ? r() : (child.once('exit', () => r()), child.kill('SIGTERM'))))
    child.stdout.on('data', (d) => {
      stdout += d
      const m = /listening (\d+)/.exec(stdout)
      if (m && !settled) {
        settled = true
        resolve({ code: null, stdout, stderr, port: Number(m[1]), stop })
      }
    })
    child.stderr.on('data', (d) => (stderr += d))
    child.on('exit', (code) => {
      if (!settled) {
        settled = true
        resolve({ code, stdout, stderr, stop })
      }
    })
  })
}

describe('TRD-353: the fixture service verifies applied migrations before it listens', () => {
  const { A, B } = inject('tenants')
  const dbA = tenantModuleDbName(A, 'fixture')
  const dbB = tenantModuleDbName(B, 'fixture')
  let a: ReturnType<typeof connect>
  let b: ReturnType<typeof connect>
  let dir: string
  let original: Buffer

  beforeAll(async () => {
    await resetWithProbe(dbA)
    await resetWithProbe(dbB)
    a = connect(dbA)
    b = connect(dbB)
    dir = copyFixture()
    await runMigrations({ sql: a, dir, ...quiet })
    await runMigrations({ sql: b, dir, ...quiet })
    original = readFileSync(join(dir, '001_init.sql'))
    await a`TRUNCATE t020_probe.ddl_log`
    await b`TRUNCATE t020_probe.ddl_log`
  })

  afterAll(async () => {
    await a?.end()
    await b?.end()
    cleanupFixtures()
    await resetWithProbe(dbA)
    await resetWithProbe(dbB)
  })

  it('RED B (recorded): without the boot check, an applied file edited + manifest regenerated still boots and listens', async () => {
    writeFileSync(join(dir, '001_init.sql'), Buffer.concat([original, Buffer.from('-- edited after it was applied\n')]))
    writeManifest(dir)
    const env = envResolveTarget({ GREMION_FIXTURE_PG_URL: serverUrl() })
    const store = createTenantStore({ resolveTarget: (t, m) => { const x = env(t, m); assertNonProductionDbUrl(x.url); return x } })
    const gate = schemaGate({ dir, openDb: (t) => store.openTenantDb(t, 'fixture'), cacheTtlMs: 0, log: () => {} })
    const server = createFixtureService({ store, gate, tenants: new Set([A]) })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    try {
      // it booted: the old shape only notices per request (503 'diverged')
      expect((server.address() as AddressInfo).port).toBeGreaterThan(0)
      expect(await gate.check(A)).toMatchObject({ ok: false, reason: 'diverged' })
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
      await store.close()
    }
    // TASK-020's runner already refuses the same state when it runs
    await expect(runMigrations({ sql: a, dir, ...quiet })).rejects.toMatchObject({ code: 'LEDGER_HASH_MISMATCH' })
  })

  it('bootFixtureService: the same state exits non-zero naming the file, never listens, executes no DDL', async () => {
    const r = await boot(dir, [A])
    expect(r.code).toBe(1)
    expect(r.stdout).not.toMatch(/listening/)
    expect(r.stderr).toMatch(/APPLIED_NOT_MANIFEST 001_init\.sql/)
    expect(await ddlLog(a)).toEqual([])
  })

  it('restored, it boots and serves', async () => {
    writeFileSync(join(dir, '001_init.sql'), original)
    writeManifest(dir)
    const r = await boot(dir, [A, B])
    try {
      expect(r.port).toBeGreaterThan(0)
      expect((await fetch(`http://127.0.0.1:${r.port}/t/${A}/items`)).status).toBe(200)
    } finally {
      await r.stop()
    }
  })

  it('RED A shape: a tampered manifest entry for an applied file refuses the boot, naming it', async () => {
    const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Record<string, string>
    const kept = m['002_item_state.sql']!
    m['002_item_state.sql'] = 'f'.repeat(64)
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(m))
    try {
      const r = await boot(dir, [A])
      expect(r.code).toBe(1)
      expect(r.stderr).toMatch(/FILE_NOT_MANIFEST 002_item_state\.sql/)
    } finally {
      m['002_item_state.sql'] = kept
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify(m))
    }
  })

  it('a NULL sha256 row, or a ledger without the column, refuses the boot naming the row -- never skipped', async () => {
    await b.unsafe(`ALTER TABLE public.schema_migrations ALTER COLUMN sha256 DROP NOT NULL`)
    const checks = await b<{ conname: string }[]>`SELECT conname FROM pg_constraint WHERE conrelid = 'public.schema_migrations'::regclass AND contype = 'c'`
    for (const c of checks) await b.unsafe(`ALTER TABLE public.schema_migrations DROP CONSTRAINT "${c.conname}"`)
    await b`UPDATE public.schema_migrations SET sha256 = NULL WHERE filename = '001_init.sql'`
    const nul = await boot(dir, [B])
    expect(nul.code).toBe(1)
    expect(nul.stderr).toMatch(/NULL_HASH 001_init\.sql/)
    await b.unsafe(`ALTER TABLE public.schema_migrations DROP COLUMN sha256`)
    const none = await boot(dir, [B])
    expect(none.code).toBe(1)
    expect(none.stderr).toMatch(/LEDGER_WITHOUT_HASH 001_init\.sql/)
  })

  it('TDD 6 under the real runner: the chain hook refuses before any DDL, ledger unchanged', async () => {
    await resetWithProbe(dbB)
    const only1 = copyFixture({ only: ['001_init.sql'] })
    await runMigrations({ sql: b, dir: only1, ...quiet })
    await b`TRUNCATE t020_probe.ddl_log`
    // the chain the register declares no longer holds 001_init.sql (renamed in another dir)
    const hook = chainPreApply({ chainFiles: ['001_renamed.sql', '002_item_state.sql', '003_item_state_idx.sql'] })
    const err = await runMigrations({ sql: b, dir, hooks: { preApply: hook }, ...quiet }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(MigrationRunnerError)
    expect((err as MigrationRunnerError).code).toBe('PRE_APPLY_FAILED')
    expect(String(((err as Error).cause as Error).message)).toMatch(/LEDGER_NAME_NOT_IN_CHAIN/)
    expect(await ledgerFiles(b)).toEqual(['001_init.sql'])
    expect(await ddlLog(b)).toEqual([])
  })
})
