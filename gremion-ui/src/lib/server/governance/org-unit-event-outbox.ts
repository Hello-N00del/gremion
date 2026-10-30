// src/lib/server/governance/org-unit-event-outbox.ts
//
// The transactional outbox for kernel org-unit change events.
//  - enqueueOrgUnitEvent() is called INSIDE the same runner (tx or pool) that wrote
//    org_units, at the governance/org-units-db.ts choke point, so the outbox row
//    co-commits with the DML (never a phantom publish, never a missed publish).
//  - It is a pure NO-OP when NATS_URL is unset - the choke point then behaves
//    exactly as without an outbox (no INSERT, the table stays empty).
//  - drainOutbox() drains due rows (pending, or failed with elapsed backoff) via a
//    supplied publish callback, marking ok / failed with a capped exponential
//    backoff, the same shape the newsletter and content leaves use.
//
// The kernel owns this event: the relay publishes whether or not a consuming
// module (the finance org-unit mirror) is enabled. The stream's retention bounds
// the backlog when nothing consumes it.

import type { SqlRunner } from '$lib/server/db/tx'
import { platformEnv } from '$lib/server/env/platform-env'
import type { OrgUnitEvent } from '@gremion/ports/broker'

/** 24 hours - matches the ledger / content outbox GIVE_UP_AFTER_SECONDS. */
export const GIVE_UP_AFTER_SECONDS = 24 * 60 * 60

/** The org-unit snapshot the leaf mirror needs (payload of an 'upserted' event). A
 *  'deleted' event carries only { id }. Keys are snake_case to match the leaf
 *  consumer's parseOrgUnitOp (id / name / kind / parent_id). */
export interface OrgUnitSnapshot {
  id: string
  name: string
  kind: string
  parent_id: string | null
}

export interface OrgUnitOutboxRow {
  id: string
  event_id: string
  event_type: OrgUnitEvent
  aggregate_id: string
  payload: unknown
  correlation_id: string | null
  occurred_at: Date
  status: 'pending' | 'ok' | 'failed'
  attempts: number
  next_attempt_at: Date | null
  first_failed_at: Date | null
  last_error: string | null
  created_at: Date
}

/**
 * Enqueue one org-unit event on the SAME runner that wrote org_units (co-committed).
 * NO-OP when NATS_URL is unset. `payload` is the full snapshot for 'upserted', or
 * `{ id }` for 'deleted'.
 */
export async function enqueueOrgUnitEvent(
  sql: SqlRunner,
  args: {
    eventType: OrgUnitEvent
    aggregateId: string
    payload: Record<string, unknown>
    correlationId?: string | null
  },
): Promise<void> {
  if (!platformEnv('NATS_URL')) return
  await sql`
    INSERT INTO org_unit_event_outbox (event_type, aggregate_id, payload, correlation_id)
    VALUES (
      ${args.eventType}, ${args.aggregateId},
      ${sql.json(args.payload as Parameters<typeof sql.json>[0])}, ${args.correlationId ?? null}
    )`
}

/** Fetch due outbox rows for one drain pass (pending, or failed past its backoff and
 *  not yet terminal). FOR UPDATE SKIP LOCKED so concurrent relay workers do not
 *  double-publish. */
export async function fetchDueRows(sql: SqlRunner, limit = 100): Promise<OrgUnitOutboxRow[]> {
  return sql<OrgUnitOutboxRow[]>`
    SELECT id, event_id, event_type, aggregate_id, payload, correlation_id, occurred_at,
           status, attempts, next_attempt_at, first_failed_at, last_error, created_at
    FROM org_unit_event_outbox
    WHERE status = 'pending'
       OR (
         status = 'failed'
         AND (next_attempt_at IS NULL OR next_attempt_at <= now())
         AND (first_failed_at IS NULL OR now() - first_failed_at < make_interval(secs => ${GIVE_UP_AFTER_SECONDS}))
       )
    ORDER BY occurred_at, id
    LIMIT ${limit}
    FOR UPDATE SKIP LOCKED`
}

/** Mark a row published (clears backoff/error - reset-on-recovery). */
export async function markOutboxOk(sql: SqlRunner, id: string): Promise<void> {
  await sql`
    UPDATE org_unit_event_outbox
    SET status = 'ok', last_error = NULL, next_attempt_at = NULL, first_failed_at = NULL, attempts = 0
    WHERE id = ${id}`
}

