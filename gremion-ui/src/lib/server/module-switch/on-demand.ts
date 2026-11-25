// src/lib/server/module-switch/on-demand.ts
// One reconciler pass for one tenant, run by a REQUEST (the module settings page asks for it while a switch is
// pending, so the gate follows a request that has succeeded within one poll instead of the next timer tick).
//
// It is the timer's work and meets the timer's guards, through the same worker-fleet seam and under the same
// worker id:
//   - the worker gate: during a release the background workers are safe in ONE process only, so a colour whose
//     gate file says `off` must not write config.modules, run the replay hooks or migrate. A request on that
//     colour reads what the other colour has written;
//   - the single-flight per (worker, tenant): the pass is not safe to overlap with itself (the alignment checks and
//     sets its "done" mark around awaits), so a request never runs beside the timer's tick or another request.
// When a guard says no, nothing runs and the caller carries on with what is stored.
import type { TenantContext } from '$lib/server/tenant/context'
import { runTenantTickNow, type TickNowResult } from '$lib/server/tenant/worker-fleet'
import { runModuleSwitchPass } from './reconciler'
import { MODULE_SWITCH_WORKER } from './worker-id'

export function runModuleSwitchPassNow(tenant: TenantContext): Promise<TickNowResult<Awaited<ReturnType<typeof runModuleSwitchPass>>>> {
  return runTenantTickNow(MODULE_SWITCH_WORKER, tenant, (ctx) => runModuleSwitchPass(ctx))
}
