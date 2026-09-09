// packages/ports/src/broker.ts (@gremion/ports/broker)
// P0.5 (design §3.2/§6): the publish/subscribe PORT. Chosen transport: NATS +
// JetStream (P1 stands up one container scoped to the newsletter leaf).
// Escape hatch: Kafka would implement this same port — no further abstraction.
// JetStream mapping: publish() impls set Nats-Msg-Id = envelope.eventId for
// consumer-window dedup; consumers additionally keep a per-consumer
// idempotency-key table (design §4.4).
// P1 (D-P1-7): MOVED here from gremion-ui/src/lib/server/ports/broker.ts so both the
// monolith and the newsletter leaf share ONE reference implementation; the old
// gremion-ui path is now a re-export shim. The NATS adapter (T7) implements this
// EXACT BrokerPort + subjectMatches semantics (incl. the '>' extension below);
// InMemoryBroker stays the reference double.
//
// This module must stay free of the NATS transport: gremion-ui's jsdom vitest
// run collects the port's unit specs, and nats-topology.test.ts's header says
// why @nats-io/* must never load there. The error classes and timing bounds
// NatsBroker implements are therefore DEFINED here — a downstream boot path,
// a BrokerSubscription mock or a handler matching on `err.name` names them
// from the port alone — and re-exported by @gremion/ports/nats.
import { randomUUID } from 'node:crypto'
import { subjectMatches } from './subject-match.js'

/** THE single subject-namespace root. Every wire subject this module builds and
 *  every JetStream stream filter in STREAMS below derives from this one constant,
 *  so the namespace has exactly ONE definition: change it here and the helpers,
 *  the stream subject filters and every consumer pattern move together. A second
 *  hand-written root literal anywhere in this file would re-introduce the drift
 *  this constant exists to make impossible. */
export const SUBJECT_ROOT = 'gremion'

/** Field-matched to contracts/kernel/asyncapi.provisioning.json EventEnvelope. */
export interface EventEnvelope<T = unknown> {
  eventId: string
  eventType: string
  tenantId: string
  occurredAt: string // ISO 8601
  correlationId: string | null
  payload: T
}

// ── Timing bounds the adapter implements ─────────────────────────────────────
// ONE definition each. The real-server proofs import these, the runbooks quote
// them by name, and NatsBroker sizes its own mechanics from them — so the
// number a test pins, the number the docs state and the number the code
// enforces cannot drift apart (round 4 pinned "4 s" in a test the mechanism
// could only honour by luck, and documented "well under a second").

/** A live subscription whose STREAM or CONSUMER is deleted on the server faults
 *  within this many milliseconds: `closed` rejects with StreamGoneError /
 *  ConsumerGoneError and one error line is logged. Consumer deletion is
 *  answered by the server at once (a 409 to the pending pull); stream deletion
 *  is noticed through missed heartbeats and a probe, which is what this bound
 *  has to hold — see CONSUME_IDLE_HEARTBEAT_MS in @gremion/ports/nats. */
export const LIVENESS_FAULT_BOUND_MS = 5_000
/** subscribe()'s server round trips — the cover check, consumer creation,
 *  starting the pull — are each bounded. Past this, `ready` and `closed` reject
 *  with SetupTimeoutError. Above the JetStream API's own 5 s request timeout on
 *  purpose: the library's more specific error wins when the server answers at
 *  all; this is the backstop for a request the client keeps queued while it
 *  reconnects. */
export const SETUP_TIMEOUT_MS = 10_000
/** close() waits at most this long for live subscriptions to settle before it
 *  drains the connection regardless, warning with the patterns still pending.
 *  The drain is what must happen; the wait is a courtesy. */
export const CLOSE_TIMEOUT_MS = 5_000

// ── Port errors ──────────────────────────────────────────────────────────────

/**
 * subscribe() was refused: the bound stream, as the SERVER reports it, does
 * not cover the requested pattern. No consumer was created — one would have
 * been legal to create and would then have delivered nothing, forever.
 */
