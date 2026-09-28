/**
 * Integration tests for services/calendar/scripts/backfill.ts
 *
 * Source is the kernel's OWN Postgres tables (`t_<slug>` DB, same server) —
 * unlike the newsletter leaf's SQLite→PG backfill, this is a PG→PG copy.
 * Correctness — id preservation (UUID PKs, no sequence collision), UTC
 * timestamp round-trip, checksum verification — is paramount (§D.2 analog).
 *
 * TDD coverage (Task 22 brief):
 *   - builds a SYNTHETIC kernel-shaped `t_<slug>` source DB (event_types,
 *     calendar_events incl. is_public + one recurring event, event_recurrence,
 *     event_committees, committee_calendar_settings, caldav_sync_queue) →
 *     run backfill →
 *   - assert per-table row counts equal,
 *   - assert ID PRESERVATION (explicit source UUIDs with intentional gaps
 *     survive verbatim in the target — no renumbering),
 *   - assert UTC timestamp ROUND-TRIP (a known UTC instant lands as the same
 *     instant in the target timestamptz column),
 *   - assert the verify-gate checksum lines are printed,
 *   - `--verify-only` against a TAMPERED target → exit 1 NAMING the table.
 *
 * Runs against CALENDAR_TEST_PG_URL (a local throwaway Postgres) for BOTH the
 * synthetic source DB and the target leaf DB (same server, two databases).
 * Fail-closed guard: refuses to run unless host is localhost/127.0.0.1 AND
 * every DB uses the `calendar_test_` prefix (mirrors #249 / the store
 * integration suites).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import {
  storeFor,
  _resetTenantStoreForTests,
  type TenantRef,
  type Sql,
} from '../src/tenant-store.ts'
import { runBackfill } from '../scripts/backfill.ts'
import { requireEphemeralTestPgUrl, assertSafeTestEnv } from './support/pg-test-guard.ts'

// ── fail-closed guard (mirrors #249 / assert-safe-test-db-url pattern) ────────
const TEST_PG_URL = requireEphemeralTestPgUrl()
const TEST_DB_PREFIX = 'calendar_test_'
assertSafeTestEnv(TEST_PG_URL, TEST_DB_PREFIX)

// ── test tenant ───────────────────────────────────────────────────────────────
const TENANT: TenantRef = { id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', slug: 'calbackfill' }
const SOURCE_DB = 't_test_calbackfill' // synthetic kernel-shaped source DB (not a real t_<slug> — throwaway)

// A known UTC instant, WITH explicit offset (kernel Postgres timestamptz columns
// always carry an offset — unlike newsletter's bare-string SQLite source).
const UTC_TS = '2026-01-15T09:30:00.000Z'

// ── PG fixtures ─────────────────────────────────────────────────────────────
let admin: ReturnType<typeof postgres>
let source: Sql

async function dropTestDbs(pgSql: ReturnType<typeof postgres>): Promise<void> {
  const rows = await pgSql<{ datname: string }[]>`
    SELECT datname FROM pg_database WHERE datname LIKE 'calendar_test_%' OR datname = ${SOURCE_DB}
  `
  for (const { datname } of rows) {
    await pgSql.unsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${datname}' AND pid <> pg_backend_pid()`,
    )
    await pgSql.unsafe(`DROP DATABASE IF EXISTS "${datname}"`)
  }
}

/** Explicit UUIDs (fixed, memorable, valid v4-shaped) for the synthetic fixture. */
const IDS = {
  evtypeTreffen: '11111111-0000-0000-0000-000000000001',
  evtypeFrist: '11111111-0000-0000-0000-000000000002',
  evtypeWahl: '11111111-0000-0000-0000-000000000003',
  evtypeSoziales: '11111111-0000-0000-0000-000000000004',
  evtypeFeiertag: '11111111-0000-0000-0000-000000000005',
  evtypeCustom: '11111111-0000-0000-0000-000000000009', // intentional "gap" vs the 5 system types
  eventSent: '22222222-0000-0000-0000-000000000003',
  eventRecurring: '22222222-0000-0000-0000-00000000000a',
  committeeA: '33333333-0000-0000-0000-000000000001',
  caldavQueueEntry: '44444444-0000-0000-0000-000000000001',
}

