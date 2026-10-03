// gremion-ui/src/lib/server/messages/backend/index.ts
// Factory: selects the messages+video backend implementation based on the
// MESSAGES_BACKEND environment variable.
//
//   unset / 'inprocess' → InprocessMessagesClient (byte-identical to current behavior)
//   'service'           → ServiceMessagesClient (HTTP ACL to MESSAGES_SERVICE_URL)
//   anything else       → throws (fail-closed)
//
// The default is 'inprocess' until the deliberate (HELD) cutover. Only 'service'
// routes to the messages-service leaf. Call sites obtain the backend once per
// request scope:
//   const backend = getMessagesBackend()
//   const mc = backend.matrix()

import { InprocessMessagesClient } from './inprocess-client'
import { ServiceMessagesClient } from './service-client'
import type { MessagesBackendPort } from './port'

export type {
  MessagesBackendPort,
  MatrixClientPort,
  SynapseAdminPort,
  LivekitPort,
  MatrixCreds,
  MintTokenOptions,
  SyncResponse,
  MatrixMessage,
  MatrixRoom,
} from './port'
export { MessagesServiceError } from './service-client'

export interface GetMessagesBackendOptions {
  /** Optional per-request correlation id forwarded as x-correlation-id to the leaf. */
  correlationId?: string
}

/**
 * Resolve the messages+video backend for the current MESSAGES_BACKEND env.
 *
 * Default is 'inprocess': byte-identical to the monolith Matrix/LiveKit/Synapse
 * client paths. Set MESSAGES_BACKEND=service to route to the messages-service leaf.
 */
export function getMessagesBackend(opts: GetMessagesBackendOptions = {}): MessagesBackendPort {
  const backend = process.env.MESSAGES_BACKEND ?? 'inprocess'

  if (backend === 'inprocess') {
    return new InprocessMessagesClient()
  }

  if (backend === 'service') {
    return new ServiceMessagesClient({ correlationId: opts.correlationId })
  }

  throw new Error(
    `[messages-backend] Unknown MESSAGES_BACKEND value: '${backend}'. ` +
      "Valid values are 'inprocess' (default) or 'service'.",
  )
}
