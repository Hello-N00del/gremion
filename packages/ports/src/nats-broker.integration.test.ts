// packages/ports/src/nats-broker.integration.test.ts
//
// Integration tests for the CANONICAL NatsBroker (@gremion/ports/nats) against a
// REAL NATS JetStream server. Written for the nats@2.x → @nats-io/* migration
// (the `nats` package is deprecated/EOL; this repo now depends on the maintained
// @nats-io/transport-node + @nats-io/jetstream + @nats-io/nats-core successors).
//
// This is the kernel-only carve (no services/* leaves live in this repo — see
// pnpm-workspace.yaml); the gremion-ui monolith's audit consumers are the only
// other importer of this class, so proving it here once, against a real
// server, is the canonical proof this repo relies on.
//
// Downstream, the SAME class is imported by every leaf (the newsletter/content/
// calendar services, each via their own services/*/test/nats-broker.integration.
// test.ts) plus that repo's monolith audit consumers. Those suites use the same
// NATS_TEST_URL env var and the same describeIf gate, so ONE throwaway server can
// validate the whole fleet — and so the two repos' copies stay diff-able.
//
// Requires a running NATS server with JetStream enabled.
// Gated: tests SKIP loudly (with a visible warning) unless NATS_TEST_URL is set:
//
//   make test-ports-nats            (or: ./packages/ports/scripts/nats-test.sh)
//
// That target is COMMITTED and reproducible, and it replaces the hand-pasted
// `docker run` recipe that used to live here. The recipe was the whole problem
// (integration defect D8, run findings 11, 25): because nothing in the repo ran
// it, the only gate that exercises ensureStream()'s default subjects and
// subscribe()'s error path was in practice never run, and a plain
// `pnpm --filter @gremion/ports test` reported GREEN with this entire file
// skipped. The target asserts the post-condition -- that THIS FILE's tests
// actually RAN and passed, by counting them in the verbose per-test lines --
// rather than the exit code, because vitest exits 0 on a fully skipped file.
//
// The port is 14222 on 127.0.0.1, deliberately neither the 4222 the leaf suites
// and services.yml use nor the 4224 of the retired recipe, so neither a
// developer's running stack nor a stale container from that recipe can collide.
// The script uses --filter rather than a path: downstream this package lives at
// upstream/gremion/packages/ports, so '-C packages/ports' resolves to nothing
// there.
//
// This file does NOT run through gremion-ui's jsdom monolith vitest run: its
// `*.integration.test.ts` files are excluded there (vite.config.ts) — and its
// `import { NatsBroker } from './nats-broker.js'` is exactly the module
// nats-topology.test.ts's header warns must never load under that run (it pulls
// the `nats` library, which must not load under jsdom).
//
// CI runner: .github/workflows/ports.yml. Before that workflow existed this
// file was collected by NOTHING in this repo (audit #434 finding 1) — gremion-ui's
// run excludes it by glob, and no workflow so much as path-filtered on
// `packages/ports/**`. ports.yml starts the JetStream container below and exports
// NATS_TEST_URL, so the proofs RUN instead of skipping. It is the kernel's
// only real-server proof of NatsBroker: this repo has no services/* leaves, so
// the leaf integration matrix that covers NatsBroker elsewhere does not cover
// the copy that lives HERE.
//
// Covers, against the real server (a double structurally cannot prove any of
// these — every one of them is about what the SERVER does or does not say):
//  1. publish → subscribe round-trip (plain delivery).
//  2. the subscribe error-handling path (audit #417 fix-now here; landed
//     downstream as 9131b5fe): a handler that THROWS must not kill the
//     `for await` consumer loop.
//  3. the Nats-Msg-Id dedup window rejects an exact replay.
//  4. the stream-cover check consults the SERVER's filter, not the STREAMS
//     topology and not the last ensureStream() argument: a subscription the
//     server's filter does not cover rejects `ready` and `closed` with
//     StreamCoverError and creates no consumer (T01 round 2 proved the
//     topology-driven check let exactly this case through, silently).
//  5. publish() to an uncaptured subject throws NoStreamError naming both.
//  6. ensureStream(): create (beforeAll), refresh-unchanged, refuse-on-drift,
//     and the opt-in repoint — the last one exercising jsm.streams.update()
//     with a CHANGED subject list against nats:2.12, which round 2 had only
//     ever run against a double.
//  7. termination semantics: unsubscribe() settles `closed` promptly on an
//     idle subscription; a closed connection under a live subscription faults
//     it (error log + rejected `closed`); broker.close() is silent and resolves
//     every `closed`; a deleted stream or consumer faults it with
//     StreamGoneError / ConsumerGoneError inside LIVENESS_FAULT_BOUND_MS (the
//     exported bound — imported here, never restated as a literal).
//  8. a repoint faults this broker's live subscriptions with
//     StreamRepointedError — the server itself says NOTHING when a filter moves
//     out from under an ordered consumer (round 2's probe: `closed` pending,
//     zero logs, zero deliveries after 8 s), so the signal has to be produced
//     client-side, and it is proved here that it is.
//  9. ensureStream() for a stream this broker is NOT bound to leaves its own
//     publish()/subscribe() checks alone (round 2 recorded that call in an
//     instance-wide slot and poisoned both checks in both directions).
// 10. publish() after the bound stream was deleted: NoStreamError with the
//     failed publish as `cause`, not the re-read's raw StreamNotFoundError.
//
// Isolation: each run uses unique stream names AND unique tenant/subject
// prefixes to avoid subject-overlap errors with prior runs (mirrors the sibling
// services/*/test/nats-broker.integration.test.ts files downstream).
//
// The "old root" in the drift tests is spelled `legacy.` — a placeholder, not
// either retired name. The real retired wire root is forbidden tree-wide by
// kernel-hygiene check h1 (a stale copy of it IS the failure being guarded),
// and the earlier working name is not used outwardly; for these proofs any
// root the server holds that the code does not is the same case.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { JetStreamManager } from '@nats-io/jetstream'
import type { NatsConnection } from '@nats-io/nats-core'
import {
  NatsBroker,
  StreamCoverError,
  NoStreamError,
  StreamRepointedError,
  StreamGoneError,
  ConsumerGoneError,
  LIVENESS_FAULT_BOUND_MS,
} from './nats-broker.js'
import { makeEnvelope, newsletterSubject, contentSubject } from './broker.js'
import type { BrokerSubscription, EventEnvelope } from './broker.js'

