/**
 * `node dist/index.js --migrate-only` (the CD leaf step) against a throwaway Postgres.
 *
 * Runs against CONTENT_TEST_PG_URL under the same fail-closed guard as the other integration tests
 * (localhost, NOT port 5432, a `_test_` database prefix). It uses a prefix of its OWN
 * (`content_mo_test_`) so it never touches the databases of the other integration files, and drops only
 * what it made. The real-bundle runs use the production prefix `content_` (the bundle has no other) on
 * the same throwaway server and drop exactly the three names they create.
 *
 * Coverage:
 *  - the catalogue is read without creating anything (no control database, no catalogue table);
 *  - a catalogued customer with a database is `migrated`, one without is `skipped` and NO database is created;
 *  - a hostile slug in the catalogue is found in no stream;
 *  - the session advisory lock (an entry waits for a holder of the lock);
 *  - idempotence: a second run and a cold-miss storeFor leave the schema fingerprint identical, and every
 *    file of the image's migrations/ applied twice does too;
 *  - the overlap with the OLD runner (new files then the previous release's files; the detector goes red
 *    on a file that redefines a function an old file creates), and a real concurrent race of two entries
 *    and an unlocked old runner;
 *  - exit codes: catalogue-race errors are retried then exit 3, a plain syntax error is exit 1, a bad
 *    manifest hash is exit 1, an unreachable server is exit 3;
 *  - the real esbuild bundle: one JSON line on stdout and nothing else, the process ends by itself.
 */
import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { classifyFailure, MAX_ATTEMPTS, MIGRATE_LOCK_NAME, runMigrateOnly, type MigrateFn } from '../src/migrate-only.ts'
import { _resetTenantStoreForTests, storeFor } from '../src/tenant-store.ts'
import { assertSafeTestEnv, requireEphemeralTestPgUrl } from './support/pg-test-guard.ts'

const TEST_PG_URL = requireEphemeralTestPgUrl()
const PREFIX = 'content_mo_test_'
const PROD_PREFIX = 'content_'
// The databases the real-bundle runs create under the production prefix (a hostile slug never gets one).
const PROD_DATABASES = ['control', 'alpha', 'beta'].map((n) => PROD_PREFIX + n)
assertSafeTestEnv(TEST_PG_URL, PREFIX)

const MODULE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const REAL_MIGRATIONS = path.join(MODULE_DIR, 'migrations')
// Inside node_modules so the bundle finds `postgres` and `zod` by the ordinary lookup, and so a stray
// directory is ignored by git.
const WORK_DIR = path.join(MODULE_DIR, 'node_modules', '.cache', `migrate-only-${randomBytes(4).toString('hex')}`)

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const ALPHA = { id: uuid(1), slug: 'alpha' }
const BETA = { id: uuid(2), slug: 'beta' }
const GAMMA = { id: uuid(3), slug: 'gamma' }
const HOSTILE = { id: uuid(9), slug: 'x"; DROP DATABASE postgres; --' }

let admin: ReturnType<typeof postgres>

function connect(db: string): ReturnType<typeof postgres> {
  const u = new URL(TEST_PG_URL)
  u.pathname = '/' + db
  return postgres(u.toString(), { max: 1, prepare: false, onnotice: () => {} })
}

async function dropAll(): Promise<void> {
  const rows = await admin<{ datname: string }[]>`
    SELECT datname FROM pg_database
     WHERE datname LIKE ${PREFIX.replace(/_/g, '\\_') + '%'} OR datname IN ${admin(PROD_DATABASES)}
  `
  for (const { datname } of rows) {
    await admin.unsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${datname}' AND pid <> pg_backend_pid()`,
    )
    await admin.unsafe(`DROP DATABASE IF EXISTS "${datname}"`)
  }
}

async function dbExists(name: string): Promise<boolean> {
  const rows = await admin`SELECT 1 FROM pg_database WHERE datname = ${name}`
  return rows.length > 0
}

