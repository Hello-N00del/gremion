import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// TASK-033-a / TRD-147 (operator decision 2026-10-28): a session WITHOUT a `sub`
// is refused. audit_log.user_id carries the 0061 CHECK (a uuid or a
// <token>-service principal), so an actor invented from preferred_username or jti
// would make every audited write fail with 23514 and roll the audited act back.
// The door refuses instead: 401 on /api, re-login for pages. The realm issues
// `sub` through the gremion-ui client's uid sub-mapper, which reconcile asserts
// (check gremion-ui-sub-mapper).
vi.mock('$app/environment', () => ({ building: true }))
vi.mock('$env/dynamic/private', () => ({ env: { DATABASE_URL: 'postgresql://gremion:gremion@localhost:5432/gremion' } }))
vi.mock('$lib/server/db', () => ({ waitForDbReady: vi.fn(async () => {}), runMigrations: vi.fn(async () => {}), getDb: () => ({}) }))
vi.mock('$lib/server/config', () => ({ readConfig: () => ({ smtp: { configured: false }, modules: { finance: true } }) }))
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
const UUID = '0192f3e0-1a2b-7c3d-8e4f-0123456789ab'

beforeEach(() => {
  vi.resetModules()
  process.exitCode = 0
})
afterEach(() => {
  process.exitCode = 0
})

async function run(opts: { path: string; session?: Record<string, unknown> | null; bearerPayload?: Record<string, unknown> }) {
  const mod = await import('./hooks.server')
  await mod.boot()
  const headers: Record<string, string> = opts.bearerPayload ? { authorization: 'Bearer a.b.c' } : {}
  if (opts.bearerPayload) {
    const jwt = await import('$lib/server/jwt-verify')
    vi.mocked(jwt.verifyBearerJwt).mockResolvedValueOnce(opts.bearerPayload as never)
  }
  const auth = vi.fn(async () => opts.session ?? null)
  const event = {
    url: new URL(`http://localhost${opts.path}`),
    request: new Request(`http://localhost${opts.path}`, { headers }),
    params: {},
    locals: { tenant: { id: 'a', slug: 'tenant-a', issuer: ISS, config: {} }, user: null, accessToken: null, accessTokenExpires: null, auth } as Record<string, unknown>,
  }
  const resolve = vi.fn(async () => new Response('ok'))
  try {
    const res = (await mod.authGuard({ event: event as never, resolve } as never)) as Response
    return { res, resolve, event, redirected: false as const }
  } catch (e) {
    const r = e as { status?: number; location?: string }
    if (r?.status === 302) return { res: null, resolve, event, redirected: true as const, location: r.location }
    throw e
  }
}

describe('a session without sub is refused (TRD-147)', () => {
  it('cookie session with no user id: /api answers 401, never resolves', async () => {
    const r = await run({ path: '/api/ping', session: { user: { id: undefined, roles: ['member'], groups: [] }, accessToken: 't', tokenIss: ISS } })
    expect(r.res?.status).toBe(401)
    expect(r.resolve).not.toHaveBeenCalled()
    expect(await r.res?.json()).toMatchObject({ error: 'Unauthenticated' })
  })

  it('cookie session with an empty user id: a page sends the user to re-login', async () => {
    const r = await run({ path: '/dashboard', session: { user: { id: '', roles: ['member'], groups: [] }, accessToken: 't', tokenIss: ISS } })
    expect(r.redirected).toBe(true)
    expect(r.resolve).not.toHaveBeenCalled()
  })

  it('verified Bearer token without sub (preferred_username and jti present): no session is invented from them, 401', async () => {
    const r = await run({
      path: '/api/ping',
      bearerPayload: { iss: ISS, preferred_username: 'x-service', jti: 'jti-1', realm_access: { roles: ['member'] } },
    })
    expect(r.res?.status).toBe(401)
    expect(r.resolve).not.toHaveBeenCalled()
    expect(r.event.locals.user).toBeNull()
  })

  it('positive controls: a cookie session with an id and a Bearer token with a sub both pass', async () => {
    const cookie = await run({ path: '/api/ping', session: { user: { id: UUID, roles: ['member'], groups: [] }, accessToken: 't', tokenIss: ISS } })
    expect(cookie.res?.status).toBe(200)
    expect(cookie.resolve).toHaveBeenCalledTimes(1)
    vi.resetModules()
    const bearer = await run({ path: '/api/ping', bearerPayload: { iss: ISS, sub: UUID, realm_access: { roles: ['member'] } } })
    expect(bearer.res?.status).toBe(200)
    expect((bearer.event.locals.user as { id: string }).id).toBe(UUID)
  })
})
