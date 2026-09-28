// test/consumer-supervisor.test.ts — the bounded restart ladder the finance leaf
// runs its org-unit mirror consumer on.
//
// Round 3 shipped a ladder that governed only the BOOT catch. The mid-life path
// (`onFatal`, reached when a live subscription's `closed` rejects) called
// `attemptConsumerStart(1)` SYNCHRONOUSLY, with the counter reset to 1 — while
// the log line one statement above it told the operator the restart was "on the
// bounded schedule". A broker that rejects `closed` as fast as it accepts a
// subscription therefore produced an unbounded, un-delayed reconnect loop: no
// backoff, no cap, no give-up line, and (before F2) a stranded connection per
// turn. Nothing could observe any of that, because the whole ladder was a
// closure inside main().
//
// These are the four properties the extraction has to make true:
//   1. a mid-life death does NOT restart synchronously — it waits the first
//      backoff step;
//   2. repeated mid-life deaths keep consuming the SAME attempt counter, so the
//      cap is reached and the give-up line is logged exactly once;
//   3. the shutdown seam cancels a pending restart, so no timer outlives the
//      drain;
//   4. an unretryable refusal is not laddered at all — it is the caller's exit.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createConsumerSupervisor,
  BROKER_RETRY_DELAYS_MS,
  MAX_BROKER_START_ATTEMPTS,
  STABLE_AFTER_MS,
} from '../src/consumer-supervisor.ts'
import { createShutdown } from '../src/shutdown.ts'
import { stopOrgUnitConsumer } from '../src/stop-consumer.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const INDEX_TS = path.join(__dirname, '..', 'src', 'index.ts')

interface Handle {
  id: number
}

function harness(opts: { isUnretryable?: (e: unknown) => boolean; bootThrows?: () => unknown } = {}) {
  const boots: Handle[] = []
  const faults: ((err: unknown) => void)[] = []
  const retained: (Handle | null)[] = []
  const released: Handle[] = []
  const logs: string[] = []
  const warns: string[] = []
  const errors: string[] = []
  const unretryable: unknown[] = []
  let stopped = false

  const supervisor = createConsumerSupervisor<Handle>({
    name: 'org-unit consumer',
    boot: async (onMidLifeFault) => {
      const thrown = opts.bootThrows?.()
      if (thrown !== undefined) throw thrown
      faults.push(onMidLifeFault)
      const handle = { id: boots.length + 1 }
      boots.push(handle)
      return handle
    },
    retain: (h) => retained.push(h),
    release: async (h) => {
      released.push(h)
    },
    isStopped: () => stopped,
    isUnretryable: opts.isUnretryable ?? (() => false),
    onUnretryable: (err) => unretryable.push(err),
    log: (m) => logs.push(m),
    warn: (m) => warns.push(m),
    error: (m) => errors.push(m),
  })

  return {
    supervisor,
    boots,
    faults,
    retained,
    released,
    logs,
    warns,
    errors,
    unretryable,
    stop(): void {
      stopped = true
    },
    /** Kill the most recent live subscription the way `closed` rejecting does. */
    killLatest(message = 'consumer deleted under subscription'): void {
      faults[faults.length - 1]!(Object.assign(new Error(message), { name: 'ConsumerGoneError' }))
    },
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('createConsumerSupervisor — the mid-life restart is delayed, not immediate', () => {
  it('waits the first backoff step instead of re-booting inside the fault handler', async () => {
    const h = harness()
    await h.supervisor.start()
    expect(h.boots.length).toBe(1)

    h.killLatest()
    // Round 3's defect in one assertion: `void attemptConsumerStart(1)` ran here.
    await vi.advanceTimersByTimeAsync(0)
    expect(h.boots.length, 'a mid-life death must not re-boot synchronously').toBe(1)
    expect(h.supervisor.restartPending()).toBe(true)

    await vi.advanceTimersByTimeAsync(BROKER_RETRY_DELAYS_MS[0]! - 1)
    expect(h.boots.length).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.boots.length).toBe(2)
  })

  it('releases the retained handle before the restart, so shutdown cannot close a dead one', async () => {
    const h = harness()
    await h.supervisor.start()
    expect(h.retained.at(-1)).toEqual({ id: 1 })

    h.killLatest()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.retained.at(-1), 'the dead handle must be dropped as soon as it dies').toBe(null)
  })
})

