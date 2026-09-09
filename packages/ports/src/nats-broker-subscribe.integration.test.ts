// packages/ports/src/nats-broker-subscribe.integration.test.ts
//
// NatsBroker's FAILURE paths — the ones that used to end in silence.
//
// The original file (integration defect D7, run finding 15) covered exactly one
// of them: subscribe() started its consumer loop in a detached async IIFE and
// ended it with a bare `.catch(() => {})`, which swallowed genuine setup
// failures on a still-live subscription. The T01 reviews found the same class
// of silence in several more places, and they are all specified here:
//
//   1. subscribe() to a subject the bound stream DOES NOT COVER — as the SERVER
//      reports it, not as the STREAMS topology or the last ensureStream() call
//      believed it. The server is perfectly happy to create that consumer; it
//      then delivers nothing, forever. Round 2 checked the client's belief and
//      let a drifted server through. Now `jsm.streams.info()` is asked first,
//      and a refused subscription rejects `ready` and `closed` with
//      StreamCoverError before any consumer exists.
//   2. The consumer loop ENDING while the subscription is still active (the
//      stream was deleted, the consumer was removed, the connection went away).
//      That logs at error level and REJECTS `closed`. A clean close() and an
//      unsubscribe() must stay quiet — and unsubscribe() must actually END the
//      loop, not flip a flag the parked `for await` never re-reads.
//   3. ensureStream() REPOINTING a live stream's subject filter by accident.
//      Refused by default, naming both filters. Under the documented opt-in it
//      repoints AND faults this broker's live subscriptions with
//      StreamRepointedError — the server produces no signal of its own.
//   4. ensureStream() swallowing EVERY streams.info() error as "does not
//      exist". Only a genuine stream-not-found falls through to add().
//   5. publish() to a subject the bound stream does not capture: NoStreamError
//      naming WHICH subject and WHICH stream.
//   6. ensureStream() for a stream this broker is NOT bound to must not change
//      what its own checks are measured against (round 2 kept the call's
//      subjects in an instance-wide slot and poisoned both checks).
//   7. A StreamCoverError verdict takes PRECEDENCE over an unsubscribe() or
//      close() issued while the cover check was in flight (round 3 erased it).
//   8. The consumer is asked to ABORT when its stream or consumer disappears,
//      instead of the library's silent recreate-forever; the loop's death is
//      reported naming the pattern and the stream.
//   9. close() is idempotent and quiet — no second drain, no throw after the
//      connection already went away.
//  10. publish() answers its capture check from a SERVER-derived cache: one
//      streams.info() per broker until invalidated (ensureStream() on the bound
//      stream, a refusal, a transient publish error), never from STREAMS; a
//      refusal is never answered from the cache; one transient error is retried
//      once after a refresh.
//
// No server needed: every one of these is in NatsBroker's own error handling,
// so the spec drives the class with JetStream doubles; the same paths are
// proved against nats:2.12 in nats-broker.integration.test.ts. The
// `.integration.test.ts` suffix is NOT about needing a server here — it is this
// repo's existing marker for "must not load under gremion-ui's jsdom monolith
// run" (vite.config.ts excludes the glob; see the header of
// nats-topology.test.ts). Any spec importing ./nats-broker.js needs it, because
// that module pulls the NATS transport. `pnpm --filter @gremion/ports test`
// collects and RUNS this file — it has no NATS_TEST_URL gate.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { TimeoutError } from '@nats-io/nats-core'
import {
  NatsBroker,
  StreamCoverError,
  NoStreamError,
  StreamRepointedError,
  StreamGoneError,
  ConsumerGoneError,
  ConsumerStalledError,
  SetupTimeoutError,
  CONSUME_EXPIRES_MS,
  CONSUME_IDLE_HEARTBEAT_MS,
  STALL_PROBE_LIMIT,
  LIVENESS_FAULT_BOUND_MS,
} from './nats-broker.js'
import { STREAMS, makeEnvelope } from './broker.js'
import * as port from './broker.js'

/** The rejection a real server sends when the consumer cannot be set up. */
const SETUP_ERROR = new Error('nats: consumer setup rejected by the server')

/** A JetStream client double whose consumer setup always rejects. */
function failingJetStream() {
  return {
    consumers: {
      get: async () => {
        throw SETUP_ERROR
      },
    },
  }
}

/** An async queue standing in for the library's status() notifications: the
 *  test pushes what the server (via the library) would have said. */
function notificationQueue() {
  const buffered: unknown[] = []
  let wake: (() => void) | undefined
  let ended = false
  return {
    push(n: unknown) {
      buffered.push(n)
      wake?.()
    },
    end() {
      ended = true
      wake?.()
    },
    async *iterable() {
      while (true) {
        if (buffered.length > 0) {
          yield buffered.shift()
          continue
        }
        if (ended) return
        await new Promise<void>((r) => {
          wake = r
        })
        wake = undefined
      }
    },
  }
}

/** A message source with the halves NatsBroker uses: the async iterator,
 *  `close()`, which ENDS the iteration the way the real ConsumerMessages does,
 *  and `status()`, the liveness notifications. Yields `items` in order, then
 *  parks until closed. `closeRejectsWith` makes close() reject AFTER releasing
 *  the loop, the shape of a library close that fails late. */
function messageSource<T>(items: T[] = [], closeRejectsWith?: Error) {
  let release!: () => void
  const closed = new Promise<void>((r) => {
    release = r
  })
  let closeCalls = 0
  const notifications = notificationQueue()
  const source = {
    async *[Symbol.asyncIterator]() {
      for (const item of items) yield item
      await closed
    },
    close: async () => {
      closeCalls++
      release()
      notifications.end()
      if (closeRejectsWith) throw closeRejectsWith
    },
    status: () => notifications.iterable(),
    /** Test hook: a ConsumerNotification the library would have emitted. */
    notify: (n: Record<string, unknown>) => notifications.push(n),
    get closeCalls() {
      return closeCalls
    },
  }
  return source
}

/** A source whose iteration ENDS at once (the library ended it without an
 *  error — the connection closed under it). */
function endingSource() {
  return {
    async *[Symbol.asyncIterator]() {},
    close: async () => {},
    status: () => notificationQueue().iterable(),
  }
}

