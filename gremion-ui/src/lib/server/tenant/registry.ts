// src/lib/server/tenant/registry.ts
// P2.1a — typed read/write over the control-DB Tenant Registry (spec §3.1).
// Reads ONLY the control pool (getControlDb) — never a tenant data-plane pool,
// never the ALS resolver. The ledger functions mirror ledger.ts's idempotency
// pattern at tenant granularity, keyed by (tenant_id, subsystem).
import { getControlDb } from './control-db'
import { validateSlug } from './slug'
import { normaliseHost } from './host'
import {
  TENANT_EVICT_CHANNEL,
  type TenantDomain,
  type AddTenantDomainOptions,
  listAllTenantDomains as tdListAll,
  listTenantDomains as tdList,
  primaryHostForTenant as tdPrimaryHostForTenant,
  readPrimaryHost as tdReadPrimaryHost,
  addTenantDomain as tdAdd,
  removeTenantDomain as tdRemove,
  setPrimaryDomain as tdSetPrimary,
} from './tenant-domain'
import { evictTenantRateLimit } from './rate-limit'
import { clampConnProfile } from './conn-profile'
import { resolveSecret } from './secrets'
import { getPoolForTenant, evictTenantPool } from '$lib/server/db/pool-registry'
import { getKeycloakAdminClient, evictKeycloakAdminClient } from '$lib/server/keycloak-admin'
import { readConfig } from '$lib/server/config'
import { brandFromConfig } from '$lib/server/brand'
import { parseAudiences } from '$lib/auth/audience'
import { evictJwks } from '$lib/server/jwt-verify'
import { evictDisplayNameResolver } from '$lib/server/identity/display-names'
import { evictTenantMail } from '$lib/server/mail/tenant-mail'
import { runTenantEvictHooks } from '$lib/server/modules/runtime-registry'
import type { TenantContext } from './context'

export type TenantStatus = 'provisioning' | 'active' | 'suspended' | 'deleting' | 'deleted'
export type TenantSubsystem = 'db' | 'realm' | 'nextcloud' | 'matrix'
export type ResourceStatus = 'pending' | 'ok' | 'failed'

export interface Tenant {
  readonly id: string
  readonly slug: string
  readonly status: TenantStatus
  readonly dbConnRef: string
  readonly realmName: string
  readonly issuer: string
  readonly kcInternal: string
  readonly kcClientId: string
  readonly kcClientRef: string
  /** MJ-secret: the UI-client (gremion-ui) secret ref — used by the Auth.js provider,
   *  distinct from kcClientRef (the admin client secret used by KeycloakAdminClient). */
  readonly authClientRef: string
  readonly ncTarget: Record<string, unknown>
  readonly matrixSpace: Record<string, unknown>
  readonly domainProfile: Record<string, unknown>
  readonly brandRef: string
  readonly blueprintRef: string
  readonly connProfile: Record<string, unknown>
  readonly backupKeyRef: string
  readonly audiences: readonly string[]
  readonly createdAt: Date
  readonly updatedAt: Date
}

export type TenantInput = Omit<Tenant, 'id' | 'createdAt' | 'updatedAt'>

// RAW DB row shape (snake_case by design), distinct from the camelCased `Tenant`
// type which is hydrated from its row via hydrate().
export interface TenantProvisioningResource {
  readonly tenant_id: string
  readonly subsystem: TenantSubsystem
  readonly status: ResourceStatus
  readonly external_id: string | null
  readonly attempts: number
  readonly last_error: string | null
  readonly synced_at: Date | null
}

interface TenantRow {
  id: string; slug: string; status: TenantStatus
  db_conn_ref: string; realm_name: string; issuer: string; kc_internal: string
  kc_client_id: string; kc_client_ref: string; auth_client_ref: string
  nc_target: Record<string, unknown>; matrix_space: Record<string, unknown>
  domain_profile: Record<string, unknown>; brand_ref: string; blueprint_ref: string
  conn_profile: Record<string, unknown>; backup_key_ref: string
  audiences: string[]; created_at: Date; updated_at: Date
}

function hydrate(r: TenantRow): Tenant {
  return {
    id: r.id, slug: r.slug, status: r.status,
    dbConnRef: r.db_conn_ref, realmName: r.realm_name, issuer: r.issuer,
    kcInternal: r.kc_internal, kcClientId: r.kc_client_id, kcClientRef: r.kc_client_ref,
    authClientRef: r.auth_client_ref,
    ncTarget: r.nc_target, matrixSpace: r.matrix_space, domainProfile: r.domain_profile,
    brandRef: r.brand_ref, blueprintRef: r.blueprint_ref, connProfile: r.conn_profile,
    backupKeyRef: r.backup_key_ref, audiences: r.audiences,
    createdAt: r.created_at, updatedAt: r.updated_at,
  }
}

