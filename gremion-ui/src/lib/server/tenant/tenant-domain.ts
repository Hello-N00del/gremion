// src/lib/server/tenant/tenant-domain.ts
// Spec B §T.1 — the tenant_domain (control migration 004) accessor half,
// extracted out of registry.ts so it is kernel-portable (TASK-025 L3-17: a
// future kernel API takes this file over UNCHANGED). PURE with respect to the
// SvelteKit runtime: every DB handle, config value and post-write side effect
// registry.ts owns is passed in as an argument, never read from a module-level
// $env or imported back from registry.ts (that would just move the SvelteKit
// dependency one hop, not remove it — see kernel-portable.guard.test.ts, which
// scans this file's own relative-import graph).
//
// The registry already carries a WRITE-TIME clash guard for realm_name/issuer
// (registerTenant) because 001 gave neither a UNIQUE. `tenant_domain.host` is
// the PRIMARY KEY, so the equivalent guarantee is free — but a raw
// `duplicate key value violates unique constraint "tenant_domain_pkey"` names
// neither the host nor the owning tenant, so addTenantDomain pre-reads the
// owner inside the transaction and throws a loud, named error instead.
//
// pg_notify and the FOR UPDATE owner pre-read stay INSIDE the transaction —
// unchanged from the pre-extraction registry.ts: a refused write delivers NO
// eviction notice, and the row lock still closes the same-host race registry
// .domain.integration.test.ts's concurrent-claim case exercises.
import type { Sql } from '@gremion/db'
import { normaliseHost } from './host'
import { isReservedPlatformHost } from './reserved-hosts'

/**
 * G-XPROC: the control-DB LISTEN/NOTIFY channel name for cross-process tenant
 * eviction. Every tenant_domain write below issues `pg_notify(TENANT_EVICT_CHANNEL,
 * '<tenantId>')` same-transaction with the row change; registry.ts's
 * updateTenantStatus uses the SAME channel for status-flip eviction, so it
 * imports this constant rather than holding its own copy.
 */
export const TENANT_EVICT_CHANNEL = 'tenant_evict'

export interface TenantDomain {
  readonly host: string
  readonly tenantId: string
  readonly isPrimary: boolean
  readonly verifiedAt: Date | null
  readonly createdAt: Date
}

interface TenantDomainRow {
  host: string
  tenant_id: string
  is_primary: boolean
  verified_at: Date | null
  created_at: Date
}

function hydrateDomain(r: TenantDomainRow): TenantDomain {
  return {
    host: r.host,
    tenantId: r.tenant_id,
    isPrimary: r.is_primary,
    verifiedAt: r.verified_at,
    createdAt: r.created_at,
  }
}

/** uuid guard so a malformed tenant id fails loudly here, not as a PG cast error. */
const TENANT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function assertTenantId(fn: string, tenantId: string): void {
  if (typeof tenantId !== 'string' || !TENANT_ID_PATTERN.test(tenantId)) {
    throw new Error(`${fn}: "${tenantId}" is not a tenant id (uuid)`)
  }
}

/** Normalise-or-throw: the WRITE path shares the resolver's normaliser, so a row
 *  the resolver could never match can never be persisted (host.ts docblock). */
function assertHost(fn: string, rawHost: string): string {
  const host = normaliseHost(rawHost)
  if (!host) {
    throw new Error(
      `${fn}: "${rawHost}" is not a valid host — it must be an ASCII (punycode) ` +
      `hostname with no list separator, no empty label and no ambiguous authority form`,
    )
  }
  return host
}

/** Every `tenant_domain` row in the deployment, in ONE statement — one snapshot,
 *  never `listTenants().map(listTenantDomains)` (an N+1 that can also observe a
 *  claim set that never existed if a write lands between two of its reads). */
export async function listAllTenantDomains(sql: Sql): Promise<readonly TenantDomain[]> {
  const rows = await sql<TenantDomainRow[]>`
    SELECT * FROM tenant_domain ORDER BY tenant_id, is_primary DESC, host`
  return rows.map(hydrateDomain)
}

/** Every host registered to a tenant, primary first then alphabetical. */
export async function listTenantDomains(sql: Sql, tenantId: string): Promise<readonly TenantDomain[]> {
  assertTenantId('listTenantDomains', tenantId)
  const rows = await sql<TenantDomainRow[]>`
    SELECT * FROM tenant_domain WHERE tenant_id = ${tenantId}
    ORDER BY is_primary DESC, host`
  return rows.map(hydrateDomain)
}

/**
 * The tenant's canonical host — the one that mints `issuerForTenant` and every
 * self-referential URL. Null when the tenant has no primary host: callers MUST
 * fail closed on that, and must NEVER synthesise `<slug>.<apex>` as a
 * substitute — that construction is exactly what spec B deletes.
 */
export async function primaryHostForTenant(sql: Sql, tenantId: string): Promise<string | null> {
  assertTenantId('primaryHostForTenant', tenantId)
  return readPrimaryHost(sql, tenantId)
}