/** Build a synthetic kernel-shaped `t_<slug>` source DB (same DDL shape as 003_calendar_schema.sql, minus the committees FK — plain UUID here since this throwaway source has no governance schema). */
async function buildSyntheticSource(): Promise<Sql> {
  const adminConn = postgres(TEST_PG_URL, { max: 1, prepare: false })
  try {
    await adminConn.unsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${SOURCE_DB}' AND pid <> pg_backend_pid()`,
    )
    await adminConn.unsafe(`DROP DATABASE IF EXISTS "${SOURCE_DB}"`)
    await adminConn.unsafe(`CREATE DATABASE "${SOURCE_DB}"`)
  } finally {
    await adminConn.end()
  }

  const u = new URL(TEST_PG_URL)
  u.pathname = '/' + SOURCE_DB
  const sql = postgres(u.toString(), { max: 4, prepare: false })

  await sql.unsafe(`
    CREATE TABLE event_types (
      id         UUID PRIMARY KEY,
      name       TEXT NOT NULL,
      color      TEXT NOT NULL,
      is_system  BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE calendar_events (
      id                 UUID PRIMARY KEY,
      title              TEXT NOT NULL,
      description        TEXT,
      location           TEXT,
      start_at           TIMESTAMPTZ NOT NULL,
      end_at             TIMESTAMPTZ NOT NULL,
      all_day            BOOLEAN NOT NULL DEFAULT false,
      is_public          BOOLEAN NOT NULL DEFAULT false,
      event_type_id      UUID REFERENCES event_types(id),
      is_multi_committee BOOLEAN NOT NULL DEFAULT false,
      created_by         TEXT NOT NULL,
      source             TEXT NOT NULL DEFAULT 'manual',
      external_id        TEXT,
      caldav_uid         TEXT UNIQUE,
      caldav_synced_at   TIMESTAMPTZ,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE event_recurrence (
      event_id   UUID PRIMARY KEY REFERENCES calendar_events(id) ON DELETE CASCADE,
      frequency  TEXT NOT NULL,
      interval   INT NOT NULL DEFAULT 1,
      until      DATE,
      count      INT,
      byday      TEXT[],
      exceptions DATE[]
    );
    CREATE TABLE event_committees (
      event_id     UUID NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
      committee_id UUID NOT NULL,
      PRIMARY KEY (event_id, committee_id)
    );
    CREATE TABLE committee_calendar_settings (
      committee_id UUID PRIMARY KEY,
      color        TEXT NOT NULL DEFAULT '#6366f1',
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE caldav_sync_queue (
      id          UUID PRIMARY KEY,
      event_id    UUID REFERENCES calendar_events(id) ON DELETE SET NULL,
      caldav_uid  TEXT NOT NULL,
      operation   TEXT NOT NULL,
      attempts    INT NOT NULL DEFAULT 0,
      last_error  TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `)

  // event_types — ALL 5 migration-seeded system-type NAMES (Treffen/Frist/
  // Wahl/Soziales/Feiertag) so the leaf's idempotent seed guard
  // (WHERE NOT EXISTS ... is_system=true) never re-seeds a "missing" system
  // type after purgeSeededSystemEventTypes() runs — mirrors the real kernel,
  // which always has all 5 (seeded the same way, migration 003). Plus one
  // admin-added custom type with an id GAP to prove id preservation.
  await sql`INSERT INTO event_types (id, name, color, is_system, created_at)
    VALUES (${IDS.evtypeTreffen}, 'Treffen', '#3b82f6', true, ${UTC_TS})`
  await sql`INSERT INTO event_types (id, name, color, is_system, created_at)
    VALUES (${IDS.evtypeFrist}, 'Frist', '#ef4444', true, ${UTC_TS})`
  await sql`INSERT INTO event_types (id, name, color, is_system, created_at)
    VALUES (${IDS.evtypeWahl}, 'Wahl', '#8b5cf6', true, ${UTC_TS})`
  await sql`INSERT INTO event_types (id, name, color, is_system, created_at)
    VALUES (${IDS.evtypeSoziales}, 'Soziales', '#22c55e', true, ${UTC_TS})`
  await sql`INSERT INTO event_types (id, name, color, is_system, created_at)
    VALUES (${IDS.evtypeFeiertag}, 'Feiertag', '#f59e0b', true, ${UTC_TS})`
  await sql`INSERT INTO event_types (id, name, color, is_system, created_at)
    VALUES (${IDS.evtypeCustom}, 'Custom', '#000000', false, ${UTC_TS})`

  // calendar_events — one plain 'sent'-shaped manual event with a known UTC ts
  // (checksum column = title), one recurring event, committee-linked.
  await sql`INSERT INTO calendar_events
      (id, title, description, location, start_at, end_at, all_day, is_public,
       event_type_id, is_multi_committee, created_by, source, external_id,
       caldav_uid, caldav_synced_at, created_at, updated_at)
    VALUES (${IDS.eventSent}, 'AStA Sitzung', 'Wichtig', 'Raum 1',
      ${UTC_TS}, ${UTC_TS}, false, true,
      ${IDS.evtypeTreffen}, false, 'admin', 'manual', null,
      'uid-sent@stura', ${UTC_TS}, ${UTC_TS}, ${UTC_TS})`
  await sql`INSERT INTO calendar_events
      (id, title, description, location, start_at, end_at, all_day, is_public,
       event_type_id, is_multi_committee, created_by, source, external_id,
       caldav_uid, caldav_synced_at, created_at, updated_at)
    VALUES (${IDS.eventRecurring}, 'Weekly Meeting', null, null,
      ${UTC_TS}, ${UTC_TS}, false, false,
      ${IDS.evtypeCustom}, true, 'admin', 'helios', 'ext-123',
      'uid-recur@stura', null, ${UTC_TS}, ${UTC_TS})`

  await sql`INSERT INTO event_recurrence (event_id, frequency, interval, until, count, byday, exceptions)
    VALUES (${IDS.eventRecurring}, 'weekly', 2, '2026-12-31', null, ${['MO', 'WE']}, null)`

  await sql`INSERT INTO event_committees (event_id, committee_id) VALUES (${IDS.eventSent}, ${IDS.committeeA})`
  await sql`INSERT INTO event_committees (event_id, committee_id) VALUES (${IDS.eventRecurring}, ${IDS.committeeA})`

  await sql`INSERT INTO committee_calendar_settings (committee_id, color, updated_at)
    VALUES (${IDS.committeeA}, '#ff00ff', ${UTC_TS})`

  await sql`INSERT INTO caldav_sync_queue (id, event_id, caldav_uid, operation, attempts, last_error, created_at)
    VALUES (${IDS.caldavQueueEntry}, ${IDS.eventRecurring}, 'uid-recur@stura', 'create', 0, null, ${UTC_TS})`

  return sql
}