/** A stream-info double: what the SERVER says the bound stream captures. */
function jsmReporting(subjects: readonly string[]) {
  return {
    streams: {
      info: async () => ({ config: { subjects: [...subjects] } }),
    },
  }
}

/** NatsBroker's constructor is private to force the connect() factory. TypeScript
 *  privacy is compile-time only, so Reflect.construct builds one with doubles and
 *  without a live server. The server-side filter defaults to the NEWSLETTER one. */
function brokerWith(
  js: unknown,
  streamName = 'TEST_STREAM',
  nc: unknown = { drain: async () => {}, isClosed: () => false },
  jsm: unknown = jsmReporting(STREAMS.NEWSLETTER.subjects),
  timeouts?: { setupMs?: number; closeMs?: number },
): NatsBroker {
  return Reflect.construct(NatsBroker, [nc, js, jsm, streamName, timeouts]) as NatsBroker
}

/** A JetStream double whose consumer delivers from `source`; `info` is what
 *  the liveness probe's consumer.info() answers. */
function jetStreamDelivering(source: AsyncIterable<unknown>, info: () => Promise<unknown> = async () => ({})) {
  let consumersRequested = 0
  return {
    consumers: {
      get: async () => {
        consumersRequested++
        return { consume: async () => source, info }
      },
    },
    get consumersRequested() {
      return consumersRequested
    },
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('NatsBroker.subscribe() consumer-setup failures', () => {
  it('surfaces a setup failure on a subscription that is still active', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const broker = brokerWith(failingJetStream())

    const sub = broker.subscribe('gremion.*.newsletter.>', async () => {})

    await expect(sub.ready, 'a subscription whose consumer could not be set up reported itself ready').rejects.toBe(
      SETUP_ERROR,
    )
    await expect(sub.closed).rejects.toBe(SETUP_ERROR)
    expect(
      errors,
      'subscribe() swallowed a consumer-setup failure on a LIVE subscription: ' +
        'the subscriber now receives nothing and nothing says so',
    ).toHaveBeenCalled()
    // The message must name the subject that is dead, or an operator cannot act.
    const reported = errors.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(reported).toContain('gremion.*.newsletter.>')

    sub.unsubscribe()
  })

  it('stays quiet when the failure follows unsubscribe (the case the catch is for)', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const broker = brokerWith(failingJetStream())

    const sub = broker.subscribe('gremion.*.newsletter.>', async () => {})
    // Tear down before the detached loop gets its turn: the rejection that
    // follows is expected teardown noise, not a fault worth reporting.
    sub.unsubscribe()

    await expect(sub.closed, 'a torn-down subscription closes cleanly').resolves.toBeUndefined()
    await expect(sub.ready, 'an intended stop before readiness must not leave `ready` hanging or rejecting').resolves.toBeUndefined()
    expect(errors, 'a post-unsubscribe rejection must not be reported as a fault').not.toHaveBeenCalled()
  })
})

// ── 1. The stream-cover check, against what the SERVER reports ─────────────
describe('NatsBroker.subscribe() stream-cover check', () => {
  it('rejects ready and closed with StreamCoverError BEFORE creating a consumer when the server filter cannot cover the pattern', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const js = jetStreamDelivering(messageSource())
    // Bound to NEWSLETTER; the server reports the NEWSLETTER filter.
    const broker = brokerWith(js, STREAMS.NEWSLETTER.name)

    const sub = broker.subscribe('gremion.*.content.>', async () => {})

    await expect(
      sub.ready,
      'subscribe() to an uncovered subject reported ready — a subscription that can only ever deliver nothing',
    ).rejects.toBeInstanceOf(StreamCoverError)
    // The error must name the pattern, the stream and its actual filter, or the
    // operator cannot tell WHICH stream is wrong.
    await expect(sub.ready).rejects.toThrow(/gremion\.\*\.content\.>/)
    await expect(sub.ready).rejects.toThrow(/NEWSLETTER[\s\S]*gremion\.\*\.newsletter\.>/)
    await expect(sub.closed).rejects.toBeInstanceOf(StreamCoverError)
    expect(js.consumersRequested, 'a consumer was created for an uncoverable filter').toBe(0)
    expect(errors).toHaveBeenCalled()
  })

  it('goes live for a pattern the server filter covers', async () => {
    const source = messageSource()
    const js = jetStreamDelivering(source)
    const broker = brokerWith(js, STREAMS.NEWSLETTER.name)

    const sub = broker.subscribe('gremion.*.newsletter.>', async () => {})
    await expect(sub.ready).resolves.toBeUndefined()
    expect(js.consumersRequested).toBe(1)
    sub.unsubscribe()
    await expect(sub.closed).resolves.toBeUndefined()
  })

  it('trusts the SERVER over the STREAMS topology: a drifted live filter refuses the subject the topology says is covered', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const js = jetStreamDelivering(messageSource())
    // The code's belief (STREAMS.NEWSLETTER) says `gremion.*.newsletter.>`; the
    // server still holds the pre-rename filter. This is the migration case.
    const broker = brokerWith(js, STREAMS.NEWSLETTER.name, undefined, jsmReporting(['legacy.*.newsletter.>']))

    const sub = broker.subscribe('gremion.*.newsletter.>', async () => {})

    await expect(
      sub.ready,
      'subscribe() went live on a filter the SERVER does not hold — the topology was believed over the server',
    ).rejects.toBeInstanceOf(StreamCoverError)
    await expect(sub.ready).rejects.toThrow(/legacy\.\*\.newsletter\.>/)
    expect(js.consumersRequested).toBe(0)
  })

  it('has no "unknown cover" escape: a stream absent from STREAMS is checked against the server like any other', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const js = jetStreamDelivering(messageSource())
    const broker = brokerWith(js, 'AD_HOC_STREAM', undefined, jsmReporting(['probe.f.>']))

    const refused = broker.subscribe('totally.other.>', async () => {})
    await expect(refused.ready, 'an ad-hoc stream skipped the cover check').rejects.toBeInstanceOf(StreamCoverError)
    expect(js.consumersRequested).toBe(0)

    const accepted = broker.subscribe('probe.f.x', async () => {})
    await expect(accepted.ready).resolves.toBeUndefined()
    accepted.unsubscribe()
  })
})