/** A control database and catalogue with the rows given, and an EMPTY database for each slug in `withDb`. */
async function seedCatalogue(
  prefix: string,
  rows: { id: string; slug: string }[],
  withDb: string[],
): Promise<void> {
  await admin.unsafe(`CREATE DATABASE "${prefix}control"`)
  const ctrl = connect(prefix + 'control')
  try {
    await ctrl.unsafe(`
      CREATE TABLE tenant_catalog (
        tenant_id  UUID PRIMARY KEY,
        slug       TEXT NOT NULL UNIQUE,
        db_name    TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `)
    for (const r of rows) {
      await ctrl`INSERT INTO tenant_catalog (tenant_id, slug, db_name) VALUES (${r.id}, ${r.slug}, ${prefix + r.slug})`
    }
  } finally {
    await ctrl.end()
  }
  for (const slug of withDb) await admin.unsafe(`CREATE DATABASE "${prefix}${slug}"`)
}

async function catalogueCount(prefix: string): Promise<number> {
  const ctrl = connect(prefix + 'control')
  try {
    const rows = await ctrl<{ n: string }[]>`SELECT count(*)::text AS n FROM tenant_catalog`
    return Number(rows[0]!.n)
  } finally {
    await ctrl.end()
  }
}

/** Apply every *.sql file of a directory, in order, over one connection (what an image's runner does). */
async function applyDir(db: string, dir: string, times = 1): Promise<void> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()
  const sql = connect(db)
  try {
    for (const file of files) {
      const text = await readFile(path.join(dir, file), 'utf-8')
      for (let i = 0; i < times; i++) await sql.unsafe(text)
    }
  } finally {
    await sql.end()
  }
}

/** A schema dump without the database name: tables, columns, indexes, constraints, triggers, functions, views. */
async function fingerprint(db: string): Promise<string> {
  const sql = connect(db)
  try {
    const rows = await sql<{ fp: string | null }[]>`
      SELECT string_agg(line, E'\n' ORDER BY line) AS fp FROM (
        SELECT 'col ' || n.nspname || '.' || c.relname || '.' || a.attname || ' ' ||
               format_type(a.atttypid, a.atttypmod) || ' notnull=' || a.attnotnull::text ||
               ' def=' || coalesce(pg_get_expr(d.adbin, d.adrelid), '') AS line
          FROM pg_attribute a
          JOIN pg_class c ON c.oid = a.attrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
         WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'
           AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S') AND a.attnum > 0 AND NOT a.attisdropped
        UNION ALL
        SELECT 'idx ' || indexdef FROM pg_indexes WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
        UNION ALL
        SELECT 'con ' || coalesce(conrelid::regclass::text, '-') || ' ' || conname || ' ' || pg_get_constraintdef(oid)
          FROM pg_constraint
         WHERE connamespace NOT IN (SELECT oid FROM pg_namespace WHERE nspname IN ('pg_catalog', 'information_schema'))
        UNION ALL
        SELECT 'trg ' || pg_get_triggerdef(t.oid) FROM pg_trigger t WHERE NOT t.tgisinternal
        UNION ALL
        SELECT 'fn ' || pg_get_functiondef(p.oid)
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND p.prokind IN ('f', 'p')
        UNION ALL
        SELECT 'view ' || n.nspname || '.' || c.relname || ' ' || pg_get_viewdef(c.oid)
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND c.relkind IN ('v', 'm')
        UNION ALL
        SELECT 'schema ' || nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname <> 'information_schema'
      ) s
    `
    return createHash('sha256').update(rows[0]?.fp ?? '').digest('hex')
  } finally {
    await sql.end()
  }
}

/** A migrations directory (files and a manifest) written under WORK_DIR. */
async function writeFixture(name: string, files: Record<string, string>): Promise<string> {
  const dir = path.join(WORK_DIR, 'fixtures', name)
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  const manifest: Record<string, string> = {}
  for (const [file, text] of Object.entries(files)) {
    await writeFile(path.join(dir, file), text)
    manifest[file] = createHash('sha256').update(Buffer.from(text)).digest('hex')
  }
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest))
  return dir
}

