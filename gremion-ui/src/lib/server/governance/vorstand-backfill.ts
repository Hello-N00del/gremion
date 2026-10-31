// src/lib/server/governance/vorstand-backfill.ts
//
// Karenz phase 1 (Task 8): apply the standard `vorstand` realm role to the people
// who already sit on a council's Vorstand committee.
//
// Realm roles live in Keycloak, not SQL, so "seeded for existing councils by
// migration" is two halves. Migration 0062 QUEUES the current members of the
// committee named (or labelled) Vorstand into `role_backfill` - the last place the
// committee-name match exists; from then on the role, not the name, says who is
// Vorstand. This worker APPLIES the queue: idempotent, bounded, and one bad row
// never aborts the pass (Review Focus 6).
//
// Row outcomes:
//   applied      the role was assigned (Keycloak's role-mapping POST is itself
//                idempotent, so a crash between the call and the mark is harmless)
//   gone         the Keycloak user no longer exists; closed with a reason so it is
//                not retried forever, and counted
//   failed       anything else (outage, 5xx): attempts + 1, last_error, loud
//                console.error, retried on the next tick
// A realm that does not (yet) have the role is not a per-row failure: the reconcile
// check `vorstand-role` creates it, and the drain says so and tries again later.
import type { Sql } from 'postgres'
import { KcAdminError, type KeycloakAdminClient } from '$lib/server/keycloak-admin'

/** Rows handled per pass; the rest wait for the next tick. */
export const ROLE_BACKFILL_BATCH = 100

/** How often the boot hook runs a pass per active tenant. */
export const ROLE_BACKFILL_INTERVAL_MS = 60_000

export type BackfillKc = Pick<KeycloakAdminClient, 'listRealmRoles' | 'assignRoles' | 'getUser'>

export interface BackfillLog {
  info(message: string): void
  error(message: string, ...rest: unknown[]): void
}

export interface BackfillResult {
  applied: number
  failed: number
  gone: number
}

interface QueueRow {
  id: string
  role: string
  user_keycloak_id: string
}

/** The two ways a missing Keycloak user shows up: getUser's sentinel and a raw 404. */
function isUserGone(err: unknown): boolean {
  if (err instanceof KcAdminError) return err.status === 404
  return err instanceof Error && err.message === 'User not found'
}

function describe(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500)
}

export async function drainRoleBackfill(db: Sql, kc: BackfillKc, log: BackfillLog): Promise<BackfillResult> {
  const out: BackfillResult = { applied: 0, failed: 0, gone: 0 }

  // Fewest attempts first: a row that keeps failing never starves a fresh one.
  const rows = await db<QueueRow[]>`
    SELECT id, role, user_keycloak_id FROM role_backfill
     WHERE applied_at IS NULL
     ORDER BY attempts, queued_at, id
     LIMIT ${ROLE_BACKFILL_BATCH}`
  if (rows.length === 0) return out

  let realmRoles: Awaited<ReturnType<BackfillKc['listRealmRoles']>>
  try {
    realmRoles = await kc.listRealmRoles()
  } catch (err) {
    log.error(`[vorstand-backfill] listing the realm roles failed; ${rows.length} queued row(s) wait for the next pass:`, err)
    out.failed = rows.length
    return out
  }
  const byName = new Map(realmRoles.map((r) => [r.name, r]))

  for (const row of rows) {
    const role = byName.get(row.role)
    if (!role) {
      // Not a per-row fault: the realm has no such role yet. No attempt is counted.
      out.failed += 1
      await db`UPDATE role_backfill SET last_error = ${`realm role '${row.role}' does not exist`} WHERE id = ${row.id}`
      continue
    }
    try {
      await kc.getUser(row.user_keycloak_id)
      await kc.assignRoles(row.user_keycloak_id, [role])
      await db`
        UPDATE role_backfill
           SET applied_at = now(), last_error = NULL, attempts = attempts + 1
         WHERE id = ${row.id}`
      out.applied += 1
    } catch (err) {
      try {
        if (isUserGone(err)) {
          await db`
            UPDATE role_backfill
               SET applied_at = now(), last_error = 'user not found', attempts = attempts + 1
             WHERE id = ${row.id}`
          out.gone += 1
          continue
        }
        out.failed += 1
        log.error(`[vorstand-backfill] assigning ${row.role} to ${row.user_keycloak_id} failed (attempt kept for the next pass):`, err)
        await db`
          UPDATE role_backfill
             SET attempts = attempts + 1, last_error = ${describe(err)}
           WHERE id = ${row.id}`
      } catch (markErr) {
        // The ledger write itself failed (database trouble): the row stays pending
        // and is retried; the pass goes on with the next row.
        out.failed += 1
        log.error(`[vorstand-backfill] recording the outcome for ${row.user_keycloak_id} failed:`, markErr)
      }
    }
  }

  // The reconcile hint, once per pass, when the whole batch was blocked on the missing role.
  const missing = rows.filter((r) => !byName.has(r.role))
  if (missing.length > 0) {
    log.error(
      `[vorstand-backfill] realm role '${missing[0]!.role}' is missing: ${missing.length} queued row(s) wait. ` +
        `Run the tenant reconcile (check 'vorstand-role') to create it.`,
    )
  }
  if (out.applied + out.gone > 0) {
    log.info(`[vorstand-backfill] applied ${out.applied}, gone ${out.gone}, failed ${out.failed}`)
  }
  return out
}