const NATS_URL = process.env.NATS_TEST_URL

if (!NATS_URL) {
  console.warn(
    '\n[ports nats-broker.integration.test] SKIPPING: NATS_TEST_URL is not set.\n' +
      'To run these tests: make test-ports-nats\n',
  )
}

const TEST_RUN_ID = Date.now()
const STREAM_NAME = 'PORTS_TEST_' + TEST_RUN_ID
const TENANT_ID = `t${TEST_RUN_ID}`
// One DISTINCT literal tenant token per test (never a `*` wildcard): a fresh
// ordered consumer with no explicit deliver_policy starts from the BEGINNING
// of the stream, so two tests sharing one subject would leak an earlier
// test's message into a later test's subscription. Distinct literal tenants
// give each test its own slice of the stream. Kept literal (not wildcarded)
// so the stream's subject filter can't overlap another stream on the same
// server — e.g. the sibling services/*/test/nats-broker.integration.test.ts
// suites downstream, which may run against this same throwaway server and each
// create their OWN stream scoped to their OWN (differently-timestamped) tenant.
const TENANT_RT = `${TENANT_ID}-rt`
const TENANT_ERR = `${TENANT_ID}-err`
const TENANT_DEDUP = `${TENANT_ID}-dedup`
const TENANT_IDLE = `${TENANT_ID}-idle`
const TENANT_CONN = `${TENANT_ID}-conn`
const TENANT_CLOSE = `${TENANT_ID}-close`
const TENANT_CDEL = `${TENANT_ID}-cdel`
const STREAM_SUBJECTS = [
  `gremion.${TENANT_RT}.newsletter.>`,
  `gremion.${TENANT_ERR}.newsletter.>`,
  `gremion.${TENANT_DEDUP}.newsletter.>`,
  `gremion.${TENANT_IDLE}.newsletter.>`,
  `gremion.${TENANT_CONN}.newsletter.>`,
  `gremion.${TENANT_CLOSE}.newsletter.>`,
  `gremion.${TENANT_CDEL}.newsletter.>`,
]

// A stream of its own for the stream-DELETION proof, so deleting it cannot
// detach the subscriptions every other test holds on STREAM_NAME.
const TENANT_SDEL = `${TENANT_ID}-sdel`
const DEL_STREAM = 'PORTS_DEL_' + TEST_RUN_ID

// A stream of its own for the publish-after-deletion proof, for the same reason.
const TENANT_PDEL = `${TENANT_ID}-pdel`
const PUB_DEL_STREAM = 'PORTS_PUBDEL_' + TEST_RUN_ID

// A second stream whose LIVE filter sits under a root the code does not use —
// the exact shape of a server that predates a wire-root rename. Not in the
// STREAMS topology, so nothing local has any belief about it: a refusal can
// only have come from asking the server.
const TENANT_DRIFT = `${TENANT_ID}-drift`
const DRIFT_STREAM = 'PORTS_DRIFT_' + TEST_RUN_ID
const DRIFT_SUBJECTS = [`legacy.${TENANT_DRIFT}.newsletter.>`]

// Streams for the two repoint proofs, one each so neither disturbs the other.
const TENANT_RP = `${TENANT_ID}-rp`
const REPOINT_STREAM = 'PORTS_REPOINT_' + TEST_RUN_ID
const TENANT_RS = `${TENANT_ID}-rs`
const RESUB_STREAM = 'PORTS_RESUB_' + TEST_RUN_ID

