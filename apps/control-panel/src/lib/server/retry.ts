// "Erneut versuchen" (H6, panel half): a failed or refused request is retried
// as a NEW request -- same kind, same verified-at-submit args -- with a NEW
// idempotency key and the operator's CURRENT sign-in as evidence. The old row
// is final and untouched. Offered, and accepted, only for kinds create and
// disable_module (resumable) while describeRequest says so (failed, expired, dead, or refused for the sign-in's
// sake); anything queued, running or succeeded writes no row.
import { randomUUID } from 'node:crypto'
import type postgres from 'postgres'
import { accessWords } from './access-log'
import { describeRequest } from '../request-state'
import type { Evidence } from './requests'
import { SubmitRefused, submitRefusal } from './requests'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export async function retryRequest(sql: postgres.Sql, slug: string, operatorId: string, evidence: Evidence): Promise<string> {
  if (!UUID.test(operatorId)) throw new SubmitRefused(403, 'Die Operator-Kennung ist keine UUID.')
  const last = await sql<{ kind: string; state: string; outcome: string | null; evidence_verified_at: Date | null; args: Record<string, unknown> }[]>`
    SELECT kind, state, outcome, evidence_verified_at, args FROM plt.provisioning_request_status
     WHERE customer_slug = ${slug} ORDER BY created_at DESC, request_id DESC LIMIT 1`
  const r = last[0]
  if (!r) throw new SubmitRefused(409, 'Zu diesem Mandanten gibt es keine Anfrage, die man wiederholen könnte.')
  const d = describeRequest({ kind: r.kind, state: r.state, outcome: r.outcome, evidenceVerifiedAt: r.evidence_verified_at?.toISOString() ?? null, lastStep: null })
  if (!d.retryable) {
    throw new SubmitRefused(409, d.active || d.phase === 'succeeded' ? 'Die letzte Anfrage ist noch nicht abgeschlossen oder war erfolgreich; ein neuer Versuch ist hier nicht möglich.' : (d.retryNote ?? 'Diese Anfrage lässt sich nicht wiederholen.'))
  }
  // Re-read right before the write: a double submit (or another tab) may have queued one already. A
  // race between this read and the insert stays possible and is harmless: the result is two create
  // requests for one slug, which the executor runs one after the other (one running per slug) and
  // the second resumes from the ledger.
  const inflight = await sql<{ one: number }[]>`
    SELECT 1 AS one FROM plt.provisioning_request_status WHERE customer_slug = ${slug} AND state IN ('queued', 'running') LIMIT 1`
  if (inflight.length > 0) throw new SubmitRefused(409, 'Für diesen Mandanten läuft bereits eine Anfrage oder wartet in der Warteschlange.')
  const key = randomUUID()
  try {
    const w = accessWords(r.kind, slug, true)
    const rows = await sql<{ id: string }[]>`
      SELECT plt.submit_provisioning_request(
               ${r.kind}, ${slug}, ${sql.json(r.args as never)}, ${key}::uuid, ${operatorId}::uuid,
               ${evidence.acr}, ${evidence.authTime}::timestamptz, ${evidence.sessionAt}::timestamptz, ${evidence.token},
               NULL, NULL)::text AS id
        FROM (SELECT oac.record_access(${slug}, ${w.action}, ${w.what}, ${w.why}, ${operatorId}, NULL)) AS access_record`
    return rows[0]!.id
  } catch (err) {
    throw submitRefusal(err)
  }
}