// ── 2. Termination ───────────────────────────────────────────────────────────
describe('NatsBroker.subscribe() termination', () => {
  it('logs and rejects `closed` when the loop ends while the subscription is still active', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    // A message source that ends immediately: the stream/consumer went away.
    const broker = brokerWith(jetStreamDelivering(endingSource()))

    const sub = broker.subscribe('gremion.*.newsletter.>', async () => {})

    await expect(
      sub.closed,
      'the consumer loop ended while the subscription was still active and `closed` did not reject',
    ).rejects.toThrow(/gremion\.\*\.newsletter\.>/)

    expect(errors, 'a dead consumer loop must be reported at error level').toHaveBeenCalled()
    const reported = errors.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(reported).toContain('gremion.*.newsletter.>')
    expect(reported).toContain('TEST_STREAM')
  })

  it('unsubscribe() ENDS the consumer iterator and resolves `closed` on an idle subscription', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const source = messageSource()
    const broker = brokerWith(jetStreamDelivering(source))

    const sub = broker.subscribe('gremion.*.newsletter.>', async () => {})
    await sub.ready

    sub.unsubscribe()
    await expect(
      Promise.race([
        sub.closed,
        new Promise((_, reject) => setTimeout(() => reject(new Error('closed did not settle within 1 s of unsubscribe()')), 1000)),
      ]),
    ).resolves.toBeUndefined()
    expect(source.closeCalls, 'unsubscribe() left the consumer iterator running (leaked consumer)').toBe(1)
    expect(errors).not.toHaveBeenCalled()
  })

  it('a clean close() ends the loop with NO error log and resolves `closed`', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})

    // The loop parks until the connection drains — exactly what close() does.
    const source = messageSource()
    const nc = {
      drain: async () => {
        await source.close()
      },
      isClosed: () => false,
    }
    const broker = brokerWith(jetStreamDelivering(source), 'TEST_STREAM', nc)

    const sub = broker.subscribe('gremion.*.newsletter.>', async () => {})
    await sub.ready
    await broker.close()

    await expect(sub.closed, 'a clean close() must resolve `closed`').resolves.toBeUndefined()
    expect(errors, 'close() reported its own shutdown as a fault').not.toHaveBeenCalled()
  })
})

// ── 3./4./6. ensureStream ────────────────────────────────────────────────────

/** The error a real server produces for an absent stream: JetStreamApiError with
 *  err_code 10059 and description "stream not found". Reproduced structurally so
 *  the double does not depend on the library's non-exported error class. */
function streamNotFound(): Error {
  return Object.assign(new Error('stream not found'), { code: 10059, status: 404 })
}

function jsmDouble(opts: {
  info?: (name: string) => Promise<unknown>
}): {
  jsm: { streams: Record<string, unknown> }
  added: Array<{ name: string; subjects: string[] }>
  updated: Array<{ name: string; subjects: string[] }>
} {
  const added: Array<{ name: string; subjects: string[] }> = []
  const updated: Array<{ name: string; subjects: string[] }> = []
  const jsm = {
    streams: {
      info: opts.info ?? (async () => { throw streamNotFound() }),
      add: async (cfg: { name: string; subjects: string[] }) => {
        added.push({ name: cfg.name, subjects: cfg.subjects })
      },
      update: async (name: string, cfg: { subjects: string[] }) => {
        updated.push({ name, subjects: cfg.subjects })
      },
    },
  }
  return { jsm, added, updated }
}

function brokerWithJsm(jsm: unknown, streamName: string, js: unknown = { consumers: {}, publish: async () => {} }): NatsBroker {
  return Reflect.construct(NatsBroker, [{ drain: async () => {}, isClosed: () => false }, js, jsm, streamName]) as NatsBroker
}