/**
 * Wait for a condition, polling every 50 ms, up to timeoutMs.
 *
 * The 4 s default sits deliberately UNDER vitest's 5 s default testTimeout, so
 * a genuine stall reports the actionable `waitFor: timed out` rather than
 * vitest's generic "Test timed out". Every synchronisation point on DELIVERY
 * below is expressed as a condition polled through here — there are
 * deliberately NO fixed `setTimeout(r, 300)`-style consumer-sync sleeps, because
 * a fixed sleep is simultaneously too slow on a fast machine and too short on a
 * loaded CI runner (audit #434 finding 4). The two properties that make the
 * fixed sleeps unnecessary here:
 *
 *  1. Subscribing does NOT have to happen before publishing. `subscribe()`
 *     creates a fresh ordered consumer with no explicit deliver_policy, which
 *     starts from the BEGINNING of the stream (the very property the per-test
 *     tenant tokens above exist to contain). A message published while the
 *     consumer is still being created is therefore still delivered — so
 *     "let the consumer loop start" sleeps are pure padding, and `waitFor` on
 *     the arrival itself is both correct and faster.
 *  2. Ordering is guaranteed by JetStream, not by sleeping. Messages published
 *     to one subject land in the stream in publish order, and ONE ordered
 *     consumer delivers them sequentially. So "give the handler a moment before
 *     the next publish" is likewise unnecessary — and a NEGATIVE assertion
 *     ("no duplicate arrives") is proved by a barrier message rather than by a
 *     settle sleep: once a later-published message has been delivered, anything
 *     the server would have delivered before it has already arrived.
 */
async function waitFor(cond: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor: timed out')
    await new Promise((r) => setTimeout(r, 50))
  }
}

/** The subscription is LIVE — its consumer exists on the server and is
 *  delivering. Every test that then cuts a connection, repoints a stream or
 *  unsubscribes needs this first, or it would be proving a setup race instead. */
async function live(sub: BrokerSubscription, what: string): Promise<void> {
  expect(
    sub.ready,
    `${what}: subscribe() returned no \`ready\` promise, so nothing can tell a live consumer from a refused one`,
  ).toBeInstanceOf(Promise)
  await sub.ready
}

/** Await a promise that MUST reject, and hand back what it rejected with. */
async function rejection(p: Promise<unknown> | undefined, what: string): Promise<Error> {
  expect(p, `${what}: no promise to await`).toBeInstanceOf(Promise)
  const outcome = await p!.then(
    () => undefined,
    (e: unknown) => e as Error,
  )
  expect(outcome, `${what}: resolved instead of rejecting`).toBeInstanceOf(Error)
  return outcome!
}

/** Reject if `p` has not settled within `ms`. */
function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms)),
  ])
}

/** The broker's own JetStream manager / connection — private slots, reached
 *  here only to ask the SERVER what it holds (consumer counts, stream filters). */
function jsmOf(b: NatsBroker): JetStreamManager {
  return (b as unknown as { jsm: JetStreamManager }).jsm
}
function ncOf(b: NatsBroker): NatsConnection {
  return (b as unknown as { nc: NatsConnection }).nc
}
async function serverFilter(b: NatsBroker, stream: string): Promise<string[]> {
  const info = await jsmOf(b).streams.info(stream)
  return info.config.subjects ?? []
}
async function consumerCount(b: NatsBroker, stream: string): Promise<number> {
  return (await jsmOf(b).consumers.list(stream).next()).length
}
/** The server-side name of the consumer whose filter is exactly `pattern`. */
async function consumerFiltering(b: NatsBroker, stream: string, pattern: string): Promise<string> {
  const infos = await jsmOf(b).consumers.list(stream).next()
  const mine = infos.find(
    (ci) => ci.config.filter_subject === pattern || (ci.config.filter_subjects ?? []).includes(pattern),
  )
  expect(mine, `no consumer on ${stream} filters "${pattern}"`).toBeDefined()
  return mine!.name
}

const describeIf = NATS_URL ? describe : describe.skip

