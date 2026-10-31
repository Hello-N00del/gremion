// src/lib/server/module-switch/store.ts
// Karenz phase 1 (Task 10): the tenant-side record of a council module switch
// (table module_switch_request, migration 0063).
//
// The request itself lives in the platform (plt.provisioning_request, origin
// 'council'); this table is the tenant's own view of it, so the settings page can
// show what is pending or failed and the reconciler can apply the result to
// config.modules. module_id is the CATALOGUE id (what the platform knows); see
// $lib/modules/catalogue-map.ts for the manifest id.
//
// Every function takes the TENANT pool (getDb() / ctx.db) and never opens one.
// The two transitions that race between instances (blue and green both run a
// reconciler) are ATOMIC CLAIMS: claimTransition and claimNotification. The
// reconciler uses only these two for them, never a read-then-update.
import type { Sql } from '@gremion/db'

export type SwitchState = 'queued' | 'succeeded' | 'applying' | 'applied' | 'failed' | 'refused' | 'expired' | 'dead'
export type SwitchAction = 'enable' | 'disable'

export interface SwitchRow {
  requestId: string
  /** Catalogue id. */
  moduleId: string
  action: SwitchAction
  actorUserId: string
  submittedAt: Date
  state: SwitchState
  outcome: string | null
  configError: string | null
  appliedAt: Date | null
  finishedAt: Date | null
  notifiedAt: Date | null
  claimedAt: Date | null
}

/** What a caller supplies on insert; everything else (submitted_at included, unless given) takes the table default. */
export type NewSwitch = Pick<SwitchRow, 'requestId' | 'moduleId' | 'action' | 'actorUserId'> & Partial<Pick<SwitchRow, 'submittedAt' | 'state'>>

/** Columns updateSwitch may set (the primary key, module, action and actor never change). */
export type SwitchPatch = Partial<Pick<SwitchRow, 'state' | 'outcome' | 'configError' | 'appliedAt' | 'finishedAt' | 'notifiedAt' | 'claimedAt'>>

/** The default lease of an `applying` claim: a pass that died is retried after this. */
export const DEFAULT_LEASE_S = 120

interface DbRow {
  request_id: string
  module_id: string
  action: SwitchAction
  actor_user_id: string
  submitted_at: Date
  state: SwitchState
  outcome: string | null
  config_error: string | null
  applied_at: Date | null
  finished_at: Date | null
  notified_at: Date | null
  claimed_at: Date | null
}

function toRow(r: DbRow): SwitchRow {
  return {
    requestId: r.request_id,
    moduleId: r.module_id,
    action: r.action,
    actorUserId: r.actor_user_id,
    submittedAt: r.submitted_at,
    state: r.state,
    outcome: r.outcome,
    configError: r.config_error,
    appliedAt: r.applied_at,
    finishedAt: r.finished_at,
    notifiedAt: r.notified_at,
    claimedAt: r.claimed_at,
  }
}

const COLUMNS = `request_id, module_id, action, actor_user_id, submitted_at, state, outcome, config_error, applied_at, finished_at, notified_at, claimed_at`

export async function insertSwitch(db: Sql, row: NewSwitch): Promise<void> {
  const state = row.state ?? 'queued'
  if (row.submittedAt === undefined) {
    // No time given: leave the column out so the table default (the DB clock, the one the lease
    // arithmetic uses) applies. Blue and green instances never order rows by their own app clocks.
    await db`
      INSERT INTO module_switch_request (request_id, module_id, action, actor_user_id, state)
      VALUES (${row.requestId}, ${row.moduleId}, ${row.action}, ${row.actorUserId}, ${state})`
    return
  }
  await db`
    INSERT INTO module_switch_request (request_id, module_id, action, actor_user_id, submitted_at, state)
    VALUES (${row.requestId}, ${row.moduleId}, ${row.action}, ${row.actorUserId}, ${row.submittedAt}, ${state})`
}

/** Newest first. `limit` is clamped to 1..200. */
export async function listSwitches(db: Sql, limit: number): Promise<SwitchRow[]> {
  const n = Math.min(Math.max(Math.trunc(limit) || 1, 1), 200)
  const rows = await db<DbRow[]>`
    SELECT ${db.unsafe(COLUMNS)} FROM module_switch_request
    ORDER BY submitted_at DESC, request_id
    LIMIT ${n}`
  return rows.map(toRow)
}

