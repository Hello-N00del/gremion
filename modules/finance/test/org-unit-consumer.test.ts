// test/org-unit-consumer.test.ts — #383 Lane E1 the first leaf-side consumer.
//
// Drives wireOrgUnitConsumer over the InMemoryBroker (the reference semantics for
// the NATS adapter) with an in-memory OrgUnitMirrorStore double that reproduces the
// SQL store's guarantees (the real Postgres store is exercised in
// org-unit-mirror.integration.test.ts). Proves the three consumer invariants:
//   1. IDEMPOTENCY  — the same eventId delivered twice applies ONCE (event_consumption).
//   2. PER-AGGREGATE ORDERING — out-of-order (stale) events are dropped by the
//      source_occurred_at guard; a delete tombstones so a stale upsert cannot resurrect.
//   3. UNKNOWN-TENANT ACK-SKIP — an event for an unknown tenant is a silent no-op.

import { describe, it, expect } from 'vitest'
import { InMemoryBroker, orgUnitSubject, type EventEnvelope } from '@gremion/ports/broker'
import {
  wireOrgUnitConsumer,
  type OrgUnitMirrorStore,
  type OrgUnitMirrorOp,
  type ApplyOutcome,
} from '../src/org-unit-consumer.ts'

const T1 = '2026-01-01T00:00:00.000Z'
const T2 = '2026-01-02T00:00:00.000Z'
const T3 = '2026-01-03T00:00:00.000Z'

/** Build an org-unit event envelope with explicit eventId + occurredAt. */
function env(
  tenantId: string,
  eventType: 'upserted' | 'deleted',
  eventId: string,
  occurredAt: string,
  payload: Record<string, unknown>,
): EventEnvelope {
  return { eventId, eventType, tenantId, occurredAt, correlationId: null, payload }
}

interface MirrorRow {
  occurredAt: string
  deleted: boolean
  name: string
  kind: string
  parentId: string | null
}

/** In-memory OrgUnitMirrorStore double: a consumed-eventId set (event_consumption)
 *  + a per-aggregate row map with the SAME `<=`-occurredAt ordering guard the SQL
 *  ON CONFLICT … WHERE clause enforces. Records every outcome for assertions. */
function memStore() {
  const consumed = new Set<string>()
  const rows = new Map<string, MirrorRow>()
  const outcomes: ApplyOutcome[] = []
  const store: OrgUnitMirrorStore = {
    async apply(op: OrgUnitMirrorOp): Promise<ApplyOutcome> {
      let outcome: ApplyOutcome
      if (consumed.has(op.eventId)) {
        outcome = 'duplicate'
      } else {
        consumed.add(op.eventId)
        const existing = rows.get(op.id)
        if (existing !== undefined && op.occurredAt <= existing.occurredAt) {
          outcome = 'stale'
        } else {
          rows.set(
            op.id,
            op.type === 'upsert'
              ? { occurredAt: op.occurredAt, deleted: false, name: op.name, kind: op.kind, parentId: op.parentId }
              : { occurredAt: op.occurredAt, deleted: true, name: '', kind: '', parentId: null },
          )
          outcome = 'applied'
        }
      }
      outcomes.push(outcome)
      return outcome
    },
  }
  return { store, rows, outcomes, consumed }
}

/** Wire a consumer that routes tenant 't1' → mem, all others → undefined (unknown). */
function harness() {
  const broker = new InMemoryBroker()
  const mem = memStore()
  const logs: string[] = []
  wireOrgUnitConsumer({
    broker,
    resolveStore: (tid) => (tid === 't1' ? mem.store : undefined),
    log: (m) => logs.push(m),
  })
  return { broker, mem, logs }
}

