// gremion-ui/src/lib/server/board/backend/index.ts
// T1 — factory: selects the board backend implementation based on the
// BOARD_BACKEND environment variable.
//
//   unset / 'auto' → RoutedBoardBackend: per call, the customer's location flag decides
//                    between the kernel tables and the board service (location.ts)
//   'inprocess'    → InprocessBoardClient, forced (tests, an operator override); ignores the flag
//   'service'      → ServiceBoardClient, forced (the leaf's own test environment); ignores the flag
//   anything else  → throws (fail-closed)
//
// The default is 'auto', so a process that has no setting at all still reads the flag instead
// of ignoring it. The factory stays SYNCHRONOUS: the flag is awaited inside the router's methods.
// Call sites obtain the backend once per request scope:
//   const backend = getBoardBackend(event.locals.correlationId)

import { InprocessBoardClient } from './inprocess-client'
import { ServiceBoardClient } from './service-client'
import { RoutedBoardBackend } from './routed-client'
import { makeLogTracer, noopTracer } from '@gremion/ports/tracer'
import type { BoardBackendPort } from './port'

export {
  getBoardLocation,
  BoardUnavailableError,
  BoardMovingError,
  BoardLocationUnreadableError,
  BOARD_LOCATION_CACHE_TTL_MS,
  BOARD_MOVE_STALE_S,
  type BoardLocation,
} from './location'

export type {
  BoardBackendPort,
  Board,
  Stack,
  Card,
  CreateCardInput,
  MoveCardTarget,
  UpdateCardPatch,
  PromoteActionItemInput,
  Deck,
  CreateBoardInput,
  CreatedBoard,
  CreateStackInput,
} from './port'

/**
 * Resolve the board backend for the current BOARD_BACKEND env.
 *
 * Default is 'auto': the router, which follows each customer's location flag.
 * BOARD_BACKEND=inprocess or =service forces one client and ignores the flag.
 *
 * @param correlationId Optional per-request correlation id forwarded as
 *   x-correlation-id to the leaf AND used to bind board.acl.<op> spans emitted
 *   when TRACE_EXPORTER=log (default 'none' → noopTracer).
 */
export function getBoardBackend(correlationId?: string): BoardBackendPort {
  const backend = process.env.BOARD_BACKEND ?? 'auto'

  if (backend === 'inprocess') {
    return new InprocessBoardClient()
  }

  if (backend === 'service') {
    return new ServiceBoardClient({ correlationId, tracer: tracerFor(correlationId) })
  }

  if (backend === 'auto') {
    return new RoutedBoardBackend({ correlationId, tracer: tracerFor(correlationId) })
  }

  throw new Error(
    `[board-backend] Unknown BOARD_BACKEND value: '${backend}'. ` +
      "Valid values are 'auto' (default), 'inprocess' or 'service'.",
  )
}

function tracerFor(correlationId: string | undefined) {
  const traceExporter = process.env.TRACE_EXPORTER ?? 'none'
  return traceExporter === 'log' && correlationId ? makeLogTracer(correlationId) : noopTracer
}