const HARNESS = `
import { runMigrateOnly } from './src/migrate-only.js'
import { storeFor, closeAllPools } from './src/tenant-store.js'
const [mode, slug, id] = process.argv.slice(2)
const pgUrl = process.env.HARNESS_PG_URL
const dbPrefix = process.env.HARNESS_PREFIX
try {
  if (mode === 'entry') {
    const r = await runMigrateOnly({ openStore: storeFor }, { pgUrl, dbPrefix, retryDelayMs: 100 })
    process.stdout.write('\\n' + JSON.stringify(r) + '\\n')
  } else {
    await storeFor({ id, slug }, { pgUrl, dbPrefix })
    await closeAllPools()
    process.stdout.write('\\n' + JSON.stringify({ ok: true }) + '\\n')
  }
} catch (err) {
  process.stdout.write('\\n' + JSON.stringify({ ok: false, code: err && err.code }) + '\\n')
}
process.exit(0)
`

const EXTERNALS = ['@nats-io/transport-node', '@nats-io/jetstream', '@nats-io/nats-core', 'postgres', 'zod']

/**
 * Bundle `entry` (a file of src/ or the harness) the way the image's build does and put `migrationsDir` next
 * to it, so the bundle finds it exactly as the container does (../migrations of dist/).
 */
async function bundle(name: string, migrationsDir: string, entry: 'index' | 'harness'): Promise<string> {
  const root = path.join(WORK_DIR, name)
  await rm(root, { recursive: true, force: true })
  await mkdir(path.join(root, 'dist'), { recursive: true })
  await cp(migrationsDir, path.join(root, 'migrations'), { recursive: true })
  const outfile = path.join(root, 'dist', 'index.js')
  await build({
    ...(entry === 'index'
      ? { entryPoints: [path.join(MODULE_DIR, 'src', 'index.ts')] }
      : { stdin: { contents: HARNESS, resolveDir: MODULE_DIR, loader: 'ts' as const, sourcefile: 'harness.ts' } }),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile,
    external: EXTERNALS,
    logLevel: 'silent',
  })
  return outfile
}

interface Ran {
  code: number | null
  stdout: string
  stderr: string
}

/** The parent environment (Windows needs SystemRoot to resolve a name) minus every service variable, plus `extra`. */
function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of ['CONTENT_PG_URL', 'NATS_URL', 'PORT', 'SCHEDULER_ENABLED']) delete env[key]
  return { ...env, ...extra }
}

function run(file: string, args: string[], env: Record<string, string>): Promise<Ran> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [file, ...args],
      { env: childEnv(env), timeout: 60_000, killSignal: 'SIGKILL' },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : null
        resolve({ code, stdout, stderr })
      },
    )
  })
}

const lastJson = (text: string): Record<string, unknown> => JSON.parse(text.trim().split('\n').pop()!)

beforeAll(async () => {
  admin = postgres(TEST_PG_URL, { max: 1, prepare: false, onnotice: () => {} })
  await mkdir(WORK_DIR, { recursive: true })
  await dropAll()
})

afterAll(async () => {
  await _resetTenantStoreForTests()
  await dropAll()
  await admin.end()
  await rm(WORK_DIR, { recursive: true, force: true })
})

beforeEach(async () => {
  await _resetTenantStoreForTests()
  await dropAll()
})

const opts = { pgUrl: TEST_PG_URL, dbPrefix: PREFIX, retryDelayMs: 0 }
// What index.ts hands the entry: the leaf's own store opener.
const deps = { openStore: storeFor }

