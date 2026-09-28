/**
 * Integration tests for services/content/scripts/backfill.ts
 *
 * Correctness — id preservation, UTC timestamp round-trip, checksum
 * verification — is paramount (this is the data migration the live cutover
 * actually runs).
 *
 * TDD coverage (Task 24 brief):
 *   - builds a SYNTHETIC PG source DB matching the REAL kernel content schema
 *     (gremion-ui/migrations/044+045+046) — note content.posts has the KERNEL
 *     7-column shape (NO status/scheduled_at/sent_at/error; those live only on
 *     the leaf, migration 002), rows in EVERY backfilled table with explicit
 *     UUIDs and the known UTC timestamp, plus live send tokens → run backfill →
 *   - assert per-table row counts equal,
 *   - assert UUID PRESERVATION (source UUIDs appear verbatim in the target),
 *   - assert UTC timestamp ROUND-TRIP (a known UTC string lands as the same
 *     instant in the timestamptz column),
 *   - assert every target post lands with the leaf default status='draft'
 *     (the kernel source carries no status to copy),
 *   - assert the verify-gate checksum lines are printed,
 *   - refuses when source and target resolve to the SAME database,
 *   - `--verify-only` against a TAMPERED target → exit 1 NAMING the table.
 *
 * Runs against CONTENT_TEST_PG_URL (a local throwaway Postgres). Fail-closed
 * guard: refuses to run unless host is localhost/127.0.0.1 AND the target DBs
 * use the `content_test_` prefix.
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

// ── fail-closed guard ─────────────────────────────────────────────────────────
const TEST_PG_URL = requireEphemeralTestPgUrl()
const TEST_DB_PREFIX = 'content_test_'
assertSafeTestEnv(TEST_PG_URL, TEST_DB_PREFIX)

// ── test tenant ───────────────────────────────────────────────────────────────
const TENANT: TenantRef = { id: 'dddddddd-dddd-dddd-dddd-dddddddddddd', slug: 'backfill' }
// Name of the synthetic source DB (mirrors kernel t_<slug> naming).
const SOURCE_DB = 'content_test_backfill_src'

// ── known UUIDs (explicit, with gaps to prove preservation) ───────────────────
const POST_A = 'aaaaaaaa-0001-0001-0001-000000000001'
const POST_B = 'aaaaaaaa-0002-0002-0002-000000000002'
const POST_C = 'aaaaaaaa-0003-0003-0003-000000000003'
const MEDIA_A = 'bbbbbbbb-0001-0001-0001-000000000001'
const LIST_A = 'cccccccc-0001-0001-0001-000000000001'
const LIST_B = 'cccccccc-0005-0005-0005-000000000005' // gap (skipping 2/3/4)
const MEMBER_A = 'dddddddd-0002-0002-0002-000000000002'
const MEMBER_B = 'dddddddd-0007-0007-0007-000000000007' // gap
const MEMBER_C = 'dddddddd-0009-0009-0009-000000000009' // gap
const RECIPIENT_A = 'eeeeeeee-0001-0001-0001-000000000001'
const DELIVERY_A = 'ffffffff-0001-0001-0001-000000000001'
const PUB_OP_A = 'a1b2c3d4-0001-0001-0001-000000000001'

// A known UTC instant in 'YYYY-MM-DD HH:MM:SS' form (no offset — kernel style).
const UTC_TS = '2026-01-15 09:30:00'
const UTC_TS_ISO = '2026-01-15T09:30:00.000Z'

// ── synthetic source DB builder ───────────────────────────────────────────────
//
// Creates the content schema on a throwaway source DB and seeds rows in EVERY
// backfilled table with explicit UUIDs and the known UTC timestamp. The schema
// mirrors the REAL kernel (gremion-ui/migrations/044+045+046) — in particular
// content.posts is the KERNEL 7-column shape (id, slug, title, body_html,
// created_by, created_at, updated_at) with NO status/scheduled_at/sent_at/error
// columns; those dispatch-lifecycle columns exist only on the LEAF (migration
// 002_posts_status.sql), so the backfill copies the 7 kernel columns and the
// leaf defaults every copied post to status='draft'. Includes:
//   - three kernel-shaped posts (no status column on the source)
//   - live send tokens (non-expired)
//   - media, post_channels, mailing lists + members, post_recipients
//   - unsubscribes, deliveries, publications, publish_ops
async function buildSyntheticSourceDb(admin: ReturnType<typeof postgres>): Promise<void> {
  // Drop + recreate the source DB.
  await admin.unsafe(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${SOURCE_DB}' AND pid <> pg_backend_pid()`,
  )
  await admin.unsafe(`DROP DATABASE IF EXISTS "${SOURCE_DB}"`)
  await admin.unsafe(`CREATE DATABASE "${SOURCE_DB}"`)

  // Connect to the source DB and create the content schema + tables.
  const srcUrl = buildDbUrl(TEST_PG_URL, SOURCE_DB)
  const src = postgres(srcUrl, { max: 1, prepare: false })
  try {
    await src.unsafe(`
      CREATE SCHEMA IF NOT EXISTS content;

      -- posts — KERNEL shape, verbatim from gremion-ui/migrations/044_content_
      -- schema.sql: exactly 7 columns, NO status/scheduled_at/sent_at/error.
      -- Those dispatch-lifecycle columns exist ONLY on the leaf (migration
      -- 002_posts_status.sql), so the source has nothing to copy for them and
      -- the leaf default (status='draft') fills them after the copy.
      CREATE TABLE IF NOT EXISTS content.posts (
        id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        slug       TEXT        NOT NULL UNIQUE,
        title      TEXT        NOT NULL DEFAULT '',
        body_html  TEXT        NOT NULL DEFAULT '',
        created_by TEXT        NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      -- post_media (UUID PK)
      CREATE TABLE IF NOT EXISTS content.post_media (
        id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        post_id  UUID NOT NULL REFERENCES content.posts(id) ON DELETE CASCADE,
        url      TEXT NOT NULL,
        role     TEXT NOT NULL CHECK (role IN ('hero', 'slide', 'inline')),
        position INT  NOT NULL DEFAULT 0,
        alt      TEXT
      );

      -- post_channels (composite PK, no UUID id)
      CREATE TABLE IF NOT EXISTS content.post_channels (
        post_id      UUID    NOT NULL REFERENCES content.posts(id) ON DELETE CASCADE,
        channel      TEXT    NOT NULL CHECK (channel IN ('email', 'portal', 'instagram')),
        enabled      BOOLEAN NOT NULL DEFAULT false,
        status       TEXT    NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft', 'scheduled', 'sent', 'published', 'failed')),
        scheduled_at TIMESTAMPTZ,
        overrides    JSONB   NOT NULL DEFAULT '{}'::jsonb,
        PRIMARY KEY (post_id, channel)
      );

      -- mailing_lists (UUID PK)
      CREATE TABLE IF NOT EXISTS content.mailing_lists (
        id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        name       TEXT        NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      -- mailing_list_members (UUID PK)
      CREATE TABLE IF NOT EXISTS content.mailing_list_members (
        id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        mailing_list_id UUID        NOT NULL REFERENCES content.mailing_lists(id) ON DELETE CASCADE,
        email           TEXT        NOT NULL,
        name            TEXT,
        source          TEXT        NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'csv')),
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (mailing_list_id, email)
      );

      -- post_recipients (UUID PK)
      CREATE TABLE IF NOT EXISTS content.post_recipients (
        id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        post_id           UUID NOT NULL REFERENCES content.posts(id) ON DELETE CASCADE,
        mailing_list_id   UUID REFERENCES content.mailing_lists(id) ON DELETE CASCADE,
        keycloak_group_id TEXT,
        CHECK ((mailing_list_id IS NOT NULL) <> (keycloak_group_id IS NOT NULL))
      );

      -- unsubscribes (TEXT PK — email only, no token column)
      CREATE TABLE IF NOT EXISTS content.unsubscribes (
        email      TEXT        PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      -- send_tokens (TEXT PK)
      CREATE TABLE IF NOT EXISTS content.send_tokens (
        token      TEXT        PRIMARY KEY,
        post_id    UUID        NOT NULL REFERENCES content.posts(id) ON DELETE CASCADE,
        email      TEXT        NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '7 days'),
        UNIQUE (post_id, email)
      );

      -- deliveries (UUID PK)
      CREATE TABLE IF NOT EXISTS content.deliveries (
        id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        post_id         UUID        NOT NULL REFERENCES content.posts(id) ON DELETE CASCADE,
        email           TEXT        NOT NULL,
        status          TEXT        NOT NULL DEFAULT 'claimed'
                        CHECK (status IN ('claimed', 'sent', 'failed')),
        claimed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        sent_at         TIMESTAMPTZ,
        failed_at       TIMESTAMPTZ,
        smtp_message_id TEXT,
        error_message   TEXT,
        UNIQUE (post_id, email)
      );

      -- publications (composite PK)
      CREATE TABLE IF NOT EXISTS content.publications (
        post_id      UUID        NOT NULL REFERENCES content.posts(id) ON DELETE CASCADE,
        channel      TEXT        NOT NULL CHECK (channel IN ('email', 'portal', 'instagram')),
        external_ref TEXT,
        published_at TIMESTAMPTZ,
        PRIMARY KEY (post_id, channel)
      );

      -- publish_ops (UUID PK)
      CREATE TABLE IF NOT EXISTS content.publish_ops (
        id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        post_id         UUID        NOT NULL REFERENCES content.posts(id) ON DELETE CASCADE,
        channel         TEXT        NOT NULL DEFAULT 'instagram' CHECK (channel = 'instagram'),
        op              TEXT        NOT NULL DEFAULT 'publish' CHECK (op = 'publish'),
        status          TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ok','failed')),
        attempts        INT         NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMPTZ,
        first_failed_at TIMESTAMPTZ,
        last_error      TEXT,
        external_ref    TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (post_id, op)
      );
    `)

    // Seed rows with explicit UUIDs and the known UTC timestamp.
    // posts — KERNEL 7-column shape (no status/scheduled_at/sent_at/error).
    // Three posts, all carrying the known UTC instant on created_at/updated_at;
    // the leaf will default every one to status='draft' after the copy.
    await src.unsafe(
      `INSERT INTO content.posts (id, slug, title, body_html, created_by, created_at, updated_at)
       VALUES
         ($1, 'post-a', 'Post A', '<p>A</p>', 'admin', $2, $2),
         ($3, 'post-b', 'Post B', '<p>B</p>', 'admin', $2, $2),
         ($4, 'post-c', 'Post C', '<p>C</p>', 'admin', $2, $2)`,
      [POST_A, UTC_TS + 'Z', POST_B, POST_C],
    )

    // post_media
    await src.unsafe(
      `INSERT INTO content.post_media (id, post_id, url, role, position, alt) VALUES ($1, $2, 'https://example.org/img.jpg', 'hero', 0, 'Alt')`,
      [MEDIA_A, POST_A],
    )

    // post_channels
    await src.unsafe(
      `INSERT INTO content.post_channels (post_id, channel, enabled, status, scheduled_at, overrides) VALUES
         ($1, 'email', true, 'sent', NULL, '{}'),
         ($2, 'email', true, 'draft', NULL, '{}'),
         ($3, 'portal', false, 'draft', $4, '{}')`,
      [POST_A, POST_B, POST_C, UTC_TS + 'Z'],
    )

    // mailing_lists — explicit UUIDs with a gap (A, B=5th)
    await src.unsafe(
      `INSERT INTO content.mailing_lists (id, name, created_at) VALUES
         ($1, 'AStA', $3),
         ($2, 'Fachschaft', $3)`,
      [LIST_A, LIST_B, UTC_TS + 'Z'],
    )

    // mailing_list_members — email column is checksum-verified
    await src.unsafe(
      `INSERT INTO content.mailing_list_members (id, mailing_list_id, email, name, source, created_at) VALUES
         ($1, $4, 'alice@example.org', 'Alice', 'manual', $6),
         ($2, $4, 'bob@example.org', 'Bob', 'csv', $6),
         ($3, $5, 'carol@example.org', NULL, 'manual', $6)`,
      [MEMBER_A, MEMBER_B, MEMBER_C, LIST_A, LIST_B, UTC_TS + 'Z'],
    )

    // post_recipients
    await src.unsafe(
      `INSERT INTO content.post_recipients (id, post_id, mailing_list_id, keycloak_group_id) VALUES
         ($1, $2, $3, NULL)`,
      [RECIPIENT_A, POST_A, LIST_A],
    )

    // unsubscribes (TEXT PK)
    await src.unsafe(
      `INSERT INTO content.unsubscribes (email, created_at) VALUES ('gone@example.org', $1)`,
      [UTC_TS + 'Z'],
    )

    // send_tokens (TEXT PK) — LIVE (far-future expiry)
    await src.unsafe(
      `INSERT INTO content.send_tokens (token, post_id, email, expires_at) VALUES
         ('live-tok-aaa', $1, 'alice@example.org', '2099-01-01T00:00:00Z'),
         ('live-tok-bbb', $1, 'bob@example.org',   '2099-01-01T00:00:00Z')`,
      [POST_A],
    )

    // deliveries (UUID PK)
    await src.unsafe(
      `INSERT INTO content.deliveries (id, post_id, email, status, claimed_at, sent_at, failed_at, smtp_message_id, error_message)
       VALUES ($1, $2, 'alice@example.org', 'sent', $3, $3, NULL, 'msg-123', NULL)`,
      [DELIVERY_A, POST_A, UTC_TS + 'Z'],
    )

    // publications (composite PK)
    await src.unsafe(
      `INSERT INTO content.publications (post_id, channel, external_ref, published_at)
       VALUES ($1, 'email', NULL, $2)`,
      [POST_A, UTC_TS + 'Z'],
    )

    // publish_ops (UUID PK)
    await src.unsafe(
      `INSERT INTO content.publish_ops (id, post_id, status, attempts, created_at, updated_at)
       VALUES ($1, $2, 'pending', 0, $3, $3)`,
      [PUB_OP_A, POST_C, UTC_TS + 'Z'],
    )
  } finally {
    await src.end()
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

function buildDbUrl(adminUrl: string, dbName: string): string {
  const u = new URL(adminUrl)
  u.pathname = '/' + dbName
  return u.toString()
}

// ── PG fixtures ─────────────────────────────────────────────────────────────
let admin: ReturnType<typeof postgres>

async function dropTestDbs(): Promise<void> {
  const rows = await admin<{ datname: string }[]>`
    SELECT datname FROM pg_database WHERE datname LIKE 'content_test_%'
  `
  for (const { datname } of rows) {
    await admin.unsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${datname}' AND pid <> pg_backend_pid()`,
    )
    await admin.unsafe(`DROP DATABASE IF EXISTS "${datname}"`)
  }
}

/** Fresh, EMPTY target DB for this tenant (drops + recreates via storeFor). */
async function freshTarget(): Promise<Sql> {
  await _resetTenantStoreForTests()
  await dropTestDbs()
  await buildSyntheticSourceDb(admin)
  // storeFor creates the target DB + applies migrations and returns a pool.
  return storeFor(TENANT, { pgUrl: TEST_PG_URL, dbPrefix: TEST_DB_PREFIX })
}

