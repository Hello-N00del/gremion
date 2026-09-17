// gremion-ui/src/lib/server/events/consumer-state.ts
//
// What this process knows about its background event workers — the three audit
// consumers and the org-unit relay — and what it does when one of them dies.
//
// WHY THIS EXISTS. The monolith's boot hooks are deliberately non-fatal: a
// consumer that will not start must not take the whole app down, because the app
// serves a great deal that has nothing to do with NATS. Round 1 kept that
// property and lost everything else with it. A failed consumer:
//   - had already set its module-level `_started = true` BEFORE awaiting the
//     boot, so nothing could ever start it again in that process — the latch
//     recorded an intention, not an outcome;
//   - left its NatsBroker connected, so a retry would have stacked connections;
//   - was reported only as one line on stderr, so /api/health answered a
//     confident 200 for a process whose audit trail had stopped;
//   - never retried, so a NATS that came up thirty seconds after the app was a
//     permanent outage.
//
// The two halves here are one concern: the phase a worker is in IS what the
// restart schedule advances, and it is what the health body reports.
//
// The restart schedule is BOUNDED on both axes — the backoff is capped and the
// attempts are finite. An unbounded retry against a stream that is still on the
// retired wire root is an infinite loop of identical StreamCoverErrors; giving
// up and STAYING degraded is what puts the failure in the health body where an
// operator (or a probe) can see it, instead of in a log that scrolls.

/** Where a background worker is. `off` means "not configured", not "broken". */
export type WorkerPhase = 'off' | 'starting' | 'running' | 'degraded'

/**
 * The stable, enumerable verdicts a worker failure falls into. This is what an
 * operator actually routes on — `stream-repoint-refused` and `stream-cover` both
 * mean "run the migration", `stream-gone`/`consumer-gone` mean "the server lost
 * the topology", `unknown` means "read the log".
 */
export type WorkerFaultCode =
  | 'stream-repoint-refused'
  | 'stream-cover'
  | 'stream-gone'
  | 'consumer-gone'
  | 'consumer-stalled'
  | 'stream-missing'
  | 'setup-timeout'
  | 'unknown'

export interface WorkerFault {
  /** The error's constructor name — 'StreamCoverError', 'Error', 'NonError'. */
  readonly errorClass: string
  readonly code: WorkerFaultCode
}

export interface WorkerState {
  /** Stable id, e.g. 'calendar-audit-consumer'. */
  readonly name: string
  readonly phase: WorkerPhase
  /**
   * WHY it is degraded, as a CLASS and a CODE — never the underlying message.
   *
   * This state is serialised verbatim onto `/api/health`, which is
   * unauthenticated. A broker message is not a safe thing to put there: the
   * repoint refusal carries both subject filters (i.e. the deployment's wire
   * root and its stream topology), a connect failure carries the broker's
   * host:port, and a credential failure carries whatever the client was
   * configured with. The full message is still logged server-side by
   * superviseWorker's `error` — it just does not leave the process this way.
   */
  readonly errorClass?: string
  readonly code?: WorkerFaultCode
  /** How many start attempts have been made, successful or not. */
  readonly attempts: number
  /** ISO timestamp of the last phase change. */
  readonly since: string
}

/**
 * Reduce a thrown value to the class + code pair the surface carries.
 *
 * Classification is by the kernel's own error CLASS first (broker.ts exports
 * StreamCoverError, StreamGoneError, ConsumerGoneError, …); the repoint refusal
 * is the one verdict the kernel throws as a plain `Error`, so it is matched on
 * its stable message prefix. A non-Error throw becomes 'NonError' and its text
 * is dropped entirely — a string thrown from a client library is exactly the
 * kind of value that turns out to hold a connection URL.
 */
