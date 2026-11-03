// src/lib/server/tenant/provisioner/reconcile-reensure.ts
// Kernel issues #88 and #89 -- one root cause: create-time provisioning that a later release extends is never
// re-applied to customers created earlier. `reconcile` is the verb that re-applies it. Two checks are appended to
// a report (reconcile.ts REENSURE_CHECK_NAMES), each a read of the post-condition plus an idempotent repair:
//
//   purger-connect         the customer's purger role can do what the scheduled purge needs on its kernel database:
//                          CONNECT, USAGE on schema public, SELECT + DELETE on the purge tables (the purge logs in as
//                          it; create time grants all three, an older release none -- CONNECT alone only moves the
//                          failure from "permission denied for database" to "refused: the purger lacks SELECT, DELETE")
//   kernel-api-nats-seed   kernel-api/tenant_<slug>.nk exists and the broker serves the account (the kernel API
//                          relay publishes as that identity; the release that added the relay never backfilled it)
//
// The repair of the second is nats-auth's own ensure path over the customer's CURRENT module set, read from the
// registry (plt.module_enablement) -- never a guessed `--modules` list: ensure is declarative, a wrong set
// suspends modules. Suspended customers are ensured with the empty module set (suspension evicts the modules;
// reconcile must not restore them), and customers that are neither active nor suspended get no such check.
//
// PURE over injected ports (a Sql-free seam), so the flow is unit-testable; customer-adapters.ts and the verb
// (scripts/tenant-provision.ts reconcileOne) supply the live ones. This file sits BESIDE reconcile.ts, not in it.
import { enabledModuleKeys } from '@gremion/provisioning'
import { ensureTenantAccount, tenantAccountProblems, withPlatformIdentities } from '@gremion/nats-auth'
import type postgres from 'postgres'
import { ensureKernelPurgerAccess, kernelPurgerAccessProblems, type ModuleServer } from '@gremion/tenant-store/lifecycle'
import type { ReconcileReport, ReensureCheckName } from './reconcile'

/** One re-ensurable piece of provisioning: `problems` reads the effective state ([] = holds), `repair` re-applies it idempotently. */
export interface ReensurePort {
  problems(): Promise<string[]>
  repair(): Promise<void>
}

/**
 * Appends a re-ensure check to a report. Verify only reads; apply repairs once when it finds a problem and READS
 * AGAIN (the post-condition is observed, not assumed); a second apply finds nothing and applies nothing. A port that
 * throws fails the check with the reason. A null port (the check does not apply to this customer) returns the report
 * as it was. The check can turn a green report red, never a red one green.
 */
export async function withReensureCheck(report: ReconcileReport, name: ReensureCheckName, port: ReensurePort | null, verifyOnly: boolean): Promise<ReconcileReport> {
  if (port === null) return report
  let problems: string[]
  let repaired = false
  try {
    problems = await port.problems()
    if (problems.length > 0 && !verifyOnly) {
      await port.repair()
      repaired = true
      problems = await port.problems()
    }
  } catch (err) {
    problems = [`cannot read or repair: ${err instanceof Error ? err.message : String(err)}`]
  }
  const check = { name, ok: problems.length === 0, detail: problems.join('; ') }
  return {
    ...report,
    ok: report.ok && check.ok,
    checks: [...report.checks, check],
    applied: repaired && check.ok ? [...report.applied, name] : report.applied,
  }
}

// ── #89: the purger's access to the customer's kernel database (CONNECT, schema USAGE, purge-table grants) ──────────────────────────────────────────────
export function purgerConnectPort(server: ModuleServer, tenantId: string): ReensurePort {
  return {
    problems: () => kernelPurgerAccessProblems(server, tenantId),
    repair: async () => {
      await ensureKernelPurgerAccess(server, tenantId)
    },
  }
}

export function reconcilePurgerConnect(report: ReconcileReport, server: ModuleServer, tenantId: string, verifyOnly: boolean): Promise<ReconcileReport> {
  return withReensureCheck(report, 'purger-connect', purgerConnectPort(server, tenantId), verifyOnly)
}

// ── #88: the kernel-api NATS seed ────────────────────────────────────────────────────────────────────────────
export interface KernelApiSeedDeps {
  /** The customer's enabled modules in the registry (plt.module_enablement), by control-row id. */
  enabledModules(customerId: string): Promise<string[]>
  problems(input: { tenant: string; modules: readonly string[] }): string[]
  ensure(input: { tenant: string; modules: readonly string[] }): Promise<unknown>
}

/** The live deps: the registry from gremion_platform, nats-auth's read-only check and its ensure (NATS_URL, the seed store). */
export function kernelApiSeedDeps(platform: postgres.Sql): KernelApiSeedDeps {
  return {
    enabledModules: (customerId) => enabledModuleKeys(platform, customerId),
    problems: (input) => tenantAccountProblems(input),
    ensure: (input) => ensureTenantAccount(input),
  }
}

/** null: the check does not apply (a customer being created creates the seed itself; a deleted one has no account). */
export function kernelApiSeedPort(tenant: { id: string; slug: string; status: string }, deps: KernelApiSeedDeps): ReensurePort | null {
  if (tenant.status !== 'active' && tenant.status !== 'suspended') return null
  const modulesOf = async (): Promise<string[]> => withPlatformIdentities(tenant.status === 'suspended' ? [] : await deps.enabledModules(tenant.id))
  return {
    problems: async () => deps.problems({ tenant: tenant.slug, modules: await modulesOf() }),
    repair: async () => {
      await deps.ensure({ tenant: tenant.slug, modules: await modulesOf() })
    },
  }
}

export function reconcileKernelApiSeed(report: ReconcileReport, tenant: { id: string; slug: string; status: string }, deps: KernelApiSeedDeps, verifyOnly: boolean): Promise<ReconcileReport> {
  return withReensureCheck(report, 'kernel-api-nats-seed', kernelApiSeedPort(tenant, deps), verifyOnly)
}
