// src/lib/server/governance/provisioning/ledger.ts
import { getDb } from '../../db'
import { getRunner } from '../../db/tx'
import type { PgTransaction } from '../../db/tx'
import type { Subsystem, ResourceStatus } from './types'

/** P0.3a: a failing intent goes terminal (stops being due) after this wall-clock age,
 *  so a long-but-transient outage self-heals rather than being abandoned (count-based
 *  backoff plateaus at 1h, so count is the wrong terminal signal). Resettable on recovery. */
export const GIVE_UP_AFTER_SECONDS = 24 * 60 * 60

export interface ProvisioningResource {
  readonly id: string
  readonly org_unit_id: string
  readonly subsystem: Subsystem
  readonly external_id: string | null
  readonly status: ResourceStatus
  readonly attempts: number
  readonly next_attempt_at: Date | null
  readonly first_failed_at: Date | null
  readonly last_error: string | null
  readonly synced_at: Date | null
  readonly updated_at: Date
}

/** Create the ledger row for (unit, subsystem) if it does not exist. */
export async function ensureResourceRow(orgUnitId: string, subsystem: Subsystem): Promise<void> {
  await getDb()`
    INSERT INTO provisioning_resources (org_unit_id, subsystem)
    VALUES (${orgUnitId}, ${subsystem})
    ON CONFLICT (org_unit_id, subsystem) DO NOTHING`
}

/** Co-commit per-subsystem 'pending' rows with the org_unit insert (the atomic outbox enqueue).
 *  'pending' + next_attempt_at NULL = immediately due. Lazy getDb thunk (never call eagerly). */
export async function enqueueResources(
  tx: PgTransaction | undefined,
  orgUnitId: string,
  subsystems: readonly Subsystem[]
): Promise<void> {
  const sql = getRunner(tx, getDb)
  for (const subsystem of subsystems) {
    await sql`
      INSERT INTO provisioning_resources (org_unit_id, subsystem)
      VALUES (${orgUnitId}, ${subsystem})
      ON CONFLICT (org_unit_id, subsystem) DO NOTHING`
  }
}

export async function getResources(orgUnitId: string): Promise<readonly ProvisioningResource[]> {
  return getDb()<ProvisioningResource[]>`
    SELECT * FROM provisioning_resources WHERE org_unit_id = ${orgUnitId}`
}

export async function getResource(
  orgUnitId: string, subsystem: Subsystem
): Promise<ProvisioningResource | null> {
  const rows = await getDb()<ProvisioningResource[]>`
    SELECT * FROM provisioning_resources
    WHERE org_unit_id = ${orgUnitId} AND subsystem = ${subsystem}`
  return rows[0] ?? null
}

export async function markResourceOk(
  orgUnitId: string, subsystem: Subsystem, externalId: string
): Promise<void> {
  await getDb()`
    UPDATE provisioning_resources SET
      status = 'ok', external_id = ${externalId}, last_error = NULL,
      next_attempt_at = NULL, synced_at = now(), updated_at = now(),
      first_failed_at = NULL, attempts = 0
    WHERE org_unit_id = ${orgUnitId} AND subsystem = ${subsystem}`
}

/** Mark failed, increment attempts, and schedule the next retry with capped backoff. */
export async function markResourceFailed(
  orgUnitId: string, subsystem: Subsystem, error: string
): Promise<void> {
  await getDb()`
    UPDATE provisioning_resources SET
      status = 'failed', last_error = ${error.slice(0, 2000)},
      attempts = attempts + 1,
      next_attempt_at = now() + make_interval(
        secs => LEAST(3600, 30 * power(2, LEAST(attempts + 1, 12))::int)),
      first_failed_at = COALESCE(first_failed_at, now()),
      updated_at = now()
    WHERE org_unit_id = ${orgUnitId} AND subsystem = ${subsystem}`
}

/** Org-units with at least one non-ok resource whose retry time has arrived,
 *  excluding resources that have been failing longer than GIVE_UP_AFTER_SECONDS
 *  wall-clock (terminal — stops retry storms; resets on any successful recovery). */
export async function listDueOrgUnitIds(): Promise<readonly string[]> {
  const rows = await getDb()<Array<{ org_unit_id: string }>>`
    SELECT DISTINCT org_unit_id FROM provisioning_resources
    WHERE status <> 'ok'
      AND (next_attempt_at IS NULL OR next_attempt_at <= now())
      AND (first_failed_at IS NULL OR now() - first_failed_at < make_interval(secs => ${GIVE_UP_AFTER_SECONDS}))`
  return rows.map((r) => r.org_unit_id)
}