describeIf('NatsBroker integration (@nats-io/* against a real JetStream server)', () => {
  let broker: NatsBroker
  // Extra brokers opened by individual tests, closed together at the end so a
  // failing assertion cannot leak a connection that keeps the worker alive.
  const opened: NatsBroker[] = []
  async function open(stream: string): Promise<NatsBroker> {
    const b = await NatsBroker.connect(NATS_URL!, stream)
    opened.push(b)
    return b
  }

  beforeAll(async () => {
    broker = await NatsBroker.connect(NATS_URL!, STREAM_NAME)
    // ensureStream() path 1 of 4: CREATE. Every delivery test below proves it
    // created the stream with these filters, on the server.
    await broker.ensureStream(STREAM_NAME, STREAM_SUBJECTS)
  })

  afterAll(async () => {
    // Guarded: when beforeAll cannot reach NATS_TEST_URL, `broker` is never
    // assigned and an unguarded close() throws a TypeError that buries the real
    // ECONNREFUSED under a useless "cannot read properties of undefined".
    await broker?.close()
    // No `.catch(() => {})`: several tests above close their broker themselves,
    // or cut its connection, so this is the SECOND close() for those — and
    // close() is specified idempotent and quiet. Round 3's catch here is what
    // hid the ClosedConnectionError it threw.
    for (const b of opened) await b.close()
  })

  it('publish -> subscribe round-trip: subscriber receives the published envelope', async () => {
    const tenantId = TENANT_RT
    const received: Array<{ event: EventEnvelope; subject: string }> = []
    const subject = newsletterSubject(tenantId, 'send.succeeded')
    const envelope = makeEnvelope({
      eventType: 'send.succeeded',
      tenantId,
      correlationId: 'corr-roundtrip',
      payload: { count: 42 },
    })

    const sub = broker.subscribe(subject, async (event, subj) => {
      received.push({ event, subject: subj })
    })

    // No "let the consumer loop start" sleep: the ordered consumer replays from
    // the beginning of the stream, so publishing during its creation is safe
    // (see waitFor's header, property 1). waitFor IS the synchronisation.
    await broker.publish(subject, envelope)
    await waitFor(() => received.length >= 1)
    sub.unsubscribe()

    expect(received).toHaveLength(1)
    expect(received[0]!.subject).toBe(subject)
    expect(received[0]!.event.eventId).toBe(envelope.eventId)
    expect((received[0]!.event.payload as { count: number }).count).toBe(42)
  })

  // ── The audit #417 / 9131b5fe subscribe error-handling proof ───────────────
  it('a handler that throws does NOT kill the consumer loop — the next message on the same subscription still delivers', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const tenantId = TENANT_ERR
      const received: string[] = [] // eventIds successfully handled
      const subject = newsletterSubject(tenantId, 'send.failed')

      const throwingEnvelope = makeEnvelope({
        eventType: 'send.failed',
        tenantId,
        correlationId: null,
        payload: { which: 'throws' },
      })
      const okEnvelope = makeEnvelope({
        eventType: 'send.failed',
        tenantId,
        correlationId: null,
        payload: { which: 'ok' },
      })

      const sub = broker.subscribe(subject, async (event) => {
        if (event.eventId === throwingEnvelope.eventId) {
          throw new Error('boom — simulated handler failure')
        }
        received.push(event.eventId)
      })

      // First message: the handler throws. This must be swallowed (logged, not
      // rethrown) so the `for await` loop survives.
      await broker.publish(subject, throwingEnvelope)

      // Second message on the SAME subscription: if the loop had died, this
      // would never arrive. This is the actual regression the fix guards.
      //
      // No sleep between the two publishes: JetStream keeps them in publish
      // order on this subject and ONE ordered consumer drains them
      // sequentially, so the throwing message is guaranteed to be handled
      // (and to throw) BEFORE the ok message is handled — the happens-before
      // edge the removed sleep was standing in for (see waitFor, property 2).
      await broker.publish(subject, okEnvelope)

      // Wait on BOTH observable effects rather than on the clock: the ok
      // message was delivered (loop survived) AND the throw was logged.
      await waitFor(() => received.length >= 1 && errorSpy.mock.calls.length >= 1)

      sub.unsubscribe()

      expect(received).toEqual([okEnvelope.eventId])
      // The error was surfaced (logged), not silently discarded.
      expect(errorSpy).toHaveBeenCalled()
      const loggedSubjects = errorSpy.mock.calls.map((c) => c[1])
      expect(loggedSubjects).toContain(subject)
    } finally {
      errorSpy.mockRestore()
    }
  })

  // ── JetStream-specific proof: Nats-Msg-Id dedup (an in-memory double cannot
  //    prove this — it requires the real server's duplicate-window tracking) ──
  it('duplicate Nats-Msg-Id within the 2-min dedup window is delivered exactly once', async () => {
    const tenantId = TENANT_DEDUP
    const received: EventEnvelope[] = []
    const subject = newsletterSubject(tenantId, 'send.succeeded')
    const envelope = makeEnvelope({
      eventType: 'send.succeeded',
      tenantId,
      correlationId: null,
      payload: { dedupProbe: true },
    })

    // A THIRD, DISTINCT message used as a delivery barrier (see below). Its own
    // eventId gives it its own Nats-Msg-Id, so the dedup window never touches it.
    const barrier = makeEnvelope({
      eventType: 'send.succeeded',
      tenantId,
      correlationId: null,
      payload: { barrier: true },
    })

    const sub = broker.subscribe(subject, async (event) => {
      received.push(event)
    })

    // Same envelope (same eventId -> same Nats-Msg-Id header) published twice.
    await broker.publish(subject, envelope)
    await broker.publish(subject, envelope)
    // Barrier publish, strictly AFTER both duplicates.
    await broker.publish(subject, barrier)

    // "Exactly once" is a NEGATIVE assertion, and the previous settle sleep was
    // a guess at how long a wrongful duplicate would take to show up. The
    // barrier turns it into a proof: the stream holds these messages in publish
    // order and one ordered consumer drains them sequentially, so if the server
    // HAD stored a second copy of `envelope` it would necessarily have been
    // delivered before the barrier. Barrier delivered => the duplicate question
    // is settled, no clock involved.
    await waitFor(() => received.some((e) => e.eventId === barrier.eventId))

    sub.unsubscribe()

    const probes = received.filter((e) => e.eventId === envelope.eventId)
    expect(probes).toHaveLength(1)
    // ...and it was the first thing delivered, ahead of the barrier.
    expect(received[0]!.eventId).toBe(envelope.eventId)
  })

  // ── 4. The silent-nothing proof, SERVER edition. A real server happily
  //    creates a consumer whose filter the bound stream does not capture and
  //    then delivers nothing to it, forever. Only the client can refuse it, only
  //    before it is created — and only by asking the server what the stream
  //    captures. This broker never called ensureStream() and its stream is not
  //    in STREAMS, so it has no local belief to fall back on: round 2's check
  //    skipped exactly this case, and the consumer was created, silently. ──
  it('subscribe() to a subject the SERVER stream filter does not cover rejects ready and closed with StreamCoverError and creates no consumer', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const fresh = await open(STREAM_NAME)
      const uncovered = contentSubject(TENANT_RT, 'publish.succeeded')
      const before = await consumerCount(fresh, STREAM_NAME)

      let delivered = 0
      const sub = fresh.subscribe(uncovered, async () => {
        delivered++
      })

      const readyErr = await rejection(sub.ready, `subscribe("${uncovered}") on ${STREAM_NAME}: ready`)
      expect(readyErr.name).toBe('StreamCoverError')
      expect(readyErr).toBeInstanceOf(StreamCoverError)
      // It names the subject and the stream, so an operator can act on the
      // message alone — and the server's filter, so they can see the drift.
      expect(readyErr.message).toContain(uncovered)
      expect(readyErr.message).toContain(STREAM_NAME)
      expect(readyErr.message).toContain(STREAM_SUBJECTS[0]!)

      const closedErr = await rejection(sub.closed, 'closed')
      expect(closedErr).toBe(readyErr)

      expect(await consumerCount(fresh, STREAM_NAME), 'a consumer was created for an uncoverable filter').toBe(before)
      expect(delivered).toBe(0)
      expect(errorSpy, 'a refused subscription must be reported at error level').toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })

  // ── 5. publish()'s mirror image. The server's own answer would be a bare
  //    "no responders", which names neither the subject nor the stream. ──
  it('publish() to a subject the bound stream does not capture throws NoStreamError naming the subject and the stream', async () => {
    const uncovered = contentSubject(TENANT_RT, 'publish.failed')
    const envelope = makeEnvelope({
      eventType: 'publish.failed',
      tenantId: TENANT_RT,
      correlationId: null,
      payload: {},
    })
    const err = await rejection(broker.publish(uncovered, envelope), `publish("${uncovered}")`)
    expect(err.name).toBe('NoStreamError')
    expect(err).toBeInstanceOf(NoStreamError)
    expect(err.message).toContain(uncovered)
    expect(err.message).toContain(STREAM_NAME)
  })

  // ── 6. ensureStream() path 3 of 4: REFUSE-ON-DRIFT, against the real stream
  //    this suite created. Repointing its filter would detach every consumer
  //    above. ──
  it('ensureStream() refuses to repoint the live stream filter and names both filters', async () => {
    const drifted = [`legacy.${TENANT_RT}.newsletter.>`]
    await expect(broker.ensureStream(STREAM_NAME, drifted)).rejects.toThrow(drifted[0]!)
    await expect(broker.ensureStream(STREAM_NAME, drifted)).rejects.toThrow(STREAM_SUBJECTS[0]!)

    // The stream is untouched, on the server.
    expect(await serverFilter(broker, STREAM_NAME)).toEqual(STREAM_SUBJECTS)
  })

  // ── ensureStream() path 2 of 4: REFRESH with an unchanged filter. ──
  it('ensureStream() with an unchanged filter refreshes the stream and a covered subscribe() still goes live', async () => {
    await broker.ensureStream(STREAM_NAME, STREAM_SUBJECTS)
    expect(await serverFilter(broker, STREAM_NAME)).toEqual(STREAM_SUBJECTS)

    const sub = broker.subscribe(newsletterSubject(TENANT_RT, 'send.succeeded'), async () => {})
    await live(sub, 'after an unchanged refresh')
    sub.unsubscribe()
    await within(sub.closed, 1000, 'closed after unsubscribe()')
  })

  // ── 7a. Termination: unsubscribe() on an IDLE subscription. Round 2 only
  //    flipped a flag the parked `for await` never re-read, so `closed` stayed
  //    pending and the ephemeral consumer leaked until the connection drained. ──
  it('unsubscribe() resolves closed within 1 s on an idle subscription', async () => {
    const b = await open(STREAM_NAME)
    const sub = b.subscribe(newsletterSubject(TENANT_IDLE, 'send.succeeded'), async () => {})
    await live(sub, 'idle subscription')

    sub.unsubscribe()
    await expect(within(sub.closed, 1000, 'closed after unsubscribe()')).resolves.toBeUndefined()
  })

  // ── 7b. Termination: the CONNECTION goes away under a live subscription. ──
  it('a closed connection under a live subscription logs an error and rejects closed', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const b = await open(STREAM_NAME)
      const subject = newsletterSubject(TENANT_CONN, 'send.succeeded')
      const sub = b.subscribe(subject, async () => {})
      await live(sub, 'subscription about to lose its connection')

      // Not drain(), not broker.close(): the raw connection, gone.
      await ncOf(b).close()

      const err = await rejection(within(sub.closed, 4000, 'closed after the connection closed'), 'closed')
      expect(err.message).toContain(subject)
      expect(errorSpy, 'a subscription that lost its connection must be reported at error level').toHaveBeenCalled()
      const reported = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n')
      expect(reported).toContain(subject)
      expect(reported).toContain(STREAM_NAME)
    } finally {
      errorSpy.mockRestore()
    }
  })

  // ── 7c. Termination: the broker's OWN close() is not a fault. ──
  it('broker.close() is silent and resolves every closed', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const b = await open(STREAM_NAME)
      const a = b.subscribe(newsletterSubject(TENANT_CLOSE, 'send.succeeded'), async () => {})
      const c = b.subscribe(newsletterSubject(TENANT_CLOSE, 'send.failed'), async () => {})
      await live(a, 'first subscription')
      await live(c, 'second subscription')

      await b.close()

      await expect(within(a.closed, 1000, 'first closed')).resolves.toBeUndefined()
      await expect(within(c.closed, 1000, 'second closed')).resolves.toBeUndefined()
      expect(errorSpy, 'close() reported its own shutdown as a fault').not.toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })

  // ── 8. + ensureStream() path 4 of 4: the OPT-IN REPOINT, against nats:2.12.
  //    The server accepts the update and says nothing to the consumer whose
  //    filter it just orphaned (round 2's probe). The broker that performed
  //    the repoint is the one place that knows, so it faults its own. ──
  it('an opt-in repoint faults this broker live subscriptions with StreamRepointedError and an error log', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const b = await open(REPOINT_STREAM)
      const oldFilter = [`gremion.${TENANT_RP}.newsletter.>`]
      const newFilter = [`gremion.${TENANT_RP}.calendar.>`]
      await b.ensureStream(REPOINT_STREAM, oldFilter)

      const pattern = newsletterSubject(TENANT_RP, 'send.succeeded')
      const sub = b.subscribe(pattern, async () => {})
      await live(sub, 'subscription about to be repointed away from')

      await b.ensureStream(REPOINT_STREAM, newFilter, { repointSubjects: true })

      const err = await rejection(within(sub.closed, 4000, 'closed after the repoint'), 'closed')
      expect(err.name).toBe('StreamRepointedError')
      expect(err).toBeInstanceOf(StreamRepointedError)
      expect(err.message).toContain(REPOINT_STREAM)
      expect(err.message).toContain(pattern)
      expect(err.message).toContain(newFilter[0]!)

      expect(errorSpy, 'a repointed-away subscription must be reported at error level').toHaveBeenCalled()
      const reported = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n')
      expect(reported).toContain(pattern)
      expect(reported).toContain(REPOINT_STREAM)

      // And the server really did move the filter: this is the update the
      // migration runbook tells an operator to perform.
      expect(await serverFilter(b, REPOINT_STREAM)).toEqual(newFilter)
    } finally {
      errorSpy.mockRestore()
    }
  })

  // ── Repoint-then-subscribe: the reviewers' probe. After the filter moved, a
  //    subscription to the OLD root must be refused, not created-and-silent. ──
  it('after a repoint, subscribe() to the old filter rejects ready with StreamCoverError and the new filter goes live', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const b = await open(RESUB_STREAM)
      await b.ensureStream(RESUB_STREAM, [`gremion.${TENANT_RS}.newsletter.>`])
      await b.ensureStream(RESUB_STREAM, [`gremion.${TENANT_RS}.calendar.>`], { repointSubjects: true })

      const stale = b.subscribe(newsletterSubject(TENANT_RS, 'send.succeeded'), async () => {})
      const err = await rejection(stale.ready, 'ready on the old filter after a repoint')
      expect(err).toBeInstanceOf(StreamCoverError)
      expect(err.message).toContain(`gremion.${TENANT_RS}.calendar.>`)

      const current = b.subscribe(`gremion.${TENANT_RS}.calendar.event.created`, async () => {})
      await live(current, 'subscription on the repointed filter')
      current.unsubscribe()
    } finally {
      errorSpy.mockRestore()
    }
  })

  // ── 9. ensureStream() for ANOTHER stream must not change what this broker's
  //    own checks are measured against. Round 2 stored the call's subjects in
  //    an instance-wide slot: the bound stream's own subject was then refused
  //    and the other stream's subject was accepted onto the wrong stream. ──
  it('ensureStream() for a stream this broker is not bound to leaves its own publish() and subscribe() checks alone', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await broker.ensureStream(DRIFT_STREAM, DRIFT_SUBJECTS)

      // Its OWN subject still publishes (round 2: false refuse, naming the
      // bound stream with the other stream's filters).
      await broker.publish(
        newsletterSubject(TENANT_RT, 'send.succeeded'),
        makeEnvelope({ eventType: 'send.succeeded', tenantId: TENANT_RT, correlationId: null, payload: {} }),
      )

      // The OTHER stream's subject is still refused on this one (round 2:
      // false accept — a live-looking consumer on a stream that cannot hold it).
      const foreign = `legacy.${TENANT_DRIFT}.newsletter.send.succeeded`
      const sub = broker.subscribe(foreign, async () => {})
      const err = await rejection(sub.ready, `subscribe("${foreign}") on ${STREAM_NAME}`)
      expect(err).toBeInstanceOf(StreamCoverError)
      expect(err.message).toContain(STREAM_NAME)
    } finally {
      errorSpy.mockRestore()
    }
  })

  // ── The migration case itself: the SERVER holds a stream under the old
  //    root. The code has no belief about this stream at all (not in STREAMS,
  //    never ensured by this broker), so both answers below can only have come
  //    from the server's filter. Depends on the previous test having created
  //    DRIFT_STREAM. ──
  it('subscribe() consults the SERVER: a stream still on the old root accepts the old-root subject and refuses the new-root one', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const b = await open(DRIFT_STREAM)

      const onOldRoot = b.subscribe(`legacy.${TENANT_DRIFT}.newsletter.send.succeeded`, async () => {})
      await live(onOldRoot, 'old-root subscription on the old-root stream')
      onOldRoot.unsubscribe()

      const onNewRoot = b.subscribe(newsletterSubject(TENANT_DRIFT, 'send.succeeded'), async () => {})
      const err = await rejection(onNewRoot.ready, 'new-root subscription on the old-root stream')
      expect(err).toBeInstanceOf(StreamCoverError)
      expect(err.message).toContain(DRIFT_SUBJECTS[0]!)
    } finally {
      errorSpy.mockRestore()
    }
  })

  // ── 10. Precedence. A StreamCoverError verdict is about the SERVER, not about
  //    this subscription's lifecycle: an unsubscribe() or close() issued while
  //    the cover check was still in flight does not make an uncoverable pattern
  //    coverable. Round 3 treated either as an intended stop and resolved
  //    `ready` and `closed` — the refusal was erased, and a process that
  //    subscribed at boot and shut down cleanly never learned its subscription
  //    could never have delivered. ──
  it('subscribe() to an uncovered subject followed by unsubscribe() still rejects ready and closed with StreamCoverError and logs once', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const fresh = await open(STREAM_NAME)
      const uncovered = contentSubject(TENANT_RT, 'publish.succeeded')
      const sub = fresh.subscribe(uncovered, async () => {})
      sub.unsubscribe()

      const readyErr = await rejection(within(sub.ready, 4000, 'ready after unsubscribe()'), 'ready')
      expect(readyErr).toBeInstanceOf(StreamCoverError)
      const closedErr = await rejection(within(sub.closed, 4000, 'closed after unsubscribe()'), 'closed')
      expect(closedErr).toBe(readyErr)
      expect(errorSpy, 'the refusal must be reported exactly once').toHaveBeenCalledTimes(1)
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('subscribe() to an uncovered subject followed by broker.close() still rejects ready and closed with StreamCoverError and logs once', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const fresh = await open(STREAM_NAME)
      const uncovered = contentSubject(TENANT_RT, 'publish.failed')
      const sub = fresh.subscribe(uncovered, async () => {})
      await fresh.close()

      const readyErr = await rejection(within(sub.ready, 4000, 'ready after close()'), 'ready')
      expect(readyErr).toBeInstanceOf(StreamCoverError)
      const closedErr = await rejection(within(sub.closed, 4000, 'closed after close()'), 'closed')
      expect(closedErr).toBe(readyErr)
      expect(errorSpy, 'the refusal must be reported exactly once').toHaveBeenCalledTimes(1)
    } finally {
      errorSpy.mockRestore()
    }
  })

  // ── 7d./7e. Termination: the STREAM or the CONSUMER is deleted under a live
  //    subscription. The server volunteers exactly one answer — a 409
  //    "Consumer Deleted" to a PENDING pull — and abort_on_missing_resource
  //    turns that into the loop's death. A stream deleted between pulls gets
  //    no answer at all: round 4 measured that fault at 0 ms or at ~30 s (the
  //    library's default pull expiry), never in between, and the gate flaked on
  //    it. The pull is now sized (expires / idle_heartbeat) and the consumer's
  //    status() notifications are consumed, so missed heartbeats probe the
  //    server and the fault arrives inside LIVENESS_FAULT_BOUND_MS — the ONE
  //    bound, exported by the broker, that the docs quote and these proofs
  //    import. No literal bound here: a bound the tests pin and the docs state
  //    separately is two numbers, and two numbers drift. ──
  it(
    'deleting the bound stream under a live subscription logs an error and rejects closed with StreamGoneError within LIVENESS_FAULT_BOUND_MS',
    async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const b = await open(DEL_STREAM)
        await b.ensureStream(DEL_STREAM, [`gremion.${TENANT_SDEL}.newsletter.>`])
        const pattern = newsletterSubject(TENANT_SDEL, 'send.succeeded')
        const sub = b.subscribe(pattern, async () => {})
        await live(sub, 'subscription whose stream is about to be deleted')

        expect(await jsmOf(b).streams.delete(DEL_STREAM)).toBe(true)
        const deletedAt = Date.now()

        const err = await rejection(within(sub.closed, LIVENESS_FAULT_BOUND_MS, 'closed after the stream was deleted'), 'closed')
        // The measured behaviour, for the docs to quote: the verbose reporter
        // prints stdout per test.
        console.log('[liveness] stream deletion faulted after %d ms (bound %d ms)', Date.now() - deletedAt, LIVENESS_FAULT_BOUND_MS)
        expect(err).toBeInstanceOf(StreamGoneError)
        expect(err.message).toContain(pattern)
        expect(err.message).toContain(DEL_STREAM)
        expect(errorSpy, 'a subscription whose stream was deleted must be reported at error level').toHaveBeenCalledTimes(1)
        const reported = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n')
        expect(reported).toContain(pattern)
        expect(reported).toContain(DEL_STREAM)
      } finally {
        errorSpy.mockRestore()
      }
    },
    LIVENESS_FAULT_BOUND_MS + 5_000,
  )

  it(
    'deleting the consumer under a live subscription logs an error and rejects closed with ConsumerGoneError within LIVENESS_FAULT_BOUND_MS',
    async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const b = await open(STREAM_NAME)
        const pattern = newsletterSubject(TENANT_CDEL, 'send.succeeded')
        const sub = b.subscribe(pattern, async () => {})
        await live(sub, 'subscription whose consumer is about to be deleted')

        const name = await consumerFiltering(b, STREAM_NAME, pattern)
        expect(await jsmOf(b).consumers.delete(STREAM_NAME, name)).toBe(true)
        const deletedAt = Date.now()

        const err = await rejection(within(sub.closed, LIVENESS_FAULT_BOUND_MS, 'closed after the consumer was deleted'), 'closed')
        console.log('[liveness] consumer deletion faulted after %d ms (bound %d ms)', Date.now() - deletedAt, LIVENESS_FAULT_BOUND_MS)
        expect(err).toBeInstanceOf(ConsumerGoneError)
        expect(err.message).toContain(pattern)
        expect(err.message).toContain(STREAM_NAME)
        expect(errorSpy, 'a subscription whose consumer was deleted must be reported at error level').toHaveBeenCalledTimes(1)
        const reported = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n')
        expect(reported).toContain(pattern)
        expect(reported).toContain(STREAM_NAME)
      } finally {
        errorSpy.mockRestore()
      }
    },
    LIVENESS_FAULT_BOUND_MS + 5_000,
  )

  // ── 5b. publish() after the bound stream was DELETED — the producer side of
  //    step 2 of the cutover. The cached filter still says "captured", the
  //    server answers the publish with "no responders", and the re-read finds
  //    no stream: round 4 let the re-read's StreamNotFoundError escape raw,
  //    naming neither the subject nor the failed publish. ──
  it('publish() after the bound stream was deleted rejects with NoStreamError carrying the failed publish as cause', async () => {
    const b = await open(PUB_DEL_STREAM)
    await b.ensureStream(PUB_DEL_STREAM, [`gremion.${TENANT_PDEL}.newsletter.>`])
    const subject = newsletterSubject(TENANT_PDEL, 'send.succeeded')
    const envelope = () =>
      makeEnvelope({ eventType: 'send.succeeded', tenantId: TENANT_PDEL, correlationId: null, payload: {} })
    await b.publish(subject, envelope()) // primes the server-derived cache

    expect(await jsmOf(b).streams.delete(PUB_DEL_STREAM)).toBe(true)

    const err = await rejection(within(b.publish(subject, envelope()), 10_000, 'publish() after the stream was deleted'), 'publish')
    expect(err.name).toBe('NoStreamError')
    expect(err).toBeInstanceOf(NoStreamError)
    expect(err.message).toContain(subject)
    expect(err.message).toContain(PUB_DEL_STREAM)
    expect(err.cause, 'the failed publish attempt is not chained as the cause').toBeInstanceOf(Error)
  })

  // ── 7f. close() is idempotent and quiet. Round 3 drained unconditionally: a
  //    second call, or a call after the connection had already gone, threw
  //    ClosedConnectionError — and this suite's teardown hid that behind
  //    `.catch(() => {})`. The teardown now closes every broker a second time
  //    with no catch, so a regression here fails the suite on its own. ──
  it('close() is idempotent and quiet: twice on a healthy broker, and after a raw connection close', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const healthy = await open(STREAM_NAME)
      await healthy.close()
      await expect(healthy.close(), 'second close() on an already-closed broker').resolves.toBeUndefined()

      const cut = await open(STREAM_NAME)
      await ncOf(cut).close()
      await expect(cut.close(), 'close() after the connection was closed underneath it').resolves.toBeUndefined()

      expect(errorSpy, 'a redundant close() is not a fault').not.toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })
})
