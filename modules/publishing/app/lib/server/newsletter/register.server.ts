// src/lib/server/newsletter/register.server.ts
// Civitas Session-A inversion A1: the newsletter module self-registers its
// audit-event consumer into the runtime-registry server-init seam, so
// hooks.server.ts never imports the events/newsletter consumer. Loaded for its
// side effects by the generated server-init barrel; runServerInitHooks() invokes
// this at cold start.
import { registerServerInitHook } from '$lib/server/modules/runtime-registry'
import { makeLogTracer, noopTracer } from '$lib/server/ports/tracer'
import { platformEnv } from '$lib/server/env/platform-env'
import {
  startNewsletterAuditConsumer,
  NEWSLETTER_AUDIT_WORKER,
} from '$lib/server/events/newsletter-audit-consumer'
import { superviseWorker, markWorkerOff } from '$lib/server/events/consumer-state'

// T15 (P1 / D-P1-7): newsletter-event → audit_log consumer. Env-gated on
// NATS_URL — absent → consumer stays off (staging-safe). Non-fatal: a consumer
// that won't start must not block the whole app.
//
// F3 (T16): TRACE_EXPORTER default is 'none' for the monolith (the leaf uses
// 'log'). When 'log', newsletter.audit.consume spans emit to stdout. The audit
// consumer is long-lived — its tracer uses a static 'monolith' correlation id
// for the span binding (correlationId is per-envelope in the span attributes,
// not the tracer's bind point for this long-lived consumer).
registerServerInitHook(async () => {
  const natsUrl = platformEnv('NATS_URL')
  if (!natsUrl) {
    console.info('[newsletter-audit-consumer] NATS_URL not set — consumer off')
    markWorkerOff(NEWSLETTER_AUDIT_WORKER, 'NATS_URL not set')
    return
  }
  const auditTraceExporter = process.env.TRACE_EXPORTER ?? 'none'
  const auditTracer = auditTraceExporter === 'log' ? makeLogTracer('monolith:newsletter-audit') : noopTracer
  // Still non-fatal, no longer silent: retried on a bounded schedule and, if it
  // never comes up, reported as degraded by /api/health.
  await superviseWorker({
    name: NEWSLETTER_AUDIT_WORKER,
    start: () => startNewsletterAuditConsumer(natsUrl, auditTracer),
  })
})
