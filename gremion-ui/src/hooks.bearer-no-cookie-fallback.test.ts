import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
// @ts-expect-error -- runtime-only internal entry; see hooks.tenant-wiring.test.ts.
import { with_request_store } from '@sveltejs/kit/internal/server'

/**
 * F1-FIX-03 / H11 (S1a#0, S1a#23; kernel alsoIn): authGuard treated every /api
 * Bearer as a Keycloak JWT and never accepted INTERNAL_PUSH_SECRET, so every
 * internalFetch self-call (news edit -> PATCH /api/news/<id>, the content
 * editor autosave -> PATCH /api/content/posts/<id>) got a 401 from the guard
 * before its handler's own isInternalBearerRequest() branch could run.
 *
 * These tests drive the REAL exported `handle` sequence (correlation, the REAL
 * tenant resolver, brand, a stand-in for Auth.js with no session, the REAL
 * authGuard, i18n and the security-header guard). Only the control-plane
 * registry, the DB and the boot side effects are stubbed. The request is built
 * exactly as internalFetch builds it: x-forwarded-host = the tenant's primary
 * host, x-internal-host-trust = the secret, Authorization: Bearer <secret>.
 *
 * Post-conditions:
 *   - the internal Bearer on an allow-listed (method, path) reaches the handler,
 *     with no user on locals (the route authorises the internal caller itself);
 *   - the SAME secret on any other path or method is a 401 (no handler);
 *   - a forged Bearer (wrong secret) on an allow-listed path is a 401;
 *   - a foreign realm's valid JWT is a 403 TenantMismatch (iss-match backstop);
 *   - an encoded-traversal id never matches the allow-list;
 *   - the module-disable gate still applies to the internal caller.
 */

const SECRET = 'f1-fix-03-internal-push-secret-0123456789'
const TENANT = {
  id: 'tid-1',
  slug: 't1',
  issuer: 'https://kc.example/realms/t1',
  primaryHost: 'stura.example',
}

const disabledModules = vi.hoisted(() => new Set<string>())
const cookieSession = vi.hoisted(() => ({ value: null as unknown }))

vi.mock('$app/environment', () => ({ building: true }))
vi.mock('$env/dynamic/private', () => ({
  env: {
    DATABASE_URL: 'postgresql://gremion:gremion@localhost:5432/gremion',
    INTERNAL_PUSH_SECRET: 'f1-fix-03-internal-push-secret-0123456789',
  },
}))
vi.mock('$lib/server/db', () => ({
  waitForDbReady: vi.fn(async () => {}),
  runMigrations: vi.fn(async () => {}),
  getDb: () => ({}),
  isTransientDbStartupError: () => false,
}))
vi.mock('$lib/server/config', () => ({
  readConfig: () => ({
    smtp: { configured: false, host: '', port: 0, from_address: '' },
    // Every module enabled unless a test disables it by id.
    modules: new Proxy({}, { get: (_t, k) => !disabledModules.has(String(k)) }),
    retention: { security_logs_days: 27 },
    brand: { product: 'StuRa', org_short: 'StuRa' },
  }),
}))
vi.mock('$lib/server/governance/provisioning/worker', () => ({ startProvisioningWorker: vi.fn() }))
vi.mock('$lib/server/tenant/evict-listener', () => ({ startTenantEvictListener: vi.fn(async () => {}) }))
vi.mock('$lib/server/audit-db', () => ({
  purgeAuditLogsOlderThan: vi.fn(async () => ({ purged: 0 })),
  verifyAuditChain: vi.fn(async () => ({ ok: true })),
}))
vi.mock('$lib/server/tenant/control-migrations', () => ({ runControlMigrations: vi.fn(async () => {}) }))
// A token the (stubbed) JWKS verifier accepts: 'foreign-realm-jwt' verifies
// against ANOTHER tenant's realm; everything else (the push secret included)
// is not a JWT at all.
vi.mock('$lib/server/jwt-verify', () => ({
  verifyBearerJwt: vi.fn(async (token: string) =>
    token === 'foreign-realm-jwt'
      ? { sub: 'u-foreign', iss: 'https://kc.example/realms/other', exp: 9_999_999_999, realm_access: { roles: [] } }
      : null,
  ),
}))
vi.mock('$lib/server/tenant/registry', () => ({
  resolveTenantBySlug: vi.fn(async () => ({
    id: 'tid-1',
    slug: 't1',
    issuer: 'https://kc.example/realms/t1',
    primaryHost: 'stura.example',
    config: {},
  })),
  resolveTenantByHost: vi.fn(async (host: string) =>
    host === 'stura.example'
      ? { id: 'tid-1', slug: 't1', issuer: 'https://kc.example/realms/t1', primaryHost: 'stura.example', config: {} }
      : null,
  ),
  getTenantStatusByHost: vi.fn(async () => null),
  resolveTenantById: vi.fn(async () => null),
  listActiveTenants: vi.fn(async () => [{ id: 'tid-1', slug: 't1', status: 'active' }]),
  startTenantMigrationRun: vi.fn(async () => 'run-1'),
  finishTenantMigrationRun: vi.fn(async () => {}),
}))
// Auth.js stand-in: no cookie session (an internalFetch hop never forwards the
// Cookie header, which is the whole point of G-075).
vi.mock('./auth', () => ({
  handle: async ({ event, resolve }: { event: { locals: Record<string, unknown> }; resolve: (e: unknown) => unknown }) => {
    event.locals.auth = async () => cookieSession.value
    return resolve(event)
  },
}))
vi.mock('nodemailer', () => ({ default: { createTransport: vi.fn() } }))
// The kernel composes no toggleable module that owns /api/content, so the gate
// test gives the real registry one route prefix to gate on.
vi.mock('$lib/modules/registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/modules/registry')>()),
  moduleRoutePrefixes: () => [{ prefix: '/api/content', moduleId: 'content' }],
}))

