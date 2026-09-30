// The TASK-024 acceptance, against a RUNNING broker (scripts/proof.sh).
//
//   proof.sh --open   today's open broker (-js, no config): every A case RED,
//                     every F case GREEN -- the record that the A cases test
//                     something the open broker does not do.
//   proof.sh --auth   docker/nats/nats.conf + the rendered accounts file:
//                     A1-A3, F1-F4, I1-I3, SYS, reload all GREEN.
//
// Every refusal runs a positive control first on the same connection and
// passes only on the server's own violation text (harness.refused).
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createUser } from '@nats-io/nkeys'
import { nkeyAuthenticator } from '@nats-io/nats-core'
import { connect } from '@nats-io/transport-node'
import { jetstreamManager, AckPolicy, DeliverPolicy } from '@nats-io/jetstream'
import {
  STREAMS,
  calendarSubject,
  contentSubject,
  newsletterSubject,
  orgUnitSubject,
  type EventEnvelope,
} from '@gremion/ports/broker'
import { NatsBroker } from '@gremion/ports/nats'
import { adminConnectOptionsFor, natsConnectOptionsFor, sysReloadConnectOptions } from '../../src/connect.ts'
import { ensureTenantAccount } from '../../src/ensure.ts'
import { natsBrokerOps } from '../../src/broker-ops.ts'
import { SeedStore } from '../../src/store.ts'
import { ACCOUNTS, CONTAINER, MODE, URL, containerState, connectRefused, loc, monitor, open, rawClient, refused, sleep, type Conn } from './harness.ts'

const A = 'ta'
const B = 'tb'
const ALL = ['publishing', 'content', 'calendar', 'finance', 'board']
const broker = () => natsBrokerOps({ url: URL, secretsDir: loc.secretsDir, attempts: 10, delayMs: 500 })
const ensure = (tenant: string, modules: string[]) => ensureTenantAccount({ tenant, modules }, { secretsDir: loc.secretsDir, accountsDir: ACCOUNTS, broker: broker() })

const conns: Conn[] = []
const brokers: NatsBroker[] = []
async function as(tenant: string, module: string): Promise<Conn> {
  const c = await open(module === 'admin' ? adminConnectOptionsFor(tenant, loc) : natsConnectOptionsFor(tenant, module, loc))
  conns.push(c)
  return c
}
async function bootBroker(tenant: string, module: string, stream: keyof typeof STREAMS): Promise<NatsBroker> {
  const d = STREAMS[stream]
  // The caller's boot, verbatim but for the identity: connect by descriptor, ensureStream.
  const b = await NatsBroker.connect(URL, d.name, natsConnectOptionsFor(tenant, module, loc))
  brokers.push(b)
  await b.ensureStream(d.name, [...d.subjects])
  return b
}
const envelope = (tenant: string, eventType: string): EventEnvelope => ({
  eventId: randomUUID(),
  eventType,
  tenantId: tenant,
  occurredAt: new Date().toISOString(),
  correlationId: null,
  payload: {},
})

beforeAll(async () => {
  if (MODE === 'auth') {
    // nats-auth init ran before the broker started (proof.sh, as Q12 orders it).
    await ensure(A, ALL)
    await ensure(B, ALL)
  } else {
    // The open broker takes no config: keys exist, the server ignores them.
    const store = new SeedStore(loc.secretsDir)
    for (const t of [A, B]) {
      await store.ensureSeed('_admin', t)
      for (const m of ['kernel', ...ALL.filter((m) => m !== 'board')]) await store.ensureSeed(m, t)
    }
    for (const d of Object.values(STREAMS)) {
      const b = await NatsBroker.connect(URL, d.name)
      await b.ensureStream(d.name, [...d.subjects])
      await b.close()
    }
  }
}, 120_000)

afterAll(async () => {
  for (const b of brokers) await b.close().catch(() => {})
  for (const c of conns) if (!c.nc.isClosed()) await c.nc.close().catch(() => {})
})

describe('A1 no anonymous access', () => {
  test('A1 no credentials: Authorization Violation', async () => {
    const control = await as(A, 'kernel') // a known key IS admitted
    expect(control.nc.isClosed()).toBe(false)
    expect(await connectRefused({})).toContain('Authorization Violation')
  })
  test('A1 unknown nkey: Authorization Violation', async () => {
    await as(A, 'kernel')
    expect(await connectRefused({ authenticator: nkeyAuthenticator(createUser().getSeed()) })).toContain('Authorization Violation')
  })
})

