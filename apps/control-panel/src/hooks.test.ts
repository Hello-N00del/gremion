// TASK-043 TDD 15 (through the real hook): the gate runs before SvelteKit
// resolves anything -- a refused request never reaches the page, action or
// endpoint; an anonymous GET is redirected (302) to the ops realm's
// authorization endpoint with acr_values=loa2; a loa1 session gets a fresh
// login (prompt=login); /healthz answers without Auth.js.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'lib', 'server', '__fixtures__')
const OPS = 'https://platform.example/auth/realms/platform'
const ENV: Record<string, string> = {
  ORIGIN: 'http://127.0.0.1:3043',
  PANEL_OIDC_ISSUER: OPS,
  PANEL_OIDC_INTERNAL_BASE: 'https://keycloak:8443/auth',
  PANEL_OIDC_CLIENT_ID: 'control-panel',
  PANEL_OIDC_CLIENT_SECRET_FILE: join(FIX, 'client_secret'),
  AUTH_SECRET_FILE: join(FIX, 'auth_secret'),
  PANEL_REQUIRED_ACR: 'loa2',
  CONTROL_DATABASE_URL: 'postgres://control:unit@127.0.0.1:1/control',
}
vi.mock('$env/dynamic/private', () => ({ env: ENV }))

const { gate, handle, hostGuard, securityHeaders, PANEL_CSP } = await import('./hooks.server')
const { hostAllowed } = await import('./lib/server/gate')

interface FakeCookie {
  name: string
  value: string
}

function event(opts: { method?: string; path?: string; session?: unknown; cookies?: FakeCookie[]; authorization?: string }) {
  const url = new URL(`http://127.0.0.1:3043${opts.path ?? '/'}`)
  const jar = new Map<string, string>((opts.cookies ?? []).map((c) => [c.name, c.value]))
  const deleted: string[] = []
  return {
    url,
    request: new Request(url, { method: opts.method ?? 'GET', headers: opts.authorization ? { authorization: opts.authorization } : {} }),
    locals: { auth: async () => opts.session ?? null } as Record<string, unknown>,
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      get: (n: string) => jar.get(n),
      set: (n: string, v: string) => void jar.set(n, v),
      delete: (n: string) => void (jar.delete(n), deleted.push(n)),
    },
    deleted,
  }
}

const nowSec = () => Math.floor(Date.now() / 1000)
const claims = (over: Record<string, unknown> = {}) => ({ claims: { iss: OPS, acr: 'loa2', uid: '5b8e0a52-2f9f-4b46-9e3a-0b5c7f1a2d33', email: 'ops@platform.example', roles: ['operator'], authAt: nowSec() - 60, ...over } })

async function run(e: ReturnType<typeof event>) {
  const resolve = vi.fn(async () => new Response('RESOLVED'))
  try {
    const res = await gate({ event: e as never, resolve: resolve as never })
    return { res, resolve, thrown: null as null | { status: number; location: string } }
  } catch (err) {
    const r = err as { status?: number; location?: string }
    if (typeof r.status === 'number' && typeof r.location === 'string') return { res: null, resolve, thrown: { status: r.status, location: r.location } }
    throw err
  }
}

