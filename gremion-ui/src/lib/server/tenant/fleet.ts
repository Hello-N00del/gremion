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

/**
 * T07 — WHICH subsystem failed the tenant.
 *
 * migrateTenant does two unrelated things inside one try: it applies the
 * data-plane migrations, and it then asserts the tenant's brand identity is
 * complete. Both used to leave an identical trace — an `ok:false` outcome, a
 * `tenant_migration_run` row with `ok = false`, and a log line reading
 * "[fleet-migrations] tenant X: FAILED". So a pilot realm's FIRST boot, whose
 * only problem is an un-materialized config.json, reported a MIGRATION failure
 * and sent whoever debugged it into the migration runner, the SHA-256 manifest
 * and the SQL — a subsystem that was working perfectly.
 *
 * The class travels with the outcome, into the ledger's error field (prefixed,
 * so the column is self-describing without a schema change) and into the
 * per-tenant readiness entry (readiness.ts) that backs the tenant-scoped 503.
 * The outcome's `error` carries the SAME prefixed string the ledger row does —
 * two texts for one failure is how a ledger row and a 503 stop agreeing.
 *
 * `control-plane` is the DEFAULT, not `migration`: everything outside
 * runWithTenant — startTenantMigrationRun, resolveTenantBySlug and the closing
 * finishTenantMigrationRun — is a control-plane operation. Defaulting to
 * `migration` reproduced the exact mis-attribution this type exists to remove:
 * a control-registry outage would have been ledgered as a migration failure and
 * sent whoever debugged it into the SQL.
 */
export type FleetFailureKind = 'control-plane' | 'migration' | 'brand-identity'

export interface FleetMigrationOutcome {
  ok: boolean
  error?: string
  /** Which subsystem failed. Present only on a failure (`ok: false`). */
  kind?: FleetFailureKind
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
  // T07: the class of whatever is running RIGHT NOW. A moving flag rather than a
  // wrapper error because `cause` below must stay the ORIGINAL thrown value —
  // re-wrapping would break that contract. It starts at `control-plane` (the
  // ledger-start and the registry resolve below), becomes `migration` on entry
  // to the tenant scope, `brand-identity` for that one assertion, and returns to
  // `control-plane` for the closing ledger write.
  let kind: FleetFailureKind = 'control-plane'
  try {
    runId = await startTenantMigrationRun(tenant.id)
    const ctx = await resolveTenantBySlug(tenant.slug)
    if (!ctx) {
      throw new Error(
        `tenant "${tenant.slug}" not resolvable (status changed since listing?)`,
      )
    }
    const lastApplied = await runWithTenant(ctx, async () => {
      kind = 'migration'
      await runMigrations()
      // P2.1c (T15 / §6-P2.2): the loud brand-incomplete BOOT/READINESS guard.
      // After neutralization an un-materialized tenant's config resolves
      // product/org_short to empty — rendering a silent blank brand. Assert a
      // COMPLETE brand identity here, inside this tenant's
      // explicit scope (readConfig reads THIS tenant's config.json): a failure
      // throws, is caught below, and travels in the outcome → readiness records
      // the tenant `failed` (readiness.ts) → resolve.ts serves a TENANT-SCOPED
      // 503 (other tenants untouched), never a blank render. A tenant with a
      // materialized config.json (real brand values) passes unchanged.
      try {
        assertBrandIdentityComplete(readConfig(ctx), tenant.slug)
      } catch (brandErr) {
        kind = 'brand-identity'
        throw brandErr
      }
      return readLastApplied()
    })
    // Out of the tenant scope: the closing ledger write is control plane again.
    // Leaving `kind` at 'migration' here would ledger a control-registry outage
    // as a migration failure over migrations that had already SUCCEEDED.
    kind = 'control-plane'
    await finishTenantMigrationRun(runId, { ok: true, lastApplied })
    console.info(`[fleet-migrations] tenant ${tenant.slug}: ok (last applied: ${lastApplied ?? 'none'})`)
    return { ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // T07: ONE classified string. The ledger's single `error` text column and the
    // outcome (→ readiness → the tenant-scoped 503) carry the identical text, so
    // a tenant_migration_run row and an operator's 503 never disagree, and the
    // column says which subsystem failed without a control-plane schema change.
    const classified = `${kind}: ${message}`
    console.error(`[fleet-migrations] tenant ${tenant.slug}: ${kind.toUpperCase()} FAILED — ${message}`)
    if (runId) {
      try {
        await finishTenantMigrationRun(runId, { ok: false, error: classified })
      } catch (ledgerErr) {
        // The ledger is observability, not correctness — never let a control-
        // plane write failure mask the tenant outcome already recorded above.
        console.error(`[fleet-migrations] tenant ${tenant.slug}: ledger write failed:`, ledgerErr)
      }
    }
    return { ok: false, error: classified, kind, cause: err }
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