export async function registerTenant(input: TenantInput): Promise<Tenant> {
  const v = validateSlug(input.slug)
  if (!v.ok) throw new Error(`invalid slug "${input.slug}": ${v.reason}`)
  // P2.1b T11: every conn_profile WRITE routes through the budget clamp so no
  // persisted row can carry a perTenantMax that overruns the pinned
  // max_connections (any future conn_profile update path MUST do the same).
  const connProfile = clampConnProfile(input.connProfile, input.slug)
  const sql = getControlDb()
  // P2.1c (T7): enforce the realm_name/issuer uniqueness invariants at write-time
  // too — migration 003 adds the UNIQUE constraints, but a non-migrated control DB
  // must still refuse (loud error naming the offending column). The check excludes
  // this slug's own row so idempotent same-slug re-register (ON CONFLICT DO NOTHING)
  // still succeeds.
  const clash = await sql<Array<{ slug: string; realm_name: string; issuer: string }>>`
    SELECT slug, realm_name, issuer FROM tenant
    WHERE slug <> ${input.slug}
      AND (realm_name = ${input.realmName} OR issuer = ${input.issuer})
    LIMIT 1`
  if (clash[0]) {
    const column = clash[0].realm_name === input.realmName ? 'realm_name' : 'issuer'
    const value = column === 'realm_name' ? input.realmName : input.issuer
    throw new Error(
      `registerTenant: tenant "${input.slug}" cannot claim ${column}="${value}" — already owned by tenant "${clash[0].slug}"`,
    )
  }
  // JSONB write: postgres-js sql.json typing needs the `as never` cast (house style, see finance/repositories/config-db.ts).
  await sql`
    INSERT INTO tenant
      (slug, status, db_conn_ref, realm_name, issuer, kc_internal, kc_client_id,
       kc_client_ref, auth_client_ref, nc_target, matrix_space, domain_profile, brand_ref,
       blueprint_ref, conn_profile, backup_key_ref, audiences)
    VALUES
      (${input.slug}, ${input.status}, ${input.dbConnRef}, ${input.realmName},
       ${input.issuer}, ${input.kcInternal}, ${input.kcClientId},
       ${input.kcClientRef}, ${input.authClientRef}, ${sql.json(input.ncTarget as never) as never},
       ${sql.json(input.matrixSpace as never) as never}, ${sql.json(input.domainProfile as never) as never},
       ${input.brandRef}, ${input.blueprintRef}, ${sql.json(connProfile as never) as never},
       ${input.backupKeyRef}, ${input.audiences})
    ON CONFLICT (slug) DO NOTHING`
  const t = await getTenantBySlug(input.slug)
  if (!t) throw new Error(`registerTenant: row vanished after upsert for ${input.slug}`)
  return t
}

export async function getTenantBySlug(slug: string): Promise<Tenant | null> {
  const rows = await getControlDb()<TenantRow[]>`SELECT * FROM tenant WHERE slug = ${slug}`
  return rows[0] ? hydrate(rows[0]) : null
}

/**
 * P2.1c (T6) — STATUS-ONLY lookup for the resolver's NULL path. resolveTenantBySlug
 * collapses unknown / invalid / non-active into a single `null`, which the resolver
 * 404s. To distinguish a SUSPENDED tenant (503 branded page) from a truly unknown
 * slug or a deleting/deleted tombstone (404), the resolver consults this on the null
 * path. It is deliberately a CONTROL-DB ROW READ ONLY (the `status` column) — NO
 * data-plane resolution (no pool, no config, no brand), so a suspended tenant whose
 * data plane is gone or quarantined is never touched. Returns null for an invalid
 * slug (same guard as resolveTenantBySlug) and for an absent row.
 */
export async function getTenantStatusBySlug(slug: string): Promise<TenantStatus | null> {
  const v = validateSlug(slug)
  if (!v.ok) return null
  const rows = await getControlDb()<{ status: TenantStatus }[]>`
    SELECT status FROM tenant WHERE slug = ${slug}`
  return rows[0]?.status ?? null
}

export async function getTenantById(id: string): Promise<Tenant | null> {
  const rows = await getControlDb()<TenantRow[]>`SELECT * FROM tenant WHERE id = ${id}`
  return rows[0] ? hydrate(rows[0]) : null
}

export async function listTenants(): Promise<readonly Tenant[]> {
  const rows = await getControlDb()<TenantRow[]>`SELECT * FROM tenant ORDER BY slug`
  return rows.map(hydrate)
}

/** P2.1b T2 (D-FLEET): the tenants the fleet-migration runner (and the worker
 *  fleet, T4) iterates — ACTIVE only, stable slug order. */
export async function listActiveTenants(): Promise<readonly Tenant[]> {
  const rows = await getControlDb()<TenantRow[]>`SELECT * FROM tenant WHERE status = 'active' ORDER BY slug`
  return rows.map(hydrate)
}

export async function ensureTenantResource(tenantId: string, subsystem: TenantSubsystem): Promise<void> {
  await getControlDb()`
    INSERT INTO tenant_provisioning_resource (tenant_id, subsystem)
    VALUES (${tenantId}, ${subsystem})
    ON CONFLICT (tenant_id, subsystem) DO NOTHING`
}

export async function getTenantResources(tenantId: string): Promise<readonly TenantProvisioningResource[]> {
  return getControlDb()<TenantProvisioningResource[]>`
    SELECT * FROM tenant_provisioning_resource
    WHERE tenant_id = ${tenantId} ORDER BY subsystem`
}

export async function markTenantResourceOk(tenantId: string, subsystem: TenantSubsystem, externalId: string): Promise<void> {
  await getControlDb()`
    UPDATE tenant_provisioning_resource SET
      status = 'ok', external_id = ${externalId}, last_error = NULL, synced_at = now()
    WHERE tenant_id = ${tenantId} AND subsystem = ${subsystem}`
}

export async function markTenantResourceFailed(tenantId: string, subsystem: TenantSubsystem, error: string): Promise<void> {
  await getControlDb()`
    UPDATE tenant_provisioning_resource SET
      status = 'failed', last_error = ${error.slice(0, 2000)/* cap stored error to keep the ledger row bounded */}, attempts = attempts + 1
    WHERE tenant_id = ${tenantId} AND subsystem = ${subsystem}`
}

// ── P2.1b T2 — fleet-migration run ledger (control migration 002, D-FLEET) ──
// Two-phase by design: `start` opens an in-flight row (started_at = now(),
// finished_at NULL) so a crashed run stays VISIBLE in the control plane;
// `finish` closes it with the outcome. The error cap mirrors
// markTenantResourceFailed so a pathological stack never bloats the ledger.

export interface TenantMigrationRunOutcome {
  ok: boolean
  error?: string
  /** schema_migrations high-water mark after the run (best-effort, may be null). */
  lastApplied?: string | null
}

