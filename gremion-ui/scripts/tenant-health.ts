// gremion-ui/scripts/tenant-health.ts
// P2.1c (T18, §7.10 half 1) — the tenant-health single-pane CLI. One command
// answers "is every tenant healthy?" — the design's answer to silo monitoring
// decentralization (design §7.10). Walks the control-DB registry and, per ACTIVE
// tenant, probes: the data-plane (SELECT 1) via the resolved DB URL, the
// migration schema_version (schema_migrations high-water mark) + the last
// tenant_migration_run outcome (the P2.1b 002 control ledger), the realm OIDC
// discovery document, and the NC/Matrix provisioning-ledger states. A SUSPENDED
// (or other non-active) tenant is reported with its status, NOT probed, NOT a
// fault (its data plane may be quarantined — the resolver's fail-closed stance).
//
// The testable logic lives in the PURE module src/lib/server/tenant/health.ts;
// this file only wires the LIVE probes + output (human table, or `--json`) and the
// exit code (1 if ANY tenant is unhealthy). Runs OPERATOR-SIDE
// (`pnpm -C gremion-ui exec tsx scripts/tenant-health.ts [--json]`).
//
// Env (operator-side; the env-guard scans src/ only, not scripts/):
//   CONTROL_DATABASE_URL    — the control-plane registry pool (required)
//   DATABASE_URL            — the default tenant's data plane (its env: ref)
//   TENANT_SECRETS_DIR      — host root for per-tenant file: secret refs
//   KC_HEALTH_BASE          — operator-reachable KC base for OIDC discovery
//                             (default: the tenant's own kcInternal origin, which
//                             is reachable in-container / inside the smoke stack)
import { readFileSync } from 'node:fs'
import postgres from 'postgres'
import {
  listTenants,
  getTenantResources,
  type Tenant,
} from '../src/lib/server/tenant/registry'
import { getControlDb, _resetControlDbForTests } from '../src/lib/server/tenant/control-db'
import { tenantSecretHostPath } from '../src/lib/server/tenant/secrets'
import {
  checkFleetHealth,
  fleetExitCode,
  renderHealthTable,
  type HealthDeps,
  type DataPlaneProbe,
  type MigrationProbe,
  type RealmOidcProbe,
  type SatelliteProbe,
  type LeafProbe,
} from '../src/lib/server/tenant/health'
import { tlog } from '../src/lib/server/observability/tenant-log'

// ── secret-ref resolution (operator-side: env: directly, file: via host path) ──
/** Resolve a registry DB-conn ref to a usable connection URL. `env:VAR` reads
 *  process.env (the default tenant's DATABASE_URL); `file:/run/secrets/tenants/…`
 *  is translated to its HOST bind-mount source and read (D-SECMOUNT) — the same
 *  path the provisioner/backup scripts write. */
function resolveConnUrl(ref: string): string {
  if (ref.startsWith('env:')) {
    const name = ref.slice('env:'.length)
    const val = process.env[name]
    if (!val) throw new Error(`secret ref env:${name} is unset`)
    return val
  }
  if (ref.startsWith('file:')) {
    return readFileSync(tenantSecretHostPath(ref), 'utf-8').trim()
  }
  throw new Error(`unsupported db_conn_ref scheme: ${ref.split(':', 1)[0]}`)
}

// ── live probes ───────────────────────────────────────────────────────────────
/** Open the tenant's data plane, run `fn`, always close. A fresh max:1 connection
 *  per probe (operator-side, low-frequency) — NOT the per-tenant LRU pool, which
 *  is a request-runtime construct keyed by ALS. */
async function withDataPlane<T>(tenant: Tenant, fn: (sql: ReturnType<typeof postgres>) => Promise<T>): Promise<T> {
  const url = resolveConnUrl(tenant.dbConnRef)
  const sql = postgres(url, { max: 1, idle_timeout: 5, connect_timeout: 10 })
  try {
    return await fn(sql)
  } finally {
    await sql.end({ timeout: 5 })
  }
}

function probeDataPlane(tenant: Tenant): Promise<DataPlaneProbe> {
  return withDataPlane(tenant, async (sql) => {
    await sql`SELECT 1`
    return { ok: true } as DataPlaneProbe
  }).catch((err) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }))
}

async function probeMigrations(tenant: Tenant): Promise<MigrationProbe> {
  // schema_version = the data-plane schema_migrations high-water mark.
  let schemaVersion: string | null = null
  try {
    schemaVersion = await withDataPlane(tenant, async (sql) => {
      const rows = await sql<{ filename: string }[]>`
        SELECT filename FROM schema_migrations ORDER BY filename DESC LIMIT 1`
      return rows[0]?.filename ?? null
    })
  } catch {
    schemaVersion = null // the data-plane probe will already have reported the connect failure
  }
  // The last fleet-migration run outcome from the control ledger (002).
  const runs = await getControlDb()<{ ok: boolean | null; finished_at: Date | null; error: string | null }[]>`
    SELECT ok, finished_at, error FROM tenant_migration_run
    WHERE tenant_id = ${tenant.id}
    ORDER BY started_at DESC LIMIT 1`
  const last = runs[0]
  const lastRun = last ? { ok: last.ok, finishedAt: last.finished_at, error: last.error } : null
  // A run is a fault only when it explicitly finished NOT-ok. An in-flight run
  // (ok null) or no run at all is not a migration fault on its own.
  const ok = lastRun?.ok !== false
  return { ok, schemaVersion, lastRun }
}

