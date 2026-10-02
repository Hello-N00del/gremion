// gremion-ui/src/lib/server/elections/backend/index.ts
// Factory: selects the votes backend implementation based on the VOTES_BACKEND
// environment variable.
//
//   unset / 'inprocess' → InprocessVotesClient (byte-identical to current behavior)
//   'service'           → ServiceVotesClient (HTTP ACL to VOTES_SERVICE_URL)
//   anything else       → throws (fail-closed)
//
// The default is 'inprocess' until the deliberate (HELD) cutover. Only 'service'
// routes to the votes-service leaf.
//
// Call sites obtain the backend once per request scope:
//   const backend = getVotesBackend({ correlationId: event.locals.correlationId })
//   const { votes, degradedUuids, pollError } = await backend.listVotes(uuids)

import { InprocessVotesClient } from './inprocess-client'
import { ServiceVotesClient } from './service-client'
import { makeLogTracer, noopTracer } from '@gremion/ports/tracer'
import type { VotesBackendPort } from './port'

export type { VotesBackendPort, VotesListResult, CreatePollInput, VoteItem } from './port'
// Re-export the Helios "tracked-but-unreachable" classifier through the seam so
// consumers never import $lib/server/elections/helios-client directly (boundary
// rule no-votes-route-to-helios-client). isHeliosUnavailable is a pure helper.
export { isHeliosUnavailable } from '../helios-client'

export interface GetVotesBackendOptions {
  /** Optional per-request correlation id forwarded as x-correlation-id to the
   *  leaf AND used to bind votes.acl.<op> spans when TRACE_EXPORTER=log. */
  correlationId?: string
}

/**
 * Resolve the votes backend for the current VOTES_BACKEND env.
 *
 * Default is 'inprocess': byte-identical to the monolith HeliosClient +
 * NextcloudPollsClient + aggregator composition. Set VOTES_BACKEND=service to
 * route to the votes-service leaf.
 */
export function getVotesBackend(opts: GetVotesBackendOptions = {}): VotesBackendPort {
  const backend = process.env.VOTES_BACKEND ?? 'inprocess'

  if (backend === 'inprocess') {
    return new InprocessVotesClient()
  }

  if (backend === 'service') {
    const traceExporter = process.env.TRACE_EXPORTER ?? 'none'
    const tracer =
      traceExporter === 'log' && opts.correlationId ? makeLogTracer(opts.correlationId) : noopTracer
    return new ServiceVotesClient({ correlationId: opts.correlationId, tracer })
  }

  throw new Error(
    `[votes-backend] Unknown VOTES_BACKEND value: '${backend}'. ` +
      "Valid values are 'inprocess' (default) or 'service'.",
  )
}
