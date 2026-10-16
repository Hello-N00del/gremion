// Live group `core`: the producer and the relay against a real Postgres 18 (non-superuser service
// role, FORCE ROW LEVEL SECURITY) and the kernel's authenticated NATS. TDD 1, 2 (live half), 3, 5, 6, 7, 16, 17.
// The F1 flow: identity `kernel` publishes into ORGUNIT; identity `finance` consumes it (nats-auth FLOWS).
import { connect } from '@nats-io/transport-node'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { inTenantTx } from '../../src/db.ts'
import { enqueue } from '../../src/enqueue.ts'
import { H } from '../../src/envelope.ts'
import { collectMetrics } from '../../src/metrics.ts'
import { createRelay } from '../../src/relay.ts'
import { requeueOutbox } from '../../src/recovery.ts'
import {
  asAdmin,
  asModule,
  closeAll,
  count,
  countingPublisher,
  createOrgUnit,
  ensureTenant,
  IDT_DOMAIN,
  NATS_URL,
  newService,
  newTenantIds,
  projectionDomain,
  psql,
  renameOrgUnit,
  rows,
  subjectsFor,
  uuidv7,
  waitFor,
  type Nats,
  type Service,
} from './harness.ts'

const T = newTenantIds()
let idt: Service
let kernel: Nats
let admin: Awaited<ReturnType<typeof asAdmin>>

const relayOf = (publisher: Pick<Nats['js'], 'publish'> | (() => Promise<Pick<Nats['js'], 'publish'>>), extra: Partial<Parameters<typeof createRelay>[0]> = {}) =>
  createRelay({ sql: idt.sql, ctx: 'idt', js: publisher, subjects: subjectsFor(T.slug), onError: () => {}, log: () => {}, ...extra })

const outboxState = async (eventId: string) => (await rows<{ relay_state: string; attempt_count: number }>(idt, 'SELECT relay_state, attempt_count FROM idt.outbox WHERE event_id = $1', [eventId]))[0]
/** Forces every pending row due now (the test's stand-in for waiting out the backoff). */
const makeDue = () => rows(idt, "UPDATE idt.outbox SET next_attempt_at = now() WHERE relay_state = 'pending'")
const streamMessages = async (filter: string) => (await admin.jsm.streams.info('ORGUNIT', { subjects_filter: filter })).state.subjects?.[filter] ?? 0

beforeAll(async () => {
  await ensureTenant(T.slug)
  idt = await newService(T.customerId, T.slug, 'idt', IDT_DOMAIN)
  // The consumer-side database exists so the F1 flow is complete; its tests are in consumer.live.test.ts.
  await newService(T.customerId, T.slug, 'fin', projectionDomain('fin'))
  kernel = await asModule(T.slug, 'kernel')
  admin = await asAdmin(T.slug)
})
afterAll(closeAll)

describe('TDD 1 co-commit (TRD-422)', () => {
  test('a domain transaction that throws after enqueue leaves no outbox row; a committed one leaves exactly one', async () => {
    const id = uuidv7()
    await expect(
      inTenantTx(idt.sql, 'idt', async (tx) => {
        await tx.unsafe('INSERT INTO idt.org_unit (org_unit_id, customer_id, name) VALUES ($1, idt.current_customer_id(), $2)', [id, 'doomed'])
        await enqueue(tx, { eventType: 'de.gremion.idt.orgunit.created.v1', source: '/gremion/idt', aggregate: { type: 'orgunit', id, version: 1 }, data: { orgUnitId: id } })
        throw new Error('the domain transaction fails after enqueue')
      }),
    ).rejects.toThrow(/fails after enqueue/)
    expect(await count(idt, 'outbox', 'aggregate_id = $1', [id])).toBe(0)
    expect(await count(idt, 'org_unit', 'org_unit_id = $1', [id])).toBe(0)

    const eventId = await createOrgUnit(idt, { id, name: 'kept' })
    expect(await count(idt, 'outbox', 'aggregate_id = $1', [id])).toBe(1)
    expect(await count(idt, 'org_unit', 'org_unit_id = $1', [id])).toBe(1)
    expect(eventId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/)
  })

  test('enqueue refuses a non-transaction handle (a pool would auto-commit the event apart from the state change)', async () => {
    const id = uuidv7()
    await expect(
      enqueue(idt.sql, { eventType: 'de.gremion.idt.orgunit.created.v1', source: '/gremion/idt', aggregate: { type: 'orgunit', id, version: 1 }, data: {} }),
    ).rejects.toThrow(/open transaction/)
    expect(await count(idt, 'outbox', 'aggregate_id = $1', [id])).toBe(0)
  })
})

