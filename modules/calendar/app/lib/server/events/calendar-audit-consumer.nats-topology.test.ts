// modules/calendar/app/lib/server/events/calendar-audit-consumer.nats-topology.test.ts
//
// The calendar share of the f2 file gremion-ui/src/lib/server/events/nats-topology-wiring.test.ts, split per
// module (TASK-205a, ruling R28-O2: a kernel test may not import a module, so the kernel copy cannot carry
// the audit-consumer cases; each module keeps its own).
//
// WP-A regression: the monolith-side calendar audit consumer must bind its OWN domain stream (CALENDAR),
// not the shared NEWSLETTER default, and its subscribe pattern must be covered by that descriptor's subjects
// (and NOT by NEWSLETTER's). It is ALSO the guard on the wire ROOT: the literal below is pinned once so a
// kernel gitlink moved back to a pre-rename SHA cannot move the consumer and the stream together and stay
// green (both sides derive from the same SUBJECT_ROOT).
//
// `@gremion/ports/nats` is mocked with a recording fake NatsBroker; STREAMS is imported from the REAL,
// un-mocked, nats-free `@gremion/ports/broker`, so the assertions compare against the production topology.

import { describe, it, expect, beforeEach, vi } from 'vitest'

// Recorder + fake are created in a hoisted block so the (hoisted) vi.mock factory can reference them.
const rec = vi.hoisted(() => {
  const connect: string[] = []
  const ensureStream: Array<{ name: string; subjects: string[] }> = []
  const subscribe: string[] = []

  class FakeNatsBroker {
    constructor(public readonly streamName: string) {}
    static async connect(_natsUrl: string, streamName: string): Promise<FakeNatsBroker> {
      connect.push(streamName)
      return new FakeNatsBroker(streamName)
    }
    async ensureStream(name: string, subjects: string[]): Promise<void> {
      ensureStream.push({ name, subjects })
    }
    // The happy path: `ready` resolves (the stream covers the pattern), `closed` never settles, which is what
    // a live subscription looks like. The rejecting cases are the NATS adapter's own and the supervised test's.
    subscribe(pattern: string): BrokerSubscription {
      subscribe.push(pattern)
      return {
        ready: Promise.resolve(),
        closed: new Promise<void>(() => {}),
        unsubscribe() {},
      }
    }
    async close(): Promise<void> {}
  }

  return { connect, ensureStream, subscribe, FakeNatsBroker }
})

vi.mock('@gremion/ports/nats', () => ({ NatsBroker: rec.FakeNatsBroker }))

import { STREAMS, type BrokerSubscription } from '@gremion/ports/broker'
import {
  startCalendarAuditConsumer,
  CALENDAR_CONSUMER_PATTERN,
  _resetStartedForTests as resetCalendar,
} from './calendar-audit-consumer'

const URL = 'nats://topology-wiring-test:4222'

beforeEach(() => {
  rec.connect.length = 0
  rec.ensureStream.length = 0
  rec.subscribe.length = 0
  resetCalendar()
})

describe('calendar audit consumer binds the CALENDAR stream', () => {
  it('connects to + ensures STREAMS.CALENDAR and subscribes a CALENDAR-covered pattern (not NEWSLETTER)', async () => {
    await expect(startCalendarAuditConsumer(URL)).resolves.toBeUndefined()

    expect(rec.connect).toEqual([STREAMS.CALENDAR.name])
    expect(rec.ensureStream).toEqual([{ name: STREAMS.CALENDAR.name, subjects: STREAMS.CALENDAR.subjects }])
    expect(rec.subscribe).toEqual([CALENDAR_CONSUMER_PATTERN])

    expect(STREAMS.CALENDAR.subjects).toContain(CALENDAR_CONSUMER_PATTERN)
    expect(STREAMS.NEWSLETTER.subjects).not.toContain(CALENDAR_CONSUMER_PATTERN)
  })
})

describe('and the pattern is the one actually on the wire', () => {
  it('pins the consumer pattern and the stream filter to their literal', () => {
    expect(CALENDAR_CONSUMER_PATTERN).toBe('gremion.*.calendar.>')
    expect(STREAMS.CALENDAR.subjects).toEqual(['gremion.*.calendar.>'])
  })
})
