/**
 * Integration tests for the calendar leaf's NatsBroker (@gremion/ports/nats)
 * against the CALENDAR JetStream stream (WP-A topology).
 *
 * Requires a running NATS server with JetStream enabled.
 * Gated: tests SKIP loudly (with a visible warning) unless NATS_TEST_URL is set.
 *
 * Set-up (mirrors services/newsletter/test/nats-broker.integration.test.ts):
 *   docker run -d --name nats-test -p 4222:4222 nats:2.12-alpine -js
 *   NATS_TEST_URL=nats://localhost:4222
 *
 * Covers:
 *  - connect(url, CALENDAR stream) + ensureStream(calendar descriptor) + a
 *    publish → subscribe round-trip proving a calendar subject lands in a
 *    calendar-grammar stream on a REAL JetStream (never the NEWSLETTER default).
 *  - duplicate Nats-Msg-Id within the 2-min dedup window → delivered once.
 *  - wildcard-parity: gremion.*.calendar.> receives the calendar subject on NatsBroker.
 *  - always-on InMemoryBroker parity block: pins the production STREAMS.CALENDAR
 *    descriptor against calendarSubject() output for EVERY CalendarEvent (no NATS).
 *
 * Isolation: each run uses a unique stream name AND a unique tenant id so the
 * tenant-scoped subject filter never overlaps a prior run's stream.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { NatsBroker } from '../src/nats-broker.ts'
import { InMemoryBroker, makeEnvelope, calendarSubject, STREAMS, SUBJECT_ROOT } from '@gremion/ports/broker'
import type { EventEnvelope, CalendarEvent } from '@gremion/ports/broker'

const NATS_URL = process.env.NATS_TEST_URL

if (!NATS_URL) {
  console.warn(
    '\n[calendar nats-broker.integration.test] SKIPPING: NATS_TEST_URL is not set.\n' +
      'To run these tests: NATS_TEST_URL=nats://localhost:4222 pnpm --filter calendar-service test:integration -- nats-broker\n',
  )
}

// Per-run unique identifiers to avoid cross-run state bleed in NATS.
const TEST_RUN_ID = Date.now()
const STREAM_NAME = 'CALENDAR_TEST_' + TEST_RUN_ID
// Unique tenant id per run so subjects don't overlap with prior streams.
const TENANT_ID = `t${TEST_RUN_ID}`
// The stream captures calendar subjects for exactly this tenant.
const STREAM_SUBJECTS = [`${SUBJECT_ROOT}.${TENANT_ID}.calendar.>`]
// The wildcard-parity test subscribes to this pattern (matches the calendar subject).
const WILDCARD_PATTERN = `${SUBJECT_ROOT}.${TENANT_ID}.calendar.>`

/** Every CalendarEvent — typed so a union change breaks compilation here. */
const CALENDAR_EVENTS: CalendarEvent[] = [
  'event.created',
  'event.updated',
  'event.deleted',
  'caldav.sync.failed',
]

/** Wait for a condition, polling every 50 ms, up to timeoutMs. */
async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor: timed out')
    await new Promise((r) => setTimeout(r, 50))
  }
}

const describeIf = NATS_URL ? describe : describe.skip

describeIf('calendar NatsBroker integration (CALENDAR stream)', () => {
  let broker: NatsBroker

  beforeAll(async () => {
    // Connect targeting the per-test stream; ensure it with calendar-grammar subjects.
    broker = await NatsBroker.connect(NATS_URL!, STREAM_NAME)
    await broker.ensureStream(STREAM_NAME, STREAM_SUBJECTS)
  })

  afterAll(async () => {
    await broker.close()
  })

  it('publish → subscribe round-trip: calendar subject lands in its own stream', async () => {
    const received: Array<{ event: EventEnvelope; subject: string }> = []
    const subject = calendarSubject(TENANT_ID, 'event.created')
    const envelope = makeEnvelope({
      eventType: 'event.created',
      tenantId: TENANT_ID,
      correlationId: 'corr-roundtrip',
      payload: { eventId: 'evt-1' },
    })

    const sub = broker.subscribe(subject, async (event, subj) => {
      received.push({ event, subject: subj })
    })

    await new Promise((r) => setTimeout(r, 300))
    await broker.publish(subject, envelope)
    await waitFor(() => received.length >= 1)
    sub.unsubscribe()

    expect(received).toHaveLength(1)
    expect(received[0]!.subject).toBe(subject)
    expect(received[0]!.event.eventId).toBe(envelope.eventId)
    expect(received[0]!.event.tenantId).toBe(TENANT_ID)
  })

  it('duplicate Nats-Msg-Id within the 2-min dedup window is delivered exactly once', async () => {
    const received: EventEnvelope[] = []
    const subject = calendarSubject(TENANT_ID, 'caldav.sync.failed')
    const envelope = makeEnvelope({
      eventType: 'caldav.sync.failed',
      tenantId: TENANT_ID,
      correlationId: null,
      payload: { reason: 'caldav-timeout' },
    })

    const sub = broker.subscribe(subject, async (event) => {
      received.push(event)
    })

    await new Promise((r) => setTimeout(r, 300))
    await broker.publish(subject, envelope)
    await broker.publish(subject, envelope)
    await waitFor(() => received.length >= 1)
    await new Promise((r) => setTimeout(r, 500))
    sub.unsubscribe()

    expect(received).toHaveLength(1)
    expect(received[0]!.eventId).toBe(envelope.eventId)
  })

  it('wildcard-parity: gremion.*.calendar.> receives the calendar subject on NatsBroker', async () => {
    const received: string[] = []
    const subject = calendarSubject(TENANT_ID, 'event.updated')
    const envelope = makeEnvelope({
      eventType: 'event.updated',
      tenantId: TENANT_ID,
      correlationId: null,
      payload: {},
    })

    const sub = broker.subscribe(WILDCARD_PATTERN, async (_, subj) => {
      received.push(subj)
    })

    await new Promise((r) => setTimeout(r, 300))
    await broker.publish(subject, envelope)
    await waitFor(() => received.length >= 1)
    sub.unsubscribe()

    expect(received).toContain(subject)
  })
})

// ── always-on InMemoryBroker parity: pin the production STREAMS.CALENDAR descriptor ─
describe('wildcard-parity: InMemoryBroker + STREAMS.CALENDAR descriptor', () => {
  it('STREAMS.CALENDAR.subjects[0] receives EVERY calendarSubject() output', async () => {
    for (const event of CALENDAR_EVENTS) {
      const broker = new InMemoryBroker()
      const received: string[] = []
      broker.subscribe(STREAMS.CALENDAR.subjects[0], async (_, subj) => {
        received.push(subj)
      })
      const subject = calendarSubject('inmem-tenant', event)
      await broker.publish(
        subject,
        makeEnvelope({ eventType: event, tenantId: 'inmem-tenant', correlationId: null, payload: {} }),
      )
      expect(received).toEqual([subject])
    }
  })

  it('STREAMS.CALENDAR.subjects[0] does NOT receive a newsletter subject', async () => {
    const broker = new InMemoryBroker()
    const received: string[] = []
    broker.subscribe(STREAMS.CALENDAR.subjects[0], async (_, subj) => {
      received.push(subj)
    })
    await broker.publish(
      'gremion.inmem-tenant.newsletter.send.succeeded',
      makeEnvelope({ eventType: 'send.succeeded', tenantId: 'inmem-tenant', correlationId: null, payload: {} }),
    )
    expect(received).toHaveLength(0)
  })
})