/** Open a tenant_migration_run row; returns the run id for finishTenantMigrationRun. */
export async function startTenantMigrationRun(tenantId: string): Promise<string> {
  const rows = await getControlDb()<{ id: string }[]>`
    INSERT INTO tenant_migration_run (tenant_id) VALUES (${tenantId}) RETURNING id`
  return rows[0].id
}

/** Close a tenant_migration_run row with the per-tenant outcome. */
export async function finishTenantMigrationRun(
  runId: string,
  outcome: TenantMigrationRunOutcome,
): Promise<void> {
  await getControlDb()`
    UPDATE tenant_migration_run SET
      finished_at = now(),
      ok = ${outcome.ok},
      error = ${outcome.error ? outcome.error.slice(0, 2000) : null},
      last_applied = ${outcome.lastApplied ?? null}
    WHERE id = ${runId}`
}

// ── P2.1b T8 — short-TTL resolution cache ───────────────────────────────────
// resolveTenantBySlug runs on EVERY request (sequence element 0) and once per
// tenant per worker-fleet tick; a cold resolution costs a control-DB SELECT +
// a readConfig() readFileSync. The cache (keyed by slug) bounds that to once
// per TTL per tenant. The TTL keeps the registry authoritative — a row change
// becomes visible within 30s — while LIFECYCLE transitions are immediate via
// evictTenantRuntime/updateTenantStatus. Null resolutions (unknown/non-active)
// are NEVER cached: the next request re-checks (D-READY's lazy retry path).
// NOTE: the TTL deliberately equals pool-registry's EVICTED_POOL_DRAIN_GRACE_MS
// so a cached context's pool is never capacity-drained underneath it.
export const RESOLUTION_CACHE_TTL_MS = 30_000

// G-XPROC: the control-DB LISTEN/NOTIFY channel name for cross-process tenant
// eviction. updateTenantStatus issues `pg_notify(TENANT_EVICT_CHANNEL, '<tenantId>')`
// same-transaction with the status flip, and evict-listener.ts subscribes every
// app process to it. TASK-025: the constant itself now lives in tenant-domain.ts
// (imported above, re-exported below) — every tenant_domain write uses the SAME
// channel, so there is exactly one definition for the notifier and the listener
// to ever drift from.

interface ResolvedEntry { ctx: TenantContext; expiresAt: number }
const _resolutionCache = new Map<string, ResolvedEntry>()

/**
 * Spec B §T.1 — the HOST-keyed twin of `_resolutionCache`. A tenant has N hosts
 * and one slug, so this cannot be folded into the slug map; both hold the SAME
 * TenantContext object and the SAME RESOLUTION_CACHE_TTL_MS. Every invalidation
 * seam below drives BOTH maps. A host entry that outlived a tenant_domain
 * change is a CROSS-TENANT hazard — the host may have been re-registered to
 * another tenant — which is why every tenant_domain write issues the
 * same-transaction pg_notify(tenant_evict) and the TTL is only the backstop.
 */
const _hostResolutionCache = new Map<string, ResolvedEntry>()

/**
 * HARDENING-1 — the write-after-evict guard for both caches.
 *
 * A monotonic generation counter, bumped by EVERY eviction seam. A resolution
 * captures it before its first read and DISCARDS its cache write when it has
 * moved. Deliberately GLOBAL, not per-tenant: an eviction can arrive for a
 * tenant whose id an in-flight resolution has not established yet (a host whose
 * row it is still reading). The cost is one extra resolution on the next
 * request; the DISCARD path is the fail-closed one.
 */
let _evictionEpoch = 0
function bumpEvictionEpoch(): void { _evictionEpoch++ }

/** Explicitly drop one slug's cached resolution (registry-row change). */
export function invalidateResolvedTenant(slug: string): void {
  bumpEvictionEpoch()
  _resolutionCache.delete(slug)
  for (const [host, entry] of _hostResolutionCache) {
    if (entry.ctx.slug === slug) _hostResolutionCache.delete(host)
  }
}

/**
 * Clear EVERY host-keyed entry. This is the "*" arm of eviction, consumed by
 * B19-internal-api-evict-and-modules' evictAllTenants() (spec B l.385):
 * evictTenantRuntime(id) can only reach entries whose ctx still names a tenant
 * this process has cached, so a blanket evict needs a seam that does not take
 * an id at all.
 */
export function clearHostResolutionCache(): void {
  bumpEvictionEpoch()
  _hostResolutionCache.clear()
}

/** Test-only: the host-keyed map's size, so guards assert the MAP, never a
 *  return value (an evictor that returns void can still evict nothing). */
export function _hostCacheSizeForTests(): number {
  return _hostResolutionCache.size
}

/** Test-only: clear the resolution cache (integration tests re-register rows
 *  with NEW tenant ids between cases — a cached context would go stale). */
export function _resetResolutionCacheForTests(): void {
  bumpEvictionEpoch()
  _resolutionCache.clear()
  _hostResolutionCache.clear()
}

/**
 * Build a fully-resolved TenantContext from an active registry row, or return
 * null for unknown / non-active tenants (so tenantResolveHandle 404s them).
 * All per-tenant clients are constructed lazily — no outbound network here.
 * Cached per slug for RESOLUTION_CACHE_TTL_MS (see above).
 */
export async function resolveTenantBySlug(slug: string): Promise<TenantContext | null> {
  const v = validateSlug(slug)
  if (!v.ok) return null
  const cached = _resolutionCache.get(slug)
  if (cached && cached.expiresAt > Date.now()) return cached.ctx
  const epoch = _evictionEpoch      // captured BEFORE the registry read
  const row = await getTenantBySlug(slug)
  if (!row || row.status !== 'active') {
    // An expired-but-present entry must not outlive a status flip seen here.
    _resolutionCache.delete(slug)
    return null
  }
  return buildAndCacheTenantContext(row, epoch)
}

