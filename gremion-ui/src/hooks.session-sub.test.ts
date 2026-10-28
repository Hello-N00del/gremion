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

// r33f review: a refusal must be diagnosable. The Bearer branch says 'no_subject' (not the
// generic 'no_session' of a garbage token) and both branches leave a structured server-side
// trace: tenant, azp / client_id, iss -- NEVER the token itself.
describe('a missing sub is named and traced (r33f review)', () => {
  let warn: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => warn.mockRestore())

  const warned = () => warn.mock.calls.map((c) => c.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))

  it('verified Bearer token without sub: 401 reason no_subject, with a warn naming tenant, azp and iss but not the token', async () => {
    const r = await run({
      path: '/api/ping',
      bearerPayload: { iss: ISS, azp: 'mobile-app', preferred_username: 'x-service', jti: 'jti-1', realm_access: { roles: ['member'] } },
    })
    expect(r.res?.status).toBe(401)
    expect(await r.res?.json()).toEqual({ error: 'Unauthenticated', reason: 'no_subject' })
    expect(r.resolve).not.toHaveBeenCalled()
    const w = warn.mock.calls.find((c) => String(c[0]).includes('no sub'))
    expect(w, `no warn about the missing sub: ${warned().join(' | ')}`).toBeDefined()
    expect(w![1]).toMatchObject({ tenant: 'tenant-a', azp: 'mobile-app', iss: ISS })
    expect(warned().join(' ')).not.toContain('a.b.c')
  })

  it('azp falls back to client_id when the token has no azp', async () => {
    await run({ path: '/api/ping', bearerPayload: { iss: ISS, client_id: 'svc-client', realm_access: { roles: ['member'] } } })
    const w = warn.mock.calls.find((c) => String(c[0]).includes('no sub'))
    expect(w![1]).toMatchObject({ azp: 'svc-client' })
  })

  it('a garbage Bearer (no verified payload) still answers no_session and does not claim a missing sub', async () => {
    const mod = await import('./hooks.server')
    await mod.boot()
    const event = {
      url: new URL('http://localhost/api/ping'),
      request: new Request('http://localhost/api/ping', { headers: { authorization: 'Bearer garbage' } }),
      params: {},
      locals: { tenant: { id: 'a', slug: 'tenant-a', issuer: ISS, config: {} }, user: null, accessToken: null, accessTokenExpires: null, auth: vi.fn(async () => null) } as Record<string, unknown>,
    }
    const res = (await mod.authGuard({ event: event as never, resolve: vi.fn(async () => new Response('ok')) } as never)) as Response
    expect(await res.json()).toMatchObject({ reason: 'no_session' })
    expect(warned().join(' ')).not.toContain('no sub')
  })

  it('cookie session with no user id: warns with tenant and iss (no token material), on /api and on pages', async () => {
    const api = await run({ path: '/api/ping', session: { user: { id: '', roles: ['member'], groups: [] }, accessToken: 'SECRET-ACCESS-TOKEN', tokenIss: ISS } })
    expect(await api.res?.json()).toMatchObject({ reason: 'no_subject' })
    const w = warn.mock.calls.find((c) => String(c[0]).includes('no sub'))
    expect(w, `no warn about the missing sub: ${warned().join(' | ')}`).toBeDefined()
    expect(w![1]).toMatchObject({ tenant: 'tenant-a', iss: ISS })
    expect(warned().join(' ')).not.toContain('SECRET-ACCESS-TOKEN')
    warn.mockClear()
    vi.resetModules()
    const page = await run({ path: '/dashboard', session: { user: { id: undefined, roles: ['member'], groups: [] }, accessToken: 't', tokenIss: ISS } })
    expect(page.redirected).toBe(true)
    expect(warn.mock.calls.some((c) => String(c[0]).includes('no sub'))).toBe(true)
  })
})

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
