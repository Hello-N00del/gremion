// org-unit-events.test.ts — #383 Lane E1 kernel publisher (choke-point enqueue).
//
// The org_units DML choke point (createOrgUnit / updateOrgUnit / deleteOrgUnit) must
// enqueue EXACTLY ONE org_unit_event_outbox row of the right type + snapshot payload,
// on the SAME runner it wrote org_units with (co-committed → a rollback of that tx
// drops both), and it must be a pure NO-OP when NATS_URL is unset (staging default).
//
// Runs under test:unit (jsdom, no DB): a fake tx runner records the emitted SQL +
// interpolated args, so we assert the enqueue happens on the SAME runner without a
// live Postgres. The real ON-CONFLICT/tx semantics are exercised leaf-side in
// modules/finance/test (the org-unit mirror consumer).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createOrgUnit, updateOrgUnit, deleteOrgUnit } from './org-units-db'

const ORG_ROW = {
  id: 'ou-1',
  name: 'Referat Finanzen',
  kind: 'committee',
  parent_id: 'ou-parent',
  description: null,
  child_term: null,
  kind_label: null,
  authority: 'deciding',
  visibility: 'all_members',
  wants_matrix_room: false,
  wants_nextcloud_folder: false,
  created_at: new Date('2026-01-01T00:00:00Z'),
}

interface Call {
  q: string
  args: unknown[]
}
/** A fake postgres-js tx runner (a FUNCTION, so unpackTxArgs treats it as a tx).
 *  Records every query + its interpolated args and routes RETURNING rows. */
function fakeTx() {
  const calls: Call[] = []
  const fn = ((strings: TemplateStringsArray, ...args: unknown[]) => {
    const q = strings.join(' ')
    calls.push({ q, args })
    if (q.includes('INSERT INTO org_units') || q.includes('UPDATE org_units')) return Promise.resolve([ORG_ROW])
    if (q.includes('DELETE FROM org_units')) return Promise.resolve([{ id: ORG_ROW.id }])
    return Promise.resolve([])
  }) as unknown as { (...a: unknown[]): Promise<unknown[]>; json: (x: unknown) => unknown; calls: Call[] }
  fn.json = (x: unknown) => x // identity so the captured payload arg IS the object
  fn.calls = calls
  return fn
}

const outboxInserts = (tx: ReturnType<typeof fakeTx>): Call[] =>
  tx.calls.filter((c) => c.q.includes('INSERT INTO org_unit_event_outbox'))

describe('org-units choke point — enqueues the mirror-resync event (NATS_URL set)', () => {
  beforeEach(() => {
    process.env.NATS_URL = 'nats://localhost:4222'
  })
  afterEach(() => {
    delete process.env.NATS_URL
  })

  it('createOrgUnit enqueues exactly one "upserted" row with the full snapshot, on the same runner', async () => {
    const tx = fakeTx()
    await createOrgUnit(tx as never, {
      name: 'Referat Finanzen',
      description: null,
      parentId: 'ou-parent',
      kind: 'committee',
      visibility: 'all_members',
      wantsMatrixRoom: false,
      wantsNextcloudFolder: false,
    })
    const outbox = outboxInserts(tx)
    expect(outbox).toHaveLength(1)
    // args = [event_type, aggregate_id, payload(json), correlation_id]
    expect(outbox[0]!.args[0]).toBe('upserted')
    expect(outbox[0]!.args[1]).toBe('ou-1')
    expect(outbox[0]!.args[2]).toEqual({ id: 'ou-1', name: 'Referat Finanzen', kind: 'committee', parent_id: 'ou-parent' })
    expect(outbox[0]!.args[3]).toBeNull()
    // co-commit: the org_units write and the outbox write are on the SAME runner (tx),
    // so a rollback of that tx drops BOTH.
    expect(tx.calls.some((c) => c.q.includes('INSERT INTO org_units'))).toBe(true)
  })

  it('updateOrgUnit enqueues exactly one "upserted" row with the fresh snapshot', async () => {
    const tx = fakeTx()
    await updateOrgUnit(tx as never, 'ou-1', { name: 'Referat Finanzen' })
    const outbox = outboxInserts(tx)
    expect(outbox).toHaveLength(1)
    expect(outbox[0]!.args[0]).toBe('upserted')
    expect(outbox[0]!.args[2]).toEqual({ id: 'ou-1', name: 'Referat Finanzen', kind: 'committee', parent_id: 'ou-parent' })
  })

  it('deleteOrgUnit enqueues exactly one "deleted" tombstone carrying only the id', async () => {
    const tx = fakeTx()
    await deleteOrgUnit(tx as never, 'ou-1')
    const outbox = outboxInserts(tx)
    expect(outbox).toHaveLength(1)
    expect(outbox[0]!.args[0]).toBe('deleted')
    expect(outbox[0]!.args[1]).toBe('ou-1')
    expect(outbox[0]!.args[2]).toEqual({ id: 'ou-1' })
  })
})

describe('org-units choke point — NO-OP when NATS_URL is unset (staging default)', () => {
  beforeEach(() => {
    delete process.env.NATS_URL
  })

  it('createOrgUnit does NOT enqueue', async () => {
    const tx = fakeTx()
    await createOrgUnit(tx as never, {
      name: 'X', description: null, parentId: null, kind: 'committee',
      visibility: 'all_members', wantsMatrixRoom: false, wantsNextcloudFolder: false,
    })
    expect(outboxInserts(tx)).toHaveLength(0)
    // the org_units write still happened — only the publish is gated off.
    expect(tx.calls.some((c) => c.q.includes('INSERT INTO org_units'))).toBe(true)
  })

  it('updateOrgUnit and deleteOrgUnit do NOT enqueue', async () => {
    const t1 = fakeTx()
    await updateOrgUnit(t1 as never, 'ou-1', { name: 'X' })
    expect(outboxInserts(t1)).toHaveLength(0)
    const t2 = fakeTx()
    await deleteOrgUnit(t2 as never, 'ou-1')
    expect(outboxInserts(t2)).toHaveLength(0)
  })
})

describe('org-units choke point — a delete that matched no row does not enqueue', () => {
  it('deleteOrgUnit enqueues nothing when the id was absent (RETURNING [])', async () => {
    process.env.NATS_URL = 'nats://localhost:4222'
    // A fake tx whose DELETE returns no row (id not found).
    const calls: Call[] = []
    const tx = ((strings: TemplateStringsArray, ...args: unknown[]) => {
      calls.push({ q: strings.join(' '), args })
      return Promise.resolve([]) // DELETE … RETURNING id → no rows
    }) as unknown as { (...a: unknown[]): Promise<unknown[]>; json: (x: unknown) => unknown; calls: Call[] }
    tx.json = (x: unknown) => x
    tx.calls = calls
    await deleteOrgUnit(tx as never, 'missing')
    expect(calls.filter((c) => c.q.includes('INSERT INTO org_unit_event_outbox'))).toHaveLength(0)
    delete process.env.NATS_URL
  })
})
