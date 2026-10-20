// services/finance/src/tenant-store.ts
//
// Tenant→storage seam for the finance leaf service. Mirrors
// services/content/src/tenant-store.ts.
//
// Responsibilities:
//  1. Control DB (`finance_control`): holds `tenant_catalog` (tenant_id, slug,
//     db_name, created_at). Created once on first use.
//  2. Per-tenant DB ensure: on first contact for a tenant, CREATE DATABASE
//     `finance_<slug>` (if not exists) + bind its catalog row (id, slug).
//  3. Leaf migration runner: manifest-hash pattern (G-012). Reads
//     migrations/*.sql, verifies SHA-256 against migrations/manifest.json, runs
//     each pending migration IN ORDER (idempotent — the DDL uses IF NOT EXISTS).
//  4. Per-tenant pool map: bounded true-LRU registry keyed by tenant id.
//
// no-phantom-stura-db invariant: the DB name is ALWAYS `<dbPrefix><slug>` with
// dbPrefix defaulting to `finance_` (never `stura_`). See
// test/no-phantom-stura-db.test.ts.

import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'

/**
 * Resolve the runtime Postgres URL, failing closed. In production FINANCE_PG_URL
 * is set; we deliberately DO NOT fall back to localhost:5432 — on the staging host
 * that port is the LIVE kernel Postgres (#394 require-explicit-env posture, already
 * carried by calendar/content/newsletter). Fires only when neither an explicit
 * pgUrl nor the env var is set (a misconfiguration).
 *
 * @param optionName the caller option that would satisfy THIS resolution. It is
 *   named in the error, so a caller resolving a second endpoint (backfill.ts
 *   resolves a SOURCE as well as a TARGET) does not tell the operator to set the
 *   option they have already set.
 */
export function requireRuntimePgUrl(
  explicit: string | undefined,
  envName: string,
  optionName = 'options.pgUrl',
): string {
  const url = explicit ?? process.env[envName]
  if (!url) {
    throw new Error(
      `[finance] no Postgres URL configured — set ${envName} (or pass ${optionName}). ` +
        'Refusing to default to localhost:5432 (the LIVE kernel Postgres on the staging host).',
    )
  }
  return url
}

// ── types ─────────────────────────────────────────────────────────────────────

/** The minimal tenant shape this module needs. */
export interface TenantRef {
  readonly id: string
  readonly slug: string
}

/** Options for storeFor (mostly to allow test overrides). */
export interface StoreForOptions {
  /** Admin PG URL (connects to the Postgres instance for CREATE DATABASE). */
  pgUrl?: string
  /**
   * DB name prefix. Production = `finance_`; tests override to `finance_test_`
   * so all test DBs are easily identified and never collide with a production
   * DB name.
   */
  dbPrefix?: string
  /**
   * Test-only: override the manifest content so we can inject a bad hash to test
   * the mismatch-abort path without touching disk.
   */
  _overrideManifest?: Record<string, string>
}

/** A postgres-js Sql instance (the pool type). */
export type Sql = ReturnType<typeof postgres>

/**
 * Thrown by every pool-opening path once closeAllPools() has run.
 *
 * closeAllPools() is the SIGTERM drain. Without a latch, a request already in
 * flight when the signal landed re-enters storeFor(), finds the registry empty,
 * and opens a brand-new pool BEHIND the drain that just closed everything -
 * a pool nothing will ever close, on a process that exits seconds later. The
 * request cannot be served either way; failing it loudly is the difference
 * between a 503 in the access log and a silent connection leak.
 */
export class ShuttingDownError extends Error {
  readonly code = 'SHUTTING_DOWN'
  constructor(what: string) {
    super(
      `[tenant-store] ${what} refused: this process is shutting down and every pool has ` +
        `already been closed. Opening a new one here would leak it - the process exits as ` +
        `soon as the drain completes.`,
    )
    this.name = 'ShuttingDownError'
  }
}

/**
 * The (tenant id, slug) pair of a request disagrees with the one the catalog
 * binds: on a warm pool (the registry entry keeps the catalog slug) or on a cold
 * miss (a catalog row for the id with another slug, or for the slug with another
 * id). Nothing is created, nothing is upserted and no pool is handed out; the
 * HTTP layer answers 409 tenant_identity_mismatch.
 *
 * The database name is derived from the slug alone, so a store that follows a
 * changed slug silently hands the tenant a new, empty database and orphans the
 * old one. A slug rename is an operator procedure (rename the database, update
 * the catalog row, restart the leaf), never a side effect of a request. Same
 * contract as the board store's R29-BOARD-STORE-S B2c; audit #534.
 */
export class TenantIdentityMismatchError extends Error {
  readonly code = 'TENANT_IDENTITY_MISMATCH'
  constructor(tenant: TenantRef, bound: TenantRef) {
    super(
      `[tenant-store] tenant identity mismatch: request (${tenant.id}, ${tenant.slug}) vs ` +
        `catalogued (${bound.id}, ${bound.slug}) - refusing (no database created, nothing upserted)`,
    )
    this.name = 'TenantIdentityMismatchError'
  }
}

/**
 * The tenant id is not a canonical lowercase uuid (Postgres' own rendering). The
 * catalog comparison is on tenant_id::text and the id keys the pool registry, so
 * any other spelling is refused before a catalog row, a database or a pool is
 * touched. The HTTP layer answers 400 invalid_tenant_id; the message and the
 * response name nothing the caller sent (follow-up to audit #534).
 */
