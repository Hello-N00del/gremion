// modules/calendar/test/move-to-lifecycle-db.integration.test.ts
//
// The operator script scripts/move-to-lifecycle-db.mjs against a real Postgres: it moves each customer's
// calendar_<slug> database into the lifecycle database t_<tenant>__calendar. Run as the real CLI (a child
// process) through `docker exec` into the scratch container, exactly as the operator runs it.
//
// The legacy layout is rebuilt the way the old leaf made it: a catalogue database with tenant_catalog and one
// calendar_<slug> database per customer, migrated with the raw migration files (no ledger). The lifecycle
// target is provisioned like enableModule does (test/support/scratch-pg.ts). Needs CALENDAR_TEST_PG_URL and
// CALENDAR_TEST_PG_CONTAINER (the container running it).
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { requireEphemeralTestPgUrl, assertSafeTestEnv } from './support/pg-test-guard.ts'
import { CALENDAR_MIGRATIONS_DIR, FIXTURE_DB_PATTERN, fixtureDb, fixtureId, provisionLifecycleDb } from './support/scratch-pg.ts'
import { listEvents } from '../src/store/index.ts'
import { storeFor, _resetTenantStoreForTests } from '../src/tenant-store.ts'

const TEST_PG_URL = requireEphemeralTestPgUrl()
const PREFIX = 'calendar_mv_test_'
assertSafeTestEnv(TEST_PG_URL, PREFIX)
const CONTAINER = process.env.CALENDAR_TEST_PG_CONTAINER ?? ''
if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(CONTAINER)) {
  throw new Error('[move] CALENDAR_TEST_PG_CONTAINER (the scratch container running CALENDAR_TEST_PG_URL) is REQUIRED')
}
const SCRIPT = fileURLToPath(new URL('../scripts/move-to-lifecycle-db.mjs', import.meta.url))

const T1 = { id: fixtureId('0000000c0a01'), slug: 'mv-one' }
const T2 = { id: fixtureId('0000000c0a02'), slug: 'mv-two' }
const T3 = { id: fixtureId('0000000c0a03'), slug: 'mv-three' }
const src = (t: { slug: string }) => PREFIX + t.slug

let admin: postgres.Sql<{}>
let work: string

function urlFor(db: string): string {
  const u = new URL(TEST_PG_URL)
  u.pathname = '/' + db
  return u.toString()
}

async function onDb<T>(db: string, fn: (sql: postgres.Sql<{}>) => Promise<T>): Promise<T> {
  const sql = postgres(urlFor(db), { max: 1, prepare: false, onnotice: () => {} })
  try {
    return await fn(sql)
  } finally {
    await sql.end({ timeout: 5 })
  }
}

