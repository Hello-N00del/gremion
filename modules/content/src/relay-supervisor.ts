// relay-supervisor.ts — the bounded start ladder the NATS relay loop runs on.
//
// BYTE-IDENTICAL in the calendar, content and newsletter leaves: the three had
// the same ladder copied into main() three times, which is why the same two
// defects existed three times.
//
// It was a closure inside main(), so nothing could observe it. Round 4's
// shutdown seam therefore had no coverage at all — neutralising BOTH
// clearTimeout calls in the leaf's before() hook left 151/151 tests green — and
// the ladder had no stopped flag, so a connect that REJECTED after before() had
// run went straight into the catch and armed a fresh retry timer. That timer
// fires during (or after) closeAllPools(): it opens a broker, and through the
// relay pass a tenant pool, that nothing left alive will ever close.
//
// Two rules, and every one of them is now a test:
//   1. once stop() has run, NO new timer is armed and no pending one survives;
//   2. an in-flight connect that SUCCEEDS after stop() tears down the broker it
//      opened rather than leaving it behind the drain.

/** Backoff between broker start attempts. The LAST value is the cap. */
export const BROKER_RETRY_DELAYS_MS = [5_000, 15_000, 60_000, 300_000] as const

/**
 * Total start attempts (the first plus the retries). Finite on purpose: an
 * unclearable failure must end up as one loud line, not an infinite log.
 */
export const MAX_BROKER_START_ATTEMPTS = 5

export interface RelaySupervisorDeps {
  /** Leaf name for the log lines, e.g. 'calendar'. */
  name: string
  /**
   * ONE start attempt: connect, bind the stream and arm the relay interval.
   * Rejecting is a failed attempt and enters the ladder (unless `isUnretryable`
   * claims it).
   */
  start: () => Promise<void>
  /**
   * Drop whatever an attempt left behind — the half-open broker and the relay
   * interval. Called on a FAILED attempt (a retry that kept the connection
   * would stack one per attempt), on an attempt that lands after stop(), and
   * from stop() itself. Must be safe to call when there is nothing to drop.
   */
  teardown: () => void
  /**
   * A failure the ladder must NOT retry — the repoint refusal, where the stream
   * is still on a root this leaf can never publish to. Retrying that is a silent
   * outage; the caller ends the process and names the migration command.
   */
  isUnretryable: (err: unknown) => boolean
  onUnretryable: (err: unknown) => void
  delaysMs?: readonly number[]
  maxAttempts?: number
  warn?: (msg: string) => void
  error?: (msg: string) => void
  /** Injectable for tests; the default unrefs so a pending retry never holds the process open. */
  schedule?: (fn: () => void, ms: number) => unknown
  cancel?: (timer: unknown) => void
}

export interface RelaySupervisor {
  /** Start attempt #1. Never rejects: every outcome is a logged branch. */
  start(): Promise<void>
  /**
   * The shutdown seam, called from createShutdown's before(). Cancels a pending
   * retry, refuses to arm any new one, and tears down whatever is open.
   */
  stop(): void
  /** Attempts consumed so far. */
  attempts(): number
  /** Is a retry timer armed? */
  retryPending(): boolean
}

function defaultSchedule(fn: () => void, ms: number): unknown {
  const t = setTimeout(fn, ms)
  if (typeof (t as { unref?: () => void }).unref === 'function') {
    ;(t as { unref: () => void }).unref()
  }
  return t
}

export function createRelaySupervisor(deps: RelaySupervisorDeps): RelaySupervisor {
  const delays = deps.delaysMs ?? BROKER_RETRY_DELAYS_MS
  const maxAttempts = deps.maxAttempts ?? MAX_BROKER_START_ATTEMPTS
  const warn = deps.warn ?? ((m: string) => console.warn(m))
  const error = deps.error ?? ((m: string) => console.error(m))
  const schedule = deps.schedule ?? defaultSchedule
  const cancel = deps.cancel ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>))

  let attempts = 0
  let timer: unknown = null
  /** Set by stop(). Nothing arms a timer or keeps a broker once this is true. */
  let relayStopped = false

  function clearPending(): void {
    if (timer !== null) {
      cancel(timer)
      timer = null
    }
  }

  async function attempt(): Promise<void> {
    // A retry that was already in flight when stop() ran must not connect.
    if (relayStopped) return
    attempts += 1
    try {
      await deps.start()
      // The connect RESOLVED after the drain began. The broker (and the relay
      // interval it armed) belong to a process that is shutting down: close them
      // here, because nothing else is left to.
      if (relayStopped) deps.teardown()
    } catch (err) {
      if (deps.isUnretryable(err)) {
        deps.onUnretryable(err)
        return
      }
      // Not the refusal: the leaf STAYS UP. Drop any half-open connection first —
      // a retry that kept it would stack one per attempt.
      deps.teardown()
      // THE ROUND-4 DEFECT: this branch re-armed the timer unconditionally, so a
      // connect that rejected after before() had run put a broker back on the
      // schedule behind the pool drain.
      if (relayStopped) return
      const detail = err instanceof Error ? err.message : String(err)
      if (attempts >= maxAttempts) {
        error(
          `[${deps.name}] NATS relay failed ${attempts} times — relay is OFF for the life of this process. ` +
            'The leaf keeps serving HTTP; its outbox will drain when it is restarted against a reachable ' +
            `broker. Last error: ${detail}`,
        )
        return
      }
      const delay = delays[Math.min(attempts - 1, delays.length - 1)]!
      warn(
        `[${deps.name}] NATS relay start attempt ${attempts}/${maxAttempts} failed — relay is OFF, ` +
          `retrying in ${delay}ms: ${detail}`,
      )
      clearPending()
      timer = schedule(() => {
        timer = null
        void attempt()
      }, delay)
    }
  }

  return {
    start: attempt,
    stop(): void {
      relayStopped = true
      clearPending()
      deps.teardown()
    },
    attempts: () => attempts,
    retryPending: () => timer !== null,
  }
}
