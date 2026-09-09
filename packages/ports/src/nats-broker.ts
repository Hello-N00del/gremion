// packages/ports/src/nats-broker.ts (@gremion/ports/nats)
//
// NatsBroker — NATS JetStream implementation of BrokerPort (@gremion/ports/broker).
//
// LIFTED here from the newsletter module's own broker so
// BOTH processes (the newsletter leaf and the gremion-ui monolith) import ONE
// canonical implementation. The leaf's esbuild bundle externalises the nats-io
// packages (--external:@nats-io/transport-node --external:@nats-io/jetstream
// --external:@nats-io/nats-core); gremion-ui's Vite SSR build leaves node_modules
// external by default, so those packages are likewise treated as a peer dep on
// both sides.
//
// nats@2.x → @nats-io/* migration (the deprecated `nats` package is EOL; the
// maintained successor is the modular @nats-io/* family). Mapping applied here:
//  - connect() moves from `nats` to @nats-io/transport-node (same shape: takes
//    { servers } and returns Promise<NatsConnection>).
//  - headers()/MsgHdrs move to @nats-io/nats-core (re-exported by nats 2.x
//    from the same monolithic package; now its own module).
//  - nc.jetstream() / nc.jetstreamManager() (methods on the connection in 2.x)
//    become the free functions jetstream(nc) / jetstreamManager(nc) from
//    @nats-io/jetstream. RetentionPolicy/StorageType move there too.
//  - StringCodec/JSONCodec are gone in the new API — moot here, this file never
//    used them: publish() already hands JetStream a plain string (`Payload =
//    Uint8Array | string` is unchanged) and subscribe() already decodes with
//    TextDecoder + JSON.parse, so neither needed a codec shim.
//  - BREAKING field rename: the ordered-consumer filter option was camelCase
//    `filterSubjects` in nats 2.x; the current @nats-io/jetstream type
//    (OrderedConsumerOptions) renamed it to snake_case `filter_subjects` — the
//    actual runtime code (jsmstream_api.js) only reads `opts.filter_subjects`,
//    so the old camelCase key would now silently install an UNFILTERED ordered
//    consumer (a runtime-only footgun the package's own README examples still
//    show as `filterSubjects` — do not trust that doc, trust the .d.ts + the
//    integration test). Verified end-to-end against a live nats:2.12-alpine
//    JetStream server in nats-broker.integration.test.ts.
//
// Wire behaviour:
//  - publish(): publishes via JetStream; sets the Nats-Msg-Id header to
//    envelope.eventId so the stream's 2-minute deduplication window rejects
//    exact replays (idempotent publish, D-P1-7). First asks the SERVER what the
//    bound stream captures and throws NoStreamError for a subject it does not.
//  - subscribe(): creates an ephemeral ordered consumer on the stream, filtered
//    to the provided subject pattern. Uses the NATS '*'/'>' wildcard syntax
//    which matches the @gremion/ports subjectMatches semantics (same rules,
//    shared via ./subject-match.ts and enforced by the wildcard-parity test in
//    nats-broker.integration.test.ts). Ordered consumers auto-recreate on
//    interruptions and don't require ack. Before the consumer is created the
//    SERVER's stream filter is fetched and must cover the pattern; otherwise
//    `ready` and `closed` reject with StreamCoverError and no consumer exists.
//  - ensureStream(): idempotent boot call that creates the BOUND stream with:
//      subjects:    the bound stream's STREAMS entry (sourced from ./broker.ts —
//                   restating the literal here would survive a STREAMS-only
//                   rename and silently re-point the stream filter)
//      storage:     'file'
//      max_age:     7 days (nanoseconds)
//      max_msgs:    50_000
//      duplicate_window: 2 minutes (nanoseconds)
//    If the stream already exists it refreshes those limits, but REFUSES to
//    move an existing subject filter unless explicitly told to.
//
// SERVER TRUTH. Every cover check in this file is answered from what
// `jsm.streams.info()` reports for the bound stream — never from the STREAMS
// topology, never from the last ensureStream() argument, and with no "unknown,
// so skip": the T01 round-2 version answered from what the code BELIEVED the
// stream held, and a server whose stream predated a wire-root rename sailed
// straight through it — the very migration the check exists for.
//  - subscribe() asks the server at the moment of the call. It is the boot-time
//    migration guard and runs once per subscription.
//  - publish() answers from a cache of the server's LAST answer (round 3 paid a
//    round trip per event). The cache is derived from the server only, and it
//    is never allowed to refuse: a subject the cached filter does not capture
//    is re-read from the server before NoStreamError is thrown, so an
//    operator's `nats stream edit` cannot produce a false refusal. It is
//    dropped by ensureStream() on the bound stream and by a transient publish
//    error, after which publish() re-reads, re-checks and retries ONCE
//    (Nats-Msg-Id makes the retry idempotent inside the dedup window). When
//    the re-read itself fails, the failed publish survives as the `cause`.
//
// LIVENESS. The server volunteers exactly ONE signal about a dead
// subscription: a 409 "consumer deleted" to a PENDING pull, and
// `abort_on_missing_resource` turns that into the loop's death. A stream
// deleted between pulls gets no answer — round 4 measured that fault arriving
// at 0 ms or at ~30 s (the library's default pull expiry), never in between,
// and the gate flaked on it. Two things close that gap, both bounded by
// LIVENESS_FAULT_BOUND_MS (@gremion/ports/broker — the one number the tests
// import and the docs quote):
//  - the pull is SIZED: `expires` CONSUME_EXPIRES_MS, `idle_heartbeat`
//    CONSUME_IDLE_HEARTBEAT_MS. The server heart-beats an idle pull at that
//    interval; the library's monitor ticks at it and, after two silent ticks
//    in a row, re-checks the consumer with the JetStream API — which, with the
//    abort flag, ends the loop on "stream not found";
//  - the consumer's status() notifications are CONSUMED: `stream_not_found`,
//    `consumer_deleted` and `consumer_not_found` fault at once (StreamGoneError
//    / ConsumerGoneError), and `heartbeats_missed` triggers a PROBE — the
//    stream via streams.info(), then the consumer via consumer.info() — that
//    faults on whichever is gone. Both present and still no heartbeat is a
//    STALL; STALL_PROBE_LIMIT consecutive such probes fault the subscription
//    with ConsumerStalledError (a heartbeat in between starts the count over).
//
// Failure paths — every one of these used to end in silence. Each is specified
// against doubles in nats-broker-subscribe.integration.test.ts and proved
// against nats:2.12 in nats-broker.integration.test.ts:
//  - a subscription the server's filter cannot cover is refused BEFORE the
//    consumer exists (the server would create it and deliver nothing forever);
//  - a consumer loop that ends while the subscription is still active — the
//    connection closed — logs at error level and rejects the subscription's
//    `closed` promise;
//  - the stream or the consumer is DELETED under a live subscription: see
//    LIVENESS above. `closed` rejects with StreamGoneError / ConsumerGoneError
//    naming the pattern and the stream, inside LIVENESS_FAULT_BOUND_MS;
//  - a setup round trip that never answers: bounded by SETUP_TIMEOUT_MS, then
//    `ready`/`closed` reject with SetupTimeoutError;
//  - a StreamCoverError verdict outlives an intended stop: unsubscribe() or
//    close() issued while the cover check is in flight still rejects `ready`
//    and `closed` with it and logs once. The verdict is about the server, not
//    about this subscription's lifecycle (round 3 resolved both as a clean
//    stop, erasing it);
//  - ensureStream() refuses to repoint a live stream's subject filter, and
//    rethrows a non-not-found streams.info() error instead of mistaking it for
//    "the stream does not exist";
//  - an OPT-IN repoint faults this broker's live subscriptions with
//    StreamRepointedError. The server produces no signal of its own here:
//    against nats 2.12 / @nats-io/jetstream 3.4 a moved filter leaves an
//    ordered consumer created, silent and apparently healthy (round 2's probe:
//    `closed` pending, zero logs, zero deliveries). The broker performing the
//    repoint is the one place that knows, so it says so;
//  - publish() to an uncaptured subject throws NoStreamError naming the
//    subject and the stream — also after the stream was DELETED under a
//    producer, with the failed publish attempt as `cause`;
//  - a messages.close() that rejects is logged (it is what makes an intended
//    stop settle `closed`, so its failure is exactly the hang that must not be
//    silent).
//
// Lifecycle:
//  - create NatsBroker with connect() (static factory, awaited at boot).
//  - call broker.ensureStream() before first publish.
//  - unsubscribe() ENDS the consumer iterator: `closed` resolves promptly and
//    the ephemeral consumer is released, connection kept. (A stop that lands
//    after consumers.get() created the consumer but before consume() leaves
//    it to the server's 5-minute inactive-threshold reaper — bounded, not
//    released.)
//  - call broker.close() on shutdown — it stops every live subscription
//    FIRST, waits for each one's outcome for at most CLOSE_TIMEOUT_MS (a
//    warning names any still pending), then drains, so a clean shutdown is
//    quiet and resolves every `closed`. Idempotent and shared: concurrent and
//    repeated calls get the ONE in-flight shutdown; a drain that fails because
//    the connection is already closed is tolerated (debug log); any other
//    failure is rethrown AND forgotten, so a later close() tries again.