/** Fresh, EMPTY target DB for this tenant (drops + recreates via storeFor). */
async function freshTarget(): Promise<Sql> {
  await _resetTenantStoreForTests()
  await dropTestDbs(admin)
  // Re-create the source (dropTestDbs above wipes it too — rebuild each time).
  source = await buildSyntheticSource()
  // storeFor creates the DB + applies migrations and returns a pool.
  return storeFor(TENANT, { pgUrl: TEST_PG_URL, dbPrefix: TEST_DB_PREFIX })
}

beforeAll(async () => {
  admin = postgres(TEST_PG_URL, { max: 1, prepare: false })
})

afterAll(async () => {
  await _resetTenantStoreForTests()
  if (source) await source.end().catch(() => {})
  await dropTestDbs(admin)
  await admin.end()
})

describe('backfill — happy path (fresh target)', () => {
  beforeEach(async () => {
    await freshTarget()
  })

  it('migrates every table with equal row counts and prints BACKFILL OK', async () => {
    const logs: string[] = []
    const res = await runBackfill({
      tenant: TENANT.slug,
      tenantId: TENANT.id,
      pgUrl: TEST_PG_URL,
      sourceDb: SOURCE_DB,
      dbPrefix: TEST_DB_PREFIX,
      verifyOnly: false,
      log: (m) => logs.push(m),
    })

    expect(res.ok).toBe(true)
    expect(res.counts['event_types']).toEqual({ source: 6, pg: 6 })
    expect(res.counts['calendar_events']).toEqual({ source: 2, pg: 2 })
    expect(res.counts['event_recurrence']).toEqual({ source: 1, pg: 1 })
    expect(res.counts['event_committees']).toEqual({ source: 2, pg: 2 })
    expect(res.counts['committee_calendar_settings']).toEqual({ source: 1, pg: 1 })
    expect(res.counts['caldav_sync_queue']).toEqual({ source: 1, pg: 1 })
    expect(logs.join('\n')).toContain(`BACKFILL OK tenant=${TENANT.slug}`)
  })

  it('prints checksum lines for the checksummed tables', async () => {
    const logs: string[] = []
    await runBackfill({
      tenant: TENANT.slug,
      tenantId: TENANT.id,
      pgUrl: TEST_PG_URL,
      sourceDb: SOURCE_DB,
      dbPrefix: TEST_DB_PREFIX,
      verifyOnly: false,
      log: (m) => logs.push(m),
    })
    const out = logs.join('\n')
    expect(out).toMatch(/checksum.*calendar_events/i)
    expect(out).toMatch(/checksum.*event_types/i)
  })

  it('PRESERVES ids: explicit source UUIDs survive verbatim (no renumbering)', async () => {
    const sql = await freshTarget()
    await runBackfill({
      tenant: TENANT.slug,
      tenantId: TENANT.id,
      pgUrl: TEST_PG_URL,
      sourceDb: SOURCE_DB,
      dbPrefix: TEST_DB_PREFIX,
      verifyOnly: false,
      log: () => {},
    })

    const types = await sql<{ id: string }[]>`SELECT id FROM event_types ORDER BY id`
    const expectedTypeIds = [
      IDS.evtypeTreffen, IDS.evtypeFrist, IDS.evtypeWahl,
      IDS.evtypeSoziales, IDS.evtypeFeiertag, IDS.evtypeCustom,
    ].sort()
    expect(types.map((r) => r.id).sort()).toEqual(expectedTypeIds)

    const events = await sql<{ id: string }[]>`SELECT id FROM calendar_events ORDER BY id`
    expect(events.map((r) => r.id).sort()).toEqual([IDS.eventSent, IDS.eventRecurring].sort())

    const queue = await sql<{ id: string }[]>`SELECT id FROM caldav_sync_queue`
    expect(queue[0]!.id).toBe(IDS.caldavQueueEntry)
  })

  it('round-trips UTC timestamps (source timestamptz → same instant in target)', async () => {
    const sql = await freshTarget()
    await runBackfill({
      tenant: TENANT.slug,
      tenantId: TENANT.id,
      pgUrl: TEST_PG_URL,
      sourceDb: SOURCE_DB,
      dbPrefix: TEST_DB_PREFIX,
      verifyOnly: false,
      log: () => {},
    })

    const rows = await sql<{ created_at: Date }[]>`
      SELECT created_at FROM calendar_events WHERE id = ${IDS.eventSent}
    `
    expect(rows[0]!.created_at.toISOString()).toBe(UTC_TS)
  })

  it('refuses a NON-EMPTY target unless --verify-only', async () => {
    await runBackfill({
      tenant: TENANT.slug,
      tenantId: TENANT.id,
      pgUrl: TEST_PG_URL,
      sourceDb: SOURCE_DB,
      dbPrefix: TEST_DB_PREFIX,
      verifyOnly: false,
      log: () => {},
    })
    await expect(
      runBackfill({
        tenant: TENANT.slug,
        tenantId: TENANT.id,
        pgUrl: TEST_PG_URL,
        sourceDb: SOURCE_DB,
        dbPrefix: TEST_DB_PREFIX,
        verifyOnly: false,
        log: () => {},
      }),
    ).rejects.toThrow(/non-empty|not empty|already/i)
  })

  it('honors a distinct --source-pg-url / sourcePgUrl (separate source connection, same server, different DB name)', async () => {
    const sql = await freshTarget()
    // Supply the source connection EXPLICITLY via sourcePgUrl (distinct from the
    // target's pgUrl, though on the same local server), and the source DB via
    // sourceDb (different DB name from the calendar_test_<slug> target). The copy
    // must succeed reading through that separate source connection.
    const res = await runBackfill({
      tenant: TENANT.slug,
      tenantId: TENANT.id,
      sourcePgUrl: TEST_PG_URL,
      sourceDb: SOURCE_DB,
      pgUrl: TEST_PG_URL,
      dbPrefix: TEST_DB_PREFIX,
      verifyOnly: false,
      log: () => {},
    })
    expect(res.ok).toBe(true)
    expect(res.counts['calendar_events']).toEqual({ source: 2, pg: 2 })
    // The explicit source connection carried the data through verbatim.
    const events = await sql<{ id: string }[]>`SELECT id FROM calendar_events ORDER BY id`
    expect(events.map((r) => r.id).sort()).toEqual([IDS.eventSent, IDS.eventRecurring].sort())
  })

  it('refuses when source and target resolve to the SAME database (before any copy)', async () => {
    await freshTarget()
    // Point the source at the TARGET's own leaf DB (calendar_test_<slug>) on the
    // same server → source and target resolve to the identical database → must
    // refuse BEFORE copying (a DB into itself is never a valid backfill).
    const targetDbName = TEST_DB_PREFIX + TENANT.slug
    await expect(
      runBackfill({
        tenant: TENANT.slug,
        tenantId: TENANT.id,
        sourcePgUrl: TEST_PG_URL,
        sourceDb: targetDbName,
        pgUrl: TEST_PG_URL,
        dbPrefix: TEST_DB_PREFIX,
        verifyOnly: false,
        log: () => {},
      }),
    ).rejects.toThrow(/same database|source and target/i)
  })

  it('is idempotent in --verify-only mode against a correctly-backfilled target', async () => {
    await runBackfill({
      tenant: TENANT.slug,
      tenantId: TENANT.id,
      pgUrl: TEST_PG_URL,
      sourceDb: SOURCE_DB,
      dbPrefix: TEST_DB_PREFIX,
      verifyOnly: false,
      log: () => {},
    })
    const logs: string[] = []
    const res = await runBackfill({
      tenant: TENANT.slug,
      tenantId: TENANT.id,
      pgUrl: TEST_PG_URL,
      sourceDb: SOURCE_DB,
      dbPrefix: TEST_DB_PREFIX,
      verifyOnly: true,
      log: (m) => logs.push(m),
    })
    expect(res.ok).toBe(true)
    expect(logs.join('\n')).toContain(`BACKFILL OK tenant=${TENANT.slug}`)
  })
})

