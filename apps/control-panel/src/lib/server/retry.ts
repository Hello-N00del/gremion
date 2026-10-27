// "Erneut versuchen" (H6, panel half): a failed or refused request is retried
// as a NEW request -- same kind, same verified-at-submit args -- with a NEW
// idempotency key and the operator's CURRENT sign-in as evidence. The old row
// is final and untouched. Offered, and accepted, only while the newest request
// of the customer is failed or refused; anything queued, running or
// succeeded writes no row.
import { randomUUID } from 'node:crypto'
import type postgres from 'postgres'
import type { Evidence } from './requests'
import { SubmitRefused, submitRefusal } from './requests'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
export const RETRYABLE_STATES = ['failed', 'refused'] as const

export async function retryRequest(sql: postgres.Sql, slug: string, operatorId: string, evidence: Evidence): Promise<string> {
  if (!UUID.test(operatorId)) throw new SubmitRefused(403, 'Die Operator-Kennung ist keine UUID.')
  const last = await sql<{ kind: string; state: string; args: Record<string, unknown> }[]>`
    SELECT kind, state, args FROM plt.provisioning_request_status
     WHERE customer_slug = ${slug} ORDER BY created_at DESC, request_id DESC LIMIT 1`
  const r = last[0]
  if (!r) throw new SubmitRefused(409, 'Zu diesem Mandanten gibt es keine Anfrage, die man wiederholen könnte.')
  if (!(RETRYABLE_STATES as readonly string[]).includes(r.state)) {
    throw new SubmitRefused(409, 'Die letzte Anfrage ist noch nicht abgeschlossen oder war erfolgreich; ein neuer Versuch ist nur nach „fehlgeschlagen“ oder „abgelehnt“ möglich.')
  }
  const key = randomUUID()
  try {
    const rows = await sql<{ id: string }[]>`
      SELECT plt.submit_provisioning_request(
               ${r.kind}, ${slug}, ${sql.json(r.args as never)}, ${key}::uuid, ${operatorId}::uuid,
               ${evidence.acr}, ${evidence.authTime}::timestamptz, ${evidence.sessionAt}::timestamptz, ${evidence.token},
               NULL, NULL)::text AS id`
    return rows[0]!.id
  } catch (err) {
    throw submitRefusal(err)
  }
}
