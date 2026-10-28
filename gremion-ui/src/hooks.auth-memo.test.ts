import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// authGuard must memoise locals.auth() for the rest of the request. Auth.js
// rebuilds the session from the ORIGINAL cookie header on every call, so a
// second call after the access token expired would refresh again with an
// already-used refresh token (and, with rotation on, log the user out).
let migrationsImpl: () => Promise<void> = async () => {}
vi.mock('$app/environment', () => ({ building: true }))
vi.mock('$env/dynamic/private', () => ({ env: { DATABASE_URL: 'postgresql://gremion:gremion@localhost:5432/gremion' } }))
vi.mock('$lib/server/db', () => ({ waitForDbReady: vi.fn(async () => {}), runMigrations: () => migrationsImpl(), getDb: () => ({}) }))
vi.mock('$lib/server/config', () => ({ readConfig: () => ({ smtp: { configured: false }, modules: { finance: true }, retention: { security_logs_days: 27 } }) }))
vi.mock('$lib/server/calendar/notification-scheduler', () => ({ startNotificationScheduler: vi.fn() }))
vi.mock('$lib/server/calendar/caldav-sync', () => ({ startCalDavSyncWorker: vi.fn() }))
vi.mock('$lib/server/governance/provisioning/worker', () => ({ startProvisioningWorker: vi.fn() }))
vi.mock('$lib/server/audit-db', () => ({ verifyAuditChain: vi.fn(async () => ({ ok: true })) }))
vi.mock('./auth', () => ({ handle: async ({ event, resolve }: { event: unknown; resolve: (e: unknown) => unknown }) => resolve(event) }))
vi.mock('$lib/server/tenant/control-migrations', () => ({ runControlMigrations: vi.fn(async () => {}) }))
vi.mock('$lib/server/tenant/registry', () => ({
  resolveTenantBySlug: vi.fn(async () => ({ id: 'default', slug: 'default', issuer: 'https://kc/realms/gremion-test' })),
  listActiveTenants: vi.fn(async () => [{ id: 'tid-1', slug: 'default', status: 'active' }]),
  startTenantMigrationRun: vi.fn(async () => 'run-1'),
  finishTenantMigrationRun: vi.fn(async () => {}),
}))
vi.mock('$lib/server/tenant/context', () => ({ runWithTenant: (_ctx: unknown, fn: () => unknown) => fn() }))
vi.mock('nodemailer', () => ({ default: { createTransport: vi.fn() } }))
vi.mock('$lib/server/jwt-verify', () => ({ verifyBearerJwt: vi.fn(async () => null) }))

const ISS = 'https://id.example.org/realms/tenant-a'

beforeEach(() => { vi.resetModules(); process.exitCode = 0; migrationsImpl = async () => {} })
afterEach(() => { process.exitCode = 0 })

describe('authGuard memoises locals.auth() per request', () => {
  it('a later locals.auth() call (root layout, +page.server load) does not rebuild the session', async () => {
    const mod = await import('./hooks.server'); await mod.boot()
    // Every call mints a DIFFERENT session object, like a fresh token refresh would.
    let calls = 0
    const auth = vi.fn(async () => {
      calls += 1
      return { user: { id: 'u1', roles: ['member'], groups: [] }, accessToken: `kc-${calls}`, tokenIss: ISS }
    })
    const event = {
      url: new URL('http://localhost/dashboard'),
      request: new Request('http://localhost/dashboard'),
      params: {},
      locals: { tenant: { id: 'a', slug: 'tenant-a', issuer: ISS, config: {} }, user: null, accessToken: null, accessTokenExpires: null, auth } as Record<string, unknown>,
    }
    const res = (await mod.authGuard({ event: event as never, resolve: async () => new Response('ok') } as never)) as Response
    expect(res.status).toBe(200)
    const layout = await (event.locals.auth as () => Promise<{ accessToken: string }>)()
    const page = await (event.locals.auth as () => Promise<{ accessToken: string }>)()
    expect(auth).toHaveBeenCalledTimes(1)
    expect(layout.accessToken).toBe('kc-1')
    expect(page).toBe(layout)
  })
})
