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
    event.locals.auth = async () => null
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
  opts: { internalHop?: boolean; host?: string; respond?: () => Response } = {},
): Promise<Outcome> {
  const internalHop = opts.internalHop ?? true
  const url = new URL(`http://gremion-ui:3000${path}`)
  const headers: Record<string, string> = { 'x-forwarded-host': opts.host ?? TENANT.primaryHost }
  if (internalHop) headers['x-internal-host-trust'] = SECRET
  if (authorization) headers.Authorization = authorization
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

describe('authGuard: the internal Bearer (INTERNAL_PUSH_SECRET) through the real handle sequence (H11)', () => {
  it('boots', () => {
    expect(mod.getBootStatus()).toEqual({ complete: true, error: null })
  })

  it('PATCH /api/news/<id> with Bearer <secret> reaches the handler, with no user on locals', async () => {
    const o = await throughHandle('PATCH', '/api/news/42', `Bearer ${SECRET}`)
    expect(o.status).toBe(200)
    expect(o.reached).toBe(true)
    expect(o.handlerSawInternal).toBe(true)
    expect(o.handlerUser).toBeNull()
  })

  it('PATCH /api/content/posts/<id> with Bearer <secret> reaches the handler', async () => {
    const o = await throughHandle('PATCH', `/api/content/posts/${POST_ID}`, `Bearer ${SECRET}`)
    expect(o.status).toBe(200)
    expect(o.reached).toBe(true)
    expect(o.handlerSawInternal).toBe(true)
  })

  for (const [method, path] of [
    ['GET', '/api/members'],
    ['POST', '/api/news'],
    ['DELETE', '/api/news/42'],
    ['PATCH', '/api/news/42/extra'],
    ['PATCH', '/api/news/abc'],
    ['DELETE', `/api/content/posts/${POST_ID}`],
    ['PATCH', '/api/content/posts/x%2F..%2F..%2Flists'],
    ['PATCH', '/api/settings/backup'],
  ] as const) {
    it(`the same secret on a path/method NOT on the allow-list (${method} ${path}) is a 401, no handler`, async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const o = await throughHandle(method, path, `Bearer ${SECRET}`)
        expect(o.reached).toBe(false)
        expect(o.status).toBe(401)
        // F1-FIX-03 round 2: a distinct reason, so a missing allow-list entry is
        // not mistaken for an anonymous request (H11 hid behind 'no_session').
        expect(JSON.parse(o.body)).toEqual({ error: 'Unauthenticated', reason: 'internal_bearer_not_allowed' })
        expectRejectionLogged(warn, { method, path, tenantSelectionTrusted: true, allowListed: false, secretMatches: true })
      } finally {
        warn.mockRestore()
      }
    })
  }

  it('a forged Bearer (wrong secret) on an allow-listed path is a 401, no handler, logged as a mismatch', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const o = await throughHandle('PATCH', '/api/news/42', 'Bearer f1-fix-03-internal-push-secret-0123456788')
      expect(o.reached).toBe(false)
      expect(o.status).toBe(401)
      expect(JSON.parse(o.body)).toEqual({ error: 'Unauthenticated', reason: 'internal_bearer_not_allowed' })
      expectRejectionLogged(warn, {
        method: 'PATCH',
        path: '/api/news/42',
        tenantSelectionTrusted: true,
        allowListed: true,
        secretMatches: false,
      })
      expect(JSON.stringify(warn.mock.calls)).not.toContain('f1-fix-03-internal-push-secret-0123456788')
    } finally {
      warn.mockRestore()
    }
  })

  it('a garbage Bearer on an edge request (no internal hop header) stays an anonymous no_session 401 and logs nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const o = await throughHandle('PATCH', '/api/news/42', 'Bearer not-a-jwt', { internalHop: false })
      expect(o.reached).toBe(false)
      expect(o.status).toBe(401)
      expect(JSON.parse(o.body)).toEqual({ error: 'Unauthenticated', reason: 'no_session' })
      expect(warn.mock.calls.filter((c) => String(c[0]).includes('internal Bearer rejected'))).toEqual([])
    } finally {
      warn.mockRestore()
    }
  })

  it('a foreign realm JWT on an allow-listed path is a 403 TenantMismatch, no handler', async () => {
    const o = await throughHandle('PATCH', '/api/news/42', 'Bearer foreign-realm-jwt')
    expect(o.reached).toBe(false)
    expect(o.status).toBe(403)
    expect(JSON.parse(o.body)).toEqual({ error: 'TenantMismatch', reason: 'iss_host_mismatch' })
  })

  it('no Authorization at all on an allow-listed path is a 401 (no session)', async () => {
    const o = await throughHandle('PATCH', '/api/news/42', null)
    expect(o.reached).toBe(false)
    expect(o.status).toBe(401)
  })

  it('the internal Bearer is honoured only on the internalFetch hop (x-internal-host-trust), not on an edge request', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const o = await throughHandle('PATCH', '/api/news/42', `Bearer ${SECRET}`, { internalHop: false })
      expect(o.reached).toBe(false)
      expect(o.status).toBe(401)
      expect(JSON.parse(o.body)).toEqual({ error: 'Unauthenticated', reason: 'internal_bearer_not_allowed' })
      expectRejectionLogged(warn, {
        method: 'PATCH',
        path: '/api/news/42',
        tenantSelectionTrusted: false,
        allowListed: true,
        secretMatches: true,
      })
    } finally {
      warn.mockRestore()
    }
  })

  it('the module-disable gate still applies to the internal caller', async () => {
    disabledModules.add('content')
    const o = await throughHandle('PATCH', `/api/content/posts/${POST_ID}`, `Bearer ${SECRET}`)
    expect(o.reached).toBe(false)
    expect(o.status).toBe(403)
  })
})

