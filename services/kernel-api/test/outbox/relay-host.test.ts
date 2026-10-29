// TASK-080-a step d: the per-customer relay supervisor, with a fake relay
// factory (the real relay on a real broker is test/outbox/relay.int.test.ts).
import type { RelayOptions } from '@gremion/events'
import { describe, expect, it } from 'vitest'
import type { GateVerdict, TenantRow } from '../../src/app/deps.ts'
import { createRelayHost, type JetStreamHandle } from '../../src/outbox/relay-host.ts'
import { A_ID, B_ID, tenantRow } from '../harness/fakes.ts'

const C_ID = '0192f0c1-2b3c-7d4e-8f00-1122334455cc'

function harness(tenants: TenantRow[], verdicts: Record<string, GateVerdict> = {}) {
  const state = { tenants, verdicts, handles: new Map<string, { gen: number; ended: boolean }[]>(), started: [] as string[], stopped: [] as string[], opened: [] as string[], closed: [] as string[], failOpenFor: new Set<string>(), made: new Map<string, RelayOptions>() }
  const host = createRelayHost({
    tenancy: { listActive: async () => state.tenants.filter((t) => t.status === 'active') },
    tenantDb: {
      sqlFor: async (t) => {
        if (state.failOpenFor.has(t.customerId)) throw new Error('pool refused')
        const list = state.handles.get(t.customerId) ?? []
        state.handles.set(t.customerId, list)
        // tenant-store hands out the live pool; an ended one is replaced by a fresh pool on the next ask
        let h = list[list.length - 1]
        if (!h || h.ended) {
          h = { gen: list.length + 1, ended: false }
          list.push(h)
        }
        const mine = h
        return {
          begin: async (fn: (tx: unknown) => Promise<unknown>) => {
            if (mine.ended) throw new Error('write CONNECTION_ENDED')
            return fn({ gen: mine.gen })
          },
        } as never
      },
    },
    gate: { check: async (t) => state.verdicts[t.customerId] ?? { ok: true } },
    openJetStream: async (t): Promise<JetStreamHandle> => {
      state.opened.push(t.slug)
      return { js: { publish: async () => ({ stream: 'IDT', seq: 1, duplicate: false }) } as never, close: async () => void state.closed.push(t.slug) }
    },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    makeRelay: ((o: RelayOptions) => {
      const slug = /^gremion\.([^.]+)\./.exec((o.subjects as (r: { event_type: string }) => string)({ event_type: 'de.gremion.idt.membership.started.v1' }))![1]!
      const id = state.tenants.find((t) => t.slug === slug)!.customerId
      state.made.set(id, o)
      return { runOnce: async () => ({ locked: true, published: 0, failed: 0, deadLettered: 0 }), start: () => void state.started.push(id), stop: async () => void state.stopped.push(id) }
    }) as never,
  })
  return { host, state }
}

describe('the per-customer relay host', () => {
  it('starts one relay for each ACTIVE customer whose database the gate calls current, and none for the others', async () => {
    const { host, state } = harness(
      [tenantRow(A_ID, 'cust-a'), tenantRow(B_ID, 'cust-b'), tenantRow(C_ID, 'cust-c'), tenantRow('0192f0c1-2b3c-7d4e-8f00-1122334455dd', 'cust-d', 'suspended')],
      { [B_ID]: { ok: false, reason: 'behind', retryAfterSeconds: 30 } },
    )
    await host.reconcile()
    expect(host.running()).toEqual([A_ID, C_ID].sort())
    expect(state.started.sort()).toEqual([A_ID, C_ID].sort())
    await host.stop()
  })

  it('every relay is ctx idt and publishes gremion.<slug>.idt.<aggregate>.<event>, under the customer\'s own NATS identity', async () => {
    const { host, state } = harness([tenantRow(A_ID, 'cust-a')])
    await host.reconcile()
    const o = state.made.get(A_ID)!
    expect(o.ctx).toBe('idt')
    const subjects = o.subjects as (row: { event_type: string }) => string
    expect(subjects({ event_type: 'de.gremion.idt.membership.started.v1' })).toBe('gremion.cust-a.idt.membership.started')
    expect(() => subjects({ event_type: 'de.gremion.gov.motion.created.v1' })).toThrow(/not an idt event type/)
    expect(state.opened).toEqual([]) // lazy: nothing connects until the relay's first pass asks
    await (o.js as () => Promise<unknown>)()
    expect(state.opened).toEqual(['cust-a'])
    await host.stop()
    expect(state.closed).toEqual(['cust-a'])
  })

  it('a customer that falls behind (or leaves the active set) loses its relay; one whose db_conn_ref changed gets a fresh one', async () => {
    const { host, state } = harness([tenantRow(A_ID, 'cust-a'), tenantRow(B_ID, 'cust-b')])
    await host.reconcile()
    expect(host.running()).toEqual([A_ID, B_ID].sort())
    state.verdicts[A_ID] = { ok: false, reason: 'diverged', retryAfterSeconds: 30 }
    state.tenants[1] = tenantRow(B_ID, 'cust-b', 'active', { dbConnRef: 'file:/run/secrets/rotated' })
    await host.reconcile()
    expect(state.stopped).toEqual(expect.arrayContaining([A_ID, B_ID]))
    expect(host.running()).toEqual([B_ID]) // B restarted on the new ref, A gone
    expect(state.started.filter((x) => x === B_ID)).toHaveLength(2)
    await host.stop()
  })

  it('one customer that cannot start (its pool is refused) never stops the others', async () => {
    const { host, state } = harness([tenantRow(A_ID, 'cust-a'), tenantRow(B_ID, 'cust-b')])
    state.failOpenFor.add(A_ID)
    await host.reconcile()
    expect(host.running()).toEqual([B_ID])
    state.failOpenFor.clear()
    await host.reconcile()
    expect(host.running()).toEqual([A_ID, B_ID].sort())
    await host.stop()
  })

  it('a control registry outage leaves the running relays alone; stop() halts every relay and is safe twice', async () => {
    const { host, state } = harness([tenantRow(A_ID, 'cust-a')])
    await host.reconcile()
    state.tenants.length = 0
    const down = createRelayHost({
      tenancy: { listActive: async () => { throw new Error('control down') } },
      tenantDb: { sqlFor: async () => ({}) as never },
      gate: { check: async () => ({ ok: true }) },
      openJetStream: async () => { throw new Error('unused') },
      log: { info: () => {}, warn: () => {}, error: () => {} },
    })
    await expect(down.reconcile()).resolves.toBeUndefined() // logged, never thrown
    await host.stop()
    await host.stop()
    expect(state.stopped).toEqual([A_ID])
    expect(host.running()).toEqual([])
  })

  it('a pool tenant-store ended (LRU eviction) is not kept: every pass asks for the current pool, so publishing resumes on a fresh one', async () => {
    const { host, state } = harness([tenantRow(A_ID, 'cust-a')])
    await host.reconcile()
    const o = state.made.get(A_ID)!
    const seen: number[] = []
    const pass = () => o.sql.begin(async (tx) => void seen.push((tx as unknown as { gen: number }).gen))
    await pass()
    state.handles.get(A_ID)![0]!.ended = true // the eviction ended pool 1
    await pass() // the very next pass must reach pool 2, not fail on the ended pool 1
    await pass()
    expect(seen).toEqual([1, 2, 2])
    expect(state.handles.get(A_ID)).toHaveLength(2)
    await host.stop()
  })
})
