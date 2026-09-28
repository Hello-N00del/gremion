// services/finance/src/org-unit-consumer.ts
//
// #383 Lane E1 — the FIRST leaf-side consumer. Subscribes the kernel org-unit
// change stream (gremion.*.org-unit.>) and applies each event to the leaf's
// `finance.org_unit_mirror`, so the project + sub-org reads resolve LEAF-LOCAL
// (see src/store/index.ts) instead of JOINing back into the kernel `org_units`.
//
// Two seams, both testable:
//   - OrgUnitMirrorStore.apply(op)  — the per-event write. sqlOrgUnitMirrorStore
//     is the REAL Postgres impl (integration-tested against migration 002); the
//     unit test injects an in-memory double with the SAME semantics.
//   - wireOrgUnitConsumer(deps)     — the broker wiring (InMemoryBroker in the
//     unit test, NatsBroker in prod via startOrgUnitConsumer).
//
// Correctness guarantees (all reproduced by the in-memory double):
//   1. IDEMPOTENCY — finance.event_consumption (consumer, event_id) PK + INSERT ON
//      CONFLICT DO NOTHING: a redelivered eventId is a no-op ('duplicate').
//   2. PER-AGGREGATE ORDERING — `source_occurred_at` is the last-applied event's
//      occurredAt; an ON CONFLICT DO UPDATE guarded by
//      `EXCLUDED.source_occurred_at > org_unit_mirror.source_occurred_at` drops a
//      stale (out-of-order) event ('stale'). A delete TOMBSTONES (deleted=true) so a
//      stale upsert delivered AFTER a delete cannot resurrect the row.
//   3. UNKNOWN-TENANT ACK-SKIP — an event for a tenant the leaf does not know
//      (resolveStore → undefined) is logged + acked, never retried, never crashes.

import {
  STREAMS,
  type BrokerPort,
  type BrokerSubscription,
  type EventEnvelope,
  type OrgUnitEvent,
} from '@gremion/ports/broker'
import type { Sql } from './tenant-store.js'

/** The consumer name used as the dedup key in finance.event_consumption. */
export const ORGUNIT_MIRROR_CONSUMER = 'finance-leaf:org-unit-mirror'

/** Subject pattern this consumer subscribes to — the SAME filter the ORGUNIT stream
 *  descriptor captures, so the wildcard semantics match end-to-end (D-P1-7). */
export const ORGUNIT_CONSUMER_PATTERN = STREAMS.ORGUNIT.subjects[0]!

/** A parsed, ready-to-apply org-unit mirror operation. */
export type OrgUnitMirrorOp =
  | {
      type: 'upsert'
      eventId: string
      occurredAt: string
      id: string
      name: string
      kind: string
      parentId: string | null
    }
  | { type: 'delete'; eventId: string; occurredAt: string; id: string }

/** The outcome of applying one op — surfaced so tests can assert idempotency +
 *  ordering without reaching into the store. */
export type ApplyOutcome = 'applied' | 'stale' | 'duplicate'

/** The per-event write seam. sqlOrgUnitMirrorStore is the real impl; the unit test
 *  injects an in-memory double with identical semantics. */
export interface OrgUnitMirrorStore {
  apply(op: OrgUnitMirrorOp): Promise<ApplyOutcome>
}

/** Guard: is the eventType one of the known OrgUnitEvent values? */
function isOrgUnitEvent(eventType: string): eventType is OrgUnitEvent {
  return eventType === 'upserted' || eventType === 'deleted'
}

/** Parse an event envelope into an OrgUnitMirrorOp, or null when it is not a
 *  well-formed org-unit event (unknown eventType / missing id → ack-skip). */
export function parseOrgUnitOp(env: EventEnvelope): OrgUnitMirrorOp | null {
  if (!isOrgUnitEvent(env.eventType)) return null
  const p = (env.payload ?? {}) as Record<string, unknown>
  const id = typeof p.id === 'string' && p.id.length > 0 ? p.id : undefined
  if (id === undefined) return null
  if (env.eventType === 'upserted') {
    return {
      type: 'upsert',
      eventId: env.eventId,
      occurredAt: env.occurredAt,
      id,
      name: typeof p.name === 'string' ? p.name : '',
      kind: typeof p.kind === 'string' ? p.kind : '',
      parentId: typeof p.parent_id === 'string' && p.parent_id.length > 0 ? p.parent_id : null,
    }
  }
  return { type: 'delete', eventId: env.eventId, occurredAt: env.occurredAt, id }
}

