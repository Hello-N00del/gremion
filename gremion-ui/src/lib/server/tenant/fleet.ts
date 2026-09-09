// src/lib/server/tenant/fleet.ts
// P2.1b T2 (D-FLEET) — the boot data-plane migration step as a FLEET run over
// the ACTIVE registry tenants (default included — same path, §8.1). Each
// tenant: resolveTenantBySlug → runWithTenant(ctx, runMigrations) — so the
// P0.2 module-skip applies per tenant via THAT tenant's config — with the
// outcome ledgered in the control plane's tenant_migration_run (002). One
// tenant's failure is caught and recorded; it NEVER blocks the rest of the
// fleet — the outcome feeds the per-tenant readiness map (readiness.ts,
// D-READY/T3), which also re-uses migrateTenant() for its lazy single-flighted
// re-attempt. Only a CONTROL-plane failure (listing the tenants) escapes —
// nothing can resolve without it, so that stays a process-wide boot failure.
import { runMigrations, getDb } from '$lib/server/db'
import { readConfig } from '$lib/server/config'
import { runWithTenant } from './context'
import {
  listActiveTenants,
  resolveTenantBySlug,
  startTenantMigrationRun,
  finishTenantMigrationRun,
} from './registry'
import { assertBrandIdentityComplete } from './provisioner/materialize'

export interface FleetMigrationOutcome {
  ok: boolean
  error?: string
  /** The ORIGINAL thrown value, identity preserved for diagnostics — callers
   *  that need the real error must never get a re-wrapped message instead. */
  cause?: unknown
}

/** A registry row's identity — all migrateTenant needs. It re-resolves the
 *  full context by slug, so a (lazy) re-run always uses CURRENT registry state. */
export interface FleetTenantRef {
  id: string
  slug: string
}

/**
 * Migrate ONE tenant: ledger-start → resolve → runWithTenant(ctx, runMigrations)
 * → ledger-finish. NEVER throws — the failure travels in the outcome (with its
 * original `cause`). Used by the boot fleet below AND the D-READY lazy
 * re-migration retry (readiness.ts, T3).
 */
export async function migrateTenant(tenant: FleetTenantRef): Promise<FleetMigrationOutcome> {
  let runId: string | null = null
  try {
    runId = await startTenantMigrationRun(tenant.id)
    const ctx = await resolveTenantBySlug(tenant.slug)
    if (!ctx) {
      throw new Error(
        `tenant "${tenant.slug}" not resolvable (status changed since listing?)`,
      )
    }
    const lastApplied = await runWithTenant(ctx, async () => {
      await runMigrations()
      // P2.1c (T15 / §6-P2.2): the loud brand-incomplete BOOT/READINESS guard.
      // After neutralization an un-materialized tenant's config resolves
      // product/org_short to empty — rendering a silent blank brand. Assert a
      // COMPLETE brand identity here, inside this tenant's
      // explicit scope (readConfig reads THIS tenant's config.json): a failure
      // throws, is caught below, and travels in the outcome → readiness records
      // the tenant `failed` (readiness.ts) → resolve.ts serves a TENANT-SCOPED
      // 503 (other tenants untouched), never a blank render. The default tenant
      // (materialized config.json with real brand values) passes unchanged.
      assertBrandIdentityComplete(readConfig(ctx), tenant.slug)
      return readLastApplied()
    })
    await finishTenantMigrationRun(runId, { ok: true, lastApplied })
    console.info(`[fleet-migrations] tenant ${tenant.slug}: ok (last applied: ${lastApplied ?? 'none'})`)
    return { ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[fleet-migrations] tenant ${tenant.slug}: FAILED — ${message}`)
    if (runId) {
      try {
        await finishTenantMigrationRun(runId, { ok: false, error: message })
      } catch (ledgerErr) {
        // The ledger is observability, not correctness — never let a control-
        // plane write failure mask the tenant outcome already recorded above.
        console.error(`[fleet-migrations] tenant ${tenant.slug}: ledger write failed:`, ledgerErr)
      }
    }
    return { ok: false, error: message, cause: err }
  }
}

/**
 * Run the data-plane migrations for every ACTIVE tenant, returning the
 * per-tenant outcome keyed by canonical tenant id. Boot feeds this map into
 * setTenantReadinessFromFleet (readiness.ts, D-READY/T3) — a failed tenant
 * serves a tenant-scoped 503 with lazy retry instead of failing boot.
 */
export async function runFleetMigrations(): Promise<Map<string, FleetMigrationOutcome>> {
  const outcomes = new Map<string, FleetMigrationOutcome>()
  const tenants = await listActiveTenants()

  for (const tenant of tenants) {
    outcomes.set(tenant.id, await migrateTenant(tenant))
  }

  return outcomes
}

/**
 * Best-effort schema_migrations high-water mark for the CURRENT tenant scope.
 * Purely informational ledger metadata — its failure must never fail a tenant
 * whose migrations already applied cleanly.
 */
async function readLastApplied(): Promise<string | null> {
  try {
    const rows = await getDb()<{ filename: string }[]>`
      SELECT filename FROM schema_migrations ORDER BY filename DESC LIMIT 1`
    return rows[0]?.filename ?? null
  } catch (err) {
    console.warn('[fleet-migrations] last_applied probe failed (ignored):', err)
    return null
  }
}
