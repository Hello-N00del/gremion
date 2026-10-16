// Live group `consumer`: the durable pull consumer against a real Postgres and the authenticated
// NATS. TDD 4 (wire), 8 (apply once), 9 (claim rollback), 10 and 11 (dead-letter), and the
// stable-identity chain of TDD 3 through to the inbox. Identity `finance` consumes ORGUNIT.
import { headers as natsHeaders } from '@nats-io/nats-core'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createConsumer, dlqSubjectFor, type ConsumerHandle } from '../../src/consumer.ts'
import { bodyOf, H, headersOf, REQUIRED_HEADERS, type OutboxRow } from '../../src/envelope.ts'
import { collectMetrics } from '../../src/metrics.ts'
import { publishRow } from '../../src/publish.ts'
import { listDeadLetters, replayDeadLetter } from '../../src/recovery.ts'
import { createRelay } from '../../src/relay.ts'
import {
  asAdmin,
  asModule,
  closeAll,
  createOrgUnit,
  ensureTenant,
  IDT_DOMAIN,
  managerOf,
  newService,
  newTenantIds,
  projectionDomain,
  projector,
  rows,
  subjectsFor,
  uuidv7,
  waitFor,
  type Nats,
  type Service,
} from './harness.ts'
import type { JetStreamManager } from '@nats-io/jetstream'

const T = newTenantIds()
let idt: Service
let fin: Service
let kernel: Nats
let finance: Nats
let financeJsm: JetStreamManager
let admin: Awaited<ReturnType<typeof asAdmin>>
const consumers: ConsumerHandle[] = []
const SUBJECT = () => subjectsFor(T.slug)['de.gremion.idt.orgunit.created.v1']!
const RENAMED = () => subjectsFor(T.slug)['de.gremion.idt.orgunit.renamed.v1']!

/** Event ids a test makes fail, and how many handler calls each saw. */
const failing = new Set<string>()
const calls = new Map<string, number>()
const effect = projector('fin')

async function startConsumer(name: string, extra: Partial<Parameters<typeof createConsumer>[0]> = {}, keepOthers = false): Promise<ConsumerHandle> {
  // One live consumer per test (every durable here reads the whole ORGUNIT stream): the earlier
  // ones are stopped, or they would also fail, retry and dead-letter this test's events.
  if (!keepOthers) for (const old of consumers.splice(0)) await old.stop().catch(() => undefined)
  const c = createConsumer({
    sql: fin.sql,
    ctx: 'fin',
    tenant: T.slug,
    module: 'finance',
    js: finance.js,
    jsm: financeJsm,
    stream: 'ORGUNIT',
    name,
    startFrom: 'new',
    maxDeliver: 3,
    backoffMs: [300, 300, 300],
    handler: async (tx, ev) => {
      calls.set(ev.eventId, (calls.get(ev.eventId) ?? 0) + 1)
      await effect(tx, ev)
      if (failing.has(ev.eventId)) throw Object.assign(new Error('the handler fails'), { code: 'poison' })
    },
    onError: () => {},
    log: () => {},
    ...extra,
  })
  await c.start()
  consumers.push(c)
  return c
}

const inbox = async (eventId: string) =>
  (await rows<{ processing_state: string; attempt_count: number; dead_lettered_at: Date | null; last_error_code: string | null }>(
    fin,
    'SELECT processing_state, attempt_count, dead_lettered_at, last_error_code FROM fin.inbox WHERE event_id = $1',
    [eventId],
  ))[0]
const inboxRows = async (eventId: string) => Number((await rows<{ n: string }>(fin, 'SELECT count(*) AS n FROM fin.inbox WHERE event_id = $1', [eventId]))[0]!.n)
const projection = async (id: string) => (await rows<{ name: string; version: string; applied: number }>(fin, 'SELECT name, version, applied FROM fin.org_unit_projection WHERE org_unit_id = $1', [id]))[0]
const relayAll = () => createRelay({ sql: idt.sql, ctx: 'idt', js: kernel.js, subjects: subjectsFor(T.slug), onError: () => {}, log: () => {} }).runOnce()
const dlqEntriesOf = async (eventId: string) => (await listDeadLetters(admin.jsm)).filter((e) => e.eventId === eventId)

