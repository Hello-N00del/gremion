// Whether the customer page's "Module" section can queue an action (TRD-044,
// PRD-OPS-004): enable_module, disable_module, record_dpia and reconcile act on
// an ACTIVE customer and only while none of its requests is queued or running.
// Pure and shared by the page load (which buttons to draw) and the actions (the
// 409 gate), so the two cannot disagree. request-verify and the container's own
// checks (customer state, the level-1 gate) are the lines that hold.
import type { NewestRequest } from './lifecycle'
import { describeRequest } from './request-state'

export type ModuleKind = 'enable_module' | 'disable_module' | 'record_dpia' | 'reconcile'

export function moduleActionsOffered(status: string | null, newest: NewestRequest | null): boolean {
  if (status !== 'active') return false
  return !(newest && describeRequest({ ...newest, lastStep: null }).active)
}
