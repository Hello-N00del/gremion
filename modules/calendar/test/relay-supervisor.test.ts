// test/relay-supervisor.test.ts — the NATS relay's bounded start ladder and,
// above all, its SHUTDOWN seam.
//
// BYTE-IDENTICAL in the calendar, content and newsletter leaves, because the
// ladder is.
//
// Round 4 shipped the ladder as a closure inside main(). Nothing could reach it,
// so nothing tested it: neutralising BOTH clearTimeout calls in the leaf's
// before() hook left 151/151 green. And the ladder had no stopped flag, so a
// connect that REJECTED after before() had run fell into the catch and armed a
// fresh retry timer — which then fires during (or after) closeAllPools(),
// opening a broker, and through the relay pass a tenant pool, that nothing left
// alive will ever close.
//
// The post-conditions pinned here:
//   1. stop() leaves NO retry timer armed;
//   2. a connect that REJECTS after stop() arms no new one;
//   3. a connect that RESOLVES after stop() is torn down, not left behind;
//   4. the ladder still backs off along the table and still gives up once;
//   5. the repoint refusal is still not laddered at all.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createRelaySupervisor,
  BROKER_RETRY_DELAYS_MS,
  MAX_BROKER_START_ATTEMPTS,
} from '../src/relay-supervisor.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const INDEX_TS = path.join(__dirname, '..', 'src', 'index.ts')

/**
 * A broker double plus the leaf's own start/teardown shape: `start` "connects"
 * (opening a broker) and arms the relay interval; `teardown` closes whatever is
 * open. Exactly the two callbacks index.ts passes in.
 */
