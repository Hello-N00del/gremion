// src/lib/server/tenant/worker-fleet.ts
// P2.1b T4 — the ONE seam every background-worker tick goes through.
//
// `forEachActiveTenant(label, fn)` iterates the ACTIVE registry tenants and
// runs `fn` for each inside an EXPLICIT runWithTenant(ctx, …) scope, so the
// fail-closed data-plane accessors (getDb(), KC-admin, calendar/newsletter
// stores, …) resolve THAT tenant — out-of-request cron/setInterval boundaries
// drop the ambient ALS scope (context.ts contract), which is exactly why every
// worker tick was dark after P2.1a until this wrap.
//
// Semantics (plan T4):
//   - single-flight per (label, tenantId): an in-process keyed set replaces the
//     old process-global `_running` booleans — an overlapping tick skips ONLY
//     the still-running tenant for the SAME worker; other tenants and other
//     workers proceed (one slow tenant never starves the fleet).
//   - fail-safe per tenant: a tenant's throw (or a tenant that no longer
//     resolves) is logged with the worker label and the loop continues.
//   - fail-safe per tick: a control-plane listing failure logs and RESOLVES —
//     a worker tick must never crash/reject on it (unlike the boot fleet in
//     fleet.ts, where a control-plane failure is a process-wide boot failure).
//   - D-READY readiness gate (adversarial-review fix, als-worker): workers are
//     the OTHER traffic source besides HTTP and their ticks WRITE to tenant
//     DBs, so they honor the SAME per-tenant readiness gate as the resolution
//     seam (resolve.ts) — see the comment inside forEachActiveTenant.
import { runWithTenant, type TenantContext } from './context'
import { listActiveTenants, resolveTenantBySlug } from './registry'
import { getTenantReadiness, isFleetPopulated } from './readiness'
import { tlog } from '$lib/server/observability/tenant-log'

/** In-flight (label, tenantId) pairs — the per-tenant single-flight registry. */
const _inFlight = new Set<string>()

/**
 * Run one worker tick over the ACTIVE tenant fleet. `label` names the worker
 * (single-flight key component + structured-log prefix); `fn` is the
 * per-tenant work, executed inside that tenant's explicit ALS scope. NEVER
 * rejects — every failure mode is caught and logged per the contract above.
 */
export async function forEachActiveTenant(
  label: string,
  fn: (ctx: TenantContext) => unknown,
): Promise<void> {
  // D-READY on the WORKER plane (adversarial-review fix): the readiness gate
  // at the HTTP seam (resolve.ts) alone does NOT hold G-014's "no traffic
  // against a half-migrated DB" per tenant — cron/interval ticks write to
  // tenant DBs too (provisioning marks, caldav failure records, newsletter
  // audit entries, audit-purge DELETEs) and would race the single-flighted
  // lazy re-migration's DDL/backfill. Two-layer gate, both fail closed:
  //   1. Before the boot fleet populates the readiness map NOTHING is known
  //      to be migrated — skip the WHOLE tick, before even listing. (The HTTP
  //      seam may stay inert pre-population because authGuard's process-wide
  //      boot gate 503s every request; no such downstream gate exists on the
  //      worker plane, hence the asymmetry. This also makes the newsletter
  //      scheduler's MODULE-LOAD cron start safe: ticks that fire before
  //      boot()'s fleet run are no-ops.)
  //   2. Per tenant, anything but 'ready' (failed/pending) is skipped — and
  //      deliberately NOT retried from here: the lazy re-migration stays
  //      request-driven at the resolution seam, so an idle failed tenant is
  //      not DDL-hammered every 30-60 s by cron pressure. Workers resume on
  //      the first tick after the tenant heals to 'ready'.
  if (!isFleetPopulated()) {
    console.info(
      `[worker-fleet] ${label}: boot fleet has not populated tenant readiness yet — tick skipped (fail closed)`,
    )
    return
  }

  let tenants: readonly { id: string; slug: string }[]
  try {
    tenants = await listActiveTenants()
  } catch (err) {
    console.error(`[worker-fleet] ${label}: listing active tenants failed — tick skipped:`, err)
    return
  }

  for (const tenant of tenants) {
    const readiness = getTenantReadiness(tenant.id)
    if (readiness !== 'ready') {
      console.warn(
        `[worker-fleet] ${label}: tenant ${tenant.slug} not ready (${readiness}) — skipped (D-READY)`,
      )
      continue
    }
    const key = `${label}::${tenant.id}`
    if (_inFlight.has(key)) {
      // Overlapping tick for the SAME (worker, tenant) — skip, never overlap.
      console.info(
        `[worker-fleet] ${label}: tenant ${tenant.slug} still in flight — skipped (single-flight)`,
      )
      continue
    }
    _inFlight.add(key)
    try {
      const ctx = await resolveTenantBySlug(tenant.slug)
      if (!ctx) {
        // Status flipped between LIST and RESOLVE (suspended/deleted) — skip.
        console.error(`[worker-fleet] ${label}: tenant ${tenant.slug} no longer resolvable — skipped`)
        continue
      }
      await runWithTenant(ctx, () => fn(ctx))
    } catch (err) {
      // One tenant's failure never stops the rest of the fleet.
      tlog('error', '[worker-fleet] tenant tick failed', {
        label,
        slug: tenant.slug,
        err: err instanceof Error ? err.message : String(err),
      })
    } finally {
      _inFlight.delete(key)
    }
  }
}

/** Test-only: clear the module-scoped single-flight registry between cases. */
export function _resetWorkerFleetForTests(): void {
  _inFlight.clear()
}