/** Mark a row failed + schedule the next retry (capped exponential backoff). */
export async function markOutboxFailed(sql: SqlRunner, id: string, error: string): Promise<void> {
  await sql`
    UPDATE org_unit_event_outbox
    SET status = 'failed',
        last_error = ${error.slice(0, 2000)},
        attempts = attempts + 1,
        next_attempt_at = now() + make_interval(secs => LEAST(3600, 30 * power(2, LEAST(attempts + 1, 12))::int)),
        first_failed_at = COALESCE(first_failed_at, now())
    WHERE id = ${id}`
}

/**
 * Drain due rows, publishing each via publishFn, marking ok/failed. All DB mutations
 * run in the SAME read-lock transaction so the FOR UPDATE SKIP LOCKED range is held
 * for the batch. Returns per-pass ok/failed counts.
 */
export async function drainOutbox(
  sql: SqlRunner,
  tenantId: string,
  publishFn: (row: OrgUnitOutboxRow) => Promise<void>,
  limit = 100,
  signal: NotDrainingSignalDeps = {},
): Promise<{ ok: number; failed: number }> {
  let ok = 0
  let failed = 0
  try {
    await (
      sql as unknown as { begin: (cb: (tx: SqlRunner) => Promise<void>) => Promise<void> }
    ).begin(async (tx) => {
      const rows = await fetchDueRows(tx, limit)
      for (const row of rows) {
        try {
          await publishFn(row)
          await markOutboxOk(tx, row.id)
          ok++
        } catch (err) {
          await markOutboxFailed(tx, row.id, err instanceof Error ? err.message : String(err))
          failed++
        }
      }
    })
  } catch (err) {
    // A drain whose TRANSACTION rejected is the MOST stuck a tenant can be - a
    // database outage publishes nothing, marks nothing and rolls back whatever
    // this pass had done. It must arm the signal BEFORE propagating, or the one
    // state that most needs the signal is the one that never raises it. It counts
    // as a failed pass (ok = 0: the transaction rolled back, so nothing was
    // actually delivered) and THEN propagates.
    recordDrainOutcome(tenantId, { ok: 0, failed: failed + 1 }, signal)
    throw err
  }
  recordDrainOutcome(tenantId, { ok, failed }, signal)
  return { ok, failed }
}

// -- "the outbox is not draining" ---------------------------------------------
//
// Every individual failure here is already recorded on the ROW (last_error,
// attempts, next_attempt_at) and retried with capped backoff, which is why a
// single failed publish is not worth a log line - the backoff is the design
// working. What has no signal at all is the state that matters: pass after pass
// where nothing gets through. A stream that cannot be reached or that rejects the
// subject makes every publish throw, every row go back to `failed`, and the queue
// grow in silence until someone happens to query it.
//
// So the signal is on the SEQUENCE, not the event, and it is a DURATION: counting
// passes cannot see a backed-off row. markOutboxFailed sets next_attempt_at to
// now() + 30 * 2^attempts seconds (60s after the first failure) while the relay
// ticks every 5s, so the passes that FOLLOW a failure fetch zero due rows and
// report (ok 0, failed 0). A pass counter would read that as "this tenant is fine"
// and reset; the passes between a backed-off row's retries are not evidence of
// health, they ARE the backoff.
//
// It is THROTTLED, because the relay runs every 5s and an unthrottled error here
// would emit ~17k lines a day and be the reason the log is ignored.
//
// It is PER TENANT: `forEachActiveTenant` walks every tenant on every tick, so a
// process-global counter would be reset by one healthy tenant's success and the
// stuck tenant would never reach the threshold; and it could not say whose outbox
// is growing, which is the one fact the line has to carry.
//
// And the owed state is DERIVED FROM THE DRAIN OUTCOMES, not queried (a count(*)
// over a never-purged table on the hot path, once per tenant every 5 seconds, is
// a heap scan whose cost grows forever):
//   - failed > 0                -> this tenant OWES work (something was due, was
//                                  tried, and threw). Start the clock if it is
//                                  not already running.
//   - failed = 0 AND ok > 0     -> the due rows went out. CLEAR it.
//   - failed = 0 AND ok = 0     -> nothing was due. Change NOTHING: on a stuck
//                                  tenant this is the backoff window, and on an
//                                  idle one the clock was never started.
//
// The one thing this cannot do is survive a PROCESS RESTART: the map below is in
// memory, so a redeploy forgets that a tenant was owing. That is deliberate and
// bounded - the first failed pass after the restart re-arms the clock, and the
// line follows one window (15s) later.
//
// It also means a tenant whose rows have all aged out past GIVE_UP_AFTER_SECONDS
// keeps saying it is not draining (throttled to one line per 5 minutes) until
// something publishes for it. Going quiet about a mirror that is permanently
// behind is the worse of the two, but it is a real difference and it is named
// here rather than hidden.