export class StreamCoverError extends Error {
  constructor(
    /** The stream this broker is bound to. */
    readonly stream: string,
    /** The pattern that was refused. */
    readonly pattern: string,
    /** What the server reports the stream captures. */
    readonly captured: readonly string[],
  ) {
    super(
      `[nats-broker] stream ${stream} does not cover subscription "${pattern}" ` +
        `(the server reports it captures [${captured.join(', ')}]) — this consumer could only ever receive nothing. ` +
        'Bind the broker to the stream that owns this domain (see STREAMS in @gremion/ports/broker), ' +
        'narrow the pattern to one the stream captures, or — if the stream is still on a retired wire root — ' +
        'follow "Migrating the wire-subject root" in docs/architecture.md.',
    )
    this.name = 'StreamCoverError'
  }
}

/**
 * publish() was refused: the bound stream, as the SERVER reports it, does not
 * capture the subject — or no longer exists at all (`captured` is then empty
 * and the message says so). JetStream's own answer would have been a bare
 * "no responders", which names neither the subject nor the stream.
 */
export class NoStreamError extends Error {
  constructor(
    readonly stream: string,
    readonly subject: string,
    readonly captured: readonly string[],
    /** Set when the refusal followed a failed publish attempt: that failure. */
    options?: ErrorOptions,
  ) {
    super(
      `[nats-broker] stream ${stream} does not capture subject "${subject}" ` +
        (captured.length === 0
          ? '(the server reports no such stream) '
          : `(the server reports it captures [${captured.join(', ')}]) `) +
        '— the event would be accepted by nobody. ' +
        'Bind the broker to the stream that owns this domain (see STREAMS in @gremion/ports/broker).',
      options,
    )
    this.name = 'NoStreamError'
  }
}

/**
 * A live subscription was faulted because THIS broker repointed the stream's
 * subject filter out from under it (ensureStream with `repointSubjects`).
 */
export class StreamRepointedError extends Error {
  constructor(
    readonly stream: string,
    readonly pattern: string,
    readonly from: readonly string[],
    readonly to: readonly string[],
  ) {
    super(
      `[nats-broker] subscription "${pattern}" on stream ${stream} was detached: the stream filter was repointed ` +
        `from [${from.join(', ')}] to [${to.join(', ')}]. The server will not say so — resubscribe on the new filter.`,
    )
    this.name = 'StreamRepointedError'
  }
}

/** A live subscription's STREAM was deleted on the server. Noticed within
 *  LIVENESS_FAULT_BOUND_MS: the server stops heart-beating the pull, the
 *  adapter probes and finds no stream. */
export class StreamGoneError extends Error {
  constructor(
    readonly stream: string,
    readonly pattern: string,
    options?: ErrorOptions,
  ) {
    super(
      `[nats-broker] subscription "${pattern}" on stream ${stream} is dead: the stream was deleted on the server, ` +
        'so it is receiving nothing. Recreate the stream (ensureStream) and resubscribe.',
      options,
    )
    this.name = 'StreamGoneError'
  }
}

/** A live subscription's CONSUMER is gone on the server — deleted, or absent
 *  when probed after missed heartbeats. Noticed within LIVENESS_FAULT_BOUND_MS. */
export class ConsumerGoneError extends Error {
  constructor(
    readonly stream: string,
    readonly pattern: string,
    /** What the server said: the 409 description, or the probe's answer. */
    readonly detail: string,
    options?: ErrorOptions,
  ) {
    super(
      `[nats-broker] subscription "${pattern}" on stream ${stream} is dead: its consumer is gone on the server ` +
        `(${detail}), so it is receiving nothing. Resubscribe.`,
      options,
    )
    this.name = 'ConsumerGoneError'
  }
}

/** A live subscription STALLED: the server sent no heartbeat across `probes`
 *  consecutive probes although the stream and the consumer both still exist.
 *  Whatever wedged it — a partition that lets JetStream API requests through
 *  but not deliveries, a flow-control lock-up — the subscription is receiving
 *  nothing and the server is not going to say so. */
export class ConsumerStalledError extends Error {
  constructor(
    readonly stream: string,
    readonly pattern: string,
    readonly probes: number,
  ) {
    super(
      `[nats-broker] subscription "${pattern}" on stream ${stream} stalled: no heartbeat from the server across ` +
        `${probes} consecutive probes although the stream and the consumer both exist, so it is receiving nothing. Resubscribe.`,
    )
    this.name = 'ConsumerStalledError'
  }
}

