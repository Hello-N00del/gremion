// src/lib/server/module-karenz/store.ts
// Module Karenz (phase 2, Task 7): the step ledger, the item list and the notice
// record of the per-tenant pass (tables of migration 0064).
//
// The platform row (plt.module_karenz) is the clock; these tables are what the
// tenant pass remembers between runs, so every pass is idempotent and a crash at
// any point is resumed, not repeated:
//   - module_karenz_step    one row per (karenz row, step): state, attempts, last error;
//   - module_karenz_item    what a participant locked or archived, to put it back;
//   - module_karenz_notice  who has been mailed, per kind (switch-off, day 23, day 29).
//
// Every function takes the TENANT pool (getDb() / ctx.db) and never opens one.
// `karenzId` is the platform row id; it names a row in ANOTHER database, so none of
// these tables has a foreign key to it.
import type { Sql } from '@gremion/db'

export type StepState = 'pending' | 'done' | 'failed' | 'skipped'
export type ItemState = 'recorded' | 'locked' | 'lock_failed' | 'restored' | 'unlock_failed' | 'kept' | 'deleted' | 'gone'
export type NoticeKind = 'switchoff' | 't23' | 't29'
export type NoticeState = 'sent' | 'failed'

export interface StepRow {
  karenzId: string
  step: string
  state: StepState
  attempts: number
  lastError: string | null
  lastReportedAt: Date | null
  doneAt: Date | null
  updatedAt: Date
}

export type StepPatch =
  | {
      state: Exclude<StepState, 'failed'>
      /** Recorded in last_error; omitted or undefined clears it (a step that is done has no error). */
      error?: string
      /** True stamps last_reported_at (the result was posted to the platform); false/omitted leaves it alone. */
      reported?: boolean
    }
  | {
      /** A failed step always says why (the settings page and the ops alert read the text), so `error` is required. */
      state: 'failed'
      error: string
      reported?: boolean
    }

/** What a participant records about one external thing. */
export interface KarenzItem {
  karenzId: string
  kind: string
  externalId: string
  state: ItemState
  /** Free structured data of the participant (for example the remaining time of a poll). */
  payload?: unknown
  detail?: string
}

export interface KarenzItemRow {
  itemId: string
  karenzId: string
  kind: string
  externalId: string
  state: ItemState
  payload: unknown
  detail: string | null
  updatedAt: Date
}

export type NoticeInput =
  | { karenzId: string; kind: NoticeKind; userId: string; state: 'sent'; error?: string }
  /** A failed notice always says why (the settings page lists it), so `error` is required. */
  | { karenzId: string; kind: NoticeKind; userId: string; state: 'failed'; error: string }

interface StepDb {
  karenz_id: string
  step: string
  state: StepState
  attempts: number
  last_error: string | null
  last_reported_at: Date | null
  done_at: Date | null
  updated_at: Date
}

interface ItemDb {
  item_id: string
  karenz_id: string
  kind: string
  external_id: string
  state: ItemState
  payload: unknown
  detail: string | null
  updated_at: Date
}

const STEP_COLUMNS = 'karenz_id, step, state, attempts, last_error, last_reported_at, done_at, updated_at'
const ITEM_COLUMNS = 'item_id, karenz_id, kind, external_id, state, payload, detail, updated_at'

function toStep(r: StepDb): StepRow {
  return {
    karenzId: r.karenz_id,
    step: r.step,
    state: r.state,
    attempts: r.attempts,
    lastError: r.last_error,
    lastReportedAt: r.last_reported_at,
    doneAt: r.done_at,
    updatedAt: r.updated_at,
  }
}

function toItem(r: ItemDb): KarenzItemRow {
  return {
    itemId: r.item_id,
    karenzId: r.karenz_id,
    kind: r.kind,
    externalId: r.external_id,
    state: r.state,
    payload: r.payload ?? null,
    detail: r.detail,
    updatedAt: r.updated_at,
  }
}

/** The ledger row of one step, or null when the step was never marked. */
export async function getStep(db: Sql, karenzId: string, step: string): Promise<StepRow | null> {
  const rows = await db<StepDb[]>`
    SELECT ${db.unsafe(STEP_COLUMNS)} FROM module_karenz_step
     WHERE karenz_id = ${karenzId} AND step = ${step}`
  return rows[0] ? toStep(rows[0]) : null
}

/** Every step of one karenz row, ordered by step name. */
export async function listSteps(db: Sql, karenzId: string): Promise<StepRow[]> {
  const rows = await db<StepDb[]>`
    SELECT ${db.unsafe(STEP_COLUMNS)} FROM module_karenz_step
     WHERE karenz_id = ${karenzId}
     ORDER BY step`
  return rows.map(toStep)
}

/**
 * Record one attempt of a step. One atomic upsert: the first call inserts with
 * attempts = 1, every later call adds one. `done_at` is set by the first call that
 * records `done` and never moved afterwards (a pass that re-observes a finished
 * step does not rewrite when it finished); `last_error` follows the latest call;
 * `last_reported_at` moves only when `reported` is true. Returns the row after the write.
 */
