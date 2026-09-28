/**
 * tenant-store control-DB init retry guard — CALENDAR leaf.
 *
 * Sibling of services/finance/test/tenant-store.init-retry.test.ts. The calendar
 * leaf carries a byte-identical `ensureControlDb` seam, so it carries the
 * identical failure mode; the fix was applied here too but arrived unguarded.
 * This file closes that gap.
 *
 * INCIDENT (2026-07-28/29, staging): `gremion-finance-service-1` booted at
 * 16:25:12Z while its Postgres was still replaying WAL. The very first
 * control-DB init lost the race and rejected with PostgresError 57P03
 * ("the database system is starting up"). Because `ensureControlDb` cached the
 * *promise* — not the *result* — with no `.catch()` and no reset on rejection,
 * that single rejected promise was replayed to every subsequent caller for the
 * next ~13 hours. The container kept reporting HEALTHY (the `/healthz` probe
 * never touches PG) while every tenant request 500'd.
 *
 * POST-CONDITIONS pinned here (assert behaviour, never an exit code):
 *   1. RETRY — an init that rejects once and would succeed on a retry MUST
 *      yield a WORKING handle on the next call. A rejection must never be
 *      cached and replayed.
 *   2. NO THUNDERING HERD — concurrent callers arriving during a single
 *      healthy init MUST share ONE in-flight init (exactly one control pool
 *      opened), not stampede the database with N inits.
 *   3. The retry must be durable across repeated failures — two consecutive
 *      failures still recover on the third call.
 *   4. NO STRANDED POOL — because retry is now possible, a control pool opened
 *      by an attempt that then fails MUST be drained before the rejection
 *      propagates, or every retry strands another pool.
 *
 * These are pure unit tests: the `postgres` driver is mocked, so no PG is
 * required and nothing here can reach the live staging database.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── mock control state (hoisted so the vi.mock factory can read it) ───────────

const h = vi.hoisted(() => ({
  /** Number of upcoming queries that should reject before any succeed. */
  failNextQueries: 0,
  /** Reject the next query whose text matches this pattern (one-shot). */
  failOnPattern: null as null | RegExp,
  /** URLs passed to the postgres() factory, in order (pool-open log). */
  factoryUrls: [] as string[],
  /** URLs whose pool had .end() called on it, in order (pool-drain log). */
  endedUrls: [] as string[],
  /** Gate that lets a test hold an in-flight init open. */
  gate: null as null | Promise<void>,
}))

/** A faithful stand-in for the real `PostgresError` 57P03 the incident threw. */
function startingUpError(): Error & { code: string; severity: string } {
  const err = new Error('the database system is starting up') as Error & {
    code: string
    severity: string
  }
  err.code = '57P03'
  err.severity = 'FATAL'
  return err
}

vi.mock('postgres', () => {
  const factory = (url: string, _opts?: unknown) => {
    h.factoryUrls.push(url)

    const run = async (text: string): Promise<unknown[]> => {
      if (h.gate !== null) await h.gate
      if (h.failNextQueries > 0) {
        h.failNextQueries -= 1
        throw startingUpError()
      }
      if (h.failOnPattern !== null && h.failOnPattern.test(text)) {
        h.failOnPattern = null
        throw startingUpError()
      }
      if (/pg_database/i.test(text)) return [{ count: '1' }]
      if (/tenant_catalog/i.test(text)) {
        return [
          { tenant_id: '11111111-1111-1111-1111-111111111111', slug: 'demo' },
          { tenant_id: '22222222-2222-2222-2222-222222222222', slug: 'other' },
        ]
      }
      return []
    }

    // postgres-js instances are callable tagged templates with extra methods.
    const sql = ((strings: TemplateStringsArray | string, ...vals: unknown[]) => {
      const text = typeof strings === 'string' ? strings : strings.join(' ? ')
      void vals
      return run(text)
    }) as unknown as Record<string, unknown> & ((...a: unknown[]) => Promise<unknown[]>)

    sql.unsafe = (text: string, _params?: unknown[]) => run(text)
    sql.end = () => {
      h.endedUrls.push(url)
      return Promise.resolve()
    }
    sql.begin = async (fn: (tx: unknown) => Promise<unknown>) => fn(sql)
    return sql
  }
  return { default: factory }
})

// Imported AFTER vi.mock so the mocked driver is in place.
const { listTenants, _resetTenantStoreForTests } = await import('../src/tenant-store.ts')

const DB_PREFIX = 'calendar_test_'
const CONTROL_DB = DB_PREFIX + 'control'

const TEST_OPTS = {
  // Never port 5432 — that is the LIVE kernel Postgres on the staging host.
  // The driver is mocked anyway, so nothing is dialled.
  pgUrl: 'postgres://u:p@127.0.0.1:59999/postgres',
  dbPrefix: DB_PREFIX,
} as const

/** The CREATE TABLE the control-DB init issues after opening the control pool. */
const CONTROL_DDL = /CREATE TABLE IF NOT EXISTS tenant_catalog/i

const controlOpens = () => h.factoryUrls.filter((u) => u.includes(CONTROL_DB)).length
const controlEnds = () => h.endedUrls.filter((u) => u.includes(CONTROL_DB)).length

beforeEach(async () => {
  await _resetTenantStoreForTests()
  h.failNextQueries = 0
  h.failOnPattern = null
  h.factoryUrls = []
  h.endedUrls = []
  h.gate = null
})

