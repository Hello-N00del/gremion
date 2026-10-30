// org-unit-outbox-drain-seam.test.ts
//
// THE PRODUCTION SEAM, driven end to end: drainOutbox → the publisher → the
// row backoff → recordDrainOutcome → the NOT DRAINING line.
//
// Round 4 tested only recordDrainOutcome, called directly with hand-written
// outcome objects. Everything BETWEEN a failing broker and that call was
// unguarded: the wiring in drainOutbox, and the `undelivered` count it fed in —
// an unindexable `status <> 'ok' AND first_failed_at …` count(*) inside the
// drain transaction, once per tenant every 5 seconds, on a table nothing purges.
// Inverting that WHERE clause kept every gate green.
//
// So the query is gone (round 5) and the owed state is derived from the drain
// outcomes the relay already observes, which is a thing a test can actually
// drive. These tests drive it: a `sql` double that models the two operations
// the drain really performs — fetch the DUE rows, mark a row failed with a 60s
// next_attempt_at — against a clock the test advances at the relay's 5s
// cadence. That is the exact rhythm production runs at, and the exact rhythm
// the round-4 signal could not survive.

import { describe, it, expect, beforeEach } from 'vitest'
import type { SqlRunner } from '$lib/server/db/tx'
import {
  drainOutbox,
  ORG_UNIT_RELAY_INTERVAL_MS,
  NOT_DRAINING_WINDOW_MS,
  NOT_DRAINING_LOG_INTERVAL_MS,
  _resetNotDrainingSignalForTests,
  type OrgUnitOutboxRow,
} from './org-unit-event-outbox'

const STUCK = 'a0000000-0000-4000-8000-00000000000a'
const HEALTHY = 'b0000000-0000-4000-8000-00000000000b'

/** markOutboxFailed's first backoff step: now() + 30 * 2^1 seconds. */
const ROW_BACKOFF_MS = 60_000

let clock = 1_000_000
const errors: string[] = []
const deps = { now: (): number => clock, error: (m: string): void => void errors.push(m) }

interface FakeRow {
  id: string
  nextAttemptAt: number
  status: 'pending' | 'ok' | 'failed'
}

/**
 * A `sql` double shaped like the real runner: a tagged template that answers by
 * statement, plus `begin`. It models the two things the drain does to a row and
 * nothing else — which is the point: the fixed signal needs no third query.
 */
function fakeSql(rows: FakeRow[]): {
  sql: SqlRunner
  statements: string[]
  failBegin?: boolean
} {
  const statements: string[] = []
  const tag = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const text = strings.join(' ? ')
    statements.push(text.replace(/\s+/g, ' ').trim().slice(0, 60))
    if (text.includes('SELECT') && text.includes('FROM org_unit_event_outbox')) {
      return Promise.resolve(
        rows.filter((r) => r.status !== 'ok' && r.nextAttemptAt <= clock) as unknown[],
      )
    }
    if (text.includes("SET status = 'ok'")) {
      const id = String(values[0])
      const row = rows.find((r) => r.id === id)
      if (row) row.status = 'ok'
      return Promise.resolve([])
    }
    if (text.includes("SET status = 'failed'")) {
      const id = String(values[values.length - 1])
      const row = rows.find((r) => r.id === id)
      if (row) {
        row.status = 'failed'
        row.nextAttemptAt = clock + ROW_BACKOFF_MS
      }
      return Promise.resolve([])
    }
    return Promise.resolve([])
  }
  ;(tag as unknown as { begin: unknown }).begin = async (
    cb: (tx: SqlRunner) => Promise<void>,
  ): Promise<void> => {
    await cb(tag as unknown as SqlRunner)
  }
  return { sql: tag as unknown as SqlRunner, statements }
}

const row = (id: string): FakeRow => ({ id, nextAttemptAt: 0, status: 'pending' })

/** The relay's publisher, as a broker still bound to the retired wire root behaves. */
const alwaysThrows = (): Promise<void> =>
  Promise.reject(new Error('no stream matches subject gremion.…org-unit.upserted'))
const alwaysPublishes = (_r: OrgUnitOutboxRow): Promise<void> => Promise.resolve()

beforeEach(() => {
  _resetNotDrainingSignalForTests()
  errors.length = 0
  clock = 1_000_000
})

