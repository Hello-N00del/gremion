// src/lib/server/governance/register.server.ts
// The governance built-in self-registers the org-unit event RELAY into the
// runtime-registry server-init seam, so hooks.server.ts never imports governance
// event internals. Loaded for its side effects by the generated server-init
// barrel; runServerInitHooks() invokes this at cold start.
//
// The relay drains each ACTIVE tenant's org_unit_event_outbox → the broker
// (gremion.<t>.org-unit.<event>) so a leaf mirror stays in sync. Env-gated on
// NATS_URL read from process.env — the SAME switch enqueueOrgUnitEvent() reads,
// so the outbox can never fill with rows no relay will drain. Non-fatal but not
// silent: a relay that cannot start is retried on a bounded schedule and stays
// visible in /api/health.
import { registerServerInitHook } from '$lib/server/modules/runtime-registry'
import { forEachActiveTenant } from '$lib/server/tenant/worker-fleet'
import { STREAMS } from '@gremion/ports/broker'
import { runOrgUnitRelayPass } from './org-unit-event-relay'
// ONE definition of the relay cadence: the not-draining window is derived from
// it (NOT_DRAINING_THRESHOLD passes), so a change here moves the window too.
import { ORG_UNIT_RELAY_INTERVAL_MS } from './org-unit-event-outbox'
import { superviseWorker, markWorkerOff } from '$lib/server/events/consumer-state'

/** The id the relay reports under in /api/health. */
export const ORG_UNIT_RELAY_WORKER = 'org-unit-relay'

registerServerInitHook(async () => {
  const natsUrl = process.env.NATS_URL
  if (!natsUrl) {
    console.info('[org-unit-relay] NATS_URL not set — relay off')
    markWorkerOff(ORG_UNIT_RELAY_WORKER, 'NATS_URL not set')
    return
  }
  await superviseWorker({
    name: ORG_UNIT_RELAY_WORKER,
    start: async () => {
      const { NatsBroker } = await import('@gremion/ports/nats')
      const broker = await NatsBroker.connect(natsUrl, STREAMS.ORGUNIT.name)
      try {
        await broker.ensureStream(STREAMS.ORGUNIT.name, STREAMS.ORGUNIT.subjects)
      } catch (err) {
        // Close on a failed attempt so retries do not stack connections.
        await broker.close().catch(() => {})
        throw err
      }
      // .unref() so the interval never pins the process on shutdown.
      setInterval(
        () => forEachActiveTenant('org-unit-relay', (ctx) => runOrgUnitRelayPass(ctx.db, ctx.id, broker)),
        ORG_UNIT_RELAY_INTERVAL_MS,
      ).unref()
      console.info('[org-unit-relay] publishing', STREAMS.ORGUNIT.subjects[0])
    },
  })
})