describe('the catalogue is read without creating anything', () => {
  it('no control database: total 0, exit 0, and the control database is NOT created', async () => {
    const result = await runMigrateOnly(deps, opts)
    expect(result).toEqual({ code: 0, counts: { v: 1, total: 0, migrated: 0, skipped: 0, failed: 0 } })
    expect(await dbExists(PREFIX + 'control')).toBe(false)
  })

  it('a control database with no catalogue table: total 0, exit 0, and the table is NOT created', async () => {
    await admin.unsafe(`CREATE DATABASE "${PREFIX}control"`)
    const result = await runMigrateOnly(deps, opts)
    expect(result.code).toBe(0)
    expect(result.counts.total).toBe(0)
    const ctrl = connect(PREFIX + 'control')
    try {
      const rows = await ctrl`SELECT to_regclass('tenant_catalog') AS t`
      expect(rows[0]!.t).toBeNull()
    } finally {
      await ctrl.end()
    }
  })
})

describe('every catalogued customer, in this process', () => {
  it('migrates the ones whose database exists, SKIPS the one without, and creates no database and no catalogue row', async () => {
    await seedCatalogue(PREFIX, [ALPHA, BETA, GAMMA], ['alpha', 'gamma'])
    await admin.unsafe(`CREATE DATABASE "${PREFIX}ref"`)
    await applyDir(PREFIX + 'ref', REAL_MIGRATIONS)

    const result = await runMigrateOnly(deps, opts)

    expect(result).toEqual({ code: 0, counts: { v: 1, total: 3, migrated: 2, skipped: 1, failed: 0 } })
    expect(await dbExists(PREFIX + 'beta')).toBe(false)
    expect(await catalogueCount(PREFIX)).toBe(3)
    const expected = await fingerprint(PREFIX + 'ref')
    expect(await fingerprint(PREFIX + 'alpha')).toBe(expected)
    expect(await fingerprint(PREFIX + 'gamma')).toBe(expected)
  })

  it('a hostile slug in the catalogue is counted failed (exit 1), reaches no stream and no database', async () => {
    await seedCatalogue(PREFIX, [ALPHA, HOSTILE], ['alpha'])
    const seen: string[] = []
    const spies = [
      vi.spyOn(process.stdout, 'write').mockImplementation(((c: unknown) => (seen.push(String(c)), true)) as never),
      vi.spyOn(process.stderr, 'write').mockImplementation(((c: unknown) => (seen.push(String(c)), true)) as never),
      vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void seen.push(a.join(' '))),
      vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => void seen.push(a.join(' '))),
      vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void seen.push(a.join(' '))),
    ]
    let result
    try {
      result = await runMigrateOnly(deps, opts)
    } finally {
      for (const s of spies) s.mockRestore()
    }
    expect(result.code).toBe(1)
    expect(result.counts).toEqual({ v: 1, total: 2, migrated: 1, skipped: 0, failed: 1 })
    expect(seen.join('\n')).not.toContain('DROP')
    expect(await dbExists('postgres')).toBe(true)
  })

  it('a manifest whose hash differs fails the customer closed (exit 1) before any DDL', async () => {
    await seedCatalogue(PREFIX, [ALPHA], ['alpha'])
    const files = (await readdir(REAL_MIGRATIONS)).filter((f) => f.endsWith('.sql'))
    const manifest = Object.fromEntries(files.map((f) => [f, '0'.repeat(64)]))
    const result = await runMigrateOnly(deps, { ...opts, manifest })
    expect(result.code).toBe(1)
    expect(result.counts).toMatchObject({ total: 1, migrated: 0, failed: 1 })
    const db = connect(PREFIX + 'alpha')
    try {
      const rows = await db`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'`
      expect(rows[0]!.n).toBe(0)
    } finally {
      await db.end()
    }
  })
})

