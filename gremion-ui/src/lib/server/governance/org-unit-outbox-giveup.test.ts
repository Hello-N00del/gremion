// org-unit-outbox-giveup.test.ts
//
// Two properties of drainOutbox that the NOT DRAINING signal alone cannot give:
//
// 1. GIVING UP IS LOUD. A row whose first failure is older than
//    GIVE_UP_AFTER_SECONDS is no longer fetched. The NOT DRAINING clock is in
//    memory and only arms on a failed pass, so after a redeploy (the normal fix
//    for a stream that rejected the subject) every pass reports {0, 0}, nothing
//    re-arms, and the tenant's finance mirror stays permanently behind in silence.
//    drainOutbox therefore checks - cheaply, throttled per tenant, and on the
//    first pass after a boot - for rows that have been given up on, and names them.
//
// 2. THE ROOT CAUSE SURVIVES. If marking a row fails inside the drain transaction,
//    the transaction is already aborted; running the "mark failed" fallback on it
//    only produces "current transaction is aborted" and buries the real error.
//
// Plus a compile-time guard: drainOutbox needs a pool (`Sql`) because it opens its
// own transaction; a TransactionSql has no `begin`.

import { describe, it, expect, beforeEach } from 'vitest'
import type { TransactionSql } from 'postgres'
import {
  drainOutbox,
  ABANDONED_CHECK_INTERVAL_MS,
  _resetNotDrainingSignalForTests,
  type OrgUnitOutboxRow,
} from './org-unit-event-outbox'

const TENANT_A = 'a0000000-0000-4000-8000-00000000000a'
const TENANT_B = 'b0000000-0000-4000-8000-00000000000b'
const UNIT_1 = 'c0000000-0000-4000-8000-0000000000c1'
const UNIT_2 = 'c0000000-0000-4000-8000-0000000000c2'

let clock = 5_000_000
const errors: string[] = []
const deps = { now: (): number => clock, error: (m: string): void => void errors.push(m) }

interface Plan {
  /** Rows the DUE query returns. */
  due: Array<Record<string, unknown>>
  /** Aggregate ids the ABANDONED query returns. */
  abandoned: string[]
  abandonedThrows?: Error
  markOkThrows?: Error
  markFailedThrows?: Error
}

function fakeSql(plan: Plan): { sql: never; statements: string[] } {
  const statements: string[] = []
  const tag = (strings: TemplateStringsArray): Promise<unknown[]> => {
    const text = strings.join(' ? ')
    statements.push(text.replace(/\s+/g, ' ').trim())
    if (text.includes('SELECT aggregate_id')) {
      if (plan.abandonedThrows) return Promise.reject(plan.abandonedThrows)
      return Promise.resolve(plan.abandoned.map((aggregate_id) => ({ aggregate_id })))
    }
    if (text.includes('SELECT id, event_id')) return Promise.resolve(plan.due)
    if (text.includes("SET status = 'ok'")) {
      return plan.markOkThrows ? Promise.reject(plan.markOkThrows) : Promise.resolve([])
    }
    if (text.includes("SET status = 'failed'")) {
      return plan.markFailedThrows ? Promise.reject(plan.markFailedThrows) : Promise.resolve([])
    }
    return Promise.resolve([])
  }
  ;(tag as unknown as { begin: unknown }).begin = async (cb: (tx: unknown) => Promise<void>) => {
    await cb(tag)
  }
  return { sql: tag as never, statements }
}

const publishes = (_r: OrgUnitOutboxRow): Promise<void> => Promise.resolve()
const abandonedQueries = (statements: string[]): number =>
  statements.filter((s) => s.includes('SELECT aggregate_id')).length

beforeEach(() => {
  _resetNotDrainingSignalForTests()
  errors.length = 0
  clock = 5_000_000
})