/** subscribe()'s setup did not complete: one server round trip (`step`) gave no
 *  answer within `timeoutMs` (SETUP_TIMEOUT_MS). `ready` and `closed` reject
 *  with this, so a boot that awaits `ready` cannot hang on a server that
 *  accepted the connection and then went quiet. */
export class SetupTimeoutError extends Error {
  constructor(
    readonly stream: string,
    readonly pattern: string,
    /** Which round trip: the cover check, consumer creation, or the pull. */
    readonly step: string,
    readonly timeoutMs: number,
  ) {
    super(
      `[nats-broker] subscription "${pattern}" on stream ${stream} could not be set up: ${step} did not answer ` +
        `within ${timeoutMs} ms.`,
    )
    this.name = 'SetupTimeoutError'
  }
}

export interface BrokerSubscription {
  /** An INTENDED stop. Ends delivery and releases the consumer; `closed` then
   *  settles promptly — on an idle subscription too, not only when the next
   *  message arrives. It settles RESOLVED, with one exception: a setup verdict
   *  that stands regardless of the stop (see `ready`) still rejects both
   *  promises. Calling it twice, or after the broker's close(), is a no-op. */
  unsubscribe(): void
  /**
   * Settles once the subscription is LIVE — or never will be.
   *
   * RESOLVES when the consumer exists and is delivering, or when an intended
   * stop (unsubscribe(), the broker's close()) ended the setup before that
   * point and the setup ended quietly. REJECTS when the subscription can never
   * deliver: the stream does not cover the pattern (NatsBroker:
   * StreamCoverError, decided by asking the server), the consumer could not be
   * set up (the server's own error), or a setup round trip did not answer
   * within SETUP_TIMEOUT_MS (SetupTimeoutError). A cover verdict OUTLIVES an
   * intended stop: `subscribe(uncovered); unsubscribe()` still rejects `ready`
   * and `closed` with StreamCoverError, because the verdict is about the
   * server, not about this subscription's lifecycle. `subscribe()` itself
   * stays synchronous — this is where its asynchronous outcome lands. `closed`
   * rejects with the same error in every rejecting case, so a caller that only
   * ever awaits `closed` still hears about it.
   *
   * Ignoring it is safe: implementations must not surface an unhandled
   * rejection when nobody attaches a handler.
   */
  readonly ready: Promise<void>
  /**
   * Settles when the subscription stops delivering.
   *
   * RESOLVES on an intended stop — unsubscribe(), or the broker's own close()
   * — except when setup had already reached a rejecting verdict (see `ready`).
   * REJECTS when it stopped for any other reason: setup failed (the same error
   * as `ready`); its filter was repointed away from under it (NatsBroker:
   * StreamRepointedError); its stream or consumer was deleted on the server
   * (StreamGoneError / ConsumerGoneError, within LIVENESS_FAULT_BOUND_MS of the
   * deletion); the server stopped heart-beating it although both still exist
   * (ConsumerStalledError); or its loop ended while the subscription was still
   * live (the connection closed). Every rejection is also logged once at error
   * level. Before this existed those last cases were indistinguishable from a
   * healthy subscription — the object stayed "live" and simply never delivered
   * again — so a caller that wants to fail loudly, restart, or alert now has
   * something to await.
   *
   * Ignoring it is safe: implementations must not surface an unhandled
   * rejection when nobody attaches a handler.
   *
   * The InMemoryBroker double produces NONE of the rejecting cases: it has no
   * server to disagree with it, its `ready` is pre-resolved and its `closed`
   * only ever resolves, on unsubscribe(). A downstream path written as
   * `sub.unsubscribe(); await sub.closed` is therefore green against the
   * double and can still reject against NatsBroker on a mis-covered subject —
   * which is the intended, loud outcome, not a parity bug to paper over.
   */
  readonly closed: Promise<void>
}

export interface BrokerPort {
  publish(subject: string, event: EventEnvelope): Promise<void>
  subscribe(
    subjectPattern: string,
    handler: (event: EventEnvelope, subject: string) => Promise<void>,
  ): BrokerSubscription
}

export function makeEnvelope<T>(args: {
  eventType: string; tenantId: string; correlationId: string | null; payload: T
}): EventEnvelope<T> {
  return { eventId: randomUUID(), occurredAt: new Date().toISOString(), ...args }
}