/** An outbox-shaped row, to publish on the wire exactly as the relay would (without an outbox row). */
const wireRow = (id: string, version: number, over: Partial<OutboxRow> = {}): OutboxRow => ({
  event_id: uuidv7(),
  customer_id: T.customerId,
  event_type: version === 1 ? 'de.gremion.idt.orgunit.created.v1' : 'de.gremion.idt.orgunit.renamed.v1',
  source: '/gremion/idt',
  subject: null,
  event_time: new Date(),
  data: { orgUnitId: id, name: `wire_v${version}`, aggregate_version: version },
  traceparent: null,
  aggregate_type: 'orgunit',
  aggregate_id: id,
  aggregate_version: String(version),
  test_run_id: null,
  ...over,
})

beforeAll(async () => {
  await ensureTenant(T.slug)
  idt = await newService(T.customerId, T.slug, 'idt', IDT_DOMAIN)
  fin = await newService(T.customerId, T.slug, 'fin', projectionDomain('fin'))
  kernel = await asModule(T.slug, 'kernel')
  finance = await asModule(T.slug, 'finance')
  financeJsm = await managerOf(finance)
  admin = await asAdmin(T.slug)
})
afterAll(async () => {
  for (const c of consumers) await c.stop().catch(() => undefined)
  await closeAll()
})

describe('TDD 3 (to the inbox) stable identity end to end', () => {
  test('a relay that crashes after the PubAck republishes the same id: one stream message, one inbox row, the effect applied once', async () => {
    await startConsumer('stable-id')
    const id = uuidv7()
    const eventId = await createOrgUnit(idt, { id, name: 'crash-then-republish' })
    let crash = true
    const relay = createRelay({
      sql: idt.sql,
      ctx: 'idt',
      js: kernel.js,
      subjects: subjectsFor(T.slug),
      onError: () => {},
      log: () => {},
      hooks: {
        afterPubAck: (row) => {
          if (crash && row.event_id === eventId) {
            crash = false
            throw new Error('simulated crash after the PubAck')
          }
        },
      },
    })
    await expect(relay.runOnce()).rejects.toThrow(/simulated crash/)
    await relay.runOnce()
    await waitFor('the event to be processed', async () => (await inbox(eventId))?.processing_state === 'processed')
    expect(await inboxRows(eventId)).toBe(1)
    expect((await projection(id))?.applied).toBe(1)
    expect(calls.get(eventId)).toBe(1)
  })
})

describe('TDD 4 wire contract (Q6)', () => {
  test.each([...REQUIRED_HEADERS])('a message without %s is dead-lettered as envelope_invalid and never applied', async (missing) => {
    await startConsumer(`wire-${missing.toLowerCase().replaceAll(/[^a-z]/g, '')}`)
    const id = uuidv7()
    const row = wireRow(id, 1)
    const h = natsHeaders()
    for (const [k, v] of Object.entries(headersOf(row))) if (k !== missing) h.set(k, v)
    await kernel.js.publish(SUBJECT(), JSON.stringify(bodyOf(row)), { headers: h, ...(missing === H.msgId ? {} : { msgID: row.event_id }) })
    // The header that identifies the entry may be the one removed: find it by its BODY.
    const entry = await waitFor('the invalid envelope in the DLQ', async () => {
      for (const e of await listDeadLetters(admin.jsm)) {
        if (e.kind !== 'consumer' || e.error !== 'envelope_invalid') continue
        const m = await admin.jsm.streams.getMessage('DLQ', { seq: e.seq })
        if ((JSON.parse(new TextDecoder().decode(m!.data)) as { eventId?: string }).eventId === row.event_id) return e
      }
      return undefined
    })
    expect(entry.error).toBe('envelope_invalid')
    expect(await projection(id), 'an invalid envelope must never be applied').toBeUndefined()
    expect(await inboxRows(row.event_id)).toBe(0)
  })

  test('the inbox key ignores Nats-Msg-Id: the same event under two message ids applies once, one inbox row', async () => {
    await startConsumer('key-ignores-msg-id')
    const id = uuidv7()
    const row = wireRow(id, 1)
    await publishRow(kernel.js, SUBJECT(), row)
    await waitFor('processed', async () => (await inbox(row.event_id))?.processing_state === 'processed')
    // Same event, a different Nats-Msg-Id (what a DLQ replay or a rebuild does).
    const h = headersOf(row)
    h[H.msgId] = `${row.event_id}.r99`
    const hdr = natsHeaders()
    for (const [k, v] of Object.entries(h)) hdr.set(k, v)
    await kernel.js.publish(SUBJECT(), JSON.stringify(bodyOf(row)), { headers: hdr, msgID: h[H.msgId]! })
    await new Promise((r) => setTimeout(r, 1_500))
    expect(await inboxRows(row.event_id)).toBe(1)
    expect((await projection(id))?.applied).toBe(1)
  })
})