/** The realm OIDC discovery document. kcInternal already carries /realms/<realm>,
 *  so the discovery URL is `<kcInternal>/.well-known/openid-configuration`. An
 *  operator-reachable KC base override (KC_HEALTH_BASE) swaps the kcInternal
 *  origin for cases where `keycloak:8443` is not resolvable from the operator
 *  host (the in-container / smoke-stack default needs no override). */
async function probeRealmOidc(tenant: Tenant): Promise<RealmOidcProbe> {
  const base = tenant.kcInternal.replace(/\/$/, '')
  const override = process.env.KC_HEALTH_BASE
  // kcInternal e.g. https://keycloak:8443/auth/realms/<realm>; swap only the
  // scheme+authority when an override is given, keeping /auth/realms/<realm>.
  const realmBase = override ? base.replace(/^https?:\/\/[^/]+/, override.replace(/\/$/, '')) : base
  const url = `${realmBase}/.well-known/openid-configuration`
  try {
    const res = await fetch(url, { method: 'GET' })
    if (!res.ok) return { ok: false, error: `discovery ${res.status} at ${url}` }
    const doc = (await res.json()) as { issuer?: string }
    if (!doc.issuer) return { ok: false, error: `discovery at ${url} returned no issuer` }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: `${err instanceof Error ? err.message : String(err)} (${url})` }
  }
}

/** The NC/Matrix provisioning-ledger states (tenant_provisioning_resource). An
 *  absent ledger row reads as `pending` (mid-provision; not a fault). */
async function probeSatellites(tenant: Tenant): Promise<SatelliteProbe> {
  const resources = await getTenantResources(tenant.id)
  const stateOf = (sub: 'nextcloud' | 'matrix') =>
    resources.find((r) => r.subsystem === sub)?.status ?? 'pending'
  return { nextcloud: stateOf('nextcloud'), matrix: stateOf('matrix') }
}

/** T21 (§8.7) — probe the leaf newsletter-service for this tenant's DB health +
 *  subscriber/newsletter counts. Fetches GET <NEWSLETTER_SERVICE_URL>/healthz/tenants
 *  (guard-exempt, no auth needed) and finds the entry for this tenant's slug.
 *  If NEWSLETTER_SERVICE_URL is unset, returns { ok: true } (leaf not configured — non-fatal). */
async function probeLeaf(tenant: Tenant): Promise<LeafProbe> {
  const serviceUrl = process.env.NEWSLETTER_SERVICE_URL
  if (!serviceUrl) {
    // Leaf not configured — non-fatal; treat as ok so it doesn't flip the fleet.
    return { ok: true }
  }
  const url = `${serviceUrl.replace(/\/$/, '')}/healthz/tenants`
  try {
    const res = await fetch(url, { method: 'GET' })
    if (!res.ok) return { ok: false, error: `leaf /healthz/tenants returned ${res.status}` }
    const body = (await res.json()) as {
      success: boolean
      data: Array<{
        tenant_id: string
        tenant_slug: string
        db_ok: boolean
        subscribers?: number
        newsletters?: number
        error?: string
      }>
    }
    const entry = body.data?.find((e) => e.tenant_slug === tenant.slug)
    if (!entry) return { ok: false, error: `tenant slug "${tenant.slug}" not found in leaf catalog` }
    return {
      ok: entry.db_ok,
      subscribers: entry.subscribers,
      newsletters: entry.newsletters,
      error: entry.error,
    }
  } catch (err) {
    return { ok: false, error: `${err instanceof Error ? err.message : String(err)} (${url})` }
  }
}

const liveDeps: HealthDeps = {
  listTenants,
  probeDataPlane,
  probeMigrations,
  probeRealmOidc,
  probeSatellites,
  probeLeaf,
}

async function main(): Promise<void> {
  const json = process.argv.includes('--json')
  const report = await checkFleetHealth(liveDeps)
  if (json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(renderHealthTable(report))
  }
  process.exitCode = fleetExitCode(report)
}

main()
  .catch((err) => {
    // A control-plane failure (cannot list tenants) is process-wide — nothing can
    // be assessed, so this is a hard exit 1 with the cause, not a per-tenant fault.
    tlog('error', '[tenant-health] FAILED', {
      err: err instanceof Error ? err.message : String(err),
    })
    process.exitCode = 1
  })
  .finally(() => {
    // The control pool is a module singleton; drop it so the process can exit.
    void getControlDb()
      .end({ timeout: 5 })
      .catch(() => undefined)
      .finally(() => _resetControlDbForTests())
  })