export class InvalidTenantIdError extends Error {
  readonly code = 'TENANT_ID_INVALID'
  constructor() {
    super('[tenant-store] tenant id is not a canonical lowercase uuid - refusing (no database created, nothing upserted)')
    this.name = 'InvalidTenantIdError'
  }
}

/** A slug storeFor refuses to build a database name from (grammar, or reserved). */
export class InvalidTenantSlugError extends Error {
  readonly code = 'INVALID_TENANT_SLUG'
  constructor(message: string) {
    super(message)
    this.name = 'InvalidTenantSlugError'
  }
}

/** Latched by closeAllPools(); cleared only by the test reset helpers. */
let _closing = false

// ── constants ─────────────────────────────────────────────────────────────────

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations')
const MANIFEST_FILE = path.join(MIGRATIONS_DIR, 'manifest.json')

/** Production DB-name prefix. Never `stura_` (see no-phantom-stura-db). */
export const DEFAULT_DB_PREFIX = 'finance_'

/** Max live tenant pools in the registry. */
const POOL_REGISTRY_MAX = 16

/**
 * #256-4 parity with the kernel registry
 * (gremion-ui/src/lib/server/db/pool-registry.ts): how long a CAPACITY-evicted
 * pool keeps serving in-flight queries before it is drained. A burst of other
 * tenants can push out a pool whose owner still has queries on the wire; ending
 * that pool synchronously tears those sockets down mid-flight, and postgres-js
 * surfaces it as a generic connection error with nothing tying it back to an
 * eviction. Defer instead. Explicit resets still drain immediately — nothing is
 * in flight there.
 */
const EVICTED_POOL_DRAIN_GRACE_MS = 30_000

/**
 * Cap on pools awaiting a deferred drain. Without it the deferral silently
 * removes POOL_REGISTRY_MAX as a bound on LIVE pools: a burst rotating N>MAX
 * tenants inside one grace window holds MAX live + (N-MAX) pending, and the
 * excess is largest exactly when the connection budget is tightest. Past this
 * cap the OLDEST pending drain is performed immediately, so simultaneously-open
 * pools never exceed POOL_REGISTRY_MAX + PENDING_DRAIN_MAX.
 *
 * A SMALL CONSTANT, not POOL_REGISTRY_MAX. Setting it to POOL_REGISTRY_MAX made
 * the ceiling 16 live + 16 pending = 32 pools (x4 connections each) - precisely
 * the 2x doubling this bound exists to prevent. 4 keeps the worst case at
 * 16 + 4 = 20 pools while still absorbing the ordinary case (a handful of
 * evictions inside one 30s window).
 */
const PENDING_DRAIN_MAX = 4

/**
 * Per-victim throttle window for the capacity-eviction warn. Once the live
 * fleet exceeds POOL_REGISTRY_MAX every cold request evicts, so an unthrottled
 * warn fires per REQUEST rather than per incident - and a log that fires
 * thousands of times an hour is as silent as no log at all.
 */
const EVICTION_WARN_THROTTLE_MS = 60_000

// ── pool registry (true LRU, bounded, deferred drain on capacity evict) ──

interface PoolEntry {
  sql: Sql
  /**
   * The catalog slug this tenant id is bound to. The hot path compares it with
   * the request's slug before handing the pool out, so the identity binding
   * holds on a warm cache too, not only on a miss.
   */
  slug: string
  /** Monotonic recency stamp — bumped on every get AND every set (true LRU). */
  lastUsedOrder: number
}

let _nextOrder = 0
const _poolMap = new Map<string, PoolEntry>()

function getEntry(tenantId: string): PoolEntry | undefined {
  const entry = _poolMap.get(tenantId)
  if (entry === undefined) return undefined
  // A read IS a use. Without this bump the registry degrades to FIFO and
  // evicts the HOTTEST tenant (inserted first, touched on every request) the
  // moment POOL_REGISTRY_MAX is reached.
  entry.lastUsedOrder = _nextOrder++
  return entry
}

function getPool(tenantId: string): Sql | undefined {
  return getEntry(tenantId)?.sql
}

/**
 * A pool evicted on capacity but not yet drained. The `Sql` handle is stored
 * ALONGSIDE its timer: a structure holding only the timer can CANCEL a drain
 * but can never PERFORM it, and the evicted entry is already out of
 * `_poolMap` - so cancelling would orphan the pool with nothing left holding a
 * reference to end() it.
 */
interface PendingDrain {
  /**
   * Insertion id. The map used to be keyed on the TIMER HANDLE, whose identity
   * and even its type depend on the environment (Node returns a Timeout object,
   * fake timers a number). An explicit monotonic id makes deletion exact and
   * insertion order total, independent of what setTimeout happens to return.
   */
  id: number
  timer: ReturnType<typeof setTimeout>
  tenantId: string
  /** The catalog slug the pool was bound under (teardown matches on it). */
  slug: string
  sql: Sql
}

/**
 * Pools evicted on capacity and awaiting their deferred drain, OLDEST FIRST
 * (Map preserves insertion order - the bound below drains from the front).
 */
const _pendingDrains = new Map<number, PendingDrain>()
/** Monotonic insertion counter for _pendingDrains keys. */
let _nextDrainId = 0

/**
 * The installed drain-on-exit hook, or null. Held by reference (rather than
 * behind a boolean) so reset() can REMOVE it: a listener that only ever
 * accumulates makes process.listenerCount('beforeExit') useless as an
 * assertion, which is exactly why the round-3 hook test could not fail.
 */
let _drainOnExitHook: (() => void) | null = null

