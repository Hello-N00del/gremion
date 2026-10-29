// TASK-080-a step d: the per-customer relay supervisor, with a fake relay
// factory (the real relay on a real broker is test/outbox/relay.int.test.ts).
import type { RelayOptions } from '@gremion/events'
import { describe, expect, it } from 'vitest'
import type { GateVerdict, Logger, TenantRow } from '../../src/app/deps.ts'
import { createRelayHost, type JetStreamHandle } from '../../src/outbox/relay-host.ts'
import { A_ID, B_ID, tenantRow } from '../harness/fakes.ts'

const C_ID = '0192f0c1-2b3c-7d4e-8f00-1122334455cc'

function harness(tenants: TenantRow[], verdicts: Record<string, GateVerdict> = {}, log: Logger = { info: () => {}, warn: () => {}, error: () => {} }) {
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
    log,
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

  it('logs once per transition: a warn for an active customer skipped because its database is not current (with the reason), an info naming why a relay stopped; nothing on repeated passes', async () => {
    const lines: { level: string; msg: string; fields?: Record<string, unknown> }[] = []
    const log: Logger = {
      info: (msg, fields) => void lines.push({ level: 'info', msg, fields }),
      warn: (msg, fields) => void lines.push({ level: 'warn', msg, fields }),
      error: (msg, fields) => void lines.push({ level: 'error', msg, fields }),
    }
    const { host, state } = harness([tenantRow(A_ID, 'cust-a'), tenantRow(B_ID, 'cust-b')], { [B_ID]: { ok: false, reason: 'behind', retryAfterSeconds: 30 } }, log)
    const skips = () => lines.filter((l) => l.level === 'warn' && l.fields?.customerId === B_ID)
    for (let i = 0; i < 4; i++) await host.reconcile()
    expect(skips(), 'one warn for B over four passes, not one per pass').toHaveLength(1)
    expect(skips()[0]!.msg).toMatch(/skipped/)
    expect(skips()[0]!.fields).toMatchObject({ customerId: B_ID, reason: 'behind' })
    expect(lines.filter((l) => l.fields?.customerId === A_ID && l.level === 'warn')).toEqual([]) // A runs: nothing to warn about
    // the reason changes: a new transition, logged once
    state.verdicts[B_ID] = { ok: false, reason: 'diverged', retryAfterSeconds: 30 }
    await host.reconcile()
    await host.reconcile()
    expect(skips().map((l) => l.fields!.reason)).toEqual(['behind', 'diverged'])
    // B recovers and starts; later it relapses: logged again (the dedup is per transition, not forever)
    state.verdicts[B_ID] = { ok: true }
    await host.reconcile()
    expect(host.running()).toEqual([A_ID, B_ID].sort())
    state.verdicts[B_ID] = { ok: false, reason: 'unavailable', retryAfterSeconds: 30 }
    await host.reconcile()
    await host.reconcile()
    expect(skips().map((l) => l.fields!.reason)).toEqual(['behind', 'diverged', 'unavailable'])
    // the relay that was running stopped: one info naming the reason, and it says which gate verdict took the database out
    const stops = lines.filter((l) => l.level === 'info' && /relay stopped/.test(l.msg) && l.fields?.customerId === B_ID)
    expect(stops).toHaveLength(1)
    expect(String(stops[0]!.fields!.reason)).toMatch(/unavailable/)
    // a customer that leaves the active set is named as such; stop() says the supervisor stopped
    state.tenants.splice(0, 1)
    await host.reconcile()
    await host.stop()
    const stopsA = lines.filter((l) => l.level === 'info' && /relay stopped/.test(l.msg) && l.fields?.customerId === A_ID)
    expect(stopsA).toHaveLength(1)
    expect(String(stopsA[0]!.fields!.reason)).toMatch(/no longer active/)
    // a ref rotation is named as such
    const rot = harness([tenantRow(A_ID, 'cust-a')], {}, log)
    await rot.host.reconcile()
    rot.state.tenants[0] = tenantRow(A_ID, 'cust-a', 'active', { dbConnRef: 'file:/run/secrets/rotated' })
    await rot.host.reconcile()
    expect(lines.some((l) => l.level === 'info' && /relay stopped/.test(l.msg) && /db_conn_ref/.test(String(l.fields?.reason)))).toBe(true)
    await rot.host.stop()
  })
})