import { connect } from '@nats-io/transport-node'
import { headers, ClosedConnectionError, RequestError, TimeoutError } from '@nats-io/nats-core'
import type { NatsConnection } from '@nats-io/nats-core'
import {
  jetstream,
  jetstreamManager,
  JetStreamApiCodes,
  JetStreamApiError,
  RetentionPolicy,
  StorageType,
} from '@nats-io/jetstream'
import type {
  Consumer,
  ConsumerMessages,
  JetStreamClient,
  JetStreamManager,
  JetStreamPublishOptions,
} from '@nats-io/jetstream'
import type { BrokerPort, BrokerSubscription, EventEnvelope } from './broker.js'
import {
  DEFAULT_STREAM,
  streamDescriptorFor,
  StreamCoverError,
  NoStreamError,
  StreamRepointedError,
  StreamGoneError,
  ConsumerGoneError,
  ConsumerStalledError,
  SetupTimeoutError,
  LIVENESS_FAULT_BOUND_MS,
  SETUP_TIMEOUT_MS,
  CLOSE_TIMEOUT_MS,
} from './broker.js'
import { streamCovers } from './subject-match.js'

// NATS.js uses nanoseconds as plain numbers (not bigint) for stream time fields.
/** 7 days in nanoseconds. */
const MAX_AGE_NS = 7 * 24 * 60 * 60 * 1_000_000_000
/** 2 minutes in nanoseconds. */
const DEDUP_WINDOW_NS = 2 * 60 * 1_000_000_000
const MAX_MSGS = 50_000

