// modules/calendar/src/tenant-store.ts
//
// Tenant→storage seam of the calendar leaf service.
//
// Where a customer's calendar lives. The module lifecycle (@gremion/tenant-store, lifecycle) owns one
// database per (customer, module): t_<tenant uuid as 32 hex>__calendar. enableModule creates and migrates
// it and grants the module's app role m_calendar_app its DML, disableModule exports it and blocks or drops
// it, the purge removes it. This leaf only OPENS that database, as m_calendar_app, through the package
// store (openTenantDb) behind its schema gate. It never creates, migrates or drops one, and it never
// reaches one with the module server's admin login: a block of the app role is then a block of the leaf.
// Customers were stored in calendar_<slug> databases before; scripts/move-to-lifecycle-db.mjs copies those
// into the lifecycle database (docs/ops/pilot-services.md).
//
// Responsibilities:
//  1. Customer pool: storeFor(tenant) -> the pool of t_<hex32>__calendar, or a typed refusal:
//       TenantNotProvisionedError  the database is gone (3D000) or blocked (42501, the module Karenz
//                                  revoked CONNECT from the app role): the module is switched off;
//       TenantUnavailableError     the schema is not current (the lifecycle migrates, the leaf never
//                                  does) or the server cannot be reached right now.
//  2. Control DB (`calendar_control`, created on first use with the admin url CALENDAR_PG_URL): holds
//     `tenant_catalog` (tenant_id, slug, db_name, created_at). It binds each tenant id to ONE slug and
//     lists the tenants the background loops (CalDAV drain, outbox relay) walk. It holds no calendar data.
//  3. Identity binding: the (id, slug) pair of every request must be the one the catalogue binds.
//
// The public API is intentionally narrow: callers (route handlers, the CalDAV ticker, the outbox relay)
// call `storeFor(tenant)` and get back a ready postgres-js Sql instance bound to that tenant's database.

import { fileURLToPath } from 'node:url'
import path from 'node:path'
import postgres from 'postgres'
import {
  createTenantStore,
  envResolveTarget,
  isUuidV7,
  moduleUrlVariable,
  schemaGate,
  tenantModuleDbName,
  type SchemaGate,
  type TenantStore,
} from '@gremion/tenant-store'

/** The module id of this leaf: the lifecycle names its databases t_<hex32>__calendar. */
export const MODULE_ID = 'calendar'

/**
 * Resolve the runtime Postgres URL, failing closed. In production CALENDAR_PG_URL (the module server's
 * admin login, used for the catalogue database only) and GREMION_CALENDAR_PG_URL (the module's app role,
 * used for every customer database) are set; we deliberately DO NOT fall back to localhost:5432 — on the
 * staging host that port is the LIVE kernel Postgres (#394 require-explicit-env posture). Fires only when
 * neither an explicit url nor the env var is set (a misconfiguration).
 */