describe('exit codes: a catalogue race is retried, a defect is not', () => {
  const pgErr = (code: string, extra: Record<string, unknown> = {}): Error =>
    Object.assign(new Error('boom'), { code, ...extra })
  const raceFirst = (): Error => pgErr('23505', { constraint_name: 'pg_type_typname_nsp_index' })

  /** A runner that fails with the given errors on its first attempts and then succeeds. */
  function failing(errors: Error[], always?: Error): { migrate: MigrateFn; calls: () => number } {
    let n = 0
    return {
      calls: () => n,
      migrate: async () => {
        const err = errors[n] ?? always
        n++
        if (err !== undefined) throw err
      },
    }
  }

  it('23505 on a pg_ index, then 42710, then 40P01 on the first attempts: retried, and the database ends migrated', async () => {
    await seedCatalogue(PREFIX, [ALPHA], ['alpha'])
    const f = failing([raceFirst(), pgErr('42710'), pgErr('40P01')])
    const result = await runMigrateOnly(deps, { ...opts, migrate: f.migrate })
    expect(result).toEqual({ code: 0, counts: { v: 1, total: 1, migrated: 1, skipped: 0, failed: 0 } })
    expect(f.calls()).toBe(MAX_ATTEMPTS)
  })

  it('the same race on every attempt ends exit 3 with failed 1, and NOT exit 1', async () => {
    await seedCatalogue(PREFIX, [ALPHA], ['alpha'])
    const f = failing([], raceFirst())
    const result = await runMigrateOnly(deps, { ...opts, migrate: f.migrate })
    expect(result.code).toBe(3)
    expect(result.counts).toMatchObject({ total: 1, migrated: 0, failed: 1 })
    expect(f.calls()).toBe(MAX_ATTEMPTS)
  })

  it('a plain 42601 syntax error is exit 1 and is not retried', async () => {
    await seedCatalogue(PREFIX, [ALPHA], ['alpha'])
    const f = failing([], pgErr('42601'))
    const result = await runMigrateOnly(deps, { ...opts, migrate: f.migrate })
    expect(result.code).toBe(1)
    expect(result.counts).toMatchObject({ failed: 1 })
    expect(f.calls()).toBe(1)
  })

  it('a server that goes away mid-run is exit 3, and the customers after it are counted failed without a connect timeout each', async () => {
    await seedCatalogue(PREFIX, [ALPHA, BETA, GAMMA], ['alpha', 'beta', 'gamma'])
    const calls: string[] = []
    const migrate: MigrateFn = async (tenant) => {
      calls.push(tenant.slug)
      throw pgErr('ECONNREFUSED')
    }
    const result = await runMigrateOnly(deps, { ...opts, migrate })
    expect(result).toEqual({ code: 3, counts: { v: 1, total: 3, migrated: 0, skipped: 0, failed: 3 } })
    expect(calls).toEqual(['alpha'])
  })

  it('a REAL concurrent CREATE OR REPLACE FUNCTION fails the loser with XX000 "tuple concurrently updated", and that is a race', async () => {
    await admin.unsafe(`CREATE DATABASE "${PREFIX}tcu"`)
    const a = connect(PREFIX + 'tcu')
    const b = connect(PREFIX + 'tcu')
    const fn = 'CREATE OR REPLACE FUNCTION leaf_probe() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$'
    try {
      await a.unsafe(fn)
      const holding = a.begin(async (tx) => {
        await tx.unsafe(fn)
        await new Promise((r) => setTimeout(r, 1500))
      })
      await new Promise((r) => setTimeout(r, 300))
      const loser = await b.unsafe(fn).then(
        () => null,
        (e: unknown) => e,
      )
      await holding
      expect(loser, 'the second session should have lost the race').not.toBeNull()
      expect((loser as { code?: string }).code).toBe('XX000')
      expect(classifyFailure(loser)).toBe('race')
    } finally {
      await a.end()
      await b.end()
    }
  })

  it('a connection lost BEFORE any DDL (while parked on the lock) is exit 3, not 1', async () => {
    await seedCatalogue(PREFIX, [ALPHA], ['alpha'])
    const holder = connect(PREFIX + 'alpha')
    try {
      await holder`SELECT pg_advisory_lock(hashtextextended(${MIGRATE_LOCK_NAME}, 0))`
      const pending = runMigrateOnly(deps, { ...opts, migrate: async () => {} })
      await vi.waitFor(
        async () => {
          const waiting = await admin`
            SELECT l.pid FROM pg_locks l JOIN pg_database d ON d.oid = l.database
             WHERE l.locktype = 'advisory' AND NOT l.granted AND d.datname = ${PREFIX + 'alpha'}
          `
          expect(waiting.length).toBeGreaterThan(0)
          await admin`SELECT pg_terminate_backend(${waiting[0]!.pid as number})`
        },
        { timeout: 10_000, interval: 100 },
      )
      const result = await pending
      expect(result.code).toBe(3)
      expect(result.counts).toMatchObject({ total: 1, migrated: 0, failed: 1 })
    } finally {
      await holder.end()
    }
  }, 60_000)

  it('a connection lost INSIDE a migration run (the runner is already past the lock) is exit 1', async () => {
    await seedCatalogue(PREFIX, [ALPHA], ['alpha'])
    const f = failing([], pgErr('CONNECTION_CLOSED'))
    const result = await runMigrateOnly(deps, { ...opts, migrate: f.migrate })
    expect(result.code).toBe(1)
    expect(f.calls()).toBe(1)
  })

  it('a refused login is exit 2 (the host configuration), not a defect of the commit', async () => {
    await seedCatalogue(PREFIX, [ALPHA], ['alpha'])
    const u = new URL(TEST_PG_URL)
    u.username = 'no_such_role'
    const result = await runMigrateOnly(deps, { ...opts, pgUrl: u.toString() })
    expect(result.code).toBe(2)
    expect(result.reason).toBe('login')
  })

  it('one defect among races is still exit 1; the customers after a defect are still migrated', async () => {
    await seedCatalogue(PREFIX, [ALPHA, BETA, GAMMA], ['alpha', 'beta', 'gamma'])
    const calls: string[] = []
    const migrate: MigrateFn = async (tenant) => {
      calls.push(tenant.slug)
      if (tenant.slug === 'alpha') throw pgErr('42601')
      if (tenant.slug === 'beta') throw raceFirst()
    }
    const result = await runMigrateOnly(deps, { ...opts, migrate })
    expect(result.code).toBe(1)
    expect(result.counts).toEqual({ v: 1, total: 3, migrated: 1, skipped: 0, failed: 2 })
    expect(calls).toContain('gamma')
  })
})