/**
 * The deferred drain timer is `unref`'d - it must not hold the process open for
 * the whole grace window - so a process exiting INSIDE that window would
 * abandon the evicted pool's sockets to a TCP reset instead of a clean
 * terminate. `beforeExit` fires exactly when the loop has emptied and still
 * permits async work: that is the shutdown path for those pools.
 */
function installDrainOnExit(): void {
  if (_drainOnExitHook !== null) return
  const hook = (): void => {
    _drainOnExitHook = null
    void drainPendingNow()
  }
  _drainOnExitHook = hook
  process.once('beforeExit', hook)
}

/** Remove the drain-on-exit hook (reset path). Idempotent. */
function uninstallDrainOnExit(): void {
  if (_drainOnExitHook === null) return
  process.removeListener('beforeExit', _drainOnExitHook)
  _drainOnExitHook = null
}

/**
 * End one evicted pool, LOGGING a failure instead of swallowing it: a
 * persistently failing end() leaks the connections that pool held, and a bare
 * `.catch(() => {})` leaves zero signal until Postgres refuses new connections.
 */
function endEvictedPool(tenantId: string, sql: Sql): Promise<boolean> {
  return sql.end().then(
    () => true,
    (err: unknown) => {
      console.warn(
        `[tenant-store] evicted pool drain FAILED for tenant ${tenantId}: ${String(err)} - ` +
          `its connections are leaked; repeated failures exhaust the Postgres connection budget`,
      )
      return false
    },
  )
}

/**
 * Drain a capacity-evicted pool after EVICTED_POOL_DRAIN_GRACE_MS, keeping the
 * handle so every other path can still end it.
 *
 * BOUNDED: deferring would otherwise remove POOL_REGISTRY_MAX as a bound on
 * LIVE pools. Past PENDING_DRAIN_MAX the oldest pending drain is performed
 * immediately, so simultaneously-open pools never exceed
 * POOL_REGISTRY_MAX + PENDING_DRAIN_MAX.
 */
function deferDrain(tenantId: string, sql: Sql, slug: string): void {
  const id = _nextDrainId++
  const timer = setTimeout(() => {
    _pendingDrains.delete(id)
    // The throttle entry is DELIBERATELY left in place. Round 4 deleted it
    // here, which cut the effective warn window from EVICTION_WARN_THROTTLE_MS
    // (60s) to EVICTED_POOL_DRAIN_GRACE_MS (30s) — the map is bounded by
    // prune-on-insert in warnEviction(), not by a deletion that also destroys
    // the suppression it exists to provide.
    void endEvictedPool(tenantId, sql)
  }, EVICTED_POOL_DRAIN_GRACE_MS)
  // Node returns a Timeout (unref keeps shutdown clean); fake timers return a
  // number - hence the defensive optional call.
  ;(timer as unknown as { unref?: () => void }).unref?.()
  _pendingDrains.set(id, { id, timer, tenantId, slug, sql })
  installDrainOnExit()
  enforcePendingDrainBound()
}

/**
 * THE one place the pending-drain bound is enforced. Called SYNCHRONOUSLY by
 * deferDrain immediately after the insert, so no caller can ever observe
 * _pendingDrains above PENDING_DRAIN_MAX and there is exactly ONE code path
 * that can grow the set.
 *
 * Round 3 inlined this loop in deferDrain and the finance suite still saw 21
 * pending drains against a cap of 16 in 2 of 6 full-suite runs. Pulling it into
 * a named function next to the single insertion point removes the possibility
 * of a second, uncapped eviction path being added later without the bound; the
 * guard test now asserts the invariant after EVERY insertion rather than once
 * at the end, so a future escape names the insert that caused it.
 */
function enforcePendingDrainBound(): void {
  while (_pendingDrains.size > PENDING_DRAIN_MAX) {
    const oldest: PendingDrain | undefined = _pendingDrains.values().next().value
    if (oldest === undefined) break
    clearTimeout(oldest.timer)
    _pendingDrains.delete(oldest.id)
    // NOT silent, but THROTTLED: this fires on the same per-request path the
    // eviction warn is throttled on, so an unthrottled copy of it reintroduces
    // exactly the flood the eviction throttle exists to stop. Round 4 also
    // deleted the victim's throttle entry here, which meant the ONE path that
    // fires per request had no suppression at all.
    warnOverflow(oldest.tenantId)
    void endEvictedPool(oldest.tenantId, oldest.sql)
  }
}

/**
 * End EVERY pool awaiting a deferred drain, here and now. This is what the
 * explicit-reset and shutdown paths call: cancelling the timers WITHOUT ending
 * their pools leaks the connections outright, because after eviction nothing
 * else holds the handle.
 */
async function drainPendingNow(): Promise<{ ended: number; failed: number }> {
  const pending = [..._pendingDrains.values()]
  _pendingDrains.clear()
  for (const entry of pending) clearTimeout(entry.timer)
  const results = await Promise.all(
    pending.map((entry) => endEvictedPool(entry.tenantId, entry.sql)),
  )
  return { ended: results.length, failed: results.filter((ok) => !ok).length }
}

/**
 * PUBLIC shutdown seam: end EVERY pool this process holds - the ones awaiting a
 * deferred drain AND the up-to-POOL_REGISTRY_MAX pools still LIVE in the
 * registry.
 *
 * Supersedes the old drainEvictedPools()-only seam (removed — unused, no
 * caller left after closeAllPools() was wired into every leaf's shutdown
 * handler; see the note on that call below).
 *
 * drainEvictedPools() alone left the larger half of the hole open: SIGTERM tore
 * down as many as POOL_REGISTRY_MAX x pool-size live connections by TCP reset
 * while carefully draining the handful that happened to be evicted in the last
 * grace window. This is what the leaf's shutdown handler awaits.
 */