describe('A2 one account per tenant', () => {
  test("A2 A's publishing key publishing gremion.<B>.newsletter.x: Permissions Violation", async () => {
    const c = await as(A, 'publishing')
    expect(await refused(c, {
      control: async () => c.nc.publish(newsletterSubject(A, 'send.succeeded'), '{}'),
      forbidden: async () => c.nc.publish(`gremion.${B}.newsletter.x`, '{}'),
      text: `Permissions Violation for Publish to "gremion.${B}.newsletter.x"`,
    })).toContain('Permissions Violation')
  })
  test("A2 A's publishing key subscribing gremion.<B>.>: Permissions Violation", async () => {
    const c = await as(A, 'publishing')
    expect(await refused(c, {
      control: async () => c.nc.subscribe('_INBOX_publishing_ta.control'),
      forbidden: async () => c.nc.subscribe(`gremion.${B}.>`),
      text: `Permissions Violation for Subscription to "gremion.${B}.>"`,
    })).toContain('Permissions Violation')
  })
  test("A2 A's publishing key subscribing >: Permissions Violation", async () => {
    const c = await as(A, 'publishing')
    expect(await refused(c, {
      control: async () => c.nc.subscribe('_INBOX_publishing_ta.control'),
      forbidden: async () => c.nc.subscribe('>'),
      text: 'Permissions Violation for Subscription to ">"',
    })).toContain('Permissions Violation')
  })
  test("A2 B's event never reaches A's NEWSLETTER (A's admin reads it)", async () => {
    const admin = await as(A, 'admin')
    const jsm = await jetstreamManager(admin.nc)
    const before = (await jsm.streams.info('NEWSLETTER')).state.messages
    const bPub = await bootBroker(B, 'publishing', 'NEWSLETTER')
    const eB = envelope(B, 'send.succeeded')
    await bPub.publish(newsletterSubject(B, 'send.succeeded'), eB)
    await sleep(200)
    const after = (await jsm.streams.info('NEWSLETTER')).state.messages
    expect(after, "A's NEWSLETTER count moved when B published").toBe(before)
    // a subject-filtered fetch of A's stream for B's subjects holds nothing
    const name = `t024-a2-${randomUUID().slice(0, 8)}`
    await jsm.consumers.add('NEWSLETTER', { name, ack_policy: AckPolicy.None, deliver_policy: DeliverPolicy.All, filter_subject: `gremion.${B}.newsletter.>` })
    const js = (await import('@nats-io/jetstream')).jetstream(admin.nc)
    const consumer = await js.consumers.get('NEWSLETTER', name)
    const batch = await consumer.fetch({ max_messages: 100, expires: 1_000 })
    const ids: string[] = []
    for await (const m of batch) ids.push((m.json() as EventEnvelope).eventId)
    expect(ids).not.toContain(eB.eventId)
    expect(ids).toEqual([])
    await jsm.consumers.delete('NEWSLETTER', name)
  })
  test('A2 /connz?auth=true: A in T_ta, B in T_tb', async () => {
    await as(A, 'finance')
    await as(B, 'finance')
    await sleep(200)
    const connz = monitor<{ connections: { name?: string; account?: string }[] }>('/connz?auth=true&limit=1024')
    const acct = (name: string) => connz.connections.find((c) => c.name === name)?.account
    expect(acct(`finance@${A}`)).toBe(`T_${A}`)
    expect(acct(`finance@${B}`)).toBe(`T_${B}`)
  })
})

