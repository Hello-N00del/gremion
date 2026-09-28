/**
 * Integration tests for services/newsletter/scripts/backfill.ts
 *
 * THE named highest Phase-1 risk: the SQLite→PG data migration the live cutover
 * (Task 22) actually runs. Correctness — id preservation, UTC timestamp
 * round-trip, checksum verification — is paramount.
 *
 * TDD coverage (Task 20 brief):
 *   - builds a SYNTHETIC SQLite store (a REAL initNewsletterDb-shaped file with
 *     rows in EVERY backfilled table incl. one `sending`, one `scheduled`, and
 *     live unsubscribe tokens) → run backfill →
 *   - assert per-table row counts equal,
 *   - assert ID PRESERVATION (max(id) carried over + a follow-up INSERT does NOT
 *     collide with a backfilled id — the sequence was advanced past max),
 *   - assert UTC timestamp ROUND-TRIP (a known SQLite UTC string lands as the
 *     same instant in the timestamptz column),
 *   - assert the verify-gate checksum lines are printed,
 *   - `--verify-only` against a TAMPERED target → exit 1 NAMING the table.
 *
 * Runs against NEWSLETTER_TEST_PG_URL (a local throwaway Postgres). Fail-closed
 * guard: refuses to run unless host is localhost/127.0.0.1 AND every DB uses the
 * `newsletter_test_` prefix (mirrors #249 / the store integration suites).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import Database from 'better-sqlite3'
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
const TEST_DB_PREFIX = 'newsletter_test_'
assertSafeTestEnv(TEST_PG_URL, TEST_DB_PREFIX)

// ── test tenant ───────────────────────────────────────────────────────────────
const TENANT: TenantRef = { id: 'dddddddd-dddd-dddd-dddd-dddddddddddd', slug: 'backfill' }

// A known UTC instant in SQLite canonical form ('YYYY-MM-DD HH:MM:SS', UTC).
const UTC_TS = '2026-01-15 09:30:00'
const UTC_TS_ISO = '2026-01-15T09:30:00.000Z' // the same instant as an ISO-Z string

// ── synthetic SQLite store builder (REAL initNewsletterDb-shaped) ─────────────
//
// We construct the exact schema initNewsletterDb writes (newsletter-db.ts),
// then seed rows in EVERY backfilled table with explicit ids + the known UTC
// timestamp, including the §D-mandated edge rows: one `sending` newsletter and
// one `scheduled` newsletter, plus live (non-expired) send tokens.
function buildSyntheticSqlite(filePath: string): void {
  const db = new Database(filePath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE mailing_lists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE mailing_list_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      list_id INTEGER NOT NULL REFERENCES mailing_lists(id) ON DELETE CASCADE,
      email TEXT NOT NULL, name TEXT,
      source TEXT NOT NULL CHECK(source IN ('csv','manual')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(list_id, email)
    );
    CREATE TABLE newsletters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL, odt_path TEXT NOT NULL, subject TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK(status IN ('draft','scheduled','sending','sent','failed')),
      scheduled_at TEXT, sent_at TEXT, error TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE newsletter_recipients (
      newsletter_id INTEGER NOT NULL REFERENCES newsletters(id) ON DELETE CASCADE,
      mailing_list_id INTEGER REFERENCES mailing_lists(id),
      keycloak_group_id TEXT,
      CHECK((mailing_list_id IS NOT NULL) OR (keycloak_group_id IS NOT NULL)),
      CHECK(NOT (mailing_list_id IS NOT NULL AND keycloak_group_id IS NOT NULL))
    );
    CREATE TABLE unsubscribes (
      email TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE,
      unsubscribed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE send_tokens (
      token TEXT PRIMARY KEY,
      newsletter_id INTEGER NOT NULL REFERENCES newsletters(id),
      email TEXT NOT NULL,
      expires_at TEXT NOT NULL DEFAULT (datetime('now','+7 days')),
      UNIQUE(newsletter_id, email)
    );
    CREATE TABLE newsletter_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      newsletter_id INTEGER NOT NULL, actor_sub TEXT NOT NULL, action TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `)

  // mailing_lists — explicit ids with a GAP (1, 5) to prove id preservation.
  db.prepare(`INSERT INTO mailing_lists (id, name, created_at) VALUES (?,?,?)`).run(1, 'AStA', UTC_TS)
  db.prepare(`INSERT INTO mailing_lists (id, name, created_at) VALUES (?,?,?)`).run(5, 'Fachschaft', UTC_TS)

  // members — explicit ids, the email column is checksum-verified.
  const mIns = db.prepare(
    `INSERT INTO mailing_list_members (id, list_id, email, name, source, created_at) VALUES (?,?,?,?,?,?)`,
  )
  mIns.run(2, 1, 'alice@example.org', 'Alice', 'manual', UTC_TS)
  mIns.run(7, 1, 'bob@example.org', 'Bob', 'csv', UTC_TS)
  mIns.run(9, 5, 'carol@example.org', null, 'manual', UTC_TS)

  // newsletters — include one `sending` and one `scheduled` (§D edge rows),
  // explicit ids with a gap (3, 10, 11).
  const nIns = db.prepare(
    `INSERT INTO newsletters
       (id, title, odt_path, subject, status, scheduled_at, sent_at, error, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  )
  nIns.run(3, 'Sent NL', '/a.odt', 'Subj A', 'sent', null, UTC_TS, null, 'admin', UTC_TS, UTC_TS)
  nIns.run(10, 'Sending NL', '/b.odt', 'Subj B', 'sending', null, null, null, 'admin', UTC_TS, UTC_TS)
  nIns.run(11, 'Scheduled NL', '/c.odt', 'Subj C', 'scheduled', UTC_TS, null, null, 'admin', UTC_TS, UTC_TS)

  // recipients (no id column) — one list-backed, one group-backed.
  db.prepare(
    `INSERT INTO newsletter_recipients (newsletter_id, mailing_list_id, keycloak_group_id) VALUES (?,?,?)`,
  ).run(3, 1, null)
  db.prepare(
    `INSERT INTO newsletter_recipients (newsletter_id, mailing_list_id, keycloak_group_id) VALUES (?,?,?)`,
  ).run(11, null, 'kc-group-1')

  // unsubscribes (text PK email) — email column is checksum-verified.
  db.prepare(
    `INSERT INTO unsubscribes (email, token, unsubscribed_at) VALUES (?,?,?)`,
  ).run('gone@example.org', 'unsub-tok-1', UTC_TS)

  // send_tokens (text PK token) — LIVE (far-future expiry); token column is
  // checksum-verified. Embedded in already-sent mail → MUST survive verbatim.
  const sIns = db.prepare(
    `INSERT INTO send_tokens (token, newsletter_id, email, expires_at) VALUES (?,?,?,?)`,
  )
  sIns.run('live-tok-aaa', 3, 'alice@example.org', '2099-01-01 00:00:00')
  sIns.run('live-tok-bbb', 3, 'bob@example.org', '2099-01-01 00:00:00')

  // newsletter_audit — explicit ids with a gap (4, 8).
  const aIns = db.prepare(
    `INSERT INTO newsletter_audit (id, newsletter_id, actor_sub, action, created_at) VALUES (?,?,?,?,?)`,
  )
  aIns.run(4, 3, 'admin', 'sent', UTC_TS)
  aIns.run(8, 10, 'admin', 'send-started', UTC_TS)

  db.close()
}

// ── PG fixtures ─────────────────────────────────────────────────────────────
let admin: ReturnType<typeof postgres>
let tmpDir: string
let sqlitePath: string

async function dropTestDbs(pgSql: ReturnType<typeof postgres>): Promise<void> {
  const rows = await pgSql<{ datname: string }[]>`
    SELECT datname FROM pg_database WHERE datname LIKE 'newsletter_test_%'
  `
  for (const { datname } of rows) {
    await pgSql.unsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${datname}' AND pid <> pg_backend_pid()`,
    )
    await pgSql.unsafe(`DROP DATABASE IF EXISTS "${datname}"`)
  }
}

/** Fresh, EMPTY target DB for this tenant (drops + recreates via storeFor). */
async function freshTarget(): Promise<Sql> {
  await _resetTenantStoreForTests()
  await dropTestDbs(admin)
  // storeFor creates the DB + applies migration 001 and returns a pool.
  return storeFor(TENANT, { pgUrl: TEST_PG_URL, dbPrefix: TEST_DB_PREFIX })
}

