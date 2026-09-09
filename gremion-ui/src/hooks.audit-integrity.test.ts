import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'

/**
 * gremion#22 finding 1 — the kernel carve dropped the periodic audit-chain
 * verification tick (verifyAuditChain()/readAuditLog() in audit-db.ts had
 * zero production callers). This pins the restored 6h tick: it re-verifies
 * the audit_log hash chain per ACTIVE tenant inside that tenant's EXPLICIT
 * runWithTenant scope and logs LOUDLY (console.error) when a chain is broken.
 *
 * Structure mirrors hooks.audit-retention.test.ts (hooks.server.ts is heavy to
 * import, so every module-scoped dependency is stubbed): the tenant CONTEXT
 * module is deliberately REAL so currentTenantId() recording proves the
 * explicit per-tenant ALS scope, and the registry lists TWO active tenants.
 *
 * Boot-once structure (NO vi.resetModules between tests): resetModules would
 * re-evaluate the hooks.server graph with a SECOND generation of the real
 * context module while vitest's cached mock factories (audit-db) keep the
 * FIRST generation's ALS — the verify would then fail-closed against the
 * wrong ALS instance and the test would pass/fail on module identity, not
 * behavior. Instead: boot once, capture the interval tick once, and steer the
 * ACTIVE tenant list + verify result per test.
 */

const verifyCalls = vi.hoisted(() => [] as Array<{ scope: string }>)
const verifyResults = vi.hoisted(
  () => new Map<string, { ok: true } | { ok: false; brokenAtId: number }>(),
)

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

vi.mock('$lib/server/config', () => ({
  readConfig: () => ({
    smtp: { configured: false, host: '', port: 0, from_address: '' },
    modules: {},
    retention: { security_logs_days: 90 },
  }),
}))

vi.mock('$lib/server/calendar/notification-scheduler', () => ({ startNotificationScheduler: vi.fn() }))
vi.mock('$lib/server/calendar/caldav-sync', () => ({ startCalDavSyncWorker: vi.fn() }))
vi.mock('$lib/server/governance/provisioning/worker', () => ({ startProvisioningWorker: vi.fn() }))
vi.mock('$lib/server/jwt-verify', () => ({ verifyBearerJwt: vi.fn(async () => null) }))

// Records the CURRENT tenant scope per verify — currentTenantId() throws
// outside an ALS scope, which is exactly the fail-closed proof. purgeAuditLogsOlderThan
// is stubbed inert (the retention tick's own behavior is pinned in
// hooks.audit-retention.test.ts) — this file only exercises verifyAuditChain.
vi.mock('$lib/server/audit-db', async () => {
  const { currentTenantId } = await import('$lib/server/tenant/context')
  return {
    purgeAuditLogsOlderThan: vi.fn(async () => ({ purged: 0 })),
    verifyAuditChain: vi.fn(async () => {
      const scope = currentTenantId()
      verifyCalls.push({ scope })
      return verifyResults.get(scope) ?? { ok: true }
    }),
  }
})

vi.mock('$lib/server/tenant/resolve', () => ({
  tenantResolveHandle: vi.fn(async ({ event, resolve }: { event: unknown; resolve: (e: unknown) => unknown }) =>
    resolve(event),
  ),
  tenantForwardFetch: vi.fn(),
}))
vi.mock('$lib/server/tenant/control-migrations', () => ({ runControlMigrations: vi.fn(async () => {}) }))
vi.mock('$lib/server/tenant/register-default', () => ({ registerDefaultTenant: vi.fn(async () => ({ id: 'tid-default' })) }))

// TWO active tenants — the interval must verify BOTH (steerable per test).
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

const HOUR_MS = 60 * 60 * 1000
const AUDIT_INTEGRITY_INTERVAL_MS = 6 * HOUR_MS

let tick: () => unknown

beforeAll(async () => {
  // Boot needs the default tenant resolvable (control-plane sanity check).
  activeTenants.push({ id: 'tid-default', slug: 'default', status: 'active' })
  const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
  const mod = await import('./hooks.server')
  await mod.boot()
  expect(mod.getBootStatus().complete).toBe(true)
  const call = setIntervalSpy.mock.calls.find((c) => c[1] === AUDIT_INTEGRITY_INTERVAL_MS)
  expect(call).toBeDefined()
  tick = call![0] as () => unknown
  setIntervalSpy.mockRestore()
})

beforeEach(async () => {
  process.exitCode = 0
  verifyCalls.length = 0
  verifyResults.clear()
  activeTenants.length = 0
  const { _resetWorkerFleetForTests } = await import('$lib/server/tenant/worker-fleet')
  _resetWorkerFleetForTests()
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

describe('hooks.server audit-integrity interval (gremion#22 finding 1)', () => {
  it('verifies the audit chain for EVERY ACTIVE tenant under its explicit context', async () => {
    activeTenants.push(
      { id: 'tid-default', slug: 'default', status: 'active' },
      { id: 'tid-beta', slug: 'beta', status: 'active' },
    )

    await tick()

    expect(verifyCalls).toEqual([{ scope: 'tid-default' }, { scope: 'tid-beta' }])
  })

  it('an intact chain logs nothing (silent success — detection-only, non-alerting)', async () => {
    activeTenants.push({ id: 'tid-default', slug: 'default', status: 'active' })
    verifyResults.set('tid-default', { ok: true })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await tick()

    const lines = errorSpy.mock.calls.map((c) => c.join(' '))
    expect(lines.some((l) => l.includes('audit-integrity'))).toBe(false)
    errorSpy.mockRestore()
  })

  it('a BROKEN chain logs LOUDLY (console.error) with the broken-at id — never throws / never halts boot', async () => {
    activeTenants.push({ id: 'tid-default', slug: 'default', status: 'active' })
    verifyResults.set('tid-default', { ok: false, brokenAtId: 7 })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(tick()).resolves.toBeUndefined()

    const lines = errorSpy.mock.calls.map((c) => c.join(' '))
    expect(lines.some((l) => l.includes('audit-integrity') && l.includes('BROKEN') && l.includes('7'))).toBe(true)
    errorSpy.mockRestore()
  })

  it('a tenant whose migration FAILED is skipped by the integrity tick (D-READY on the worker plane)', async () => {
    activeTenants.push(
      { id: 'tid-default', slug: 'default', status: 'active' },
      { id: 'tid-beta', slug: 'beta', status: 'active' },
    )
    const { setTenantReadinessFromFleet } = await import('$lib/server/tenant/readiness')
    setTenantReadinessFromFleet(new Map([['tid-beta', { ok: false, error: 'schema drift' }]]))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await tick()

    expect(verifyCalls).toEqual([{ scope: 'tid-default' }])
    const lines = warnSpy.mock.calls.map((c) => c.join(' '))
    expect(lines.some((l) => l.includes('audit-integrity') && l.includes('beta'))).toBe(true)
    warnSpy.mockRestore()
  })
})