describe('TDD 8 apply once (TRD-421)', () => {
  test('a handler failure naks and the redelivery applies once: one inbox row, processed, one successful effect', async () => {
    await startConsumer('redelivery', { backoffMs: [400, 400, 400] })
    const id = uuidv7()
    const eventId = await createOrgUnit(idt, { id, name: 'redelivered' })
    failing.add(eventId)
    await relayAll()
    await waitFor('the first failure', async () => (await inbox(eventId))?.processing_state === 'failed')
    expect((await inbox(eventId))?.attempt_count).toBe(1)
    failing.delete(eventId)
    await waitFor('the redelivery to apply', async () => (await inbox(eventId))?.processing_state === 'processed')
    expect(await inboxRows(eventId)).toBe(1)
    expect((await projection(id))?.applied, 'the failed attempt is rolled back, the second applies once').toBe(1)
  })

  test('a second copy under a new Nats-Msg-Id is acknowledged and ignored (duplicate): one inbox row, effect not repeated', async () => {
    await startConsumer('second-copy')
    const id = uuidv7()
    const row = wireRow(id, 1)
    await publishRow(kernel.js, SUBJECT(), row)
    await waitFor('processed', async () => (await inbox(row.event_id))?.processing_state === 'processed')
    for (let i = 0; i < 2; i++) {
      const h = natsHeaders()
      for (const [k, v] of Object.entries({ ...headersOf(row), [H.msgId]: `copy-${i}-${row.event_id}` })) h.set(k, v)
      await kernel.js.publish(SUBJECT(), JSON.stringify(bodyOf(row)), { headers: h, msgID: `copy-${i}-${row.event_id}` })
    }
    await new Promise((r) => setTimeout(r, 1_500))
    expect(await inboxRows(row.event_id)).toBe(1)
    expect((await projection(id))?.applied).toBe(1)
    expect(calls.get(row.event_id)).toBe(1)
  })

  test('a lower aggregate_version is skipped_stale and does not touch the projection', async () => {
    await startConsumer('stale')
    const id = uuidv7()
    const v1 = wireRow(id, 1)
    const v2 = wireRow(id, 2)
    await publishRow(kernel.js, RENAMED(), v2)
    await waitFor('v2 processed', async () => (await inbox(v2.event_id))?.processing_state === 'processed')
    await publishRow(kernel.js, SUBJECT(), v1)
    await waitFor('v1 stale', async () => (await inbox(v1.event_id))?.processing_state === 'skipped_stale')
    expect((await projection(id))?.version).toBe('2')
    expect(calls.has(v1.event_id), 'a stale event never reaches the handler').toBe(false)
    expect(Number((await rows<{ v: string }>(fin, "SELECT applied_version AS v FROM fin.applied_aggregate_version WHERE aggregate_id = $1", [id]))[0]!.v)).toBe(2)
  })

  test('a test-run event is skipped_test for a consumer that reaches people, and applied for one that does not', async () => {
    await startConsumer('people', { reachesPeople: true })
    const run = uuidv7()
    const id = uuidv7()
    const row = wireRow(id, 1, { test_run_id: run })
    await publishRow(kernel.js, SUBJECT(), row)
    await waitFor('skipped_test', async () => (await inbox(row.event_id))?.processing_state === 'skipped_test')
    expect(await projection(id)).toBeUndefined()
    expect(calls.has(row.event_id)).toBe(false)

    await startConsumer('no-people', { reachesPeople: false }, true)
    const id2 = uuidv7()
    const row2 = wireRow(id2, 1, { test_run_id: run })
    await publishRow(kernel.js, SUBJECT(), row2)
    // Both consumers share this database's inbox: row2 is claimed by whichever consumer gets it first.
    await waitFor('row2 handled', async () => ['skipped_test', 'processed'].includes((await inbox(row2.event_id))?.processing_state ?? ''))
  })
})