/**
 * Passes at the relay's cadence that define the window below. Kept as the
 * documented shape of the promise ("three passes"); the firing decision is the
 * DURATION, not the count, because a count cannot see a backed-off row.
 */
export const NOT_DRAINING_THRESHOLD = 3

/**
 * The relay's own cadence. Defined HERE and imported by register.server.ts's
 * setInterval, so the window below is a real duration rather than a count that
 * hopes the interval never moved.
 */
export const ORG_UNIT_RELAY_INTERVAL_MS = 5_000

/**
 * The window an operator is promised: a stuck tenant is named on stderr within
 * this long of the outbox going quiet - three passes at the relay's cadence,
 * i.e. 15s.
 */
export const NOT_DRAINING_WINDOW_MS = NOT_DRAINING_THRESHOLD * ORG_UNIT_RELAY_INTERVAL_MS

/** Minimum gap between two not-draining errors FOR THE SAME TENANT. */
export const NOT_DRAINING_LOG_INTERVAL_MS = 5 * 60 * 1000

export interface NotDrainingSignalDeps {
  now?: () => number
  error?: (msg: string) => void
}

/** What one completed drain pass observed for ONE tenant. */
export interface DrainOutcome {
  /** Rows published in this pass. */
  ok: number
  /**
   * Rows that were due, were tried, and threw - or 1 for a pass whose whole
   * transaction rejected. Non-zero is what marks the tenant as OWING.
   */
  failed: number
}

interface TenantSignal {
  /** When this tenant last went from "delivering / owing nothing" to owing. null = not owing. */
  owingSince: number | null
  /**
   * When the last line was emitted for this tenant. NULL, not 0: `0` would mean BOTH
   * "never logged" and "logged at time zero", so on a clock whose epoch is 0 the
   * throttle would read its own sentinel as a timestamp inside the interval.
   */
  lastLogAt: number | null
}

const signals = new Map<string, TenantSignal>()

function signalFor(tenantId: string): TenantSignal {
  let sig = signals.get(tenantId)
  if (!sig) {
    sig = { owingSince: null, lastLogAt: null }
    signals.set(tenantId, sig)
  }
  return sig
}

/**
 * Advance the not-draining signal for one completed pass of ONE tenant.
 * Exported so the relay (and the tests) can drive it without going through the DB.
 */
export function recordDrainOutcome(
  tenantId: string,
  outcome: DrainOutcome,
  deps: NotDrainingSignalDeps = {},
): void {
  const now = deps.now ?? (() => Date.now())
  const error = deps.error ?? ((m: string) => console.error(m))
  const sig = signalFor(tenantId)
  const t = now()

  if (outcome.failed > 0) {
    // Something was due, was tried, and did not go out. Start the clock if it is
    // not already running - a tenant that is already owing keeps its ORIGINAL
    // timestamp, or every failing pass would push the window out of reach.
    if (sig.owingSince === null) sig.owingSince = t
  } else if (outcome.ok > 0) {
    // The due rows went out. Whatever this tenant owed, it does not owe now.
    sig.owingSince = null
    return
  }
  // The remaining case - nothing due, nothing failed - deliberately changes
  // nothing: on a stuck tenant it is the backoff between retries, and on an
  // idle one there is no clock to reset.

  if (sig.owingSince === null) return
  const stuckForMs = t - sig.owingSince
  if (stuckForMs < NOT_DRAINING_WINDOW_MS) return
  if (sig.lastLogAt !== null && t - sig.lastLogAt < NOT_DRAINING_LOG_INTERVAL_MS) return
  sig.lastLogAt = t
  error(
    `[org-unit-outbox] NOT DRAINING for tenant ${tenantId}: nothing has been published for ` +
      `${Math.round(stuckForMs / 1000)}s and every pass since has either failed or found its rows ` +
      `still inside their backoff (${outcome.failed} failed in the last pass). That tenant's finance ` +
      'org_unit_mirror is falling behind. Check the row-level last_error in org_unit_event_outbox for ' +
      'that tenant; if the broker log also shows "refusing to repoint stream ORGUNIT", the ORGUNIT ' +
      'stream captures different subjects than this release publishes and needs an explicit repoint. ' +
      `(window ${NOT_DRAINING_WINDOW_MS / 1000}s; throttled to one line per ` +
      `${NOT_DRAINING_LOG_INTERVAL_MS / 1000}s per tenant; the state is in memory, so a redeploy ` +
      're-arms it on the next failed pass)',
  )
}

/** Reset the not-draining signal - for tests only. */
export function _resetNotDrainingSignalForTests(): void {
  signals.clear()
}
