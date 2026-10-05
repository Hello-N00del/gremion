// src/lib/server/tenant/host-mismatch-log.ts
// TASK-041 (L3-08; TRD-076): "a deliberate host mismatch is emitted as a
// structured application-log event naming the timestamp and the rejected host".
//
// TASK-077 G6: the bounded emitter (event names, dedupe, 1024-key memory bound,
// 60-lines-per-window flood cap, never-throws) moved, unchanged, to
// packages/tenancy-core/src/host-mismatch-log.ts, where the sink is REQUIRED.
// This file supplies gremion-ui's sink: the tlog seam (one JSON line on
// console.warn), exactly the default it had before the move, so every caller
// and host-mismatch-log.test.ts see the same behaviour.
import { tlog, type TLogFieldValue } from '$lib/server/observability/tenant-log'
import {
  createHostRejectionLog as createCoreHostRejectionLog,
  type HostRejectionLog,
  type HostRejectionLogDeps as CoreHostRejectionLogDeps,
} from '@gremion/tenancy-core/host-mismatch-log'

export {
  DEDUPE_WINDOW_MS,
  HOST_REJECTED_EVENT,
  HOST_REJECTED_FLOOD_EVENT,
  MAX_DEDUPE_KEYS,
  MAX_LINES_PER_WINDOW,
  MAX_LOGGED_HOST_CHARS,
} from '@gremion/tenancy-core/host-mismatch-log'
export type { HostRejectionLog, HostRejectReason } from '@gremion/tenancy-core/host-mismatch-log'

type Fields = Record<string, TLogFieldValue>

export interface HostRejectionLogDeps extends Omit<CoreHostRejectionLogDeps, 'emit'> {
  /** Where a line goes; defaults to tlog('warn', msg, fields). */
  emit?: (msg: string, fields: Fields) => void
}

const defaultEmit = (msg: string, fields: Fields): void => tlog('warn', msg, fields)

export function createHostRejectionLog(deps: HostRejectionLogDeps = {}): HostRejectionLog {
  return createCoreHostRejectionLog({ ...deps, emit: deps.emit ?? defaultEmit })
}

/** The process-wide emitter the resolver uses. */
export const logHostRejection: HostRejectionLog = createHostRejectionLog()