describe('the session advisory lock', () => {
  it('an entry waits while another session holds the lock on that database, then runs and exits 0', async () => {
    await seedCatalogue(PREFIX, [ALPHA], ['alpha'])
    const holder = connect(PREFIX + 'alpha')
    const ran = vi.fn(async () => {})
    try {
      await holder`SELECT pg_advisory_lock(hashtextextended(${MIGRATE_LOCK_NAME}, 0))`
      const pending = runMigrateOnly(deps, { ...opts, migrate: ran })

      // The entry is parked on the lock: its runner has not been called and a waiter shows in pg_locks.
      await vi.waitFor(
        async () => {
          const waiting = await admin`
            SELECT 1 FROM pg_locks l JOIN pg_database d ON d.oid = l.database
             WHERE l.locktype = 'advisory' AND NOT l.granted AND d.datname = ${PREFIX + 'alpha'}
          `
          expect(waiting.length).toBeGreaterThan(0)
        },
        { timeout: 10_000, interval: 100 },
      )
      await new Promise((r) => setTimeout(r, 500))
      expect(ran).not.toHaveBeenCalled()

      await holder`SELECT pg_advisory_unlock_all()`
      const result = await pending
      expect(result.code).toBe(0)
      expect(result.counts.migrated).toBe(1)
      expect(ran).toHaveBeenCalledTimes(1)
    } finally {
      await holder.end()
    }
  }, 60_000)
})