/**
 * The un-guarded read behind primaryHostForTenant. registry.ts's
 * buildAndCacheTenantContext calls THIS, not primaryHostForTenant: the id it
 * holds came out of the control-DB row it is hydrating, so it is a uuid by
 * construction, and running assertTenantId over it would turn the public
 * API's argument guard into a constraint on registry ROWS. One statement, one
 * shape, one place.
 */
export async function readPrimaryHost(sql: Sql, tenantId: string): Promise<string | null> {
  const rows = await sql<Array<{ host: string }>>`
    SELECT host FROM tenant_domain WHERE tenant_id = ${tenantId} AND is_primary`
  return rows[0]?.host ?? null
}

export interface AddTenantDomainOptions {
  isPrimary?: boolean
  verified?: boolean
}

/** Everything registry.ts injects for a write: the reserved-host apex and the
 *  post-commit runtime-eviction callback. Neither is read from $env here — the
 *  caller (registry.ts) is the one file allowed to know about env vars and
 *  evictTenantRuntime. */
export interface TenantDomainWriteDeps {
  /** The apex under which the nine platform names are reserved (PLATFORM_DOMAIN). */
  platformDomain: string
  /** Invoked AFTER the transaction commits, with the tenant id whose runtime
   *  (resolution caches, pools, KC/JWKS/mail clients, …) must be evicted.
   *  Never called for a refused write. */
  onEvict: (tenantId: string) => void
  /**
   * TEST-ONLY seam (TASK-025 round-2 fix, verify-round1.md residual "(e)" /
   * MED #1): invoked once inside the transaction, immediately after the owner
   * pre-read resolves and BEFORE this call's own INSERT ... ON CONFLICT runs.
   * Defaults to a no-op and MUST NEVER be set by a production wrapper —
   * registry.ts's addTenantDomain never sets it. It exists solely so
   * registry.domain.integration.test.ts can force the ON-CONFLICT interleave
   * DETERMINISTICALLY (a second connection commits a competing owner between
   * this call's pre-read and its own upsert) instead of relying on
   * Promise.allSettled's undefined scheduling, which never actually reached
   * that code path in 8 verifier runs.
   */
  afterOwnerPreRead?: () => void | Promise<void>
}

/**
 * Register `host` for `tenantId`. Idempotent for the SAME tenant, and REFUSED
 * with a named error when another tenant already owns the host — the host PK
 * makes takeover impossible, this just makes the refusal readable.
 *
 * `isPrimary: true` clears the tenant's previous primary in the SAME
 * transaction (clear-then-set), so `tenant_domain_one_primary` is never
 * transiently violated and a crash can never leave a tenant with two primaries.
 *
 * pg_notify(TENANT_EVICT_CHANNEL) runs INSIDE the transaction: a host->tenant
 * mapping change must bust every replica's host-resolution cache on commit and
 * on nothing else. Without it, an operator who moves a host from tenant A to
 * tenant B leaves other replicas serving A's data on B's host for a full TTL.
 */
export async function addTenantDomain(
  sql: Sql,
  tenantId: string,
  rawHost: string,
  opts: AddTenantDomainOptions,
  deps: TenantDomainWriteDeps,
): Promise<TenantDomain> {
  assertTenantId('addTenantDomain', tenantId)
  // Spec A §C / §H.2 — reserved platform names, BEFORE normalisation (so the
  // underscore in `_dmarc` is refused as reserved, not as malformed) and BEFORE
  // any DNS pre-flight (which cannot catch names that already point at us).
  // ONE error shape for both call sites: an operator must never be told a
  // reserved name is merely malformed.
  const platformDomain = deps.platformDomain
  const refuseReserved = (candidate: string) => {
    if (isReservedPlatformHost(candidate, platformDomain)) {
      throw new Error(
        `addTenantDomain: reserved platform host: ${candidate} — reserved for the platform ` +
        `under PLATFORM_DOMAIN=${platformDomain}, it can never be a tenant host (spec A §C)`,
      )
    }
  }
  refuseReserved(rawHost.trim().toLowerCase().replace(/:[0-9]{1,5}$/, '').replace(/\.$/, ''))
  const host = assertHost('addTenantDomain', rawHost)
  refuseReserved(host)
  const isPrimary = opts.isPrimary === true
  const row = await sql.begin(async (tx) => {
    const owner = await tx<Array<{ tenant_id: string; slug: string }>>`
      SELECT d.tenant_id, t.slug FROM tenant_domain d
      JOIN tenant t ON t.id = d.tenant_id
      WHERE d.host = ${host}
      FOR UPDATE OF d`
    if (owner[0] && owner[0].tenant_id !== tenantId) {
      throw new Error(
        `addTenantDomain: host "${host}" is already registered to tenant "${owner[0].slug}" ` +
        `(${owner[0].tenant_id}) — a host belongs to exactly one tenant`,
      )
    }
    if (!owner[0]) {
      const t = await tx<Array<{ slug: string }>>`SELECT slug FROM tenant WHERE id = ${tenantId}`
      if (!t[0]) throw new Error(`addTenantDomain: unknown tenant id ${tenantId}`)
    }
    // TEST-ONLY seam — see TenantDomainWriteDeps.afterOwnerPreRead. A no-op in
    // every production call (registry.ts never sets it).
    if (deps.afterOwnerPreRead) await deps.afterOwnerPreRead()
    if (isPrimary) {
      await tx`UPDATE tenant_domain SET is_primary = false
               WHERE tenant_id = ${tenantId} AND is_primary AND host <> ${host}`
    }
    const rows = await tx<TenantDomainRow[]>`
      INSERT INTO tenant_domain (host, tenant_id, is_primary, verified_at)
      VALUES (${host}, ${tenantId}, ${isPrimary},
              CASE WHEN ${opts.verified === true} THEN now() ELSE NULL END)
      ON CONFLICT (host) DO UPDATE SET
        is_primary  = tenant_domain.is_primary OR EXCLUDED.is_primary,
        verified_at = COALESCE(EXCLUDED.verified_at, tenant_domain.verified_at)
      WHERE tenant_domain.tenant_id = EXCLUDED.tenant_id
      RETURNING *`
    if (!rows[0]) {
      throw new Error(`addTenantDomain: host "${host}" was claimed by another tenant concurrently`)
    }
    await tx`SELECT pg_notify(${TENANT_EVICT_CHANNEL}, ${tenantId})`
    return rows[0]
  })
  deps.onEvict(tenantId)
  return hydrateDomain(row as unknown as TenantDomainRow)
}

