// consumer-supervisor.ts — the bounded restart ladder the org-unit mirror
// consumer runs on, extracted out of main()'s closure so it can be observed.
//
// Round 3 had TWO restart paths and only one ladder. The boot catch backed off
// along BROKER_RETRY_DELAYS_MS and gave up at MAX_BROKER_START_ATTEMPTS; the
// MID-LIFE path — onFatal, reached when a live subscription's `closed` rejects —
// called `attemptConsumerStart(1)` synchronously, with the counter reset to 1,
// one statement after a log line promising "the bounded schedule". A broker that
// drops the consumer as fast as it accepts one therefore produced an un-delayed,
// uncapped reconnect loop. Both paths now run through the same counter here.
//
// The ladder is also CANCELLABLE. A pending restart timer that survives
// createShutdown's before() hook re-opens a broker while closeAllPools() is
// draining — the same class of defect as the relay timers the leaves clear.

/** Backoff between broker start attempts. The LAST value is the cap. */
export const BROKER_RETRY_DELAYS_MS = [5_000, 15_000, 60_000, 300_000] as const

/**
 * CONSECUTIVE start attempts before the ladder gives up — the first boot plus
 * every retry, boot-path and mid-life alike, counted from the last time the
 * consumer proved the broker works (see STABLE_AFTER_MS). Finite on purpose: an
 * unclearable failure must end up as one loud line, not an infinite log.
 *
 * It counts CONSECUTIVE failures and not lifetime ones, because a lifetime
 * counter turns four routine broker blips spread over a quarter into a
 * permanent end of org-unit mirroring: the fifth death gives up forever even
 * though the consumer ran healthy for weeks between each one. The give-up line
 * is for a broker this process cannot reach AT ALL, not for a leaf that has
 * simply been running long enough to have seen a few restarts.
 */
export const MAX_BROKER_START_ATTEMPTS = 5

/**
 * How long a booted consumer has to stay alive before the broker counts as
 * proven and the consecutive-failure counter resets to zero.
 *
 * 60s, one step past the first two rungs of the ladder: long enough that a
 * broker which accepts a subscription and drops it moments later (the flap the
 * cap exists to bound) never clears the counter, short enough that a genuine
 * reconnect after a NATS restart does. A consumer that boots and dies INSIDE
 * this window keeps counting.
 */
export const STABLE_AFTER_MS = 60_000

export interface ConsumerSupervisorDeps<H> {
  /** Label for the log lines, e.g. 'org-unit consumer'. */
  name: string
  /**
   * One boot attempt. The supervisor hands in the mid-life fault callback the
   * consumer must call when a LIVE subscription dies; rejecting is a boot
   * failure and enters the ladder (unless `isUnretryable` claims it).
   */
  boot: (onMidLifeFault: (err: unknown) => void) => Promise<H>
  /** Retain the live handle so shutdown can close it — or null once it is dead. */
  retain: (handle: H | null) => void
  /** Close a handle that arrived after shutdown had already begun. */
  release: (handle: H) => Promise<void>
  /** True once graceful shutdown has begun. */
  isStopped: () => boolean
  /**
   * A failure the ladder must NOT retry — the repoint refusal, where the stream
   * is on a root this consumer could never receive from. Retrying that is a
   * silent outage; the caller ends the process and names the migration command.
   */
  isUnretryable: (err: unknown) => boolean
  onUnretryable: (err: unknown) => void
  delaysMs?: readonly number[]
  maxAttempts?: number
  /** Alive-for, after which the consecutive-failure counter resets. */
  stableAfterMs?: number
  /** Injectable clock — the stable window is a DURATION, not a tick count. */
  now?: () => number
  log?: (msg: string) => void
  warn?: (msg: string) => void
  error?: (msg: string) => void
  /** Injectable for tests; the default unrefs so a pending retry never holds the process open. */
  schedule?: (fn: () => void, ms: number) => unknown
  cancel?: (timer: unknown) => void
}

export interface ConsumerSupervisor {
  /** Boot attempt #1. Never rejects: every outcome is a logged branch. */
  start(): Promise<void>
  /** Shutdown seam: cancel a pending restart so no timer outlives the drain. */
  cancelRestarts(): void
  /** CONSECUTIVE attempts consumed since the broker was last proven. */
  attempts(): number
  /** Is a restart timer armed? */
  restartPending(): boolean
}

function defaultSchedule(fn: () => void, ms: number): unknown {
  const t = setTimeout(fn, ms)
  if (typeof (t as { unref?: () => void }).unref === 'function') {
    ;(t as { unref: () => void }).unref()
  }
  return t
}