describe('org-unit consumer — idempotency (event_consumption)', () => {
  it('the same eventId delivered twice applies ONCE (second is a duplicate)', async () => {
    const { broker, mem } = harness()
    const e = env('t1', 'upserted', 'evt-1', T1, { id: 'ou-a', name: 'A', kind: 'council' })
    await broker.publish(orgUnitSubject('t1', 'upserted'), e)
    await broker.publish(orgUnitSubject('t1', 'upserted'), e) // redelivery, same eventId
    expect(mem.outcomes).toEqual(['applied', 'duplicate'])
    expect(mem.rows.get('ou-a')).toMatchObject({ name: 'A', kind: 'council', deleted: false })
    expect(mem.consumed.size).toBe(1)
  })
})

describe('org-unit consumer — per-aggregate ordering (source_occurred_at guard)', () => {
  it('upserts delivered t2-then-t1 end at the t2 state (stale t1 dropped)', async () => {
    const { broker, mem } = harness()
    await broker.publish(orgUnitSubject('t1', 'upserted'), env('t1', 'upserted', 'e2', T2, { id: 'ou-a', name: 'NEW', kind: 'council' }))
    await broker.publish(orgUnitSubject('t1', 'upserted'), env('t1', 'upserted', 'e1', T1, { id: 'ou-a', name: 'OLD', kind: 'committee' }))
    expect(mem.outcomes).toEqual(['applied', 'stale'])
    expect(mem.rows.get('ou-a')).toMatchObject({ name: 'NEW', kind: 'council', occurredAt: T2 })
  })

  it('a delete then a STALE upsert leaves the row tombstoned (cannot resurrect)', async () => {
    const { broker, mem } = harness()
    // delete at t3 (tombstone), then a stale upsert at t2 (< t3) — must be dropped.
    await broker.publish(orgUnitSubject('t1', 'deleted'), env('t1', 'deleted', 'ed', T3, { id: 'ou-a' }))
    await broker.publish(orgUnitSubject('t1', 'upserted'), env('t1', 'upserted', 'eu', T2, { id: 'ou-a', name: 'ZOMBIE', kind: 'council' }))
    expect(mem.outcomes).toEqual(['applied', 'stale'])
    expect(mem.rows.get('ou-a')).toMatchObject({ deleted: true })
  })

  it('a newer delete over an existing upsert tombstones it', async () => {
    const { broker, mem } = harness()
    await broker.publish(orgUnitSubject('t1', 'upserted'), env('t1', 'upserted', 'e1', T1, { id: 'ou-a', name: 'A', kind: 'council' }))
    await broker.publish(orgUnitSubject('t1', 'deleted'), env('t1', 'deleted', 'e2', T2, { id: 'ou-a' }))
    expect(mem.outcomes).toEqual(['applied', 'applied'])
    expect(mem.rows.get('ou-a')).toMatchObject({ deleted: true, occurredAt: T2 })
  })
})

describe('org-unit consumer — unknown tenant + malformed events', () => {
  it('an event for an unknown tenant is ack-skipped (no store write, no throw)', async () => {
    const { broker, mem, logs } = harness()
    await broker.publish(orgUnitSubject('t9', 'upserted'), env('t9', 'upserted', 'e1', T1, { id: 'ou-a', name: 'A', kind: 'council' }))
    expect(mem.rows.size).toBe(0)
    expect(mem.outcomes).toEqual([])
    expect(logs.some((l) => l.includes('unknown tenant'))).toBe(true)
  })

  it('a malformed event (missing id) is ack-skipped before tenant resolution', async () => {
    const { broker, mem, logs } = harness()
    await broker.publish(orgUnitSubject('t1', 'upserted'), env('t1', 'upserted', 'e1', T1, { name: 'no id' }))
    expect(mem.rows.size).toBe(0)
    expect(logs.some((l) => l.includes('malformed'))).toBe(true)
  })

  it('a known-tenant event IS applied (harness sanity — proves the skip is tenant-specific)', async () => {
    const { broker, mem } = harness()
    await broker.publish(orgUnitSubject('t1', 'upserted'), env('t1', 'upserted', 'e1', T1, { id: 'ou-a', name: 'A', kind: 'council' }))
    expect(mem.rows.get('ou-a')).toBeDefined()
  })
})