function withRequestStore<T>(event: unknown, fn: () => T): T {
  const state = { tracing: { record_span: <R>({ fn }: { fn: (span: unknown) => Promise<R> }) => fn({}) } }
  return with_request_store({ event, state } as never, fn)
}

type Mod = typeof import('./hooks.server')
let mod: Mod

beforeAll(async () => {
  mod = await import('./hooks.server')
  await mod.boot()
})

beforeEach(() => {
  disabledModules.clear()
})

interface Outcome {
  status: number
  reached: boolean
  handlerSawInternal: boolean
  handlerUser: unknown
  body: string
  headers: Headers
}

/** One request through the REAL handle sequence, shaped like internalFetch's hop. */
async function throughHandle(
  method: string,
  path: string,
  authorization: string | null,
  opts: { internalHop?: boolean; host?: string; respond?: () => Response; extra?: Record<string, string> } = {},
): Promise<Outcome> {
  const internalHop = opts.internalHop ?? true
  const url = new URL(`http://gremion-ui:3000${path}`)
  const headers: Record<string, string> = { 'x-forwarded-host': opts.host ?? TENANT.primaryHost }
  if (internalHop) headers['x-internal-host-trust'] = SECRET
  if (authorization) headers.Authorization = authorization
  Object.assign(headers, opts.extra ?? {})
  const hasBody = method !== 'GET' && method !== 'DELETE'
  if (hasBody) headers['Content-Type'] = 'application/json'
  const request = new Request(url, { method, headers, body: hasBody ? '{"action":"publish"}' : undefined })
  const event = {
    url,
    request,
    locals: {} as Record<string, unknown>,
    params: {},
    route: { id: path },
    cookies: { get: () => undefined, getAll: () => [], set: () => {}, delete: () => {} },
    getClientAddress: () => '10.0.0.5',
    isDataRequest: false,
    isSubRequest: false,
    setHeaders: () => {},
    platform: undefined,
  }
  let reached = false
  let handlerSawInternal = false
  let handlerUser: unknown = 'unset'
  const { isInternalBearerRequest } = await import('$lib/server/internal-fetch')
  const res = (await withRequestStore(event, () =>
    mod.handle({
      event: event as never,
      resolve: async (e: { request: Request; locals: Record<string, unknown> }) => {
        reached = true
        // The route's OWN gate (news/[id] and content/posts/[id] PATCH) — the
        // guard must hand the request over with the header intact.
        handlerSawInternal = isInternalBearerRequest(e.request)
        handlerUser = e.locals.user
        if (opts.respond) return opts.respond()
        return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
      },
    } as never),
  )) as Response
  return {
    status: res.status,
    reached,
    handlerSawInternal,
    handlerUser,
    body: await res.text(),
    headers: res.headers,
  }
}

/**
 * F1-FIX-03 round 2 (review MEDIUM): a rejected internal Bearer must leave a
 * server-side trace (method, path, hop trust, allow-list verdict, secret match)
 * and never the token itself.
 */
function expectRejectionLogged(
  warn: { mock: { calls: unknown[][] } },
  ctx: { method: string; path: string; tenantSelectionTrusted: boolean; allowListed: boolean; secretMatches: boolean },
): void {
  const hits = warn.mock.calls.filter((c) => String(c[0]).includes('internal Bearer rejected'))
  expect(hits).toHaveLength(1)
  expect(hits[0][1]).toEqual(ctx)
  expect(JSON.stringify(warn.mock.calls)).not.toContain(SECRET)
}

const POST_ID = '3f2b8a4e-9c1d-4e5f-8a7b-0c1d2e3f4a5b'


const SESSION = {
  user: { id: 'u1', name: 'U', email: 'u@x', roles: ['member'] },
  expires: '2999-01-01T00:00:00.000Z',
  tokenIss: TENANT.issuer,
}

describe('authGuard: an Authorization header never falls back to the cookie session (CSRF bypass)', () => {
  beforeEach(() => {
    cookieSession.value = SESSION
  })

  it.each(['Bearer garbage', 'bearer garbage', 'BEARER garbage', 'Basic abc', 'Bearer'])(
    '%s + a live session cookie + cross-site Origin is refused (401), handler not reached',
    async (authz) => {
      const out = await throughHandle('POST', '/api/settings/reset', authz, {
        internalHop: false,
        extra: { cookie: 'authjs.session-token=abc', origin: 'https://evil.example.org' },
      })
      expect(out.reached).toBe(false)
      expect([401, 403]).toContain(out.status)
      if (/^bearer /i.test(authz)) expect(out.status).toBe(401)
    },
  )

  it('a cookie session with no Authorization header still reaches the handler', async () => {
    const out = await throughHandle('GET', '/api/settings/reset', null, {
      internalHop: false,
      extra: { cookie: 'authjs.session-token=abc' },
    })
    expect(out.reached).toBe(true)
  })
})