export function classifyWorkerError(err: unknown): WorkerFault {
  if (!(err instanceof Error)) return { errorClass: 'NonError', code: 'unknown' }
  const errorClass = err.name || 'Error'
  const byClass: Record<string, WorkerFaultCode> = {
    StreamCoverError: 'stream-cover',
    StreamGoneError: 'stream-gone',
    StreamRepointedError: 'stream-gone',
    ConsumerGoneError: 'consumer-gone',
    ConsumerStalledError: 'consumer-stalled',
    NoStreamError: 'stream-missing',
    SetupTimeoutError: 'setup-timeout',
  }
  const mapped = byClass[errorClass]
  if (mapped) return { errorClass, code: mapped }
  if (err.message.includes('refusing to repoint stream')) {
    return { errorClass, code: 'stream-repoint-refused' }
  }
  return { errorClass, code: 'unknown' }
}

/** Backoff between restart attempts. The LAST value is the cap. */
export const RESTART_DELAYS_MS = [5_000, 15_000, 60_000, 300_000] as const

/**
 * How many times a worker is started in total (the first boot plus retries).
 * Finite on purpose — see the header.
 */
export const MAX_START_ATTEMPTS = 5

const states = new Map<string, WorkerState>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()
/** The supervisor that owns each worker, so a MID-LIFE fault can restart it on
 *  the same bounded schedule the boot used. Registered by superviseWorker(). */
const supervisors = new Map<string, SuperviseOptions>()

function set(name: string, phase: WorkerPhase, attempts: number, fault?: WorkerFault): WorkerState {
  const next: WorkerState = { name, phase, attempts, since: new Date().toISOString(), ...(fault ?? {}) }
  states.set(name, next)
  return next
}

/** Every worker this process has heard of, in registration order. */
export function getWorkerStates(): WorkerState[] {
  return [...states.values()]
}

export function getWorkerState(name: string): WorkerState | undefined {
  return states.get(name)
}

/** The ones an operator needs to know about. */
export function degradedWorkers(): WorkerState[] {
  return getWorkerStates().filter((s) => s.phase === 'degraded')
}

/**
 * Declare a worker that is deliberately not running (NATS_URL unset, flag off).
 *
 * `_why` stays in the signature for the call sites that document themselves with
 * it, but it is NOT stored: `off` is a configuration, it never reaches the
 * degraded list, and the reason is already on the caller's own boot log line.
 */
export function markWorkerOff(name: string, _why?: string): void {
  set(name, 'off', states.get(name)?.attempts ?? 0)
}

/** Record a live worker. Clears any pending restart for it. */
export function markWorkerRunning(name: string): void {
  const attempts = states.get(name)?.attempts ?? 1
  set(name, 'running', attempts)
}

/**
 * Record a worker that is not doing its job. Used both by a failed boot and by
 * a subscription that dies later.
 */
export function markWorkerDegraded(name: string, err: unknown, attempts?: number): void {
  set(name, 'degraded', attempts ?? states.get(name)?.attempts ?? 0, classifyWorkerError(err))
}

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export interface SuperviseOptions {
  /** Stable worker id — the one that appears in the health body. */
  name: string
  /** One start attempt. Must resolve only once the worker is genuinely live. */
  start: () => Promise<void>
  /** Injected in tests so the schedule can be asserted without waiting for it. */
  schedule?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  log?: (msg: string) => void
  error?: (msg: string, err: unknown) => void
}

/**
 * Start a worker and keep trying, on a bounded schedule, until it is live or
 * the attempts run out.
 *
 * Returns once the FIRST attempt has settled — a boot hook must not block the
 * app for five minutes of backoff — so a caller that awaits it learns whether
 * the worker came up immediately, and the health body carries the answer after
 * that.
 */
export async function superviseWorker(opts: SuperviseOptions): Promise<WorkerState> {
  // Remembered so a MID-LIFE fault restarts the worker the same way its boot
  // did — same start(), same schedule, same bounds.
  supervisors.set(opts.name, opts)
  return attemptStart(opts, 1)
}