describe('drainOutbox → the NOT DRAINING signal, through the real seam', () => {
  it('names the stuck tenant within the documented window, across the 60s row backoff', async () => {
    const { sql } = fakeSql([row('r1')])
    const started = clock

    // The relay's own cadence, run until the line appears or the window is
    // comfortably past. Pass 1 tries the row and fails it (next_attempt_at =
    // +60s); passes 2..n find nothing DUE — which is the backoff, not health.
    for (let i = 0; i < 12 && errors.length === 0; i += 1) {
      await drainOutbox(sql, STUCK, alwaysThrows, 100, deps)
      if (errors.length === 0) clock += ORG_UNIT_RELAY_INTERVAL_MS
    }

    expect(errors, 'the seam must produce the line, not just recordDrainOutcome in isolation').toHaveLength(1)
    expect(errors[0]).toContain('NOT DRAINING')
    expect(errors[0]).toContain(STUCK)
    expect(errors[0]).toContain('last_error')
    expect(errors[0]).not.toContain('nats:migrate-streams')
    expect(
      clock - started,
      'the operator is promised the line inside NOT_DRAINING_WINDOW_MS',
    ).toBeLessThanOrEqual(NOT_DRAINING_WINDOW_MS)
  })

  it('never fires for a healthy tenant draining on the same ticks', async () => {
    const stuck = fakeSql([row('s1')])
    const healthy = fakeSql([row('h1')])

    for (let i = 0; i < 12; i += 1) {
      await drainOutbox(stuck.sql, STUCK, alwaysThrows, 100, deps)
      await drainOutbox(healthy.sql, HEALTHY, alwaysPublishes, 100, deps)
      clock += ORG_UNIT_RELAY_INTERVAL_MS
    }

    expect(errors.filter((e) => e.includes(HEALTHY))).toHaveLength(0)
    expect(errors.filter((e) => e.includes(STUCK)).length).toBeGreaterThan(0)
  })

  it('goes quiet the moment the broker recovers and the backed-off row goes out', async () => {
    const { sql } = fakeSql([row('r1')])
    let broken = true
    const publish = (): Promise<void> =>
      broken ? alwaysThrows() : Promise.resolve()

    for (let i = 0; i < 12 && errors.length === 0; i += 1) {
      await drainOutbox(sql, STUCK, publish, 100, deps)
      if (errors.length === 0) clock += ORG_UNIT_RELAY_INTERVAL_MS
    }
    expect(errors).toHaveLength(1)

    // The broker comes back. The row is still inside its backoff, so the next
    // pass that actually DELIVERS is the one after it expires.
    broken = false
    clock += ROW_BACKOFF_MS
    const after = await drainOutbox(sql, STUCK, publish, 100, deps)
    expect(after.ok, 'the recovered pass must publish the backed-off row').toBe(1)

    clock += NOT_DRAINING_LOG_INTERVAL_MS * 2
    for (let i = 0; i < 12; i += 1) {
      await drainOutbox(sql, STUCK, publish, 100, deps)
      clock += ORG_UNIT_RELAY_INTERVAL_MS
    }
    expect(errors, 'a recovered relay must stop talking').toHaveLength(1)
  })

  it('does not run a count query on the drain path at all', async () => {
    const { sql, statements } = fakeSql([row('r1')])
    await drainOutbox(sql, STUCK, alwaysPublishes, 100, deps)
    expect(
      statements.filter((q) => q.includes('count(')),
      'the not-draining signal must not cost a heap scan per tenant per 5s tick',
    ).toEqual([])
  })

  it('treats a REJECTED drain transaction as a failed pass — a DB outage is the most stuck state', async () => {
    const boom = new Error('connection terminated unexpectedly')
    const sql = (() => {
      const tag = (): Promise<unknown[]> => Promise.resolve([])
      ;(tag as unknown as { begin: unknown }).begin = (): Promise<void> => Promise.reject(boom)
      return tag as unknown as SqlRunner
    })()

    for (let i = 0; i < 12 && errors.length === 0; i += 1) {
      await expect(drainOutbox(sql, STUCK, alwaysPublishes, 100, deps)).rejects.toThrow(boom)
      if (errors.length === 0) clock += ORG_UNIT_RELAY_INTERVAL_MS
    }

    expect(
      errors,
      'round 4 propagated the rejection before the outcome was ever recorded, so the one state ' +
        'that most needs the signal never armed it',
    ).toHaveLength(1)
    expect(errors[0]).toContain(STUCK)
  })

  it('an idle tenant with an empty outbox never looks stuck', async () => {
    const { sql } = fakeSql([])
    for (let i = 0; i < 40; i += 1) {
      await drainOutbox(sql, HEALTHY, alwaysPublishes, 100, deps)
      clock += ORG_UNIT_RELAY_INTERVAL_MS
    }
    expect(errors).toEqual([])
  })
})
