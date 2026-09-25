/**
 * Integration tests for the B5 holiday dedup: migration 003 (partial unique
 * index + pre-existing-dup collapse) and the conflict-tolerant store createEvent.
 *
 * Two isolated DBs:
 *   1. A RAW DB where 001+002 are applied, a DUPLICATE holiday is seeded (only
 *      possible pre-003), then 003 is applied — proving it de-dupes AND creates
 *      the partial unique index, after which a raw duplicate insert is rejected.
 *   2. A storeFor() DB (all migrations incl. 003) — proving a second createEvent
 *      with the same (source, external_id) holiday is a NO-OP returning the
 *      existing row, while non-holiday sources are NOT deduped.
 *
 * Fail-closed guard mirrors store.integration.test.ts: localhost-only +
 * calendar_test_ DB-name prefix.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { storeFor, _resetTenantStoreForTests, type TenantRef } from '../src/tenant-store.ts'
import { createEvent, findEventByExternalId, type CreateEventInput } from '../src/store/index.ts'
import { requireEphemeralTestPgUrl, assertSafeTestEnv } from './support/pg-test-guard.ts'

// ── fail-closed guard ─────────────────────────────────────────────────────────
const TEST_PG_URL = requireEphemeralTestPgUrl()
const TEST_DB_PREFIX = 'calendar_test_'
assertSafeTestEnv(TEST_PG_URL, TEST_DB_PREFIX)

// ── migration helpers ───────────────────────────────────────────────────────────
const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations')

/** Read a migration + strip the BEGIN/COMMIT wrapper (tenant-store runner pattern). */
function migrationSql(file: string): string {
  return readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8')
    .replace(/^\s*BEGIN\s*;?\s*/im, '')
    .replace(/\s*COMMIT\s*;?\s*$/im, '')
}

function dbUrlFor(dbName: string): string {
  const u = new URL(TEST_PG_URL)
  u.pathname = '/' + dbName
  return u.toString()
}

// ── PG lifecycle ────────────────────────────────────────────────────────────────
let admin: ReturnType<typeof postgres>

async function dropTestDbs(pgSql: ReturnType<typeof postgres>): Promise<void> {
  const rows = await pgSql<{ datname: string }[]>`
    SELECT datname FROM pg_database WHERE datname LIKE 'calendar_test_%'
  `
  for (const { datname } of rows) {
    await pgSql.unsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${datname}' AND pid <> pg_backend_pid()`,
    )
    await pgSql.unsafe(`DROP DATABASE IF EXISTS "${datname}"`)
  }
}

beforeAll(async () => {
  admin = postgres(TEST_PG_URL, { max: 1, prepare: false })
  await dropTestDbs(admin)
})

afterAll(async () => {
  await _resetTenantStoreForTests()
  await dropTestDbs(admin)
  await admin.end()
})

// ── 1. RAW migration apply: seed a pre-003 duplicate, then apply 003 ─────────────

