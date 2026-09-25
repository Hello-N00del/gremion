// services/<leaf>/src/shutdown.ts
//
// The SIGTERM/SIGINT handler, extracted from main() so it can be TESTED.
//
// Round 3 shipped the drain as `void drainEvictedPools()` immediately followed
// by `server.close(cb => process.exit(0))`. Nothing sequenced the two:
// `server.close`'s callback fires as soon as the last connection goes away — on
// an idle leaf, or one whose only client is the wget healthcheck, that is the
// next tick — while `sql.end()` is a network round trip. `process.exit()` does
// not wait for pending promises, so the pools died by exactly the TCP reset the
// drain existed to prevent. The comment claimed "the forced-exit timer below
// bounds it", but that timer is the LATE bound; the exit that actually happened
// was the fast `server.close` path, unbounded in the other direction.
//
// The contract here:
//   1. ARM the forced-exit timer — FIRST, before anything that can throw or
//      hang (see below),
//   2. stop the loops and brokers (before()),
//   3. stop accepting (server.close),
//   4. AWAIT the drain on BOTH close branches, raced against the timer,
//   5. log which of the two won, and what was drained,
//   6. exit exactly once.
//
// Round 4 got steps 1 and 4 wrong, in ways only an ordering test can see:
//   - The timer was armed AFTER before(). before() closes the NATS broker and
//     clears the loop timers; anything it throws propagates straight out of the
//     signal handler, so the arming line is never reached and the shutdown is
//     unbounded in the exact case where something is already wrong. The handler
//     is the last code running — an exception there is not caught by anyone.
//   - The server.close ERROR branch exited WITHOUT draining. A close error is
//     precisely the case where connections are still open, so the branch that
//     most needs the drain was the one that skipped it.
//
// Every collaborator is injected so a test can drive all of it without booting
// a server or killing a process — that testability IS the fix, because the
// defects were orderings the previous shape gave no way to assert.

/** Just enough of node:http's Server for the shutdown path. */
export interface ClosableServer {
  close(cb: (err?: Error) => void): void
}

/**
 * What the drain reports back. Every field is optional so a leaf (or a test)
 * can hand back a bare `void` and still be logged sensibly; `closeAllPools()`
 * fills all four.
 */
export interface DrainSummary {
  /** Live per-tenant pools ended. */
  readonly live?: number
  /** Capacity-evicted pools still inside their grace window when SIGTERM landed. */
  readonly evicted?: number
  /** The control-DB pool — 1 once the leaf has booted, 0 before. */
  readonly control?: number
  /** Pools whose end() REJECTED. Non-zero means connections were leaked. */
  readonly failed?: number
}

/**
 * Default upper bound on the whole graceful path.
 *
 * 7s, not the 10s round 4 shipped. Compose's default `stop_grace_period` is
 * 10s and Kubernetes' default `terminationGracePeriodSeconds` is 30s, so a
 * 10_000ms timer sits exactly ON the compose bound: the forced exit and the
 * SIGKILL race, and when the SIGKILL wins the log line that would have
 * explained the kill is the one that is lost. 7s leaves 3s of headroom under
 * the tighter of the two orchestrators, which is enough for the forced-exit
 * error to be written and flushed.
 */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 7_000

/** The subset of the process environment the shutdown bound is read from. */
export interface ShutdownTimeoutEnv {
  readonly SHUTDOWN_TIMEOUT_MS?: string | undefined
}

/**
 * Resolve the forced-exit bound from the environment.
 *
 * OVERRIDABLE on purpose: compose and k8s do not agree on the grace period they
 * give a container, and a leaf deployed under a 30s k8s grace period can afford
 * a longer drain than the same image under compose. A hard-coded constant can
 * be neither raised nor lowered without a rebuild.
 *
 * A bad value falls back to the default and SAYS SO — an operator who set
 * SHUTDOWN_TIMEOUT_MS believes it is in effect, and a silently-ignored setting
 * is worse than a rejected one.
 */
export function resolveShutdownTimeoutMs(
  env: ShutdownTimeoutEnv,
  warn: (msg: string) => void = (msg: string): void => console.warn(msg),
): number {
  const raw = env.SHUTDOWN_TIMEOUT_MS
  if (raw === undefined || raw === '') return DEFAULT_SHUTDOWN_TIMEOUT_MS
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    warn(
      `[shutdown] SHUTDOWN_TIMEOUT_MS=${JSON.stringify(raw)} is not a positive integer number ` +
        `of milliseconds — falling back to ${DEFAULT_SHUTDOWN_TIMEOUT_MS}ms`,
    )
    return DEFAULT_SHUTDOWN_TIMEOUT_MS
  }
  return parsed
}