describe('drainOutbox names rows it has given up on', () => {
  it('reports aged-out rows on the first pass after a boot, although nothing is due and nothing failed', async () => {
    const { sql } = fakeSql({ due: [], abandoned: [UNIT_1, UNIT_2] })

    const res = await drainOutbox(sql, TENANT_A, publishes, 100, deps)

    expect(res).toEqual({ ok: 0, failed: 0 })
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('GAVE UP')
    expect(errors[0]).toContain(TENANT_A)
    expect(errors[0]).toContain(UNIT_1)
    expect(errors[0]).toContain(UNIT_2)
    expect(errors[0]).toContain('org_unit_mirror')
  })

  it('stays silent when no row has been given up on', async () => {
    const { sql } = fakeSql({ due: [], abandoned: [] })
    await drainOutbox(sql, TENANT_A, publishes, 100, deps)
    expect(errors).toEqual([])
  })

  it('checks at most once per interval per tenant, then again after it', async () => {
    const { sql, statements } = fakeSql({ due: [], abandoned: [UNIT_1] })

    for (let i = 0; i < 20; i += 1) {
      await drainOutbox(sql, TENANT_A, publishes, 100, deps)
      clock += 5_000
    }
    expect(abandonedQueries(statements), 'a query per 5s tick would be the hot-path cost the design avoids').toBe(1)
    expect(errors).toHaveLength(1)

    clock += ABANDONED_CHECK_INTERVAL_MS
    await drainOutbox(sql, TENANT_A, publishes, 100, deps)
    expect(abandonedQueries(statements)).toBe(2)
    expect(errors, 'a mirror that is still permanently behind keeps being named, once per interval').toHaveLength(2)
  })

  it('is per tenant: one tenant being checked does not hide another', async () => {
    const a = fakeSql({ due: [], abandoned: [UNIT_1] })
    const b = fakeSql({ due: [], abandoned: [UNIT_2] })
    await drainOutbox(a.sql, TENANT_A, publishes, 100, deps)
    await drainOutbox(b.sql, TENANT_B, publishes, 100, deps)
    expect(errors).toHaveLength(2)
    expect(errors[0]).toContain(TENANT_A)
    expect(errors[1]).toContain(TENANT_B)
  })

  it('a failing check never fails the drain, and says so', async () => {
    const { sql } = fakeSql({ due: [], abandoned: [], abandonedThrows: new Error('statement timeout') })
    await expect(drainOutbox(sql, TENANT_A, publishes, 100, deps)).resolves.toEqual({ ok: 0, failed: 0 })
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('statement timeout')
  })
})

describe('drainOutbox keeps the root cause when the bookkeeping itself fails', () => {
  const dueRow = {
    id: '1',
    event_id: 'e1',
    event_type: 'upserted',
    aggregate_id: UNIT_1,
    payload: {},
    correlation_id: null,
    occurred_at: new Date(0),
    status: 'pending',
    attempts: 0,
  }

  it('a failing "mark ok" surfaces as itself, not as the aborted-transaction error from the fallback', async () => {
    const root = new Error('lock timeout while marking the row')
    const { sql } = fakeSql({
      due: [dueRow],
      abandoned: [],
      markOkThrows: root,
      markFailedThrows: new Error('current transaction is aborted, commands ignored until end of transaction block'),
    })

    await expect(drainOutbox(sql, TENANT_A, publishes, 100, deps)).rejects.toBe(root)
  })

  it('a failing "mark failed" after a publish failure still reports the publish error', async () => {
    const { sql } = fakeSql({
      due: [dueRow],
      abandoned: [],
      markFailedThrows: new Error('connection terminated unexpectedly'),
    })
    const publish = (): Promise<void> => Promise.reject(new Error('no stream matches subject'))

    const err = await drainOutbox(sql, TENANT_A, publish, 100, deps).then(
      () => null,
      (e: unknown) => e as Error,
    )
    expect(err).toBeInstanceOf(Error)
    expect(err!.message).toContain('no stream matches subject')
    expect(err!.message).toContain('connection terminated unexpectedly')
  })
})

describe('drainOutbox only accepts a pool', () => {
  it('rejects a TransactionSql at compile time (it has no begin)', () => {
    // Never executed: this exists so svelte-check fails if the parameter is ever
    // widened back to a type a transaction satisfies.
    const neverCalled = (tx: TransactionSql<{}>): Promise<unknown> =>
      // @ts-expect-error a TransactionSql has no `begin`, so drainOutbox must not accept it
      drainOutbox(tx, TENANT_A, publishes)
    expect(typeof neverCalled).toBe('function')
  })
})