/**
 * Un-register a host from a tenant, scoped by tenantId so one tenant's operator
 * surface can never delete another tenant's row. The PRIMARY host cannot be
 * removed while the tenant still has OTHER hosts — enforced in the DELETE's own
 * WHERE, not in JS. Removing the LAST host IS allowed: that is the deliberate
 * "this tenant goes dark" operation.
 */
export async function removeTenantDomain(
  sql: Sql,
  tenantId: string,
  rawHost: string,
  onEvict: (tenantId: string) => void,
): Promise<boolean> {
  assertTenantId('removeTenantDomain', tenantId)
  const host = assertHost('removeTenantDomain', rawHost)
  const removed = await sql.begin(async (tx) => {
    const rows = await tx<TenantDomainRow[]>`
      DELETE FROM tenant_domain d
      WHERE d.tenant_id = ${tenantId}
        AND d.host = ${host}
        AND (NOT d.is_primary
             OR NOT EXISTS (SELECT 1 FROM tenant_domain o
                            WHERE o.tenant_id = d.tenant_id AND o.host <> d.host))
      RETURNING *`
    if (rows[0]) {
      await tx`SELECT pg_notify(${TENANT_EVICT_CHANNEL}, ${tenantId})`
      return true
    }
    const existing = await tx<Array<{ is_primary: boolean }>>`
      SELECT is_primary FROM tenant_domain WHERE tenant_id = ${tenantId} AND host = ${host}`
    if (existing[0]?.is_primary) {
      throw new Error(
        `removeTenantDomain: host "${host}" is tenant ${tenantId}'s PRIMARY host and the tenant ` +
        `has other hosts — setPrimaryDomain to one of them before removing it`,
      )
    }
    return false
  })
  if (removed) onEvict(tenantId)
  return removed === true
}

/**
 * Promote one of the tenant's existing hosts to primary. CLEAR-then-SET in ONE
 * transaction, not a single `SET is_primary = (host = $2)`:
 * `tenant_domain_one_primary` is a plain (non-deferrable) partial unique index
 * and Postgres checks it per ROW, so one statement can spuriously trip on a
 * transient two-primaries state depending on row order.
 */
export async function setPrimaryDomain(
  sql: Sql,
  tenantId: string,
  rawHost: string,
  onEvict: (tenantId: string) => void,
): Promise<TenantDomain> {
  assertTenantId('setPrimaryDomain', tenantId)
  const host = assertHost('setPrimaryDomain', rawHost)
  const row = await sql.begin(async (tx) => {
    await tx`UPDATE tenant_domain SET is_primary = false
             WHERE tenant_id = ${tenantId} AND is_primary AND host <> ${host}`
    const rows = await tx<TenantDomainRow[]>`
      UPDATE tenant_domain SET is_primary = true
      WHERE tenant_id = ${tenantId} AND host = ${host}
      RETURNING *`
    if (!rows[0]) {
      throw new Error(
        `setPrimaryDomain: host "${host}" is not registered to tenant ${tenantId} — register it first`,
      )
    }
    await tx`SELECT pg_notify(${TENANT_EVICT_CHANNEL}, ${tenantId})`
    return rows[0]
  })
  onEvict(tenantId)
  return hydrateDomain(row as unknown as TenantDomainRow)
}