describe('ensureControlDb — a failed init must be retried, never cached', () => {
  it('yields a WORKING handle on the second call after the first init rejects', async () => {
    // Arrange: the first query of the first init loses the boot race, exactly
    // as the finance leaf's Postgres did at 2026-07-28T16:25:12Z.
    h.failNextQueries = 1

    // Act 1 — the doomed init. It MUST reject (we are not suppressing errors).
    await expect(listTenants({ ...TEST_OPTS })).rejects.toThrow(/starting up/)

    // Act 2 — Postgres is now up. A retry must actually reach the database.
    const tenants = await listTenants({ ...TEST_OPTS })

    // Assert the POST-CONDITION: a real, usable result — not a replayed
    // rejection. Under the pre-fix code this call rejects with the *same*
    // 57P03 error object forever.
    expect(tenants).toEqual([
      { id: '11111111-1111-1111-1111-111111111111', slug: 'demo' },
      { id: '22222222-2222-2222-2222-222222222222', slug: 'other' },
    ])
  })

  it('recovers even after two consecutive failed inits', async () => {
    h.failNextQueries = 1
    await expect(listTenants({ ...TEST_OPTS })).rejects.toThrow(/starting up/)

    h.failNextQueries = 1
    await expect(listTenants({ ...TEST_OPTS })).rejects.toThrow(/starting up/)

    const tenants = await listTenants({ ...TEST_OPTS })
    expect(tenants.map((t) => t.slug)).toEqual(['demo', 'other'])
  })

  it('does not leak the rejected init into a later healthy call chain', async () => {
    h.failNextQueries = 1
    await expect(listTenants({ ...TEST_OPTS })).rejects.toThrow(/starting up/)

    // Three sequential healthy calls must ALL succeed.
    for (let i = 0; i < 3; i += 1) {
      const tenants = await listTenants({ ...TEST_OPTS })
      expect(tenants).toHaveLength(2)
    }
  })

  it('retries when the failure lands on the control-DB DDL, not just the admin probe', async () => {
    // The incident's 57P03 could land at ANY step of the init. Pin the later
    // step too: the control pool is already open when this one throws.
    h.failOnPattern = CONTROL_DDL
    await expect(listTenants({ ...TEST_OPTS })).rejects.toThrow(/starting up/)

    const tenants = await listTenants({ ...TEST_OPTS })
    expect(tenants).toHaveLength(2)
  })
})

describe('ensureControlDb — a failed attempt must not strand its control pool', () => {
  it('drains the control pool opened by an attempt that then fails', async () => {
    h.failOnPattern = CONTROL_DDL
    await expect(listTenants({ ...TEST_OPTS })).rejects.toThrow(/starting up/)

    // POST-CONDITION: the one control pool this attempt opened was drained.
    // Without the drain, retry (which the fix above enables) leaks a pool per
    // attempt — a slow-burn connection exhaustion behind the recovered service.
    expect(controlOpens(), `pools opened: ${h.factoryUrls.join(', ')}`).toBe(1)
    expect(controlEnds(), `pools ended: ${h.endedUrls.join(', ')}`).toBe(1)
  })

  it('leaves the LIVE control pool open once an init finally succeeds', async () => {
    h.failOnPattern = CONTROL_DDL
    await expect(listTenants({ ...TEST_OPTS })).rejects.toThrow(/starting up/)
    await listTenants({ ...TEST_OPTS })

    // Two attempts → two control pools opened; only the FAILED one is drained.
    expect(controlOpens()).toBe(2)
    expect(controlEnds()).toBe(1)
  })
})

describe('ensureControlDb — concurrent callers share one in-flight init', () => {
  it('opens exactly one control pool for N concurrent callers (no thundering herd)', async () => {
    // Hold every query open so all callers pile up on the SAME in-flight init.
    let release!: () => void
    h.gate = new Promise<void>((res) => {
      release = res
    })

    const inFlight = [
      listTenants({ ...TEST_OPTS }),
      listTenants({ ...TEST_OPTS }),
      listTenants({ ...TEST_OPTS }),
      listTenants({ ...TEST_OPTS }),
      listTenants({ ...TEST_OPTS }),
    ]

    release()
    h.gate = null
    const results = await Promise.all(inFlight)

    for (const r of results) expect(r).toHaveLength(2)

    // POST-CONDITION: one control pool for the whole burst. A per-caller init
    // would open 5.
    expect(controlOpens(), `control pools opened: ${h.factoryUrls.join(', ')}`).toBe(1)
  })

  it('still shares one init when the burst arrives during a FAILING init', async () => {
    // All five callers must observe the failure...
    h.failNextQueries = 1
    let release!: () => void
    h.gate = new Promise<void>((res) => {
      release = res
    })

    const inFlight = Array.from({ length: 5 }, () =>
      listTenants({ ...TEST_OPTS }).then(
        () => 'ok' as const,
        () => 'err' as const,
      ),
    )
    release()
    h.gate = null
    const outcomes = await Promise.all(inFlight)
    expect(outcomes.every((o) => o === 'err')).toBe(true)

    // ...and the NEXT caller must still recover.
    const tenants = await listTenants({ ...TEST_OPTS })
    expect(tenants).toHaveLength(2)
  })
})
