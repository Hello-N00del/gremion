// src/lib/server/tenant/readiness.ts
// P2.1b T3 (D-READY) — per-tenant boot readiness. Replaces the process-wide
// "_bootComplete or 503-everything" contract at TENANT granularity: the boot
// fleet run (fleet.ts, D-FLEET) populates this map with each tenant's
// migration outcome; tenantResolveHandle (resolve.ts) then serves a
// tenant-scoped 503 for `failed`/`pending` tenants while every other tenant
// serves normally — one tenant's failure never takes the fleet down. The
// WORKER plane consults the same map: forEachActiveTenant (worker-fleet.ts)
// skips not-ready tenants (and whole ticks pre-population) so background
// writes never race a re-migration on a half-migrated tenant DB.
//
// Lazy re-attempt: a request that hits a failed/pending tenant triggers ONE
// single-flighted re-migration for that tenant (ledgered like a boot fleet
// run); the next resolution re-checks the map. Retries are DISABLED until the
// boot fleet has populated the map — boot owns the first attempt, so a request
// racing the boot fleet can never start a concurrent second migration.
//
// Control-plane/boot failure stays PROCESS-wide (hooks.server.ts `_bootError`
// → 503 for everything): nothing can resolve a tenant without the control
// plane, so per-tenant readiness is meaningless there (D-READY).
import { migrateTenant, type FleetMigrationOutcome } from './fleet'
import type { TenantContext } from './context'

export type TenantReadiness = 'ready' | 'failed' | 'pending'

interface ReadinessEntry {
  state: TenantReadiness
  error?: string
}

const _readiness = new Map<string, ReadinessEntry>()
let _fleetPopulated = false
/** Per-tenant single-flight: at most ONE lazy re-migration in flight per tenant. */
const _retriesInFlight = new Map<string, Promise<void>>()

/** Boot (hooks.server.ts) records the fleet run's per-tenant outcomes here. */
export function setTenantReadinessFromFleet(
  outcomes: ReadonlyMap<string, FleetMigrationOutcome>,
): void {
  for (const [tenantId, outcome] of outcomes) {
    _readiness.set(
      tenantId,
      outcome.ok ? { state: 'ready' } : { state: 'failed', error: outcome.error },
    )
  }
  _fleetPopulated = true
}

/** True once the boot fleet has run — before that the seam gate stays inert
 *  (the process-wide boot gate owns pre-boot/failed-boot 503s). */
export function isFleetPopulated(): boolean {
  return _fleetPopulated
}

/** A tenant the fleet never saw (e.g. registered after boot) is `pending`. */
export function getTenantReadiness(tenantId: string): TenantReadiness {
  return _readiness.get(tenantId)?.state ?? 'pending'
}

/** The recorded migration error for a `failed` tenant (diagnostics only). */
export function getTenantReadinessError(tenantId: string): string | undefined {
  return _readiness.get(tenantId)?.error
}

/**
 * Trigger ONE single-flighted lazy re-migration for a failed/pending tenant
 * (D-READY retry path). Fire-and-forget at the call site — the caller serves
 * its 503 immediately and the NEXT resolution re-checks the map. Returns the
 * in-flight attempt (new or coalesced) so tests can await it; null when no
 * attempt starts (fleet not populated yet, or the tenant is already ready).
 */
export function triggerTenantMigrationRetry(
  tenant: Pick<TenantContext, 'id' | 'slug'>,
): Promise<void> | null {
  if (!_fleetPopulated) return null // boot owns the first attempt
  if (getTenantReadiness(tenant.id) === 'ready') return null
  const inFlight = _retriesInFlight.get(tenant.id)
  if (inFlight) return inFlight

  console.info(`[tenant-readiness] tenant ${tenant.slug}: lazy re-migration attempt starting (D-READY)`)
  const attempt = (async () => {
    // migrateTenant never throws — it ledgers and returns the outcome
    // (fleet.ts); the defensive catch below covers any unexpected escape.
    const outcome = await migrateTenant({ id: tenant.id, slug: tenant.slug })
    _readiness.set(
      tenant.id,
      outcome.ok ? { state: 'ready' } : { state: 'failed', error: outcome.error },
    )
    console.info(
      `[tenant-readiness] tenant ${tenant.slug}: re-migration ${
        outcome.ok ? 'succeeded — tenant ready' : `failed — ${outcome.error}`
      }`,
    )
  })()
    .catch((err) => {
      _readiness.set(tenant.id, {
        state: 'failed',
        error: err instanceof Error ? err.message : String(err),
      })
      console.error(`[tenant-readiness] tenant ${tenant.slug}: re-migration attempt errored:`, err)
    })
    .finally(() => {
      _retriesInFlight.delete(tenant.id)
    })
  _retriesInFlight.set(tenant.id, attempt)
  return attempt
}

/** Test-only: clear the module-scoped readiness state between cases. */
export function _resetReadinessForTests(): void {
  _readiness.clear()
  _retriesInFlight.clear()
  _fleetPopulated = false
}