/** Subject grammar from the AsyncAPI doc: gremion.{tenantId}.provisioning.{aggregate}.{event} */
// CONTRACT ANCHOR — no producer yet: kept to back contracts/kernel/asyncapi.provisioning.json
// + the subject-disjointness proof in broker.test.ts (the 5-token provisioning grammar). Do
// not prune as "dead" — the producer lands when provisioning egress is wired.
export function provisioningSubject(
  tenantId: string,
  aggregate: 'org-unit' | 'member',
  event: 'requested' | 'succeeded' | 'failed' | 'abandoned',
): string {
  return `${SUBJECT_ROOT}.${tenantId}.provisioning.${aggregate}.${event}`
}

/** The newsletter module's two terminal events. Its outbox `event_type` column
 *  stores EXACTLY this short pair — NEVER a `newsletter.`-prefixed long form. */
export type NewsletterEvent = 'send.succeeded' | 'send.failed'

/** Subject grammar gremion.{tenantId}.newsletter.{event}. THE single place the
 *  newsletter wire subject is built, so producer and consumer cannot drift.
 *
 *  NOT IN THIS REPO: the newsletter module, its relay and consumer, and
 *  contracts/newsletter/asyncapi.newsletter.json all live in the module repo.
 *  The kernel keeps the grammar because the seam must be provably disjoint
 *  across domains (nats-topology.test.ts); broker.test.ts pins the shape here.
 *  Substituting a `newsletter.`-prefixed event verbatim would emit
 *  gremion.<t>.newsletter.newsletter.send.… and silently drift from it. */
export function newsletterSubject(tenantId: string, event: NewsletterEvent): string {
  return `${SUBJECT_ROOT}.${tenantId}.newsletter.${event}`
}

/** The calendar leaf's terminal events (event lifecycle + CalDAV push failures). */
export type CalendarEvent = 'event.created' | 'event.updated' | 'event.deleted' | 'caldav.sync.failed'

/** Subject grammar from contracts/calendar/asyncapi.calendar.json (that contract
 *  ships in this repo): gremion.{tenantId}.calendar.{event}. THE single place the
 *  calendar wire subject is built. The producing leaf and its audit consumer are
 *  NOT in this repo — they live in the module repo and derive from this helper. */
export function calendarSubject(tenantId: string, event: CalendarEvent): string {
  return `${SUBJECT_ROOT}.${tenantId}.calendar.${event}`
}

/** The org-unit mirror events. The kernel is the PRODUCER (org_units is a
 *  governance table it owns); a finance module CONSUMES them to keep its own
 *  mirror in sync instead of joining back into the kernel's `org_units`.
 *  'upserted' carries a full snapshot (id/name/kind/parent_id); 'deleted'
 *  carries the id (tombstone). */
export type OrgUnitEvent = 'upserted' | 'deleted'

/** Subject grammar for the org-unit mirror domain: gremion.{tenantId}.org-unit.{event}.
 *  THE single place the org-unit wire subject is built. Neither end is in this
 *  repo yet: the relay that publishes these and the finance-side consumer both
 *  live in the module repo. The `org-unit` domain token keeps it DISJOINT from
 *  the 5-token provisioning grammar (gremion.<t>.provisioning.org-unit.<event>) and
 *  from newsletter/content/calendar (proved by nats-topology.test.ts). */
export function orgUnitSubject(tenantId: string, event: OrgUnitEvent): string {
  return `${SUBJECT_ROOT}.${tenantId}.org-unit.${event}`
}

/** The content module's terminal events — field-matched to
 *  contracts/content/asyncapi.content.json, which ships in this repo. */
export type ContentEvent =
  | 'publish.succeeded'
  | 'publish.failed'
  | 'channel.email.sent'
  | 'channel.portal.sent'
  | 'channel.instagram.enqueued'

/** Subject grammar from contracts/content/asyncapi.content.json:
 *  gremion.{tenantId}.content.{event}. THE single place the content wire subject is
 *  built; the relay and consumer that use it live in the module repo, not here.
 *  Using a `content.`-prefixed event verbatim would emit
 *  gremion.<t>.content.content.… and silently drift from the contract. */