describe('migration 003 — partial-unique holiday dedup (raw apply)', () => {
  const RAW_DB = 'calendar_test_holidaymig'
  let raw: ReturnType<typeof postgres>

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE "${RAW_DB}"`)
    raw = postgres(dbUrlFor(RAW_DB), { max: 2, prepare: false })
    // Apply 001 + 002 ONLY (no 003 yet) so a duplicate holiday can be seeded.
    await raw.begin(async (tx) => { await tx.unsafe(migrationSql('001_init.sql')) })
    await raw.begin(async (tx) => { await tx.unsafe(migrationSql('002_add_is_public.sql')) })
    // Seed TWO rows with the SAME (source, external_id) — distinct caldav_uid so
    // the caldav_uid UNIQUE constraint doesn't block the second insert.
    await raw`
      INSERT INTO calendar_events (title, start_at, end_at, created_by, source, external_id, caldav_uid)
      VALUES ('Dup A', now(), now(), 'system', 'holiday', 'dup-1', 'uid-a@stura')
    `
    await raw`
      INSERT INTO calendar_events (title, start_at, end_at, created_by, source, external_id, caldav_uid)
      VALUES ('Dup B', now(), now(), 'system', 'holiday', 'dup-1', 'uid-b@stura')
    `
  })

  afterAll(async () => {
    await raw?.end().catch(() => {})
  })

  it('003 collapses pre-existing duplicate holiday rows to one and creates the partial unique index', async () => {
    const before = await raw<{ c: number }[]>`
      SELECT count(*)::int AS c FROM calendar_events WHERE source = 'holiday' AND external_id = 'dup-1'
    `
    expect(before[0]!.c).toBe(2)

    await raw.begin(async (tx) => { await tx.unsafe(migrationSql('003_holiday_unique.sql')) })

    const after = await raw<{ c: number }[]>`
      SELECT count(*)::int AS c FROM calendar_events WHERE source = 'holiday' AND external_id = 'dup-1'
    `
    expect(after[0]!.c).toBe(1)

    const idx = await raw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE indexname = 'calendar_events_holiday_extid_uidx'
    `
    expect(idx).toHaveLength(1)
    expect(idx[0]!.indexdef).toMatch(/UNIQUE/i)
    expect(idx[0]!.indexdef.toLowerCase()).toContain("source = 'holiday'")
  })

  it('a raw duplicate holiday insert is now rejected by the partial unique index', async () => {
    await expect(
      raw`
        INSERT INTO calendar_events (title, start_at, end_at, created_by, source, external_id, caldav_uid)
        VALUES ('Dup C', now(), now(), 'system', 'holiday', 'dup-1', 'uid-c@stura')
      `,
    ).rejects.toThrow()
  })

  it('003 is idempotent — re-applying it against an already-unique set is a no-op', async () => {
    await expect(
      raw.begin(async (tx) => { await tx.unsafe(migrationSql('003_holiday_unique.sql')) }),
    ).resolves.not.toThrow()
  })
})

// ── 2. store createEvent — holiday idempotency (all migrations via storeFor) ─────

describe('createEvent — holiday idempotency (store, all migrations incl. 003)', () => {
  const TENANT: TenantRef = { id: 'ffffffff-ffff-ffff-ffff-ffffffffffff', slug: 'holidedup' }
  let sql: Awaited<ReturnType<typeof storeFor>>

  function holidayInput(externalId: string): CreateEventInput {
    return {
      title: `Feiertag ${externalId}`,
      description: null,
      location: null,
      startAt: new Date('2026-05-01T00:00:00Z'),
      endAt: new Date('2026-05-01T23:59:59Z'),
      allDay: true,
      eventTypeId: null,
      isMultiCommittee: false,
      createdBy: 'system',
      source: 'holiday',
      externalId,
      committeeIds: [],
      recurrence: null,
    }
  }

  beforeAll(async () => {
    sql = await storeFor(TENANT, { pgUrl: TEST_PG_URL, dbPrefix: TEST_DB_PREFIX })
  })

  it('a second createEvent with the same (source, external_id) holiday is a NO-OP returning the existing row', async () => {
    const first = await createEvent(sql, holidayInput('new-1'))
    const second = await createEvent(sql, holidayInput('new-1'))

    expect(second.id).toBe(first.id)

    const rows = await sql<{ c: number }[]>`
      SELECT count(*)::int AS c FROM calendar_events WHERE source = 'holiday' AND external_id = 'new-1'
    `
    expect(rows[0]!.c).toBe(1)

    // The dedup read resolves to the same row.
    const found = await findEventByExternalId(sql, 'holiday', 'new-1')
    expect(found).not.toBeNull()
    expect(found!.id).toBe(first.id)

    // The no-op must NOT enqueue a second CalDAV create for this event.
    const queue = await sql<{ c: number }[]>`
      SELECT count(*)::int AS c FROM caldav_sync_queue q
      JOIN calendar_events e ON e.id = q.event_id
      WHERE e.external_id = 'new-1' AND q.operation = 'create'
    `
    expect(queue[0]!.c).toBe(1)
  })

  it('non-holiday sources are NOT deduped (no partial index applies to them)', async () => {
    const a = await createEvent(sql, { ...holidayInput('shared'), source: 'manual' })
    const b = await createEvent(sql, { ...holidayInput('shared'), source: 'manual' })
    expect(b.id).not.toBe(a.id)

    const rows = await sql<{ c: number }[]>`
      SELECT count(*)::int AS c FROM calendar_events WHERE source = 'manual' AND external_id = 'shared'
    `
    expect(rows[0]!.c).toBe(2)
  })
})