describe('idempotence: the claim that makes the scheduler redundant', () => {
  it('a second run, and a cold-miss storeFor of the same customer, leave the schema fingerprint identical', async () => {
    await seedCatalogue(PREFIX, [ALPHA], ['alpha'])
    expect((await runMigrateOnly(deps, opts)).code).toBe(0)
    const afterFirst = await fingerprint(PREFIX + 'alpha')

    expect((await runMigrateOnly(deps, opts)).code).toBe(0)
    expect(await fingerprint(PREFIX + 'alpha')).toBe(afterFirst)

    await _resetTenantStoreForTests() // a cold miss: nothing in the registry
    await storeFor(ALPHA, { pgUrl: TEST_PG_URL, dbPrefix: PREFIX })
    expect(await fingerprint(PREFIX + 'alpha')).toBe(afterFirst)
  })

  it('every file of the image migrations/ run twice (file after file, and the whole set again) changes nothing', async () => {
    await admin.unsafe(`CREATE DATABASE "${PREFIX}once"`)
    await admin.unsafe(`CREATE DATABASE "${PREFIX}twice"`)
    await admin.unsafe(`CREATE DATABASE "${PREFIX}again"`)
    await applyDir(PREFIX + 'once', REAL_MIGRATIONS)
    await applyDir(PREFIX + 'twice', REAL_MIGRATIONS, 2)
    await applyDir(PREFIX + 'again', REAL_MIGRATIONS)
    await applyDir(PREFIX + 'again', REAL_MIGRATIONS)
    const once = await fingerprint(PREFIX + 'once')
    expect(await fingerprint(PREFIX + 'twice')).toBe(once)
    expect(await fingerprint(PREFIX + 'again')).toBe(once)
  })
})

describe('the overlap with the OLD runner (the old colour keeps serving during the step)', () => {
  it('the new files, then the previous release files, leave the fingerprint of the new files alone (today files)', async () => {
    const files = (await readdir(REAL_MIGRATIONS)).filter((f) => f.endsWith('.sql')).sort()
    // The previous release: every file but the newest (the whole set when there is only one).
    const oldFiles: Record<string, string> = {}
    for (const f of files.length > 1 ? files.slice(0, -1) : files) {
      oldFiles[f] = await readFile(path.join(REAL_MIGRATIONS, f), 'utf-8')
    }
    const oldDir = await writeFixture('old-release', oldFiles)

    await admin.unsafe(`CREATE DATABASE "${PREFIX}newonly"`)
    await admin.unsafe(`CREATE DATABASE "${PREFIX}overlap"`)
    await applyDir(PREFIX + 'newonly', REAL_MIGRATIONS)
    await applyDir(PREFIX + 'overlap', REAL_MIGRATIONS)
    await applyDir(PREFIX + 'overlap', oldDir)

    expect(await fingerprint(PREFIX + 'overlap')).toBe(await fingerprint(PREFIX + 'newonly'))
  })

  it('a new file that redefines a function an old file creates turns the comparison RED (the old body comes back)', async () => {
    const probe = (n: number): string =>
      `CREATE OR REPLACE FUNCTION leaf_overlap_probe() RETURNS int LANGUAGE sql AS $$ SELECT ${n} $$;\n`
    const oldDir = await writeFixture('red-old', { '001_probe.sql': probe(1) })
    const newDir = await writeFixture('red-new', { '001_probe.sql': probe(1), '002_probe_v2.sql': probe(2) })

    await admin.unsafe(`CREATE DATABASE "${PREFIX}rednew"`)
    await admin.unsafe(`CREATE DATABASE "${PREFIX}redover"`)
    await applyDir(PREFIX + 'rednew', newDir)
    await applyDir(PREFIX + 'redover', newDir)
    await applyDir(PREFIX + 'redover', oldDir)

    expect(await fingerprint(PREFIX + 'redover')).not.toBe(await fingerprint(PREFIX + 'rednew'))
  })
})