export interface PoolDrainCounts {
  /** Live per-tenant pools ended. */
  readonly live: number
  /** Capacity-evicted pools still inside their grace window. */
  readonly evicted: number
  /** The control-DB pool: 1 once the leaf has booted, 0 before. */
  readonly control: number
  /** Pools whose end() REJECTED — every one of these is a leaked connection. */
  readonly failed: number
}

export async function closeAllPools(): Promise<PoolDrainCounts> {
  // Set FIRST: an in-flight request that lands mid-drain would otherwise open a
  // fresh pool behind the drain that just closed everything, and nothing would
  // ever close that one — the process exits seconds later.
  _closing = true

  const live = [..._poolMap.entries()]
  _poolMap.clear()

  // The CONTROL pool is not in _poolMap and is never evicted, so a drain that
  // walks only the registry misses the one pool a running leaf is guaranteed to
  // hold. Detach it before ending it so the guard above cannot hand it out.
  const control = _controlSql
  _controlSql = null
  _controlInitialized = false
  _controlInitPromise = null

  const [pending, liveResults, controlOk] = await Promise.all([
    drainPendingNow(),
    Promise.all(live.map(([tenantId, entry]) => endEvictedPool(tenantId, entry.sql))),
    control === null ? Promise.resolve(null) : endEvictedPool('<control>', control),
  ])

  const counts: PoolDrainCounts = {
    live: liveResults.length,
    evicted: pending.ended,
    control: control === null ? 0 : 1,
    failed:
      liveResults.filter((ok) => !ok).length + pending.failed + (controlOk === false ? 1 : 0),
  }
  // REAL counts, not a bare "drained": a rejected end() used to be swallowed
  // into a resolved promise and the shutdown logged success over the top of
  // leaked connections.
  console.log(
    `[tenant-store] closeAllPools: live=${counts.live} evicted=${counts.evicted} ` +
      `control=${counts.control} failed=${counts.failed}`,
  )
  return counts
}

/**
 * Last capacity-eviction warn per VICTIM tenant (throttle state).
 *
 * THE KEY IS THE VICTIM, deliberately. The warn names the victim, and what has
 * to be suppressed is the same tenant being evicted again on every cold request
 * once the live fleet exceeds POOL_REGISTRY_MAX. Keying on the evicting CAUSE
 * (the incoming tenant) would suppress along the wrong axis: one hot newcomer
 * would silence the warns for every tenant it displaced. A single global
 * once-per-window key would do the same to the whole fleet.
 *
 * BOUNDED: the entry is removed when that victim's pool is actually drained -
 * on the deferred timer, on the forced overflow drain, and on drainPendingNow -
 * so the map is bounded by the pending set instead of gaining one entry per
 * tenant-ever-evicted for the lifetime of the process.
 */
const _lastEvictionWarnAt = new Map<string, number>()
/** Monotonic eviction counter - carried in the warn so suppression is visible. */
let _evictionCount = 0

/**
 * Last pending-drain-overflow warn (null = never). GLOBAL, not per victim: the
 * message is about the process-wide PENDING_DRAIN_MAX cap, and the victim it
 * names is whichever pool happened to be oldest.
 */
let _lastOverflowWarnAt: number | null = null
/** Monotonic overflow counter - carried in the warn so suppression is visible. */
let _overflowCount = 0

/**
 * Warn on a forced overflow drain, at most once per throttle window.
 *
 * Ending a pool BEFORE its grace period elapsed is the exact harm the grace
 * period exists to avoid, so it must not be silent - but this fires on the same
 * per-request path warnEviction() is throttled on, so an unthrottled copy is
 * the same flood wearing a different message.
 */
function warnOverflow(tenantId: string): void {
  _overflowCount += 1
  const now = Date.now()
  if (_lastOverflowWarnAt !== null && now - _lastOverflowWarnAt < EVICTION_WARN_THROTTLE_MS) return
  _lastOverflowWarnAt = now
  console.warn(
    '[tenant-store] pending-drain overflow #' +
      _overflowCount +
      ': tenant ' +
      tenantId +
      ' pool ended BEFORE its ' +
      EVICTED_POOL_DRAIN_GRACE_MS +
      'ms grace period because PENDING_DRAIN_MAX=' +
      PENDING_DRAIN_MAX +
      ' was exceeded. Its in-flight queries fail with a generic connection error; ' +
      'the tenant fan-out on this instance exceeds what POOL_REGISTRY_MAX=' +
      POOL_REGISTRY_MAX +
      ' was sized for. Further overflows are suppressed for ' +
      EVICTION_WARN_THROTTLE_MS +
      'ms; the counter keeps rising.',
  )
}

/** Warn on a capacity eviction, at most once per victim per throttle window. */
function warnEviction(tenantId: string): void {
  _evictionCount += 1
  const now = Date.now()
  const last = _lastEvictionWarnAt.get(tenantId)
  if (last !== undefined && now - last < EVICTION_WARN_THROTTLE_MS) return
  // PRUNE-ON-INSERT is what bounds this map. Round 4 bounded it by deleting a
  // victim's entry when its pool drained, which also ended the suppression
  // window early - 30s instead of 60s on the deferred path, and immediately on
  // the overflow path. Dropping entries that have OUTLIVED their window keeps
  // the map bounded by the window without shortening it for anyone.
  for (const [victim, at] of _lastEvictionWarnAt) {
    if (now - at >= EVICTION_WARN_THROTTLE_MS) _lastEvictionWarnAt.delete(victim)
  }
  _lastEvictionWarnAt.set(tenantId, now)
  console.warn(
    `[tenant-store] capacity eviction #${_evictionCount}: tenant ${tenantId}'s pool pushed out ` +
      `past POOL_REGISTRY_MAX=${POOL_REGISTRY_MAX} live pools - drain deferred by ` +
      `${EVICTED_POOL_DRAIN_GRACE_MS}ms so in-flight queries can finish. Further evictions of ` +
      `this tenant are suppressed for ${EVICTION_WARN_THROTTLE_MS}ms; the counter keeps rising.`,
  )
}