/** Rows the reconciler still has to carry: queued, succeeded or applying. Oldest first. */
export async function pendingSwitches(db: Sql): Promise<SwitchRow[]> {
  const rows = await db<DbRow[]>`
    SELECT ${db.unsafe(COLUMNS)} FROM module_switch_request
    WHERE state IN ('queued', 'succeeded', 'applying')
    ORDER BY submitted_at, request_id`
  return rows.map(toRow)
}

const PATCH_COLUMNS: Record<keyof SwitchPatch, string> = {
  state: 'state',
  outcome: 'outcome',
  configError: 'config_error',
  appliedAt: 'applied_at',
  finishedAt: 'finished_at',
  notifiedAt: 'notified_at',
  claimedAt: 'claimed_at',
}

/**
 * Set the named columns. An unset key is left alone; a key set to `null` clears
 * the column. NOT for the racing transitions: use claimTransition for those.
 *
 * Resolves true when the row exists (and was written), false when no row has
 * this request id. A caller that records a terminal outcome MUST check it: a
 * false means the outcome was lost, and it has to be logged or the row adopted
 * first, never dropped.
 */
export async function updateSwitch(db: Sql, requestId: string, patch: SwitchPatch): Promise<boolean> {
  const keys = (Object.keys(patch) as (keyof SwitchPatch)[]).filter((k) => k in PATCH_COLUMNS && patch[k] !== undefined)
  if (keys.length === 0) {
    const found = await db<{ request_id: string }[]>`SELECT request_id FROM module_switch_request WHERE request_id = ${requestId}`
    return found.length === 1
  }
  const values: Record<string, unknown> = {}
  for (const k of keys) values[PATCH_COLUMNS[k]] = patch[k]
  // postgres.js builds `SET "col" = $n, ...` from the object; the column names come from PATCH_COLUMNS only.
  const written = await db<{ request_id: string }[]>`
    UPDATE module_switch_request SET ${db(values as Record<string, never>, ...Object.keys(values))}
     WHERE request_id = ${requestId}
    RETURNING request_id`
  return written.length === 1
}

/**
 * Atomically move a row to `to` when it is in one of the `from` states, or, for
 * a claim INTO `applying` only, when it is `applying` with an expired (or
 * missing) lease: a pass that died mid-apply is retried. A call for any other
 * edge never takes over a half-applied row; name 'applying' in `from` to do
 * that on purpose. Returns the row after the move, or null when another
 * instance holds it (or the row is in none of the states). One UPDATE ...
 * WHERE ... RETURNING, so two concurrent callers cannot both win.
 *
 * Only ACQUIRING the lease is atomic. A holder that outlives the lease and then
 * writes its result through updateSwitch can overwrite the newer holder's; the
 * 120 s default is far above one apply pass, and a lease token is the follow-up
 * if a pass ever gets close to it.
 */
export async function claimTransition(
  db: Sql,
  requestId: string,
  from: readonly SwitchState[],
  to: SwitchState,
  opts: { leaseS?: number } = {},
): Promise<SwitchRow | null> {
  const lease = opts.leaseS ?? DEFAULT_LEASE_S
  const reclaimExpired = to === 'applying'
  const rows = await db<DbRow[]>`
    UPDATE module_switch_request
       SET state = ${to}, claimed_at = now()
     WHERE request_id = ${requestId}
       AND (state = ANY(${[...from]}::text[])
            OR (${reclaimExpired}::boolean AND state = 'applying'
                AND (claimed_at IS NULL OR claimed_at < now() - make_interval(secs => ${lease}::double precision))))
    RETURNING ${db.unsafe(COLUMNS)}`
  return rows[0] ? toRow(rows[0]) : null
}

/** Atomically mark the post-switch notice as sent. True for exactly one caller. */
export async function claimNotification(db: Sql, requestId: string): Promise<boolean> {
  const rows = await db<{ request_id: string }[]>`
    UPDATE module_switch_request SET notified_at = now()
     WHERE request_id = ${requestId} AND notified_at IS NULL
    RETURNING request_id`
  return rows.length === 1
}