describe('TDD 2 plumbing against a real database (TASK-075 lint, TASK-020 runner)', () => {
  test('the plumbing migrated through the runner as a NOSUPERUSER owner: ledger row, tables, binding', async () => {
    const [role] = await idt.sql.unsafe<{ rolsuper: boolean }[]>('SELECT rolsuper FROM pg_roles WHERE rolname = current_user')
    expect(role!.rolsuper, 'FORCE ROW LEVEL SECURITY does not apply to a superuser: the proof must not run as one').toBe(false)
    const tables = await idt.sql.unsafe<{ table_name: string }[]>("SELECT table_name FROM information_schema.tables WHERE table_schema = 'idt' ORDER BY 1")
    expect(tables.map((t) => t.table_name)).toEqual(expect.arrayContaining(['applied_aggregate_version', 'database_binding', 'inbox', 'job', 'outbox']))
    const ledger = await idt.sql.unsafe<{ filename: string; phase: string }[]>('SELECT filename, phase FROM public.schema_migrations')
    expect(ledger).toEqual([{ filename: '0001_init.sql', phase: 'expand' }])
    const [b] = await idt.sql.unsafe<{ context_code: string; tenant_token: string }[]>('SELECT context_code, tenant_token FROM idt.database_binding')
    expect(b).toEqual({ context_code: 'idt', tenant_token: T.slug })
  })

  test('a whitespace payload fails with 23514 outbox_data_no_prose_check', async () => {
    const id = uuidv7()
    const err = await inTenantTx(idt.sql, 'idt', (tx) =>
      enqueue(tx, { eventType: 'de.gremion.idt.orgunit.created.v1', source: '/gremion/idt', aggregate: { type: 'orgunit', id, version: 1 }, data: { name: 'free personal text' } }),
    ).catch((e: unknown) => e as { code?: string; constraint_name?: string })
    expect((err as { code?: string }).code).toBe('23514')
    expect((err as { constraint_name?: string }).constraint_name).toBe('outbox_data_no_prose_check')
  })

  test('without gremion.customer_id the relay sees 0 rows, though rows exist (FORCE ROW LEVEL SECURITY)', async () => {
    await createOrgUnit(idt, { id: uuidv7(), name: 'rls-probe' })
    expect(await count(idt, 'outbox')).toBeGreaterThan(0)
    const bare = await idt.sql.unsafe<{ n: string }[]>('SELECT count(*) AS n FROM idt.outbox')
    expect(Number(bare[0]!.n)).toBe(0)
  })

  test('a row of another customer is invisible and unwritable in this customer context', async () => {
    const other = uuidv7()
    const err = await inTenantTx(idt.sql, 'idt', (tx) =>
      tx.unsafe(
        `INSERT INTO idt.outbox (customer_id, tenantid, event_type, source, data, aggregate_type, aggregate_id, aggregate_version)
         VALUES ($1::uuid, $3::text, 'de.gremion.idt.orgunit.created.v1', '/gremion/idt', '{"aggregate_version":1}', 'orgunit', $2::uuid, 1)`,
        [other, uuidv7(), other],
      ),
    ).catch((e: unknown) => e as { code?: string })
    expect((err as { code?: string }).code, 'row-level security WITH CHECK').toBe('42501')
  })
})