describe('NatsBroker.ensureStream()', () => {
  it('derives its default subjects from the BOUND stream, not from NEWSLETTER', async () => {
    const { jsm, added } = jsmDouble({})
    const broker = brokerWithJsm(jsm, STREAMS.CONTENT.name)

    await broker.ensureStream()

    expect(added).toHaveLength(1)
    expect(
      added[0]!.subjects,
      'ensureStream() created the CONTENT stream with the NEWSLETTER subject filter — ' +
        'every content event would land nowhere',
    ).toEqual([...STREAMS.CONTENT.subjects])
    expect(added[0]!.name).toBe(STREAMS.CONTENT.name)
  })

  it('refuses to repoint a drifted subject filter by default, naming BOTH filters', async () => {
    const current = ['gremion.*.newsletter.>']
    const { jsm, updated } = jsmDouble({
      info: async () => ({ config: { name: 'NEWSLETTER', subjects: current } }),
    })
    const broker = brokerWithJsm(jsm, STREAMS.NEWSLETTER.name)

    const attempt = broker.ensureStream(STREAMS.NEWSLETTER.name, ['legacy.*.newsletter.>'])

    await expect(attempt).rejects.toThrow(/gremion\.\*\.newsletter\.>/)
    await expect(attempt).rejects.toThrow(/legacy\.\*\.newsletter\.>/)
    expect(updated, 'the live stream was repointed without an explicit opt-in').toHaveLength(0)
  })

  it('repoints only under the documented opt-in', async () => {
    const { jsm, updated } = jsmDouble({
      info: async () => ({ config: { name: 'NEWSLETTER', subjects: ['gremion.*.newsletter.>'] } }),
    })
    const broker = brokerWithJsm(jsm, STREAMS.NEWSLETTER.name)

    await broker.ensureStream(STREAMS.NEWSLETTER.name, ['legacy.*.newsletter.>'], {
      repointSubjects: true,
    })

    expect(updated).toEqual([{ name: 'NEWSLETTER', subjects: ['legacy.*.newsletter.>'] }])
  })

  it('an opt-in repoint faults this broker live subscriptions with StreamRepointedError and an error log', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { jsm } = jsmDouble({
      info: async () => ({ config: { name: 'NEWSLETTER', subjects: ['gremion.*.newsletter.>'] } }),
    })
    const source = messageSource()
    const broker = brokerWithJsm(jsm, STREAMS.NEWSLETTER.name, jetStreamDelivering(source))
    const sub = broker.subscribe('gremion.*.newsletter.>', async () => {})
    await sub.ready

    await broker.ensureStream(STREAMS.NEWSLETTER.name, ['legacy.*.newsletter.>'], { repointSubjects: true })

    await expect(
      sub.closed,
      'the filter moved out from under a live subscription and `closed` did not reject',
    ).rejects.toBeInstanceOf(StreamRepointedError)
    await expect(sub.closed).rejects.toThrow(/legacy\.\*\.newsletter\.>/)
    expect(source.closeCalls, 'a repointed-away consumer iterator was left running').toBe(1)
    expect(errors).toHaveBeenCalled()
    const reported = errors.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(reported).toContain('gremion.*.newsletter.>')
    expect(reported).toContain('NEWSLETTER')
  })

  it('still refreshes limits when the subject filter has NOT drifted', async () => {
    const { jsm, updated } = jsmDouble({
      info: async () => ({ config: { name: 'NEWSLETTER', subjects: ['gremion.*.newsletter.>'] } }),
    })
    const broker = brokerWithJsm(jsm, STREAMS.NEWSLETTER.name)

    await broker.ensureStream()

    expect(updated).toHaveLength(1)
    expect(updated[0]!.subjects).toEqual([...STREAMS.NEWSLETTER.subjects])
  })

  it('rethrows a non-not-found info() error with its cause, instead of creating a stream', async () => {
    const denied = new Error('nats: permissions violation for JS.API.STREAM.INFO.NEWSLETTER')
    const { jsm, added } = jsmDouble({ info: async () => { throw denied } })
    const broker = brokerWithJsm(jsm, STREAMS.NEWSLETTER.name)

    await expect(broker.ensureStream()).rejects.toMatchObject({ cause: denied })
    expect(added, 'a permissions failure was mistaken for "stream does not exist"').toHaveLength(0)
  })

  it('refuses a stream name it has no subjects for rather than guessing', async () => {
    const { jsm } = jsmDouble({})
    const broker = brokerWithJsm(jsm, 'UNKNOWN_STREAM')
    await expect(broker.ensureStream()).rejects.toThrow(/UNKNOWN_STREAM/)
  })

  it('provisioning ANOTHER stream leaves the bound stream checks measured against the bound stream', async () => {
    // The server: NEWSLETTER holds its own filter, CONTENT does not exist yet.
    const { jsm } = jsmDouble({
      info: async (name: string) => {
        if (name === STREAMS.NEWSLETTER.name) return { config: { subjects: [...STREAMS.NEWSLETTER.subjects] } }
        throw streamNotFound()
      },
    })
    const published: string[] = []
    const js = { consumers: {}, publish: async (subject: string) => { published.push(subject) } }
    const broker = brokerWithJsm(jsm, STREAMS.NEWSLETTER.name, js)
    const envelope = makeEnvelope({ eventType: 'send.succeeded', tenantId: 't1', correlationId: null, payload: {} })

    await broker.ensureStream(STREAMS.CONTENT.name, STREAMS.CONTENT.subjects)

    // Its own subject is NOT refused with CONTENT's filters...
    await broker.publish('gremion.t1.newsletter.send.succeeded', envelope)
    expect(published).toEqual(['gremion.t1.newsletter.send.succeeded'])
    // ...and CONTENT's subject is NOT accepted onto NEWSLETTER.
    await expect(broker.publish('gremion.t1.content.publish.succeeded', envelope)).rejects.toBeInstanceOf(NoStreamError)
    expect(published).toHaveLength(1)
  })
})

// ── 5. publish() to an uncaptured subject ────────────────────────────────────
describe('NatsBroker.publish() stream-capture check', () => {
  function publishingBroker(streamName: string) {
    const published: string[] = []
    const js = { publish: async (subject: string) => { published.push(subject); return {} }, consumers: {} }
    const broker = brokerWithJsm(jsmReporting(STREAMS.NEWSLETTER.subjects), streamName, js)
    return { broker, published }
  }

  const envelope = makeEnvelope({
    eventType: 'publish.succeeded',
    tenantId: 't1',
    correlationId: null,
    payload: {},
  })

  it('throws NoStreamError naming the subject AND the stream when the server filter does not capture it', async () => {
    const { broker, published } = publishingBroker(STREAMS.NEWSLETTER.name)
    const subject = 'gremion.t1.content.publish.succeeded'

    await expect(broker.publish(subject, envelope)).rejects.toBeInstanceOf(NoStreamError)
    await expect(broker.publish(subject, envelope)).rejects.toThrow(
      /gremion\.t1\.content\.publish\.succeeded/,
    )
    await expect(broker.publish(subject, envelope)).rejects.toThrow(/NEWSLETTER/)
    expect(published, 'the event was published to a stream that cannot store it').toHaveLength(0)
  })

  it('publishes a captured subject unchanged', async () => {
    const { broker, published } = publishingBroker(STREAMS.NEWSLETTER.name)
    const subject = 'gremion.t1.newsletter.send.succeeded'
    await broker.publish(subject, envelope)
    expect(published).toEqual([subject])
  })
})

// ── 7. Precedence: the cover verdict outlives an intended stop ──────────────
describe('NatsBroker.subscribe() cover-error precedence', () => {
  it('a StreamCoverError still rejects ready and closed, and logs once, when unsubscribe() arrived while the check was in flight', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const js = jetStreamDelivering(messageSource())
    const broker = brokerWith(js, STREAMS.NEWSLETTER.name)

    const sub = broker.subscribe('gremion.*.content.>', async () => {})
    sub.unsubscribe()

    await expect(sub.ready, 'unsubscribe() erased the refusal').rejects.toBeInstanceOf(StreamCoverError)
    await expect(sub.closed).rejects.toBeInstanceOf(StreamCoverError)
    expect(js.consumersRequested).toBe(0)
    expect(errors).toHaveBeenCalledTimes(1)
  })

  it('a StreamCoverError still rejects ready and closed, and logs once, when broker.close() arrived while the check was in flight', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const js = jetStreamDelivering(messageSource())
    const broker = brokerWith(js, STREAMS.NEWSLETTER.name)

    const sub = broker.subscribe('gremion.*.content.>', async () => {})
    await broker.close()

    await expect(sub.ready, 'close() erased the refusal').rejects.toBeInstanceOf(StreamCoverError)
    await expect(sub.closed).rejects.toBeInstanceOf(StreamCoverError)
    expect(js.consumersRequested).toBe(0)
    expect(errors).toHaveBeenCalledTimes(1)
  })
})