beforeAll(async () => {
  admin = postgres(TEST_PG_URL, { max: 1, prepare: false })
  tmpDir = mkdtempSync(path.join(tmpdir(), 'nl-backfill-'))
  sqlitePath = path.join(tmpDir, 'sample.db')
  buildSyntheticSqlite(sqlitePath)
})

afterAll(async () => {
  await _resetTenantStoreForTests()
  await dropTestDbs(admin)
  await admin.end()
  rmSync(tmpDir, { recursive: true, force: true })
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
      sqlitePath,
      verifyOnly: false,
      pgUrl: TEST_PG_URL,
      dbPrefix: TEST_DB_PREFIX,
      log: (m) => logs.push(m),
    })

    expect(res.ok).toBe(true)
    // Per-table source counts as built above.
    expect(res.counts['mailing_lists']).toEqual({ sqlite: 2, pg: 2 })
    expect(res.counts['mailing_list_members']).toEqual({ sqlite: 3, pg: 3 })
    expect(res.counts['newsletters']).toEqual({ sqlite: 3, pg: 3 })
    expect(res.counts['newsletter_recipients']).toEqual({ sqlite: 2, pg: 2 })
    expect(res.counts['unsubscribes']).toEqual({ sqlite: 1, pg: 1 })
    expect(res.counts['send_tokens']).toEqual({ sqlite: 2, pg: 2 })
    expect(res.counts['newsletter_audit']).toEqual({ sqlite: 2, pg: 2 })
    // The final OK line is printed.
    expect(logs.join('\n')).toContain(`BACKFILL OK tenant=${TENANT.slug}`)
  })

  it('prints checksum lines for the email/token-checksummed tables + status histogram', async () => {
    const logs: string[] = []
    await runBackfill({
      tenant: TENANT.slug,
      tenantId: TENANT.id,
      sqlitePath,
      verifyOnly: false,
      pgUrl: TEST_PG_URL,
      dbPrefix: TEST_DB_PREFIX,
      log: (m) => logs.push(m),
    })
    const out = logs.join('\n')
    // Verify gate prints a checksum compare per checksummed table.
    expect(out).toMatch(/checksum.*mailing_list_members/i)
    expect(out).toMatch(/checksum.*unsubscribes/i)
    expect(out).toMatch(/checksum.*send_tokens/i)
    // And the newsletters status histogram.
    expect(out).toMatch(/histogram|status/i)
  })

  it('PRESERVES ids: max(id) survives and a follow-up INSERT does not collide', async () => {
    const sql = await freshTarget()
    await runBackfill({
      tenant: TENANT.slug,
      tenantId: TENANT.id,
      sqlitePath,
      verifyOnly: false,
      pgUrl: TEST_PG_URL,
      dbPrefix: TEST_DB_PREFIX,
      log: () => {},
    })

    // The exact source ids must be present (not renumbered).
    const lists = await sql<{ id: number }[]>`SELECT id FROM mailing_lists ORDER BY id`
    expect(lists.map((r) => Number(r.id))).toEqual([1, 5])

    const nls = await sql<{ id: number }[]>`SELECT id FROM newsletters ORDER BY id`
    expect(nls.map((r) => Number(r.id))).toEqual([3, 10, 11])

    // A NEW insert (sequence-driven) must get an id GREATER than the max
    // backfilled id — i.e. the sequence was advanced via setval. No collision.
    const newList = await sql<{ id: number }[]>`
      INSERT INTO mailing_lists (name) VALUES ('post-backfill') RETURNING id
    `
    expect(Number(newList[0]!.id)).toBeGreaterThan(5)

    const newNl = await sql<{ id: number }[]>`
      INSERT INTO newsletters (title, odt_path, subject, created_by)
      VALUES ('post', '/p.odt', 'P', 'admin') RETURNING id
    `
    expect(Number(newNl[0]!.id)).toBeGreaterThan(11)

    const newMember = await sql<{ id: number }[]>`
      INSERT INTO mailing_list_members (list_id, email, name, source)
      VALUES (1, 'late@example.org', null, 'manual') RETURNING id
    `
    expect(Number(newMember[0]!.id)).toBeGreaterThan(9)

    const newAudit = await sql<{ id: number }[]>`
      INSERT INTO newsletter_audit (newsletter_id, actor_sub, action)
      VALUES (3, 'admin', 'late') RETURNING id
    `
    expect(Number(newAudit[0]!.id)).toBeGreaterThan(8)
  })

  it('round-trips UTC timestamps (SQLite UTC string → same instant in timestamptz)', async () => {
    const sql = await freshTarget()
    await runBackfill({
      tenant: TENANT.slug,
      tenantId: TENANT.id,
      sqlitePath,
      verifyOnly: false,
      pgUrl: TEST_PG_URL,
      dbPrefix: TEST_DB_PREFIX,
      log: () => {},
    })

    // The newsletter row whose created_at was the known UTC string must land as
    // the SAME instant — read it back normalized to UTC ISO.
    const rows = await sql<{ created_at_utc: string }[]>`
      SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at_utc
      FROM newsletters WHERE id = 3
    `
    expect(rows[0]!.created_at_utc).toBe(UTC_TS_ISO)

    // And the JS Date round-trip equals the known instant exactly.
    const dateRows = await sql<{ created_at: Date }[]>`
      SELECT created_at FROM newsletters WHERE id = 3
    `
    expect(dateRows[0]!.created_at.toISOString()).toBe(UTC_TS_ISO)
  })

  it('refuses a NON-EMPTY target unless --verify-only', async () => {
    // First backfill populates the target.
    await runBackfill({
      tenant: TENANT.slug,
      tenantId: TENANT.id,
      sqlitePath,
      verifyOnly: false,
      pgUrl: TEST_PG_URL,
      dbPrefix: TEST_DB_PREFIX,
      log: () => {},
    })
    // A second non-verify run must refuse (fail-closed, no silent merge).
    await expect(
      runBackfill({
        tenant: TENANT.slug,
        tenantId: TENANT.id,
        sqlitePath,
        verifyOnly: false,
        pgUrl: TEST_PG_URL,
        dbPrefix: TEST_DB_PREFIX,
        log: () => {},
      }),
    ).rejects.toThrow(/non-empty|not empty|already/i)
  })

  it('is idempotent in --verify-only mode against a correctly-backfilled target', async () => {
    await runBackfill({
      tenant: TENANT.slug,
      tenantId: TENANT.id,
      sqlitePath,
      verifyOnly: false,
      pgUrl: TEST_PG_URL,
      dbPrefix: TEST_DB_PREFIX,
      log: () => {},
    })
    const logs: string[] = []
    const res = await runBackfill({
      tenant: TENANT.slug,
      tenantId: TENANT.id,
      sqlitePath,
      verifyOnly: true,
      pgUrl: TEST_PG_URL,
      dbPrefix: TEST_DB_PREFIX,
      log: (m) => logs.push(m),
    })
    expect(res.ok).toBe(true)
    expect(logs.join('\n')).toContain(`BACKFILL OK tenant=${TENANT.slug}`)
  })
})

