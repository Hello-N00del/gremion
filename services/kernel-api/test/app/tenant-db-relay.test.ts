// TASK-080-a house review, finding 1: the relay supervisor captured the control
// row it started with, and tenant-db evicts a customer's pool on ANY db_conn_ref
// mismatch. After a db_conn_ref change the relay (stale row) and the HTTP path
// (fresh row) evicted each other's pool on every pass. This suite runs the REAL
// createTenantDb and the REAL relay host over a fake pool factory.
import type { RelayOptions } from '@gremion/events'
import type { DbProfile } from '@gremion/db'
import { describe, expect, it } from 'vitest'
import type { TenantRow } from '../../src/app/deps.ts'
import { createTenantDb } from '../../src/app/tenant-db.ts'
import { createRelayHost } from '../../src/outbox/relay-host.ts'
import { kernelDatabaseOf } from '../../src/tenancy/target.ts'
import { A_ID, tenantRow } from '../harness/fakes.ts'

function world(initialRef: string) {
  const state = { row: tenantRow(A_ID, 'cust-a', 'active', { dbConnRef: initialRef }), made: [] as { user: string; ended: boolean }[], relayOpts: undefined as RelayOptions | undefined, relays: 0 }
  const tenantDb = createTenantDb({
    resolveSecret: (ref) => `postgres://u_${ref}@h/${kernelDatabaseOf(A_ID)}`,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    evictGraceMs: 0,
    createDb: (profile: DbProfile) => {
      const rec = { user: new URL((profile as unknown as { url: string }).url).username, ended: false }
      state.made.push(rec)
      return { begin: async (fn: (tx: unknown) => Promise<unknown>) => fn({ user: rec.user }), end: async () => void (rec.ended = true) } as never
    },
  })
  const host = createRelayHost({
    tenancy: { listActive: async () => [state.row] },
    tenantDb,
    gate: { check: async () => ({ ok: true }) },
    openJetStream: async () => ({ js: {} as never, close: async () => {} }),
    log: { info: () => {}, warn: () => {}, error: () => {} },
    makeRelay: ((o: RelayOptions) => {
      state.relayOpts = o
      state.relays++
      return { runOnce: async () => ({ locked: true, published: 0, failed: 0, deadLettered: 0 }), start: () => {}, stop: async () => {} }
    }) as never,
  })
  /** One relay pass: what createRelay does with `sql`. */
  const relayPass = async (): Promise<string> => (await state.relayOpts!.sql.begin(async (tx) => (tx as unknown as { user: string }).user)) as string
  return { state, tenantDb, host, relayPass }
}

describe('tenant-db and the relay after a db_conn_ref change', () => {
  it('the relay (stale row) and the HTTP path (fresh row) do not evict each other: one pool for the new ref, no churn', async () => {
    const w = world('r1')
    await w.host.reconcile()
    expect(w.state.made.map((m) => m.user)).toEqual(['u_r1'])
    // the control row's ref changes; the first request after it carries the fresh row
    w.state.row = { ...w.state.row, dbConnRef: 'r2' }
    await w.tenantDb.sqlFor(w.state.row)
    expect(w.state.made.map((m) => m.user)).toEqual(['u_r1', 'u_r2'])
    // the relay has not reconciled yet: its passes run with the row it started with
    for (let i = 0; i < 4; i++) {
      expect(await w.relayPass(), `relay pass ${i} must run on the pool of the CURRENT ref`).toBe('u_r2')
      await w.tenantDb.sqlFor(w.state.row)
    }
    expect(w.state.made.map((m) => m.user), 'no pool was rebuilt for the stale ref').toEqual(['u_r1', 'u_r2'])
    // the next reconcile restarts the relay on the new ref, still on the same pool
    await w.host.reconcile()
    expect(w.state.relays, 'the relay halted and restarted itself on the new ref').toBe(2)
    expect(await w.relayPass()).toBe('u_r2')
    expect(w.state.made).toHaveLength(2)
    await w.host.stop()
  })

  it('tenant-db itself: a call carrying a ref that is not the current one does not evict (peek), and a fresh ref still replaces the pool', async () => {
    const w = world('r1')
    const row = (ref: string): TenantRow => ({ ...w.state.row, dbConnRef: ref })
    await w.tenantDb.sqlFor(row('r1'))
    await w.tenantDb.sqlFor(row('r2'))
    const peeked = await w.tenantDb.currentSqlFor(A_ID)
    expect(await peeked!.begin(async (tx) => (tx as unknown as { user: string }).user)).toBe('u_r2')
    expect(w.state.made.map((m) => m.user)).toEqual(['u_r1', 'u_r2'])
    expect(await w.tenantDb.currentSqlFor('0192f0c1-2b3c-7d4e-8f00-000000000000')).toBeUndefined() // no ref in hand for this customer
  })
})
