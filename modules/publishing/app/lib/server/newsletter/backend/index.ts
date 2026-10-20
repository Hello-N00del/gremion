// gremion-ui/src/lib/server/newsletter/backend/index.ts
// Task 12 — factory: selects the newsletter backend implementation based on
// the NEWSLETTER_BACKEND environment variable.
//
// Task 23 (old-path decommission): the monolith SQLite backend is REMOVED. The
// newsletter leaf service is now the ONLY implementation:
//   unset / 'service' → ServiceNewsletterClient (HTTP ACL to NEWSLETTER_SERVICE_URL)
//   anything else     → boot/resolve error (fail-closed; resolve.ts maps it to 503)
//
// Call sites obtain the backend once per request / tick scope:
//   const backend = getNewsletterBackend()
//   const newsletters = await backend.listNewsletters()

import { ServiceNewsletterClient } from './service-client'
import { makeLogTracer, noopTracer } from '@gremion/ports/tracer'
import type { NewsletterBackendPort } from './port'

export type { NewsletterBackendPort } from './port'
export type { GroupMemberFetcher } from './port'

/**
 * Resolve the newsletter backend for the current NEWSLETTER_BACKEND env.
 *
 * The default is 'service' (Task 23): the only backend is the HTTP ACL to the
 * newsletter leaf. The service client reads getTenant() on EACH method call
 * (not at construction time) so it can safely be constructed once per request
 * handler.
 *
 * @param correlationId  F3 (T16): optional per-request correlation id forwarded
 *   as x-correlation-id to the leaf AND used to bind the newsletter.acl.<op>
 *   spans emitted when TRACE_EXPORTER=log (default 'none' for the monolith →
 *   noopTracer). Pass event.locals.correlationId from route handlers.
 */
export function getNewsletterBackend(correlationId?: string): NewsletterBackendPort {
  const backend = process.env.NEWSLETTER_BACKEND ?? 'service'

  if (backend === 'service') {
    // F3: build the tracer from TRACE_EXPORTER (default 'none' for the monolith).
    const traceExporter = process.env.TRACE_EXPORTER ?? 'none'
    const tracer =
      traceExporter === 'log' && correlationId ? makeLogTracer(correlationId) : noopTracer
    return new ServiceNewsletterClient({ correlationId, tracer })
  }

  throw new Error(
    `[newsletter-backend] Unknown NEWSLETTER_BACKEND value: '${backend}'. ` +
      "The SQLite path was decommissioned (Task 23); the only valid value is 'service'."
  )
}