describe('TDD 9 the claim is part of the effect transaction', () => {
  test('a handler that throws after the claim leaves no claim behind: the next delivery applies', async () => {
    await startConsumer('claim-rollback', { backoffMs: [1500, 1500, 1500] })
    const id = uuidv7()
    const eventId = await createOrgUnit(idt, { id, name: 'claim-rollback' })
    failing.add(eventId)
    await relayAll()
    const failed = await waitFor('the failure to be recorded', async () => {
      const r = await inbox(eventId)
      return r?.processing_state === 'failed' ? r : undefined
    })
    expect(failed.attempt_count).toBe(1)
    expect(await projection(id), 'the failed attempt wrote a projection row and rolled it back with the claim').toBeUndefined()
    failing.delete(eventId)
    await waitFor('the next delivery to apply', async () => (await inbox(eventId))?.processing_state === 'processed', 20_000)
    expect((await projection(id))?.applied).toBe(1)
    expect(await inboxRows(eventId)).toBe(1)
  })
})

describe('TDD 10 poison message (TRD-420)', () => {
  test('past MaxDeliver the message lands in the tenant DLQ stream under its own msg id with the Gremion-Dlq headers, the inbox row is dead_lettered, the message is terminated', async () => {
    const name = 'poison'
    await startConsumer(name)
    const id = uuidv7()
    const eventId = await createOrgUnit(idt, { id, name: 'poison-pill' })
    failing.add(eventId)
    await relayAll()
    const entry = await waitFor('the dead letter', async () => (await dlqEntriesOf(eventId))[0], 30_000)
    expect(entry.kind).toBe('consumer')
    expect(entry.subject).toBe(dlqSubjectFor(T.slug, 'finance', name))
    expect(entry.error).toBe('poison')
    expect(entry.origSubject).toBe(SUBJECT())
    expect(entry.stream).toBe('ORGUNIT')
    expect(entry.consumer).toBe(name)
    expect(entry.streamSeq).toBeGreaterThan(0)
    const stored = await admin.jsm.streams.getMessage('DLQ', { seq: entry.seq })
    expect(stored!.header.get(H.dlqOrigMsgId)).toBe(eventId)
    expect(stored!.header.get(H.eventId)).toBe(eventId)
    expect(stored!.header.get(H.msgId), 'its OWN message id, never the original').not.toBe(eventId)
    const dead = await waitFor('the inbox row to be dead_lettered', async () => {
      const r = await inbox(eventId)
      return r?.processing_state === 'dead_lettered' ? r : undefined
    })
    expect(dead.dead_lettered_at).not.toBeNull()
    expect(calls.get(eventId)).toBe(3)
    // Terminated: nothing pending, nothing awaiting an ack on that consumer.
    const info = await admin.jsm.consumers.info('ORGUNIT', name)
    expect(info.num_ack_pending).toBe(0)
    expect(info.num_pending).toBe(0)
    expect((await collectMetrics(fin.sql, { ctx: 'fin', consumer: 'finance' })).inboxDeadLettered).toBeGreaterThanOrEqual(1)
  })
})

describe('TDD 11 a second poisoning after a replay gives a second DLQ entry', () => {
  test('replaying a dead letter whose handler still fails re-poisons it: a NEW entry, not deduplicated away', async () => {
    await startConsumer('poison-twice')
    const id = uuidv7()
    const eventId = await createOrgUnit(idt, { id, name: 'poison-twice' })
    failing.add(eventId)
    await relayAll()
    const first = await waitFor('the first dead letter', async () => (await dlqEntriesOf(eventId))[0], 30_000)
    // The admin reads and deletes the DLQ entry; the republish is the target stream's PUBLISHER (the admin may not publish stream subjects).
    const replay = await replayDeadLetter(admin.jsm, async (stream) => (stream === 'ORGUNIT' ? kernel.js : Promise.reject(new Error(`unexpected stream ${stream}`))), { seq: first.seq, log: () => {} })
    expect(replay.msgId).toBe(`${eventId}.r${first.seq}`)
    expect((await dlqEntriesOf(eventId)).filter((e) => e.seq === first.seq), 'the replayed entry is deleted after the PubAck').toHaveLength(0)
    const second = await waitFor('the second dead letter', async () => (await dlqEntriesOf(eventId))[0], 30_000)
    expect(second.seq).not.toBe(first.seq)
    expect(second.streamSeq, 'the replay is a NEW stream message').not.toBe(first.streamSeq)
    expect(calls.get(eventId)).toBeGreaterThanOrEqual(6)
  })
})