describe('createConsumerSupervisor — repeated mid-life deaths are CAPPED', () => {
  it('consumes one attempt per restart and gives up once at the cap', async () => {
    const h = harness()
    await h.supervisor.start()

    // Kill it as fast as it comes up, forever. Round 3 looped here without bound.
    for (let i = 0; i < MAX_BROKER_START_ATTEMPTS + 3; i += 1) {
      h.killLatest()
      await vi.advanceTimersByTimeAsync(BROKER_RETRY_DELAYS_MS[0]!)
    }

    expect(
      h.boots.length,
      'the counter must CONTINUE across restarts — resetting it to 1 is the unbounded loop',
    ).toBe(MAX_BROKER_START_ATTEMPTS)
    expect(h.supervisor.attempts()).toBe(MAX_BROKER_START_ATTEMPTS)
    expect(h.supervisor.restartPending()).toBe(false)

    const giveUps = h.errors.filter((m) => m.includes('OFF for the life of this process'))
    expect(giveUps.length, 'the give-up line is one loud line, not one per fault').toBe(1)
    expect(giveUps[0]).toContain(`failed ${MAX_BROKER_START_ATTEMPTS} consecutive times`)
  })

  it('backs the boot ladder off along the delay table, capping at the last value', async () => {
    let failures = 99
    const h = harness({ bootThrows: () => (failures-- > 0 ? new Error('ECONNREFUSED') : undefined) })
    await h.supervisor.start()

    // Attempt 1 already failed; each subsequent step waits the NEXT table value.
    for (let i = 1; i < MAX_BROKER_START_ATTEMPTS; i += 1) {
      const expected = BROKER_RETRY_DELAYS_MS[Math.min(i - 1, BROKER_RETRY_DELAYS_MS.length - 1)]!
      await vi.advanceTimersByTimeAsync(expected - 1)
      expect(h.supervisor.attempts(), `step ${i} must wait the full ${expected}ms`).toBe(i)
      await vi.advanceTimersByTimeAsync(1)
      expect(h.supervisor.attempts()).toBe(i + 1)
    }
    await vi.advanceTimersByTimeAsync(BROKER_RETRY_DELAYS_MS.at(-1)! * 2)
    expect(h.supervisor.attempts()).toBe(MAX_BROKER_START_ATTEMPTS)
    expect(h.errors.filter((m) => m.includes('OFF for the life of this process')).length).toBe(1)
  })
})

describe('createConsumerSupervisor — the shutdown seam', () => {
  it('cancels a pending restart, so no timer outlives the drain', async () => {
    const h = harness()
    await h.supervisor.start()
    h.killLatest()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.supervisor.restartPending()).toBe(true)

    // Exactly what createShutdown's before() hook does.
    h.stop()
    h.supervisor.cancelRestarts()

    await vi.advanceTimersByTimeAsync(BROKER_RETRY_DELAYS_MS.at(-1)! * 2)
    expect(h.boots.length, 'a restart must not fire after shutdown began').toBe(1)
    expect(h.supervisor.restartPending()).toBe(false)
  })

  it('does not schedule a restart at all for a death that lands after shutdown started', async () => {
    const h = harness()
    await h.supervisor.start()
    h.stop()
    h.killLatest()
    await vi.advanceTimersByTimeAsync(BROKER_RETRY_DELAYS_MS.at(-1)! * 2)
    expect(h.boots.length).toBe(1)
    expect(h.supervisor.restartPending()).toBe(false)
  })

  it('closes a handle that arrives after shutdown rather than retaining it', async () => {
    const h = harness()
    h.stop()
    await h.supervisor.start()
    expect(h.released).toEqual([{ id: 1 }])
    expect(h.retained).toEqual([])
  })
})