async function dropAll(): Promise<void> {
  const rows = await admin<{ datname: string }[]>`SELECT datname FROM pg_database WHERE datname LIKE ${PREFIX + '%'} OR datname ~ ${FIXTURE_DB_PATTERN}`
  for (const { datname } of rows) await admin.unsafe(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`)
}

/** The earlier layout: calendar_<slug> migrated with the raw files, the way the old leaf's runner did. */
async function legacyDb(t: { slug: string }): Promise<void> {
  await admin.unsafe(`CREATE DATABASE "${src(t)}"`)
  const files = readdirSync(CALENDAR_MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
  await onDb(src(t), async (sql) => {
    for (const f of files) await sql.unsafe(readFileSync(join(CALENDAR_MIGRATIONS_DIR, f), 'utf8'))
  })
}

/** Customer data in every table of the schema, with ids that differ per customer. */
async function fill(t: { slug: string }, n: number): Promise<void> {
  await onDb(src(t), async (sql) => {
    const [type] = await sql<{ id: string }[]>`INSERT INTO event_types (name, color, is_system) VALUES (${'Gremium-' + t.slug}, '#123456', false) RETURNING id`
    for (let i = 0; i < n; i++) {
      const [ev] = await sql<{ id: string }[]>`
        INSERT INTO calendar_events (title, description, start_at, end_at, event_type_id, created_by, caldav_uid)
        VALUES (${`Sitzung ${t.slug} ${i}`}, 'Beschreibung mit Umlauten: äöü', '2030-03-01T10:00:00Z', '2030-03-01T11:00:00Z', ${type!.id}, 'user-1', ${`uid-${t.slug}-${i}@example.org`})
        RETURNING id`
      await sql`INSERT INTO event_recurrence (event_id, frequency, interval, byday, exceptions) VALUES (${ev!.id}, 'weekly', 1, ${['MO', 'WE']}, ${['2030-03-08']})`
      await sql`INSERT INTO event_committees (event_id, committee_id) VALUES (${ev!.id}, gen_random_uuid())`
      await sql`INSERT INTO caldav_sync_queue (event_id, caldav_uid, operation) VALUES (${ev!.id}, ${`uid-${t.slug}-${i}@example.org`}, 'create')`
      await sql`INSERT INTO calendar_audit (event_id, actor_sub, action) VALUES (${ev!.id}, 'user-1', 'create')`
      await sql`INSERT INTO outbox (event_type, payload, correlation_id) VALUES ('event.created', ${sql.json({ eventDbId: ev!.id })}, 'corr-1')`
    }
    await sql`INSERT INTO committee_calendar_settings (committee_id, color) VALUES (gen_random_uuid(), '#abcdef')`
  })
}

/** The catalogue database of the earlier layout, with one row per customer. */
async function control(tenants: { id: string; slug: string }[]): Promise<void> {
  await admin.unsafe(`CREATE DATABASE "${PREFIX}control"`)
  await onDb(PREFIX + 'control', async (sql) => {
    await sql.unsafe(`CREATE TABLE tenant_catalog (tenant_id UUID PRIMARY KEY, slug TEXT NOT NULL UNIQUE, db_name TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`)
    for (const t of tenants) await sql`INSERT INTO tenant_catalog (tenant_id, slug, db_name) VALUES (${t.id}, ${t.slug}, ${src(t)})`
  })
}

interface Fp { table: string; count: number; md5: string }
async function fingerprint(db: string): Promise<Fp[]> {
  return onDb(db, async (sql) => {
    const tables = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> 'schema_migrations' ORDER BY table_name`
    const out: Fp[] = []
    for (const { table_name } of tables) {
      const [r] = await sql.unsafe<{ c: string; m: string }[]>(`SELECT count(*) AS c, coalesce(md5(string_agg(x::text, '|' ORDER BY x::text)), '') AS m FROM public."${table_name}" x`)
      out.push({ table: table_name, count: Number(r!.c), md5: r!.m })
    }
    return out
  })
}

const comment = async (db: string): Promise<string> =>
  (await admin<{ c: string }[]>`SELECT coalesce(shobj_description(oid, 'pg_database'), '') AS c FROM pg_database WHERE datname = ${db}`)[0]?.c ?? ''
const exists = async (db: string): Promise<boolean> => (await admin`SELECT 1 FROM pg_database WHERE datname = ${db}`).length === 1

function run(args: string[]): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, [SCRIPT, '--container', CONTAINER, '--admin-user', 'postgres', '--db-prefix', PREFIX, ...args], { encoding: 'utf8' })
  return { status: r.status, out: `${r.stdout}${r.stderr}` }
}

/** T1 (data) and T3 (no customer data) with their lifecycle databases; T2 has data and NO lifecycle database. */
async function world(opts: { lifecycleFor: { id: string; slug: string }[]; tenants: { id: string; slug: string; rows: number }[] }): Promise<void> {
  await _resetTenantStoreForTests()
  await dropAll()
  await control(opts.tenants)
  for (const t of opts.tenants) {
    await legacyDb(t)
    await fill(t, t.rows)
  }
  for (const t of opts.lifecycleFor) await provisionLifecycleDb(TEST_PG_URL, t.id)
}

beforeAll(async () => {
  admin = postgres(TEST_PG_URL, { max: 2, prepare: false, onnotice: () => {} })
  work = mkdtempSync(join(tmpdir(), 'fu7-move-'))
}, 60_000)

afterAll(async () => {
  await _resetTenantStoreForTests()
  if (admin) {
    await dropAll()
    await admin.end({ timeout: 5 })
  }
  rmSync(work, { recursive: true, force: true })
}, 60_000)

