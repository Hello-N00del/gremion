// modules/calendar/app/lib/server/events/calendar-audit-consumer.supervised.test.ts
//
// The calendar share of the f2 describe 'the audit consumers under a rejecting broker' in
// gremion-ui/src/lib/server/events/consumer-state.test.ts, split per module (TASK-205a, ruling R28-O2: the
// kernel's consumer-state.test.ts pins the supervisor itself and may not import a module).
//
// Round 1 made each of these false at once, and each is a way a dead consumer looks alive:
//   1. the module latch was set BEFORE the boot was awaited, so a failed start could never be retried in
//      that process;
//   2. the NatsBroker was left connected on a failed attempt, so a retry would stack connections;
//   3. the failure existed only as a line on stderr, so /api/health said 'ok'.
//
// The doubles are a REJECTING-READY broker (the boot refusal: a stream that does not cover the pattern) and
// a REJECTING-CLOSED one (a live subscription that dies later).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { BrokerSubscription, EventEnvelope } from '@gremion/ports/broker'
import { degradedWorkers, _resetWorkerStatesForTests } from '$lib/server/events/consumer-state'
import {
  startCalendarAuditConsumer,
  CALENDAR_AUDIT_WORKER,
  _resetStartedForTests,
} from './calendar-audit-consumer'

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  promise.catch(() => {})
  return { promise, resolve, reject }
}

/**
 * A broker double whose subscription settles however the test says.
 * `closes` counts close() so a leaked connection is a visible failure.
 */
function makeBroker(opts: { ensureStreamError?: Error; readyRejects?: Error } = {}) {
  const ready = deferred<void>()
  const subClosed = deferred<void>()
  if (opts.readyRejects) ready.reject(opts.readyRejects)
  else ready.resolve()
  let closes = 0
  return {
    get closes() {
      return closes
    },
    /** Was this connection handed back at all? A restart that leaves this false has stranded the dead broker. */
    get closed() {
      return closes > 0
    },
    subClosed,
    async ensureStream(): Promise<void> {
      if (opts.ensureStreamError) throw opts.ensureStreamError
    },
    async close(): Promise<void> {
      closes += 1
    },
    async publish(): Promise<void> {},
    // Signature-matched to BrokerPort.subscribe: the handler takes (event, subject).
    subscribe(pattern: string, _h: (e: EventEnvelope, subject: string) => Promise<void>): BrokerSubscription {
      return { pattern, ready: ready.promise, closed: subClosed.promise, unsubscribe(): void {} } as BrokerSubscription
    },
  }
}

beforeEach(() => {
  _resetWorkerStatesForTests()
  _resetStartedForTests()
  vi.restoreAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
})

afterEach(() => {
  _resetStartedForTests()
  _resetWorkerStatesForTests()
})

describe('the calendar audit consumer under a rejecting broker', () => {
  it('a rejecting `ready` fails the boot, closes the broker and leaves no latch', async () => {
    const cover = new Error('[nats-broker] stream CALENDAR does not cover subscription "gremion.*.calendar.>"')
    const broker = makeBroker({ readyRejects: cover })

    await expect(startCalendarAuditConsumer('nats://x', undefined, async () => broker as never)).rejects.toBe(cover)
    // (2) the connection is not leaked ...
    expect(broker.closes).toBe(1)

    // ... and (1) the latch did not close over a failure: a later attempt in the SAME process still runs.
    const good = makeBroker()
    await startCalendarAuditConsumer('nats://x', undefined, async () => good as never)
    expect(good.closes).toBe(0)
  })

  it('an ensureStream refusal fails the boot and closes the broker', async () => {
    const refusal = new Error('[nats-broker] refusing to repoint stream CALENDAR: it currently captures […]')
    const broker = makeBroker({ ensureStreamError: refusal })

    await expect(startCalendarAuditConsumer('nats://x', undefined, async () => broker as never)).rejects.toBe(refusal)
    expect(broker.closes).toBe(1)
  })

  it('a subscription that dies LATER marks the worker degraded for the health body and hands the dead broker back', async () => {
    const broker = makeBroker()

    await startCalendarAuditConsumer('nats://x', undefined, async () => broker as never)
    expect(degradedWorkers()).toEqual([])
    expect(broker.closed).toBe(false)

    broker.subClosed.reject(
      Object.assign(new Error('[nats-broker] stream CALENDAR was deleted under subscription'), { name: 'StreamGoneError' }),
    )
    await new Promise((r) => setImmediate(r))

    const [degraded] = degradedWorkers()
    expect(degraded?.name).toBe(CALENDAR_AUDIT_WORKER)
    expect(degraded?.code).toBe('stream-gone')
    // Only the error CLASS and CODE reach the unauthenticated health body, never the broker's own text.
    expect(JSON.stringify(degraded)).not.toContain('was deleted under subscription')
    // The restart opens a NEW NatsBroker, so the one whose subscription just died has to be handed back here:
    // a dropped handle strands a live NATS connection for the life of the process.
    expect(broker.closed).toBe(true)
  })
})