/**
 * Resolve an ACTIVE tenant by its canonical tenant ID (UUID), or null for an
 * unknown / non-active id. Mirrors resolveTenantBySlug (same active-only filter,
 * same per-slug resolution cache + context hydration) — it differs ONLY in the
 * lookup key.
 *
 * Why this exists (SP-3 audit-consumer fix): event envelopes are keyed by the
 * tenant UUID (envelope.tenantId), not the slug. The newsletter audit consumer
 * resolved them via resolveTenantBySlug(envelope.tenantId), which validateSlug-
 * rejected every UUID → "unknown tenant" ack-skip → the audit row was never
 * written. Resolving by id fixes that while keeping the unknown-id → null
 * (ack-skip) contract for a genuinely unknown/inactive id.
 *
 * The resolution cache is keyed by SLUG (so evictTenantRuntime / the resolver's
 * by-slug path stay coherent); this reuses the SAME cached entry when present
 * (matched by ctx.id) and otherwise populates it after the row read.
 */
export async function resolveTenantById(id: string): Promise<TenantContext | null> {
  if (typeof id !== 'string' || id.length === 0) return null
  // Reuse a live cache entry for this id (entries are keyed by slug) before any DB read.
  const now = Date.now()
  for (const entry of _resolutionCache.values()) {
    if (entry.ctx.id === id && entry.expiresAt > now) return entry.ctx
  }
  const epoch = _evictionEpoch      // captured BEFORE the registry read
  const row = await getTenantById(id)
  if (!row || row.status !== 'active') {
    // Drop any expired-but-present entry for this id so a status flip seen here
    // is not masked by a stale cached context.
    for (const [slug, entry] of _resolutionCache) {
      if (entry.ctx.id === id) _resolutionCache.delete(slug)
    }
    return null
  }
  return buildAndCacheTenantContext(row, epoch)
}

/**
 * Hydrate a fully-resolved TenantContext from an ACTIVE registry row and cache
 * it (keyed by slug for RESOLUTION_CACHE_TTL_MS). Shared by resolveTenantBySlug
 * and resolveTenantById so both produce a byte-identical context + cache entry.
 * Callers MUST have already confirmed row.status === 'active'.
 */
async function buildAndCacheTenantContext(row: Tenant, epoch: number): Promise<TenantContext> {
  const slug = row.slug
  const dbUrl = resolveSecret(row.dbConnRef)
  const conn = row.connProfile as { perTenantMax?: number; prepare?: boolean }
  const dbMax = typeof conn.perTenantMax === 'number' ? conn.perTenantMax : 4
  const dbPrepare = conn.prepare ?? true
  const issuer = row.issuer.replace(/\/$/, '')
  const kcInternal = row.kcInternal.replace(/\/$/, '')
  // CR1: per-tenant audiences come from the registry row (seeded for `default`
  // from parseAudiences(process.env.AUTH_JWT_AUDIENCES) at registration — Task 30); the
  // parseAudiences(undefined) fallback only fires for a malformed empty row.
  const audiences = row.audiences.length ? Array.from(row.audiences) : parseAudiences(undefined)
  const matrixSpace = row.matrixSpace as {
    serverName?: string
    aliasNamespace?: string
    url?: string
    adminTokenRef?: string
    adminBotUserId?: string
  }
  // P2.1b T7: per-tenant external-service endpoints. domain_profile carries the
  // helios/livekit resolution; matrix_space carries the homeserver/admin refs
  // (spec §3.1 "Matrix url/admin-ref/serverName/aliasNamespace"). All optional —
  // an absent field means env fallback at the consuming module, and the DEFAULT
  // tenant ignores `services` entirely (env stays its source of truth).
  const domainProfile = row.domainProfile as {
    heliosUrl?: string
    livekit?: { url?: string; apiKeyRef?: string; apiSecretRef?: string }
    // SP-2: per-tenant SMTP credential ref + optional host/port/from override.
    // The default row carries no `smtp` key ⇒ undefined ⇒ config.smtp + auth-less.
    smtp?: { host?: string; port?: number; from?: string; user?: string; passwordRef?: string }
  }
  const configPath = configPathForTenant(row.slug)
  // Spec B §T.1 — the ONE place ctx.primaryHost is populated, so a context is
  // identical however it was resolved. Deliberately NOT swallowed: a control-DB
  // failure surfaces as the resolver's existing 503, never as a context that
  // silently carries no host.
  const primaryHost = await readPrimaryHost(row.id)

  const poolTenant = { id: row.id, dbUrl, dbMax, dbPrepare }
  const cfg = readConfig({ id: row.id, configPath })
  const brand = brandFromConfig(cfg)

  const ctx: TenantContext = {
    id: row.id,
    slug: row.slug,
    primaryHost,
    db: getPoolForTenant(poolTenant),
    issuer,
    kcInternal,
    audiences,
    // D-JWKS (P2.1b T6): no eager JWKS here — jwt-verify.ts owns ONE lazy
    // per-tenant.id JWKS, created on the first Bearer verify for the tenant.
    kcAdminClient: getKeycloakAdminClient({
      id: row.id,
      realmName: row.realmName,
      kcAdminUrl: kcAdminUrlFromInternal(kcInternal),
      kcClientId: row.kcClientId,
      kcClientSecretRef: row.kcClientRef,
    }),
    realmName: row.realmName,
    kcAdminUrl: kcAdminUrlFromInternal(kcInternal),
    kcClientId: row.kcClientId,
    kcClientSecretRef: row.kcClientRef,
    // MJ-secret: the Auth.js provider uses the UI client (gremion-ui) + its OWN secret
    // ref (row.authClientRef), NOT the admin client/secret above.
    // externalBase (point 6): for the `default` tenant this must derive from
    // AUTH_KEYCLOAK_BASE (matching auth.ts:19 `AUTH_KEYCLOAK_BASE ?? AUTH_KEYCLOAK_ISSUER`)
    // so the browser authorization redirect URL is byte-identical to today; other
    // tenants fall back to their issuer.
    authExternalBase: authExternalBaseForTenant(row.slug, issuer),
    // D-UICLIENT (P2.1c §8.1): the UI client id is FROZEN to `gremion-ui` for every
    // tenant realm — no per-tenant registry column. The realm template's UI client
    // is `gremion-ui` (realm-export.base.json) and the provisioner always creates it
    // by that name, so this is universal by construction (pinned by the D-UICLIENT
    // guard test in registry.integration.test.ts). REVISIT TRIGGER: a tenant
    // contractually requiring a different UI client id — then add a `ui_client_id`
    // column and read it here instead of this literal.
    authClientId: 'gremion-ui',
    authClientSecretRef: row.authClientRef,
    brand,
    config: cfg,
    aliasNamespace: matrixSpace.aliasNamespace ?? 'stura-',
    // MJ1: no per-tenant accent/logo data source in P2.1a — always null (deferred to P2.2).
    accent: null,
    logoUrl: null,
    configPath,
    dbUrl,
    dbMax,
    dbPrepare,
    services: {
      matrixUrl: matrixSpace.url,
      synapseAdminTokenRef: matrixSpace.adminTokenRef,
      synapseAdminBotUserId: matrixSpace.adminBotUserId,
      synapseServerName: matrixSpace.serverName,
      heliosUrl: domainProfile.heliosUrl,
      livekitUrl: domainProfile.livekit?.url,
      livekitApiKeyRef: domainProfile.livekit?.apiKeyRef,
      livekitApiSecretRef: domainProfile.livekit?.apiSecretRef,
      // SP-2 (O-2): per-tenant SMTP from domain_profile.smtp. Absent on the
      // default row ⇒ undefined ⇒ tenant-mail falls back to config.smtp + auth-less.
      smtp: domainProfile.smtp,
    },
  }
  // HARDENING-1: an eviction that landed while this resolution was in flight
  // must not be undone by its cache write.
  if (_evictionEpoch === epoch) {
    _resolutionCache.set(slug, { ctx, expiresAt: Date.now() + RESOLUTION_CACHE_TTL_MS })
  }
  return ctx
}