let backups: string
beforeEach(() => {
  backups = join(work, `b-${Math.random().toString(16).slice(2)}`)
})

describe('move-to-lifecycle-db (operator script)', () => {
  it('the default is a dry run: it prints the plan and changes nothing', async () => {
    await world({ lifecycleFor: [T1, T3], tenants: [{ ...T1, rows: 3 }, { ...T3, rows: 0 }] })
    const before = await fingerprint(fixtureDb(T1.id))
    const r = run([])
    expect(r.status, r.out).toBe(0)
    expect(r.out).toContain('DRY RUN')
    expect(r.out).toContain(`WOULD COPY ${src(T1)} -> ${fixtureDb(T1.id)}`)
    expect(await fingerprint(fixtureDb(T1.id))).toEqual(before)
    expect(await comment(src(T1))).toBe('')
    const [row] = await onDb(PREFIX + 'control', (sql) => sql<{ db_name: string }[]>`SELECT db_name FROM tenant_catalog WHERE tenant_id = ${T1.id}`)
    expect(row!.db_name).toBe(src(T1))
    expect(existsSync(backups)).toBe(false)
  }, 120_000)

  it('--apply needs a backup directory', async () => {
    const r = run(['--apply'])
    expect(r.status).toBe(2)
    expect(r.out).toContain('--backup-dir')
  })

  it('--apply backs up first, copies every table with equal counts and checksums, marks the source retired and never drops it', async () => {
    await world({ lifecycleFor: [T1, T3], tenants: [{ ...T1, rows: 3 }, { ...T3, rows: 0 }] })
    const sourceFp = await fingerprint(src(T1))
    expect(sourceFp.map((f) => f.table)).toEqual(['calendar_audit', 'calendar_events', 'caldav_sync_queue', 'committee_calendar_settings', 'event_committees', 'event_recurrence', 'event_types', 'outbox'].sort())
    expect(sourceFp.find((f) => f.table === 'calendar_events')!.count).toBe(3)

    const r = run(['--apply', '--backup-dir', backups])
    expect(r.status, r.out).toBe(0)
    expect(r.out).toContain(`copied ${src(T1)} -> ${fixtureDb(T1.id)}; counts equal`)

    // equal counts and checksums in EVERY table, the seeded system event types replaced by the source's
    expect(await fingerprint(fixtureDb(T1.id))).toEqual(sourceFp)
    expect(await fingerprint(fixtureDb(T3.id))).toEqual(await fingerprint(src(T3)))

    // the backup was taken first, is private, and is a custom-format dump
    const files = readdirSync(backups)
    expect(files.filter((f) => f.endsWith('.dump'))).toHaveLength(2)
    for (const f of files) expect(statSync(join(backups, f)).size).toBeGreaterThan(0)
    expect(r.out).toMatch(/backup .*calendar-[0-9a-f]{32}-.*\.dump \(\d+ bytes, sha256 [0-9a-f]{64}\)/)

    // the source is kept and marked; the catalogue names the lifecycle database
    expect(await exists(src(T1))).toBe(true)
    expect(await exists(src(T3))).toBe(true)
    expect(await comment(src(T1))).toContain(`gremion-retired: moved to ${fixtureDb(T1.id)}`)
    const [row] = await onDb(PREFIX + 'control', (sql) => sql<{ db_name: string }[]>`SELECT db_name FROM tenant_catalog WHERE tenant_id = ${T1.id}`)
    expect(row!.db_name).toBe(fixtureDb(T1.id))
  }, 180_000)

  it('the new leaf then serves the moved events from the lifecycle database', async () => {
    await world({ lifecycleFor: [T1], tenants: [{ ...T1, rows: 2 }] })
    const opts = { pgUrl: TEST_PG_URL, dbPrefix: PREFIX, moduleUrl: TEST_PG_URL }
    // before the move the leaf serves nothing for the customer and writes nothing into the empty lifecycle database
    await expect(storeFor(T1, opts)).rejects.toMatchObject({ code: 'TENANT_UNAVAILABLE', reason: 'move_pending' })
    expect((await fingerprint(fixtureDb(T1.id))).find((f) => f.table === 'calendar_events')!.count).toBe(0)
    await _resetTenantStoreForTests()
    const r = run(['--apply', '--backup-dir', backups])
    expect(r.status, r.out).toBe(0)
    const sql = await storeFor(T1, opts)
    const events = await listEvents(sql)
    expect(events.map((e) => e.title).sort()).toEqual(['Sitzung mv-one 0', 'Sitzung mv-one 1'])
    expect(events.every((e) => e.description === 'Beschreibung mit Umlauten: äöü')).toBe(true)
  }, 180_000)

  it('running it again is a no-op: the retired source is skipped, what the leaf wrote since stays, no second backup', async () => {
    await world({ lifecycleFor: [T1], tenants: [{ ...T1, rows: 2 }] })
    expect(run(['--apply', '--backup-dir', backups]).status).toBe(0)
    await onDb(fixtureDb(T1.id), (sql) => sql`INSERT INTO calendar_events (title, start_at, end_at, created_by) VALUES ('Nach dem Umzug', now(), now(), 'leaf')`)
    const after = await fingerprint(fixtureDb(T1.id))
    const second = join(work, 'second')
    const r = run(['--apply', '--backup-dir', second])
    expect(r.status, r.out).toBe(0)
    expect(r.out).toContain('nothing to do (the catalogue already names the lifecycle database)')
    expect(await fingerprint(fixtureDb(T1.id))).toEqual(after)
    expect(readdirSync(second)).toEqual([])

    // a run that stopped after the mark and before the catalogue update: the mark decides, the catalogue is healed
    await onDb(PREFIX + 'control', (sql) => sql`UPDATE tenant_catalog SET db_name = ${src(T1)} WHERE tenant_id = ${T1.id}`)
    const healed = run(['--apply', '--backup-dir', join(work, 'second-heal')])
    expect(healed.status, healed.out).toBe(0)
    expect(healed.out).toContain('nothing to do (the source carries the retired mark)')
    const [row] = await onDb(PREFIX + 'control', (sql) => sql<{ db_name: string }[]>`SELECT db_name FROM tenant_catalog WHERE tenant_id = ${T1.id}`)
    expect(row!.db_name).toBe(fixtureDb(T1.id))
    expect(await fingerprint(fixtureDb(T1.id))).toEqual(after)
  }, 180_000)

  it('a run that stopped between the copy and the mark only marks: no backup, no copy', async () => {
    await world({ lifecycleFor: [T1], tenants: [{ ...T1, rows: 2 }] })
    expect(run(['--apply', '--backup-dir', backups]).status).toBe(0)
    // the state after a crash between the copy and the mark: no mark, the catalogue still names the source
    await admin.unsafe(`COMMENT ON DATABASE "${src(T1)}" IS NULL`)
    await onDb(PREFIX + 'control', (sql) => sql`UPDATE tenant_catalog SET db_name = ${src(T1)} WHERE tenant_id = ${T1.id}`)
    const before = await fingerprint(fixtureDb(T1.id))
    const second = join(work, 'second-mark')
    const r = run(['--apply', '--backup-dir', second])
    expect(r.status, r.out).toBe(0)
    expect(r.out).toContain('marked retired')
    expect(r.out).not.toContain('copied ')
    expect(readdirSync(second)).toEqual([])
    expect(await fingerprint(fixtureDb(T1.id))).toEqual(before)
    expect(await comment(src(T1))).toContain('gremion-retired')
  }, 180_000)

  it('a catalogue row whose source database is gone has nothing to move: --apply records the lifecycle name so the leaf serves it', async () => {
    await world({ lifecycleFor: [T1], tenants: [{ ...T1, rows: 1 }] })
    await admin.unsafe(`DROP DATABASE "${src(T1)}" WITH (FORCE)`)
    const dry = run([])
    expect(dry.status, dry.out).toBe(0)
    expect(dry.out).toContain('nothing to do (there is no source database)')
    const [before] = await onDb(PREFIX + 'control', (sql) => sql<{ db_name: string }[]>`SELECT db_name FROM tenant_catalog WHERE tenant_id = ${T1.id}`)
    expect(before!.db_name).toBe(src(T1))
    const r = run(['--apply', '--backup-dir', backups])
    expect(r.status, r.out).toBe(0)
    const [after] = await onDb(PREFIX + 'control', (sql) => sql<{ db_name: string }[]>`SELECT db_name FROM tenant_catalog WHERE tenant_id = ${T1.id}`)
    expect(after!.db_name).toBe(fixtureDb(T1.id))
    await expect(storeFor(T1, { pgUrl: TEST_PG_URL, dbPrefix: PREFIX, moduleUrl: TEST_PG_URL })).resolves.toBeDefined()
  }, 180_000)

  it('a customer without a lifecycle database is refused, nothing is created for it, the other customers are still moved', async () => {
    await world({ lifecycleFor: [T1], tenants: [{ ...T1, rows: 1 }, { ...T2, rows: 1 }] })
    const names = (await admin<{ datname: string }[]>`SELECT datname FROM pg_database ORDER BY datname`).map((d) => d.datname)
    const r = run(['--apply', '--backup-dir', backups])
    expect(r.status).toBe(1)
    expect(r.out).toContain('REFUSED (the lifecycle database does not exist: enable the calendar module for this customer first')
    expect(await exists(fixtureDb(T2.id))).toBe(false)
    expect(await comment(src(T2))).toBe('')
    expect((await admin<{ datname: string }[]>`SELECT datname FROM pg_database ORDER BY datname`).map((d) => d.datname)).toEqual([...names, fixtureDb(T1.id)].filter((n, i, a) => a.indexOf(n) === i).sort())
    expect(await comment(src(T1))).toContain('gremion-retired')
  }, 180_000)

  it('a target that holds data that is not the source\'s is refused and left as it was', async () => {
    await world({ lifecycleFor: [T1], tenants: [{ ...T1, rows: 2 }] })
    await onDb(fixtureDb(T1.id), (sql) => sql`INSERT INTO calendar_events (title, start_at, end_at, created_by) VALUES ('Fremd', now(), now(), 'leaf')`)
    const before = await fingerprint(fixtureDb(T1.id))
    const r = run(['--apply', '--backup-dir', backups])
    expect(r.status).toBe(1)
    expect(r.out).toContain("the target holds data that is not the source's")
    expect(await fingerprint(fixtureDb(T1.id))).toEqual(before)
    expect(await comment(src(T1))).toBe('')
    expect(readdirSync(backups)).toEqual([])
  }, 180_000)

  it('a copy that fails half way is rolled back as a whole: the target keeps its seeded rows and nothing is marked', async () => {
    await world({ lifecycleFor: [T1], tenants: [{ ...T1, rows: 2 }] })
    // the target refuses one of the source's rows
    await onDb(fixtureDb(T1.id), (sql) => sql.unsafe(`ALTER TABLE calendar_events ADD CONSTRAINT refuse_second CHECK (title <> 'Sitzung mv-one 1')`))
    const before = await fingerprint(fixtureDb(T1.id))
    const r = run(['--apply', '--backup-dir', backups])
    expect(r.status).toBe(1)
    expect(r.out).toContain('FAILED (the copy was rolled back')
    expect(await fingerprint(fixtureDb(T1.id))).toEqual(before)
    expect(await comment(src(T1))).toBe('')
    expect(await exists(src(T1))).toBe(true)
  }, 180_000)

  it('the script never creates or drops a database, whatever it does', async () => {
    await world({ lifecycleFor: [T1], tenants: [{ ...T1, rows: 1 }, { ...T2, rows: 1 }] })
    const before = (await admin<{ datname: string }[]>`SELECT datname FROM pg_database ORDER BY datname`).map((d) => d.datname)
    run([])
    run(['--apply', '--backup-dir', backups])
    run(['--apply', '--backup-dir', join(work, 'again')])
    expect((await admin<{ datname: string }[]>`SELECT datname FROM pg_database ORDER BY datname`).map((d) => d.datname)).toEqual(before)
    const source = readFileSync(SCRIPT, 'utf8')
    expect(source).not.toMatch(/\bDROP\s+DATABASE\b|\bCREATE\s+DATABASE\b|\bALTER\s+DATABASE\b[^;]*RENAME/i)
  }, 180_000)
})