function setPool(tenantId: string, sql: Sql, slug: string): void {
  if (_poolMap.size >= POOL_REGISTRY_MAX && !_poolMap.has(tenantId)) {
    let lruKey: string | undefined
    let lruOrder = Infinity
    for (const [k, v] of _poolMap) {
      if (v.lastUsedOrder < lruOrder) {
        lruOrder = v.lastUsedOrder
        lruKey = k
      }
    }
    if (lruKey !== undefined) {
      const evicted = _poolMap.get(lruKey)!
      _poolMap.delete(lruKey)
      // Log LOUDLY (kernel parity): a recurring capacity eviction means
      // POOL_REGISTRY_MAX is too low for the live fleet, and a SILENT one is
      // undiagnosable from the victim tenant's side — it just sees connection
      // errors. Name the tenant so the log identifies the victim.
      warnEviction(lruKey)
      deferDrain(lruKey, evicted.sql, evicted.slug)
    }
  }
  const existing = _poolMap.get(tenantId)
  if (existing !== undefined && existing.sql !== sql) {
    // storeFor() has no in-flight dedupe, so two concurrent calls for the SAME
    // tenant both open a pool. The loser used to be dropped from the map with
    // nothing left holding a reference to end() it - no warn, no pending drain,
    // no counter; the sockets survived until idle_timeout. Route it through the
    // same deferred drain a capacity victim gets: it may have queries in flight.
    console.warn(
      '[tenant-store] pool for tenant ' +
        tenantId +
        ' was REPLACED while one was already registered (concurrent storeFor); the ' +
        'displaced pool is drained after ' +
        EVICTED_POOL_DRAIN_GRACE_MS +
        'ms instead of being orphaned',
    )
    deferDrain(tenantId, existing.sql, existing.slug)
  }
  _poolMap.set(tenantId, { sql, slug, lastUsedOrder: _nextOrder++ })
}

/**
 * Teardown seam (the admin DELETE routes): end and remove every pool this
 * process holds for a tenant whose database or catalog row is being removed -
 * the live registry entry AND any capacity-evicted pool still inside its drain
 * grace window. Both keep connections open, an open connection blocks DROP
 * DATABASE, and a pool left behind would keep serving (or re-creating) a tenant
 * that no longer exists. Matches on the tenant id and/or the catalog slug.
 * Resolves to how many pools were ended.
 */
export async function evictTenantPools(match: { id?: string; slug?: string }): Promise<number> {
  const hit = (id: string, slug: string): boolean =>
    (match.id !== undefined && id === match.id) || (match.slug !== undefined && slug === match.slug)
  const ending: Promise<boolean>[] = []
  for (const [id, entry] of _poolMap) {
    if (!hit(id, entry.slug)) continue
    _poolMap.delete(id)
    ending.push(endEvictedPool(id, entry.sql))
  }
  for (const pending of _pendingDrains.values()) {
    if (!hit(pending.tenantId, pending.slug)) continue
    clearTimeout(pending.timer)
    _pendingDrains.delete(pending.id)
    ending.push(endEvictedPool(pending.tenantId, pending.sql))
  }
  await Promise.all(ending)
  return ending.length
}

/**
 * Test-only handle on the bounded pool registry. Lets
 * test/tenant-store.pool-registry.test.ts assert eviction ORDER on registry
 * MEMBERSHIP without opening POOL_REGISTRY_MAX+1 real Postgres pools.
 */
