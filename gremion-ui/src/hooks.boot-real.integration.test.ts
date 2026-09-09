import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'

// NB: GREMION_DISABLE_SEEDS=true is set in vitest.integration.config.ts (BEFORE
// the $env/dynamic/private snapshot — setting it here in module scope is too
// late). It makes boot()'s data-plane runMigrations() a clean no-op: the
// integration DB has the 33 schema migrations applied but not the *_seed.sql
// dev seeds (which reference a committees table the harness doesn't populate).
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
// control-db, control-migrations, register-default, registry and context REAL,
// running against the control+gremion test DBs. With FIX 1 it boots clean; with
// the pre-fix default probe it would set _bootError = "no tenant context".

vi.mock('$app/environment', () => ({ building: true }))
// $env/dynamic/private AND $lib/server/config stay REAL so db.ts/control-db.ts
// read the integration config's DATABASE_URL / CONTROL_DATABASE_URL
// (vitest.integration.config.ts) and resolveTenantBySlug -> brandFromConfig(cfg)
// can dereference the real cfg.brand when boot resolves the default context.
vi.mock('$lib/server/calendar/notification-scheduler', () => ({ startNotificationScheduler: vi.fn() }))
vi.mock('$lib/server/calendar/caldav-sync', () => ({ startCalDavSyncWorker: vi.fn() }))
vi.mock('$lib/server/governance/provisioning/worker', () => ({ startProvisioningWorker: vi.fn() }))
// Task 23: hooks.server.ts no longer boots a newsletter SQLite store or scheduler
// (the leaf service owns them), so there are no newsletter modules to mock here.
vi.mock('$lib/server/audit-db', () => ({ purgeAuditLogsOlderThan: vi.fn(async () => ({ purged: 0 })) }))
vi.mock('./auth', () => ({ handle: async ({ event, resolve }: { event: unknown; resolve: (e: unknown) => unknown }) => resolve(event) }))
vi.mock('nodemailer', () => ({ default: { createTransport: vi.fn() } }))
// NOTE: $lib/server/db, control-db, control-migrations, register-default,
// registry, context are DELIBERATELY left REAL — that is the whole point.

import { getControlDb } from './lib/server/tenant/control-db'
import { _getAls } from './lib/server/tenant/context'

// P2.1c (T15 / §6-P2.2): boot's fleet now asserts a COMPLETE brand identity per
// tenant after migrations succeed. In production the DEFAULT tenant is
// MATERIALIZED (its config.json carries real brand values), so the default
// tenant must resolve a complete brand for boot to flip it `ready`. The suite's
// CONFIG_PATH is pointed at the committed complete-brand fixture
// (tests/integration/fixtures/default-config.json) in vitest.integration.config.ts
// — it MUST be set there, before the $env/dynamic/private snapshot at worker
// fork (setting process.env here, after that snapshot, is too late). Without a
// complete brand the default tenant would correctly be marked not-ready.
describe('hooks.server REAL boot (FIX 1: waitForDbReady probes the control pool)', () => {
  beforeAll(async () => {
    // boot() runs runControlMigrations() itself, but registerDefaultTenant +
    // the data-plane runMigrations need the control schema present and the
    // gremion migrations already applied (the test DBs are pre-migrated per the
    // harness contract). Truncate to a clean registry first.
    const { runControlMigrations } = await import('./lib/server/tenant/control-migrations')
    await runControlMigrations()
  })
  beforeEach(async () => {
    await getControlDb()`TRUNCATE tenant, tenant_provisioning_resource RESTART IDENTITY CASCADE`
    process.exitCode = 0
    // Drop any cached hooks.server so the module-load-time boot() (re-)runs
    // freshly INSIDE the cleared-ALS import below — not against a promise that
    // was already resolved while the harness tenant happened to be ambient.
    vi.resetModules()
  })

  it('boot() completes against the real control+gremion DBs (no fail-closed probe throw)', async () => {
    // CRITICAL: production boots with NO ambient tenant ALS — the fail-closed
    // getDb() throw is exactly what the pre-fix default probe `() => getDb()
    // `SELECT 1`` hits. The shared integration harness (tests/integration/
    // setup.ts) enterWith()s a DEFAULT_TEST_TENANT before each test, which would
    // MASK the bug: getDb() would find that ambient tenant and never throw.
    //
    // hooks.server.ts calls boot() at MODULE LOAD (and caches the promise), so
    // we must import it from WITHIN _getAls().exit() — that runs the import (and
    // therefore the module-load boot()) with the store cleared, matching the
    // production precondition. Reverting FIX 1 (back to `await waitForDbReady()`)
    // makes this fail with _bootError = "No tenant context: getTenant() called
    // outside runWithTenant()"; with FIX 1 the control-pool probe succeeds.
    // (boot()'s own runWithTenant block still scopes the data-plane
    // runMigrations() correctly — only the pre-migration readiness probe routed
    // through the fail-closed getDb().)
    const mod = await _getAls().exit(async () => {
      const m = await import('./hooks.server')
      await m.boot()
      return m
    })
    const status = mod.getBootStatus()
    expect(status.error).toBeNull()
    expect(status.complete).toBe(true)
    expect(process.exitCode).toBe(0)

    // P2.1b T2 (D-FLEET): boot's data-plane migration step is now a fleet run
    // over the ACTIVE registry tenants — with only the default tenant present,
    // behavior is identical AND exactly one ok ledger row lands in the control
    // plane's tenant_migration_run for it.
    const runs = await getControlDb()`
      SELECT r.* FROM tenant_migration_run r
      JOIN tenant t ON t.id = r.tenant_id
      WHERE t.slug = 'default'`
    expect(runs.length).toBe(1)
    expect(runs[0].ok).toBe(true)
    expect(runs[0].finished_at).not.toBeNull()
    expect(runs[0].error).toBeNull()

    // P2.1b T3 (D-READY): boot populated the per-tenant readiness map and the
    // default tenant is `ready` — the seam gate passes its requests straight
    // through, byte-identical to the pre-T3 single-tenant run. Import AFTER
    // the hooks.server import above so we read the SAME (reset) module
    // instance boot wrote into.
    const readiness = await import('./lib/server/tenant/readiness')
    const tid = await getControlDb()<{ id: string }[]>`SELECT id FROM tenant WHERE slug = 'default'`
    expect(readiness.isFleetPopulated()).toBe(true)
    expect(readiness.getTenantReadiness(tid[0].id)).toBe('ready')
  })
})