/**
 * P2.1b T8 — drop EVERY per-tenant keyed runtime handle for ONE tenant:
 * resolution cache, DB pool (immediate drain — explicit eviction, #256-4),
 * KC-admin client, Bearer JWKS, display-name resolver, per-tenant mail, plus
 * every MODULE-registered per-tenant handle (the Matrix/Synapse/Helios/LiveKit
 * evictors, registered via runtime-registry by each module's
 * register.server.ts). The ONE lifecycle seam: updateTenantStatus routes
 * suspend/delete through here, and the P2.1c operator script uses the same
 * function.
 *
 * Session-A inversion A1: the module evictors used to be statically
 * imported here ($lib/server/{messages,elections}/*). They are now run via
 * runTenantEvictHooks(), so this kernel file imports ZERO module internals — the
 * modules register their evictor into the runtime-registry seam instead.
 */
export function evictTenantRuntime(tenantId: string): void {
  // HARDENING-1: bump FIRST. The deletes below only reach entries that already
  // exist; a resolution in flight has nothing to delete yet, and this is what
  // stops its later write from re-installing what we are evicting.
  bumpEvictionEpoch()
  for (const [slug, entry] of _resolutionCache) {
    if (entry.ctx.id === tenantId) _resolutionCache.delete(slug)
  }
  // Spec B §T.1: the HOST-keyed cache is evicted on the SAME seam, so the
  // cross-process tenant_evict NOTIFY covers it too. A stale host entry is
  // strictly worse than a stale slug entry — a host can be re-registered to a
  // DIFFERENT tenant, so an un-evicted entry is a cross-tenant selection.
  // (The blanket form, for B19's evictAllTenants, is clearHostResolutionCache.)
  for (const [host, entry] of _hostResolutionCache) {
    if (entry.ctx.id === tenantId) _hostResolutionCache.delete(host)
  }
  evictTenantPool(tenantId)
  evictKeycloakAdminClient(tenantId)
  evictJwks(tenantId)
  evictDisplayNameResolver(tenantId)
  // Task 23: the per-tenant newsletter SQLite store was decommissioned; the
  // newsletter leaf service owns per-tenant state now, so there is no
  // monolith-side newsletter handle to evict here.
  evictTenantMail(tenantId) // SP-2: drop the per-tenant SMTP transport + close its sockets
  // Spec B §T.1: the per-tenant token bucket is per-tenant keyed runtime state
  // like every handle above — a suspended or re-registered id must not inherit
  // the previous occupant's consumed budget.
  evictTenantRateLimit(tenantId)
  // Module-owned per-tenant handles (Matrix/Synapse/Helios/LiveKit): each module
  // registered its evictor via runtime-registry (register.server.ts). Run them on
  // the SAME lifecycle seam as the kernel evictors above.
  runTenantEvictHooks(tenantId)
}

/**
 * P2.1b T8 — the registry status-transition fn (tenant suspend/delete path;
 * the operator-facing script arrives in P2.1c). Updates the control row and
 * evicts the tenant's ENTIRE runtime so no cached handle (pool/JWKS/clients/
 * resolution) outlives the transition — a suspended tenant stops resolving
 * IMMEDIATELY, not after the resolution-cache TTL. Returns the updated
 * tenant, or null when the id is unknown (nothing evicted).
 */