describe('A3 no cross-module access (publishing vs content, tenant A)', () => {
  const infoControl = (c: Conn) => async () => (await jetstreamManager(c.nc)).streams.info('NEWSLETTER')
  test("A3 core publish to content's subjects: Permissions Violation", async () => {
    const c = await as(A, 'publishing')
    expect(await refused(c, {
      control: async () => c.nc.publish(newsletterSubject(A, 'send.failed'), '{}'),
      forbidden: async () => c.nc.publish(contentSubject(A, 'publish.succeeded'), '{}'),
      text: `Permissions Violation for Publish to "${contentSubject(A, 'publish.succeeded')}"`,
    })).toContain('Permissions Violation')
  })
  test("A3 core subscribe to content's subjects: Permissions Violation", async () => {
    const c = await as(A, 'publishing')
    expect(await refused(c, {
      control: async () => c.nc.subscribe('_INBOX_publishing_ta.control'),
      forbidden: async () => c.nc.subscribe(`gremion.${A}.content.>`),
      text: `Permissions Violation for Subscription to "gremion.${A}.content.>"`,
    })).toContain('Permissions Violation')
  })
  test('A3 consumer create on CONTENT (no flow): Permissions Violation', async () => {
    const c = await as(A, 'publishing')
    expect(await refused(c, {
      control: infoControl(c),
      forbidden: async () => (await jetstreamManager(c.nc)).consumers.add('CONTENT', { name: 't024-a3', ack_policy: AckPolicy.None }),
      text: 'Permissions Violation for Publish to "$JS.API.CONSUMER.CREATE.CONTENT',
    })).toContain('Permissions Violation')
  })
  test('A3 DIRECT.GET on CONTENT: Permissions Violation', async () => {
    const c = await as(A, 'publishing')
    expect(await refused(c, {
      control: infoControl(c),
      forbidden: async () => c.nc.request('$JS.API.DIRECT.GET.CONTENT', JSON.stringify({ seq: 1 }), { timeout: 3_000 }),
      text: 'Permissions Violation for Publish to "$JS.API.DIRECT.GET.CONTENT"',
    })).toContain('Permissions Violation')
  })
  test('A3 STREAM.MSG.GET on CONTENT: Permissions Violation', async () => {
    const c = await as(A, 'publishing')
    expect(await refused(c, {
      control: infoControl(c),
      forbidden: async () => c.nc.request('$JS.API.STREAM.MSG.GET.CONTENT', JSON.stringify({ seq: 1 }), { timeout: 3_000 }),
      text: 'Permissions Violation for Publish to "$JS.API.STREAM.MSG.GET.CONTENT"',
    })).toContain('Permissions Violation')
  })
  test("A3 side door: STREAM.UPDATE of its own NEWSLETTER widened to content's subjects: Permissions Violation", async () => {
    const c = await as(A, 'publishing')
    expect(await refused(c, {
      control: infoControl(c),
      forbidden: async () => {
        const jsm = await jetstreamManager(c.nc)
        const cfg = (await jsm.streams.info('NEWSLETTER')).config
        return jsm.streams.update('NEWSLETTER', { ...cfg, subjects: [...cfg.subjects!, `gremion.${A}.content.>`] })
      },
      text: 'Permissions Violation for Publish to "$JS.API.STREAM.UPDATE.NEWSLETTER"',
    })).toContain('Permissions Violation')
  })
  test("A3 content's inbox prefix: Permissions Violation", async () => {
    const c = await as(A, 'publishing')
    expect(await refused(c, {
      control: async () => c.nc.subscribe('_INBOX_publishing_ta.control'),
      forbidden: async () => c.nc.subscribe(`_INBOX_content_${A}.>`),
      text: `Permissions Violation for Subscription to "_INBOX_content_${A}.>"`,
    })).toContain('Permissions Violation')
  })
})

/** Boots consumer then producer as the callers do; asserts the consumer received the one event exactly once. */
async function flow(producer: string, consumer: string, stream: keyof typeof STREAMS, subject: string, eventType: string): Promise<void> {
  const d = STREAMS[stream]
  const sub = await bootBroker(A, consumer, stream)
  const got: string[] = []
  const e = envelope(A, eventType)
  const s = sub.subscribe(d.subjects[0]!, async (env) => {
    got.push(env.eventId)
  })
  brokers.push(sub)
  await s.ready
  const pub = await bootBroker(A, producer, stream)
  await pub.publish(subject, e)
  for (let i = 0; i < 100 && !got.includes(e.eventId); i++) await sleep(50)
  const delivered = got.filter((id) => id === e.eventId)
  expect(delivered, `${consumer} did not receive ${producer}'s ${e.eventId}`).toEqual([e.eventId])
  s.unsubscribe()
}

describe('F the current flows deliver, as the callers boot', () => {
  test('F1 kernel -> ORGUNIT -> finance', async () => {
    await flow('kernel', 'finance', 'ORGUNIT', orgUnitSubject(A, 'upserted'), 'upserted')
  })
  test('F2 publishing -> NEWSLETTER -> kernel', async () => {
    await flow('publishing', 'kernel', 'NEWSLETTER', newsletterSubject(A, 'send.succeeded'), 'send.succeeded')
  })
  test('F3 content -> CONTENT -> kernel', async () => {
    await flow('content', 'kernel', 'CONTENT', contentSubject(A, 'publish.succeeded'), 'publish.succeeded')
  })
  test('F4 calendar -> CALENDAR -> kernel', async () => {
    await flow('calendar', 'kernel', 'CALENDAR', calendarSubject(A, 'event.created'), 'event.created')
  })
})