export function contentSubject(tenantId: string, event: ContentEvent): string {
  return `${SUBJECT_ROOT}.${tenantId}.content.${event}`
}

/** A JetStream stream descriptor: the durable stream name plus the NATS subject
 *  filter(s) it captures. WP-A: one stream PER event domain, each capturing ONLY
 *  its own domain's subjects, so a leaf/consumer targets its domain's stream by
 *  descriptor rather than defaulting every domain onto the single NEWSLETTER stream. */
export interface StreamDescriptor {
  name: string
  subjects: string[]
}

/** The JetStream stream topology — the SINGLE source of truth for which stream a
 *  domain's events land in. Each descriptor's subject filter is DISJOINT from the
 *  others (proved by nats-topology.test.ts), so content/calendar subjects land in
 *  CONTENT/CALENDAR and never silently miss a newsletter-only stream. The leaf
 *  entrypoints and the monolith audit consumers — both in the module repo, not
 *  here — bind their broker by descriptor — connect(url, STREAMS.X.name) + ensureStream(
 *  name, subjects) — instead of the pre-WP-A connect(url)/ensureStream() defaults. */
export const STREAMS = {
  NEWSLETTER: { name: 'NEWSLETTER', subjects: [`${SUBJECT_ROOT}.*.newsletter.>`] },
  CONTENT: { name: 'CONTENT', subjects: [`${SUBJECT_ROOT}.*.content.>`] },
  CALENDAR: { name: 'CALENDAR', subjects: [`${SUBJECT_ROOT}.*.calendar.>`] },
  ORGUNIT: { name: 'ORGUNIT', subjects: [`${SUBJECT_ROOT}.*.org-unit.>`] },
} satisfies Record<string, StreamDescriptor>

/** The stream NatsBroker.connect() binds to when no stream name is passed.
 *  Historical: NEWSLETTER was the first extracted domain and became the implicit
 *  default. It is a compatibility default, not a recommendation — bind by
 *  descriptor (STREAMS.X) instead. Sourced from STREAMS so the topology keeps one
 *  definition; tests pass a unique name to avoid bleed. */
export const DEFAULT_STREAM = STREAMS.NEWSLETTER.name

/** The STREAMS descriptor a stream NAME belongs to, or undefined for a name the
 *  topology does not know (a per-run test stream, say). NatsBroker uses this to
 *  learn what the stream it is bound to actually captures — WITHOUT restating a
 *  subject filter, and without defaulting every stream onto NEWSLETTER's. */
export function streamDescriptorFor(name: string): StreamDescriptor | undefined {
  return Object.values(STREAMS).find((s) => s.name === name)
}

// NATS subject matching lives in ./subject-match.ts, shared with the NATS
// adapter's stream-cover checks so the two can never disagree about the grammar.

/** Test/dev implementation. NOT durable, NOT cross-process — a unit-test double
 *  and the reference semantics for the P1 NATS adapter's DELIVERY (matching,
 *  ordering). It has no server, so it cannot produce any of the port errors
 *  above — see the BrokerSubscription contract for what that means for tests. */
export class InMemoryBroker implements BrokerPort {
  readonly published: Array<{ subject: string; event: EventEnvelope }> = []
  private subs: Array<{ pattern: string; handler: (e: EventEnvelope, s: string) => Promise<void>; active: boolean }> = []

  async publish(subject: string, event: EventEnvelope): Promise<void> {
    this.published.push({ subject, event })
    for (const sub of this.subs) {
      if (sub.active && subjectMatches(sub.pattern, subject)) await sub.handler(event, subject)
    }
  }

  subscribe(pattern: string, handler: (e: EventEnvelope, s: string) => Promise<void>): BrokerSubscription {
    const entry = { pattern, handler, active: true }
    this.subs.push(entry)
    // The double is live the moment it is registered and never dies on its
    // own, so `ready` is already resolved and `closed` only ever settles the
    // one way: resolved, by unsubscribe(). Both exist so test code can await
    // the same contract NatsBroker implements.
    let settle!: () => void
    const closed = new Promise<void>((resolve) => { settle = resolve })
    return { ready: Promise.resolve(), closed, unsubscribe: () => { entry.active = false; settle() } }
  }
}