describe('the gate hook (TDD 15)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it.each([
    ['a page', 'GET', '/'],
    ['a form action', 'POST', '/customers/new'],
    ['a +server endpoint', 'GET', '/api/customers'],
  ])('a customer-realm session is 403 on %s and nothing resolves', async (_w, method, path) => {
    const { res, resolve } = await run(event({ method, path, session: claims({ iss: 'https://rat.musterstadt.example/auth/realms/musterstadt' }) }))
    expect(res?.status).toBe(403)
    expect(resolve).not.toHaveBeenCalled()
  })

  it('a forged session cookie is 403, the cookie is cleared, nothing resolves', async () => {
    const e = event({ path: '/api/customers', cookies: [{ name: 'authjs.session-token', value: 'forged' }] })
    const { res, resolve } = await run(e)
    expect(res?.status).toBe(403)
    expect(e.deleted).toEqual(['authjs.session-token'])
    expect(resolve).not.toHaveBeenCalled()
  })

  it('an anonymous GET is redirected to the ops realm authorization endpoint with acr_values=loa2', async () => {
    const { thrown, resolve } = await run(event({ path: '/customers' }))
    expect(resolve).not.toHaveBeenCalled()
    expect(thrown?.status).toBe(302)
    const loc = new URL(thrown!.location)
    expect(`${loc.origin}${loc.pathname}`).toBe(`${OPS}/protocol/openid-connect/auth`)
    expect(loc.searchParams.get('acr_values')).toBe('loa2')
    expect(loc.searchParams.get('client_id')).toBe('control-panel')
    expect(loc.searchParams.get('code_challenge_method')).toBe('S256')
    expect(loc.searchParams.get('prompt')).toBeNull()
  })

  it('an ops session at loa1 is sent to a fresh login at loa2 (step-up)', async () => {
    const { thrown } = await run(event({ session: claims({ acr: 'loa1' }) }))
    expect(thrown?.status).toBe(302)
    const loc = new URL(thrown!.location)
    expect(loc.searchParams.get('acr_values')).toBe('loa2')
    expect(loc.searchParams.get('prompt')).toBe('login')
  })

  it('an ops session at loa2 with the operator role resolves, with the operator on locals', async () => {
    const e = event({ session: claims() })
    const { res, resolve } = await run(e)
    expect(await res?.text()).toBe('RESOLVED')
    expect(resolve).toHaveBeenCalledOnce()
    expect(e.locals.operator).toMatchObject({ id: '5b8e0a52-2f9f-4b46-9e3a-0b5c7f1a2d33', acr: 'loa2', iss: OPS })
  })

  it('an active ops loa2 session signed in over an hour ago never resolves: POST is 403 and cleared, GET re-signs in', async () => {
    const old = claims({ authAt: nowSec() - 7200 })
    const post = event({ method: 'POST', path: '/customers/new', session: old, cookies: [{ name: 'authjs.session-token', value: 'x' }] })
    const r1 = await run(post)
    expect(r1.res?.status).toBe(403)
    expect(post.deleted).toEqual(['authjs.session-token'])
    expect(r1.resolve).not.toHaveBeenCalled()
    const r2 = await run(event({ session: old, cookies: [{ name: 'authjs.session-token', value: 'x' }] }))
    expect(r2.resolve).not.toHaveBeenCalled()
    expect(r2.thrown?.status).toBe(302)
  })

  it('the expiry marker auth.ts leaves for a session past its lifetime: GET goes to the ops realm, POST is 403 and cleared', async () => {
    const marker = { claims: { error: 'SessionExpired', roles: [] } }
    const g = await run(event({ session: marker, cookies: [{ name: 'authjs.session-token', value: 'x' }] }))
    expect(g.resolve).not.toHaveBeenCalled()
    expect(g.thrown?.status).toBe(302)
    expect(`${new URL(g.thrown!.location).origin}${new URL(g.thrown!.location).pathname}`).toBe(`${OPS}/protocol/openid-connect/auth`)
    const post = event({ method: 'POST', path: '/customers/new', session: marker, cookies: [{ name: 'authjs.session-token', value: 'x' }] })
    const p = await run(post)
    expect(p.res?.status).toBe(403)
    expect(post.deleted).toEqual(['authjs.session-token'])
  })

  it('a session decode that THROWS is logged (never the cookie value) and still fails closed', async () => {
    const logged: string[] = []
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void logged.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')))
    const e = event({ path: '/api/customers', cookies: [{ name: 'authjs.session-token', value: 'cookie-value-t043' }] })
    e.locals.auth = async () => {
      throw new Error('JWEDecryptionFailed: decryption operation failed')
    }
    const { res, resolve } = await run(e)
    expect(res?.status).toBe(403)
    expect(resolve).not.toHaveBeenCalled()
    const text = logged.join('\n')
    expect(text).toMatch(/session decode failed/)
    expect(text).toMatch(/JWEDecryptionFailed/)
    expect(text).not.toContain('cookie-value-t043')
  })

  it('the probes are not gated', async () => {
    for (const path of ['/healthz', '/api/internal/evict']) {
      const { resolve } = await run(event({ path }))
      expect(resolve).toHaveBeenCalledOnce()
    }
  })
})