export async function updateTenantStatus(tenantId: string, status: TenantStatus): Promise<Tenant | null> {
  // G-XPROC: the UPDATE and the cross-process eviction NOTIFY run in ONE
  // transaction, so the notify is delivered exactly on commit — never for an
  // un-committed status change, and never stranded between two autocommit
  // statements. A CLI `suspend`/`delete` (a SEPARATE process from the running
  // app) thereby busts every app replica's resolution cache + per-tenant runtime
  // IMMEDIATELY via the tenant-evict listener, instead of waiting out the ~30s
  // RESOLUTION_CACHE_TTL. pg_notify takes the channel as a bound text arg
  // (injection-safe), unlike the `NOTIFY chan, 'payload'` statement form.
  const sql = getControlDb()
  const row = await sql.begin(async (tx) => {
    const rows = await tx<TenantRow[]>`
      UPDATE tenant SET status = ${status}, updated_at = now()
      WHERE id = ${tenantId}
      RETURNING *`
    const updated = rows[0]
    if (updated) await tx`SELECT pg_notify(${TENANT_EVICT_CHANNEL}, ${tenantId})`
    return updated
  })
  if (!row) return null
  console.log(
    `[tenant-registry] tenant ${row.slug} (${tenantId}) status -> ${status}; runtime evicted + NOTIFY ${TENANT_EVICT_CHANNEL}`,
  )
  // Local eviction stays: an IN-PROCESS flip (a future admin route inside the
  // app) evicts instantly without waiting for its own NOTIFY round-trip; on the
  // CLI path this process holds no cache, and the listener handles the fleet.
  evictTenantRuntime(tenantId)
  return hydrate(row)
}

/**
 * FIX2-LIFECYCLE (§7.8) — guarded suspend/resume state machine.
 *
 * `updateTenantStatus` is a BARE control-row UPDATE with no precondition — it is
 * the ONE lifecycle seam (it evicts the runtime), and the multi-step DELETE
 * pipeline (lifecycle.deleteTenant) and the provision pipeline legitimately drive
 * it through forward transitions (active/suspended→deleting→deleted, and the FINAL
 * provisioning→active). The operator-facing `suspend`/`resume` flips, however, MUST
 * NOT be unconditional: `resume <deleted-slug>` would flip a crypto-shredded
 * tombstone back to `active`, and resolveTenantBySlug (which filters only on
 * status!=='active') would then resolve it LIVE again — defeating the §7.8
 * tombstone-is-terminal / subdomain-takeover defence that delete + provision
 * enforce. The same unguarded flip would also promote a half-provisioned
 * `provisioning` row straight to `active`.
 *
 * This is the state-machine precondition for those two operator flips: resume is
 * legal ONLY from `suspended`; suspend is legal ONLY from `active`. Every other
 * current status (including the `deleted`/`deleting` tombstone and the
 * `provisioning` half-built row) is REFUSED with a loud, named error. PURE (no
 * I/O) so it is unit-testable; the async wrappers below read the current status
 * and apply it.
 */
export class TenantStatusTransitionError extends Error {
  constructor(
    readonly slug: string,
    readonly current: TenantStatus,
    readonly target: 'active' | 'suspended',
  ) {
    super(
      `refusing tenant "${slug}" status transition ${current} -> ${target}: ` +
        (target === 'active'
          ? current === 'deleted' || current === 'deleting'
            ? 'a deleted/deleting tenant is a terminal tombstone and can NEVER be resumed (§7.8 ' +
              'subdomain-takeover defence — the slug is reserved forever)'
            : current === 'provisioning'
              ? 'a half-provisioned tenant must finish the provision pipeline (which flips it to ' +
                'active), it cannot be resumed'
              : 'resume is legal ONLY from "suspended"'
          : 'suspend is legal ONLY from "active"'),
    )
    this.name = 'TenantStatusTransitionError'
  }
}

/** The ONLY legal source status for each operator flip target (state machine). */
const LEGAL_TRANSITION_SOURCE: Record<'active' | 'suspended', TenantStatus> = {
  active: 'suspended', // resume
  suspended: 'active', // suspend
}

/**
 * Pure state-machine precondition for the operator suspend/resume flips. Throws a
 * loud, named TenantStatusTransitionError unless `current` is the single legal
 * source for `target`. (Forward lifecycle transitions — deleting/deleted via
 * deleteTenant, and provisioning→active via the provision pipeline — do NOT route
 * through here; they call updateTenantStatus directly.)
 */
export function assertTenantStatusTransition(
  slug: string,
  current: TenantStatus,
  target: 'active' | 'suspended',
): void {
  if (current !== LEGAL_TRANSITION_SOURCE[target]) {
    throw new TenantStatusTransitionError(slug, current, target)
  }
}

/**
 * Guarded RESUME (status -> active). Reads the current control-row status, refuses
 * any non-`suspended` source via the state machine (so a `deleted`/`deleting`
 * tombstone is NEVER resurrected and a `provisioning` row is never short-circuited
 * to active), then routes through updateTenantStatus (which evicts the runtime).
 * Throws on an unknown slug.
 */
export async function resumeTenant(slug: string): Promise<Tenant> {
  return flipTenantStatus(slug, 'active')
}

/**
 * Guarded SUSPEND (status -> suspended). Reads the current control-row status,
 * refuses any non-`active` source via the state machine, then routes through
 * updateTenantStatus (which evicts the runtime). Throws on an unknown slug.
 */
export async function suspendTenant(slug: string): Promise<Tenant> {
  return flipTenantStatus(slug, 'suspended')
}

async function flipTenantStatus(slug: string, target: 'active' | 'suspended'): Promise<Tenant> {
  const v = validateSlug(slug)
  if (!v.ok) throw new Error(`invalid slug "${slug}": ${v.reason}`)
  const tenant = await getTenantBySlug(v.slug)
  if (!tenant) throw new Error(`unknown tenant "${v.slug}"`)
  // State-machine precondition BEFORE the write — a refused transition leaves the
  // control row (and the tombstone) untouched.
  assertTenantStatusTransition(v.slug, tenant.status, target)
  const updated = await updateTenantStatus(tenant.id, target)
  if (!updated) throw new Error(`tenant "${v.slug}" (${tenant.id}) vanished during status flip`)
  return updated
}