// F1-FIX-03 / S1a#17: cspGuard was the INNERMOST handle, so every early return
// (tenant 404/429/503, authGuard 401/403/503, module gate) left the pipeline
// without the security headers, and the kernel set no nosniff at all. It now
// wraps everything after the correlation handle.
describe('security headers on every response, early returns included (S1a#17)', () => {
  it('a tenant-resolver 404 (unbound host) carries X-Content-Type-Options: nosniff', async () => {
    const o = await throughHandle('GET', '/api/members', null, { host: 'unbound.example', internalHop: false })
    expect(o.reached).toBe(false)
    expect(o.status).toBe(404)
    expect(o.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('an authGuard 401 carries nosniff and a Referrer-Policy', async () => {
    const o = await throughHandle('GET', '/api/members', null)
    expect(o.status).toBe(401)
    expect(o.headers.get('x-content-type-options')).toBe('nosniff')
    expect(o.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin')
  })

  it('a module-gate 403 carries nosniff', async () => {
    disabledModules.add('content')
    const o = await throughHandle('PATCH', `/api/content/posts/${POST_ID}`, `Bearer ${SECRET}`)
    expect(o.status).toBe(403)
    expect(o.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('a handler response with IMMUTABLE headers (a proxied fetch/redirect Response) still gets nosniff, body and status intact', async () => {
    const o = await throughHandle('PATCH', '/api/news/42', `Bearer ${SECRET}`, {
      respond: () => Response.redirect('http://gremion-ui:3000/elsewhere', 302),
    })
    expect(o.status).toBe(302)
    expect(o.headers.get('location')).toBe('http://gremion-ui:3000/elsewhere')
    expect(o.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('an error from headers.set that is NOT the immutable-guard TypeError propagates instead of being swallowed', async () => {
    await expect(
      throughHandle('PATCH', '/api/news/42', `Bearer ${SECRET}`, {
        respond: () => {
          const res = new Response('x', { status: 200 })
          const headers = new Headers()
          headers.set = () => {
            throw new RangeError('f1-fix-03 headers.set boom')
          }
          Object.defineProperty(res, 'headers', { value: headers })
          return res
        },
      }),
    ).rejects.toThrow(RangeError)
  })

  it('text/html still gets the CSP; a handler-set Referrer-Policy is kept', async () => {
    const o = await throughHandle('PATCH', '/api/news/42', `Bearer ${SECRET}`, {
      respond: () =>
        new Response('<html></html>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8', 'referrer-policy': 'no-referrer' },
        }),
    })
    expect(o.headers.get('content-security-policy')).toBe(mod.CSP_HEADER_VALUE)
    expect(o.headers.get('referrer-policy')).toBe('no-referrer')
    expect(o.headers.get('x-content-type-options')).toBe('nosniff')
  })
})

describe('the internal-bearer allow-list is exact', () => {
  it('names exactly the kernel routes whose handlers accept the internal Bearer', () => {
    expect(mod.INTERNAL_BEARER_ROUTES.map((r) => `${r.method} ${r.pattern.source}`).sort()).toEqual(
      [
        String.raw`PATCH ^\/api\/content\/posts\/[0-9A-Za-z-]{1,64}$`,
        String.raw`PATCH ^\/api\/news\/[0-9]{1,12}$`,
      ].sort(),
    )
  })

  it('the list and every entry are frozen (no importer can re-point a pattern)', () => {
    expect(Object.isFrozen(mod.INTERNAL_BEARER_ROUTES)).toBe(true)
    for (const r of mod.INTERNAL_BEARER_ROUTES) expect(Object.isFrozen(r)).toBe(true)
  })
})