export interface ShutdownOptions {
  /** Leaf name, used as the log prefix (e.g. 'finance'). */
  readonly name: string
  readonly server: ClosableServer
  /**
   * Ends the leaf's Postgres pools — LIVE, evicted AND the control pool.
   * Awaited before exit; its counts are logged.
   */
  readonly drain: () => Promise<DrainSummary | void>
  /** Process exit seam. Called at most once per shutdown. */
  readonly exit: (code: number) => void
  /** Upper bound on the whole graceful path (see resolveShutdownTimeoutMs). */
  readonly forceAfterMs: number
  /** Everything that must stop before the server closes (loops, brokers). */
  readonly before?: () => void
  readonly log?: (msg: string) => void
  readonly errorLog?: (msg: string) => void
}

/** Render the drain counts for the completion log line; '' for a bare void. */
function formatSummary(summary: DrainSummary | void): string {
  if (summary === undefined || summary === null) return ''
  const parts: string[] = []
  if (summary.live !== undefined) parts.push(`live=${summary.live}`)
  if (summary.evicted !== undefined) parts.push(`evicted=${summary.evicted}`)
  if (summary.control !== undefined) parts.push(`control=${summary.control}`)
  if (summary.failed !== undefined) parts.push(`failed=${summary.failed}`)
  return parts.length === 0 ? '' : ` (${parts.join(' ')})`
}

/**
 * Build the signal handler. The returned function is idempotent: a second
 * signal while a shutdown is in flight is ignored rather than starting a
 * second drain.
 */
export function createShutdown(options: ShutdownOptions): (signal: string) => void {
  const log = options.log ?? ((msg: string): void => console.log(`[${options.name}] ${msg}`))
  const errorLog =
    options.errorLog ?? ((msg: string): void => console.error(`[${options.name}] ${msg}`))

  let shuttingDown = false
  let exited = false

  /**
   * The forced-exit timer and the drain race each other; whichever finishes
   * first decides the exit code. A second exit() would contradict the log line
   * the first one printed, so the loser is dropped.
   */
  const exitOnce = (code: number): void => {
    if (exited) return
    exited = true
    options.exit(code)
  }

  return (signal: string): void => {
    if (shuttingDown) return
    shuttingDown = true
    // The BOUND is named in the first line: the default and an operator's
    // override are otherwise indistinguishable in a container log.
    log(`${signal} received — draining connections (forced exit after ${options.forceAfterMs}ms)`)

    // ARMED FIRST — before before(), before server.close, before anything that
    // can throw or hang. Round 4 armed it after before(); a before() that threw
    // took the arming line with it and the shutdown ran unbounded.
    const forced = setTimeout(() => {
      errorLog(
        `graceful shutdown timed out after ${options.forceAfterMs}ms — forcing exit; ` +
          'pools that had not finished draining are terminated by the runtime',
      )
      exitOnce(1)
    }, options.forceAfterMs)
    // Node returns a Timeout; fake timers may return a number — hence the
    // defensive optional call rather than a bare .unref().
    ;(forced as unknown as { unref?: () => void }).unref?.()

    // A pre-stop hook that throws must NOT abort the shutdown: this handler is
    // the last thing running, so an exception here is caught by nobody and the
    // drain never starts.
    try {
      options.before?.()
    } catch (err) {
      errorLog(
        `pre-stop hook failed during shutdown: ${
          err instanceof Error ? err.message : String(err)
        } — continuing with the drain`,
      )
    }

    options.server.close((err) => {
      // BOTH branches drain. A close error means connections are STILL OPEN,
      // which is exactly when the pools behind them need ending; round 4's
      // error branch exited straight away and left them to a TCP reset.
      const closeFailed = err !== undefined && err !== null
      if (closeFailed) errorLog(`error during shutdown: ${err.message}`)
      // THE FIX (round 3): the drain is awaited HERE, inside the close
      // callback, before any exit. `void drain()` at this point would be
      // overtaken by the exit on the very next tick.
      void options.drain().then(
        (summary) => {
          clearTimeout(forced)
          log(`shutdown complete — pools drained${formatSummary(summary)}`)
          exitOnce(closeFailed ? 1 : 0)
        },
        (drainErr: unknown) => {
          clearTimeout(forced)
          errorLog(
            `pool drain failed during shutdown: ${
              drainErr instanceof Error ? drainErr.message : String(drainErr)
            }`,
          )
          exitOnce(1)
        },
      )
    })
  }
}
