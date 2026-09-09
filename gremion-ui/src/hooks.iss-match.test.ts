import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

let migrationsImpl: () => Promise<void> = async () => {}
vi.mock('$app/environment', () => ({ building: true }))
vi.mock('$env/dynamic/private', () => ({ env: { DATABASE_URL: 'postgresql://gremion:gremion@localhost:5432/gremion' } }))
vi.mock('$lib/server/db', () => ({ waitForDbReady: vi.fn(async () => {}), runMigrations: () => migrationsImpl(), getDb: () => ({}) }))
vi.mock('$lib/server/config', () => ({ readConfig: () => ({ smtp: { configured: false }, modules: { finance: true }, retention: { security_logs_days: 90 } }) }))
vi.mock('$lib/server/calendar/notification-scheduler', () => ({ startNotificationScheduler: vi.fn() }))
vi.mock('$lib/server/calendar/caldav-sync', () => ({ startCalDavSyncWorker: vi.fn() }))
vi.mock('$lib/server/governance/provisioning/worker', () => ({ startProvisioningWorker: vi.fn() }))
vi.mock('$lib/server/audit-db', () => ({ purgeAuditLogsOlderThan: vi.fn(async () => ({ purged: 0 })) }))
vi.mock('./auth', () => ({ handle: async ({ event, resolve }: { event: unknown; resolve: (e: unknown) => unknown }) => resolve(event) }))
vi.mock('$lib/server/tenant/control-migrations', () => ({ runControlMigrations: vi.fn(async () => {}) }))
vi.mock('$lib/server/tenant/register-default', () => ({ registerDefaultTenant: vi.fn(async () => ({ id: 'tid-1' })) }))
// boot() fleet-migrates the active tenants (P2.1b T2) then resolves the default
// context for the audit-purge interval; the listActiveTenants id must match the
// registerDefaultTenant mock above.
vi.mock('$lib/server/tenant/registry', () => ({
  resolveTenantBySlug: vi.fn(async () => ({ id: 'default', slug: 'default', issuer: 'https://kc/realms/sturaos' })),
  listActiveTenants: vi.fn(async () => [{ id: 'tid-1', slug: 'default', status: 'active' }]),
  startTenantMigrationRun: vi.fn(async () => 'run-1'),
  finishTenantMigrationRun: vi.fn(async () => {}),
}))
vi.mock('$lib/server/tenant/context', () => ({ runWithTenant: (_ctx: unknown, fn: () => unknown) => fn() }))
vi.mock('$lib/server/tenant/default-tenant', () => ({ DEFAULT_TENANT: { id: 'default', configPath: '/tmp/config.json' } }))
vi.mock('nodemailer', () => ({ default: { createTransport: vi.fn() } }))

let bearerPayload: Record<string, unknown> | null = null
vi.mock('$lib/server/jwt-verify', () => ({ verifyBearerJwt: vi.fn(async () => bearerPayload) }))

const ISS_A = 'https://id.example.org/realms/tenant-a'
const ISS_B = 'https://id.example.org/realms/tenant-b'
// P2.2-auth A4: the page-path guard now reads tenant.config (pageAccessForTenant),
// so the stub carries the real TenantContext's always-present config field.
const tenant = (slug: string, issuer: string) => ({ id: slug, slug, issuer, config: {} })

function makeEvent(opts: { path: string; tenant: { id: string; slug: string; issuer: string }; headers?: Record<string, string>; session?: unknown }) {
  const headers = new Headers(opts.headers ?? {})
  return {
    url: new URL(`http://localhost${opts.path}`),
    request: new Request(`http://localhost${opts.path}`, { headers }),
    params: {},
    locals: { tenant: opts.tenant, user: null, accessToken: null, accessTokenExpires: null, auth: async () => opts.session ?? null } as Record<string, unknown>,
  }
}
const RESOLVED = new Response('resolved-data-plane', { status: 200 })
const resolveSpy = async () => RESOLVED

beforeEach(() => { vi.resetModules(); process.exitCode = 0; bearerPayload = null; migrationsImpl = async () => {} })
afterEach(() => { process.exitCode = 0 })

