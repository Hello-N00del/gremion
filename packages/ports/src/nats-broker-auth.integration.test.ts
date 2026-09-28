// packages/ports/src/nats-broker-auth.integration.test.ts
//
// TASK-024 G2, against doubles (no server): NatsBroker.connect() gains an
// optional { authenticator, inboxPrefix, name } and passes NOTHING new without
// it; ensureStream() writes only on drift -- a server config equal to the one
// it would write is left alone (a module's nkey may read its stream's info but
// never update it), while the bound stream's subject cache is still dropped.
//
// Named *.integration.test.ts because it loads ./nats-broker.js: gremion-ui's
// jsdom run excludes that pattern, and nats-broker.test.ts must stay free of
// the NATS transport (see its header). The real-server half is
// packages/nats-auth/scripts/proof.sh.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { nkeyAuthenticator } from '@nats-io/nats-core'

const connectCalls: unknown[] = []
vi.mock('@nats-io/transport-node', () => ({
  connect: async (opts: unknown) => {
    connectCalls.push(opts)
    return { isClosed: () => false, drain: async () => {} }
  },
}))
vi.mock('@nats-io/jetstream', async (orig) => {
  const real = (await orig()) as Record<string, unknown>
  return { ...real, jetstream: () => ({ consumers: {} }), jetstreamManager: async () => ({ streams: {} }) }
})

const { NatsBroker } = await import('./nats-broker.js')
const { STREAMS } = await import('./broker.js')

beforeEach(() => {
  connectCalls.length = 0
})

describe('NatsBroker.connect() options (G2)', () => {
  it('without opts connects with exactly { servers } -- unchanged', async () => {
    await NatsBroker.connect('nats://h:4222', STREAMS.CONTENT.name)
    expect(connectCalls).toEqual([{ servers: 'nats://h:4222' }])
  })

  it('passes authenticator, inboxPrefix and name through', async () => {
    const authenticator = nkeyAuthenticator(new Uint8Array()) // never invoked: connect is mocked
    await NatsBroker.connect('nats://h:4222', STREAMS.CONTENT.name, { authenticator, inboxPrefix: '_INBOX_content_ta', name: 'content@ta' })
    expect(connectCalls).toEqual([{ servers: 'nats://h:4222', authenticator, inboxPrefix: '_INBOX_content_ta', name: 'content@ta' }])
  })

  it('leaves out an option given as undefined', async () => {
    await NatsBroker.connect('nats://h:4222', STREAMS.CONTENT.name, { name: 'x', inboxPrefix: undefined })
    expect(connectCalls).toEqual([{ servers: 'nats://h:4222', name: 'x' }])
  })
})

/** What a 2.12 server reports for a stream ensureStream() created. */
const serverConfig = (subjects: readonly string[], over: Record<string, unknown> = {}) => ({
  config: {
    name: 'X',
    subjects: [...subjects],
    storage: 'file',
    max_age: 7 * 24 * 60 * 60 * 1_000_000_000,
    max_msgs: 50_000,
    duplicate_window: 2 * 60 * 1_000_000_000,
    retention: 'limits',
    // server-side defaults ensureStream() never sets: not part of the compare
    max_bytes: -1,
    num_replicas: 1,
    discard: 'old',
    ...over,
  },
})

function ensureDouble(info: () => unknown) {
  const calls = { info: 0, update: 0, add: 0 }
  const jsm = {
    streams: {
      info: async () => {
        calls.info++
        return info()
      },
      add: async () => {
        calls.add++
      },
      update: async () => {
        calls.update++
      },
    },
  }
  let published = 0
  const js = { consumers: {}, publish: async () => { published++; return {} } }
  const broker = Reflect.construct(NatsBroker, [{ drain: async () => {}, isClosed: () => false }, js, jsm, STREAMS.NEWSLETTER.name]) as import('./nats-broker.js').NatsBroker
  return { broker, calls, get published() { return published } }
}

describe('NatsBroker.ensureStream() is read-only on an equal config (G2)', () => {
  const S = STREAMS.NEWSLETTER

  it('equal config: streams.info only, no update', async () => {
    const d = ensureDouble(() => serverConfig(S.subjects))
    await d.broker.ensureStream(S.name, [...S.subjects])
    expect(d.calls).toEqual({ info: 1, update: 0, add: 0 })
  })

  it('equal config still invalidates the bound stream subject cache', async () => {
    const d = ensureDouble(() => serverConfig(S.subjects))
    const envelope = { eventId: 'e1', eventType: 'x', tenantId: 'ta', occurredAt: new Date(0).toISOString(), correlationId: null, payload: {} }
    await d.broker.publish('gremion.ta.newsletter.send.succeeded', envelope)
    expect(d.calls.info).toBe(1)
    await d.broker.ensureStream(S.name, [...S.subjects])
    expect(d.calls.info).toBe(2)
    await d.broker.publish('gremion.ta.newsletter.send.succeeded', envelope)
    expect(d.calls.info, 'publish() after an equal ensureStream() answered from the pre-ensure cache').toBe(3)
    expect(d.calls.update).toBe(0)
  })

  for (const [field, value] of [
    ['max_age', 1],
    ['max_msgs', 1],
    ['duplicate_window', 1],
    ['storage', 'memory'],
    ['retention', 'workqueue'],
  ] as const) {
    it(`drift in ${field} still updates`, async () => {
      const d = ensureDouble(() => serverConfig(S.subjects, { [field]: value }))
      await d.broker.ensureStream(S.name, [...S.subjects])
      expect(d.calls.update).toBe(1)
    })
  }

  it('a filter in another order is equal, not drift', async () => {
    const two = ['gremion.*.a.>', 'gremion.*.b.>']
    const d = ensureDouble(() => serverConfig([...two].reverse()))
    await d.broker.ensureStream(S.name, two)
    expect(d.calls.update).toBe(0)
  })

  it('a repoint is still refused', async () => {
    const d = ensureDouble(() => serverConfig(['gremion.*.elsewhere.>']))
    await expect(d.broker.ensureStream(S.name, [...S.subjects])).rejects.toThrow(/refusing to repoint/)
    expect(d.calls.update).toBe(0)
  })

  it('an absent stream is still created', async () => {
    const d = ensureDouble(() => {
      throw Object.assign(new Error('stream not found'), { code: 10059, status: 404 })
    })
    await d.broker.ensureStream(S.name, [...S.subjects])
    expect(d.calls).toEqual({ info: 1, update: 0, add: 1 })
  })
})
