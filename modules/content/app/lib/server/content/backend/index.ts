// gremion-ui/src/lib/server/content/backend/index.ts
// Task 4 — factory: selects the content backend implementation based on
// the CONTENT_BACKEND environment variable.
//
// Default behavior (flag OFF): 'inprocess' → byte-identical to current
// implementation (InprocessContentClient wraps content-db exports).
//
// Explicit cutover: set CONTENT_BACKEND='service' + CONTENT_SERVICE_URL to
// switch to the HTTP ACL client (ServiceContentClient).
//
// Call sites obtain the backend once per request / tick scope:
//   const backend = getContentBackend(event.locals.correlationId)
//   const posts = await backend.listPosts()

import { InprocessContentClient } from './inprocess-client'
import { ServiceContentClient } from './service-client'
import { makeLogTracer, noopTracer } from '@gremion/ports/tracer'
import type { ContentBackendPort } from './port'

export type { ContentBackendPort } from './port'
export type {
  ChannelId,
  ChannelStatus,
  ClaimResult,
  DeliveryClaim,
  MailingList,
  MailingListMember,
  MediaRole,
  Post,
  PostChannel,
  PostMedia,
  PostRecipient,
  Publication,
  PublishOp,
} from './port'

/**
 * Resolve the content backend for the current CONTENT_BACKEND env.
 *
 * The default is 'inprocess' (branch-by-abstraction OFF): delegates to
 * content-db exports, maintaining byte-identical behavior until explicit cutover.
 * The inprocess client reads getTenant() on EACH method call so it can safely be
 * constructed once per request handler.
 *
 * @param correlationId  F3 (T16): optional per-request correlation id forwarded
 *   as x-correlation-id to the leaf AND used to bind the content.acl.<op>
 *   spans emitted when TRACE_EXPORTER=log (default 'none' for the monolith →
 *   noopTracer). Pass event.locals.correlationId from route handlers.
 */
export function getContentBackend(correlationId?: string): ContentBackendPort {
  const backend = process.env.CONTENT_BACKEND ?? 'inprocess'

  if (backend === 'inprocess') {
    return new InprocessContentClient()
  }

  if (backend === 'service') {
    // F3: build the tracer from TRACE_EXPORTER (default 'none' for the monolith).
    const traceExporter = process.env.TRACE_EXPORTER ?? 'none'
    const tracer =
      traceExporter === 'log' && correlationId ? makeLogTracer(correlationId) : noopTracer
    return new ServiceContentClient({ correlationId, tracer })
  }

  throw new Error(`[content-backend] Unknown CONTENT_BACKEND value: '${backend}'.`)
}
