// Live group `deadletter`: TDD 12 (a crash on the last delivery: the broker advisory lands in the DLQ
// and the stalled gauge fires; replay by stream_seq) and TDD 13 (the written runbook, command by
// command, against the scratch stack: replay after the fix, requeue). Identity `finance` consumes ORGUNIT.
import { execFileSync } from 'node:child_process'
import { headers as natsHeaders } from '@nats-io/nats-core'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createConsumer, type ConsumerHandle } from '../../src/consumer.ts'
import { bodyOf, H, headersOf, type OutboxRow } from '../../src/envelope.ts'
import { collectMetrics } from '../../src/metrics.ts'
import { listDeadLetters, replayDeadLetter } from '../../src/recovery.ts'
import { createRelay } from '../../src/relay.ts'
import { binOf, extractCommands, fill } from '../runbook-lib.ts'
import {
  asAdmin,
  asModule,
  cliEnv,
  closeAll,
  countingPublisher,
  createOrgUnit,
  ensureTenant,
  IDT_DOMAIN,
  managerOf,
  newService,
  newTenantIds,
  projectionDomain,
  projector,
  rows,
  runCli,
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
const CREATED = () => subjectsFor(T.slug)['de.gremion.idt.orgunit.created.v1']!
const failing = new Set<string>()
const calls = new Map<string, number>()
let crashOnLast = false
const effect = projector('fin')

async function startConsumer(name: string, extra: Partial<Parameters<typeof createConsumer>[0]> = {}): Promise<ConsumerHandle> {
  for (const old of consumers.splice(0)) await old.stop().catch(() => undefined)
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
    maxDeliver: 2,
    backoffMs: [300, 300],
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
  (await rows<{ processing_state: string; attempt_count: number }>(fin, 'SELECT processing_state, attempt_count FROM fin.inbox WHERE event_id = $1', [eventId]))[0]
const projection = async (id: string) => (await rows<{ applied: number; version: string }>(fin, 'SELECT applied, version FROM fin.org_unit_projection WHERE org_unit_id = $1', [id]))[0]
const relayAll = () => createRelay({ sql: idt.sql, ctx: 'idt', js: kernel.js, subjects: subjectsFor(T.slug), onError: () => {}, log: () => {} }).runOnce()
const lastStreamSeq = async () => (await admin.jsm.streams.getMessage('ORGUNIT', { last_by_subj: CREATED() }))!.seq
const gauges = () => collectMetrics(fin.sql, { ctx: 'fin', consumer: 'finance', stalledAfterMs: 500 })

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

describe('TDD 12 a crash on the last delivery (TRD-420 backstop)', () => {
  let eventId: string
  let aggregate: string
  let streamSeq: number

  test('the broker advisory lands in the DLQ stream and the stalled gauge reads 1', async () => {
    crashOnLast = true
    await startConsumer('crashy', {
      hooks: {
        beforeDeadLetter: () => {
          if (crashOnLast) throw new Error('simulated crash on the last delivery')
        },
      },
    })
    aggregate = uuidv7()
    eventId = await createOrgUnit(idt, { id: aggregate, name: 'crash-on-last' })
    failing.add(eventId)
    await relayAll()
    streamSeq = await lastStreamSeq()
    const advisory = await waitFor('the MAX_DELIVERIES advisory in the DLQ stream', async () => (await listDeadLetters(admin.jsm)).find((e) => e.kind === 'advisory' && e.consumer === 'crashy' && e.streamSeq === streamSeq), 30_000)
    expect(advisory.stream).toBe('ORGUNIT')
    expect(advisory.subject).toContain('$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.ORGUNIT.crashy')
    // No consumer-published dead letter exists: the consumer died before it, and the row is not dead_lettered.
    expect((await listDeadLetters(admin.jsm)).filter((e) => e.kind === 'consumer' && e.eventId === eventId)).toHaveLength(0)
    expect((await inbox(eventId))?.processing_state).toBe('failed')
    await waitFor('the failed row to age past the horizon', async () => (await gauges()).inboxStalled >= 1, 10_000, 200)
    expect((await gauges()).inboxStalled).toBe(1)
    expect((await gauges()).inboxDeadLettered).toBe(0)
  })

  test('replay of the advisory entry by stream_seq re-delivers the original: the event ends processed, the entry is deleted, every gauge is 0', async () => {
    crashOnLast = false
    failing.delete(eventId)
    const advisory = (await listDeadLetters(admin.jsm)).find((e) => e.kind === 'advisory' && e.streamSeq === streamSeq)!
    const r = await replayDeadLetter(admin.jsm, async (s) => (s === 'ORGUNIT' ? kernel.js : Promise.reject(new Error(`unexpected stream ${s}`))), { seq: advisory.seq, log: () => {} })
    expect(r.kind).toBe('advisory')
    expect(r.msgId).toBe(`${eventId}.r${advisory.seq}`)
    await waitFor('the replayed event to be processed', async () => (await inbox(eventId))?.processing_state === 'processed', 30_000)
    expect((await projection(aggregate))?.applied).toBe(1)
    expect((await listDeadLetters(admin.jsm)).filter((e) => e.seq === advisory.seq)).toHaveLength(0)
    expect(await gauges()).toMatchObject({ outboxDeadLettered: 0, inboxDeadLettered: 0, inboxStalled: 0 })
  })
})

describe('TDD 13 the written runbook, command by command', () => {
  const cmds = extractCommands()
  const find = (tool: string, verb: string) => {
    const c = cmds.find((x) => x.tool === tool && x.args[0] === verb)
    if (!c) throw new Error(`dead-letter.md has no \`${tool} ${verb}\` command`)
    return c
  }
  const run = (c: ReturnType<typeof find>, extra: Record<string, string> = {}) =>
    runCli(binOf(c.tool), fill(c.args, { slug: T.slug, customer: T.customerId, ctx: 'idt', service: 'kernel-api', ...extra }))

  test('dlq-list names the dead letter; dlq-replay after the fix ends the event processed, deletes the entry; the gauges return to 0; a second copy is a duplicate', async () => {
    await startConsumer('runbook')
    const aggregateId = uuidv7()
    const eventId = await createOrgUnit(idt, { id: aggregateId, name: 'runbook-replay' })
    failing.add(eventId)
    await relayAll()
    await waitFor('the event to be dead_lettered', async () => (await inbox(eventId))?.processing_state === 'dead_lettered', 30_000)
    expect((await gauges()).inboxDeadLettered).toBe(1)

    // Step 1 of the runbook, as written.
    const listed = run(find('events', 'dlq-list'))
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { seq: number; kind: string; eventId?: string; error?: string })
    const entry = listed.find((e) => e.eventId === eventId)
    expect(entry, `dlq-list output: ${JSON.stringify(listed)}`).toBeTruthy()
    expect(entry!.kind).toBe('consumer')
    expect(entry!.error).toBe('poison')

    // The cause is fixed; step 2, as written.
    failing.delete(eventId)
    const out = run(find('events', 'dlq-replay'), { n: String(entry!.seq) })
    expect(out).toContain('skipped_stale')
    await waitFor('the replayed event to end processed (a dead_lettered inbox row must be re-claimable)', async () => (await inbox(eventId))?.processing_state === 'processed', 30_000)
    expect((await projection(aggregateId))?.applied).toBe(1)
    expect((await listDeadLetters(admin.jsm)).filter((e) => e.eventId === eventId)).toHaveLength(0)
    expect(await gauges()).toMatchObject({ outboxDeadLettered: 0, inboxDeadLettered: 0, inboxStalled: 0 })

    // Re-publishing the original id: the inbox says duplicate; nothing is applied twice.
    const row: OutboxRow = {
      event_id: eventId,
      customer_id: T.customerId,
      event_type: 'de.gremion.idt.orgunit.created.v1',
      source: '/gremion/idt',
      subject: null,
      event_time: new Date(),
      data: { orgUnitId: aggregateId, name: 'runbook-replay', aggregate_version: 1 },
      traceparent: null,
      aggregate_type: 'orgunit',
      aggregate_id: aggregateId,
      aggregate_version: '1',
      test_run_id: null,
    }
    const h = natsHeaders()
    for (const [k, v] of Object.entries({ ...headersOf(row), [H.msgId]: `again-${eventId}` })) h.set(k, v)
    await kernel.js.publish(CREATED(), JSON.stringify(bodyOf(row)), { headers: h, msgID: `again-${eventId}` })
    await new Promise((r) => setTimeout(r, 1_500))
    expect((await projection(aggregateId))?.applied).toBe(1)
    expect(Number((await rows<{ n: string }>(fin, 'SELECT count(*) AS n FROM fin.inbox WHERE event_id = $1', [eventId]))[0]!.n)).toBe(1)
  })

  test('outbox-requeue (as written) moves a relay-dead-lettered row back to pending, the relay publishes it, the gauge returns to 0', async () => {
    const eventId = await createOrgUnit(idt, { id: uuidv7(), name: 'runbook-requeue' })
    await rows(idt, "UPDATE idt.outbox SET next_attempt_at = now() + interval '1 day' WHERE relay_state = 'pending' AND event_id <> $1", [eventId])
    const dead = createRelay({ sql: idt.sql, ctx: 'idt', js: countingPublisher(kernel.js, () => true).publisher, subjects: subjectsFor(T.slug), maxAttempts: 1, onError: () => {}, log: () => {} })
    await dead.runOnce()
    const state = async () => (await rows<{ relay_state: string }>(idt, 'SELECT relay_state FROM idt.outbox WHERE event_id = $1', [eventId]))[0]!.relay_state
    expect(await state()).toBe('dead_lettered')
    expect((await collectMetrics(idt.sql, { ctx: 'idt' })).outboxDeadLettered).toBe(1)

    expect(run(find('events', 'outbox-requeue'), { 'event-id': eventId })).toContain(`requeued ${eventId}`)
    expect(await state()).toBe('pending')
    await rows(idt, "UPDATE idt.outbox SET next_attempt_at = now() WHERE relay_state = 'pending'")
    await relayAll()
    expect(await state()).toBe('published')
    expect((await collectMetrics(idt.sql, { ctx: 'idt' })).outboxDeadLettered).toBe(0)
  })

  test('a replay of an entry that does not exist fails loudly (exit 1) and says what to do', () => {
    let failure = ''
    try {
      run(find('events', 'dlq-replay'), { n: '999999' })
    } catch (e) {
      failure = String((e as { stderr?: unknown }).stderr ?? e)
    }
    expect(failure).toContain('does not exist')
    expect(failure).toContain('outbox-replay')
  })

  test('the CLI runs in a child process with only the documented environment (no seed or password in its output)', () => {
    const out = execFileSync(process.execPath, [binOf('events'), 'dlq-list', '--tenant', T.slug], { env: cliEnv(), encoding: 'utf8', timeout: 60_000 })
    expect(out).not.toMatch(/SU[A-Z2-7]{50,}/)
    expect(out).not.toContain('t079_svc')
  })
})