// ── 8. The consumer aborts on a missing stream/consumer ─────────────────────
describe('NatsBroker.subscribe() missing-resource faulting', () => {
  it('asks consume() to abort on a missing resource instead of recreating the consumer forever', async () => {
    let consumeOpts: Record<string, unknown> | undefined
    const source = messageSource()
    const js = {
      consumers: {
        get: async () => ({
          consume: async (opts?: Record<string, unknown>) => {
            consumeOpts = opts
            return source
          },
        }),
      },
    }
    const broker = brokerWith(js)

    const sub = broker.subscribe('gremion.*.newsletter.>', async () => {})
    await sub.ready
    expect(consumeOpts, 'consume() was not told to abort when its stream or consumer disappears').toMatchObject({
      abort_on_missing_resource: true,
    })
    sub.unsubscribe()
    await sub.closed
  })

  it('a consumer iterator that DIES while the subscription is active rejects closed with an error naming the pattern and the stream, keeping the cause', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const died = new Error('consumer deleted')
    // The library's iterator throws once the server reports the resource gone.
    const dying = {
      async *[Symbol.asyncIterator]() {
        await Promise.resolve()
        throw died
      },
      close: async () => {},
      status: () => notificationQueue().iterable(),
    }
    const broker = brokerWith(jetStreamDelivering(dying))

    const sub = broker.subscribe('gremion.*.newsletter.>', async () => {})
    await sub.ready

    const err = await sub.closed.then(
      () => undefined,
      (e: unknown) => e as Error,
    )
    expect(err, 'closed resolved although the consumer iterator died').toBeInstanceOf(Error)
    expect(err!.message).toContain('gremion.*.newsletter.>')
    expect(err!.message).toContain('TEST_STREAM')
    expect(err!.cause).toBe(died)
    expect(errors).toHaveBeenCalledTimes(1)
  })
})

// ── 9. close() idempotency ───────────────────────────────────────────────────
describe('NatsBroker.close() idempotency', () => {
  it('drains once: a second close() is a quiet no-op', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    let drains = 0
    let closed = false
    const nc = {
      drain: async () => {
        if (closed) throw new Error('nats: connection closed')
        drains++
        closed = true
      },
      isClosed: () => closed,
    }
    const broker = brokerWith(jetStreamDelivering(messageSource()), 'TEST_STREAM', nc)

    await broker.close()
    await expect(broker.close(), 'the second close() threw').resolves.toBeUndefined()
    expect(drains).toBe(1)
    expect(errors).not.toHaveBeenCalled()
  })

  it('does not drain a connection that is already closed, and does not throw', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const nc = {
      drain: async () => {
        throw new Error('nats: connection closed')
      },
      isClosed: () => true,
    }
    const broker = brokerWith(jetStreamDelivering(messageSource()), 'TEST_STREAM', nc)

    await expect(broker.close(), 'close() after the connection went away threw').resolves.toBeUndefined()
    expect(errors).not.toHaveBeenCalled()
  })
})