function harness(opts: { connectRejects?: () => unknown; connectDelayMs?: number } = {}) {
  const opened: number[] = []
  const closed: number[] = []
  const warns: string[] = []
  const errors: string[] = []
  const unretryable: unknown[] = []
  let live: number | null = null
  let intervalArmed = false

  const supervisor = createRelaySupervisor({
    name: 'leaf',
    start: async () => {
      if (opts.connectDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, opts.connectDelayMs))
      }
      const thrown = opts.connectRejects?.()
      if (thrown !== undefined) throw thrown
      live = opened.length + 1
      opened.push(live)
      intervalArmed = true
    },
    teardown: () => {
      intervalArmed = false
      if (live !== null) {
        closed.push(live)
        live = null
      }
    },
    isUnretryable: (err) => err instanceof Error && err.message.includes('refusing to repoint'),
    onUnretryable: (err) => unretryable.push(err),
    warn: (m) => warns.push(m),
    error: (m) => errors.push(m),
  })

  return {
    supervisor,
    opened,
    closed,
    warns,
    errors,
    unretryable,
    intervalArmed: () => intervalArmed,
    liveBrokers: () => opened.length - closed.length,
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('createRelaySupervisor — the shutdown seam', () => {
  it('leaves NO retry timer armed once stop() has run', async () => {
    const h = harness({ connectRejects: () => new Error('ECONNREFUSED') })
    await h.supervisor.start()
    expect(h.supervisor.retryPending(), 'a failed connect arms the ladder').toBe(true)

    // Exactly what createShutdown's before() hook does.
    h.supervisor.stop()

    expect(h.supervisor.retryPending()).toBe(false)
    await vi.advanceTimersByTimeAsync(BROKER_RETRY_DELAYS_MS.at(-1)! * 3)
    expect(h.opened, 'nothing may reconnect behind the pool drain').toEqual([])
    expect(h.supervisor.attempts(), 'and no further attempt is even made').toBe(1)
  })

  it('arms no NEW timer for a connect that rejects AFTER stop()', async () => {
    // The connect is still in flight when SIGTERM lands; it rejects afterwards.
    const h = harness({
      connectRejects: () => new Error('ECONNREFUSED'),
      connectDelayMs: 50,
    })
    const inFlight = h.supervisor.start()

    h.supervisor.stop()
    await vi.advanceTimersByTimeAsync(50)
    await inFlight

    expect(
      h.supervisor.retryPending(),
      'round 4 fell into the catch and re-armed the ladder behind the drain',
    ).toBe(false)
    await vi.advanceTimersByTimeAsync(BROKER_RETRY_DELAYS_MS.at(-1)! * 3)
    expect(h.opened).toEqual([])
  })

  it('tears down a connect that SUCCEEDS after stop() rather than leaving a broker open', async () => {
    const h = harness({ connectDelayMs: 50 })
    const inFlight = h.supervisor.start()

    h.supervisor.stop()
    await vi.advanceTimersByTimeAsync(50)
    await inFlight

    expect(h.opened.length, 'the connect did complete').toBe(1)
    expect(h.liveBrokers(), 'but nothing is left open behind the drain').toBe(0)
    expect(h.intervalArmed(), 'and no relay interval survives either').toBe(false)
  })

  it('is idempotent — a second stop() is not an error', () => {
    const h = harness()
    h.supervisor.stop()
    h.supervisor.stop()
    expect(h.supervisor.retryPending()).toBe(false)
  })
})

describe('createRelaySupervisor — the bounded ladder', () => {
  it('backs off along the delay table and gives up ONCE at the cap', async () => {
    const h = harness({ connectRejects: () => new Error('ECONNREFUSED') })
    await h.supervisor.start()

    for (let i = 1; i < MAX_BROKER_START_ATTEMPTS; i += 1) {
      const expected = BROKER_RETRY_DELAYS_MS[Math.min(i - 1, BROKER_RETRY_DELAYS_MS.length - 1)]!
      await vi.advanceTimersByTimeAsync(expected - 1)
      expect(h.supervisor.attempts(), `step ${i} must wait the full ${expected}ms`).toBe(i)
      await vi.advanceTimersByTimeAsync(1)
      expect(h.supervisor.attempts()).toBe(i + 1)
    }
    await vi.advanceTimersByTimeAsync(BROKER_RETRY_DELAYS_MS.at(-1)! * 2)

    expect(h.supervisor.attempts()).toBe(MAX_BROKER_START_ATTEMPTS)
    expect(
      h.errors.filter((m) => m.includes('OFF for the life of this process')).length,
      'one loud line, not one per attempt',
    ).toBe(1)
    expect(h.supervisor.retryPending()).toBe(false)
  })

  it('closes the half-open connection on every failed attempt', async () => {
    let fail = true
    const h = harness({ connectRejects: () => (fail ? new Error('ECONNREFUSED') : undefined) })
    await h.supervisor.start()
    fail = false
    await vi.advanceTimersByTimeAsync(BROKER_RETRY_DELAYS_MS[0]!)
    expect(h.opened.length).toBe(1)
    expect(h.liveBrokers(), 'the retry that succeeded holds exactly one broker').toBe(1)
  })

  it('does not ladder a repoint refusal — that one is the caller’s exit', async () => {
    const refusal = new Error('[nats-broker] refusing to repoint stream CALENDAR')
    const h = harness({ connectRejects: () => refusal })
    await h.supervisor.start()

    expect(h.unretryable).toEqual([refusal])
    expect(h.supervisor.retryPending()).toBe(false)
    await vi.advanceTimersByTimeAsync(BROKER_RETRY_DELAYS_MS.at(-1)! * 2)
    expect(h.supervisor.attempts()).toBe(1)
  })
})

describe('wiring — this leaf actually runs on the supervisor', () => {
  const source = fs.readFileSync(INDEX_TS, 'utf8')

  it('builds the relay ladder with createRelaySupervisor rather than an inline closure', () => {
    expect(source).toMatch(/createRelaySupervisor\(/)
  })

  it('stops it from the shutdown seam, and keeps no retry timer of its own', () => {
    const at = source.indexOf('createShutdown(')
    expect(at).toBeGreaterThan(-1)
    expect(source.slice(at)).toMatch(/relaySupervisor\?\.stop\(\)/)
    expect(
      source,
      'a retry timer main() owns is one the tested seam cannot cancel',
    ).not.toMatch(/relayRetryTimer/)
  })
})