export const _poolRegistryForTests = {
  MAX: POOL_REGISTRY_MAX,
  DRAIN_GRACE_MS: EVICTED_POOL_DRAIN_GRACE_MS,
  PENDING_MAX: PENDING_DRAIN_MAX,
  WARN_THROTTLE_MS: EVICTION_WARN_THROTTLE_MS,
  get: (tenantId: string): Sql | undefined => getPool(tenantId),
  set: (tenantId: string, sql: Sql, slug = 'registry-test'): void => setPool(tenantId, sql, slug),
  /** The catalog slug a live entry is bound to (undefined when absent). */
  slug: (tenantId: string): string | undefined => _poolMap.get(tenantId)?.slug,
  keys: (): string[] => [..._poolMap.keys()],
  /**
   * Recency stamp of a live entry (undefined when absent). Lets the LRU test
   * assert the getPool BUMP directly instead of inferring it from an eviction
   * outcome — a direct assertion no ordering accident can satisfy.
   */
  order: (tenantId: string): number | undefined => _poolMap.get(tenantId)?.lastUsedOrder,
  /** How many evicted pools are still waiting on a deferred drain. */
  pending: (): number => _pendingDrains.size,
  /**
   * Victim tenants currently recorded in the eviction-warn throttle map. Lets
   * the guard test prove an entry SURVIVES its victim's drain (the throttle
   * window is 60s; the drain lands at 30s) and is pruned only once it expires.
   */
  warnedVictims: (): string[] => [..._lastEvictionWarnAt.keys()],
  /**
   * The shutdown path: end every pending evicted pool NOW (what the
   * `beforeExit` hook runs when the process leaves inside the grace window).
   */
  drainPending: async (): Promise<void> => {
    await drainPendingNow()
  },
  /**
   * PG-free reset of every piece of registry state: entries, recency counter,
   * eviction-warn throttle, pending deferred drains AND the beforeExit hook.
   * The pending drains are ENDED, not merely cancelled - see drainPendingNow().
   * "Synchronous" is true of INVOCATION only: the end() calls start here and
   * settle on a later microtask, which is why the rejection is caught rather
   * than left to surface as an unhandled rejection in a later test.
   * Tests call this per test so none can inherit another's state or timers.
   */
  reset: (): void => {
    void drainPendingNow().catch(() => {})
    uninstallDrainOnExit()
    _poolMap.clear()
    _nextOrder = 0
    _nextDrainId = 0
    _lastEvictionWarnAt.clear()
    _evictionCount = 0
    _lastOverflowWarnAt = null
    _overflowCount = 0
    // A test that ran closeAllPools() latched the shutdown flag; leaving it set
    // would make every later storeFor() in the file reject for a reason that
    // has nothing to do with the test asserting it.
    _closing = false
    _controlSql = null
    _controlInitialized = false
    _controlInitPromise = null
  },
  /** Is the store latched shut by closeAllPools()? */
  closing: (): boolean => _closing,
  /**
   * Install a stand-in control-DB pool. The control pool is opened by
   * ensureControlDb() against a real Postgres, so proving closeAllPools() ends
   * it needs a seam - otherwise the one pool a running leaf always holds is the
   * one no PG-free test can cover.
   */
  setControl: (sql: Sql | null): void => {
    _controlSql = sql
    _controlInitialized = sql !== null
    _controlInitPromise = null
  },
  /** Does the store still hold a control pool? */
  hasControl: (): boolean => _controlSql !== null,
  /** Direct handle on the control-DB initializer (for the shutdown guard). */
  ensureControl: (adminUrl: string, dbPrefix: string): Promise<Sql> =>
    ensureControlDb(adminUrl, dbPrefix),
}

// ── slug validation ───────────────────────────────────────────────────────────

/**
 * Mirrors the kernel's SLUG_PATTERN with the additional no-leading/trailing
 * hyphen constraint. Anchored so a malformed slug never reaches CREATE DATABASE.
 */
const SLUG_PATTERN = /^[a-z0-9]([a-z0-9-]{0,28}[a-z0-9])?$/

function assertValidSlug(slug: string): void {
  if (slug.length === 0 || slug.length > 30 || !SLUG_PATTERN.test(slug)) {
    throw new InvalidTenantSlugError(
      `[tenant-store] invalid tenant slug "${slug}": ` +
        `slug must be 1–30 lowercase alphanumeric characters (a-z, 0-9, hyphen), ` +
        `must not start or end with a hyphen. ` +
        `Refusing to build a database name from this value.`,
    )
  }
  // <prefix>control is the catalog database. A tenant with the slug `control`
  // would be handed the catalog as its own database (board's B2b).
  if (RESERVED_SLUGS.has(slug)) {
    throw new InvalidTenantSlugError(
      `[tenant-store] invalid tenant slug "${slug}": reserved (<prefix>${slug} is the catalog database).`,
    )
  }
}

/** Slugs whose <prefix><slug> is not a tenant database. */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set(['control'])

/** Databases every cluster has, whatever the admin url names: never a tenant's. */
const CLUSTER_DATABASES: ReadonlySet<string> = new Set(['postgres', 'template0', 'template1'])

/**
 * storeFor never hands out a pool on the maintenance database named by the admin
 * url (its own path), nor on postgres or a template database (board's B2d). With
 * an empty prefix a slug such as `postgres` would otherwise name one of them.
 */
function assertNotMaintenanceDb(adminUrl: string, dbName: string): void {
  const maintenance = decodeURIComponent(new URL(adminUrl).pathname.slice(1))
  if (dbName === maintenance || CLUSTER_DATABASES.has(dbName)) {
    throw new Error(
      `[tenant-store] refusing to serve the maintenance database "${dbName}" of the admin url as a tenant database`,
    )
  }
}

/**
 * A tenant id as Postgres renders a uuid (canonical, lowercase). The catalog
 * comparison is on tenant_id::text, so this is the store's own floor: any other
 * spelling is refused before a catalog row or a database is touched.
 */
const TENANT_ID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// ── control DB state ──────────────────────────────────────────────────────────

let _controlSql: Sql | null = null
let _controlInitialized = false
let _controlInitPromise: Promise<Sql> | null = null

// ── migration manifest cache ──────────────────────────────────────────────────

let _manifestCache: Record<string, string> | null = null

async function loadManifest(override?: Record<string, string>): Promise<Record<string, string>> {
  if (override !== undefined) return override
  if (_manifestCache !== null) return _manifestCache
  let raw: string
  try {
    raw = await readFile(MANIFEST_FILE, 'utf-8')
  } catch (err) {
    throw new Error(
      `[tenant-store] failed to read migration manifest at ${MANIFEST_FILE}: ${String(err)}`,
    )
  }
  _manifestCache = JSON.parse(raw) as Record<string, string>
  return _manifestCache
}

// ── internal helpers ──────────────────────────────────────────────────────────

/** Build a postgres URL pointing at a specific database on the same server. */
function dbUrlFor(adminUrl: string, dbName: string): string {
  const u = new URL(adminUrl)
  u.pathname = '/' + dbName
  return u.toString()
}