describe('backfill — verify gate catches a TAMPERED target', () => {
  it('--verify-only on a target with a tampered member email exits non-ok NAMING the table', async () => {
    const sql = await freshTarget()
    await runBackfill({
      tenant: TENANT.slug,
      tenantId: TENANT.id,
      sqlitePath,
      verifyOnly: false,
      pgUrl: TEST_PG_URL,
      dbPrefix: TEST_DB_PREFIX,
      log: () => {},
    })
    // Tamper: change one member email so the checksum diverges (count stays equal).
    await sql`UPDATE mailing_list_members SET email = 'tampered@example.org' WHERE id = 2`

    const logs: string[] = []
    await expect(
      runBackfill({
        tenant: TENANT.slug,
        tenantId: TENANT.id,
        sqlitePath,
        verifyOnly: true,
        pgUrl: TEST_PG_URL,
        dbPrefix: TEST_DB_PREFIX,
        log: (m) => logs.push(m),
      }),
    ).rejects.toThrow(/mailing_list_members/)
    expect(logs.join('\n')).not.toContain('BACKFILL OK')
  })

  it('--verify-only on a target with a deleted row exits non-ok NAMING the table (count mismatch)', async () => {
    const sql = await freshTarget()
    await runBackfill({
      tenant: TENANT.slug,
      tenantId: TENANT.id,
      sqlitePath,
      verifyOnly: false,
      pgUrl: TEST_PG_URL,
      dbPrefix: TEST_DB_PREFIX,
      log: () => {},
    })
    await sql`DELETE FROM send_tokens WHERE token = 'live-tok-bbb'`
    await expect(
      runBackfill({
        tenant: TENANT.slug,
        tenantId: TENANT.id,
        sqlitePath,
        verifyOnly: true,
        pgUrl: TEST_PG_URL,
        dbPrefix: TEST_DB_PREFIX,
        log: () => {},
      }),
    ).rejects.toThrow(/send_tokens/)
  })
})

