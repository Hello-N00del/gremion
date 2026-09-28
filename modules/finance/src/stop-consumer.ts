// stop-consumer.ts — the pre-stop hook the finance leaf hands to createShutdown.
//
// Extracted out of main()'s closure for ONE reason: round 4's only coverage of
// this seam was a source-text grep for a `cancelRestarts()` call in index.ts
// after `createShutdown(`, which a COMMENTED-OUT call satisfies. A guard that a
// comment can pass is not a guard. Everything the hook must do is now a
// function with injected collaborators, so a test can run the real hook through
// the real createShutdown and assert what happened.
//
// The three things, in this order:
//   1. mark the leaf stopped — every org-unit event the consumer handles calls
//      storeFor(), and a storeFor() that lands after closeAllPools() would open
//      a pool nothing left alive will close;
//   2. cancel a PENDING restart — `stopped` alone is not enough, because the
//      ladder's timer is already scheduled by the time this runs, and a restart
//      that fires during the drain re-opens a broker behind it;
//   3. close the live consumer, if there is one.
//
// Step 3's failure is LOGGED. A bare swallowing catch is the shape this diff's
// own rule forbids: a broker handle that refuses to close is a leaked
// connection on a process that is about to exit, and the operator's only chance
// of seeing it is this line.

/** The restart ladder, narrowed to what the shutdown seam needs from it. */
export interface CancellableRestarts {
  cancelRestarts(): void
}

/** A live consumer handle, narrowed to what the shutdown seam needs from it. */
export interface ClosableConsumer {
  close(): Promise<void>
}

export interface StopOrgUnitConsumerDeps {
  /** Flip the leaf's `stopped` flag (read by the consumer and the supervisor). */
  markStopped: () => void
  /** The supervisor, or null when NATS_URL was unset and no ladder was built. */
  supervisor: () => CancellableRestarts | null
  /** The live consumer, or null when none ever booted / it already died. */
  liveConsumer: () => ClosableConsumer | null
  warn?: (msg: string) => void
}

/**
 * Run the finance leaf's pre-stop hook. Never throws: its caller is the signal
 * handler, and an exception there is caught by nobody.
 */
export function stopOrgUnitConsumer(deps: StopOrgUnitConsumerDeps): void {
  const warn = deps.warn ?? ((msg: string): void => console.warn(msg))
  deps.markStopped()
  deps.supervisor()?.cancelRestarts()
  const live = deps.liveConsumer()
  if (live !== null) {
    void live.close().catch((err: unknown) => {
      warn(
        '[finance] org-unit consumer close failed during shutdown — the subscription may be leaked ' +
          `until the process exits: ${err instanceof Error ? err.message : String(err)}`,
      )
    })
  }
}