// The default production stream name lives in ./broker.ts (the STREAMS topology,
// the single source of truth) so it stays === 'NEWSLETTER'. Re-exported here so
// existing `@gremion/ports/nats` importers (the leaf nats-broker.ts shims) keep
// resolving DEFAULT_STREAM from this module unchanged.
export { DEFAULT_STREAM }
// The port errors and bounds are DEFINED in ./broker.ts (the port must stay
// free of the NATS transport — see its header) and re-exported here so every
// existing `@gremion/ports/nats` importer keeps resolving them unchanged.
export {
  StreamCoverError,
  NoStreamError,
  StreamRepointedError,
  StreamGoneError,
  ConsumerGoneError,
  ConsumerStalledError,
  SetupTimeoutError,
  LIVENESS_FAULT_BOUND_MS,
  SETUP_TIMEOUT_MS,
  CLOSE_TIMEOUT_MS,
}

/** The interval at which the server heart-beats an idle pull, and at which the
 *  library's monitor checks for one. The monitor fires after two silent ticks
 *  in a row, i.e. at most three ticks after the last heartbeat; one JetStream
 *  API round trip (the probe) follows. That is what LIVENESS_FAULT_BOUND_MS
 *  has to hold — nats-broker-subscribe.integration.test.ts pins
 *  `3 * CONSUME_IDLE_HEARTBEAT_MS < LIVENESS_FAULT_BOUND_MS`. The library's
 *  floor is 500 ms; lower means more heartbeat traffic per idle consumer. */
export const CONSUME_IDLE_HEARTBEAT_MS = 1_000
/** How long one pull request stays open on the server before the client
 *  re-issues it. The library's floor is 1000 ms and its default heartbeat is
 *  half of this — kept at exactly twice the heartbeat so the two stay in the
 *  ratio the library assumes. One re-pull per idle consumer per interval is
 *  the cost. */
export const CONSUME_EXPIRES_MS = 2 * CONSUME_IDLE_HEARTBEAT_MS
/** Consecutive missed-heartbeat probes that find the stream AND the consumer
 *  present before the subscription is faulted as stalled. Each probe follows
 *  the library's own re-pull attempt, so a wedge that a re-pull can clear has
 *  had that many chances. */
export const STALL_PROBE_LIMIT = 3

/** Options for {@link NatsBroker.ensureStream}. */
export interface EnsureStreamOptions {
  /**
   * Allow this call to REPOINT an existing stream's subject filter.
   *
   * Off by default, and deliberately awkward. `jsm.streams.update()` will
   * happily move a live stream's filter, which orphans every already-stored
   * message under the old subjects and leaves every running consumer whose
   * filter no longer overlaps created, silent and apparently healthy — the
   * server says nothing on either count. That is a migration, not a boot step,
   * so a boot path that unknowingly drifted has to say so instead of performing
   * it. When this flag IS set, the broker faults its own live subscriptions
   * with {@link StreamRepointedError}; subscriptions held by OTHER processes
   * get no signal, which is why the operator procedure in docs/architecture.md
   * ("Migrating the wire-subject root") restarts the consumers.
   */
  repointSubjects?: boolean
}

/** The two bounds NatsBroker enforces itself. Defaults are the port's
 *  SETUP_TIMEOUT_MS / CLOSE_TIMEOUT_MS; the doubles suite shortens them. */
export interface BrokerTimeouts {
  setupMs: number
  closeMs: number
}

/** Did jsm.streams.info() fail because the stream is absent — as opposed to a
 *  permissions, connectivity or JetStream-not-enabled failure? Only the first
 *  may fall through to streams.add(); treating the others the same way turns an
 *  actionable error into a misleading create attempt. */
function isStreamNotFound(err: unknown): boolean {
  if (err instanceof JetStreamApiError) return err.code === JetStreamApiCodes.StreamNotFound
  // Structural fallback: the library's StreamNotFoundError is not exported from
  // the package root, and doubles/older shapes carry the same fields.
  const e = err as { code?: unknown; status?: unknown; message?: unknown }
  if (e?.code === JetStreamApiCodes.StreamNotFound || e?.code === 404 || e?.code === '404') return true
  return typeof e?.message === 'string' && e.message.toLowerCase().includes('stream not found')
}

/** Is this the server saying the CONSUMER is gone — the JetStream API's
 *  "consumer not found" (10014) on an info request, or the 409 "consumer
 *  deleted" status the library turns into the loop's death? */