// ── 10. publish()'s server-derived subject cache ─────────────────────────────
describe('NatsBroker.publish() subject cache', () => {
  const NEWSLETTER = 'gremion.t1.newsletter.send.succeeded'
  const CONTENT = 'gremion.t1.content.publish.succeeded'
  const envelope = makeEnvelope({ eventType: 'send.succeeded', tenantId: 't1', correlationId: null, payload: {} })

  /** A server whose bound-stream filter can be MOVED under the broker (an
   *  operator's `nats stream edit`), and a publish that can be made to fail. */
  function cachingBroker(initial: readonly string[], publishFailures: Error[] = []) {
    let serverFilter = [...initial]
    let gone = false
    let infoCalls = 0
    const published: string[] = []
    const jsm = {
      streams: {
        info: async () => {
          infoCalls++
          if (gone) throw streamNotFound()
          return { config: { subjects: [...serverFilter] } }
          infoCalls++
          return { config: { subjects: [...serverFilter] } }
        },
        add: async () => {},
        update: async () => {},
      },
    }
    const js = {
      consumers: {},
      publish: async (subject: string) => {
        const failure = publishFailures.shift()
        if (failure) throw failure
        published.push(subject)
        return {}
      },
    }
    const broker = brokerWithJsm(jsm, STREAMS.NEWSLETTER.name, js)
    return {
      broker,
      published,
      get infoCalls() {
        return infoCalls
      },
      repointServer(filter: readonly string[]) {
        serverFilter = [...filter]
      },
      failNext(err: Error) {
        publishFailures.push(err)
      },
      removeStream() {
        gone = true
      },
    }
  }

  it('asks streams.info() ONCE per broker and answers later publishes from the server-derived cache', async () => {
    const c = cachingBroker(STREAMS.NEWSLETTER.subjects)
    await c.broker.publish(NEWSLETTER, envelope)
    await c.broker.publish(NEWSLETTER, envelope)
    await c.broker.publish(NEWSLETTER, envelope)
    expect(c.infoCalls, 'publish() went back to the server for every event').toBe(1)
    expect(c.published).toHaveLength(3)
  })

  it('ensureStream() on the bound stream invalidates the cache', async () => {
    const c = cachingBroker(STREAMS.NEWSLETTER.subjects)
    await c.broker.publish(NEWSLETTER, envelope)
    expect(c.infoCalls).toBe(1)

    await c.broker.ensureStream(STREAMS.NEWSLETTER.name, [...STREAMS.NEWSLETTER.subjects])
    const afterEnsure = c.infoCalls // ensureStream()'s own read
    await c.broker.publish(NEWSLETTER, envelope)
    expect(c.infoCalls, 'publish() after ensureStream() answered from the pre-ensure cache').toBe(afterEnsure + 1)
  })

  it('never answers a REFUSAL from the cache: a filter moved on the server is re-read before NoStreamError', async () => {
    const c = cachingBroker(STREAMS.NEWSLETTER.subjects)
    await c.broker.publish(NEWSLETTER, envelope)
    expect(c.infoCalls).toBe(1)

    // An operator repoints the stream underneath this broker.
    c.repointServer(STREAMS.CONTENT.subjects)

    // The cached filter says "not covered"; the truth is re-read and the
    // publish goes through.
    await c.broker.publish(CONTENT, envelope)
    expect(c.infoCalls, 'a stale cache produced a false refusal').toBe(2)
    expect(c.published).toEqual([NEWSLETTER, CONTENT])

    // The newsletter subject is now genuinely uncaptured: refused, after one
    // more re-read — not from the cache.
    await expect(c.broker.publish(NEWSLETTER, envelope)).rejects.toBeInstanceOf(NoStreamError)
    expect(c.infoCalls).toBe(3)
    expect(c.published).toHaveLength(2)
  })

  it('retries ONE transient JetStream error after re-reading the filter', async () => {
    const c = cachingBroker(STREAMS.NEWSLETTER.subjects, [new TimeoutError()])
    await c.broker.publish(NEWSLETTER, envelope)
    expect(c.published, 'the transient error was not retried').toEqual([NEWSLETTER])
    expect(c.infoCalls, 'the retry did not re-read the server filter').toBe(2)
  })

  it('a transient error on a subject the re-read filter no longer captures becomes NoStreamError, with the cause', async () => {
    // What @nats-io/jetstream throws when no stream captures the subject.
    const noResponders = Object.assign(new Error('jetstream is not enabled'), { name: 'JetStreamNotEnabled' })
    const c = cachingBroker(STREAMS.NEWSLETTER.subjects)
    await c.broker.publish(NEWSLETTER, envelope) // cache: newsletter filter
    // An operator repoints the stream; the next publish, checked against the
    // stale cache, reaches the server and gets "no responders" back.
    c.repointServer(STREAMS.CONTENT.subjects)
    c.failNext(noResponders)
    c.published.length = 0

    const err = await c.broker.publish(NEWSLETTER, envelope).then(
      () => undefined,
      (e: unknown) => e as Error,
    )
    expect(err).toBeInstanceOf(NoStreamError)
    expect(err!.cause).toBe(noResponders)
    expect(c.published).toHaveLength(0)
  })

  it('does not retry a non-transient error, and does not retry twice', async () => {
    const denied = new Error('nats: permissions violation for publish')
    const c = cachingBroker(STREAMS.NEWSLETTER.subjects, [denied])
    await expect(c.broker.publish(NEWSLETTER, envelope)).rejects.toBe(denied)
    expect(c.published).toHaveLength(0)

    const twice = cachingBroker(STREAMS.NEWSLETTER.subjects, [new TimeoutError(), new TimeoutError()])
    await expect(twice.broker.publish(NEWSLETTER, envelope)).rejects.toBeInstanceOf(TimeoutError)
    expect(twice.published).toHaveLength(0)
  })

  it('a transient error followed by a stream that no longer exists rejects with NoStreamError carrying the failed publish as cause', async () => {
    const noResponders = Object.assign(new Error('jetstream is not enabled'), { name: 'JetStreamNotEnabled' })
    const c = cachingBroker(STREAMS.NEWSLETTER.subjects)
    await c.broker.publish(NEWSLETTER, envelope) // cache: newsletter filter
    // The stream is deleted under this producer (step 2 of the cutover): the
    // next publish, checked against the cache, reaches the server and gets
    // "no responders"; the re-read then finds no stream at all.
    c.removeStream()
    c.failNext(noResponders)
    c.published.length = 0

    const err = await c.broker.publish(NEWSLETTER, envelope).then(
      () => undefined,
      (e: unknown) => e as Error,
    )
    expect(err, 'the re-read failure escaped raw, dropping the publish failure').toBeInstanceOf(NoStreamError)
    expect(err!.message).toContain(NEWSLETTER)
    expect(err!.message).toContain('NEWSLETTER')
    expect(err!.cause, 'the original publish failure is not the cause').toBe(noResponders)
    expect(c.published).toHaveLength(0)
  })
})