describe('real processes', () => {
  it('two entries and an unlocked old runner started at the same instant on one fresh database leave the same schema', async () => {
    const harness = await bundle('harness', REAL_MIGRATIONS, 'harness')
    await admin.unsafe(`CREATE DATABASE "${PREFIX}ref"`)
    await applyDir(PREFIX + 'ref', REAL_MIGRATIONS)
    const expected = await fingerprint(PREFIX + 'ref')
    const env = { HARNESS_PG_URL: TEST_PG_URL, HARNESS_PREFIX: PREFIX }

    for (let round = 0; round < 3; round++) {
      await dropAllExceptRef()
      await seedCatalogue(PREFIX, [ALPHA], ['alpha'])
      const [e1, e2, old] = await Promise.all([
        run(harness, ['entry'], env),
        run(harness, ['entry'], env),
        run(harness, ['old', ALPHA.slug, ALPHA.id], env),
      ])
      // The old runner has no lock and no retry, so it may lose the race; the entries must not.
      for (const e of [e1, e2]) {
        const r = lastJson(e.stdout) as { code: number; counts: { migrated: number } }
        expect(r.code, e.stderr).toBe(0)
        expect(r.counts.migrated).toBe(1)
      }
      expect(old.code).toBe(0)
      expect(await fingerprint(PREFIX + 'alpha')).toBe(expected)
    }
  }, 120_000)

  async function dropAllExceptRef(): Promise<void> {
    const rows = await admin<{ datname: string }[]>`
      SELECT datname FROM pg_database WHERE datname LIKE ${PREFIX.replace(/_/g, '\\_') + '%'} AND datname <> ${PREFIX + 'ref'}
    `
    for (const { datname } of rows) {
      await admin.unsafe(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${datname}' AND pid <> pg_backend_pid()`,
      )
      await admin.unsafe(`DROP DATABASE IF EXISTS "${datname}"`)
    }
  }

  it('the real bundle: one JSON line on stdout and nothing else, no name in any stream, and the process ends by itself', async () => {
    const entry = await bundle('image', REAL_MIGRATIONS, 'index')
    await seedCatalogue(PROD_PREFIX, [ALPHA, BETA], ['alpha'])
    const env = {
      CONTENT_PG_URL: TEST_PG_URL,
      // Were the service to start, these would make it bind a port and try a broker.
      PORT: '0',
      NATS_URL: 'nats://127.0.0.1:1',
    }

    const ran = await run(entry, ['--migrate-only'], env)

    expect(ran.code, ran.stderr).toBe(0)
    expect(ran.stdout.trimEnd().split('\n')).toHaveLength(1)
    expect(JSON.parse(ran.stdout)).toEqual({ v: 1, total: 2, migrated: 1, skipped: 1, failed: 0 })
    expect(ran.stderr).toBe('')
    for (const name of ['alpha', 'beta']) {
      expect(ran.stdout).not.toContain(name)
      expect(ran.stderr).not.toContain(name)
    }
    expect(await dbExists(PROD_PREFIX + 'beta')).toBe(false)
  }, 120_000)

  it('the real bundle with a hostile catalogue row: exit 1, the line is still the only output', async () => {
    const entry = await bundle('image', REAL_MIGRATIONS, 'index')
    await seedCatalogue(PROD_PREFIX, [ALPHA, HOSTILE], ['alpha'])
    const ran = await run(entry, ['--migrate-only'], { CONTENT_PG_URL: TEST_PG_URL })
    expect(ran.code).toBe(1)
    expect(JSON.parse(ran.stdout)).toEqual({ v: 1, total: 2, migrated: 1, skipped: 0, failed: 1 })
    expect(ran.stdout + ran.stderr).not.toContain('DROP')
  }, 120_000)

  it('the real bundle: a slug argument is exit 2 with nothing on stdout; a missing URL is exit 2; a refused connection is exit 3', async () => {
    const entry = await bundle('image', REAL_MIGRATIONS, 'index')
    const withArg = await run(entry, ['--migrate-only', 'alpha'], { CONTENT_PG_URL: TEST_PG_URL })
    expect(withArg.code).toBe(2)
    expect(withArg.stdout).toBe('')

    const noUrl = await run(entry, ['--migrate-only'], {})
    expect(noUrl.code).toBe(2)
    expect(noUrl.stdout).toBe('')

    const refused = await run(entry, ['--migrate-only'], { CONTENT_PG_URL: 'postgres://postgres@127.0.0.1:1/postgres' })
    expect(refused.code).toBe(3)
    expect(JSON.parse(refused.stdout)).toEqual({ v: 1, total: 0, migrated: 0, skipped: 0, failed: 0 })
  }, 120_000)
})
