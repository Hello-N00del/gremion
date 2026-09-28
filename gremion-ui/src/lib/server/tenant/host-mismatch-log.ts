// src/lib/server/tenant/host-mismatch-log.ts
// TASK-041 (L3-08; TRD-076): "a deliberate host mismatch is emitted as a
// structured application-log event naming the timestamp and the rejected host".
//
// The tenant resolver calls `logHostRejection(reason, host)` on EVERY host-path
// 404, after the decision and before the return. The line is
//
//   {"level":"warn","msg":"tenant.host.rejected","tenant":null,
//    "ts":"<RFC 3339 UTC>","host":"<host>","reason":"<reason>"[,"suppressed":n]}
//
// written through the tlog seam (one JSON line, so the host can never break the
// line or forge a second record). `host` is the normalised host, or -- for a
// header that does not normalise -- the raw value truncated to 253 characters.
// Neither 503 (suspended tenant, registry unreachable) emits: those are not a
// host mismatch.
//
// The host is attacker-chosen, so the emitter is bounded on three axes (OWASP
// Logging Cheat Sheet, "Attacks on Logs": flooding and injection), all within
// TRD-076's 5-minute visibility window:
//   * dedupe -- one line per (reason, host) per 60 s per process; the first line
//     after the window carries `suppressed:<n>` for the repeats it swallowed;
//   * memory -- the dedupe map holds at most 1024 keys; when full, the oldest
//     insertion is evicted;
//   * volume -- at most 60 event lines per 60 s window per process; beyond that
//     lines are dropped, and ONE `tenant.host.rejected.flood` line per window
//     reports `dropped:<n>` when the window closes (a timer, or the next event
//     after it, whichever comes first).
//
// It NEVER throws: a logging failure must not turn a 404 into a 500.
// Alerting on these lines is TASK-039's (TRD-182); Traefik's own no-router 404s
// are in its access log, not here.
import { tlog, type TLogFieldValue } from '$lib/server/observability/tenant-log'

export type HostRejectReason = 'unparseable' | 'unbound' | 'inactive' | 'forged'

export const HOST_REJECTED_EVENT = 'tenant.host.rejected'
export const HOST_REJECTED_FLOOD_EVENT = 'tenant.host.rejected.flood'
/** The dedupe window and the volume window are the same 60 s. */
export const DEDUPE_WINDOW_MS = 60_000
export const MAX_DEDUPE_KEYS = 1024
export const MAX_LINES_PER_WINDOW = 60
/** RFC 1035 presentation-form maximum; a longer value was never a host. */
export const MAX_LOGGED_HOST_CHARS = 253

type Fields = Record<string, TLogFieldValue>

export interface HostRejectionLogDeps {
  /** Epoch milliseconds. */
  now?: () => number
  /** Where a line goes; defaults to tlog('warn', msg, fields). */
  emit?: (msg: string, fields: Fields) => void
  /** Run `fn` once after `ms`; defaults to an unref'd setTimeout. */
  schedule?: (fn: () => void, ms: number) => void
}

export interface HostRejectionLog {
  (reason: HostRejectReason, host: string | null | undefined): void
  /** Keys currently held by the dedupe map (for the bound's test). */
  size(): number
}

const defaultEmit = (msg: string, fields: Fields): void => tlog('warn', msg, fields)
const defaultSchedule = (fn: () => void, ms: number): void => {
  const t = setTimeout(fn, ms)
  // Never keep the process alive for a log line.
  ;(t as { unref?: () => void }).unref?.()
}

export function createHostRejectionLog(deps: HostRejectionLogDeps = {}): HostRejectionLog {
  const now = deps.now ?? Date.now
  const emit = deps.emit ?? defaultEmit
  const schedule = deps.schedule ?? defaultSchedule

  /** (reason, host) -> when its last line was written and what it swallowed since. */
  const seen = new Map<string, { at: number; suppressed: number }>()
  let windowStart = Number.NEGATIVE_INFINITY
  let linesInWindow = 0
  let droppedInWindow = 0
  let floodFlushScheduledFor = Number.NaN

  const safeEmit = (msg: string, fields: Fields): void => {
    try {
      emit(msg, fields)
    } catch {
      // A sink that throws (closed stderr, a broken transport) is swallowed.
    }
  }

  /** Report the window's drops, once, and zero the counter. */
  const closeWindow = (at: number): void => {
    if (droppedInWindow === 0) return
    const dropped = droppedInWindow
    droppedInWindow = 0
    safeEmit(HOST_REJECTED_FLOOD_EVENT, { ts: new Date(at).toISOString(), dropped })
  }

  const roll = (t: number): void => {
    if (t - windowStart < DEDUPE_WINDOW_MS) return
    closeWindow(t)
    windowStart = t
    linesInWindow = 0
  }

  const log = ((reason: HostRejectReason, host: string | null | undefined): void => {
    try {
      const t = now()
      roll(t)
      const shown = (host ?? '').slice(0, MAX_LOGGED_HOST_CHARS)
      const key = `${reason}\u0000${shown}`

      const prev = seen.get(key)
      if (prev && t - prev.at < DEDUPE_WINDOW_MS) {
        prev.suppressed++
        return
      }

      if (linesInWindow >= MAX_LINES_PER_WINDOW) {
        droppedInWindow++
        if (floodFlushScheduledFor !== windowStart) {
          floodFlushScheduledFor = windowStart
          const w = windowStart
          schedule(
            () => {
              try {
                // Only if that window is still open: a later event may already
                // have rolled it and reported the drops itself.
                if (windowStart === w) closeWindow(now())
              } catch {
                // never throws, not even from a timer
              }
            },
            Math.max(0, w + DEDUPE_WINDOW_MS - t),
          )
        }
        return
      }

      linesInWindow++
      const fields: Fields = { ts: new Date(t).toISOString(), host: shown, reason }
      if (prev && prev.suppressed > 0) fields.suppressed = prev.suppressed
      // Re-insert so Map order is insertion order of the LATEST line; evict the
      // oldest insertion while full.
      seen.delete(key)
      while (seen.size >= MAX_DEDUPE_KEYS) {
        const oldest = seen.keys().next()
        if (oldest.done) break
        seen.delete(oldest.value)
      }
      seen.set(key, { at: t, suppressed: 0 })
      safeEmit(HOST_REJECTED_EVENT, fields)
    } catch {
      // The emitter never throws.
    }
  }) as HostRejectionLog
  log.size = () => seen.size
  return log
}

/** The process-wide emitter the resolver uses. */
export const logHostRejection: HostRejectionLog = createHostRejectionLog()