// ── 11. Liveness: the status() notifications and the missed-heartbeat probe ──
//    abort_on_missing_resource covers the one answer the server volunteers (a
//    409 to a PENDING pull). A stream deleted between pulls gets no answer;
//    round 4 measured that fault arriving at 0 ms or at ~30 s, the library's
//    default pull expiry — never in between. The pull is now sized by
//    CONSUME_EXPIRES_MS / CONSUME_IDLE_HEARTBEAT_MS, and the status() iterator
//    is consumed: a missing-resource notification faults at once, and missed
//    heartbeats trigger a probe of the stream and the consumer on the server.
describe('NatsBroker.subscribe() liveness (status() notifications + probe)', () => {
  const PATTERN = 'gremion.*.newsletter.>'
  function liveBroker(opts: { streamInfo?: () => Promise<unknown>; consumerInfo?: () => Promise<unknown> } = {}) {
    const source = messageSource()
    const js = jetStreamDelivering(source, opts.consumerInfo)
    const jsm = {
      streams: { info: opts.streamInfo ?? (async () => ({ config: { subjects: [...STREAMS.NEWSLETTER.subjects] } })) },
    }
    const broker = brokerWith(js, STREAMS.NEWSLETTER.name, undefined, jsm)
    return { source, broker }
  }
  async function faultOf(closed: Promise<void>): Promise<Error> {
    const err = await closed.then(
      () => undefined,
      (e: unknown) => e as Error,
    )
    expect(err, 'closed resolved although the subscription was faulted').toBeInstanceOf(Error)
    return err!
  }
  const settleTick = () => new Promise((r) => setTimeout(r, 25))

  it('sizes the pull so a silent server is noticed: consume() gets expires and idle_heartbeat alongside the abort flag', async () => {
    let consumeOpts: Record<string, unknown> | undefined
    const source = messageSource()
    const js = {
      consumers: {
        get: async () => ({
          consume: async (opts?: Record<string, unknown>) => {
            consumeOpts = opts
            return source
          },
          info: async () => ({}),
        }),
      },
    }
    const broker = brokerWith(js)
    const sub = broker.subscribe(PATTERN, async () => {})
    await sub.ready
    expect(consumeOpts, 'the pull is not sized: a deleted stream is only noticed at the library default expiry').toMatchObject({
      abort_on_missing_resource: true,
      expires: CONSUME_EXPIRES_MS,
      idle_heartbeat: CONSUME_IDLE_HEARTBEAT_MS,
    })
    sub.unsubscribe()
    await sub.closed
  })

  it('a stream_not_found notification faults the subscription: StreamGoneError naming the pattern and the stream, iterator ended, one error log', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { source, broker } = liveBroker()
    const sub = broker.subscribe(PATTERN, async () => {})
    await sub.ready

    source.notify({ type: 'stream_not_found', name: 'NEWSLETTER' })

    const err = await faultOf(sub.closed)
    expect(err).toBeInstanceOf(StreamGoneError)
    expect(err.message).toContain(PATTERN)
    expect(err.message).toContain('NEWSLETTER')
    expect(source.closeCalls, 'the consumer iterator was left running after the fault').toBe(1)
    expect(errors).toHaveBeenCalledTimes(1)
  })

  it('a consumer_deleted notification faults the subscription with ConsumerGoneError', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { source, broker } = liveBroker()
    const sub = broker.subscribe(PATTERN, async () => {})
    await sub.ready

    source.notify({ type: 'consumer_deleted', code: 409, description: 'consumer deleted' })

    const err = await faultOf(sub.closed)
    expect(err).toBeInstanceOf(ConsumerGoneError)
    expect(err.message).toContain(PATTERN)
    expect(err.message).toContain('NEWSLETTER')
    expect(errors).toHaveBeenCalledTimes(1)
  })

  it('missed heartbeats probe the SERVER: a stream that is gone faults with StreamGoneError', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let probes = 0
    const { source, broker } = liveBroker({
      streamInfo: async () => {
        probes++
        if (probes > 1) throw streamNotFound() // the cover check read it; the probe finds it gone
        return { config: { subjects: [...STREAMS.NEWSLETTER.subjects] } }
      },
    })
    const sub = broker.subscribe(PATTERN, async () => {})
    await sub.ready

    source.notify({ type: 'heartbeats_missed', count: 2 })

    const err = await faultOf(sub.closed)
    expect(err).toBeInstanceOf(StreamGoneError)
    expect(err.message).toContain(PATTERN)
    expect(probes, 'missed heartbeats did not probe the stream on the server').toBe(2)
  })

  it('missed heartbeats probe the SERVER: a consumer that is gone faults with ConsumerGoneError', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { source, broker } = liveBroker({
      consumerInfo: async () => {
        throw Object.assign(new Error('consumer not found'), { code: 10014, status: 404 })
      },
    })
    const sub = broker.subscribe(PATTERN, async () => {})
    await sub.ready

    source.notify({ type: 'heartbeats_missed', count: 2 })

    const err = await faultOf(sub.closed)
    expect(err).toBeInstanceOf(ConsumerGoneError)
    expect(err.message).toContain(PATTERN)
    expect(err.message).toContain('NEWSLETTER')
  })

  it('missed heartbeats with the stream and consumer both present is a STALL: faults with ConsumerStalledError after STALL_PROBE_LIMIT consecutive probes, not before', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { source, broker } = liveBroker()
    const sub = broker.subscribe(PATTERN, async () => {})
    await sub.ready
    let outcome = 'pending'
    sub.closed.then(
      () => (outcome = 'resolved'),
      () => (outcome = 'rejected'),
    )

    for (let i = 1; i < STALL_PROBE_LIMIT; i++) source.notify({ type: 'heartbeats_missed', count: 2 })
    await settleTick()
    expect(outcome, 'faulted on a stall before STALL_PROBE_LIMIT probes').toBe('pending')
    // A heartbeat in between means the consumer recovered: the count starts over.
    source.notify({ type: 'heartbeat' })
    for (let i = 1; i < STALL_PROBE_LIMIT; i++) source.notify({ type: 'heartbeats_missed', count: 2 })
    await settleTick()
    expect(outcome, 'a recovered heartbeat did not reset the stall count').toBe('pending')
    expect(errors).not.toHaveBeenCalled()

    source.notify({ type: 'heartbeats_missed', count: 2 })
    const err = await faultOf(sub.closed)
    expect(err).toBeInstanceOf(ConsumerStalledError)
    expect(err.message).toContain(PATTERN)
    expect(err.message).toContain('NEWSLETTER')
    expect(errors).toHaveBeenCalledTimes(1)
  })

  it('informational notifications leave the subscription live and quiet', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { source, broker } = liveBroker()
    const sub = broker.subscribe(PATTERN, async () => {})
    await sub.ready
    let outcome = 'pending'
    sub.closed.then(
      () => (outcome = 'resolved'),
      () => (outcome = 'rejected'),
    )
    source.notify({ type: 'heartbeat' })
    source.notify({ type: 'next', options: {} })
    source.notify({ type: 'ordered_consumer_recreated', name: 'x' })
    source.notify({ type: 'reset', name: 'x' })
    await settleTick()
    expect(outcome).toBe('pending')
    expect(errors).not.toHaveBeenCalled()
    sub.unsubscribe()
    await expect(sub.closed).resolves.toBeUndefined()
  })
})