export function requireRuntimePgUrl(explicit: string | undefined, envName: string): string {
  const url = explicit ?? process.env[envName]
  if (!url) {
    throw new Error(
      `[calendar] no Postgres URL configured — set ${envName} (or pass the url as an option). ` +
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
  /**
   * Admin PG URL of the module server. Used ONLY for the catalogue database `<dbPrefix>control`
   * (created on first use); never for a customer database.
   */
  pgUrl?: string
  /**
   * Name prefix of the catalogue database. Production = `calendar_`; tests override to
   * `calendar_test_` so all test databases are easily identified and never collide with a production
   * name. It takes no part in a customer database name.
   */
  dbPrefix?: string
  /**
   * The module server as customer pools reach it, logged in as the module's app role
   * (GREMION_CALENDAR_PG_URL). The database name in its path is replaced per customer.
   */
  moduleUrl?: string
}

/** A postgres-js Sql instance (the pool type). */
export type Sql = ReturnType<typeof postgres>

/**
 * Thrown by every pool-opening path once closeAllPools() has run.
 *
 * closeAllPools() is the SIGTERM drain. Without a latch, a request already in
 * flight when the signal landed re-enters storeFor(), finds nothing open, and
 * opens a brand-new pool BEHIND the drain that just closed everything -
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
 * binds: on a warm tenant (the store remembers the catalog slug) or on a cold
 * miss (a catalog row for the id with another slug, or for the slug with another
 * id). Nothing is upserted and no pool is handed out; the HTTP layer answers 409
 * tenant_identity_mismatch.
 *
 * The slug names the customer's CalDAV collection and its catalogue row, so a
 * store that follows a changed slug would push one customer's events into another
 * collection. A slug rename is an operator procedure (update the catalog row,
 * restart the leaf), never a side effect of a request. Same contract as the
 * board store's R29-BOARD-STORE-S B2c; audit #534.
 */
export class TenantIdentityMismatchError extends Error {
  readonly code = 'TENANT_IDENTITY_MISMATCH'
  constructor(tenant: TenantRef, bound: TenantRef) {
    super(
      `[tenant-store] tenant identity mismatch: request (${tenant.id}, ${tenant.slug}) vs ` +
        `catalogued (${bound.id}, ${bound.slug}) - refusing (nothing upserted)`,
    )
    this.name = 'TenantIdentityMismatchError'
  }
}

/**
 * The tenant id is not a canonical lowercase UUIDv7 (the kernel's tenant ids; the form the lifecycle
 * database name t_<hex32>__calendar is built from). The id keys the catalogue and the database name, so any
 * other spelling is refused before a catalog row, a database name or a pool is touched. The HTTP layer
 * answers 400 invalid_tenant_id; the message and the response name nothing the caller sent (follow-up to
 * audit #534).
 */
export class InvalidTenantIdError extends Error {
  readonly code = 'TENANT_ID_INVALID'
  constructor() {
    super('[tenant-store] tenant id is not a canonical lowercase UUIDv7 - refusing (nothing upserted)')
    this.name = 'InvalidTenantIdError'
  }
}

/** A slug storeFor refuses to bind (grammar, or reserved). */
export class InvalidTenantSlugError extends Error {
  readonly code = 'INVALID_TENANT_SLUG'
  constructor(message: string) {
    super(message)
    this.name = 'InvalidTenantSlugError'
  }
}

/**
 * The customer's calendar database does not exist or is blocked: the module is switched off for this
 * customer (disableModule dropped it, or the module Karenz revoked CONNECT from the app role), or it was
 * never enabled. The HTTP layer answers 404 tenant_not_provisioned. Nothing is created in its place.
 */
export class TenantNotProvisionedError extends Error {
  readonly code = 'TENANT_NOT_PROVISIONED'
  constructor() {
    super('[tenant-store] the calendar database of this tenant does not exist or is blocked - not provisioned')
    this.name = 'TenantNotProvisionedError'
  }
}

/**
 * The customer's calendar database cannot be used right now: its schema is behind or diverged from this
 * release's migrations (the lifecycle migrates, the leaf never does), or the server could not be
 * reached. The HTTP layer answers 503 with Retry-After.
 */
export class TenantUnavailableError extends Error {
  readonly code = 'TENANT_UNAVAILABLE'
  constructor(
    readonly reason: 'tenant_unavailable' | 'schema_not_current',
    readonly retryAfterSeconds: number,
  ) {
    super(`[tenant-store] the calendar database of this tenant cannot be used right now (${reason})`)
    this.name = 'TenantUnavailableError'
  }
}

/** Latched by closeAllPools(); cleared only by the test reset helpers. */
let _closing = false

// ── constants ─────────────────────────────────────────────────────────────────

/**
 * The module's migrations directory — resolved HERE, at src/ DEPTH 1, on purpose: esbuild bundles the
 * leaf into a SINGLE depth-1 file (dist/index.js), so one '..' resolves to <leaf>/migrations from the
 * source tree AND to /app/migrations from the bundle (the Dockerfile copies migrations → /app/migrations).
 * The schema gate reads its manifest.json from here.
 */
export const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations')

/** Customer pools kept open at once by the package store (the least recently used one is retired). */
const MAX_TENANT_POOLS = 64

/** Retry-After of a 503 (the schema gate's default). */
const RETRY_AFTER_SECONDS = 30

// ── slug validation ───────────────────────────────────────────────────────────

/**
 * Mirrors the kernel's SLUG_PATTERN from gremion-ui/src/lib/server/tenant/slug.ts,
 * with the additional constraint from the brief: no leading or trailing hyphen.
 * Anchored: ^[a-z0-9][a-z0-9-]{0,28}[a-z0-9]$  (2–30 chars with interior hyphens)
 * OR        ^[a-z0-9]$                            (1 char, no hyphen needed)
 */
const SLUG_PATTERN = /^[a-z0-9]([a-z0-9-]{0,28}[a-z0-9])?$/

/**
 * Validate the tenant slug before it is bound in the catalogue or used to name a CalDAV collection.
 * Throws with a clear message on any mismatch.
 */
function assertValidSlug(slug: string): void {
  if (slug.length === 0 || slug.length > 30 || !SLUG_PATTERN.test(slug)) {
    throw new InvalidTenantSlugError(
      `[tenant-store] invalid tenant slug "${slug}": ` +
        `slug must be 1–30 lowercase alphanumeric characters (a-z, 0-9, hyphen), ` +
        `must not start or end with a hyphen. ` +
        `Refusing to bind this value.`,
    )
  }
  // <prefix>control is the catalog database. A tenant with the slug `control` would
  // be confused with it (board's B2b); the kernel does not issue it either.
  if (RESERVED_SLUGS.has(slug)) {
    throw new InvalidTenantSlugError(
      `[tenant-store] invalid tenant slug "${slug}": reserved (<prefix>${slug} is the catalog database).`,
    )
  }
}

/** Slugs that name the catalogue database, never a tenant. */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set(['control'])

// ── customer databases: the package store behind the schema gate ──────────────

interface TenantDbs {
  /** What the pools were built for: a changed module url builds new ones. */
  readonly moduleUrl: string
  readonly store: TenantStore
  readonly gate: SchemaGate
}

let _dbs: TenantDbs | null = null

/** The slug each tenant id is bound to in THIS process (the warm half of the identity binding). */
const _boundSlug = new Map<string, string>()

function tenantDbs(options: StoreForOptions): TenantDbs {
  const moduleUrl = requireRuntimePgUrl(options.moduleUrl, moduleUrlVariable(MODULE_ID))
  if (_dbs !== null && _dbs.moduleUrl === moduleUrl) return _dbs
  // A new module url (tests only): the pools of the old one are drained in the background.
  const old = _dbs
  if (old !== null) void old.store.close().catch(() => {})
  const store = createTenantStore({
    resolveTarget: envResolveTarget({ [moduleUrlVariable(MODULE_ID)]: moduleUrl }),
    maxPools: MAX_TENANT_POOLS,
  })
  const gate = schemaGate({ dir: MIGRATIONS_DIR, openDb: (tenantId) => store.openTenantDb(tenantId, MODULE_ID) })
  _dbs = { moduleUrl, store, gate }
  return _dbs
}

function sqlstateOf(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  const code = (err as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/**
 * The SQLSTATEs of a tenant database that cannot be connected to because the module is off: it is gone
 * (3D000, dropped) or blocked (42501, the module Karenz revoked CONNECT from the app role). Only
 * meaningful for a failure of the CONNECTION (or of `SELECT 1`), never for a query that needs a table
 * privilege.
 */
export function isTenantDatabaseOff(err: unknown): boolean {
  const code = sqlstateOf(err)
  return code === '3D000' || code === '42501'
}

/**
 * Errors that mean "the connection went away under the query", not "the query was wrong": the server
 * terminated the backend (57P01 admin shutdown — what DROP DATABASE ... WITH (FORCE) does to a disabled
 * tenant's pool —, 57P02 crash shutdown, 57P03 cannot connect now) or postgres-js lost the socket.
 */
const CONNECTION_LOST: ReadonlySet<string> = new Set([
  '57P01',
  '57P02',
  '57P03',
  'CONNECTION_CLOSED',
  'CONNECTION_ENDED',
  'CONNECTION_DESTROYED',
  'CONNECT_TIMEOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
])

/**
 * What a failure of a QUERY on a customer pool says about the tenant's database, for the route layer:
 * the database is gone (3D000: the module was just switched off) -> not provisioned; the connection was
 * lost under the query (a drop with FORCE, a restart) -> unavailable, retry. Anything else is not the
 * database's availability and returns null (the caller treats it as the fault it is).
 */
export function classifyQueryFailure(err: unknown): TenantNotProvisionedError | TenantUnavailableError | null {
  const code = sqlstateOf(err)
  if (code === '3D000') return new TenantNotProvisionedError()
  if (code !== undefined && CONNECTION_LOST.has(code)) return new TenantUnavailableError('tenant_unavailable', RETRY_AFTER_SECONDS)
  return null
}

/**
 * The tenant's pool, or why it cannot be had. Fail closed, nothing created:
 *   gate ok                              -> the tenant's pool
 *   gate behind | diverged               -> TenantUnavailableError schema_not_current (the leaf never migrates)
 *   gate unavailable -> classify, with SELECT 1 on the tenant pool:
 *     3D000 (no database) | 42501 at connect (blocked) -> TenantNotProvisionedError
 *     anything else                                      -> TenantUnavailableError tenant_unavailable
 */
async function openLifecycleDb(dbs: TenantDbs, tenantId: string): Promise<Sql> {
  const verdict = await dbs.gate.check(tenantId)
  if (verdict.ok) return (await dbs.store.openTenantDb(tenantId, MODULE_ID)) as Sql
  if (verdict.reason !== 'unavailable') throw new TenantUnavailableError('schema_not_current', verdict.retryAfterSeconds)
  try {
    const sql = await dbs.store.openTenantDb(tenantId, MODULE_ID)
    await sql`SELECT 1`
  } catch (err) {
    if (isTenantDatabaseOff(err)) throw new TenantNotProvisionedError()
  }
  throw new TenantUnavailableError('tenant_unavailable', verdict.retryAfterSeconds)
}

// ── control DB state ──────────────────────────────────────────────────────────

let _controlSql: Sql | null = null
let _controlInitialized = false
/** In-flight init Promise so concurrent first callers await the same work. */
let _controlInitPromise: Promise<Sql> | null = null

// ── internal helpers ──────────────────────────────────────────────────────────

/** Build a postgres URL pointing at a specific database on the same server. */
function dbUrlFor(adminUrl: string, dbName: string): string {
  const u = new URL(adminUrl)
  u.pathname = '/' + dbName
  return u.toString()
}

function firstContactKey(tenant: TenantRef, pgUrl: string, dbPrefix: string, moduleUrl: string): string {
  return JSON.stringify([tenant.id, tenant.slug, pgUrl, dbPrefix, moduleUrl])
}

// ── the catalogue database: serialise its creation ────────────────────────────
//
// The catalogue database is created on first use. Two processes (an old and a new colour, two replicas)
// that meet it missing must not both run CREATE DATABASE: the loser dies with 23505 on
// pg_database_datname_index (or 42P04) and its caller used to get a 500. Three layers, each covering what
// the one before cannot see:
//   1. in this process, concurrent first requests for one customer share ONE flight (_firstContact);
//   2. across processes, CREATE DATABASE runs under a session advisory lock held on the maintenance
//      database, and the catalogue table under a transaction lock held on the catalogue database;
//   3. a duplicate-database error that still arrives (a creator that takes no lock: an older
//      colour) means the database exists, which is what the caller wanted: it is not a failure.

/** Hashed to a bigint in SQL (hashtextextended). One lock for every CREATE DATABASE on the server:
 *  concurrent creations of DIFFERENT databases also fight over the template (55006). */
const CREATE_DB_LOCK = 'gremion.leaf.create-database'
/** The lock the catalogue table creation runs under. */
const FIRST_CONTACT_LOCK = 'gremion.leaf.first-contact'
/** Bound of every wait for those locks (lock_timeout): a stuck holder ends the wait with 55P03. */
const FIRST_CONTACT_LOCK_TIMEOUT_MS = 30_000
/** Pause between the retries of a CREATE DATABASE that found the template busy. */
const TEMPLATE_BUSY_RETRY_MS = 250
const TEMPLATE_BUSY_MAX_ATTEMPTS = 4

/** CREATE DATABASE lost a race to another creator of the same name. */
function isDuplicateDatabase(err: unknown): boolean {
  const code = sqlstateOf(err)
  if (code === '42P04') return true // duplicate_database
  if (code !== '23505') return false
  const constraint = (err as { constraint_name?: unknown }).constraint_name
  return constraint === 'pg_database_datname_index'
}

/** CREATE DATABASE found template1 in use by another creator (55006, object_in_use): retry. */
function isTemplateBusy(err: unknown): boolean {
  return sqlstateOf(err) === '55006'
}

/**
 * Make sure database `dbName` exists. Safe to call concurrently, from this process and from others:
 * exactly one caller creates it, the rest find it there. Only the catalogue database is made here.
 */
async function createDatabaseIfMissing(adminUrl: string, dbName: string): Promise<void> {
  const admin = postgres(adminUrl, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    onnotice: () => {},
    connection: { lock_timeout: FIRST_CONTACT_LOCK_TIMEOUT_MS },
  })
  const exists = async (): Promise<boolean> => {
    const rows = await admin<{ count: string }[]>`
      SELECT count(*) AS count FROM pg_database WHERE datname = ${dbName}
    `
    return Number(rows[0].count) > 0
  }
  try {
    // The ordinary case: the database is there. No lock, so nothing here ever queues behind
    // somebody else's slow CREATE DATABASE.
    if (await exists()) return
    // Missing: create it under the server-wide lock (held on this connection, released with it) and
    // look again, because the holder before us may just have created it.
    await admin`SELECT pg_advisory_lock(hashtextextended(${CREATE_DB_LOCK}, 0))`
    if (await exists()) return
    for (let attempt = 1; ; attempt++) {
      try {
        await admin.unsafe(`CREATE DATABASE "${dbName}"`)
        return
      } catch (err) {
        if (isDuplicateDatabase(err)) return
        if (isTemplateBusy(err) && attempt < TEMPLATE_BUSY_MAX_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, TEMPLATE_BUSY_RETRY_MS * attempt))
          continue
        }
        throw err
      }
    }
  } finally {
    await admin.end({ timeout: 5 }).catch(() => {})
  }
}

/**
 * First contacts in flight, keyed by everything that decides the outcome (customer id and slug, the
 * server, the prefix, the module url). Concurrent callers with the same key await the same promise,
 * so the work exists once; a caller with another slug for the same id gets its own flight and meets
 * the catalog binding (TenantIdentityMismatchError), not a borrowed pool.
 */
const _firstContact = new Map<string, Promise<Sql>>()

/**
 * Ensure the control DB (`calendar_control` / `calendar_test_control`)
 * exists and the `tenant_catalog` table is present. Idempotent.
 *
 * Promise-guard: if two concurrent callers arrive before initialization
 * completes, both await the same in-flight Promise so initialization runs
 * exactly once and no admin connection is leaked.
 */
async function ensureControlDb(adminUrl: string, dbPrefix: string): Promise<Sql> {
  // The control pool re-opens itself on demand, so without this the shutdown
  // drain ends it and the very next listTenants() opens a replacement that
  // nothing will ever close.
  if (_closing) throw new ShuttingDownError('ensureControlDb()')

  // Fast path: already initialized.
  if (_controlSql !== null && _controlInitialized) return _controlSql

  // Concurrent-call guard: if init is already in flight, await it.
  if (_controlInitPromise !== null) return _controlInitPromise

  // First caller: create and store the in-flight Promise immediately so any
  // concurrent second caller finds it and awaits rather than starting a second init.
  const attempt = (async (): Promise<Sql> => {
    const controlDbName = dbPrefix + 'control'
    const controlUrl = dbUrlFor(adminUrl, controlDbName)

    // 1. CREATE the control DB if it doesn't exist. Must connect to the admin
    //    maintenance DB (the URL as-is) because CREATE DATABASE cannot run
    //    inside a transaction and must be issued from a different database.
    //    Two processes starting together race here; createDatabaseIfMissing serialises them.
    await createDatabaseIfMissing(adminUrl, controlDbName)

    // 2. Connect to the control DB and ensure the catalog table.
    const ctrl = postgres(controlUrl, { max: 2, prepare: true })
    try {
      // Concurrent CREATE TABLE IF NOT EXISTS from two processes can still collide on the catalogue
      // (42P07, 23505 on pg_type): run it under a transaction-level first-contact lock, on the pool
      // itself (no extra connection, and the lock cannot outlive the statement).
      await ctrl.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${FIRST_CONTACT_LOCK}, 0))`
        await tx.unsafe(`
          CREATE TABLE IF NOT EXISTS tenant_catalog (
            tenant_id  UUID PRIMARY KEY,
            slug       TEXT NOT NULL UNIQUE,
            db_name    TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
          )
        `)
      })
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
  // Caching a rejected promise here is what took the FINANCE leaf — which
  // carries this same seam — down on 2026-07-28: one lost boot race against its
  // Postgres (PostgresError 57P03, "the database system is starting up") was
  // replayed to every subsequent request for ~13 hours while /healthz still
  // answered ok. See test/tenant-store.init-retry.test.ts.
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
 * Bind (id, slug) in the catalog. Replaces the blind upsert, which followed a changed slug and so
 * rebound a renamed tenant.
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

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Return a ready postgres-js Sql instance for the given tenant: the pool of its lifecycle database
 * t_<hex32>__calendar, as the module's app role. Nothing is created or migrated here; a database that
 * is missing, blocked or not current is a typed refusal (TenantNotProvisionedError, TenantUnavailableError).
 *
 * Identity BINDING: on every call the (id, slug) pair must be the one the catalog holds — checked on the
 * warm path against the slug this process bound, and on a cold miss against the catalog — else
 * TenantIdentityMismatchError, with nothing upserted. A tenant whose database is refused is not entered
 * in the catalogue.
 *
 * @param tenant   Minimal tenant identity (id + slug).
 * @param options  Runtime config. In production the defaults (env vars) apply;
 *                 in tests, pass pgUrl / dbPrefix / moduleUrl.
 */
export async function storeFor(tenant: TenantRef, options: StoreForOptions = {}): Promise<Sql> {
  // Checked BEFORE anything is opened: after closeAllPools() every call would otherwise open a fresh
  // pool behind the drain.
  if (_closing) throw new ShuttingDownError(`storeFor(${tenant.slug})`)

  // The id is the storage key (t_<hex32>__calendar) and the catalogue key: refuse any other spelling
  // before a catalog row, a database name or a pool is touched.
  if (typeof tenant.id !== 'string' || !isUuidV7(tenant.id)) throw new InvalidTenantIdError()

  // Validate slug before it is bound or handed to a CalDAV collection name.
  assertValidSlug(tenant.slug)

  // Warm: the slug this process bound for the id must be the request's. Without this the binding would
  // be checked on a cold start only.
  const bound = _boundSlug.get(tenant.id)
  if (bound !== undefined) {
    if (bound !== tenant.slug) throw new TenantIdentityMismatchError(tenant, { id: tenant.id, slug: bound })
    return openLifecycleDb(tenantDbs(options), tenant.id)
  }

  const pgUrl = requireRuntimePgUrl(options.pgUrl, 'CALENDAR_PG_URL')
  const dbPrefix = options.dbPrefix ?? 'calendar_'
  const dbs = tenantDbs(options)

  // Concurrent first requests for one customer (and the other processes) share one flight.
  const key = firstContactKey(tenant, pgUrl, dbPrefix, dbs.moduleUrl)
  const running = _firstContact.get(key)
  if (running !== undefined) return running
  const flight: Promise<Sql> = openFirstContact(tenant, pgUrl, dbPrefix, dbs).finally(() => {
    if (_firstContact.get(key) === flight) _firstContact.delete(key)
  })
  _firstContact.set(key, flight)
  return flight
}

/** The cold path of storeFor: check the binding, open the lifecycle database, then claim the catalogue row. */
async function openFirstContact(tenant: TenantRef, pgUrl: string, dbPrefix: string, dbs: TenantDbs): Promise<Sql> {
  // 1. Ensure the control DB + tenant_catalog table (idempotent).
  const ctrl = await ensureControlDb(pgUrl, dbPrefix)

  // 2. A pair the catalogue does not bind is refused before the customer database is touched.
  await assertCatalogBinding(ctrl, tenant)

  // 3. Open the customer's lifecycle database. A refusal leaves the catalogue untouched.
  const sql = await openLifecycleDb(dbs, tenant.id)

  // 4. Bind (id, slug) in the catalogue (insert-if-absent), naming the lifecycle database.
  await claimCatalog(ctrl, tenant, tenantModuleDbName(tenant.id, MODULE_ID))

  _boundSlug.set(tenant.id, tenant.slug)
  return sql
}

// ── shutdown ──────────────────────────────────────────────────────────────────

export interface PoolDrainCounts {
  /** Customer pools ended. */
  readonly live: number
  /** Retained for the log line's shape: the package store owns eviction, nothing is pending here. */
  readonly evicted: number
  /** The control-DB pool: 1 once the leaf has booted, 0 before. */
  readonly control: number
  /** Pools whose end() REJECTED — every one of these is a leaked connection. */
  readonly failed: number
}

/**
 * PUBLIC shutdown seam: end EVERY pool this process holds, the customer pools (through the package
 * store) and the control-DB pool. This is what the leaf's shutdown handler awaits.
 */
export async function closeAllPools(): Promise<PoolDrainCounts> {
  // Set FIRST: an in-flight request that lands mid-drain would otherwise open a
  // fresh pool behind the drain that just closed everything, and nothing would
  // ever close that one — the process exits seconds later.
  _closing = true

  const dbs = _dbs
  _dbs = null
  _boundSlug.clear()
  const live = dbs?.store.size() ?? 0

  // The CONTROL pool is never evicted, so a drain that walks only the customer pools misses the one pool
  // a running leaf is guaranteed to hold. Detach it before ending it so nothing can hand it out.
  const control = _controlSql
  _controlSql = null
  _controlInitialized = false
  _controlInitPromise = null

  let failed = 0
  await Promise.all([
    dbs === null
      ? Promise.resolve()
      : dbs.store.close().catch((err: unknown) => {
          failed++
          console.error('[tenant-store] closing the customer pools failed:', err instanceof Error ? err.message : String(err))
        }),
    control === null
      ? Promise.resolve()
      : control.end({ timeout: 5 }).catch((err: unknown) => {
          failed++
          console.error('[tenant-store] closing the control pool failed:', err instanceof Error ? err.message : String(err))
        }),
  ])

  const counts: PoolDrainCounts = { live, evicted: 0, control: control === null ? 0 : 1, failed }
  // REAL counts, not a bare "drained": a rejected end() used to be swallowed
  // into a resolved promise and the shutdown logged success over the top of
  // leaked connections.
  console.log(
    `[tenant-store] closeAllPools: live=${counts.live} evicted=${counts.evicted} ` +
      `control=${counts.control} failed=${counts.failed}`,
  )
  return counts
}

// ── public: list tenants from the control catalog ─────────────────────────────

/**
 * List all tenants registered in the control DB catalog.
 *
 * Used by the CalDAV sync ticker (listTenants DI), the outbox relay and the /healthz/tenants
 * handler. Calls ensureControlDb() first (idempotent) so the control DB is
 * initialized on demand — safe to call at any point after boot.
 *
 * A listed tenant whose module is switched off is refused by storeFor (TenantNotProvisionedError);
 * the loops skip it for that pass.
 *
 * Returns an empty array (not an error) if the catalog exists but has no rows.
 */
export async function listTenants(options: StoreForOptions = {}): Promise<TenantRef[]> {
  const pgUrl = requireRuntimePgUrl(options.pgUrl, 'CALENDAR_PG_URL')
  const dbPrefix = options.dbPrefix ?? 'calendar_'
  const ctrl = await ensureControlDb(pgUrl, dbPrefix)
  const rows = await ctrl<{ tenant_id: string; slug: string }[]>`
    SELECT tenant_id, slug FROM tenant_catalog ORDER BY created_at
  `
  return rows.map((r) => ({ id: r.tenant_id, slug: r.slug }))
}

// ── test helpers ──────────────────────────────────────────────────────────────

/**
 * Drain every pool, clear the state, and reset the control DB connection.
 *
 * TEST-ONLY. Awaitable so tests can wait for drains to complete before dropping DBs.
 */
export async function _resetTenantStoreForTests(): Promise<void> {
  const dbs = _dbs
  _dbs = null
  _boundSlug.clear()
  _firstContact.clear()
  if (dbs !== null) await dbs.store.close().catch(() => {})

  // Drain + reset the control DB connection.
  if (_controlSql !== null) {
    await _controlSql.end().catch(() => {})
    _controlSql = null
    _controlInitialized = false
  }
  _controlInitPromise = null
  // An integration test that exercised the shutdown path must not leave the
  // store latched shut for the next test in the file.
  _closing = false
}
