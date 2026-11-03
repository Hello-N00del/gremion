// src/lib/server/governance/register.server.ts
// The governance module self-registers the org-unit event RELAY into the
// runtime-registry server-init seam, so hooks.server.ts never imports governance
// event internals. Loaded for its side effects by the generated server-init barrel;
// runServerInitHooks() invokes this at cold start.
//
// The relay drains each ACTIVE tenant's org_unit_event_outbox into NATS
// (gremion.<t>.org-unit.<event>) so the finance org_unit_mirror stays in sync. It
// publishes whether or not the finance module is enabled: the kernel owns the event.
// Env-gated on NATS_URL (a deployment-global, read through platformEnv): absent ->
// relay stays OFF (the choke-point enqueue is likewise a no-op, so the outbox never
// fills). Non-fatal: a relay that won't start must not block the whole app.
import { registerServerInitHook } from '$lib/server/modules/runtime-registry'
import { forEachActiveTenant } from '$lib/server/tenant/worker-fleet'
import { platformEnv } from '$lib/server/env/platform-env'
import { STREAMS } from '@gremion/ports/broker'
import { runOrgUnitRelayPass } from './org-unit-event-relay'
// ONE definition of the relay cadence: the not-draining window is derived from
// it (NOT_DRAINING_THRESHOLD passes), so a change here must move the window too.
import { ORG_UNIT_RELAY_INTERVAL_MS } from './org-unit-event-outbox'
import { superviseWorker, markWorkerOff } from '$lib/server/events/consumer-state'
import { getKeycloakAdminClientForCurrentTenant } from '$lib/server/keycloak-admin'
import { drainRoleBackfill, ROLE_BACKFILL_INTERVAL_MS } from './vorstand-backfill'

/** The id the relay reports under in worker states. */
export const ORG_UNIT_RELAY_WORKER = 'org-unit-relay'

registerServerInitHook(async () => {
  const natsUrl = platformEnv('NATS_URL')
  if (!natsUrl) {
    console.info('[org-unit-relay] NATS_URL not set - relay off')
    markWorkerOff(ORG_UNIT_RELAY_WORKER, 'NATS_URL not set')
    return
  }
  // Non-fatal (the app serves plenty that does not depend on the relay), but not
  // SILENT: a relay that cannot start is retried on a bounded schedule and, if it
  // never comes up, stays visible in the worker states. The broker is closed on a
  // failed attempt so retries do not stack connections.
  await superviseWorker({
    name: ORG_UNIT_RELAY_WORKER,
    start: async () => {
      const { NatsBroker } = await import('@gremion/ports/nats')
      const broker = await NatsBroker.connect(natsUrl, STREAMS.ORGUNIT.name)
      try {
        await broker.ensureStream(STREAMS.ORGUNIT.name, STREAMS.ORGUNIT.subjects)
      } catch (err) {
        await broker.close().catch((closeErr: unknown) => {
          console.error('[org-unit-relay] closing the broker after a failed ensureStream failed:', closeErr)
        })
        throw err
      }
      // Drain cadence - the mirror is eventually consistent; a few seconds of lag
      // between an org_units write and the mirror update is acceptable.
      // .unref() so the interval never pins the process on shutdown.
      setInterval(
        () => forEachActiveTenant(ORG_UNIT_RELAY_WORKER, (ctx) => runOrgUnitRelayPass(ctx.db, ctx.id, broker)),
        ORG_UNIT_RELAY_INTERVAL_MS,
      ).unref()
      console.info('[org-unit-relay] publishing', STREAMS.ORGUNIT.subjects[0])
    },
  })
})

/** The id the vorstand role backfill reports under in logs and single-flight. */
export const VORSTAND_BACKFILL_WORKER = 'vorstand-backfill'

// The standard `vorstand` realm role for the people migration 0062 queued (Karenz
// phase 1). Not env-gated: the queue is tenant-local and a pass on an empty queue is
// one cheap SELECT with no Keycloak call. Each tick is a drain per ACTIVE tenant
// through the worker-fleet seam (explicit tenant scope, single-flight per tenant,
// one tenant's failure never stops the rest). The first tick is one interval after
// boot, which also gives the reconcile check time to create the role first.
// .unref() so the interval never pins the process on shutdown.
registerServerInitHook(() => {
  setInterval(
    () =>
      forEachActiveTenant(VORSTAND_BACKFILL_WORKER, (ctx) =>
        drainRoleBackfill(ctx.db, getKeycloakAdminClientForCurrentTenant(), console),
      ),
    ROLE_BACKFILL_INTERVAL_MS,
  ).unref()
})