function isConsumerGone(err: unknown): boolean {
  if (err instanceof JetStreamApiError && err.code === JetStreamApiCodes.ConsumerNotFound) return true
  const e = err as { code?: unknown; message?: unknown }
  if (e?.code === JetStreamApiCodes.ConsumerNotFound) return true
  if (typeof e?.message !== 'string') return false
  const m = e.message.toLowerCase()
  return m.includes('consumer not found') || m.includes('consumer deleted')
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

const sameFilters = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().every((s, i) => s === [...b].sort()[i])

/** Is this publish failure one a second attempt could survive — a request
 *  timeout, a "no responders" answer (which @nats-io/jetstream reports as
 *  JetStreamNotEnabled, a class the package root does not export), or a 503
 *  from the JetStream API? A closed connection, a permissions violation or a
 *  4xx API error is not: retrying those only delays the same answer. */
function isTransientPublishError(err: unknown): boolean {
  if (err instanceof TimeoutError) return true
  if (err instanceof RequestError) return err.isNoResponders()
  if (err instanceof JetStreamApiError) return err.status === 503
  return (err as { name?: unknown } | undefined)?.name === 'JetStreamNotEnabled'
}

/** What close() and a repoint need from a live subscription. */
interface LiveSubscription {
  readonly pattern: string
  /** Settles with this subscription's outcome; close() waits for it. */
  readonly closed: Promise<void>
  /** An INTENDED stop: end the loop quietly, `closed` resolves. */
  stop(): void
  /** A FAULT: log it, reject `ready`/`closed` with `err`, end the loop. */
  fault(err: Error): void
}

/** What the liveness probe found on the server after missed heartbeats. */
type ProbeVerdict = 'stream-gone' | 'consumer-gone' | 'present' | 'unknown'

export class NatsBroker implements BrokerPort {
  /** Every live subscription, so close() can stop them all BEFORE draining
   *  (otherwise a clean shutdown ends every consumer loop and each one reports
   *  itself as a fault) and a repoint can fault the ones it detaches. */
  private readonly live = new Set<LiveSubscription>()
  /** The bound stream's filter as the server LAST reported it — publish()'s
   *  answer source (see "SERVER TRUTH" in the header). `undefined` = re-read. */
  private cachedSubjects: Promise<readonly string[]> | undefined
  /** The one shutdown in flight; close() hands it back to every caller. A
   *  shutdown that REJECTED is forgotten so a later close() can try again. */
  private closing: Promise<void> | undefined
  private readonly timeouts: BrokerTimeouts

  private constructor(
    private readonly nc: NatsConnection,
    private readonly js: JetStreamClient,
    private readonly jsm: JetStreamManager,
    /** The stream name this broker publishes to / subscribes from. */
    readonly streamName: string,
    timeouts: Partial<BrokerTimeouts> = {},
  ) {
    this.timeouts = { setupMs: timeouts.setupMs ?? SETUP_TIMEOUT_MS, closeMs: timeouts.closeMs ?? CLOSE_TIMEOUT_MS }
  }

  /** Static factory — awaits NATS connection before returning. */
  static async connect(natsUrl: string, streamName = DEFAULT_STREAM): Promise<NatsBroker> {
    const nc = await connect({ servers: natsUrl })
    // nats 2.x: nc.jetstream() / nc.jetstreamManager() (methods on the
    // connection). @nats-io/jetstream: free functions taking the connection.
    const js = jetstream(nc)
    const jsm = await jetstreamManager(nc)
    return new NatsBroker(nc, js, jsm, streamName)
  }

  /**
   * The subject filters the bound stream captures ON THE SERVER, right now.
   * Deliberately not cached and not defaulted from STREAMS (see "SERVER TRUTH"
   * in the header). A missing stream surfaces as the server's own error.
   */
  private async serverSubjects(): Promise<readonly string[]> {
    const info = (await this.jsm.streams.info(this.streamName)) as { config?: { subjects?: string[] } }
    return info.config?.subjects ?? []
  }

  /** The server's LAST answer, read once and kept until invalidated. A failed
   *  read is not kept — the next caller asks again. */
  private cachedServerSubjects(): Promise<readonly string[]> {
    if (!this.cachedSubjects) {
      const read = this.serverSubjects()
      this.cachedSubjects = read
      read.catch(() => {
        if (this.cachedSubjects === read) this.cachedSubjects = undefined
      })
    }
    return this.cachedSubjects
  }

  private refreshServerSubjects(): Promise<readonly string[]> {
    this.invalidateSubjects()
    return this.cachedServerSubjects()
  }

  private invalidateSubjects(): void {
    this.cachedSubjects = undefined
  }

  /** After missed heartbeats: is the stream still there, and is the consumer?
   *  Answers 'unknown' for any failure that is not a not-found — a connection
   *  that is closing, an API timeout — because that is not a verdict about the
   *  server, and the message loop or the connection-closed path will speak. */
  private async probeLiveness(consumer: Consumer): Promise<ProbeVerdict> {
    try {
      await this.jsm.streams.info(this.streamName)
    } catch (err) {
      return isStreamNotFound(err) ? 'stream-gone' : 'unknown'
    }
    try {
      await consumer.info()
    } catch (err) {
      if (isConsumerGone(err)) return 'consumer-gone'
      return isStreamNotFound(err) ? 'stream-gone' : 'unknown'
    }
    return 'present'
  }

  /**
   * Idempotent stream bootstrap. Creates the stream if it does not exist;
   * refreshes its limits if it does.
   *
   * The `subjects` default is READ FROM the STREAMS topology in ./broker.ts (the
   * single source of truth) rather than repeated as a literal, so renaming the
   * subject root there cannot leave this boot path pinned to the old filter —
   * and it is read for the stream THIS broker is bound to, not for NEWSLETTER.
   * Defaulting every stream onto NEWSLETTER's filter (the pre-fix behaviour)
   * created CONTENT/CALENDAR/ORGUNIT streams that captured newsletter subjects
   * and therefore stored none of their own domain's events. A stream name the
   * topology does not know has no derivable default, so it is refused rather
   * than guessed: pass `subjects` explicitly.
   *
   * REFUSES TO REPOINT. If the stream exists and its subject filter differs
   * from `subjects`, this throws and names both filters instead of moving the
   * filter. Moving it orphans every stored message and silences every running
   * consumer, with no word from the server on either — see
   * EnsureStreamOptions.repointSubjects and the migration procedure in
   * docs/architecture.md. Under the opt-in, a repoint of the BOUND stream
   * faults this broker's own live subscriptions (StreamRepointedError).
   *
   * Provisioning a stream this broker is NOT bound to changes nothing about
   * how its own publish()/subscribe() are checked: those ask the server about
   * the bound stream every time, so there is no per-broker slot for another
   * stream's filters to leak into.
   */
  async ensureStream(
    name = this.streamName,
    subjects = defaultSubjectsFor(name),
    opts: EnsureStreamOptions = {},
  ): Promise<void> {
    const streamCfg = {
      name,
      subjects,
      storage: StorageType.File,
      max_age: MAX_AGE_NS,
      max_msgs: MAX_MSGS,
      duplicate_window: DEDUP_WINDOW_NS,
      retention: RetentionPolicy.Limits,
    }

    let existing: { config?: { subjects?: string[] } } | undefined
    try {
      existing = (await this.jsm.streams.info(name)) as { config?: { subjects?: string[] } }
    } catch (err) {
      // ONLY a genuine "stream not found" means "create it". Anything else —
      // permissions, no JetStream on the account, a dead connection — used to
      // be swallowed here and turned into a streams.add() whose own failure
      // reported the wrong cause.
      if (!isStreamNotFound(err)) {
        throw new Error(`[nats-broker] could not read stream ${name}: ${messageOf(err)}`, { cause: err })
      }
      await this.jsm.streams.add(streamCfg)
      if (name === this.streamName) this.invalidateSubjects()
      return
    }

    const current = existing?.config?.subjects ?? []
    const moved = !sameFilters(current, subjects)
    if (moved && !opts.repointSubjects) {
      throw new Error(
        `[nats-broker] refusing to repoint stream ${name}: it currently captures ` +
          `[${current.join(', ')}] but this call would set [${subjects.join(', ')}]. ` +
          'Repointing a live stream orphans every already-stored message and silences every ' +
          'running consumer, and the server reports neither. Pass { repointSubjects: true } only as ' +
          'part of the wire-root migration in docs/architecture.md ' +
          '("Migrating the wire-subject root").',
      )
    }
    // Filter unchanged (or an explicit repoint) — refresh limits.
    await this.jsm.streams.update(name, streamCfg)
    // publish()'s cached filter is about THIS stream; whatever it held, the
    // server was just written to, so the next publish re-reads.
    if (name === this.streamName) this.invalidateSubjects()

    // This process just moved the filter under its own consumers. The server
    // will not tell them; this is the only place that can.
    if (moved && name === this.streamName) {
      for (const sub of [...this.live]) {
        sub.fault(new StreamRepointedError(name, sub.pattern, current, subjects))
      }
    }
  }

  /**
   * Publish an event to the NATS subject via JetStream.
   * Sets Nats-Msg-Id = envelope.eventId for deduplication within the 2-min window.
   *
   * Throws NoStreamError for a subject the bound stream — as the server reports
   * it — does not capture. JetStream's own answer is "no responders", which
   * names neither the subject the caller meant nor the stream this broker is
   * bound to — the two facts needed to fix it.
   *
   * The capture check is answered from the server's last reported filter,
   * read once per broker (see "SERVER TRUTH"). A refusal is never answered
   * from that cache, and one transient publish error is retried once after a
   * re-read. If that re-read finds the stream GONE, the result is NoStreamError
   * with the failed publish as `cause`; if the re-read fails for another
   * reason, the error names both failures and keeps the publish one as `cause`
   * — the raw re-read error alone would say nothing about the publish.
   */
  async publish(subject: string, event: EventEnvelope): Promise<void> {
    let captured = await this.cachedServerSubjects()
    if (!streamCovers(captured, subject)) {
      // The filter may have moved on the server since it was read (an
      // operator's `nats stream edit`): confirm before refusing.
      captured = await this.refreshServerSubjects()
      if (!streamCovers(captured, subject)) {
        throw new NoStreamError(this.streamName, subject, captured)
      }
    }
    const h = headers()
    h.set('Nats-Msg-Id', event.eventId)
    const opts: Partial<JetStreamPublishOptions> = { headers: h }
    const data = JSON.stringify(event)
    try {
      await this.js.publish(subject, data, opts)
    } catch (err) {
      if (!isTransientPublishError(err)) throw err
      // The filter this publish was checked against may be what went stale —
      // a "no responders" answer right after an external repoint is exactly
      // that. Re-read, re-check, try ONCE more: Nats-Msg-Id makes the retry
      // idempotent within the dedup window even if the first attempt landed.
      try {
        captured = await this.refreshServerSubjects()
      } catch (readErr) {
        if (isStreamNotFound(readErr)) throw new NoStreamError(this.streamName, subject, [], { cause: err })
        throw new Error(
          `[nats-broker] publish to "${subject}" on stream ${this.streamName} failed (${messageOf(err)}) ` +
            `and the stream filter could not be re-read afterwards: ${messageOf(readErr)}`,
          { cause: err },
        )
      }
      if (!streamCovers(captured, subject)) {
        throw new NoStreamError(this.streamName, subject, captured, { cause: err })
      }
      await this.js.publish(subject, data, opts)
    }
  }

  /**
   * Subscribe to a NATS subject pattern via an ephemeral ordered consumer.
   * Supports NATS '*' (one token) and '>' (one-or-more, final token) wildcards —
   * exactly the same grammar as @gremion/ports subjectMatches (D-P1-7).
   *
   * Ordered consumers auto-recreate on gaps — no manual ack needed.
   *
   * Returns synchronously (BrokerPort). The server round trips — the cover
   * check and the consumer creation, each bounded by SETUP_TIMEOUT_MS — settle
   * `ready`: resolved once the consumer is live, rejected (StreamCoverError,
   * SetupTimeoutError, or the server's own error) when it never will be.
   * `closed` rejects with the same error in that case, so a caller that only
   * ever awaits `closed` still hears about it.
   */
  subscribe(
    subjectPattern: string,
    handler: (event: EventEnvelope, subject: string) => Promise<void>,
  ): BrokerSubscription {
    let active = true
    let messages: ConsumerMessages | undefined

    let markReady!: () => void
    let failReady!: (err: unknown) => void
    const ready = new Promise<void>((resolve, reject) => {
      markReady = resolve
      failReady = reject
    })
    // Settles when this subscription stops delivering: resolved for an intended
    // stop (unsubscribe / close), rejected for every other reason.
    let settle!: () => void
    let fail!: (err: unknown) => void
    const closed = new Promise<void>((resolve, reject) => {
      settle = resolve
      fail = reject
    })
    // A caller may legitimately ignore either promise. Keep inert handlers
    // attached so a rejection never surfaces as an unhandled rejection (which
    // in Node terminates the process) — the caller's own handlers still fire.
    ready.catch(() => {})
    closed.catch(() => {})

    const report = (err: unknown) => {
      console.error(
        '[nats-broker] subscription to %s on stream %s stopped and is receiving nothing: %s',
        subjectPattern,
        this.streamName,
        messageOf(err),
        err,
      )
    }
    const reportCloseFailure = (err: unknown) => {
      // This close() is what makes an intended stop settle `closed` and what
      // close() waits on; a rejection here is a hang in the making, and round
      // 4's bare `.catch(() => {})` guaranteed zero diagnostics for it.
      console.error(
        '[nats-broker] could not end the consumer iterator for %s on stream %s: %s',
        subjectPattern,
        this.streamName,
        messageOf(err),
        err,
      )
    }
    // End the consumer iterator: the parked `for await` below returns, the
    // ephemeral consumer is released. Flipping `active` alone is not enough —
    // an idle loop never re-reads it (round 2 left `closed` pending forever).
    const endIterator = () => {
      messages?.close().catch(reportCloseFailure)
    }

    let faulted = false
    const entry: LiveSubscription = {
      pattern: subjectPattern,
      closed,
      stop: () => {
        if (!active) return
        active = false
        this.live.delete(entry)
        // `ready` is NOT resolved here. An intended stop before readiness is
        // not a failure, but it is not a verdict either: `ready` settles with
        // the setup's own outcome below — resolved when the in-flight setup
        // ends quietly, rejected when the cover check says this subscription
        // could never have delivered. Round 3 resolved it here and erased that.
        endIterator()
      },
      fault: (err) => {
        if (!active) return
        active = false
        faulted = true
        this.live.delete(entry)
        report(err)
        failReady(err)
        fail(err)
        endIterator()
      },
    }
    this.live.add(entry)

    // One setup round trip, bounded. The underlying request cannot be
    // cancelled; past the bound it is abandoned and `onLate` gets whatever it
    // eventually produced (a consume() that answered late must be closed, or
    // it pulls into the void).
    const bounded = <T>(p: Promise<T>, step: string, onLate?: (value: T) => void): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        let late = false
        const timer = setTimeout(() => {
          late = true
          reject(new SetupTimeoutError(this.streamName, subjectPattern, step, this.timeouts.setupMs))
        }, this.timeouts.setupMs)
        timer.unref?.()
        p.then(
          (value) => {
            clearTimeout(timer)
            if (late) onLate?.(value)
            else resolve(value)
          },
          (err: unknown) => {
            clearTimeout(timer)
            if (!late) reject(err)
          },
        )
      })

    // "Consumer gone" is what the server says for a deleted STREAM too: the 409
    // it answers a pending pull with reads "consumer deleted" either way. Ask
    // once which it was, so the operator gets the remedy that fits (recreate
    // the stream, or resubscribe). A probe that cannot tell keeps the server's
    // wording.
    const consumerOrStreamGone = async (detail: string, cause?: unknown): Promise<Error> => {
      const options = cause === undefined ? undefined : { cause }
      try {
        await this.jsm.streams.info(this.streamName)
      } catch (err) {
        if (isStreamNotFound(err)) return new StreamGoneError(this.streamName, subjectPattern, options)
      }
      return new ConsumerGoneError(this.streamName, subjectPattern, detail, options)
    }

    // The library's iterator ended WITH an error: name it for what the server
    // said, so whichever path noticed first — the loop's death or the status()
    // watcher below — the caller sees the same class.
    const loopDeath = async (err: unknown): Promise<Error> => {
      if (isStreamNotFound(err)) return new StreamGoneError(this.streamName, subjectPattern, { cause: err })
      if (isConsumerGone(err)) return consumerOrStreamGone(messageOf(err), err)
      return new Error(
        `consumer loop for "${subjectPattern}" on stream ${this.streamName} died while the subscription was still active: ` +
          messageOf(err),
        { cause: err },
      )
    }

    // The liveness watch (see LIVENESS in the header). Ends when the library
    // stops the consumer — close() stops every status() listener.
    const watchLiveness = (source: ConsumerMessages, consumer: Consumer) => {
      let stalls = 0
      ;(async () => {
        for await (const n of source.status()) {
          if (!active) return
          switch (n.type) {
            case 'stream_not_found':
              entry.fault(new StreamGoneError(this.streamName, subjectPattern))
              return
            case 'consumer_deleted': {
              const gone = await consumerOrStreamGone(`${n.code} ${n.description}`)
              if (active) entry.fault(gone)
              return
            }
            case 'consumer_not_found': {
              const gone = await consumerOrStreamGone(`consumer ${n.name} not found`)
              if (active) entry.fault(gone)
              return
            }
            case 'heartbeats_missed': {
              const verdict = await this.probeLiveness(consumer)
              if (!active) return
              if (verdict === 'stream-gone') {
                entry.fault(new StreamGoneError(this.streamName, subjectPattern))
                return
              }
              if (verdict === 'consumer-gone') {
                entry.fault(new ConsumerGoneError(this.streamName, subjectPattern, 'the probe after missed heartbeats found no consumer'))
                return
              }
              if (verdict === 'present' && ++stalls >= STALL_PROBE_LIMIT) {
                entry.fault(new ConsumerStalledError(this.streamName, subjectPattern, stalls))
                return
              }
              break
            }
            case 'heartbeat':
              stalls = 0
              break
            default:
              break
          }
        }
      })().catch((err: unknown) => {
        // The status iterator itself failed — not a verdict about the server.
        // Say so; the message loop is still the one that speaks for delivery.
        if (active) {
          console.warn('[nats-broker] liveness watch for %s on stream %s ended: %s', subjectPattern, this.streamName, messageOf(err))
        }
      })
    }

    // The consumer loop runs detached; its outcome is reported through
    // `ready`/`closed` and the error log, never swallowed.
    ;(async () => {
      // ── Stream-cover check against the SERVER, BEFORE any consumer exists ──
      // JetStream will create a consumer whose filter the stream does not
      // capture and then deliver nothing to it, forever, with no error on
      // either side. Nothing downstream can detect that; only this call site
      // can, and only by asking the server what the stream actually holds.
      const captured = await bounded(this.serverSubjects(), 'the stream-cover check (streams.info)')
      // The verdict comes BEFORE the liveness check: an unsubscribe() or
      // close() that arrived while the request was in flight does not make an
      // uncoverable pattern coverable, so the refusal is reported even then.
      if (!streamCovers(captured, subjectPattern)) {
        throw new StreamCoverError(this.streamName, subjectPattern, captured)
      }
      if (!active) return

      // Ordered consumer (no name/durable) with filter subject.
      // NOTE: `filter_subjects` (snake_case) — renamed from nats 2.x's
      // camelCase `filterSubjects`; see the migration-mapping comment at the
      // top of this file.
      const consumer = await bounded(
        this.js.consumers.get(this.streamName, { filter_subjects: subjectPattern }),
        'consumer creation (consumers.get)',
      )
      if (!active) return
      // abort_on_missing_resource: the server's one volunteered signal (a 409
      // to a pending pull) ends the iterator WITH the error instead of the
      // library's silent recreate-forever. expires/idle_heartbeat size the
      // pull so a stream deleted BETWEEN pulls is noticed through missed
      // heartbeats inside LIVENESS_FAULT_BOUND_MS — see LIVENESS in the header.
      messages = await bounded(
        consumer.consume({
          abort_on_missing_resource: true,
          expires: CONSUME_EXPIRES_MS,
          idle_heartbeat: CONSUME_IDLE_HEARTBEAT_MS,
        }),
        'starting the pull (consume)',
        (late) => {
          late.close().catch(reportCloseFailure)
        },
      )
      if (!active) {
        endIterator()
        return
      }
      watchLiveness(messages, consumer)
      markReady()

      try {
        for await (const msg of messages) {
          if (!active) break
          try {
            const payload = JSON.parse(new TextDecoder().decode(msg.data)) as EventEnvelope
            await handler(payload, msg.subject)
            // Ordered consumers don't require ack, but it's safe to call ack() anyway.
            msg.ack()
          } catch (err) {
            // These are ORDERED consumers (see header): they auto-recreate on
            // gaps and do NOT redeliver on a missing ack. So NOT acking here does
            // not replay the message — a swallowed handler/parse error means the
            // event is dropped for good. Logging is the only mitigation, so
            // surface it. Do NOT rethrow: that would break the `for await` loop
            // and kill the consumer for every subsequent event.
            console.error('[nats-broker] handler error on subject %s', msg.subject, err)
          }
        }
      } catch (err) {
        // The iterator DIED: the library ended it with an error — the stream
        // or the consumer was deleted (abort_on_missing_resource above), or a
        // status the consumer could not recover from. After stop()/fault()
        // that is teardown noise; on a live subscription it is the fault, and
        // it is named here because the library's message names neither the
        // pattern nor the stream.
        if (!active) return
        throw await loopDeath(err)
      }
      // The message iterator ENDED. If nobody asked for that, this subscription
      // is dead: the connection closed (the library ends the iterator on
      // connection close, without an error). Pre-fix the IIFE simply resolved
      // here, the subscription object stayed "live", and the caller had no way
      // to learn its events had stopped — the same silent no-delivery as a
      // failed setup, one line later.
      if (active) {
        throw new Error(
          `consumer loop for "${subjectPattern}" on stream ${this.streamName} ended while the subscription was still active`,
        )
      }
    })().then(
      () => {
        // Loop ended after stop() — the intended stop. An intended stop before
        // readiness settles `ready` here, resolved: it must neither hang nor
        // reject. (After fault() both promises are already rejected and these
        // are no-ops.)
        markReady()
        settle()
      },
      (err) => {
        // After stop() the in-flight setup call may reject as teardown noise
        // (the drain cut it, or the setup bound did); after fault() the error
        // has already been reported. Neither is a NEW fault — EXCEPT a cover
        // verdict after a stop(), which is about the server and stands
        // whatever this subscription did since.
        if (!active && (faulted || !(err instanceof StreamCoverError))) {
          markReady()
          settle()
          return
        }
        active = false
        this.live.delete(entry)
        report(err)
        failReady(err)
        fail(err)
      },
    )

    return { ready, closed, unsubscribe: entry.stop }
  }

  /**
   * Drain and close the underlying NATS connection.
   *
   * Stops every live subscription FIRST and waits for each one's outcome, for
   * at most CLOSE_TIMEOUT_MS: draining ends each consumer loop, and without
   * the stop a clean shutdown would report every one of them as a dead
   * subscription. Every `closed` that can settle does so before the connection
   * goes — resolved for a live one, rejected with StreamCoverError for one
   * whose cover check was still in flight. One that cannot (a setup round trip
   * the server never answers, a handler that never returns) is named in a
   * warning and the drain proceeds without it — the drain is what must happen.
   *
   * Idempotent and shared: concurrent and repeated calls get the ONE in-flight
   * shutdown; a call after the connection already went away is a quiet no-op,
   * and a drain that fails because the connection closed underneath it is
   * tolerated with a debug line. Any other drain failure is rethrown AND the
   * attempt is forgotten, so a later close() drains again instead of replaying
   * the stale rejection. Round 3's suite hid the ClosedConnectionError behind
   * a `.catch(() => {})` in teardown; round 4 memoised the rejection forever.
   */
  close(): Promise<void> {
    if (!this.closing) {
      const attempt: Promise<void> = this.shutdown().catch((err: unknown) => {
        if (this.closing === attempt) this.closing = undefined
        throw err
      })
      this.closing = attempt
    }
    return this.closing
  }

  private async shutdown(): Promise<void> {
    const pending = new Set<LiveSubscription>(this.live)
    // Each `closed` already carries an inert catch, so a rejection here is not
    // an unhandled rejection; allSettled keeps the drain unconditional.
    const outcomes = [...pending].map((sub) => sub.closed.then(() => pending.delete(sub), () => pending.delete(sub)))
    for (const sub of [...this.live]) sub.stop()
    let timer: ReturnType<typeof setTimeout> | undefined
    const gaveUp = await Promise.race([
      Promise.allSettled(outcomes).then(() => false),
      new Promise<true>((resolve) => {
        timer = setTimeout(() => resolve(true), this.timeouts.closeMs)
      }),
    ])
    if (timer) clearTimeout(timer)
    if (gaveUp) {
      console.warn(
        '[nats-broker] close() on stream %s: %d subscription(s) did not settle within %d ms, draining anyway: %s',
        this.streamName,
        pending.size,
        this.timeouts.closeMs,
        [...pending].map((s) => s.pattern).join(', '),
      )
    }
    if (this.nc.isClosed()) return
    try {
      await this.nc.drain()
    } catch (err) {
      // The connection went away between the check and the drain, or the
      // drain itself found it closed: nothing left to drain, not a failure.
      if (this.nc.isClosed() || err instanceof ClosedConnectionError) {
        console.debug('[nats-broker] close() on stream %s: drain on an already-closed connection (%s)', this.streamName, messageOf(err))
        return
      }
      throw err
    }
  }
}

/** The subject filters a stream name defaults to, from the STREAMS topology.
 *  A name the topology does not know has no derivable default — refuse rather
 *  than fall back to some other domain's filter. */
function defaultSubjectsFor(name: string): string[] {
  const descriptor = streamDescriptorFor(name)
  if (!descriptor) {
    throw new Error(
      `[nats-broker] no default subjects for stream "${name}": it is not in the STREAMS topology ` +
        '(@gremion/ports/broker). Pass the subject filters explicitly, or add the stream to STREAMS.',
    )
  }
  return [...descriptor.subjects]
}
