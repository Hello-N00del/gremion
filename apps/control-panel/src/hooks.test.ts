// TASK-043 TDD 15 (through the real hook): the gate runs before SvelteKit
// resolves anything -- a refused request never reaches the page, action or
// endpoint; an anonymous GET is redirected (302) to the ops realm's
// authorization endpoint with acr_values=loa2; a loa1 session gets a fresh
// login (prompt=login); /healthz answers without Auth.js.
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

const { gate } = await import('./hooks.server')

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

const claims = (over: Record<string, unknown> = {}) => ({ claims: { iss: OPS, acr: 'loa2', uid: '5b8e0a52-2f9f-4b46-9e3a-0b5c7f1a2d33', email: 'ops@platform.example', roles: ['operator'], ...over } })

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

  it('the probes are not gated', async () => {
    for (const path of ['/healthz', '/api/internal/evict']) {
      const { resolve } = await run(event({ path }))
      expect(resolve).toHaveBeenCalledOnce()
    }
  })
})
