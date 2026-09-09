// src/lib/server/tenant/health.ts
// P2.1c (T18, §7.10 half 1) — the tenant-health single-pane CORE. One command
// answers "is every tenant healthy?" — the design's answer to silo monitoring
// decentralization (design §7.10): instead of N per-tenant dashboards, the
// operator runs ONE fleet probe over the control-DB registry.
//
// PURE orchestration over INJECTED probes (registry list + per-tenant data-plane /
// migration / realm-OIDC / satellite probes), so the whole walk + verdict + table
// rendering is unit-testable with fully-mocked subsystems (no DB, no KC, no
// network). The CLI (scripts/tenant-health.ts) supplies the live probes.
//
// SUSPENDED (and any other non-`active`) tenant: reported with its STATUS and
// treated as healthy-by-status — its data plane / realm are NEVER probed. A
// suspended data plane may be quarantined, and touching it is exactly what the
// resolver's fail-closed non-active path refuses to do (registry.ts
// resolveTenantBySlug returns null for non-active). Only `active` tenants are
// fully probed; an active tenant is unhealthy iff ANY of its probes fail.
import type { Tenant, TenantStatus } from './registry'

/** The probe families run per active tenant (the §7.10 health surface). */
export type HealthCheckName = 'data-plane' | 'migrations' | 'realm-oidc' | 'satellites' | 'leaf'

/** T21 (§8.7) — the leaf newsletter-service health probe result.
 *  `ok` is false if the leaf DB is down or the tenant is absent in the catalog.
 *  `subscribers` and `newsletters` are present on a passing probe for display. */
export interface LeafProbe {
  ok: boolean
  subscribers?: number
  newsletters?: number
  error?: string
}

/** A single named probe result (machine-readable; detail empty on pass). */
export interface HealthCheck {
  name: HealthCheckName
  ok: boolean
  detail: string
}

/** Per-tenant health: the registry status plus the active-tenant probe results. */
export interface TenantHealthRow {
  slug: string
  id: string
  status: TenantStatus
  /** True iff this tenant is NOT a fault (active + all probes green, OR a
   *  non-active lifecycle state — suspended/provisioning/deleting/deleted). */
  healthy: boolean
  /** The probe results (empty for a non-active tenant — its probes are skipped). */
  checks: HealthCheck[]
}

export interface FleetHealthReport {
  /** True iff EVERY tenant is healthy (exit 0); false → at least one fault. */
  ok: boolean
  tenants: TenantHealthRow[]
}

// ── injected probe shapes ─────────────────────────────────────────────────────

export interface DataPlaneProbe {
  ok: boolean
  /** Failure reason (e.g. the SELECT 1 error message). */
  error?: string
}

export interface MigrationProbe {
  /** False iff the last fleet-migration run for this tenant failed. */
  ok: boolean
  /** The schema_migrations high-water mark (the applied migration filename), or
   *  null if the data-plane probe could not read it. */
  schemaVersion: string | null
  /** The latest tenant_migration_run row (the P2.1b control ledger, 002), or null
   *  if the tenant has no recorded run yet. */
  lastRun: { ok: boolean | null; finishedAt: Date | null; error: string | null } | null
}

export interface RealmOidcProbe {
  ok: boolean
  /** Failure reason (e.g. the discovery HTTP status / fetch error). */
  error?: string
}

/** The NC/Matrix provisioning-ledger states (tenant_provisioning_resource). */
export interface SatelliteProbe {
  nextcloud: string
  matrix: string
}

export interface HealthDeps {
  /** Walk EVERY registry row (all statuses — the pane reports suspended too). */
  listTenants(): Promise<readonly Tenant[]>
  /** Active-tenant probes — never called for a non-active tenant. */
  probeDataPlane(tenant: Tenant): Promise<DataPlaneProbe>
  probeMigrations(tenant: Tenant): Promise<MigrationProbe>
  probeRealmOidc(tenant: Tenant): Promise<RealmOidcProbe>
  probeSatellites(tenant: Tenant): Promise<SatelliteProbe>
  /** T21 (§8.7) — probe the leaf newsletter-service for this tenant's DB health +
   *  subscriber/newsletter counts. Called for ACTIVE tenants only. */
  probeLeaf(tenant: Tenant): Promise<LeafProbe>
}

/** A satellite ledger state is a fault iff it is `failed` (pending = mid-provision,
 *  ok = done; neither is a health fault). */
function satelliteOk(state: string): boolean {
  return state !== 'failed'
}