export async function markStep(db: Sql, karenzId: string, step: string, patch: StepPatch): Promise<StepRow> {
  if (patch.state === 'failed' && !patch.error?.trim()) throw new RangeError('markStep: a failed step records why it failed (error is required)')
  const reported = patch.reported === true
  const rows = await db<StepDb[]>`
    INSERT INTO module_karenz_step (karenz_id, step, state, attempts, last_error, last_reported_at, done_at)
    VALUES (${karenzId}, ${step}, ${patch.state}, 1, ${patch.error ?? null},
            CASE WHEN ${reported}::boolean THEN now() END,
            CASE WHEN ${patch.state} = 'done' THEN now() END)
    ON CONFLICT (karenz_id, step) DO UPDATE
       SET state            = EXCLUDED.state,
           attempts         = module_karenz_step.attempts + 1,
           last_error       = EXCLUDED.last_error,
           last_reported_at = CASE WHEN ${reported}::boolean THEN now() ELSE module_karenz_step.last_reported_at END,
           done_at          = COALESCE(module_karenz_step.done_at, EXCLUDED.done_at),
           updated_at       = now()
    RETURNING ${db.unsafe(STEP_COLUMNS)}`
  return toStep(rows[0]!)
}

/**
 * Record an item, idempotent per (karenz_id, kind, external_id). A pass that observes
 * the same thing again records it as `recorded`; that must never undo what an earlier
 * pass did to it, so a `recorded` upsert onto a row in any other state changes nothing
 * (state, payload and detail stay). Any other state moves the row, keeps the old
 * payload when the call carries none, and takes the new detail. Returns the row.
 */
export async function upsertItem(db: Sql, item: KarenzItem): Promise<KarenzItemRow> {
  const payload = item.payload === undefined ? null : db.json(item.payload as never)
  const rows = await db<ItemDb[]>`
    INSERT INTO module_karenz_item (karenz_id, kind, external_id, state, payload, detail)
    VALUES (${item.karenzId}, ${item.kind}, ${item.externalId}, ${item.state}, ${payload}, ${item.detail ?? null})
    ON CONFLICT (karenz_id, kind, external_id) DO UPDATE
       SET state      = CASE WHEN EXCLUDED.state = 'recorded' AND module_karenz_item.state <> 'recorded'
                             THEN module_karenz_item.state ELSE EXCLUDED.state END,
           payload    = CASE WHEN EXCLUDED.state = 'recorded' AND module_karenz_item.state <> 'recorded'
                             THEN module_karenz_item.payload
                             ELSE COALESCE(EXCLUDED.payload, module_karenz_item.payload) END,
           detail     = CASE WHEN EXCLUDED.state = 'recorded' AND module_karenz_item.state <> 'recorded'
                             THEN module_karenz_item.detail ELSE EXCLUDED.detail END,
           updated_at = now()
    RETURNING ${db.unsafe(ITEM_COLUMNS)}`
  return toItem(rows[0]!)
}

/** The items of one karenz row (optionally of one kind), ordered by kind and then by external id (not by when they were recorded). */
export async function listItems(db: Sql, karenzId: string, kind?: string): Promise<KarenzItemRow[]> {
  const rows =
    kind === undefined
      ? await db<ItemDb[]>`
          SELECT ${db.unsafe(ITEM_COLUMNS)} FROM module_karenz_item
           WHERE karenz_id = ${karenzId}
           ORDER BY kind, external_id`
      : await db<ItemDb[]>`
          SELECT ${db.unsafe(ITEM_COLUMNS)} FROM module_karenz_item
           WHERE karenz_id = ${karenzId} AND kind = ${kind}
           ORDER BY external_id`
  return rows.map(toItem)
}

/**
 * Move one item to `state` (and set its detail; omitted clears it). True when the item
 * exists, false when no item has this id: a caller that records a result MUST check it.
 */
export async function setItemState(db: Sql, itemId: string, state: ItemState, detail?: string): Promise<boolean> {
  const rows = await db<{ item_id: string }[]>`
    UPDATE module_karenz_item
       SET state = ${state}, detail = ${detail ?? null}, updated_at = now()
     WHERE item_id = ${itemId}
    RETURNING item_id`
  return rows.length === 1
}

/**
 * Record the outcome of one mail to one person. Idempotent per (karenz, kind, user):
 * every call counts an attempt, a `sent` stamps sent_at (the first time) and clears the
 * error, and a later `failed` never turns a `sent` row back, so a retried pass cannot
 * make a delivered notice look undelivered.
 */
export async function recordNotice(db: Sql, n: NoticeInput): Promise<void> {
  if (n.state === 'failed' && !n.error?.trim()) throw new RangeError('recordNotice: a failed notice records why it failed (error is required)')
  await db`
    INSERT INTO module_karenz_notice (karenz_id, kind, user_id, state, attempts, sent_at, last_error)
    VALUES (${n.karenzId}, ${n.kind}, ${n.userId}, ${n.state}, 1,
            CASE WHEN ${n.state} = 'sent' THEN now() END, ${n.state === 'failed' ? (n.error ?? null) : null})
    ON CONFLICT (karenz_id, kind, user_id) DO UPDATE
       SET attempts   = module_karenz_notice.attempts + 1,
           state      = CASE WHEN module_karenz_notice.state = 'sent' THEN 'sent' ELSE EXCLUDED.state END,
           sent_at    = COALESCE(module_karenz_notice.sent_at, EXCLUDED.sent_at),
           last_error = CASE WHEN module_karenz_notice.state = 'sent' OR EXCLUDED.state = 'sent'
                             THEN NULL ELSE EXCLUDED.last_error END`
}

/** The user ids already mailed for this kind (state `sent`); a failed notice is not in the set. */
export async function noticesSent(db: Sql, karenzId: string, kind: NoticeKind): Promise<Set<string>> {
  const rows = await db<{ user_id: string }[]>`
    SELECT user_id FROM module_karenz_notice
     WHERE karenz_id = ${karenzId} AND kind = ${kind} AND state = 'sent'`
  return new Set(rows.map((r) => r.user_id))
}
