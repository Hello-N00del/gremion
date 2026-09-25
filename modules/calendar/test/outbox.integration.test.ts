/**
 * Integration tests for services/calendar/src/outbox.ts
 *
 * Covers:
 *  - enqueueOutbox: tx-co-committed (row visible after commit, not before rollback)
 *  - fetchDueRows: pending + failed-with-due-retry appear; ok + terminal-failed do not
 *  - markOutboxOk: reset-on-recovery (clears first_failed_at, attempts)
 *  - markOutboxFailed: backoff expression, first_failed_at set on first failure
 *  - drainOutbox: end-to-end publish callback + ok/failed counts
 *  - terminal: row past GIVE_UP_AFTER_SECONDS is NOT returned by fetchDueRows
 *
 * Fail-closed guard: mirrors store.integration.test.ts pattern (localhost + calendar_test_ prefix).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import { storeFor, _resetTenantStoreForTests, type TenantRef } from '../src/tenant-store.ts'
import {
  enqueueOutbox,
  fetchDueRows,
  markOutboxOk,
  markOutboxFailed,
  drainOutbox,
  GIVE_UP_AFTER_SECONDS,
} from '../src/outbox.ts'
import { requireEphemeralTestPgUrl, assertSafeTestEnv } from './support/pg-test-guard.ts'

// ── fail-closed guard ─────────────────────────────────────────────────────────
const TEST_PG_URL = requireEphemeralTestPgUrl()
const TEST_DB_PREFIX = 'calendar_test_'
assertSafeTestEnv(TEST_PG_URL, TEST_DB_PREFIX)

// ── test tenant ───────────────────────────────────────────────────────────────
const OUTBOX_TENANT: TenantRef = {
  id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
  slug: 'outboxtest',
}

// ── helpers ───────────────────────────────────────────────────────────────────
let admin: ReturnType<typeof postgres>
let sql: Awaited<ReturnType<typeof storeFor>>

async function dropTestDbs(pgSql: ReturnType<typeof postgres>): Promise<void> {
  const rows = await pgSql<{ datname: string }[]>`
    SELECT datname FROM pg_database
    WHERE datname LIKE 'calendar_test_%'
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
  sql = await storeFor(OUTBOX_TENANT, { pgUrl: TEST_PG_URL, dbPrefix: TEST_DB_PREFIX })
})

afterAll(async () => {
  await _resetTenantStoreForTests()
  await dropTestDbs(admin)
  await admin.end()
})

beforeEach(async () => {
  await sql`DELETE FROM outbox`
})

// ── enqueueOutbox ──────────────────────────────────────────────────────────────
describe('enqueueOutbox', () => {
  it('returns a uuid and inserts a pending row co-committed with the transaction', async () => {
    let id!: string
    await sql.begin(async (tx) => {
      id = await enqueueOutbox(tx as never, 'event.created', { eventDbId: 1 }, 'corr-1')
    })
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    )
    const rows = await sql<{ status: string; event_type: string; correlation_id: string }[]>`
      SELECT status, event_type, correlation_id FROM outbox WHERE id = ${id}
    `
    expect(rows).toHaveLength(1)
    expect(rows[0]!.status).toBe('pending')
    expect(rows[0]!.event_type).toBe('event.created')
    expect(rows[0]!.correlation_id).toBe('corr-1')
  })

  it('row is NOT visible before transaction commits (rollback test)', async () => {
    let id!: string
    await sql.begin(async (tx) => {
      id = await enqueueOutbox(tx as never, 'event.deleted', { error: 'oops' })
      // Simulate rollback by throwing inside the transaction.
      throw new Error('intentional rollback')
    }).catch(() => {})
    // After rollback, the row must not exist.
    const rows = await sql<{ id: string }[]>`SELECT id FROM outbox WHERE id = ${id}`
    expect(rows).toHaveLength(0)
  })

  it('enqueues with null correlation_id when not provided', async () => {
    let id!: string
    await sql.begin(async (tx) => {
      id = await enqueueOutbox(tx as never, 'event.created', {})
    })
    const rows = await sql<{ correlation_id: string | null }[]>`
      SELECT correlation_id FROM outbox WHERE id = ${id}
    `
    expect(rows[0]!.correlation_id).toBeNull()
  })
})

// ── fetchDueRows ──────────────────────────────────────────────────────────────
describe('fetchDueRows', () => {
  it('returns pending rows', async () => {
    await sql.begin(async (tx) => {
      await enqueueOutbox(tx as never, 'event.created', { n: 1 })
    })
    await sql.begin(async (tx) => {
      const rows = await fetchDueRows(tx as never)
      expect(rows).toHaveLength(1)
      expect(rows[0]!.status).toBe('pending')
    })
  })

  it('returns failed rows whose next_attempt_at has passed', async () => {
    let id!: string
    await sql.begin(async (tx) => {
      id = await enqueueOutbox(tx as never, 'caldav.sync.failed', { n: 2 })
    })
    // Manually age the row to look like a failed retry that is now due.
    await sql`
      UPDATE outbox SET
        status = 'failed',
        attempts = 1,
        first_failed_at = now() - interval '1 minute',
        next_attempt_at = now() - interval '1 second'
      WHERE id = ${id}
    `
    await sql.begin(async (tx) => {
      const rows = await fetchDueRows(tx as never)
      expect(rows.some((r) => r.id === id)).toBe(true)
    })
  })

  it('does NOT return failed rows whose next_attempt_at is in the future', async () => {
    let id!: string
    await sql.begin(async (tx) => {
      id = await enqueueOutbox(tx as never, 'caldav.sync.failed', { n: 3 })
    })
    await sql`
      UPDATE outbox SET
        status = 'failed',
        next_attempt_at = now() + interval '1 hour',
        first_failed_at = now()
      WHERE id = ${id}
    `
    await sql.begin(async (tx) => {
      const rows = await fetchDueRows(tx as never)
      expect(rows.some((r) => r.id === id)).toBe(false)
    })
  })

  it('does NOT return terminal rows (first_failed_at older than GIVE_UP_AFTER_SECONDS)', async () => {
    let id!: string
    await sql.begin(async (tx) => {
      id = await enqueueOutbox(tx as never, 'caldav.sync.failed', { n: 4 })
    })
    await sql`
      UPDATE outbox SET
        status = 'failed',
        next_attempt_at = now() - interval '1 second',
        first_failed_at = now() - make_interval(secs => ${GIVE_UP_AFTER_SECONDS + 1})
      WHERE id = ${id}
    `
    await sql.begin(async (tx) => {
      const rows = await fetchDueRows(tx as never)
      expect(rows.some((r) => r.id === id)).toBe(false)
    })
  })

  it('does NOT return ok rows', async () => {
    let id!: string
    await sql.begin(async (tx) => {
      id = await enqueueOutbox(tx as never, 'event.created', { n: 5 })
    })
    await sql`UPDATE outbox SET status = 'ok' WHERE id = ${id}`
    await sql.begin(async (tx) => {
      const rows = await fetchDueRows(tx as never)
      expect(rows.some((r) => r.id === id)).toBe(false)
    })
  })
})

// ── markOutboxOk ──────────────────────────────────────────────────────────────
describe('markOutboxOk', () => {
  it('sets status=ok and clears backoff/error fields (reset-on-recovery)', async () => {
    let id!: string
    await sql.begin(async (tx) => {
      id = await enqueueOutbox(tx as never, 'event.created', {})
    })
    // Pre-populate failure state to verify reset.
    await sql`
      UPDATE outbox SET
        status = 'failed', attempts = 3, last_error = 'boom',
        first_failed_at = now() - interval '1 hour',
        next_attempt_at = now() + interval '30 minutes'
      WHERE id = ${id}
    `
    await markOutboxOk(sql, id)
    const rows = await sql<{
      status: string; attempts: number; last_error: string | null;
      first_failed_at: Date | null; next_attempt_at: Date | null
    }[]>`SELECT status, attempts, last_error, first_failed_at, next_attempt_at FROM outbox WHERE id = ${id}`
    expect(rows[0]!.status).toBe('ok')
    expect(rows[0]!.attempts).toBe(0)
    expect(rows[0]!.last_error).toBeNull()
    expect(rows[0]!.first_failed_at).toBeNull()
    expect(rows[0]!.next_attempt_at).toBeNull()
  })
})

// ── markOutboxFailed ──────────────────────────────────────────────────────────
describe('markOutboxFailed', () => {
  it('increments attempts and sets first_failed_at on first failure', async () => {
    let id!: string
    await sql.begin(async (tx) => {
      id = await enqueueOutbox(tx as never, 'caldav.sync.failed', {})
    })
    await markOutboxFailed(sql, id, 'timeout')
    const rows = await sql<{
      status: string; attempts: number; last_error: string;
      first_failed_at: Date | null; next_attempt_at: Date | null
    }[]>`SELECT status, attempts, last_error, first_failed_at, next_attempt_at FROM outbox WHERE id = ${id}`
    expect(rows[0]!.status).toBe('failed')
    expect(rows[0]!.attempts).toBe(1)
    expect(rows[0]!.last_error).toBe('timeout')
    expect(rows[0]!.first_failed_at).not.toBeNull()
    // next_attempt_at must be in the future.
    expect(rows[0]!.next_attempt_at!.getTime()).toBeGreaterThan(Date.now())
  })

  it('does NOT overwrite first_failed_at on subsequent failures', async () => {
    let id!: string
    await sql.begin(async (tx) => {
      id = await enqueueOutbox(tx as never, 'caldav.sync.failed', {})
    })
    await markOutboxFailed(sql, id, 'first')
    const after1 = await sql<{ first_failed_at: Date }[]>`
      SELECT first_failed_at FROM outbox WHERE id = ${id}
    `
    const firstFailedAt = after1[0]!.first_failed_at.getTime()
    await new Promise((r) => setTimeout(r, 10))
    await markOutboxFailed(sql, id, 'second')
    const after2 = await sql<{ first_failed_at: Date }[]>`
      SELECT first_failed_at FROM outbox WHERE id = ${id}
    `
    expect(after2[0]!.first_failed_at.getTime()).toBe(firstFailedAt)
  })

  it('truncates last_error to 2000 chars', async () => {
    let id!: string
    await sql.begin(async (tx) => {
      id = await enqueueOutbox(tx as never, 'caldav.sync.failed', {})
    })
    await markOutboxFailed(sql, id, 'x'.repeat(3000))
    const rows = await sql<{ last_error: string }[]>`SELECT last_error FROM outbox WHERE id = ${id}`
    expect(rows[0]!.last_error.length).toBe(2000)
  })
})

// ── drainOutbox ───────────────────────────────────────────────────────────────
describe('drainOutbox', () => {
  it('calls publishFn for each due row and returns ok count', async () => {
    await sql.begin(async (tx) => {
      await enqueueOutbox(tx as never, 'event.created', { a: 1 })
      await enqueueOutbox(tx as never, 'caldav.sync.failed', { b: 2 })
    })
    const published: string[] = []
    const result = await drainOutbox(sql, async (row) => {
      published.push(row.event_type)
    })
    expect(result.ok).toBe(2)
    expect(result.failed).toBe(0)
    expect(published.sort()).toEqual(['caldav.sync.failed', 'event.created'])
    // Rows must now be marked ok.
    const rows = await sql<{ status: string }[]>`SELECT status FROM outbox`
    expect(rows.every((r) => r.status === 'ok')).toBe(true)
  })

  it('marks rows failed when publishFn throws, backoff applied', async () => {
    await sql.begin(async (tx) => {
      await enqueueOutbox(tx as never, 'event.created', {})
    })
    const result = await drainOutbox(sql, async () => {
      throw new Error('broker down')
    })
    expect(result.ok).toBe(0)
    expect(result.failed).toBe(1)
    const rows = await sql<{ status: string; last_error: string; attempts: number }[]>`
      SELECT status, last_error, attempts FROM outbox
    `
    expect(rows[0]!.status).toBe('failed')
    expect(rows[0]!.last_error).toContain('broker down')
    expect(rows[0]!.attempts).toBe(1)
  })

  it('returns {ok:0, failed:0} when no due rows', async () => {
    const result = await drainOutbox(sql, async () => {})
    expect(result).toEqual({ ok: 0, failed: 0 })
  })
})
