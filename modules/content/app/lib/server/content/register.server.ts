// src/lib/server/content/register.server.ts
// Civitas Session-A inversion A1: the content module self-registers its
// scheduled-publish drain into the runtime-registry server-init seam, so
// hooks.server.ts never imports content internals. Loaded for its side effects
// by the generated server-init barrel; runServerInitHooks() invokes this at cold
// start.
import { registerServerInitHook } from '$lib/server/modules/runtime-registry'
import { forEachActiveTenant } from '$lib/server/tenant/worker-fleet'
import { drainInstagramPublishOps } from './instagram/drain'
import { drainScheduledPublishes } from './worker'
import { makeLogTracer, noopTracer } from '$lib/server/ports/tracer'
import { defaultTenantEnv } from '$lib/server/tenant/default-env'
import { startContentAuditConsumer, CONTENT_AUDIT_WORKER } from '$lib/server/events/content-audit-consumer'
import { superviseWorker, markWorkerOff } from '$lib/server/events/consumer-state'

// Content Engine L2 (T6): every minute, drain each ACTIVE tenant's scheduled
// content channels (enabled + status='scheduled' + scheduled_at due) through the
// in-kernel publishPost orchestrator. forEachActiveTenant re-establishes the
// per-tenant ALS scope so getDb()/the mail+KC seams resolve THAT tenant; per-row
// try/catch in the worker + per-tenant try/catch in the fleet keep one failure
// from stopping the rest. Restart-safety/idempotency lives in the delivery
// ledger (email) + content.publications (portal), so a still-'scheduled' row is
// simply retried next tick — no double-send. .unref() so the interval doesn't
// pin the process on shutdown.
const CONTENT_PUBLISH_INTERVAL_MS = 60 * 1000

// Cutover guard: when CONTENT_BACKEND=service the content leaf owns scheduled
// publishing (its own SCHEDULER_ENABLED-gated scheduler drains the leaf DB), so
// the in-kernel publish drains MUST NOT register — they'd drive the now-stale
// kernel content schema (a split-brain data path). Mirrors how the newsletter
// cutover removed its in-kernel worker. Read the flag at cold start (before any
// tenant ALS scope). The content-audit consumer below stays in-kernel regardless.
if ((process.env.CONTENT_BACKEND ?? 'inprocess') !== 'service') {
  registerServerInitHook(() => {
    setInterval(
      () => forEachActiveTenant('content-publish', () => drainScheduledPublishes()),
      CONTENT_PUBLISH_INTERVAL_MS,
    ).unref()
  })

  // Content Engine L3 (T4): a SECOND per-minute per-tenant drain reconciles the
  // Instagram publish outbox (content.publish_ops) against the Meta Graph carousel
  // API. It mirrors the scheduled-publish registration above (same forEachActiveTenant
  // ALS re-scope, same .unref()). Shipped INERT: drainInstagramPublishOps() returns
  // immediately when Instagram is not configured (no credentials = the shipping
  // default), so this interval is a no-op until activation flips credentials on.
  registerServerInitHook(() => {
    setInterval(
      () =>
        forEachActiveTenant('content-instagram-publish', () => drainInstagramPublishOps()),
      CONTENT_PUBLISH_INTERVAL_MS,
    ).unref()
  })
}

// Task 12: content-event → audit_log consumer. Env-gated on NATS_URL — absent
// → consumer stays off (staging-safe until Task 17 wires compose). Non-fatal:
// a consumer that won't start must not block the whole app.
//
// TRACE_EXPORTER default is 'none' for the monolith. When 'log',
// content.audit.consume spans emit to stdout. The audit consumer is long-lived
// — its tracer uses a static 'monolith' correlation id for the span binding
// (correlationId is per-envelope in the span attributes, not the tracer's bind
// point for this long-lived consumer).
registerServerInitHook(async () => {
  const natsUrl = defaultTenantEnv('NATS_URL')
  if (!natsUrl) {
    console.info('[content-audit-consumer] NATS_URL not set — consumer off')
    markWorkerOff(CONTENT_AUDIT_WORKER, 'NATS_URL not set')
    return
  }
  const auditTraceExporter = process.env.TRACE_EXPORTER ?? 'none'
  const auditTracer = auditTraceExporter === 'log' ? makeLogTracer('monolith:content-audit') : noopTracer
  // Still non-fatal, no longer silent: retried on a bounded schedule and, if it
  // never comes up, reported as degraded by /api/health.
  await superviseWorker({
    name: CONTENT_AUDIT_WORKER,
    start: () => startContentAuditConsumer(natsUrl, auditTracer),
  })
})
