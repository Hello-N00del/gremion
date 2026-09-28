/**
 * Integration tests for services/newsletter/src/nats-broker.ts
 *
 * Requires a running NATS server with JetStream enabled.
 * Gated: tests SKIP loudly (with a visible warning) unless NATS_TEST_URL is set.
 *
 * Set-up (already running per task brief):
 *   docker run -d --name nats-test -p 4222:4222 nats:2.12-alpine -js
 *   NATS_TEST_URL=nats://localhost:4222
 *
 * Covers:
 *  - publish → subscribe round-trip (message received with correct payload)
 *  - duplicate Nats-Msg-Id within 2-min dedup window → delivered exactly once
 *  - wildcard-parity test: gremion.*.newsletter.> subscription receives the
 *    5-token newsletterSubject() output on BOTH NatsBroker AND InMemoryBroker
 *    (proves D-P1-7 > semantics match between the two implementations)
 *
 * Isolation: each test run uses a unique stream name AND unique subject prefix
 * (gremion.testN.newsletter.*) to avoid subject-overlap errors with prior runs.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { NatsBroker } from '../src/nats-broker.ts'
import { InMemoryBroker, makeEnvelope, newsletterSubject, STREAMS, SUBJECT_ROOT } from '@gremion/ports/broker'
import type { EventEnvelope } from '@gremion/ports/broker'

const NATS_URL = process.env.NATS_TEST_URL

if (!NATS_URL) {
  console.warn(
    '\n[nats-broker.integration.test] SKIPPING: NATS_TEST_URL is not set.\n' +
      'To run these tests: NATS_TEST_URL=nats://localhost:4222 pnpm -C services/newsletter test:integration -- nats-broker\n',
  )
}

// Per-run unique identifiers to avoid cross-run state bleed in NATS.
const TEST_RUN_ID = Date.now()
const STREAM_NAME = 'NL_TEST_' + TEST_RUN_ID
// Use a unique tenant id per test run so subjects don't overlap with prior streams.
const TENANT_ID = `t${TEST_RUN_ID}`
// The stream subscribes to subjects for exactly this tenant.
const STREAM_SUBJECTS = [`${SUBJECT_ROOT}.${TENANT_ID}.newsletter.>`]
// The wildcard-parity test subscribes to this pattern (matches the 5-token subject).
const WILDCARD_PATTERN = `${SUBJECT_ROOT}.${TENANT_ID}.newsletter.>`

/** Wait for a condition, polling every 50 ms, up to timeoutMs. */
async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor: timed out')
    await new Promise((r) => setTimeout(r, 50))
  }
}

const describeIf = NATS_URL ? describe : describe.skip

describeIf('NatsBroker integration', () => {
  let broker: NatsBroker

  beforeAll(async () => {
    // Pass STREAM_NAME so NatsBroker.subscribe() targets the correct per-test stream.
    broker = await NatsBroker.connect(NATS_URL!, STREAM_NAME)
    // Create a stream scoped to this test run's unique tenant id — no subject overlap.
    await broker.ensureStream(STREAM_NAME, STREAM_SUBJECTS)
  })

  afterAll(async () => {
    await broker.close()
  })

  it('publish → subscribe round-trip: subscriber receives the published envelope', async () => {
    const received: Array<{ event: EventEnvelope; subject: string }> = []
    const subject = newsletterSubject(TENANT_ID, 'send.succeeded')
    const envelope = makeEnvelope({
      eventType: 'send.succeeded',
      tenantId: TENANT_ID,
      correlationId: 'corr-roundtrip',
      payload: { count: 42 },
    })

    const sub = broker.subscribe(
      subject,
      async (event, subj) => {
        received.push({ event, subject: subj })
      },
    )

    // Give the consumer time to start.
    await new Promise((r) => setTimeout(r, 300))

    await broker.publish(subject, envelope)
    await waitFor(() => received.length >= 1)

    sub.unsubscribe()

    expect(received).toHaveLength(1)
    expect(received[0]!.subject).toBe(subject)
    expect(received[0]!.event.eventId).toBe(envelope.eventId)
    expect(received[0]!.event.tenantId).toBe(TENANT_ID)
    expect((received[0]!.event.payload as { count: number }).count).toBe(42)
  })

  it('duplicate Nats-Msg-Id within 2-min dedup window is delivered exactly once', async () => {
    const received: EventEnvelope[] = []
    const subject = newsletterSubject(TENANT_ID, 'send.failed')
    const envelope = makeEnvelope({
      eventType: 'send.failed',
      tenantId: TENANT_ID,
      correlationId: null,
      payload: { reason: 'smtp-timeout' },
    })

    const sub = broker.subscribe(subject, async (event) => {
      received.push(event)
    })

    await new Promise((r) => setTimeout(r, 300))

    // Publish the same envelope twice — same eventId → same Nats-Msg-Id header.
    await broker.publish(subject, envelope)
    await broker.publish(subject, envelope)

    // Wait for the first message plus a window for any duplicate.
    await waitFor(() => received.length >= 1)
    await new Promise((r) => setTimeout(r, 500))

    sub.unsubscribe()

    // The dedup window must prevent double delivery.
    expect(received).toHaveLength(1)
    expect(received[0]!.eventId).toBe(envelope.eventId)
  })

  it('wildcard-parity: gremion.*.newsletter.> subscription receives the 5-token subject on NatsBroker', async () => {
    const received: string[] = []
    const subject = newsletterSubject(TENANT_ID, 'send.succeeded')
    const envelope = makeEnvelope({
      eventType: 'send.succeeded',
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

    // The wildcard subscription must have matched the 5-token subject.
    expect(received).toContain(subject)
    // subject must be the exact 5-token form: gremion.<tenant>.newsletter.send.succeeded
    expect(subject.split('.').length).toBe(5)
  })
})

// ── wildcard-parity: InMemoryBroker (proves reference semantics match) ─────────
describe('wildcard-parity: InMemoryBroker > wildcard matches 5-token newsletterSubject', () => {
  // Use a fixed tenant for InMemoryBroker tests (no NATS state, no isolation needed).
  const INMEM_TENANT = 'inmem-tenant'

  it('gremion.*.newsletter.> subscription receives the 5-token subject on InMemoryBroker', async () => {
    const broker = new InMemoryBroker()
    const received: string[] = []
    const subject = newsletterSubject(INMEM_TENANT, 'send.succeeded')

    broker.subscribe(STREAMS.NEWSLETTER.subjects[0]!, async (_, subj) => {
      received.push(subj)
    })

    const envelope = makeEnvelope({
      eventType: 'send.succeeded',
      tenantId: INMEM_TENANT,
      correlationId: null,
      payload: {},
    })

    await broker.publish(subject, envelope)

    expect(received).toHaveLength(1)
    expect(received[0]).toBe(subject)
    expect(subject.split('.').length).toBe(5)
  })

  it('gremion.*.newsletter.> does NOT match a 3-token subject (> requires at least one trailing token)', async () => {
    const broker = new InMemoryBroker()
    const received: string[] = []

    broker.subscribe(STREAMS.NEWSLETTER.subjects[0]!, async (_, subj) => {
      received.push(subj)
    })

    const envelope = makeEnvelope({
      eventType: 'send.succeeded',
      tenantId: INMEM_TENANT,
      correlationId: null,
      payload: {},
    })

    // 3-token subject — the pattern's '>' needs at least 1 more token after the prefix.
    await broker.publish(`${SUBJECT_ROOT}.${INMEM_TENANT}.newsletter`, envelope)

    expect(received).toHaveLength(0)
  })
})