// ── 12. Bounds: setup and close() ────────────────────────────────────────────
//    Round 4's close() awaited every subscription's outcome BEFORE draining,
//    and a subscription parked in a setup round trip settles only when that
//    request does — the drain that used to cut it was now sequenced behind it.
//    Probe: streams.info() never settles, close() never returned.
describe('NatsBroker setup bound and close() bound', () => {
  const PATTERN = 'gremion.*.newsletter.>'
  const never = () => new Promise<never>(() => {})
  function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
    return Promise.race([
      p,
      new Promise<T>((_, reject) => setTimeout(() => reject(new Error(what + ' did not settle within ' + ms + ' ms')), ms)),
    ])
  }

  it('a setup round trip that never settles rejects ready and closed with SetupTimeoutError inside the setup bound, logged once', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const broker = brokerWith(jetStreamDelivering(messageSource()), 'NEWSLETTER', undefined, { streams: { info: never } }, {
      setupMs: 100,
    })
    const sub = broker.subscribe(PATTERN, async () => {})

    const err = await within(sub.ready, 1000, 'ready with a never-settling setup').then(
      () => undefined,
      (e: unknown) => e as Error,
    )
    expect(err, 'ready never settled: the setup has no bound').toBeInstanceOf(SetupTimeoutError)
    expect(err!.message).toContain(PATTERN)
    expect(err!.message).toContain('NEWSLETTER')
    expect(err!.message).toContain('100')
    await expect(sub.closed).rejects.toBe(err)
    expect(errors).toHaveBeenCalledTimes(1)
  })

  it('close() returns inside the close bound while a setup round trip is still in flight: warns naming the pattern, drains anyway', async () => {
    const warns = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    let drains = 0
    const nc = {
      drain: async () => {
        drains++
      },
      isClosed: () => false,
    }
    const broker = brokerWith(jetStreamDelivering(messageSource()), 'NEWSLETTER', nc, { streams: { info: never } }, {
      setupMs: 60_000,
      closeMs: 150,
    })
    broker.subscribe(PATTERN, async () => {})

    await within(broker.close(), 2000, 'close() with a never-settling setup')

    expect(drains, 'close() returned without draining').toBe(1)
    expect(warns, 'a close() that gave up waiting must say so').toHaveBeenCalledTimes(1)
    const warned = warns.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(warned).toContain(PATTERN)
    expect(warned).toContain('150')
    expect(errors).not.toHaveBeenCalled()
  })
})

// ── 13. close(): drain tolerance, one in-flight shutdown, a forgotten failure ─
describe('NatsBroker.close() drain tolerance and retry', () => {
  it('tolerates a drain that fails because the connection is already closed: resolves, one debug line, no error log', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const debugs = vi.spyOn(console, 'debug').mockImplementation(() => {})
    let closed = false
    const nc = {
      drain: async () => {
        closed = true // the connection went away under the drain
        throw new Error('nats: connection closed')
      },
      isClosed: () => closed,
    }
    const broker = brokerWith(jetStreamDelivering(messageSource()), 'TEST_STREAM', nc)

    await expect(broker.close(), 'a drain error on a closed connection is not a failed close()').resolves.toBeUndefined()
    expect(debugs).toHaveBeenCalledTimes(1)
    expect(errors).not.toHaveBeenCalled()
  })

  it('rethrows any other drain failure, forgets that attempt, and a later close() drains again', async () => {
    let drains = 0
    const boom = new Error('drain blew up')
    const nc = {
      drain: async () => {
        drains++
        if (drains === 1) throw boom
      },
      isClosed: () => false,
    }
    const broker = brokerWith(jetStreamDelivering(messageSource()), 'TEST_STREAM', nc)

    await expect(broker.close()).rejects.toBe(boom)
    await expect(broker.close(), 'the rejected shutdown was memoised: no later close() can retry').resolves.toBeUndefined()
    expect(drains).toBe(2)
  })

  it('shares ONE in-flight shutdown: concurrent close() calls get the same promise and drain once', async () => {
    let drains = 0
    const nc = {
      drain: async () => {
        drains++
        await new Promise((r) => setTimeout(r, 10))
      },
      isClosed: () => false,
    }
    const broker = brokerWith(jetStreamDelivering(messageSource()), 'TEST_STREAM', nc)
    const first = broker.close()
    const second = broker.close()
    expect(second).toBe(first)
    await first
    expect(drains).toBe(1)
  })
})

// ── 14. endIterator(): a messages.close() rejection is logged, not swallowed ─
describe('NatsBroker.subscribe() iterator close failure', () => {
  it('logs a messages.close() rejection naming the pattern and the stream', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const source = messageSource([], new Error('iterator close blew up'))
    const broker = brokerWith(jetStreamDelivering(source))
    const sub = broker.subscribe('gremion.*.newsletter.>', async () => {})
    await sub.ready

    sub.unsubscribe()
    await sub.closed

    await vi.waitFor(() => expect(errors, 'the close() rejection was swallowed').toHaveBeenCalled())
    const reported = errors.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(reported).toContain('gremion.*.newsletter.>')
    expect(reported).toContain('TEST_STREAM')
    expect(reported).toContain('iterator close blew up')
  })
})

// ── 15. The two entry points export ONE set of port errors and bounds ────────
describe('@gremion/ports/nats re-exports the port error classes and bounds from @gremion/ports/broker', () => {
  it('is the same class identity on both entry points', () => {
    expect(StreamCoverError).toBe(port.StreamCoverError)
    expect(NoStreamError).toBe(port.NoStreamError)
    expect(StreamRepointedError).toBe(port.StreamRepointedError)
    expect(StreamGoneError).toBe(port.StreamGoneError)
    expect(ConsumerGoneError).toBe(port.ConsumerGoneError)
    expect(ConsumerStalledError).toBe(port.ConsumerStalledError)
    expect(SetupTimeoutError).toBe(port.SetupTimeoutError)
    expect(LIVENESS_FAULT_BOUND_MS).toBe(port.LIVENESS_FAULT_BOUND_MS)
  })

  it('the consume tuning fits inside the published liveness bound', () => {
    // The library's monitor ticks every idle_heartbeat and fires once two
    // ticks in a row saw no heartbeat: worst case three ticks after the last
    // one, then one probe round trip. The bound must hold that with room.
    expect(3 * CONSUME_IDLE_HEARTBEAT_MS).toBeLessThan(LIVENESS_FAULT_BOUND_MS)
    expect(CONSUME_EXPIRES_MS, 'below the library minimum for expires').toBeGreaterThanOrEqual(1000)
    expect(CONSUME_IDLE_HEARTBEAT_MS, 'below the library minimum for idle_heartbeat').toBeGreaterThanOrEqual(500)
    expect(CONSUME_IDLE_HEARTBEAT_MS).toBeLessThanOrEqual(CONSUME_EXPIRES_MS)
  })
})