function sha256hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

/**
 * Ensure the control DB (`finance_control` / `finance_control_test`) exists and
 * the `tenant_catalog` table is present. Idempotent + concurrency-guarded.
 */
async function ensureControlDb(adminUrl: string, dbPrefix: string): Promise<Sql> {
  // The control pool re-opens itself on demand, so without this the shutdown
  // drain ends it and the very next listTenants() opens a replacement that
  // nothing will ever close.
  if (_closing) throw new ShuttingDownError('ensureControlDb()')

  if (_controlSql !== null && _controlInitialized) return _controlSql
  if (_controlInitPromise !== null) return _controlInitPromise

  const attempt = (async (): Promise<Sql> => {
    const controlDbName = dbPrefix + 'control'
    const controlUrl = dbUrlFor(adminUrl, controlDbName)

    const admin = postgres(adminUrl, { max: 1, prepare: false })
    try {
      const exists = await admin<{ count: string }[]>`
        SELECT count(*) AS count FROM pg_database WHERE datname = ${controlDbName}
      `
      if (Number(exists[0].count) === 0) {
        await admin.unsafe(`CREATE DATABASE "${controlDbName}"`)
      }
    } finally {
      await admin.end()
    }

    const ctrl = postgres(controlUrl, { max: 2, prepare: true })
    try {
      await ctrl.unsafe(`
        CREATE TABLE IF NOT EXISTS tenant_catalog (
          tenant_id  UUID PRIMARY KEY,
          slug       TEXT NOT NULL UNIQUE,
          db_name    TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `)
    } catch (err) {
      // Retry is now possible (see below), so a failed attempt MUST NOT leak
      // its pool — otherwise every retry would strand another connection pool.
      await ctrl.end().catch(() => {})
      throw err
    }

    _controlSql = ctrl
    _controlInitialized = true
    return ctrl
  })()

  // Cache the IN-FLIGHT promise so concurrent callers share a single init
  // (no thundering herd), but DROP it the moment it rejects so the next caller
  // starts a fresh attempt.
  //
  // Caching a rejected promise here is what took the finance leaf down on
  // 2026-07-28: one lost boot race against finance-postgres (PostgresError
  // 57P03, "the database system is starting up") was replayed to every
  // subsequent request for ~13 hours while /healthz still answered ok.
  // See test/tenant-store.init-retry.test.ts.
  _controlInitPromise = attempt
  attempt.catch(() => {
    if (_controlInitPromise === attempt) _controlInitPromise = null
  })

  return attempt
}

/**
 * Refuse unless every catalog row naming this tenant's id OR its slug is
 * exactly (id, slug). Returns how many rows matched (0 or 1).
 */
async function assertCatalogBinding(ctrl: Sql, tenant: TenantRef): Promise<number> {
  const rows = await ctrl.unsafe<{ tenant_id: string; slug: string }[]>(
    `SELECT tenant_id::text AS tenant_id, slug FROM tenant_catalog WHERE tenant_id = $1 OR slug = $2`,
    [tenant.id, tenant.slug],
  )
  for (const row of rows) {
    if (row.tenant_id !== tenant.id || row.slug !== tenant.slug) {
      throw new TenantIdentityMismatchError(tenant, { id: row.tenant_id, slug: row.slug })
    }
  }
  return rows.length
}

/**
 * Bind (id, slug) in the catalog BEFORE any database is created. Replaces the
 * blind upsert, which followed a changed slug and so rebound a renamed tenant to
 * a new, empty database.
 *   - a row for the id with another slug, or for the slug with another id:
 *     TenantIdentityMismatchError, nothing written;
 *   - no row: INSERT … ON CONFLICT DO NOTHING (a concurrent claim of the same
 *     id or slug by another pair loses here), then re-check, so the pair that
 *     proceeds is the one the catalog holds.
 */