describe('backfill — verify gate catches a TAMPERED target', () => {
  it('--verify-only on a target with a tampered event title exits non-ok NAMING the table', async () => {
    const sql = await freshTarget()
    await runBackfill({
      tenant: TENANT.slug,
      tenantId: TENANT.id,
      pgUrl: TEST_PG_URL,
      sourceDb: SOURCE_DB,
      dbPrefix: TEST_DB_PREFIX,
      verifyOnly: false,
      log: () => {},
    })
    await sql`UPDATE calendar_events SET title = 'TAMPERED' WHERE id = ${IDS.eventSent}`

    const logs: string[] = []
    await expect(
      runBackfill({
        tenant: TENANT.slug,
        tenantId: TENANT.id,
        pgUrl: TEST_PG_URL,
        sourceDb: SOURCE_DB,
        dbPrefix: TEST_DB_PREFIX,
        verifyOnly: true,
        log: (m) => logs.push(m),
      }),
    ).rejects.toThrow(/calendar_events/)
    expect(logs.join('\n')).not.toContain('BACKFILL OK')
  })

  it('--verify-only on a target with a deleted row exits non-ok NAMING the table (count mismatch)', async () => {
    const sql = await freshTarget()
    await runBackfill({
      tenant: TENANT.slug,
      tenantId: TENANT.id,
      pgUrl: TEST_PG_URL,
      sourceDb: SOURCE_DB,
      dbPrefix: TEST_DB_PREFIX,
      verifyOnly: false,
      log: () => {},
    })
    await sql`DELETE FROM committee_calendar_settings WHERE committee_id = ${IDS.committeeA}`
    await expect(
      runBackfill({
        tenant: TENANT.slug,
        tenantId: TENANT.id,
        pgUrl: TEST_PG_URL,
        sourceDb: SOURCE_DB,
        dbPrefix: TEST_DB_PREFIX,
        verifyOnly: true,
        log: () => {},
      }),
    ).rejects.toThrow(/committee_calendar_settings/)
  })
})