describe('TDD 3 stable identity: a crash between the PubAck and the published mark republishes the same id', () => {
  test('one stream message under that id, and its four ids are one (outbox = body = Gremion-Event-Id = Nats-Msg-Id)', async () => {
    await rows(idt, "UPDATE idt.outbox SET relay_state = 'published', published_at = now(), dead_lettered_at = NULL WHERE relay_state IN ('pending', 'dead_lettered')")
    const aggregate = uuidv7()
    const eventId = await createOrgUnit(idt, { id: aggregate, name: 'crashy' })
    const subject = subjectsFor(T.slug)['de.gremion.idt.orgunit.created.v1']!
    const before = await streamMessages(subject)
    let crash = true
    const { calls, publisher } = countingPublisher(kernel.js)
    const relay = relayOf(publisher, {
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
    expect((await outboxState(eventId))?.relay_state, 'the crash rolled the mark back').toBe('pending')
    await relay.runOnce()
    expect((await outboxState(eventId))?.relay_state).toBe('published')

    const mine = calls.filter((c) => c.msgId === eventId)
    expect(mine.map((c) => c.msgId)).toEqual([eventId, eventId])
    expect(mine[1]!.duplicate, 'the broker saw the same Nats-Msg-Id twice and deduplicated').toBe(true)
    expect(await streamMessages(subject)).toBe(before + 1)

    const stored = await admin.jsm.streams.getMessage('ORGUNIT', { last_by_subj: subject })
    expect(stored!.header.get(H.msgId)).toBe(eventId)
    expect(stored!.header.get(H.eventId)).toBe(eventId)
    expect((JSON.parse(new TextDecoder().decode(stored!.data)) as { eventId: string }).eventId).toBe(eventId)
  })
})

describe('TDD 5 relay limit', () => {
  test('past the attempt limit the row is dead_lettered, the state/times CHECK holds, the gauge reads 1; requeue publishes it and the gauge returns to 0', async () => {
    const eventId = await createOrgUnit(idt, { id: uuidv7(), name: 'limit' })
    await rows(idt, "UPDATE idt.outbox SET next_attempt_at = now() + interval '1 day' WHERE relay_state = 'pending' AND event_id <> $1", [eventId])
    const dead = relayOf(countingPublisher(kernel.js, () => true).publisher, { maxAttempts: 3 })
    for (let i = 0; i < 3; i++) {
      await makeDue()
      await rows(idt, "UPDATE idt.outbox SET next_attempt_at = now() + interval '1 day' WHERE event_id <> $1 AND relay_state = 'pending'", [eventId])
      await dead.runOnce()
    }
    const row = (await rows<{ relay_state: string; attempt_count: number; published_at: Date | null; dead_lettered_at: Date | null; last_error_code: string | null }>(
      idt,
      'SELECT relay_state, attempt_count, published_at, dead_lettered_at, last_error_code FROM idt.outbox WHERE event_id = $1',
      [eventId],
    ))[0]!
    expect(row.relay_state).toBe('dead_lettered')
    expect(row.attempt_count).toBe(3)
    expect(row.published_at).toBeNull()
    expect(row.dead_lettered_at).not.toBeNull()
    expect(row.last_error_code).toBeTruthy()
    expect((await collectMetrics(idt.sql, { ctx: 'idt' })).outboxDeadLettered).toBe(1)
    // A dead_lettered row is not retried by the relay.
    expect((await dead.runOnce()).published).toBe(0)

    await requeueOutbox(idt.sql, { ctx: 'idt', eventId })
    expect((await outboxState(eventId))).toEqual({ relay_state: 'pending', attempt_count: 0 })
    await makeDue()
    await relayOf(kernel.js).runOnce()
    expect((await outboxState(eventId))?.relay_state).toBe('published')
    expect((await collectMetrics(idt.sql, { ctx: 'idt' })).outboxDeadLettered).toBe(0)
    await expect(requeueOutbox(idt.sql, { ctx: 'idt', eventId })).rejects.toThrow(/no dead_lettered outbox row/)
  })
})

describe('TDD 6 one relay pass per database', () => {
  test('a pass that finds the advisory lock taken does nothing; released, it publishes', async () => {
    const eventId = await createOrgUnit(idt, { id: uuidv7(), name: 'locked' })
    await makeDue()
    const { calls, publisher } = countingPublisher(kernel.js)
    const relay = relayOf(publisher)
    const { ADVISORY_LOCKS } = await import('@gremion/tenant-store')
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    let acquired!: () => void
    const got = new Promise<void>((r) => (acquired = r))
    const holder = inTenantTx(idt.sql, 'idt', async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(${ADVISORY_LOCKS.outboxRelay.classid}::int, ${ADVISORY_LOCKS.outboxRelay.objid}::int)`
      acquired()
      await held
    })
    await got
    const blocked = await relay.runOnce()
    expect(blocked).toEqual({ locked: false, published: 0, failed: 0, deadLettered: 0 })
    expect(calls).toEqual([])
    expect((await outboxState(eventId))?.relay_state).toBe('pending')
    release()
    await holder
    expect((await relay.runOnce()).published).toBeGreaterThanOrEqual(1)
    expect((await outboxState(eventId))?.relay_state).toBe('published')
  })

  test('two relays at once publish every row exactly once', async () => {
    await rows(idt, "UPDATE idt.outbox SET relay_state = 'published', published_at = now(), dead_lettered_at = NULL WHERE relay_state = 'pending'")
    const ids: string[] = []
    for (let i = 0; i < 12; i++) ids.push(await createOrgUnit(idt, { id: uuidv7(), name: `two-relays-${i}` }))
    const a = countingPublisher(kernel.js)
    const b = countingPublisher(kernel.js)
    const [ra, rb] = await Promise.all([relayOf(a.publisher, { batchSize: 4 }).runOnce(), relayOf(b.publisher, { batchSize: 4 }).runOnce()])
    expect(ra.locked || rb.locked).toBe(true)
    for (let i = 0; i < 6; i++) await relayOf(a.publisher, { batchSize: 4 }).runOnce()
    const published = [...a.calls, ...b.calls].filter((c) => ids.includes(c.msgId))
    for (const id of ids) expect(published.filter((c) => c.msgId === id), id).toHaveLength(1)
    for (const id of ids) expect((await outboxState(id))?.relay_state).toBe('published')
  })
})

describe('TDD 7 head-of-line: a backing-off or dead-lettered v2 holds v3 back (Q10)', () => {
  test('v2 fails and backs off, v3 is not published; v2 recovers, then v2 and v3 arrive in order', async () => {
    await rows(idt, "UPDATE idt.outbox SET relay_state = 'published', published_at = now(), dead_lettered_at = NULL WHERE relay_state = 'pending'")
    const agg = uuidv7()
    await createOrgUnit(idt, { id: agg, name: 'hol' })
    const v2 = await renameOrgUnit(idt, agg, 'hol-two')
    const v3 = await renameOrgUnit(idt, agg, 'hol-three')
    expect([v2.version, v3.version]).toEqual([2, 3])
    let failV2 = true
    const { calls, publisher } = countingPublisher(kernel.js, (c) => failV2 && c.version === 2)
    const relay = relayOf(publisher)
    for (let i = 0; i < 4; i++) await relay.runOnce()
    expect(calls.filter((c) => c.version === 1)).toHaveLength(1)
    expect(calls.filter((c) => c.version === 2 && c.failed)).toHaveLength(1)
    expect(calls.filter((c) => c.version === 3), 'v3 must never be attempted while v2 is not published').toHaveLength(0)
    expect((await outboxState(v3.eventId))?.relay_state).toBe('pending')

    failV2 = false
    await makeDue()
    for (let i = 0; i < 4; i++) await relay.runOnce()
    const order = calls.filter((c) => !c.failed).map((c) => c.version)
    expect(order).toEqual([1, 2, 3])
    expect((await outboxState(v3.eventId))?.relay_state).toBe('published')
  })

  test('a dead-lettered v2 also holds v3; requeue releases both, in order', async () => {
    await rows(idt, "UPDATE idt.outbox SET relay_state = 'published', published_at = now(), dead_lettered_at = NULL WHERE relay_state = 'pending'")
    const agg = uuidv7()
    await createOrgUnit(idt, { id: agg, name: 'hol2' })
    const v2 = await renameOrgUnit(idt, agg, 'hol2-two')
    await renameOrgUnit(idt, agg, 'hol2-three')
    let failV2 = true
    const { calls, publisher } = countingPublisher(kernel.js, (c) => failV2 && c.version === 2)
    const relay = relayOf(publisher, { maxAttempts: 2 })
    // pass 1 publishes v1, pass 2 and 3 fail v2 (maxAttempts 2): it is dead_lettered.
    for (let i = 0; i < 3; i++) {
      await relay.runOnce()
      await makeDue()
    }
    expect((await outboxState(v2.eventId))?.relay_state).toBe('dead_lettered')
    await relay.runOnce()
    expect(calls.filter((c) => c.version === 3)).toHaveLength(0)
    failV2 = false
    await requeueOutbox(idt.sql, { ctx: 'idt', eventId: v2.eventId })
    for (let i = 0; i < 4; i++) await relay.runOnce()
    expect(calls.filter((c) => !c.failed).map((c) => c.version)).toEqual([1, 2, 3])
  })
})

describe('TDD 16 trace hop (W3C Trace Context)', () => {
  test('the relay sets NATS traceparent from outbox.traceparent; a null value adds no header', async () => {
    await rows(idt, "UPDATE idt.outbox SET relay_state = 'published', published_at = now(), dead_lettered_at = NULL WHERE relay_state = 'pending'")
    const trace = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'
    const withTrace = await createOrgUnit(idt, { id: uuidv7(), name: 'traced', traceparent: trace })
    await relayOf(kernel.js).runOnce()
    const subject = subjectsFor(T.slug)['de.gremion.idt.orgunit.created.v1']!
    const traced = await admin.jsm.streams.getMessage('ORGUNIT', { last_by_subj: subject })
    expect(traced!.header.get(H.eventId)).toBe(withTrace)
    expect(traced!.header.get(H.traceparent)).toBe(trace)
    expect((JSON.parse(new TextDecoder().decode(traced!.data)) as { correlationId: string }).correlationId).toBe('0af7651916cd43dd8448eb211c80319c')

    const without = await createOrgUnit(idt, { id: uuidv7(), name: 'untraced' })
    await relayOf(kernel.js).runOnce()
    const plain = await admin.jsm.streams.getMessage('ORGUNIT', { last_by_subj: subject })
    expect(plain!.header.get(H.eventId)).toBe(without)
    expect(plain!.header.keys()).not.toContain(H.traceparent)
  })
})

describe('TDD 17 authenticated', () => {
  test('a relay without credentials leaves the rows pending and untouched', async () => {
    const eventId = await createOrgUnit(idt, { id: uuidv7(), name: 'no-credentials' })
    await makeDue()
    // The broker refuses a connection without a known nkey: nothing of the library can publish.
    const refusal = await connect({ servers: NATS_URL, reconnect: false, timeout: 3_000 }).then(
      (nc) => nc.close().then(() => 'accepted'),
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    )
    expect(refusal).toContain('Authorization Violation')
    const relay = relayOf(async () => {
      const nc = await connect({ servers: NATS_URL, reconnect: false, timeout: 3_000 })
      return (await import('@nats-io/jetstream')).jetstream(nc)
    })
    await expect(relay.runOnce()).rejects.toThrow(/authorization/i)
    expect(await outboxState(eventId)).toEqual({ relay_state: 'pending', attempt_count: 0 })
  })

  test('the identity the relay uses is the module key: only its own subjects are accepted (kernel publishes ORGUNIT, not CONTENT)', async () => {
    const eventId = await createOrgUnit(idt, { id: uuidv7(), name: 'wrong-subject' })
    await makeDue()
    const relay = relayOf(kernel.js, { subjects: { 'de.gremion.idt.orgunit.created.v1': `gremion.${T.slug}.content.created` }, maxAttempts: 5 })
    const r = await relay.runOnce()
    expect(r.failed).toBeGreaterThanOrEqual(1)
    expect((await outboxState(eventId))?.relay_state).toBe('pending')
    expect((await outboxState(eventId))?.attempt_count).toBeGreaterThanOrEqual(1)
    await waitFor('the row to be retryable', async () => (await makeDue(), true))
  })
})

describe('the harness left nothing running', () => {
  test('this group created no dangling superuser connection (psql probe)', () => {
    expect(psql("SELECT count(*) FROM pg_stat_activity WHERE usename = 't079_svc' AND state = 'idle in transaction'")).toBe('0')
  })
})
