import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'

/**
 * P2.1b T4 — the 24h audit-retention purge interval migrates onto the
 * worker-fleet helper: every tick purges audit logs per ACTIVE tenant inside
 * that tenant's EXPLICIT runWithTenant scope (previously it re-entered ONLY
 * the captured default context). The tenant CONTEXT module is deliberately
 * REAL so currentTenantId() recording proves the explicit per-tenant ALS
 * scope ([[als-default-tenant-test-harness-masks-fail-closed]]).
 *
 * Mock block mirrors hooks.boot.test.ts (hooks.server.ts is heavy to import),
 * EXCEPT: $lib/server/tenant/context stays real, and the registry lists TWO
 * active tenants.
 *
 * Boot-once structure (NO vi.resetModules between tests): resetModules would
 * re-evaluate the hooks.server graph with a SECOND generation of the real
 * context module while vitest's cached mock factories (audit-db) keep the
 * FIRST generation's ALS — the purge would then fail-closed against the wrong
 * ALS instance and the test would pass/fail on module identity, not behavior.
 * Instead: boot once, capture the interval tick once, and steer the ACTIVE
 * tenant list per test (the tick reads listActiveTenants() live).
 */

const purgeCalls = vi.hoisted(() => [] as Array<{ scope: string; days: number }>)

vi.mock('$app/environment', () => ({ building: true }))

vi.mock('$env/dynamic/private', () => ({
  env: {
    DATABASE_URL: 'postgresql://gremion:gremion@localhost:5432/gremion',
  },
}))

vi.mock('$lib/server/db', () => ({
  waitForDbReady: vi.fn(async () => {}),
  runMigrations: vi.fn(async () => {}),
  getDb: () => ({}),
}))

// retention.security_logs_days = 42 — asserting 42 below proves the purge
// reads the per-tenant config, not a hardcoded 90.
vi.mock('$lib/server/config', () => ({
  readConfig: () => ({
    smtp: { configured: false, host: '', port: 0, from_address: '' },
    modules: {},
    retention: { security_logs_days: 42 },
  }),
}))

vi.mock('$lib/server/calendar/notification-scheduler', () => ({ startNotificationScheduler: vi.fn() }))
vi.mock('$lib/server/calendar/caldav-sync', () => ({ startCalDavSyncWorker: vi.fn() }))
vi.mock('$lib/server/governance/provisioning/worker', () => ({ startProvisioningWorker: vi.fn() }))
vi.mock('$lib/server/jwt-verify', () => ({ verifyBearerJwt: vi.fn(async () => null) }))

// Records the CURRENT tenant scope per purge — currentTenantId() throws
// outside an ALS scope, which is exactly the fail-closed proof.
vi.mock('$lib/server/audit-db', async () => {
  const { currentTenantId } = await import('$lib/server/tenant/context')
  return {
    purgeAuditLogsOlderThan: vi.fn(async (days: number) => {
      purgeCalls.push({ scope: currentTenantId(), days })
      return { purged: 0 }
    }),
  }
})

vi.mock('$lib/server/tenant/resolve', () => ({
  tenantResolveHandle: vi.fn(async ({ event, resolve }: { event: unknown; resolve: (e: unknown) => unknown }) =>
    resolve(event),
  ),
  // hooks.server.ts also wires tenantForwardFetch as `handleFetch` (gremion#22
  // finding 1) — stub so the module loads; its own behavior is pinned in
  // forward-fetch.test.ts.
  tenantForwardFetch: vi.fn(),
}))
vi.mock('$lib/server/tenant/control-migrations', () => ({ runControlMigrations: vi.fn(async () => {}) }))
vi.mock('$lib/server/tenant/register-default', () => ({ registerDefaultTenant: vi.fn(async () => ({ id: 'tid-default' })) }))