describe('backfill — CLI exit codes (the operator-facing contract)', () => {
  const scriptPath = fileURLToPath(new URL('../scripts/backfill.ts', import.meta.url))
  const cwd = fileURLToPath(new URL('..', import.meta.url))

  function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
    const r = spawnSync('npx', ['tsx', scriptPath, ...args], {
      cwd,
      encoding: 'utf-8',
      env: { ...process.env, NEWSLETTER_TEST_PG_URL: TEST_PG_URL },
      shell: process.platform === 'win32',
    })
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
  }

  it('--verify-only against a correctly-backfilled target → exit 0 + BACKFILL OK', async () => {
    await freshTarget()
    await runBackfill({
      tenant: TENANT.slug,
      tenantId: TENANT.id,
      sqlitePath,
      verifyOnly: false,
      pgUrl: TEST_PG_URL,
      dbPrefix: TEST_DB_PREFIX,
      log: () => {},
    })
    // Release in-process pools so the CLI subprocess can connect freely.
    await _resetTenantStoreForTests()

    const r = runCli([
      '--tenant', TENANT.slug,
      '--tenant-id', TENANT.id,
      '--sqlite', sqlitePath,
      '--verify-only',
      '--pg-url', TEST_PG_URL,
      '--db-prefix', TEST_DB_PREFIX,
    ])
    expect(r.status).toBe(0)
    expect(r.stdout + r.stderr).toContain(`BACKFILL OK tenant=${TENANT.slug}`)
  })

  it('--verify-only against a TAMPERED target → exit 1 NAMING the table', async () => {
    const sql = await freshTarget()
    await runBackfill({
      tenant: TENANT.slug,
      tenantId: TENANT.id,
      sqlitePath,
      verifyOnly: false,
      pgUrl: TEST_PG_URL,
      dbPrefix: TEST_DB_PREFIX,
      log: () => {},
    })
    await sql`UPDATE unsubscribes SET email = 'evil@example.org' WHERE email = 'gone@example.org'`
    await _resetTenantStoreForTests()

    const r = runCli([
      '--tenant', TENANT.slug,
      '--tenant-id', TENANT.id,
      '--sqlite', sqlitePath,
      '--verify-only',
      '--pg-url', TEST_PG_URL,
      '--db-prefix', TEST_DB_PREFIX,
    ])
    expect(r.status).toBe(1)
    expect(r.stdout + r.stderr).toMatch(/unsubscribes/)
    expect(r.stdout + r.stderr).not.toContain('BACKFILL OK')
  })
})