/**
 * The real Postgres mirror store. Every apply runs in ONE transaction so the
 * idempotency claim (event_consumption) and the guarded mirror write co-commit.
 *
 *  - INSERT event_consumption ON CONFLICT DO NOTHING RETURNING → 0 rows means the
 *    eventId was already applied → 'duplicate' (mirror is left untouched).
 *  - The mirror write is `INSERT … ON CONFLICT (id) DO UPDATE … WHERE
 *    EXCLUDED.source_occurred_at > org_unit_mirror.source_occurred_at RETURNING id`.
 *    RETURNING yields the row ONLY when the write took effect (fresh insert OR a
 *    strictly-newer update) → 'applied'; a stale (guard-false) conflict returns 0
 *    rows → 'stale'.
 */
export function sqlOrgUnitMirrorStore(sql: Sql, consumer: string = ORGUNIT_MIRROR_CONSUMER): OrgUnitMirrorStore {
  return {
    async apply(op: OrgUnitMirrorOp): Promise<ApplyOutcome> {
      return sql.begin(async (tx) => {
        const t = tx as unknown as Sql
        const claimed = await t<{ event_id: string }[]>`
          INSERT INTO finance.event_consumption (consumer, event_id)
          VALUES (${consumer}, ${op.eventId})
          ON CONFLICT (consumer, event_id) DO NOTHING
          RETURNING event_id`
        if (claimed.length === 0) return 'duplicate' as const

        if (op.type === 'upsert') {
          const w = await t<{ id: string }[]>`
            INSERT INTO finance.org_unit_mirror (id, name, kind, parent_id, deleted, source_occurred_at)
            VALUES (${op.id}, ${op.name}, ${op.kind}, ${op.parentId}, false, ${op.occurredAt})
            ON CONFLICT (id) DO UPDATE SET
              name = EXCLUDED.name,
              kind = EXCLUDED.kind,
              parent_id = EXCLUDED.parent_id,
              deleted = false,
              source_occurred_at = EXCLUDED.source_occurred_at
            WHERE EXCLUDED.source_occurred_at > finance.org_unit_mirror.source_occurred_at
            RETURNING id`
          return (w.length > 0 ? 'applied' : 'stale') as ApplyOutcome
        }

        const w = await t<{ id: string }[]>`
          INSERT INTO finance.org_unit_mirror (id, name, kind, parent_id, deleted, source_occurred_at)
          VALUES (${op.id}, '', '', NULL, true, ${op.occurredAt})
          ON CONFLICT (id) DO UPDATE SET
            deleted = true,
            source_occurred_at = EXCLUDED.source_occurred_at
          WHERE EXCLUDED.source_occurred_at > finance.org_unit_mirror.source_occurred_at
          RETURNING id`
        return (w.length > 0 ? 'applied' : 'stale') as ApplyOutcome
      }) as Promise<ApplyOutcome>
    },
  }
}

export interface OrgUnitConsumerDeps {
  broker: BrokerPort
  /** Resolve the mirror store for a tenant id; undefined → unknown tenant → ack-skip. */
  resolveStore: (tenantId: string) => OrgUnitMirrorStore | undefined | Promise<OrgUnitMirrorStore | undefined>
  log?: (msg: string) => void
}

/**
 * Wire the org-unit mirror consumer onto a broker (InMemoryBroker in tests,
 * NatsBroker in prod). Returns the subscription so callers can unsubscribe on
 * shutdown. Every branch acks (never throws out of the handler): a malformed
 * event, an unknown tenant, a duplicate, or a stale event are all no-ops.
 */
export function wireOrgUnitConsumer(deps: OrgUnitConsumerDeps): BrokerSubscription {
  const log = deps.log ?? ((m: string) => console.info(m))
  return deps.broker.subscribe(ORGUNIT_CONSUMER_PATTERN, async (env: EventEnvelope) => {
    const op = parseOrgUnitOp(env)
    if (op === null) {
      log(`[org-unit-consumer] ignoring malformed/unknown event ${env.eventId} (type=${env.eventType}) — ack-skip`)
      return
    }
    const store = await deps.resolveStore(env.tenantId)
    if (store === undefined) {
      log(`[org-unit-consumer] unknown tenant "${env.tenantId}" for event ${env.eventId} — ack-skip`)
      return
    }
    await store.apply(op)
  })
}

/**
 * The bits of the leaf's NatsBroker this bootstrap needs beyond BrokerPort.
 * Declared structurally so the test can drive the boot with a double instead of
 * a live server.
 */