async function attemptStart(opts: SuperviseOptions, n: number): Promise<WorkerState> {
  const log = opts.log ?? ((m: string) => console.info(m))
  const error = opts.error ?? ((m: string, err: unknown) => console.error(m, err))
  const schedule =
    opts.schedule ??
    ((fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms)
      // A pending restart must never be the reason a process refuses to exit.
      if (typeof (t as { unref?: () => void }).unref === 'function') (t as { unref: () => void }).unref()
      return t
    })

  set(opts.name, 'starting', n)
  try {
    await opts.start()
    log(`[${opts.name}] started (attempt ${n})`)
    markWorkerRunning(opts.name)
    return getWorkerState(opts.name)!
  } catch (err) {
    // The FULL message goes to the log, where an operator can act on it; only
    // the class + code reach the state (see WorkerState.errorClass).
    error(`[${opts.name}] start attempt ${n}/${MAX_START_ATTEMPTS} failed:`, err)
    markWorkerDegraded(opts.name, err, n)
    if (n >= MAX_START_ATTEMPTS) {
      error(
        `[${opts.name}] giving up after ${MAX_START_ATTEMPTS} attempts — it stays DEGRADED in /api/health ` +
          'until this process is restarted. If the cause is "[nats-broker] refusing to repoint stream …" or a ' +
          'stream-cover refusal, run `pnpm nats:migrate-streams` and redeploy.',
        err,
      )
      return getWorkerState(opts.name)!
    }
    const delay = RESTART_DELAYS_MS[Math.min(n - 1, RESTART_DELAYS_MS.length - 1)]!
    log(`[${opts.name}] retrying in ${delay}ms`)
    const prev = timers.get(opts.name)
    if (prev) clearTimeout(prev)
    timers.set(
      opts.name,
      schedule(() => {
        timers.delete(opts.name)
        void attemptStart(opts, n + 1)
      }, delay),
    )
    return getWorkerState(opts.name)!
  }
}

/**
 * A worker that WAS live and has stopped being live — a subscription whose
 * `closed` rejected because the server lost its stream or consumer.
 *
 * Round 2 recorded exactly this as degraded and then did nothing: the boot had a
 * bounded supervisor and the rest of the worker's life had none, so a NATS that
 * blipped for ten seconds took the audit trail down until the next deploy. This
 * puts the mid-life fault back on the SAME bounded schedule as the boot — one
 * scheduled attempt, capped backoff, finite attempts — and a successful restart
 * returns the worker to `running`, which clears it from the health body.
 *
 * Attempts are counted from 1 again because the worker did come up: this is a
 * fresh failure, not a continuation of a boot that never succeeded.
 */
export function noteWorkerFault(name: string, err: unknown): void {
  markWorkerDegraded(name, err, 1)
  const opts = supervisors.get(name)
  if (!opts) return // never supervised (a direct start) — degraded is all we can do
  const error = opts.error ?? ((m: string, e: unknown) => console.error(m, e))
  const log = opts.log ?? ((m: string) => console.info(m))
  const schedule =
    opts.schedule ??
    ((fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms)
      if (typeof (t as { unref?: () => void }).unref === 'function') (t as { unref: () => void }).unref()
      return t
    })
  error(`[${name}] died after it was live — restarting on the bounded schedule:`, err)
  const delay = RESTART_DELAYS_MS[0]!
  log(`[${name}] restarting in ${delay}ms`)
  const prev = timers.get(name)
  if (prev) clearTimeout(prev)
  timers.set(
    name,
    schedule(() => {
      timers.delete(name)
      void attemptStart(opts, 2)
    }, delay),
  )
}

/** Cancel any pending restart (shutdown, and test isolation). */
export function cancelWorkerRestarts(): void {
  for (const t of timers.values()) clearTimeout(t)
  timers.clear()
}

/** Reset the registry — for tests only. */
export function _resetWorkerStatesForTests(): void {
  cancelWorkerRestarts()
  states.clear()
  supervisors.clear()
}