async function claimCatalog(ctrl: Sql, tenant: TenantRef, dbName: string): Promise<void> {
  if ((await assertCatalogBinding(ctrl, tenant)) === 1) return
  await ctrl.unsafe(
    `INSERT INTO tenant_catalog (tenant_id, slug, db_name)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [tenant.id, tenant.slug, dbName],
  )
  if ((await assertCatalogBinding(ctrl, tenant)) !== 1) {
    throw new Error(`[tenant-store] catalog claim for (${tenant.id}, ${tenant.slug}) did not land - refusing`)
  }
}

async function ensureTenantDb(adminUrl: string, dbName: string): Promise<void> {
  const admin = postgres(adminUrl, { max: 1, prepare: false })
  try {
    const exists = await admin<{ count: string }[]>`
      SELECT count(*) AS count FROM pg_database WHERE datname = ${dbName}
    `
    if (Number(exists[0].count) === 0) {
      await admin.unsafe(`CREATE DATABASE "${dbName}"`)
    }
  } finally {
    await admin.end()
  }
}

/**
 * Run the leaf migrations against a per-tenant DB pool. Manifest-hash pattern
 * (G-012): verify SHA-256 of every *.sql against manifest.json BEFORE running
 * any SQL (fail-closed), then run each in order inside a single transaction.
 */
async function runMigrations(sql: Sql, overrideManifest?: Record<string, string>): Promise<void> {
  const manifest = await loadManifest(overrideManifest)

  let entries: string[]
  try {
    entries = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort()
  } catch (err) {
    throw new Error(`[tenant-store] failed to read migrations dir: ${String(err)}`)
  }

  for (const file of entries) {
    const expected = manifest[file]
    if (expected === undefined) {
      throw new Error(
        `[tenant-store] migration file "${file}" has no entry in manifest.json — ` +
          `run scripts/build-migration-manifest.mjs to regenerate the manifest.`,
      )
    }
    const buf = await readFile(path.join(MIGRATIONS_DIR, file))
    const actual = sha256hex(buf)
    if (actual !== expected) {
      throw new Error(
        `[tenant-store] manifest hash mismatch for ${file} — ` +
          `manifest says ${expected}, on-disk hash is ${actual}. ` +
          `Migration aborted (fail-closed). ` +
          `If you edited a migration file, run scripts/build-migration-manifest.mjs.`,
      )
    }
  }

  for (const file of entries) {
    const sqlText = await readFile(path.join(MIGRATIONS_DIR, file), 'utf-8')
    const stripped = sqlText
      .replace(/^\s*BEGIN\s*;?\s*/im, '')
      .replace(/\s*COMMIT\s*;?\s*$/im, '')
    await sql.begin(async (tx) => {
      await tx.unsafe(stripped)
    })
  }
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Return a ready postgres-js Sql instance for the given tenant, creating the
 * database + running migrations if this is the first contact. Two calls with the
 * same tenant.id return the SAME Sql instance until the pool is evicted/reset.
 *
 * Identity BINDING: on every call the (id, slug) pair must be the one the
 * catalog holds — checked on the warm path against the registry entry's slug and
 * on a cold miss against the catalog — else TenantIdentityMismatchError, with no
 * database created and nothing upserted. The database name is derived from the
 * slug alone, so a pair the catalog does not bind must never reach it.
 */
export async function storeFor(tenant: TenantRef, options: StoreForOptions = {}): Promise<Sql> {
  // Checked BEFORE the cache lookup: after closeAllPools() the registry is empty, so
  // every call would otherwise fall through to opening a fresh pool behind the drain.
  if (_closing) throw new ShuttingDownError(`storeFor(${tenant.slug})`)

  // The entry keeps the catalog slug: a warm hit is refused unless the
  // request's slug is the bound one — without this the binding would be
  // checked on a cold cache only.
  const existing = getEntry(tenant.id)
  if (existing) {
    if (existing.slug !== tenant.slug) {
      throw new TenantIdentityMismatchError(tenant, { id: tenant.id, slug: existing.slug })
    }
    return existing.sql
  }

  const pgUrl = requireRuntimePgUrl(options.pgUrl, 'FINANCE_PG_URL')
  const dbPrefix = options.dbPrefix ?? DEFAULT_DB_PREFIX

  // The catalog comparison is on tenant_id::text (canonical lowercase): refuse
  // any other spelling before a catalog row or a database is touched.
  if (!TENANT_ID_TEXT.test(tenant.id)) throw new InvalidTenantIdError()

  assertValidSlug(tenant.slug)

  const dbName = dbPrefix + tenant.slug
  assertNotMaintenanceDb(pgUrl, dbName)

  const ctrl = await ensureControlDb(pgUrl, dbPrefix)
  // Bind (id, slug) in the catalog BEFORE any database is created.
  await claimCatalog(ctrl, tenant, dbName)
  await ensureTenantDb(pgUrl, dbName)

  const tenantUrl = dbUrlFor(pgUrl, dbName)
  const sql = postgres(tenantUrl, { max: 4, prepare: true, idle_timeout: 20, connect_timeout: 10 })

  try {
    await runMigrations(sql, options._overrideManifest)
  } catch (err) {
    await sql.end().catch(() => {})
    throw err
  }

  setPool(tenant.id, sql, tenant.slug)

  return sql
}

/**
 * List all tenants registered in the control DB catalog. Used by the scheduler
 * (none in this slice) and the /healthz/tenants handler.
 */
export async function listTenants(options: StoreForOptions = {}): Promise<TenantRef[]> {
  const pgUrl = requireRuntimePgUrl(options.pgUrl, 'FINANCE_PG_URL')
  const dbPrefix = options.dbPrefix ?? DEFAULT_DB_PREFIX
  const ctrl = await ensureControlDb(pgUrl, dbPrefix)
  const rows = await ctrl<{ tenant_id: string; slug: string }[]>`
    SELECT tenant_id, slug FROM tenant_catalog ORDER BY created_at
  `
  return rows.map((r) => ({ id: r.tenant_id, slug: r.slug }))
}

// ── test helpers ──────────────────────────────────────────────────────────────

/** Drain every pool, clear the registry, and reset the control DB connection. */
export async function _resetTenantStoreForTests(): Promise<void> {
  const drains: Promise<void>[] = []
  for (const [, entry] of _poolMap) {
    drains.push(entry.sql.end().catch(() => {}))
  }
  _poolMap.clear()
  _nextOrder = 0
  // An explicit reset is not a capacity eviction: nothing is in flight, so the
  // deferred drains are cancelled and their pools ENDED here and now. Cancelling
  // the timer alone would orphan the handle - the evicted entry is already out
  // of _poolMap, so nothing else could ever end() it.
  drains.push(drainPendingNow().then(() => {}))
  _lastEvictionWarnAt.clear()
  _evictionCount = 0
  await Promise.all(drains)

  if (_controlSql !== null) {
    await _controlSql.end().catch(() => {})
    _controlSql = null
    _controlInitialized = false
  }
  _controlInitPromise = null
  // An integration test that exercised the shutdown path must not leave the
  // store latched shut for the next test in the file.
  _closing = false
  _lastOverflowWarnAt = null
  _overflowCount = 0

  _manifestCache = null
}