export interface LeafBroker extends BrokerPort {
  // Mirrors @gremion/ports/nats NatsBroker.ensureStream exactly. It was
  // `readonly string[]`, which a NatsBroker is NOT assignable to (its own
  // parameter is a mutable `string[]`, and parameters are contravariant), so
  // src/index.ts failed to typecheck against the real class.
  ensureStream(name: string, subjects: string[]): Promise<void>
  close(): Promise<void>
}

/** What startOrgUnitConsumer hands back so SIGTERM can actually stop it. */
export interface OrgUnitConsumerHandle {
  close(): Promise<void>
}

export interface OrgUnitConsumerBootDeps {
  /** Connect a broker bound to the ORGUNIT stream. */
  connect: () => Promise<LeafBroker>
  resolveStore: OrgUnitConsumerDeps['resolveStore']
  /**
   * True once graceful shutdown has begun. A `closed` rejection AFTER that is
   * the shutdown doing its job — close() ends the consumer and an ended
   * consumer is allowed to reject — so it must not become exit(1). Round 1 had
   * no such check, so every clean SIGTERM raced a spurious non-zero exit
   * against the pool drain.
   */
  isStopped: () => boolean
  /**
   * The subscription died MID-LIFE. The broker has already been closed by the
   * time this is called, so the handler's job is to schedule a re-boot on its
   * own bounded ladder — NOT to exit: a leaf that exits here is crash-looped by
   * compose against a broker that is usually about to come back. Boot failures
   * are NOT routed here — they reject the returned promise so the caller can
   * name the migration command in its own log line.
   */
  onFatal: (err: unknown) => void
  log?: (msg: string) => void
  error?: (msg: string, err: unknown) => void
}

/**
 * Boot the org-unit mirror consumer.
 *
 * FATAL on refusal, deliberately. Since the kernel's wire-root cutover both
 * ensureStream() (the repoint refusal) and subscribe()'s `ready`
 * (StreamCoverError, the server's own consumer error, SetupTimeoutError) can
 * say "this consumer could only ever receive nothing" — typically because the
 * stream is still on the retired root. A leaf that swallowed that would keep
 * serving HTTP while its mirror silently stopped tracking the kernel, which is
 * the failure this whole cutover exists to make impossible.
 *
 * The broker is CLOSED before the rejection propagates: the connection must not
 * survive a boot the caller chooses to retry.
 */
export async function startOrgUnitConsumer(deps: OrgUnitConsumerBootDeps): Promise<OrgUnitConsumerHandle> {
  const log = deps.log ?? ((m: string) => console.info(m))
  const error = deps.error ?? ((m: string, err: unknown) => console.error(m, err))
  const broker = await deps.connect()
  let subscription: BrokerSubscription
  try {
    await broker.ensureStream(STREAMS.ORGUNIT.name, STREAMS.ORGUNIT.subjects)
    subscription = wireOrgUnitConsumer({ broker, resolveStore: deps.resolveStore, log })
    // A returned subscription is not a LIVE one — `ready` is where that verdict
    // lands, and it is the only place it does.
    await subscription.ready
  } catch (err) {
    await broker.close().catch(() => {})
    throw err
  }
  // And a live subscription can still die later: its stream or consumer deleted
  // under it, or the server quietly stopping delivery. `closed` rejects within
  // LIVENESS_FAULT_BOUND_MS when that happens. The dead broker is closed and the
  // fault handed to onFatal, which re-boots this whole function on the caller's
  // bounded schedule — a fresh boot redoes the ensureStream/cover check against
  // whatever the stream actually is NOW, which is the state that needs
  // re-verifying. It does NOT exit the process: compose's restart policy would
  // crash-loop the leaf's whole HTTP surface against a broker that is usually
  // about to come back on its own.
  void subscription.closed.catch(async (err: unknown) => {
    if (deps.isStopped()) {
      log('[org-unit-consumer] subscription ended during shutdown — expected, not a fault')
      return
    }
    error('[org-unit-consumer] subscription died — resubscribing on the bounded schedule:', err)
    // The restart calls connect() again and gets a NEW broker, so the connection
    // whose subscription just died has to be handed back HERE — and BEFORE
    // onFatal, so the restart can never overlap a live-but-dead handle. Round 3
    // dropped it: every mid-life death stranded one connection for the life of
    // the process, which is the leak the boot path's catch was already fixed for.
    await broker.close().catch((closeErr: unknown) => {
      error('[org-unit-consumer] closing the dead broker failed:', closeErr)
    })
    deps.onFatal(err)
  })
  return {
    async close(): Promise<void> {
      subscription.unsubscribe()
      await broker.close()
    },
  }
}