// TWO active tenants — the interval must purge BOTH (steerable per test).
const activeTenants: Array<{ id: string; slug: string; status: string }> = []
vi.mock('$lib/server/tenant/registry', () => ({
  resolveTenantBySlug: vi.fn(async (slug: string) =>
    activeTenants.some((t) => t.slug === slug)
      ? { id: slug === 'default' ? 'tid-default' : 'tid-beta', slug }
      : null,
  ),
  listActiveTenants: vi.fn(async () => activeTenants),
  startTenantMigrationRun: vi.fn(async () => 'run-1'),
  finishTenantMigrationRun: vi.fn(async () => {}),
}))

// NOTE: '$lib/server/tenant/context' is NOT mocked — the real ALS is the point.
vi.mock('$lib/server/tenant/default-tenant', () => ({
  DEFAULT_TENANT: { id: 'default', configPath: '/tmp/config.json' },
}))

vi.mock('./auth', () => ({
  handle: async ({ event, resolve }: { event: unknown; resolve: (e: unknown) => unknown }) =>
    resolve(event),
}))
vi.mock('nodemailer', () => ({ default: { createTransport: vi.fn() } }))

const DAY_MS = 24 * 60 * 60 * 1000

let tick: () => unknown

beforeAll(async () => {
  // Boot needs the default tenant resolvable (control-plane sanity check).
  activeTenants.push({ id: 'tid-default', slug: 'default', status: 'active' })
  const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
  const mod = await import('./hooks.server')
  await mod.boot()
  expect(mod.getBootStatus().complete).toBe(true)
  const call = setIntervalSpy.mock.calls.find((c) => c[1] === DAY_MS)
  expect(call).toBeDefined()
  tick = call![0] as () => unknown
  setIntervalSpy.mockRestore()
})

beforeEach(async () => {
  process.exitCode = 0
  purgeCalls.length = 0
  activeTenants.length = 0
  const { _resetWorkerFleetForTests } = await import('$lib/server/tenant/worker-fleet')
  _resetWorkerFleetForTests()
  // D-READY worker gate: boot's fleet run only marked tid-default ready (the
  // boot-time active list). Mark BOTH ready so the fleet-wrap tests exercise
  // the normal path (and to undo the failed-tenant test's override below).
  const { setTenantReadinessFromFleet } = await import('$lib/server/tenant/readiness')
  setTenantReadinessFromFleet(
    new Map([
      ['tid-default', { ok: true }],
      ['tid-beta', { ok: true }],
    ]),
  )
})

afterEach(() => {
  process.exitCode = 0
})

describe('hooks.server audit-retention interval — P2.1b T4 fleet wrap', () => {
  it('purges per ACTIVE tenant under explicit contexts with the configured retention window', async () => {
    activeTenants.push(
      { id: 'tid-default', slug: 'default', status: 'active' },
      { id: 'tid-beta', slug: 'beta', status: 'active' },
    )

    await tick()

    expect(purgeCalls).toEqual([
      { scope: 'tid-default', days: 42 },
      { scope: 'tid-beta', days: 42 },
    ])
  })

  it('default-tenant-only run stays byte-identical: one purge, default scope', async () => {
    activeTenants.push({ id: 'tid-default', slug: 'default', status: 'active' })

    await tick()

    expect(purgeCalls).toEqual([{ scope: 'tid-default', days: 42 }])
  })

  // Adversarial-review fix (als-worker): the purge tick DELETEs from the
  // tenant's audit_log — it must skip a tenant whose data-plane migration
  // failed (half-migrated DB, racing the lazy re-migration's DDL).
  it('a tenant whose migration FAILED is skipped by the purge tick (D-READY on the worker plane)', async () => {
    activeTenants.push(
      { id: 'tid-default', slug: 'default', status: 'active' },
      { id: 'tid-beta', slug: 'beta', status: 'active' },
    )
    const { setTenantReadinessFromFleet } = await import('$lib/server/tenant/readiness')
    setTenantReadinessFromFleet(new Map([['tid-beta', { ok: false, error: 'schema drift' }]]))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await tick()

    expect(purgeCalls).toEqual([{ scope: 'tid-default', days: 42 }])
    const lines = warnSpy.mock.calls.map((c) => c.join(' '))
    expect(lines.some((l) => l.includes('audit-retention') && l.includes('beta'))).toBe(true)
    warnSpy.mockRestore()
  })
})