describe.runIf(MODE === 'auth')('I idempotence, additions, eviction (auth broker)', () => {
  // Production tenant ids are lowercase UUIDs: prove the server takes one as
  // an account name (T_<uuid>) and inside an inbox prefix.
  const C = '0f7c2a52-3c1e-4b8e-9a51-6d2f0c9e4b7a'
  const loadTime = () => monitor<{ config_load_time: string }>('/varz').config_load_time
  const accounts = () => readFileSync(path.join(ACCOUNTS, 'accounts.conf'), 'utf8')

  test('I1 a second identical call creates no key, rewrites nothing, reloads nothing', async () => {
    await ensure(C, ['publishing'])
    const bytes = accounts()
    const t0 = loadTime()
    await sleep(1_100) // config_load_time has second resolution in some builds
    const r = await ensure(C, ['publishing'])
    expect(r).toEqual({ accountRef: `T_${C}`, createdUsers: [], removedUsers: [], reloaded: false })
    expect(accounts()).toBe(bytes)
    expect(loadTime()).toBe(t0)
  })

  test('I2 adding a module adds one user (and reloads); creating tenant td leaves a live subscription delivering', async () => {
    const t0 = loadTime()
    const r = await ensure(C, ['publishing', 'finance'])
    expect(r.createdUsers).toEqual(['finance'])
    expect(r.reloaded).toBe(true)
    expect(loadTime()).not.toBe(t0)
    // a live C subscription survives another tenant's creation
    const sub = await NatsBroker.connect(URL, 'NEWSLETTER', natsConnectOptionsFor(C, 'kernel', loc))
    brokers.push(sub)
    await sub.ensureStream('NEWSLETTER', [...STREAMS.NEWSLETTER.subjects])
    const got: string[] = []
    const s = sub.subscribe(STREAMS.NEWSLETTER.subjects[0]!, async (env) => {
      got.push(env.eventId)
    })
    await s.ready
    const created = await ensure('td', ['calendar'])
    expect(created.reloaded).toBe(true)
    const pub = await NatsBroker.connect(URL, 'NEWSLETTER', natsConnectOptionsFor(C, 'publishing', loc))
    brokers.push(pub)
    await pub.ensureStream('NEWSLETTER', [...STREAMS.NEWSLETTER.subjects])
    const e = envelope(C, 'send.succeeded')
    await pub.publish(newsletterSubject(C, 'send.succeeded'), e)
    for (let i = 0; i < 100 && !got.includes(e.eventId); i++) await sleep(50)
    expect(got).toContain(e.eventId)
    s.unsubscribe()
  })

  test('I3 dropping finance closes its live subscription with Authorization Violation within 5 s; the old seed is refused', async () => {
    const seed = new SeedStore(loc.secretsDir).seedFor('finance', C).seed
    // The module as it boots (NatsBroker, library reconnect defaults), live.
    const fin = await NatsBroker.connect(URL, 'ORGUNIT', natsConnectOptionsFor(C, 'finance', loc))
    brokers.push(fin)
    await fin.ensureStream('ORGUNIT', [...STREAMS.ORGUNIT.subjects])
    const sub = fin.subscribe(STREAMS.ORGUNIT.subjects[0]!, async () => {})
    await sub.ready // positive control: admitted, consumer live
    // A plain connection with the same library defaults, to read WHY it closed.
    const probe = await connect({ servers: URL, ...natsConnectOptionsFor(C, 'finance', loc) })
    const probeClosed = probe.closed()
    // And the wire itself: when does the server drop the socket?
    const raw = await rawClient(seed, `finance@${C}-raw`, `_INBOX_finance_${C}.live`)
    expect(raw.lines).toContain('PONG')

    const t0 = Date.now()
    const r = await ensure(C, ['publishing'])
    expect(r.removedUsers).toEqual(['finance'])
    const subOutcome = await Promise.race([
      sub.closed.then(() => 'resolved', (e: unknown) => `rejected: ${e instanceof Error ? e.message : String(e)}`),
      sleep(5_000).then(() => 'still open after 5 s'),
    ])
    const elapsed = Date.now() - t0
    expect(subOutcome).toMatch(/^rejected: /)
    expect(elapsed).toBeLessThan(5_000)
    const why = await Promise.race([probeClosed, sleep(1_000).then(() => new Error('probe still open'))])
    expect(why instanceof Error ? why.message : String(why)).toBe('Authorization Violation')
    expect(raw.closedAt, 'the server did not drop the socket').toBeDefined()
    expect(raw.closedAt! - t0).toBeLessThan(5_000)
    raw.end()
    expect(await connectRefused({ authenticator: nkeyAuthenticator(seed), inboxPrefix: `_INBOX_finance_${C}` })).toContain('Authorization Violation')
  })
})

