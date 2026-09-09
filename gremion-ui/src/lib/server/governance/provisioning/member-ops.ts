// Durable membership-remove outbox (Pillar-1 P0.3a). A remove intent is enqueued in the SAME
// tx as the org_unit_members hard-delete, so a fanOut throw can never silently drop the removal
// (the #185 residual). The reconcile worker drains due ops idempotently. Mirrors ledger.ts.
import { getDb } from '$lib/server/db'
import { getRunner, type PgTransaction } from '$lib/server/db/tx'
import { GIVE_UP_AFTER_SECONDS } from './ledger'
import type { MemberOp, Subsystem } from './types'

/** Enqueue one `remove` op per subsystem for (unit, user). MUST run in the same tx as the
 *  membership-row delete (caller passes the tx). Lazy getDb fallback for non-tx callers/tests. */
export async function enqueueMemberRemoveOps(tx: PgTransaction | undefined, orgUnitId: string, userKeycloakId: string, subsystems: readonly Subsystem[]): Promise<void> {
  if (subsystems.length === 0) return
  const sql = getRunner(tx, getDb)
  for (const subsystem of subsystems) {
    await sql`INSERT INTO provisioning_member_ops (org_unit_id, user_keycloak_id, subsystem, op) VALUES (${orgUnitId}, ${userKeycloakId}, ${subsystem}, 'remove')`
  }
}

export async function getMemberOps(orgUnitId: string): Promise<readonly MemberOp[]> {
  return getDb()<MemberOp[]>`SELECT * FROM provisioning_member_ops WHERE org_unit_id = ${orgUnitId} ORDER BY created_at`
}

export async function listDueMemberOps(): Promise<readonly MemberOp[]> {
  return getDb()<MemberOp[]>`
    SELECT * FROM provisioning_member_ops
    WHERE status <> 'ok'
      AND (next_attempt_at IS NULL OR next_attempt_at <= now())
      AND (first_failed_at IS NULL OR now() - first_failed_at < make_interval(secs => ${GIVE_UP_AFTER_SECONDS}))
    ORDER BY created_at`
}

export async function markMemberOpOk(id: string): Promise<void> {
  await getDb()`UPDATE provisioning_member_ops SET status = 'ok', last_error = NULL, next_attempt_at = NULL, first_failed_at = NULL, updated_at = now() WHERE id = ${id}`
}

export async function markMemberOpFailed(id: string, error: string): Promise<void> {
  await getDb()`
    UPDATE provisioning_member_ops
    SET status = 'failed', last_error = ${error.slice(0, 2000)}, attempts = attempts + 1,
        first_failed_at = COALESCE(first_failed_at, now()),
        next_attempt_at = now() + make_interval(secs => LEAST(3600, 30 * power(2, LEAST(attempts + 1, 12))::int)), updated_at = now()
    WHERE id = ${id}`
}
