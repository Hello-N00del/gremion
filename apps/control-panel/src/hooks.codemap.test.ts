// The Code-Karte routes (/codemap and /codemap/map) sit behind the same gate as every other route of the panel:
// not exempt, an anonymous GET goes to sign-in, a bearer token is refused, a customer-realm session is refused.
// The pages themselves are never reached in any of these cases. (hooks.test.ts holds the gate's own proofs.)
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

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

const { gate } = await import('./hooks.server')
const { isExempt } = await import('./lib/server/gate')

const PATHS = ['/codemap', '/codemap/map']

function event(opts: { method?: string; path: string; session?: unknown; authorization?: string }) {
  const url = new URL(`http://127.0.0.1:3043${opts.path}`)
  const jar = new Map<string, string>()
  return {
    url,
    request: new Request(url, { method: opts.method ?? 'GET', headers: opts.authorization ? { authorization: opts.authorization } : {} }),
    locals: { auth: async () => opts.session ?? null } as Record<string, unknown>,
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      get: (n: string) => jar.get(n),
      set: (n: string, v: string) => void jar.set(n, v),
      delete: (n: string) => void jar.delete(n),
      serialize: (n: string, v: string, o: { path?: string } = {}) => `${n}=${v}; Path=${o.path ?? '/'}`,
    },
  }
}

const nowSec = () => Math.floor(Date.now() / 1000)
const claims = (over: Record<string, unknown> = {}) => ({ claims: { iss: OPS, acr: 'loa2', uid: '5b8e0a52-2f9f-4b46-9e3a-0b5c7f1a2d33', email: 'ops@platform.example', roles: ['operator'], authAt: nowSec() - 60, ...over } })

describe('the Code-Karte routes are behind the gate', () => {
  it.each(PATHS)('%s is not exempt from the gate', (p) => {
    expect(isExempt(p)).toBe(false)
    expect(isExempt(`${p}/`)).toBe(false)
    expect(isExempt(`${p}/x`)).toBe(false)
  })

  it.each(PATHS)('an anonymous GET of %s is sent to the ops realm sign-in and nothing resolves', async (p) => {
    const resolve = vi.fn(async () => new Response('RESOLVED'))
    const res = await gate({ event: event({ path: p }) as never, resolve: resolve as never })
    expect(res.status).toBe(302)
    const loc = new URL(res.headers.get('location')!)
    expect(`${loc.origin}${loc.pathname}`).toBe(`${OPS}/protocol/openid-connect/auth`)
    expect(loc.searchParams.get('acr_values')).toBe('loa2')
    expect(resolve).not.toHaveBeenCalled()
  })

  it.each(PATHS)('a bearer token on %s is 403, even a well-formed one, and nothing resolves', async (p) => {
    const resolve = vi.fn(async () => new Response('RESOLVED'))
    const res = await gate({ event: event({ path: p, authorization: 'Bearer abc.def.ghi' }) as never, resolve: resolve as never })
    expect(res.status).toBe(403)
    expect(resolve).not.toHaveBeenCalled()
  })

  it.each(PATHS)('a bearer token on %s does not help a session either', async (p) => {
    const resolve = vi.fn(async () => new Response('RESOLVED'))
    const res = await gate({ event: event({ path: p, session: claims(), authorization: 'Bearer abc.def.ghi' }) as never, resolve: resolve as never })
    expect(res.status).toBe(403)
    expect(resolve).not.toHaveBeenCalled()
  })

  it.each(PATHS)('a customer-realm session on %s is 403', async (p) => {
    const resolve = vi.fn(async () => new Response('RESOLVED'))
    const res = await gate({ event: event({ path: p, session: claims({ iss: 'https://rat.musterstadt.example/auth/realms/musterstadt' }) }) as never, resolve: resolve as never })
    expect(res.status).toBe(403)
    expect(resolve).not.toHaveBeenCalled()
  })

  it.each(PATHS)('a session without the operator role on %s is 403', async (p) => {
    const resolve = vi.fn(async () => new Response('RESOLVED'))
    const res = await gate({ event: event({ path: p, session: claims({ roles: [] }) }) as never, resolve: resolve as never })
    expect(res.status).toBe(403)
    expect(resolve).not.toHaveBeenCalled()
  })

  it.each(PATHS)('an anonymous POST to %s is 403, not a sign-in redirect', async (p) => {
    const resolve = vi.fn(async () => new Response('RESOLVED'))
    const res = await gate({ event: event({ method: 'POST', path: p }) as never, resolve: resolve as never })
    expect(res.status).toBe(403)
    expect(resolve).not.toHaveBeenCalled()
  })

  it.each(PATHS)('an ops session at loa2 with the operator role reaches %s (the control case)', async (p) => {
    const resolve = vi.fn(async () => new Response('RESOLVED'))
    const res = await gate({ event: event({ path: p, session: claims() }) as never, resolve: resolve as never })
    expect(await res.text()).toBe('RESOLVED')
    expect(resolve).toHaveBeenCalledOnce()
  })
})
