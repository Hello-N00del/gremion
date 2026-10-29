// services/kernel-api/src/outbox/relay-host.ts -- the per-customer relay
// supervisor (TASK-080-a step d).
//
// @gremion/events createRelay is ONE loop per service database; the kernel API
// is multi-tenant (one idt.outbox per customer database), so it supervises one
// relay per customer:
//   * a customer gets a relay only while the control registry calls it `active`
//     AND the schema gate calls its database current (a database behind the
//     chain has no idt.database_binding yet; a relay on it would fail every pass);
//   * the relay runs on the customer's own app-role pool and publishes under the
//     customer's own NATS identity (kernel-api@<slug>): the broker enforces that
//     it can publish gremion.<slug>.idt.> and nothing else;
//   * subject = gremion.<slug>.idt.<aggregate>.<event> (subjectOfType);
//   * a customer that stops being active / current, or whose db_conn_ref changed,
//     loses / restarts its relay on the next reconcile; one customer's failure
//     (a NATS outage, a refused pool) is logged and never stops the others;
//   * every TRANSITION is logged once, never once per pass: a warn when an active
//     customer is skipped because its database is not current (the gate's reason),
//     an info naming why a relay stopped;
//   * stop() halts every loop, then closes every NATS connection it opened.
// The relay itself reconnects (createRelay re-opens a closed connection) and its
// advisory lock makes a second kernel-api replica a no-op for that customer.
import type { Sql } from '@gremion/db'
import { createRelay, type Publisher, type Relay } from '@gremion/events'
import type { CustomerGate, Logger, TenancyStore, TenantDb, TenantRow } from '../app/deps.ts'
import { subjectOfType } from './catalogue.ts'

export interface JetStreamHandle {
  js: Publisher
  close(): Promise<void>
}

export interface RelayHostOptions {
  tenancy: Pick<TenancyStore, 'listActive'>
  tenantDb: TenantDb
  gate: CustomerGate
  /** Opens the customer's NATS connection as the kernel-api identity. */
  openJetStream(tenant: TenantRow): Promise<JetStreamHandle>
  log: Logger
  /** Relay poll interval. Default 1 s. */
  pollMs?: number
  /** Customer set re-check interval. Default 30 s. */
  reconcileMs?: number
  /** Test seam: the relay factory (default createRelay). */
  makeRelay?: typeof createRelay
}

interface Running {
  tenant: TenantRow
  relay: Relay
  handles: JetStreamHandle[]
}

export interface RelayHost {
  /** One pass over the customers; resolves when the set is reconciled (never rejects). */
  reconcile(): Promise<void>
  /** Starts the periodic reconcile (the first pass runs at once). */
  start(): void
  /** Stops every relay and closes every connection. Safe to call twice. */
  stop(): Promise<void>
  /** Customers with a running relay. */
  running(): string[]
}

