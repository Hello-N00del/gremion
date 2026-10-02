import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'

// NB: GREMION_DISABLE_SEEDS=true is set in vitest.integration.config.ts (BEFORE
// the $env/dynamic/private snapshot — setting it here in module scope is too
// late). It makes boot()'s data-plane runMigrations() skip the *_seed.sql dev
// seeds (which reference a committees table the harness doesn't populate).
// This does NOT mask FIX 1 — waitForDbReady's control-pool probe runs FIRST,
// before runMigrations, so a fail-closed probe would still abort boot.

// ── Real-boot regression for FIX 1 (final review / CRITICAL) ────────────────
//
// hooks.boot.test.ts mocks $lib/server/db ENTIRELY (waitForDbReady is a no-op,
// getDb returns {}), so it could never have caught the boot-killer it was
// supposed to guard: boot()'s `await waitForDbReady()` used the DEFAULT ping
// `() => getDb()`SELECT 1``, and getDb() is now fail-closed (requireTenant()
// THROWS "no tenant context" with no ALS). That throw is NON-transient, so
// waitForDbReady rethrows on attempt #1 -> boot catches -> process.exitCode=1
// -> permanent 503. FIX 1 makes the probe ping the CONTROL pool instead.
//
// This test exercises the REAL boot() end-to-end: it mocks ONLY the
// worker/scheduler/nodemailer side-effects, and leaves $lib/server/db,
// control-db, control-migrations, registry and context REAL, running against
// the control+gremion test DBs. TASK-042: boot registers no tenant, so the
// one tenant it migrates here is a fixture made by createTestTenant.

vi.mock('$app/environment', () => ({ building: true }))
// $env/dynamic/private AND $lib/server/config stay REAL so db.ts/control-db.ts
// read the integration config's DATABASE_URL / CONTROL_DATABASE_URL
// (vitest.integration.config.ts) and resolveTenantBySlug -> brandFromConfig(cfg)
// can dereference the real cfg.brand when the fleet resolves the tenant.
vi.mock('$lib/server/calendar/notification-scheduler', () => ({ startNotificationScheduler: vi.fn() }))
vi.mock('$lib/server/calendar/caldav-sync', () => ({ startCalDavSyncWorker: vi.fn() }))
vi.mock('$lib/server/governance/provisioning/worker', () => ({ startProvisioningWorker: vi.fn() }))
// Task 23: hooks.server.ts no longer boots a newsletter SQLite store or scheduler
// (the leaf service owns them), so there are no newsletter modules to mock here.
vi.mock('$lib/server/audit-db', () => ({ purgeAuditLogsOlderThan: vi.fn(async () => ({ purged: 0 })) }))
vi.mock('./auth', () => ({ handle: async ({ event, resolve }: { event: unknown; resolve: (e: unknown) => unknown }) => resolve(event) }))
vi.mock('nodemailer', () => ({ default: { createTransport: vi.fn() } }))
// NOTE: $lib/server/db, control-db, control-migrations, registry, context are
// DELIBERATELY left REAL — that is the whole point.

import { getControlDb } from './lib/server/tenant/control-db'
import { _getAls } from './lib/server/tenant/context'
import { _resetResolutionCacheForTests } from './lib/server/tenant/registry'
import { createTestTenant } from '../tests/integration/create-test-tenant'

// P2.1c (T15 / §6-P2.2): boot's fleet asserts a COMPLETE brand identity per
// tenant after migrations succeed. The fixture tenant `fixture` reads
// `${TENANT_DATA_ROOT}/fixture/config.json`, which vitest.integration.config.ts
// points at the committed complete-brand fixture tree.
describe('hooks.server REAL boot (FIX 1: waitForDbReady probes the control pool)', () => {
  beforeAll(async () => {
    // boot() runs runControlMigrations() itself, but the fixture registration
    // below needs the control schema present first. Truncate to a clean
    // registry in beforeEach.
    const { runControlMigrations } = await import('./lib/server/tenant/control-migrations')
    await runControlMigrations()
  })
  beforeEach(async () => {
    await getControlDb()`TRUNCATE tenant, tenant_provisioning_resource RESTART IDENTITY CASCADE`
    _resetResolutionCacheForTests()
    process.exitCode = 0
    // Drop any cached hooks.server so the module-load-time boot() (re-)runs
    // freshly INSIDE the cleared-ALS import below — not against a promise that
    // was already resolved while the harness tenant happened to be ambient.
    vi.resetModules()
  })

  it('boot() completes against the real control+gremion DBs (no fail-closed probe throw)', async () => {
    const fixture = await createTestTenant({ slug: 'fixture', host: 'fixture.test' })
    // CRITICAL: production boots with NO ambient tenant ALS — the fail-closed
    // getDb() throw is exactly what the pre-fix default probe `() => getDb()
    // `SELECT 1`` hits. The shared integration harness (tests/integration/
    // setup.ts) enterWith()s the fixture tenant before each test, which would
    // MASK the bug: getDb() would find that ambient tenant and never throw.
    //
    // hooks.server.ts calls boot() at MODULE LOAD (and caches the promise), so
    // we must import it from WITHIN _getAls().exit() — that runs the import (and
    // therefore the module-load boot()) with the store cleared, matching the
    // production precondition.
    const mod = await _getAls().exit(async () => {
      const m = await import('./hooks.server')
      await m.boot()
      return m
    })
    const status = mod.getBootStatus()
    expect(status.error).toBeNull()
    expect(status.complete).toBe(true)
    expect(process.exitCode).toBe(0)

    // P2.1b T2 (D-FLEET): boot's data-plane migration step is a fleet run over
    // the ACTIVE registry tenants — exactly one ok ledger row lands in the
    // control plane's tenant_migration_run for the one registered tenant.
    const runs = await getControlDb()`
      SELECT r.* FROM tenant_migration_run r WHERE r.tenant_id = ${fixture.id}`
    expect(runs.length).toBe(1)
    expect(runs[0].ok).toBe(true)
    expect(runs[0].finished_at).not.toBeNull()
    expect(runs[0].error).toBeNull()

    // P2.1b T3 (D-READY): boot populated the per-tenant readiness map and the
    // tenant is `ready`. Import AFTER the hooks.server import above so we read
    // the SAME (reset) module instance boot wrote into.
    const readiness = await import('./lib/server/tenant/readiness')
    expect(readiness.isFleetPopulated()).toBe(true)
    expect(readiness.getTenantReadiness(fixture.id)).toBe('ready')
  })
})