/**
 * P2.1c (T10) — the provisioner-owned write-back path. `registerTenant` is
 * `INSERT … ON CONFLICT (slug) DO NOTHING` (so a half-provisioned row is never
 * clobbered by a retry), which means the provisioner cannot use it to update an
 * existing row — the write-back would silently no-op. This explicit,
 * slug-guarded UPDATE patches ONLY the columns the provision pipeline owns
 * (realm/issuer/kc-internal/client-id/secret-refs/db-ref/conn-profile/services),
 * leaving `slug` and `status` untouched (status transitions go through
 * `updateTenantStatus`, which also evicts the runtime). conn_profile, like
 * registerTenant, is clamped to the budget before persistence. Returns the
 * updated tenant, or null when the slug is unknown.
 */
export interface TenantProvisioningPatch {
  realmName?: string
  issuer?: string
  kcInternal?: string
  kcClientId?: string
  kcClientRef?: string
  authClientRef?: string
  dbConnRef?: string
  backupKeyRef?: string
  audiences?: readonly string[]
  ncTarget?: Record<string, unknown>
  matrixSpace?: Record<string, unknown>
  domainProfile?: Record<string, unknown>
  connProfile?: Record<string, unknown>
}

export async function updateTenantProvisioning(
  slug: string,
  patch: TenantProvisioningPatch,
): Promise<Tenant | null> {
  const v = validateSlug(slug)
  if (!v.ok) throw new Error(`invalid slug "${slug}": ${v.reason}`)
  const sql = getControlDb()
  // COALESCE(${maybe}, column) leaves a column untouched when the patch omits
  // it (the param is NULL → COALESCE keeps the existing value). JSONB columns
  // use the sql.json house-style cast; conn_profile is budget-clamped first.
  const clamped =
    patch.connProfile !== undefined ? clampConnProfile(patch.connProfile, slug) : undefined
  const rows = await sql<TenantRow[]>`
    UPDATE tenant SET
      realm_name     = COALESCE(${patch.realmName ?? null}, realm_name),
      issuer         = COALESCE(${patch.issuer ?? null}, issuer),
      kc_internal    = COALESCE(${patch.kcInternal ?? null}, kc_internal),
      kc_client_id   = COALESCE(${patch.kcClientId ?? null}, kc_client_id),
      kc_client_ref  = COALESCE(${patch.kcClientRef ?? null}, kc_client_ref),
      auth_client_ref = COALESCE(${patch.authClientRef ?? null}, auth_client_ref),
      db_conn_ref    = COALESCE(${patch.dbConnRef ?? null}, db_conn_ref),
      backup_key_ref = COALESCE(${patch.backupKeyRef ?? null}, backup_key_ref),
      audiences      = COALESCE(${patch.audiences ? Array.from(patch.audiences) : null}, audiences),
      nc_target      = COALESCE(${patch.ncTarget !== undefined ? (sql.json(patch.ncTarget as never) as never) : null}, nc_target),
      matrix_space   = COALESCE(${patch.matrixSpace !== undefined ? (sql.json(patch.matrixSpace as never) as never) : null}, matrix_space),
      domain_profile = COALESCE(${patch.domainProfile !== undefined ? (sql.json(patch.domainProfile as never) as never) : null}, domain_profile),
      conn_profile   = COALESCE(${clamped !== undefined ? (sql.json(clamped as never) as never) : null}, conn_profile),
      updated_at = now()
    WHERE slug = ${slug}
    RETURNING *`
  return rows[0] ? hydrate(rows[0]) : null
}

/** The `default` tenant keeps process.env.CONFIG_PATH; others use a per-slug data dir. */
function configPathForTenant(slug: string): string {
  return slug === 'default' ? (process.env.CONFIG_PATH ?? '/app/config/config.json') : `/data/${slug}/config.json`
}

/**
 * Point 6 (byte-identical default): the `default` tenant's Auth.js external base
 * MUST match auth.ts:19 today — `AUTH_KEYCLOAK_BASE ?? AUTH_KEYCLOAK_ISSUER` —
 * so the browser authorization-redirect URL is unchanged. (The realm issuer can
 * differ from the OIDC endpoint base when KC runs under --http-relative-path, which
 * is exactly why auth.ts splits BASE from ISSUER.) Other tenants use their issuer.
 */
function authExternalBaseForTenant(slug: string, issuer: string): string {
  if (slug === 'default') {
    return (process.env.AUTH_KEYCLOAK_BASE ?? process.env.AUTH_KEYCLOAK_ISSUER ?? issuer).replace(/\/$/, '')
  }
  return issuer
}

/** kc_internal stores the realm-scoped issuer base; the admin URL is its origin + /auth. */
function kcAdminUrlFromInternal(kcInternal: string): string {
  // kcInternal e.g. http://keycloak:8080/auth/realms/<realm> -> http://keycloak:8080/auth
  return kcInternal.replace(/\/realms\/.*$/, '')
}

// ── Spec B §T.1 — tenant_domain (control migration 004, owned by B4) ─────────
//
// The table, its CHECK and its indexes come from
// B4-migrations-portback-nine's migrations-control/004_tenant_domain.sql.
//
// TASK-025 (L3-17): the accessor implementations now live in tenant-domain.ts,
// which is kernel-portable (no SvelteKit import, see kernel-portable.guard.
// test.ts) — every function below is a THIN WRAPPER that supplies the three
// things only registry.ts is allowed to know about: getControlDb() (the
// control pool), process.env.PLATFORM_DOMAIN, and evictTenantRuntime (the runtime
// eviction callback). No behaviour change: same exports, same signatures,
// same errors — the extraction moved code, not semantics.
export type { TenantDomain }

/** Re-exported so registry.ts's own updateTenantStatus and every existing
 *  caller/test keep importing ONE channel name from ONE place. */
export { TENANT_EVICT_CHANNEL }

/** Every `tenant_domain` row in the deployment, in ONE statement — one snapshot,
 *  never `listTenants().map(listTenantDomains)` (an N+1 that can also observe a
 *  claim set that never existed if a write lands between two of its reads). */
