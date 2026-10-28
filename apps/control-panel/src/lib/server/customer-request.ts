// The ONE write the panel may make for an existing customer's operate kinds
// (suspend, resume, enable_module, disable_module, record_dpia, reconcile):
// a row through plt.submit_provisioning_request with the operator's signed
// sign-in as evidence. The offer gate (is the action possible in this state)
// is each caller's; the in-flight re-check and the insert are shared here.
import { randomUUID } from 'node:crypto'
import type postgres from 'postgres'
import type { NewestRequest } from '../lifecycle'
import type { Evidence } from './requests'
import { SubmitRefused, submitRefusal } from './requests'

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** The customer's newest request, or null. */
export async function newestRequest(sql: postgres.Sql, slug: string): Promise<NewestRequest | null> {
  const last = await sql<{ kind: string; state: string; outcome: string | null; evidence_verified_at: Date | null }[]>`
    SELECT kind, state, outcome, evidence_verified_at FROM plt.provisioning_request_status
     WHERE customer_slug = ${slug} ORDER BY created_at DESC, request_id DESC LIMIT 1`
  const r = last[0]
  return r ? { kind: r.kind, state: r.state, outcome: r.outcome, evidenceVerifiedAt: r.evidence_verified_at?.toISOString() ?? null } : null
}

/**
 * Queues the request. Throws SubmitRefused 409 when another request of the
 * customer is queued or running. A race between that read and the insert stays
 * possible and is harmless: the executor runs one request per slug at a time,
 * and every operate kind converges when repeated.
 */
export async function queueRequest(sql: postgres.Sql, kind: string, slug: string, args: Record<string, unknown>, operatorId: string, evidence: Evidence): Promise<string> {
  if (!UUID.test(operatorId)) throw new SubmitRefused(403, 'Die Operator-Kennung ist keine UUID.')
  const inflight = await sql<{ one: number }[]>`
    SELECT 1 AS one FROM plt.provisioning_request_status WHERE customer_slug = ${slug} AND state IN ('queued', 'running') LIMIT 1`
  if (inflight.length > 0) throw new SubmitRefused(409, 'Für diesen Mandanten läuft bereits eine Anfrage oder wartet in der Warteschlange.')
  try {
    const rows = await sql<{ id: string }[]>`
      SELECT plt.submit_provisioning_request(
               ${kind}, ${slug}, ${sql.json(args as never)}, ${randomUUID()}::uuid, ${operatorId}::uuid,
               ${evidence.acr}, ${evidence.authTime}::timestamptz, ${evidence.sessionAt}::timestamptz, ${evidence.token},
               NULL, NULL)::text AS id`
    return rows[0]!.id
  } catch (err) {
    throw submitRefusal(err)
  }
}