describe.runIf(MODE === 'auth')('SYS is reload-only', () => {
  async function sys() {
    const c = await open(sysReloadConnectOptions(loc))
    conns.push(c)
    const ping = await c.nc.request('$SYS.REQ.SERVER.PING', '', { timeout: 3_000 })
    return { c, id: (ping.json() as { server: { id: string } }).server.id }
  }
  for (const [label, subj] of [
    ['$SYS.REQ.ACCOUNT.T_ta.CONNZ', () => '$SYS.REQ.ACCOUNT.T_ta.CONNZ'],
    ['$SYS.REQ.SERVER.<id>.CONNZ', (id: string) => `$SYS.REQ.SERVER.${id}.CONNZ`],
    ['$SYS.REQ.SERVER.<id>.KICK', (id: string) => `$SYS.REQ.SERVER.${id}.KICK`],
  ] as const) {
    test(`SYS the reload user on ${label}: Permissions Violation`, async () => {
      const { c, id } = await sys()
      const subject = subj(id)
      expect(await refused(c, {
        control: async () => c.nc.request('$SYS.REQ.SERVER.PING', '', { timeout: 3_000 }),
        forbidden: async () => c.nc.request(subject, '{}', { timeout: 3_000 }),
        text: `Permissions Violation for Publish to "${subject}"`,
      })).toContain('Permissions Violation')
    })
  }
})

describe.runIf(MODE === 'auth')('reload (TRD-440)', () => {
  test('a new account works without a restart: same container, no restart', async () => {
    const before = containerState()
    await ensure('te', ['content'])
    const c = await as('te', 'admin')
    const info = await (await jetstreamManager(c.nc)).getAccountInfo()
    expect(info.streams).toBeGreaterThanOrEqual(1)
    // the per-tenant JetStream ceilings are in force on the server
    expect(info.limits).toMatchObject({ max_streams: 8, max_consumers: 64, max_storage: 512_000_000, max_memory: 8_000_000 })
    const after = containerState()
    expect(after).toEqual(before)
    expect(CONTAINER).toMatch(/^t024-/)
  })
})

// RESIDUAL R1 (security review, reported to the orchestrator, NOT fixed in
// this unit): NATS checks publish permission on a message's SUBJECT only,
// never on its reply subject. Any JetStream API request a module may send
// ($JS.API.INFO at least) with a reply subject inside another module's
// stream makes the server's own response land in that stream. Tenant
// isolation holds (accounts); within a tenant only a structural change --
// one account per (tenant, stream owner) with exports/imports -- closes it.
// This characterises the gap so its fix flips the test; the injected message
// carries no Nats-Msg-Id, which is what a consumer-side check can reject.
describe.runIf(MODE === 'auth')('R1 residual: reply-subject injection within a tenant', () => {
  test('R1 finance of tb writes a JetStream API response into tb NEWSLETTER via a reply subject; it carries no Nats-Msg-Id', async () => {
    const admin = await as(B, 'admin')
    const jsm = await jetstreamManager(admin.nc)
    const before = (await jsm.streams.info('NEWSLETTER')).state.messages
    const fin = await as(B, 'finance')
    expect(await refused(fin, {
      control: async () => (await jetstreamManager(fin.nc)).streams.info('ORGUNIT'),
      forbidden: async () => fin.nc.publish(`gremion.${B}.newsletter.r1-direct`, '{}'),
      text: `Permissions Violation for Publish to "gremion.${B}.newsletter.r1-direct"`,
    })).toContain('Permissions Violation')
    fin.nc.publish('$JS.API.INFO', '', { reply: `gremion.${B}.newsletter.r1` })
    await fin.nc.flush()
    await sleep(300)
    expect((await jsm.streams.info('NEWSLETTER')).state.messages, 'the reply-subject gap is closed -- remove residual R1').toBe(before + 1)
    const m = await jsm.streams.getMessage('NEWSLETTER', { last_by_subj: `gremion.${B}.newsletter.r1` })
    expect(m, 'the injected message is not in the stream').not.toBeNull()
    expect(m!.header?.get('Nats-Msg-Id') ?? '').toBe('')
  })
})