describe('backfill — CLI exit codes (the operator-facing contract)', () => {
  const scriptPath = fileURLToPath(new URL('../scripts/backfill.ts', import.meta.url))
  const cwd = fileURLToPath(new URL('..', import.meta.url))

  function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
    const r = spawnSync('npx', ['tsx', scriptPath, ...args], {
      cwd,
      encoding: 'utf-8',
      env: { ...process.env, CALENDAR_TEST_PG_URL: TEST_PG_URL },
      shell: process.platform === 'win32',
    })
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
  }

  it('--verify-only against a correctly-backfilled target → exit 0 + BACKFILL OK', async () => {
    await freshTarget()
    await runBackfill({
      tenant: TENANT.slug,
      tenantId: TENANT.id,
      pgUrl: TEST_PG_URL,
      sourceDb: SOURCE_DB,
      dbPrefix: TEST_DB_PREFIX,
      verifyOnly: false,
      log: () => {},
    })
    await _resetTenantStoreForTests()

    const r = runCli([
      '--tenant', TENANT.slug,
      '--tenant-id', TENANT.id,
      '--pg-url', TEST_PG_URL,
      '--source-db', SOURCE_DB,
      '--db-prefix', TEST_DB_PREFIX,
      '--verify-only',
    ])
    expect(r.status).toBe(0)
    expect(r.stdout + r.stderr).toContain(`BACKFILL OK tenant=${TENANT.slug}`)
  })

  it('accepts --source-pg-url (a distinct source connection) → exit 0 + BACKFILL OK', async () => {
    await freshTarget()
    await runBackfill({
      tenant: TENANT.slug,
      tenantId: TENANT.id,
      pgUrl: TEST_PG_URL,
      sourceDb: SOURCE_DB,
      dbPrefix: TEST_DB_PREFIX,
      verifyOnly: false,
      log: () => {},
    })
    await _resetTenantStoreForTests()

    const r = runCli([
      '--tenant', TENANT.slug,
      '--tenant-id', TENANT.id,
      '--source-pg-url', TEST_PG_URL,
      '--pg-url', TEST_PG_URL,
      '--source-db', SOURCE_DB,
      '--db-prefix', TEST_DB_PREFIX,
      '--verify-only',
    ])
    expect(r.status).toBe(0)
    expect(r.stdout + r.stderr).toContain(`BACKFILL OK tenant=${TENANT.slug}`)
  })

  it('--verify-only against a TAMPERED target → exit 1 NAMING the table', async () => {
    const sql = await freshTarget()
    await runBackfill({
      tenant: TENANT.slug,
      tenantId: TENANT.id,
      pgUrl: TEST_PG_URL,
      sourceDb: SOURCE_DB,
      dbPrefix: TEST_DB_PREFIX,
      verifyOnly: false,
      log: () => {},
    })
    await sql`UPDATE event_types SET name = 'Evil' WHERE id = ${IDS.evtypeCustom}`
    await _resetTenantStoreForTests()

    const r = runCli([
      '--tenant', TENANT.slug,
      '--tenant-id', TENANT.id,
      '--pg-url', TEST_PG_URL,
      '--source-db', SOURCE_DB,
      '--db-prefix', TEST_DB_PREFIX,
      '--verify-only',
    ])
    expect(r.status).toBe(1)
    expect(r.stdout + r.stderr).toMatch(/event_types/)
    expect(r.stdout + r.stderr).not.toContain('BACKFILL OK')
  })

  it('rejects a non-UUID --tenant-id with a clear message (tenant-by-UUID, #173)', () => {
    const r = runCli([
      '--tenant', TENANT.slug,
      '--tenant-id', 'not-a-uuid',
      '--pg-url', TEST_PG_URL,
      '--source-db', SOURCE_DB,
      '--db-prefix', TEST_DB_PREFIX,
      '--verify-only',
    ])
    expect(r.status).toBe(1)
    expect(r.stdout + r.stderr).toMatch(/tenant-id/i)
  })
})