describe('authGuard iss-match — SESSION path', () => {
  it('serves when token iss == resolved tenant issuer', async () => {
    const mod = await import('./hooks.server'); await mod.boot()
    const event = makeEvent({ path: '/dashboard', tenant: tenant('tenant-a', ISS_A), session: { user: { id: 'u1', roles: ['member'], groups: [] }, accessToken: 'kc', tokenIss: ISS_A } })
    const res = (await mod.authGuard({ event: event as never, resolve: resolveSpy } as never)) as Response
    expect(res.status).toBe(200)
  })
  it('REJECTS 403 when an A-realm session is replayed on tenant B host', async () => {
    const mod = await import('./hooks.server'); await mod.boot()
    const event = makeEvent({ path: '/dashboard', tenant: tenant('tenant-b', ISS_B), session: { user: { id: 'u1', roles: ['member'], groups: [] }, accessToken: 'kc', tokenIss: ISS_A } })
    const res = (await mod.authGuard({ event: event as never, resolve: resolveSpy } as never)) as Response
    expect(res.status).toBe(403)
    expect(await res.text()).toBe('Forbidden: tenant mismatch')
  })
  // #256-3: a session WITHOUT tokenIss is a pre-spine cookie (minted before
  // sessionCallback recorded the issuer) — a legitimate user needing re-auth,
  // not a cross-tenant replay. Dead-end 403 → clean re-auth instead, with the
  // SAME api/page split as the no-session branch: pages 302 to login, /api/
  // paths get machine-readable 401 JSON (a client fetch can't follow a 302 to
  // the HTML login page — "Unexpected token '<'").
  // A PRESENT but MISMATCHED iss must STAY 403 (the replay tests above).
  it('redirects 302 to /auth/login when a PAGE session has NO tokenIss (pre-spine session)', async () => {
    const mod = await import('./hooks.server'); await mod.boot()
    const event = makeEvent({ path: '/dashboard', tenant: tenant('tenant-a', ISS_A), session: { user: { id: 'u1', roles: ['member'], groups: [] }, accessToken: 'kc' } })
    let thrown: { status?: number; location?: string } | undefined
    try {
      await mod.authGuard({ event: event as never, resolve: resolveSpy } as never)
    } catch (e) {
      thrown = e as { status?: number; location?: string }
    }
    expect(thrown?.status).toBe(302)
    expect(thrown?.location).toContain('/auth/login')
  })

  it('returns 401 JSON (NOT a 302) when an /api/ session has NO tokenIss (pre-spine session)', async () => {
    const mod = await import('./hooks.server'); await mod.boot()
    const event = makeEvent({ path: '/api/files/recent', tenant: tenant('tenant-a', ISS_A), session: { user: { id: 'u1', roles: ['member'], groups: [] }, accessToken: 'kc' } })
    const res = (await mod.authGuard({ event: event as never, resolve: resolveSpy } as never)) as Response
    expect(res.status).toBe(401)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(await res.json()).toEqual({ error: 'Unauthenticated', reason: 'stale_session' })
  })

  it('REJECTS an API session replay with machine-readable 403 JSON', async () => {
    const mod = await import('./hooks.server'); await mod.boot()
    const event = makeEvent({ path: '/api/finance/budgets', tenant: tenant('tenant-b', ISS_B), session: { user: { id: 'u1', roles: ['finance'], groups: [] }, accessToken: 'kc', tokenIss: ISS_A } })
    const res = (await mod.authGuard({ event: event as never, resolve: resolveSpy } as never)) as Response
    expect(res.status).toBe(403)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(await res.json()).toEqual({ error: 'TenantMismatch', reason: 'iss_host_mismatch' })
  })
})

describe('authGuard iss-match — BEARER path', () => {
  it('serves the bearer request when token iss == resolved tenant issuer', async () => {
    bearerPayload = { sub: 'mob1', iss: ISS_A, realm_access: { roles: ['member'] }, exp: 9999999999 }
    const mod = await import('./hooks.server'); await mod.boot()
    const event = makeEvent({ path: '/api/finance/budgets', tenant: tenant('tenant-a', ISS_A), headers: { Authorization: 'Bearer aaa.bbb.ccc' } })
    const res = (await mod.authGuard({ event: event as never, resolve: resolveSpy } as never)) as Response
    expect(res.status).toBe(200)
  })
  it('REJECTS 403 when an A-realm bearer token is replayed on tenant B host', async () => {
    bearerPayload = { sub: 'mob1', iss: ISS_A, realm_access: { roles: ['member'] }, exp: 9999999999 }
    const mod = await import('./hooks.server'); await mod.boot()
    const event = makeEvent({ path: '/api/finance/budgets', tenant: tenant('tenant-b', ISS_B), headers: { Authorization: 'Bearer aaa.bbb.ccc' } })
    const res = (await mod.authGuard({ event: event as never, resolve: resolveSpy } as never)) as Response
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'TenantMismatch', reason: 'iss_host_mismatch' })
  })
})
