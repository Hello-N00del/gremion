// test/org-unit-consumer-boot.test.ts — the BOOT seam of the org-unit mirror
// consumer (startOrgUnitConsumer), driven with broker doubles.
//
// Round 1 of the gitlink bump wired `ready` and `closed` in the leaf entrypoint
// where nothing could reach them, and the `closed` handler exited(1)
// unconditionally — so a clean SIGTERM (which closes the subscription on
// purpose) raced a spurious non-zero exit against the pool drain. These are the
// four things the resolution has to keep true:
//
//   1. a `ready` REJECTION propagates out of the boot (the caller exits non-zero)
//      and the broker is CLOSED rather than leaked;
//   2. an ensureStream REPOINT REFUSAL does the same, with the server's own
//      message intact;
//   3. a `closed` rejection while the process is STOPPED is not a fault —
//      onFatal is never called;
//   4. a `closed` rejection while the process is LIVE is a fault — onFatal is
//      called with the error.

import { describe, it, expect } from 'vitest'
import type { BrokerSubscription, EventEnvelope } from '@gremion/ports/broker'
import { startOrgUnitConsumer, type LeafBroker, type OrgUnitMirrorStore } from '../src/org-unit-consumer.ts'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  // An unhandled rejection here would fail the run before the code under test
  // ever attaches its own handler.
  promise.catch(() => {})
  return { promise, resolve, reject }
}

interface FakeBroker extends LeafBroker {
  closed: boolean
  ensureStreamCalls: number
  unsubscribed: number
  ready: Deferred<void>
  subClosed: Deferred<void>
}

function makeBroker(opts: { ensureStreamError?: Error } = {}): FakeBroker {
  const ready = deferred<void>()
  const subClosed = deferred<void>()
  const broker: FakeBroker = {
    closed: false,
    ensureStreamCalls: 0,
    unsubscribed: 0,
    ready,
    subClosed,
    async ensureStream(): Promise<void> {
      broker.ensureStreamCalls += 1
      if (opts.ensureStreamError) throw opts.ensureStreamError
    },
    async close(): Promise<void> {
      broker.closed = true
    },
    async publish(): Promise<void> {},
    // Signature-matched to BrokerPort.subscribe: the handler takes (event,
    // subject). A one-parameter handler is not assignable to it, and the `as
    // FakeBroker` cast below stopped being able to bridge that once the kernel
    // added the subject argument — which is what broke `typecheck:tests`.
    subscribe(
      _subjectPattern: string,
      _handler: (event: EventEnvelope, subject: string) => Promise<void>,
    ): BrokerSubscription {
      const sub: BrokerSubscription = {
        ready: ready.promise,
        closed: subClosed.promise,
        unsubscribe(): void {
          broker.unsubscribed += 1
        },
      }
      return sub
    },
  } as FakeBroker
  return broker
}

const noStore = async (): Promise<OrgUnitMirrorStore | undefined> => undefined

describe('startOrgUnitConsumer — boot refusals are fatal', () => {
  it('propagates a `ready` rejection and closes the broker instead of leaking it', async () => {
    const broker = makeBroker()
    const fatals: unknown[] = []
    const cover = new Error(
      '[nats-broker] stream ORGUNIT does not cover subscription "gremion.*.org-unit.>" ' +
        '(the server reports it captures [stura.*.org-unit.>])',
    )
    broker.ready.reject(cover)

    await expect(
      startOrgUnitConsumer({
        connect: async () => broker,
        resolveStore: noStore,
        isStopped: () => false,
        onFatal: (e) => fatals.push(e),
        log: () => {},
        error: () => {},
      }),
    ).rejects.toBe(cover)

    expect(broker.closed).toBe(true)
    // A boot refusal is the CALLER's exit, not onFatal's — the caller is the one
    // that names the migration command.
    expect(fatals).toEqual([])
  })

  it('propagates the ensureStream repoint refusal verbatim and never subscribes', async () => {
    const refusal = new Error(
      '[nats-broker] refusing to repoint stream ORGUNIT: it currently captures ' +
        '[stura.*.org-unit.>] but this call would set [gremion.*.org-unit.>].',
    )
    const broker = makeBroker({ ensureStreamError: refusal })

    await expect(
      startOrgUnitConsumer({
        connect: async () => broker,
        resolveStore: noStore,
        isStopped: () => false,
        onFatal: () => {},
        log: () => {},
        error: () => {},
      }),
    ).rejects.toThrow('refusing to repoint stream ORGUNIT')

    expect(broker.ensureStreamCalls).toBe(1)
    expect(broker.closed).toBe(true)
  })
})

describe('startOrgUnitConsumer — a `closed` rejection is read against the shutdown flag', () => {
  it('does NOT fault when the subscription ends because shutdown started', async () => {
    const broker = makeBroker()
    const fatals: unknown[] = []
    let stopped = false
    broker.ready.resolve()

    const handle = await startOrgUnitConsumer({
      connect: async () => broker,
      resolveStore: noStore,
      isStopped: () => stopped,
      onFatal: (e) => fatals.push(e),
      log: () => {},
      error: () => {},
    })

    // Exactly what createShutdown's before() hook does.
    stopped = true
    await handle.close()
    broker.subClosed.reject(new Error('consumer ended'))
    await new Promise((r) => setImmediate(r))

    expect(fatals).toEqual([])
    expect(broker.unsubscribed).toBe(1)
    expect(broker.closed).toBe(true)
  })

  it('DOES fault when the subscription dies while the process is still live', async () => {
    const broker = makeBroker()
    const fatals: unknown[] = []
    broker.ready.resolve()

    await startOrgUnitConsumer({
      connect: async () => broker,
      resolveStore: noStore,
      isStopped: () => false,
      onFatal: (e) => fatals.push(e),
      log: () => {},
      error: () => {},
    })

    const died = new Error('[nats-broker] stream ORGUNIT was deleted under subscription')
    broker.subClosed.reject(died)
    await new Promise((r) => setImmediate(r))

    expect(fatals).toEqual([died])
    // The restart opens a NEW broker (connect() runs again), so the one whose
    // subscription just died must be handed back before onFatal is called.
    // Round 3 dropped the handle: every mid-life death stranded a live NATS
    // connection for the life of the process — the leak the BOOT path's catch
    // was already fixed for, reintroduced two lines below it.
    expect(broker.closed).toBe(true)
  })

  it('closes the dead broker BEFORE onFatal, so the restart never overlaps it', async () => {
    const broker = makeBroker()
    const closedWhenFatal: boolean[] = []
    broker.ready.resolve()

    await startOrgUnitConsumer({
      connect: async () => broker,
      resolveStore: noStore,
      isStopped: () => false,
      onFatal: () => closedWhenFatal.push(broker.closed),
      log: () => {},
      error: () => {},
    })

    broker.subClosed.reject(new Error('consumer deleted under subscription'))
    await new Promise((r) => setImmediate(r))

    expect(closedWhenFatal).toEqual([true])
  })
})