beforeAll(async () => {
  admin = postgres(TEST_PG_URL, { max: 1, prepare: false })
  await buildSyntheticSourceDb(admin)
})

afterAll(async () => {
  await _resetTenantStoreForTests()
  await dropTestDbs()
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
      sourcePgUrl: TEST_PG_URL,
      sourceDbName: SOURCE_DB,
      verifyOnly: false,
      pgUrl: TEST_PG_URL,
      dbPrefix: TEST_DB_PREFIX,
      log: (m) => logs.push(m),
    })

    expect(res.ok).toBe(true)
    // Per-table source counts as built above.
    expect(res.counts['posts']).toEqual({ source: 3, pg: 3 })
    expect(res.counts['post_media']).toEqual({ source: 1, pg: 1 })
    expect(res.counts['post_channels']).toEqual({ source: 3, pg: 3 })
    expect(res.counts['mailing_lists']).toEqual({ source: 2, pg: 2 })
    expect(res.counts['mailing_list_members']).toEqual({ source: 3, pg: 3 })
    expect(res.counts['post_recipients']).toEqual({ source: 1, pg: 1 })
    expect(res.counts['unsubscribes']).toEqual({ source: 1, pg: 1 })
    expect(res.counts['send_tokens']).toEqual({ source: 2, pg: 2 })
    expect(res.counts['deliveries']).toEqual({ source: 1, pg: 1 })
    expect(res.counts['publications']).toEqual({ source: 1, pg: 1 })
    expect(res.counts['publish_ops']).toEqual({ source: 1, pg: 1 })
    // The final OK line is printed.
    expect(logs.join('\n')).toContain(`BACKFILL OK tenant=${TENANT.slug}`)
  })

  it('prints checksum lines for the email/token-checksummed tables + status histogram', async () => {
    const logs: string[] = []
    await runBackfill({
      tenant: TENANT.slug,
      tenantId: TENANT.id,
      sourcePgUrl: TEST_PG_URL,
      sourceDbName: SOURCE_DB,
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
    // And the posts status histogram.
    expect(out).toMatch(/histogram|status/i)
  })

  it('PRESERVES UUIDs: source UUIDs appear verbatim in the target', async () => {
    const sql = await freshTarget()
    await runBackfill({
      tenant: TENANT.slug,
      tenantId: TENANT.id,
      sourcePgUrl: TEST_PG_URL,
      sourceDbName: SOURCE_DB,
      verifyOnly: false,
      pgUrl: TEST_PG_URL,
      dbPrefix: TEST_DB_PREFIX,
      log: () => {},
    })

    // The exact source UUIDs must be present (not regenerated).
    const posts = await sql<{ id: string }[]>`SELECT id FROM content.posts ORDER BY id`
    const postIds = posts.map((r) => r.id)
    expect(postIds).toContain(POST_A)
    expect(postIds).toContain(POST_B)
    expect(postIds).toContain(POST_C)

    const lists = await sql<{ id: string }[]>`SELECT id FROM content.mailing_lists ORDER BY id`
    const listIds = lists.map((r) => r.id)
    expect(listIds).toContain(LIST_A)
    expect(listIds).toContain(LIST_B)

    const members = await sql<{ id: string }[]>`SELECT id FROM content.mailing_list_members ORDER BY id`
    const memberIds = members.map((r) => r.id)
    expect(memberIds).toContain(MEMBER_A)
    expect(memberIds).toContain(MEMBER_B)
    expect(memberIds).toContain(MEMBER_C)

    // Delivery UUID also preserved.
    const deliveries = await sql<{ id: string }[]>`SELECT id FROM content.deliveries`
    expect(deliveries.map((r) => r.id)).toContain(DELIVERY_A)
  })

  it('round-trips UTC timestamps (kernel UTC string → same instant in timestamptz)', async () => {
    const sql = await freshTarget()
    await runBackfill({
      tenant: TENANT.slug,
      tenantId: TENANT.id,
      sourcePgUrl: TEST_PG_URL,
      sourceDbName: SOURCE_DB,
      verifyOnly: false,
      pgUrl: TEST_PG_URL,
      dbPrefix: TEST_DB_PREFIX,
      log: () => {},
    })

    // The post row whose created_at was the known UTC string must land as
    // the SAME instant — read it back normalized to UTC ISO.
    const rows = await sql<{ created_at_utc: string }[]>`
      SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at_utc
      FROM content.posts WHERE id = ${POST_A}
    `
    expect(rows[0]!.created_at_utc).toBe(UTC_TS_ISO)

    // And the JS Date round-trip equals the known instant exactly.
    const dateRows = await sql<{ created_at: Date }[]>`
      SELECT created_at FROM content.posts WHERE id = ${POST_A}
    `
    expect(dateRows[0]!.created_at.toISOString()).toBe(UTC_TS_ISO)
  })

  it('lands every target post with the leaf default status=draft (kernel source has no status column)', async () => {
    const sql = await freshTarget()
    const res = await runBackfill({
      tenant: TENANT.slug,
      tenantId: TENANT.id,
      sourcePgUrl: TEST_PG_URL,
      sourceDbName: SOURCE_DB,
      verifyOnly: false,
      pgUrl: TEST_PG_URL,
      dbPrefix: TEST_DB_PREFIX,
      log: () => {},
    })

    // The kernel source carries no posts.status; the leaf DEFAULT 'draft' fills
    // it for all three copied posts.
    const rows = await sql<{ status: string; c: number }[]>`
      SELECT status, COUNT(*)::int AS c FROM content.posts GROUP BY status ORDER BY status
    `
    expect(rows).toEqual([{ status: 'draft', c: 3 }])
    // The result histogram reflects the TARGET distribution (there is no source
    // side to compare — the kernel source has no status column).
    expect(res.histogram.pg).toEqual({ draft: 3 })
  })

  it('refuses a NON-EMPTY target unless --verify-only', async () => {
    // First backfill populates the target.
    await runBackfill({
      tenant: TENANT.slug,
      tenantId: TENANT.id,
      sourcePgUrl: TEST_PG_URL,
      sourceDbName: SOURCE_DB,
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
        sourcePgUrl: TEST_PG_URL,
        sourceDbName: SOURCE_DB,
        verifyOnly: false,
        pgUrl: TEST_PG_URL,
        dbPrefix: TEST_DB_PREFIX,
        log: () => {},
      }),
    ).rejects.toThrow(/non-empty|not empty|already/i)
  })

  it('refuses when source and target resolve to the SAME database (before any copy)', async () => {
    await freshTarget()
    // Point the source at the TARGET's own leaf DB (content_test_<slug>) on the
    // same server → source and target resolve to the identical database → must
    // refuse BEFORE copying (a DB into itself is never a valid backfill).
    const targetDbName = TEST_DB_PREFIX + TENANT.slug
    await expect(
      runBackfill({
        tenant: TENANT.slug,
        tenantId: TENANT.id,
        sourcePgUrl: TEST_PG_URL,
        sourceDbName: targetDbName,
        verifyOnly: false,
        pgUrl: TEST_PG_URL,
        dbPrefix: TEST_DB_PREFIX,
        log: () => {},
      }),
    ).rejects.toThrow(/same database|source and target/i)
  })

  it('is idempotent in --verify-only mode against a correctly-backfilled target', async () => {
    await runBackfill({
      tenant: TENANT.slug,
      tenantId: TENANT.id,
      sourcePgUrl: TEST_PG_URL,
      sourceDbName: SOURCE_DB,
      verifyOnly: false,
      pgUrl: TEST_PG_URL,
      dbPrefix: TEST_DB_PREFIX,
      log: () => {},
    })
    const logs: string[] = []
    const res = await runBackfill({
      tenant: TENANT.slug,
      tenantId: TENANT.id,
      sourcePgUrl: TEST_PG_URL,
      sourceDbName: SOURCE_DB,
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
      sourcePgUrl: TEST_PG_URL,
      sourceDbName: SOURCE_DB,
      verifyOnly: false,
      pgUrl: TEST_PG_URL,
      dbPrefix: TEST_DB_PREFIX,
      log: () => {},
    })
    // Tamper: change one member email so the checksum diverges (count stays equal).
    await sql`UPDATE content.mailing_list_members SET email = 'tampered@example.org' WHERE id = ${MEMBER_A}`

    const logs: string[] = []
    await expect(
      runBackfill({
        tenant: TENANT.slug,
        tenantId: TENANT.id,
        sourcePgUrl: TEST_PG_URL,
        sourceDbName: SOURCE_DB,
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
      sourcePgUrl: TEST_PG_URL,
      sourceDbName: SOURCE_DB,
      verifyOnly: false,
      pgUrl: TEST_PG_URL,
      dbPrefix: TEST_DB_PREFIX,
      log: () => {},
    })
    await sql`DELETE FROM content.send_tokens WHERE token = 'live-tok-bbb'`
    await expect(
      runBackfill({
        tenant: TENANT.slug,
        tenantId: TENANT.id,
        sourcePgUrl: TEST_PG_URL,
        sourceDbName: SOURCE_DB,
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
      env: { ...process.env, CONTENT_TEST_PG_URL: TEST_PG_URL },
      shell: process.platform === 'win32',
    })
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
  }

  it('--verify-only against a correctly-backfilled target → exit 0 + BACKFILL OK', async () => {
    await freshTarget()
    await runBackfill({
      tenant: TENANT.slug,
      tenantId: TENANT.id,
      sourcePgUrl: TEST_PG_URL,
      sourceDbName: SOURCE_DB,
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
      '--source-pg-url', TEST_PG_URL,
      '--source-db', SOURCE_DB,
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
      sourcePgUrl: TEST_PG_URL,
      sourceDbName: SOURCE_DB,
      verifyOnly: false,
      pgUrl: TEST_PG_URL,
      dbPrefix: TEST_DB_PREFIX,
      log: () => {},
    })
    await sql`UPDATE content.unsubscribes SET email = 'evil@example.org' WHERE email = 'gone@example.org'`
    await _resetTenantStoreForTests()

    const r = runCli([
      '--tenant', TENANT.slug,
      '--tenant-id', TENANT.id,
      '--source-pg-url', TEST_PG_URL,
      '--source-db', SOURCE_DB,
      '--verify-only',
      '--pg-url', TEST_PG_URL,
      '--db-prefix', TEST_DB_PREFIX,
    ])
    expect(r.status).toBe(1)
    expect(r.stdout + r.stderr).toMatch(/unsubscribes/)
    expect(r.stdout + r.stderr).not.toContain('BACKFILL OK')
  })
})