// [D R29-I11]: the panel is reached on ONE operator-supplied host name (the
// host of ORIGIN; behind the edge Traefik on the test env). Every request whose
// Host is not that name is refused before Auth.js or the gate run -- a page, a
// form action, a +server endpoint and Auth.js's own /auth/* routes alike. Only
// the container HEALTHCHECK (/healthz: the process and a valid config, no
// data) and the bearer-checked evict fan-out answer on any Host.
describe('the host guard (R29-I11)', () => {
  function hostEvent(path: string, host: string | null, method = 'GET') {
    const url = new URL(`http://127.0.0.1:3043${path}`)
    const headers: Record<string, string> = {}
    if (host !== null) headers.host = host
    return { url, request: new Request(url, { method, headers }), locals: {}, cookies: { getAll: () => [] } }
  }
  async function guard(e: ReturnType<typeof hostEvent>) {
    const resolve = vi.fn(async () => new Response('RESOLVED'))
    const res = await hostGuard({ event: e as never, resolve: resolve as never })
    return { res, resolve }
  }

  it.each([
    ['a page', 'GET', '/'],
    ['a form action', 'POST', '/customers/new'],
    ['a +server endpoint', 'GET', '/api/customers'],
    ['an Auth.js route', 'GET', '/auth/callback/keycloak'],
  ])('a foreign Host is refused (421) on %s and nothing resolves', async (_w, method, path) => {
    for (const host of ['evil.example', 'panel.example.org', '127.0.0.1:3044', '127.0.0.1', 'localhost:3043']) {
      const { res, resolve } = await guard(hostEvent(path, host, method))
      expect(res.status, host).toBe(421)
      expect(resolve).not.toHaveBeenCalled()
    }
  })

  it('an X-Forwarded-Host other than ORIGIN\'s host is refused too: Auth.js builds its URLs from it (review A, r2)', async () => {
    const e = hostEvent('/auth/signin', '127.0.0.1:3043')
    e.request.headers.set('x-forwarded-host', 'evil.example')
    const { res, resolve } = await guard(e)
    expect(res.status).toBe(421)
    expect(resolve).not.toHaveBeenCalled()
    const same = hostEvent('/', '127.0.0.1:3043')
    same.request.headers.set('x-forwarded-host', '127.0.0.1:3043')
    expect((await guard(same)).resolve).toHaveBeenCalledOnce()
  })

  it('every response carries nosniff and no-referrer (review A LOW, r2)', async () => {
    const res = await securityHeaders({ event: {} as never, resolve: (async () => new Response('x', { headers: { 'content-type': 'text/plain' } })) as never })
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
  })

  it('a request without a Host is refused', async () => {
    const { res, resolve } = await guard(hostEvent('/', null))
    expect(res.status).toBe(421)
    expect(resolve).not.toHaveBeenCalled()
  })

  it("the ORIGIN's own host resolves (case-insensitive, as RFC 9110 host names are)", async () => {
    for (const host of ['127.0.0.1:3043', '127.0.0.1:3043'.toUpperCase()]) {
      const { resolve } = await guard(hostEvent('/', host))
      expect(resolve).toHaveBeenCalledOnce()
    }
  })

  it('the probes answer on any Host (the container healthcheck reaches 127.0.0.1:3000)', async () => {
    for (const path of ['/healthz', '/api/internal/evict']) {
      const { resolve } = await guard(hostEvent(path, '127.0.0.1:3000'))
      expect(resolve).toHaveBeenCalledOnce()
    }
  })

  it('handle runs the host guard first: a foreign Host never reaches Auth.js or the gate', async () => {
    const resolve = vi.fn(async () => new Response('RESOLVED'))
    const res = (await handle({ event: hostEvent('/', 'evil.example') as never, resolve: resolve as never })) as Response
    expect(res.status).toBe(421)
    expect(resolve).not.toHaveBeenCalled()
  })
})

describe('host names (hostAllowed)', () => {
  it('matches the host of an https origin without a port, and nothing else', () => {
    expect(hostAllowed('panel.example.org', 'https://panel.example.org')).toBe(true)
    expect(hostAllowed('Panel.Example.Org', 'https://panel.example.org')).toBe(true)
    expect(hostAllowed('panel.example.org:443', 'https://panel.example.org')).toBe(false)
    expect(hostAllowed('panel.example.org.evil.example', 'https://panel.example.org')).toBe(false)
    expect(hostAllowed('x.panel.example.org', 'https://panel.example.org')).toBe(false)
    expect(hostAllowed('', 'https://panel.example.org')).toBe(false)
    expect(hostAllowed(null, 'https://panel.example.org')).toBe(false)
    expect(hostAllowed('panel.example.org', 'not a url')).toBe(false)
  })
})

// [D R29-I11]: security headers equal to gremion-ui's. The in-app half is
// gremion-ui's Content-Security-Policy on every text/html response (cspGuard);
// the edge half (HSTS) is the panel router's middleware in standalone.yml.
describe('security headers (R29-I11)', () => {
  function gremionUiCsp(): string {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'gremion-ui', 'src', 'hooks.server.ts'), 'utf8')
    const block = /export const CSP_HEADER_VALUE = \[([\s\S]*?)\]\.join\('; '\)/.exec(src)
    if (!block) throw new Error("gremion-ui's CSP_HEADER_VALUE is no longer an array joined by '; ': re-derive this test")
    return [...block[1]!.matchAll(/^\s*"([^"]+)",?\s*$/gm)].map((m) => m[1]).join('; ')
  }

  it("the panel's CSP is exactly gremion-ui's", () => {
    const ui = gremionUiCsp()
    expect(ui).toMatch(/^default-src 'self'; /)
    expect(PANEL_CSP).toBe(ui)
  })

  it('an HTML response carries the CSP; a JSON one does not need it', async () => {
    const html = await securityHeaders({ event: {} as never, resolve: (async () => new Response('<p>x</p>', { headers: { 'content-type': 'text/html; charset=utf-8' } })) as never })
    expect(html.headers.get('content-security-policy')).toBe(PANEL_CSP)
    const json = await securityHeaders({ event: {} as never, resolve: (async () => new Response('{}', { headers: { 'content-type': 'application/json' } })) as never })
    expect(json.headers.get('content-security-policy')).toBeNull()
  })
})