export function createRelayHost(o: RelayHostOptions): RelayHost {
  const relays = new Map<string, Running>()
  /** customerId -> the skip signature last logged (a gate reason / a gate error), cleared when the customer is wanted or inactive. */
  const skipped = new Map<string, string>()
  const makeRelay = o.makeRelay ?? createRelay
  let timer: ReturnType<typeof setInterval> | undefined
  let stopped = false
  let inFlight: Promise<void> | undefined

  async function halt(id: string, reason: string): Promise<void> {
    const r = relays.get(id)
    if (!r) return
    relays.delete(id)
    o.log.info('kernel-api: event relay stopped', { customerId: id, reason })
    await r.relay.stop().catch((err: unknown) => o.log.warn('kernel-api: relay stop failed', { customerId: id, err: (err as Error).message }))
    await Promise.allSettled(r.handles.map((h) => h.close()))
  }

  async function begin(tenant: TenantRow): Promise<void> {
    // Resolve once now: a customer whose pool is refused does not get a relay at all.
    await o.tenantDb.sqlFor(tenant)
    // The relay only ever opens transactions (`sql.begin`). tenant-store may END a pool it evicted (LRU overflow,
    // evictTenantDb); a relay that kept the handle it got at start would fail every pass on the ended pool until a
    // process restart. So every pass asks tenant-store for the CURRENT pool (a cached lookup, not a connection).
    // currentSqlFor, never sqlFor(tenant): `tenant` is the row this relay STARTED with. After a db_conn_ref change it is
    // stale, and sqlFor would evict the fresh pool the HTTP path opened (and the HTTP path would evict it back) on every
    // pass, until the next reconcile restarts this relay on the new row.
    const poolNow = async (): Promise<Sql> => (await o.tenantDb.currentSqlFor?.(tenant.customerId)) ?? (await o.tenantDb.sqlFor(tenant))
    const sql = { begin: async (fn: never) => (await poolNow()).begin(fn) } as unknown as Sql
    const handles: JetStreamHandle[] = []
    const relay = makeRelay({
      sql,
      ctx: 'idt',
      subjects: (row) => subjectOfType(tenant.slug, row.event_type),
      pollMs: o.pollMs ?? 1_000,
      // A client function: the relay calls it again after a closed connection (never a fixed value that cannot recover).
      js: async () => {
        const h = await o.openJetStream(tenant)
        handles.push(h)
        return h.js
      },
      onError: (err, where) => o.log.error('kernel-api: relay pass failed', { customerId: tenant.customerId, where, err: (err as Error).message }),
      log: (line) => o.log.info(`kernel-api: relay ${tenant.customerId}: ${line}`),
    })
    relays.set(tenant.customerId, { tenant, relay, handles })
    relay.start()
    o.log.info('kernel-api: event relay started', { customerId: tenant.customerId })
  }

  async function reconcileOnce(): Promise<void> {
    let active: TenantRow[]
    try {
      active = await o.tenancy.listActive()
    } catch (err) {
      o.log.error('kernel-api: relay reconcile could not list the customers', { err: (err as Error).message })
      return
    }
    const wanted = new Map<string, TenantRow>()
    const activeIds = new Set<string>()
    for (const t of active) {
      activeIds.add(t.customerId)
      try {
        const verdict = await o.gate.check(t)
        if (verdict.ok || verdict.reason === 'ahead' || verdict.reason === 'current') {
          wanted.set(t.customerId, t)
          skipped.delete(t.customerId)
        } else if (skipped.get(t.customerId) !== verdict.reason) {
          skipped.set(t.customerId, verdict.reason)
          o.log.warn('kernel-api: event relay skipped, the customer database is not current', { customerId: t.customerId, reason: verdict.reason })
        }
      } catch (err) {
        const sig = `gate check failed: ${(err as Error).message}`
        if (skipped.get(t.customerId) !== sig) {
          skipped.set(t.customerId, sig)
          o.log.warn('kernel-api: relay gate check failed', { customerId: t.customerId, err: (err as Error).message })
        }
      }
    }
    for (const id of skipped.keys()) if (!activeIds.has(id)) skipped.delete(id)
    // Live iteration is safe: reconcileOnce is serialised (inFlight), additions happen only in
    // the loop below, and a Map skips an entry deleted (by halt) before it is reached.
    for (const [id, r] of relays) {
      const t = wanted.get(id)
      if (!t) await halt(id, activeIds.has(id) ? `the customer database is not current (${skipped.get(id) ?? 'gate verdict'})` : 'the customer is no longer active')
      else if (t.dbConnRef !== r.tenant.dbConnRef) await halt(id, 'db_conn_ref changed')
      else if (t.slug !== r.tenant.slug) await halt(id, 'slug changed')
    }
    for (const [id, t] of wanted) {
      if (stopped) return
      if (relays.has(id)) continue
      try {
        await begin(t)
      } catch (err) {
        o.log.error('kernel-api: event relay could not start', { customerId: id, err: (err as Error).message })
      }
    }
  }

  const reconcile = (): Promise<void> => {
    // one pass at a time; a call during a pass joins it
    inFlight ??= reconcileOnce().finally(() => {
      inFlight = undefined
    })
    return inFlight
  }

  return {
    reconcile,
    start() {
      if (timer || stopped) return
      void reconcile()
      timer = setInterval(() => void reconcile(), o.reconcileMs ?? 30_000)
      timer.unref?.()
    },
    async stop() {
      stopped = true
      if (timer) clearInterval(timer)
      timer = undefined
      await inFlight?.catch(() => undefined)
      await Promise.allSettled([...relays.keys()].map((id) => halt(id, 'the supervisor is stopping')))
    },
    running: () => [...relays.keys()].sort(),
  }
}
