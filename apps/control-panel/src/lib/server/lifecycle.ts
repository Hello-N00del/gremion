// "Mandant sperren" / "Mandant fortsetzen" as REQUESTS (TRD-044, PRD-OPS-004).
// Like create and retry the panel mutates nothing itself: it writes ONE row
// through plt.submit_provisioning_request with the operator's signed sign-in
// as evidence; the host-side executor re-verifies it and runs the handler
// (handlers/suspend.sh, resume.sh). The gate here (the customer's status and
// the newest request, lifecycleOffer) is for the operator's sake; request-verify
// and the container's own state check are the lines that hold.
import type postgres from 'postgres'
import { lifecycleOffer, type LifecycleKind } from '../lifecycle'
import { newestRequest, queueRequest, UUID } from './customer-request'
import type { Evidence } from './requests'
import { SubmitRefused } from './requests'

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
  if (!lifecycleOffer(status, await newestRequest(sql, slug))[kind]) throw new SubmitRefused(409, NOT_OFFERED[kind])
  return queueRequest(sql, kind, slug, lifecycleArgs(slug), operatorId, evidence)
}
