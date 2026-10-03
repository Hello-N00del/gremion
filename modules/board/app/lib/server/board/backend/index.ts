// gremion-ui/src/lib/server/board/backend/index.ts
// T1 — factory: selects the board backend implementation based on the
// BOARD_BACKEND environment variable.
//
//   unset / 'inprocess' → InprocessBoardClient (byte-identical to current behaviour)
//   'service'           → ServiceBoardClient (HTTP ACL to BOARD_SERVICE_URL)
//   anything else       → throws (fail-closed)
//
// The default is 'inprocess' until the deliberate (HELD) cutover. Only 'service'
// routes to the leaf. Call sites obtain the backend once per request scope:
//   const backend = getBoardBackend(event.locals.correlationId)

import { InprocessBoardClient } from './inprocess-client'
import { ServiceBoardClient } from './service-client'
import { makeLogTracer, noopTracer } from '@gremion/ports/tracer'
import type { BoardBackendPort } from './port'

export type {
  BoardBackendPort,
  Board,
  Stack,
  Card,
  CreateCardInput,
  MoveCardTarget,
  PromoteActionItemInput,
  Deck,
  CreateBoardInput,
  CreatedBoard,
  CreateStackInput,
} from './port'

/**
 * Resolve the board backend for the current BOARD_BACKEND env.
 *
 * Default is 'inprocess': byte-identical to the monolith boardDb calls.
 * Set BOARD_BACKEND=service to route to the board leaf service.
 *
 * @param correlationId Optional per-request correlation id forwarded as
 *   x-correlation-id to the leaf AND used to bind board.acl.<op> spans emitted
 *   when TRACE_EXPORTER=log (default 'none' → noopTracer).
 */
export function getBoardBackend(correlationId?: string): BoardBackendPort {
  const backend = process.env.BOARD_BACKEND ?? 'inprocess'

  if (backend === 'inprocess') {
    return new InprocessBoardClient()
  }

  if (backend === 'service') {
    const traceExporter = process.env.TRACE_EXPORTER ?? 'none'
    const tracer =
      traceExporter === 'log' && correlationId ? makeLogTracer(correlationId) : noopTracer
    return new ServiceBoardClient({ correlationId, tracer })
  }

  throw new Error(
    `[board-backend] Unknown BOARD_BACKEND value: '${backend}'. ` +
      "Valid values are 'inprocess' (default) or 'service'.",
  )
}