type SafeResult<T> = { ok: true; value: T } | { ok: false; error: string }
async function safe<T>(fn: () => Promise<T>): Promise<SafeResult<T>> {
  try {
    return { ok: true, value: await fn() }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Probe ONE active tenant: data-plane SELECT 1, migration schema_version + the
 * last fleet-migration-run outcome, realm OIDC discovery, and the NC/Matrix
 * provisioning-ledger states. Each probe is wrapped so a thrown probe (a probe
 * implementation bug, not a tenant fault on its own) still produces a NAMED
 * failed check rather than aborting the whole fleet walk.
 */
async function checkActiveTenant(tenant: Tenant, deps: HealthDeps): Promise<HealthCheck[]> {
  const checks: HealthCheck[] = []

  const dp = await safe(() => deps.probeDataPlane(tenant))
  checks.push(
    dp.ok && dp.value.ok
      ? { name: 'data-plane', ok: true, detail: '' }
      : {
          name: 'data-plane',
          ok: false,
          detail: dp.ok ? (dp.value.error ?? 'data-plane probe failed') : dp.error,
        },
  )

  const mig = await safe(() => deps.probeMigrations(tenant))
  if (!mig.ok) {
    checks.push({ name: 'migrations', ok: false, detail: mig.error })
  } else {
    const m = mig.value
    const version = m.schemaVersion ?? 'unknown'
    if (m.ok) {
      checks.push({ name: 'migrations', ok: true, detail: '' })
    } else {
      const why = m.lastRun?.error ?? 'last fleet-migration run did not succeed'
      checks.push({ name: 'migrations', ok: false, detail: `schema_version=${version}; last run failed: ${why}` })
    }
  }

  const oidc = await safe(() => deps.probeRealmOidc(tenant))
  checks.push(
    oidc.ok && oidc.value.ok
      ? { name: 'realm-oidc', ok: true, detail: '' }
      : {
          name: 'realm-oidc',
          ok: false,
          detail: oidc.ok ? (oidc.value.error ?? 'realm OIDC discovery failed') : oidc.error,
        },
  )

  const sat = await safe(() => deps.probeSatellites(tenant))
  if (!sat.ok) {
    checks.push({ name: 'satellites', ok: false, detail: sat.error })
  } else {
    const s = sat.value
    const offenders = [
      ['nextcloud', s.nextcloud] as const,
      ['matrix', s.matrix] as const,
    ].filter(([, state]) => !satelliteOk(state))
    checks.push(
      offenders.length === 0
        ? { name: 'satellites', ok: true, detail: '' }
        : {
            name: 'satellites',
            ok: false,
            detail: offenders.map(([name, state]) => `${name}=${state}`).join(', '),
          },
    )
  }

  // T21 (§8.7) — leaf probe: newsletter-service DB health + subscriber/newsletter counts.
  const leaf = await safe(() => deps.probeLeaf(tenant))
  if (!leaf.ok) {
    checks.push({ name: 'leaf', ok: false, detail: leaf.error })
  } else {
    const l = leaf.value
    if (l.ok) {
      // Encode subscriber/newsletter counts in the detail string for renderHealthTable.
      const parts: string[] = []
      if (l.subscribers !== undefined) parts.push(`${l.subscribers} sub`)
      if (l.newsletters !== undefined) parts.push(`${l.newsletters} nl`)
      checks.push({ name: 'leaf', ok: true, detail: parts.join(', ') })
    } else {
      checks.push({ name: 'leaf', ok: false, detail: l.error ?? 'leaf probe failed' })
    }
  }

  return checks
}

/**
 * Walk the registry and produce a per-tenant health report. Active tenants are
 * fully probed (a fault on ANY probe makes the tenant unhealthy); a non-active
 * tenant (suspended/provisioning/deleting/deleted) is reported with its status
 * and is healthy-by-status (its data plane is never touched). The fleet is ok iff
 * every tenant row is healthy.
 */
export async function checkFleetHealth(deps: HealthDeps): Promise<FleetHealthReport> {
  const tenants = await deps.listTenants()
  const rows: TenantHealthRow[] = []
  for (const t of tenants) {
    if (t.status === 'active') {
      const checks = await checkActiveTenant(t, deps)
      rows.push({ slug: t.slug, id: t.id, status: t.status, healthy: checks.every((c) => c.ok), checks })
    } else {
      // Non-active lifecycle states are EXPECTED — reported, not faulted. No
      // data-plane / realm probe (a suspended data plane may be quarantined).
      rows.push({ slug: t.slug, id: t.id, status: t.status, healthy: true, checks: [] })
    }
  }
  return { ok: rows.every((r) => r.healthy), tenants: rows }
}

/** Exit 0 iff the whole fleet is healthy; 1 if ANY tenant is a fault. */
export function fleetExitCode(report: FleetHealthReport): number {
  return report.ok ? 0 : 1
}

/**
 * Render a human-readable table: one line per tenant (slug · status · per-tenant
 * verdict), each failed check named with its detail underneath, and a final
 * overall verdict line. Pairs with the CLI's `--json` (the raw FleetHealthReport).
 */
export function renderHealthTable(report: FleetHealthReport): string {
  const lines: string[] = []
  lines.push('TENANT HEALTH')
  if (report.tenants.length === 0) {
    lines.push('  (no tenants registered)')
  }
  for (const row of report.tenants) {
    const verdict = row.status !== 'active' ? row.status.toUpperCase() : row.healthy ? 'OK' : 'UNHEALTHY'
    // T21: append leaf subscriber/newsletter counts to the verdict when present.
    const leafCheck = row.checks.find((c) => c.name === 'leaf' && c.ok && c.detail)
    const leafSuffix = leafCheck ? `  [leaf: ${leafCheck.detail}]` : ''
    lines.push(`  ${row.healthy ? '   ' : '!! '}${row.slug.padEnd(20)} status=${row.status.padEnd(12)} ${verdict}${leafSuffix}`)
    for (const c of row.checks) {
      if (!c.ok) lines.push(`        FAIL  ${c.name}: ${c.detail}`)
    }
  }
  lines.push('')
  lines.push(report.ok ? 'FLEET: OK' : 'FLEET: UNHEALTHY')
  return lines.join('\n')
}