export async function listAllTenantDomains(): Promise<readonly TenantDomain[]> {
  return tdListAll(getControlDb())
}

/** Every host registered to a tenant, primary first then alphabetical. */
export async function listTenantDomains(tenantId: string): Promise<readonly TenantDomain[]> {
  return tdList(getControlDb(), tenantId)
}

/**
 * The tenant's canonical host — the one that mints `issuerForTenant` and every
 * self-referential URL. Null when the tenant has no primary host: callers MUST
 * fail closed on that, and must NEVER synthesise `<slug>.<apex>` as a
 * substitute — that construction is exactly what spec B deletes.
 */
export async function primaryHostForTenant(tenantId: string): Promise<string | null> {
  return tdPrimaryHostForTenant(getControlDb(), tenantId)
}

/**
 * The un-guarded read behind primaryHostForTenant. buildAndCacheTenantContext
 * calls THIS, not the exported accessor: the id it holds came out of the
 * control-DB row it is hydrating, so it is a uuid by construction, and running
 * assertTenantId over it would turn the public API's argument guard into a
 * constraint on registry ROWS. One statement, one shape, one place.
 */
async function readPrimaryHost(tenantId: string): Promise<string | null> {
  return tdReadPrimaryHost(getControlDb(), tenantId)
}

/**
 * Register `host` for `tenantId`. Idempotent for the SAME tenant, and REFUSED
 * with a named error when another tenant already owns the host — the host PK
 * makes takeover impossible, this just makes the refusal readable. See
 * tenant-domain.ts:addTenantDomain for the full transaction (owner pre-read,
 * clear-then-set primary, same-tx pg_notify).
 */
export async function addTenantDomain(
  tenantId: string,
  rawHost: string,
  opts: AddTenantDomainOptions = {},
): Promise<TenantDomain> {
  return tdAdd(getControlDb(), tenantId, rawHost, opts, {
    platformDomain: process.env.PLATFORM_DOMAIN ?? '',
    onEvict: evictTenantRuntime,
  })
}

/**
 * Un-register a host from a tenant, scoped by tenantId so one tenant's operator
 * surface can never delete another tenant's row. The PRIMARY host cannot be
 * removed while the tenant still has OTHER hosts — enforced in the DELETE's own
 * WHERE, not in JS. Removing the LAST host IS allowed: that is the deliberate
 * "this tenant goes dark" operation.
 */
export async function removeTenantDomain(tenantId: string, rawHost: string): Promise<boolean> {
  return tdRemove(getControlDb(), tenantId, rawHost, evictTenantRuntime)
}

/**
 * Promote one of the tenant's existing hosts to primary. CLEAR-then-SET in ONE
 * transaction, not a single `SET is_primary = (host = $2)`:
 * `tenant_domain_one_primary` is a plain (non-deferrable) partial unique index
 * and Postgres checks it per ROW, so one statement can spuriously trip on a
 * transient two-primaries state depending on row order.
 */
export async function setPrimaryDomain(tenantId: string, rawHost: string): Promise<TenantDomain> {
  return tdSetPrimary(getControlDb(), tenantId, rawHost, evictTenantRuntime)
}


/**
 * Resolve an ACTIVE tenant by the FULL edge-forwarded host, or null. There is
 * NO fallback, NO leftmost-label path and NO apex special case: a null return
 * means REJECT and must never be read as "use the default tenant".
 *
 * The lookup joins tenant_domain -> tenant. Because `host` is tenant_domain's
 * PK the join yields at most one row, so an ambiguous host is not merely
 * improbable — it is unrepresentable.
 *
 * TASK-025 Q1 (ledger): on this base, resolve.ts's request path still selects
 * the tenant by the leftmost DNS label (extractLeftmostLabel) — this function
 * has NO production caller yet. TASK-025 proves the request clause HERE,
 * against this function directly, via registry.domain.integration.test.ts's
 * two-tenant-isolation and B8-post-condition blocks (real Postgres, real
 * tenant_domain rows, a raw-host lookup). The request-path cut-over — wiring
 * resolve.ts's Handle to call resolveTenantByHost instead of extractLeftmostLabel
 * — is TASK-041 (B10-resolver-fullhost), not this task.
 */
export async function resolveTenantByHost(
  host: string | undefined | null,
): Promise<TenantContext | null> {
  const h = normaliseHost(host)
  if (!h) return null
  const cached = _hostResolutionCache.get(h)
  if (cached && cached.expiresAt > Date.now()) return cached.ctx
  const epoch = _evictionEpoch      // captured BEFORE the host->tenant read
  const rows = await getControlDb()<TenantRow[]>`
    SELECT t.* FROM tenant t
    JOIN tenant_domain d ON d.tenant_id = t.id
    WHERE d.host = ${h}`
  const row = rows[0]
  if (!row || row.status !== 'active') {
    // An expired-but-present entry must not outlive a status flip seen here.
    _hostResolutionCache.delete(h)
    return null
  }
  const ctx = await buildAndCacheTenantContext(hydrate(row), epoch)
  if (_evictionEpoch === epoch) {
    _hostResolutionCache.set(h, { ctx, expiresAt: Date.now() + RESOLUTION_CACHE_TTL_MS })
  }
  return ctx
}

/**
 * The host-keyed twin of getTenantStatusBySlug. Deliberately a CONTROL-DB ROW
 * READ ONLY (the `status` column) — no pool, no config, no brand — so a
 * suspended tenant whose data plane is gone or quarantined is never touched.
 */
export async function getTenantStatusByHost(
  host: string | undefined | null,
): Promise<TenantStatus | null> {
  const h = normaliseHost(host)
  if (!h) return null
  const rows = await getControlDb()<{ status: TenantStatus }[]>`
    SELECT t.status FROM tenant t
    JOIN tenant_domain d ON d.tenant_id = t.id
    WHERE d.host = ${h}`
  return rows[0]?.status ?? null
}
