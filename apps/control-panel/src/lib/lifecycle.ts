// Which council lifecycle action the customer page offers (TRD-044, PRD-OPS-004):
// "Mandant sperren" (suspend) and "Mandant fortsetzen" (resume). Pure, shared by
// the page load (which buttons to draw) and the actions (the 409 gate), so the
// two can never disagree. The executor's request-verify and the container's own
// state check (suspendCustomer / resumeCustomer) are the lines that hold.
import { describeRequest } from './request-state'

export type LifecycleKind = 'suspend' | 'resume'

export interface NewestRequest {
  kind: string
  state: string
  outcome: string | null
  evidenceVerifiedAt: string | null
}

export interface LifecycleOffer {
  suspend: boolean
  resume: boolean
}

/**
 * `status` is the control registry's customer status (null: no such customer).
 *  - active: suspend is offered; resume is not.
 *  - suspended: resume is offered; and, after a suspend request that did not
 *    succeed (the status flips first, the mail principal is revoked afterwards),
 *    or a resume that did not (it issues a fresh principal before the status
 *    flips), suspend again too, because rerunning it converges.
 *  - anything else (provisioning, none): nothing.
 * While the newest request is queued or running nothing is offered.
 */
export function lifecycleOffer(status: string | null, newest: NewestRequest | null): LifecycleOffer {
  const none = { suspend: false, resume: false }
  if (newest && describeRequest({ ...newest, lastStep: null }).active) return none
  if (status === 'active') return { suspend: true, resume: false }
  if (status === 'suspended') {
    // a suspend that did not finish (rerun converges), or a resume that failed after the host issued a
    // fresh principal (suspend revokes it again)
    const halfDone = newest !== null && (newest.kind === 'suspend' || newest.kind === 'resume') && newest.state !== 'succeeded'
    return { suspend: halfDone, resume: true }
  }
  return none
}
