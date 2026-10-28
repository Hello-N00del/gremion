// "Mandant sperren" / "Mandant fortsetzen" as REQUESTS (TRD-044, PRD-OPS-004).
// Like create and retry the panel mutates nothing itself: it writes ONE row
// through plt.submit_provisioning_request with the operator's signed sign-in
// as evidence; the host-side executor re-verifies it and runs the handler
// (handlers/suspend.sh, resume.sh). The gate here (the customer's status and
// the newest request, lifecycleOffer) is for the operator's sake; request-verify
// and the container's own state check are the lines that hold.
import { randomUUID } from 'node:crypto'
import type postgres from 'postgres'
import { lifecycleOffer, type LifecycleKind } from '../lifecycle'
import type { Evidence } from './requests'
import { SubmitRefused, submitRefusal } from './requests'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const NOT_OFFERED: Record<LifecycleKind, string> = {
  suspend: 'Der Mandant kann in diesem Zustand nicht gesperrt werden (nur ein aktiver Mandant, oder ein Mandant nach einer unvollständigen Sperre).',
  resume: 'Der Mandant kann in diesem Zustand nicht fortgesetzt werden (nur ein gesperrter Mandant).',
}

/** The normalised args request-verify accepts for suspend and resume: the slug and nothing else. */
export const lifecycleArgs = (slug: string): Record<string, unknown> => ({ slug })

/**
 * Queues the request. `status` is the customer's registry status (null: none).
 * Throws SubmitRefused 409 when the action is not offered in that state or
 * another request of the customer is queued or running.
 */
export async function submitLifecycle(
  sql: postgres.Sql,
  kind: LifecycleKind,
  slug: string,
  status: string | null,
  operatorId: string,
  evidence: Evidence,
): Promise<string> {
  if (!UUID.test(operatorId)) throw new SubmitRefused(403, 'Die Operator-Kennung ist keine UUID.')
  const last = await sql<{ kind: string; state: string; outcome: string | null; evidence_verified_at: Date | null }[]>`
    SELECT kind, state, outcome, evidence_verified_at FROM plt.provisioning_request_status
     WHERE customer_slug = ${slug} ORDER BY created_at DESC, request_id DESC LIMIT 1`
  const r = last[0]
  const newest = r ? { kind: r.kind, state: r.state, outcome: r.outcome, evidenceVerifiedAt: r.evidence_verified_at?.toISOString() ?? null } : null
  if (!lifecycleOffer(status, newest)[kind]) throw new SubmitRefused(409, NOT_OFFERED[kind])
  // Re-read right before the write: a double submit (or another tab) may have queued one already. A
  // race between this read and the insert stays possible and is harmless: the executor runs one
  // request per slug at a time, and both verbs converge when repeated.
  const inflight = await sql<{ one: number }[]>`
    SELECT 1 AS one FROM plt.provisioning_request_status WHERE customer_slug = ${slug} AND state IN ('queued', 'running') LIMIT 1`
  if (inflight.length > 0) throw new SubmitRefused(409, 'Für diesen Mandanten läuft bereits eine Anfrage oder wartet in der Warteschlange.')
  try {
    const rows = await sql<{ id: string }[]>`
      SELECT plt.submit_provisioning_request(
               ${kind}, ${slug}, ${sql.json(lifecycleArgs(slug) as never)}, ${randomUUID()}::uuid, ${operatorId}::uuid,
               ${evidence.acr}, ${evidence.authTime}::timestamptz, ${evidence.sessionAt}::timestamptz, ${evidence.token},
               NULL, NULL)::text AS id`
    return rows[0]!.id
  } catch (err) {
    throw submitRefusal(err)
  }
}
