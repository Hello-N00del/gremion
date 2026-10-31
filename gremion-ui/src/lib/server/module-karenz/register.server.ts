// src/lib/server/module-karenz/register.server.ts
// Module Karenz (phase 2, Task 8): the per-tenant pass self-registers into the runtime-registry
// server-init seam. Loaded for its side effects by the generated server-init barrel;
// runServerInitHooks() invokes it at cold start.
//
// One tick every KARENZ_PASS_INTERVAL_MS (five minutes) per ACTIVE tenant through the worker-fleet
// seam (explicit tenant scope, single-flight per tenant, one tenant's failure never stops the rest),
// the first one a minute after boot so a restart does not wait a full interval. A tick on a tenant
// with no switch-off is one platform read. Plus a switch listener that runs the pass at once for the
// tenant whose switch just reached it, so a switch-off is not left waiting for the next tick.
//
// Deliberately NOT gated on PLATFORM_MODULES_DATABASE_URL: without the council pool the pass cannot
// read or report anything, and saying so (loudly, when a Karenz is on record) is the pass's job.
// Both blue and green load this file; the step ledger keeps a repeat from redoing finished work.
import { registerServerInitHook } from '$lib/server/modules/runtime-registry'
import { registerModuleSwitchListener } from '$lib/server/module-switch/listeners'
import { runWithTenant } from '$lib/server/tenant/context'
import { resolveTenantBySlug } from '$lib/server/tenant/registry'
import { forEachActiveTenant } from '$lib/server/tenant/worker-fleet'
import { KARENZ_PASS_INTERVAL_MS, runKarenzPass } from './engine'

/** The id the pass reports under in logs and single-flight. */
export const MODULE_KARENZ_WORKER = 'module-karenz'

/** The first tick after boot (the rest follow every KARENZ_PASS_INTERVAL_MS). */
const FIRST_TICK_DELAY_MS = 60_000

registerServerInitHook(() => {
  // Immediately after a switch reached the tenant (the reconciler tells its listeners once).
  registerModuleSwitchListener(async (e) => {
    if (e.outcome !== 'applied') return
    try {
      const ctx = await resolveTenantBySlug(e.slug)
      if (!ctx) return
      await runWithTenant(ctx, () => runKarenzPass(ctx))
    } catch (err) {
      // At-most-once delivery by design: the tick is the safety net.
      console.error(`[module-karenz] the immediate pass for ${e.slug} failed (the next tick retries):`, err instanceof Error ? err.message : err)
    }
  })
  const tick = () => forEachActiveTenant(MODULE_KARENZ_WORKER, (ctx) => runKarenzPass(ctx))
  // .unref() so the timers never pin the process on shutdown.
  setTimeout(tick, FIRST_TICK_DELAY_MS).unref()
  setInterval(tick, KARENZ_PASS_INTERVAL_MS).unref()
  console.info('[module-karenz] pass running every', KARENZ_PASS_INTERVAL_MS, 'ms per active tenant')
})