describe('createConsumerSupervisor — an unretryable refusal is not laddered', () => {
  it('routes a repoint refusal to the caller and schedules nothing', async () => {
    const refusal = new Error('[nats-broker] refusing to repoint stream ORGUNIT')
    const h = harness({
      isUnretryable: (e) => e instanceof Error && e.message.includes('refusing to repoint'),
      bootThrows: () => refusal,
    })
    await h.supervisor.start()

    expect(h.unretryable).toEqual([refusal])
    expect(h.supervisor.restartPending()).toBe(false)
    await vi.advanceTimersByTimeAsync(BROKER_RETRY_DELAYS_MS.at(-1)! * 2)
    expect(h.supervisor.attempts()).toBe(1)
  })
})

describe('createConsumerSupervisor — the counter is CONSECUTIVE, not lifetime', () => {
  // Round 4 shipped a LIFETIME counter. `attempts` only ever went up, so the
  // fifth broker blip over the life of the process ended org-unit mirroring for
  // good — even with weeks of healthy consumption between the deaths. Four
  // routine restarts of the NATS container across a quarter is not a fault
  // condition; the give-up line is for a broker that cannot be reached AT ALL.
  it('does not give up after deaths separated by healthy runs longer than the stable window', async () => {
    const h = harness()
    await h.supervisor.start()

    for (let i = 0; i < MAX_BROKER_START_ATTEMPTS + 3; i += 1) {
      // Healthy for longer than STABLE_AFTER_MS: the broker demonstrably works.
      await vi.advanceTimersByTimeAsync(STABLE_AFTER_MS + 1)
      h.killLatest()
      await vi.advanceTimersByTimeAsync(BROKER_RETRY_DELAYS_MS[0]!)
    }

    expect(
      h.errors.filter((m) => m.includes('OFF for the life of this process')),
      'a lifetime counter ends the mirror after four routine broker blips',
    ).toEqual([])
    expect(h.boots.length, 'every death must be followed by a restart').toBe(
      MAX_BROKER_START_ATTEMPTS + 4,
    )
    // 1 = the death that was just recovered from, 2 = the boot that recovered it.
    expect(h.supervisor.attempts(), 'the counter restarts from the stable run').toBe(2)
  })

  it('restarts the LADDER too — a death after a stable run waits the first delay again', async () => {
    let failures = 0
    const h = harness({ bootThrows: () => (failures-- > 0 ? new Error('ECONNREFUSED') : undefined) })
    await h.supervisor.start()

    // Walk the ladder up to (but not into) the cap, then let a boot succeed.
    failures = MAX_BROKER_START_ATTEMPTS - 2
    h.killLatest()
    await vi.advanceTimersByTimeAsync(BROKER_RETRY_DELAYS_MS.at(-1)! * MAX_BROKER_START_ATTEMPTS)
    expect(h.supervisor.attempts()).toBe(MAX_BROKER_START_ATTEMPTS)

    // Now it stays up past the stable window, and dies again.
    await vi.advanceTimersByTimeAsync(STABLE_AFTER_MS + 1)
    const bootsBefore = h.boots.length
    h.killLatest()
    await vi.advanceTimersByTimeAsync(BROKER_RETRY_DELAYS_MS[0]! - 1)
    expect(h.boots.length, 'the restart still waits the first backoff step').toBe(bootsBefore)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.boots.length, 'and then fires — the ladder walked back to step one').toBe(
      bootsBefore + 1,
    )
  })

  it('still gives up ONCE on a genuine flap — deaths inside the stable window', async () => {
    const h = harness()
    await h.supervisor.start()

    for (let i = 0; i < MAX_BROKER_START_ATTEMPTS + 3; i += 1) {
      // Alive for less than STABLE_AFTER_MS every time: that is a flap.
      await vi.advanceTimersByTimeAsync(STABLE_AFTER_MS - BROKER_RETRY_DELAYS_MS[0]! - 1)
      h.killLatest()
      await vi.advanceTimersByTimeAsync(BROKER_RETRY_DELAYS_MS[0]!)
    }

    expect(h.boots.length).toBe(MAX_BROKER_START_ATTEMPTS)
    const giveUps = h.errors.filter((m) => m.includes('OFF for the life of this process'))
    expect(giveUps.length, 'a flap still ends in exactly one loud line').toBe(1)
    expect(giveUps[0]).toContain(`failed ${MAX_BROKER_START_ATTEMPTS} consecutive times`)
  })
})