export function createConsumerSupervisor<H>(deps: ConsumerSupervisorDeps<H>): ConsumerSupervisor {
  const delays = deps.delaysMs ?? BROKER_RETRY_DELAYS_MS
  const maxAttempts = deps.maxAttempts ?? MAX_BROKER_START_ATTEMPTS
  const stableAfterMs = deps.stableAfterMs ?? STABLE_AFTER_MS
  const now = deps.now ?? (() => Date.now())
  const log = deps.log ?? ((m: string) => console.info(m))
  const warn = deps.warn ?? ((m: string) => console.warn(m))
  const error = deps.error ?? ((m: string) => console.error(m))
  const schedule = deps.schedule ?? defaultSchedule
  const cancel = deps.cancel ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>))

  let attempts = 0
  let timer: unknown = null
  let gaveUp = false
  /**
   * When the CURRENT consumer was retained, or null when none is live. This is
   * what makes `attempts` a consecutive count: a death that follows a run
   * longer than `stableAfterMs` starts the ladder over.
   */
  let liveSince: number | null = null

  const detailOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

  function clearPending(): void {
    if (timer !== null) {
      cancel(timer)
      timer = null
    }
  }

  /**
   * Arm the next attempt, or give up once.
   *
   * `delayMs` is passed by the mid-life path, which restarts on the FIRST step
   * regardless of how far the boot ladder had walked — a consumer that was live
   * is evidence the broker is reachable, so the long tail of the table would
   * only extend the mirror's blind window. The CAP is shared either way, which
   * is what bounds a broker that accepts a subscription and drops it at once.
   */
  function scheduleNext(err: unknown, delayMs?: number): void {
    if (deps.isStopped()) return
    // THE CONSECUTIVE RULE, and it has to run BEFORE the give-up check: a
    // consumer that ran healthy for longer than the stable window is evidence
    // the broker works, so this failure is the FIRST of a new run and both the
    // cap and the delay table start over. Without this the counter was a
    // lifetime one and the fifth blip ever seen ended the mirror for good.
    if (liveSince !== null && now() - liveSince >= stableAfterMs) attempts = 1
    liveSince = null
    const detail = detailOf(err)
    if (attempts >= maxAttempts) {
      if (!gaveUp) {
        gaveUp = true
        error(
          `[finance] ${deps.name} failed ${attempts} consecutive times — the consumer is OFF for the ` +
            'life of this ' +
            'process. The leaf keeps serving HTTP; its org_unit_mirror stops tracking the kernel until it ' +
            `is restarted against a reachable broker. Last error: ${detail}`,
        )
      }
      return
    }
    const delay = delayMs ?? delays[Math.min(attempts - 1, delays.length - 1)]!
    warn(
      `[finance] ${deps.name} start attempt ${attempts}/${maxAttempts} failed — the consumer is OFF, ` +
        `retrying in ${delay}ms: ${detail}`,
    )
    clearPending()
    timer = schedule(() => {
      timer = null
      void attempt()
    }, delay)
  }

  function onMidLifeFault(err: unknown): void {
    if (deps.isUnretryable(err)) {
      deps.onUnretryable(err)
      return
    }
    // The handle is dead: drop it so the shutdown seam cannot try to close it,
    // and so nothing mistakes it for a live consumer.
    deps.retain(null)
    if (deps.isStopped()) return
    error(
      `[finance] ${deps.name} died after it was live — restarting on the bounded schedule: ${detailOf(err)}`,
    )
    scheduleNext(err, delays[0]!)
  }

  async function attempt(): Promise<void> {
    attempts += 1
    try {
      const handle = await deps.boot(onMidLifeFault)
      if (deps.isStopped()) {
        // The boot RESOLVED after the drain began: close what it opened. A close
        // that then fails is a leaked subscription on a process that is exiting,
        // and this line is the operator's only chance of seeing it — a bare
        // swallowing catch here breaks the same rule this diff enforces
        // everywhere else.
        await deps.release(handle).catch((err: unknown) => {
          warn(
            `[finance] ${deps.name} arrived after shutdown and its close FAILED — the subscription ` +
              `may be leaked until the process exits: ${detailOf(err)}`,
          )
        })
        return
      }
      deps.retain(handle)
      liveSince = now()
      log(`[finance] ${deps.name} started (attempt ${attempts}/${maxAttempts})`)
    } catch (err) {
      if (deps.isUnretryable(err)) {
        deps.onUnretryable(err)
        return
      }
      if (deps.isStopped()) return
      scheduleNext(err)
    }
  }

  return {
    start: attempt,
    cancelRestarts: clearPending,
    attempts: () => attempts,
    restartPending: () => timer !== null,
  }
}
