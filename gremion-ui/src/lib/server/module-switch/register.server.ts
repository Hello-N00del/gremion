// src/lib/server/module-switch/register.server.ts
// The council module switch self-registers its reconciler into the runtime-registry server-init
// seam (Karenz phase 1, Task 13). Loaded for its side effects by the generated server-init barrel;
// runServerInitHooks() invokes it at cold start. (governance/register.server.ts is not used: this is
// the kernel's own worker and does not depend on the governance module.)
//
// One tick every MODULE_SWITCH_INTERVAL_MS per ACTIVE tenant through the worker-fleet seam (explicit
// tenant scope, single-flight per tenant, one tenant's failure never stops the rest). A tick on a
// tenant with no pending switch is one cheap SELECT on the tenant database and, once a minute, one read of the
// platform enablement state (the board follows it); the platform requests are read only on the sweep interval.
//
// Gated on the council requester pool: PLATFORM_MODULES_DATABASE_URL empty or unset (deploy wiring
// leaves it empty when UI_MODULES_DB_PASSWORD is unset) means self-service switching is off on this
// deployment and there is nothing to reconcile. Non-fatal either way: the app serves everything
// else without this worker.
import { registerServerInitHook } from '$lib/server/modules/runtime-registry'
import { forEachActiveTenant } from '$lib/server/tenant/worker-fleet'
import { CouncilNotConfigured, getCouncilDb } from './council-db'
import { registerSwitchOffGuard } from './guards'
import { calendarLeafSwitchOffGuard } from './leaf-guards'
import { MODULE_SWITCH_INTERVAL_MS, runModuleSwitchPass } from './reconciler'

/** The id the reconciler reports under in logs and single-flight. */
export const MODULE_SWITCH_WORKER = 'module-switch'

// Unconditional (not inside the hook below): the guard answers the switch service, which runs whether or
// not the reconciler does. See leaf-guards.ts for why a leaf-backed calendar may not be switched off yet.
registerSwitchOffGuard('calendar', calendarLeafSwitchOffGuard())

registerServerInitHook(() => {
  try {
    getCouncilDb()
  } catch (err) {
    if (err instanceof CouncilNotConfigured) {
      console.info('[module-switch] PLATFORM_MODULES_DATABASE_URL not set - module self-service reconciler off; a platform disable of the board is not followed either (modules/board/README.md)')
    } else {
      console.error('[module-switch] the council pool could not be created - reconciler off:', err instanceof Error ? err.message : err)
    }
    return
  }
  // .unref() so the interval never pins the process on shutdown.
  setInterval(() => forEachActiveTenant(MODULE_SWITCH_WORKER, (ctx) => runModuleSwitchPass(ctx)), MODULE_SWITCH_INTERVAL_MS).unref()
  console.info('[module-switch] reconciler running every', MODULE_SWITCH_INTERVAL_MS, 'ms per active tenant')
})