describe('wiring — the finance leaf actually runs on this ladder', () => {
  const source = fs.readFileSync(INDEX_TS, 'utf8')

  it('builds the consumer supervisor rather than an inline closure', () => {
    expect(
      source,
      'src/index.ts must build its restart ladder with createConsumerSupervisor — the inline ' +
        'closure is the untestable shape that shipped the round-3 defect',
    ).toMatch(/createConsumerSupervisor[<(]/)
  })

  it('has no synchronous mid-life restart left', () => {
    expect(
      source,
      'void attemptConsumerStart(1) inside onFatal is the exact round-3 defect: immediate, ' +
        'counter reset, unbounded',
    ).not.toMatch(/attemptConsumerStart\(1\)/)
  })

  // The remaining SOURCE check is the wiring link only: that index.ts routes
  // its pre-stop hook through stopOrgUnitConsumer. What the hook DOES is
  // asserted behaviourally below, through the real createShutdown.
  it('routes its pre-stop hook through the testable stop seam', () => {
    const at = source.indexOf('createShutdown(')
    expect(at).toBeGreaterThan(-1)
    expect(
      source.slice(at),
      'before() must call the extracted hook, or the behavioural tests below guard nothing',
    ).toMatch(/before:[\s\S]{0,40}stopOrgUnitConsumer\(/)
  })
})

// Round 4's shutdown-seam guard was `expect(source.slice(at)).toMatch(/cancelRestarts\(\)/)`
// — a source-text grep that a COMMENTED-OUT call passes. These run the REAL
// pre-stop hook through the REAL createShutdown instead.
describe('the shutdown seam, run rather than grepped', () => {
  const runShutdown = (before: () => void): { drained: string[] } => {
    const order: string[] = []
    const shutdown = createShutdown({
      name: 'finance',
      server: { close: (cb) => cb() },
      drain: async () => {
        order.push('drain')
        return {}
      },
      exit: () => {
        order.push('exit')
      },
      forceAfterMs: 1_000,
      before: () => {
        order.push('before')
        before()
      },
      log: () => {},
      errorLog: () => {},
    })
    shutdown('SIGTERM')
    return { drained: order }
  }

  it('calls cancelRestarts on the supervisor, before the drain', async () => {
    const calls: string[] = []
    let stopped = false
    const supervisor = {
      cancelRestarts: (): void => {
        calls.push('cancelRestarts')
      },
    }
    const consumer = {
      close: async (): Promise<void> => {
        calls.push('close')
      },
    }

    const { drained } = runShutdown(() =>
      stopOrgUnitConsumer({
        markStopped: () => {
          stopped = true
        },
        supervisor: () => supervisor,
        liveConsumer: () => consumer,
      }),
    )
    await vi.advanceTimersByTimeAsync(0)

    expect(stopped, 'the leaf must be marked stopped before the pools drain').toBe(true)
    expect(calls, 'the ladder is cancelled by the hook the leaf actually installs').toContain(
      'cancelRestarts',
    )
    expect(calls).toContain('close')
    expect(drained.indexOf('before')).toBeLessThan(drained.indexOf('drain'))
  })

  it('leaves NO pending restart from the real ladder once the hook has run', async () => {
    const h = harness()
    await h.supervisor.start()
    h.killLatest()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.supervisor.restartPending()).toBe(true)

    runShutdown(() =>
      stopOrgUnitConsumer({
        markStopped: h.stop,
        supervisor: () => h.supervisor,
        liveConsumer: () => null,
      }),
    )
    await vi.advanceTimersByTimeAsync(BROKER_RETRY_DELAYS_MS.at(-1)! * 2)

    expect(h.supervisor.restartPending(), 'no timer may outlive the drain').toBe(false)
    expect(h.boots.length, 'and nothing re-opened a broker behind the drain').toBe(1)
  })

  it('a close that REJECTS is logged, not swallowed', async () => {
    const warns: string[] = []
    runShutdown(() =>
      stopOrgUnitConsumer({
        markStopped: () => {},
        supervisor: () => null,
        liveConsumer: () => ({ close: async () => Promise.reject(new Error('socket already gone')) }),
        warn: (m) => warns.push(m),
      }),
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(warns.join(' | ')).toContain('socket already gone')
  })
})
