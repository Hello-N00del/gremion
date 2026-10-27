import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// #256-1: the Bearer branch of authGuard used to `return resolve(event)` BEFORE
// the module-disable gate that only the cookie-session path reached, so a
// disabled module's /api prefix stayed reachable to token clients. This suite
// drives the REAL authGuard through both auth methods against a config whose
// module is toggled off and pins the 403 parity.
//
// Carve note: the governance-only kernel ships no toggleable feature modules, so
// the real moduleRoutePrefixes() is empty. This suite injects a SYNTHETIC
// toggleable module (demo_widget) via the registry seam to exercise the gate
// MECHANISM — the parity guarantee (Bearer == cookie) is module-agnostic.

// --- module stubs (must precede the ./hooks.server import) ---
vi.mock('$app/environment', () => ({ building: true }))
vi.mock('$env/dynamic/private', () => ({ env: { DATABASE_URL: 'postgresql://gremion:gremion@localhost:5432/gremion' } }))
vi.mock('$lib/server/db', () => ({ waitForDbReady: vi.fn(async () => {}), runMigrations: vi.fn(async () => {}), getDb: () => ({}) }))
// Mutable module toggle: each test flips `demo_widget` and the SAME readConfig
// mock feeds boot(), the cookie gate and the Bearer gate (module-gate.ts).
const modulesState = { demo_widget: true, messages: true }
vi.mock('$lib/server/config', () => ({
  readConfig: () => ({
    smtp: { configured: false },
    modules: { ...modulesState },
    retention: { security_logs_days: 27 },
  }),
}))
// Inject a synthetic toggleable module's prefixes into the gate's registry seam.
vi.mock('$lib/modules/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/modules/registry')>()
  return {
    ...actual,
    // canAccess needs a PAGE_ACCESS entry for the synthetic page segment (else it throws in dev mode).
    composePageAccess: (...a: Parameters<typeof actual.composePageAccess>) => ({ ...actual.composePageAccess(...a), 'demo-widget': 'member' as const }),
    moduleRoutePrefixes: () => [
      { prefix: '/demo-widget', moduleId: 'demo_widget' },
      { prefix: '/api/demo-widget', moduleId: 'demo_widget' },
    ],
  }
})
vi.mock('$lib/server/governance/provisioning/worker', () => ({ startProvisioningWorker: vi.fn() }))
vi.mock('$lib/server/audit-db', () => ({ purgeAuditLogsOlderThan: vi.fn(async () => ({ purged: 0 })) }))
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

let bearerPayload: Record<string, unknown> | null = null
vi.mock('$lib/server/jwt-verify', () => ({ verifyBearerJwt: vi.fn(async () => bearerPayload) }))
// --- end stubs ---

const ISS = 'https://id.example.org/realms/tenant-a'
// P2.2-auth A2: the bearer path resolves the tenant's role vocabulary from
// locals.tenant.config (no config.roles override = the default Role enum).
const TENANT = { id: 'tenant-a', slug: 'tenant-a', issuer: ISS, config: {} }

function makeEvent(opts: { path: string; headers?: Record<string, string>; session?: unknown }) {
  const headers = new Headers(opts.headers ?? {})
  return {
    url: new URL(`http://localhost${opts.path}`),
    request: new Request(`http://localhost${opts.path}`, { headers }),
    params: {},
    locals: { tenant: TENANT, user: null, accessToken: null, accessTokenExpires: null, auth: async () => opts.session ?? null } as Record<string, unknown>,
  }
}
const RESOLVED = new Response('resolved-data-plane', { status: 200 })
const resolveSpy = async () => RESOLVED

beforeEach(() => {
  vi.resetModules()
  process.exitCode = 0
  bearerPayload = null
  modulesState.demo_widget = true
  modulesState.messages = true
})
afterEach(() => { process.exitCode = 0 })

describe('module-disable gate parity (#256-1)', () => {
  it('BEARER request to a DISABLED module /api prefix → 403 Module disabled', async () => {
    modulesState.demo_widget = false
    bearerPayload = { sub: 'mob1', iss: ISS, realm_access: { roles: ['member'] }, exp: 9999999999 }
    const mod = await import('./hooks.server'); await mod.boot()
    const event = makeEvent({ path: '/api/demo-widget/things', headers: { Authorization: 'Bearer aaa.bbb.ccc' } })
    const res = (await mod.authGuard({ event: event as never, resolve: resolveSpy } as never)) as Response
    expect(res.status).toBe(403)
    expect(await res.text()).toBe('Module disabled')
  })

  it('cookie-session request to the same DISABLED /api prefix → 403 Module disabled (parity pin)', async () => {
    modulesState.demo_widget = false
    const mod = await import('./hooks.server'); await mod.boot()
    const event = makeEvent({ path: '/api/demo-widget/things', session: { user: { id: 'u1', roles: ['member'], groups: [] }, accessToken: 'kc', tokenIss: ISS } })
    const res = (await mod.authGuard({ event: event as never, resolve: resolveSpy } as never)) as Response
    expect(res.status).toBe(403)
    expect(await res.text()).toBe('Module disabled')
  })

  it('BEARER request passes through when the module is ENABLED (no over-blocking)', async () => {
    bearerPayload = { sub: 'mob1', iss: ISS, realm_access: { roles: ['member'] }, exp: 9999999999 }
    const mod = await import('./hooks.server'); await mod.boot()
    const event = makeEvent({ path: '/api/demo-widget/things', headers: { Authorization: 'Bearer aaa.bbb.ccc' } })
    const res = (await mod.authGuard({ event: event as never, resolve: resolveSpy } as never)) as Response
    expect(res.status).toBe(200)
  })

  it('BEARER request to a NON-module /api path is unaffected by a disabled module', async () => {
    modulesState.demo_widget = false
    bearerPayload = { sub: 'mob1', iss: ISS, realm_access: { roles: ['member'] }, exp: 9999999999 }
    const mod = await import('./hooks.server'); await mod.boot()
    const event = makeEvent({ path: '/api/governance/committees', headers: { Authorization: 'Bearer aaa.bbb.ccc' } })
    const res = (await mod.authGuard({ event: event as never, resolve: resolveSpy } as never)) as Response
    expect(res.status).toBe(200)
  })
})

// #290 / F1 + R33d: a disabled-module PAGE deep link is recognised here (disabledModuleForPath) and answered by
// the authGuard hook with 403 + the in-shell notice page (module-off-response.ts, unit-tested in
// lib/server/module-off-response.test.ts; the authGuard wiring is pinned by the describe below).
// It must not be thrown from the root layout load: SvelteKit then renders the static error template.
describe('disabledModuleForPath — PAGE module-off detection (#290 / F1 fix)', () => {
  it('returns the owning moduleId for a disabled-module page path', async () => {
    modulesState.demo_widget = false
    const { disabledModuleForPath } = await import('$lib/server/module-gate')
    expect(disabledModuleForPath('/demo-widget')).toBe('demo_widget')
    expect(disabledModuleForPath('/demo-widget/thing/123')).toBe('demo_widget')
  })

  it('returns null when the module is enabled or the path is unrelated', async () => {
    modulesState.demo_widget = true
    const { disabledModuleForPath } = await import('$lib/server/module-gate')
    expect(disabledModuleForPath('/demo-widget/thing/123')).toBeNull()
    expect(disabledModuleForPath('/dashboard')).toBeNull()
  })
})

// R33d authGuard-level guard: drives the REAL hook. Revert the `else` branch in authGuard
// (hooks.server.ts: `const disabled = disabledModuleForPath(path); if (disabled) return moduleOffPageResponse(...)`)
// and the first two tests go RED (resolve gets called, the module's own loads would run).
describe('authGuard answers a disabled-module PAGE itself (R33d)', () => {
  const SESSION = { user: { id: 'u1', roles: ['member'], groups: [] }, accessToken: 'kc', tokenIss: ISS }
  const pageEvent = (path: string, extra: Record<string, unknown> = {}, session: unknown = SESSION) => {
    const event = makeEvent({ path, session }) as Record<string, unknown>
    event.isDataRequest = false
    Object.assign(event, extra)
    return event
  }

  it('document request: 403 + the notice page fetched in-process; resolve is never called', async () => {
    modulesState.demo_widget = false
    const mod = await import('./hooks.server'); await mod.boot()
    const fetched: string[] = []
    const event = pageEvent('/demo-widget/thing/123', {
      fetch: async (u: string) => { fetched.push(u); return new Response('<h1>Modul nicht aktiv</h1>', { status: 200, headers: { 'content-type': 'text/html' } }) },
    })
    const resolve = vi.fn(resolveSpy)
    const res = (await mod.authGuard({ event: event as never, resolve } as never)) as Response
    expect(res.status).toBe(403)
    expect(await res.text()).toContain('Modul nicht aktiv')
    expect(fetched).toEqual(['/module-off/demo_widget'])
    expect(resolve).not.toHaveBeenCalled()
  })

  it('__data.json request: JSON 403 "module-disabled:<id>", no in-process fetch, resolve is never called', async () => {
    modulesState.demo_widget = false
    const mod = await import('./hooks.server'); await mod.boot()
    const fetchSpy = vi.fn()
    const event = pageEvent('/demo-widget/thing/123', { isDataRequest: true, fetch: fetchSpy })
    const resolve = vi.fn(resolveSpy)
    const res = (await mod.authGuard({ event: event as never, resolve } as never)) as Response
    expect(res.status).toBe(403)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(await res.json()).toBe('module-disabled:demo_widget')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(resolve).not.toHaveBeenCalled()
  })

  it('/api of a disabled module keeps the bare machine-readable 403 (no notice page fetch)', async () => {
    modulesState.demo_widget = false
    const mod = await import('./hooks.server'); await mod.boot()
    const fetchSpy = vi.fn()
    const event = pageEvent('/api/demo-widget/things', { fetch: fetchSpy })
    const resolve = vi.fn(resolveSpy)
    const res = (await mod.authGuard({ event: event as never, resolve } as never)) as Response
    expect(res.status).toBe(403)
    expect(await res.text()).toBe('Module disabled')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(resolve).not.toHaveBeenCalled()
  })

  it('control: the same PAGE with the module ENABLED resolves normally', async () => {
    const mod = await import('./hooks.server'); await mod.boot()
    const fetchSpy = vi.fn()
    const event = pageEvent('/demo-widget/thing/123', { fetch: fetchSpy })
    const resolve = vi.fn(resolveSpy)
    const res = (await mod.authGuard({ event: event as never, resolve } as never)) as Response
    expect(res.status).toBe(200)
    expect(resolve).toHaveBeenCalledOnce()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('an anonymous visitor still gets the login redirect, not the notice (auth runs first)', async () => {
    modulesState.demo_widget = false
    const mod = await import('./hooks.server'); await mod.boot()
    const fetchSpy = vi.fn()
    const event = pageEvent('/demo-widget/thing/123', { fetch: fetchSpy }, null)
    const resolve = vi.fn(resolveSpy)
    // redirect() throws a SvelteKit Redirect rather than returning a Response.
    await expect(mod.authGuard({ event: event as never, resolve } as never)).rejects.toMatchObject({ status: 302 })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(resolve).not.toHaveBeenCalled()
  })
})

// F5 r2: /element-call and /livekit/ are PUBLIC_PATHS (the embedded client carries no session) and used to
// return before the module gate, leaving the video proxy reachable with messages OFF.
describe('public video proxy follows the messages module (F5 r2)', () => {
  const paths = ['/element-call', '/element-call/index.html', '/livekit/jwt/get_token']
  it.each(paths)('messages OFF -> %s answers 403 Module disabled without a session', async (p) => {
    modulesState.messages = false
    const mod = await import('./hooks.server'); await mod.boot()
    const res = (await mod.authGuard({ event: makeEvent({ path: p }) as never, resolve: resolveSpy } as never)) as Response
    expect(res.status).toBe(403)
    expect(await res.text()).toBe('Module disabled')
  })
  it.each(paths)('control: messages ON -> %s stays public', async (p) => {
    const mod = await import('./hooks.server'); await mod.boot()
    const res = (await mod.authGuard({ event: makeEvent({ path: p }) as never, resolve: resolveSpy } as never)) as Response
    expect(res.status).toBe(200)
  })
})

// F5 r2: the unsubscribe page + API stay reachable with newsletter OFF (former subscribers must opt out).
describe('newsletter unsubscribe is exempt from the module gate (F5 r2)', () => {
  it('exempt paths are never reported disabled; sibling paths still are', async () => {
    const { disabledModuleForPath, MODULE_GATE_EXEMPT } = await import('$lib/server/module-gate')
    expect(MODULE_GATE_EXEMPT).toContain('/newsletter/unsubscribe')
    expect(disabledModuleForPath('/newsletter/unsubscribe', { modules: { newsletter: false } } as never)).toBeNull()
    expect(disabledModuleForPath('/api/newsletter/unsubscribe', { modules: { newsletter: false } } as never)).toBeNull()
  })
})

// Raw-vs-decoded path: SvelteKit routes on the DECODED path, so the gate must
// compare the decoded one. `/api/demo-widget` and its encoded spellings must
// get the identical response.
describe('module gate uses the decoded path (encoded-path bypass)', () => {
  const cases: [string, string][] = [
    ['percent-encoded letter', '/api/demo-w%69dget/things'],
    ['mixed-case hex digit', '/api/demo-%77idget/things'],
    ['upper-case hex digit', '/api/%64emo-widget/things'],
    ['encoded slash after prefix', '/api/demo-widget%2Fthings'],
    ['encoded slash lower-case', '/api/demo-widget%2fthings'],
    ['page deep link, encoded', '/demo-w%69dget/x'],
  ]
  for (const [name, path] of cases) {
    it(`${name} (${path}) -> 403, cookie session`, async () => {
      modulesState.demo_widget = false
      const mod = await import('./hooks.server'); await mod.boot()
      const event = makeEvent({ path, session: { user: { id: 'u1', roles: ['member'], groups: [] }, accessToken: 'kc', tokenIss: ISS } })
      const res = (await mod.authGuard({ event: event as never, resolve: resolveSpy } as never)) as Response
      expect(res.status).toBe(403)
    })
  }

  it('encoded API path -> 403 Module disabled for a BEARER client too', async () => {
    modulesState.demo_widget = false
    bearerPayload = { sub: 'mob1', iss: ISS, realm_access: { roles: ['member'] }, exp: 9999999999 }
    const mod = await import('./hooks.server'); await mod.boot()
    const event = makeEvent({ path: '/api/demo-w%69dget/things', headers: { Authorization: 'Bearer aaa.bbb.ccc' } })
    const res = (await mod.authGuard({ event: event as never, resolve: resolveSpy } as never)) as Response
    expect(res.status).toBe(403)
    expect(await res.text()).toBe('Module disabled')
  })

  it('encoded path to an ENABLED module still passes (no over-blocking)', async () => {
    const mod = await import('./hooks.server'); await mod.boot()
    const event = makeEvent({ path: '/api/demo-w%69dget/things', session: { user: { id: 'u1', roles: ['member'], groups: [] }, accessToken: 'kc', tokenIss: ISS } })
    const res = (await mod.authGuard({ event: event as never, resolve: resolveSpy } as never)) as Response
    expect(res.status).toBe(200)
  })

  it('requestPathHandle rejects a malformed escape with 400 and decodes otherwise', async () => {
    const mod = await import('./hooks.server')
    const bad = makeEvent({ path: '/api/demo-widget/%E0%A4%A' })
    const res = (await mod.requestPathHandle({ event: bad as never, resolve: resolveSpy } as never)) as Response
    expect(res.status).toBe(400)
    const ok = makeEvent({ path: '/api/demo-w%69dget' })
    await mod.requestPathHandle({ event: ok as never, resolve: resolveSpy } as never)
    expect(ok.locals.decodedPath).toBe('/api/demo-widget')
  })

  it('login redirect callbackUrl keeps the RAW path (%25 is not decoded)', async () => {
    const mod = await import('./hooks.server'); await mod.boot()
    for (const raw of ['/files/a%25b', '/files/%2561']) {
      const event = makeEvent({ path: raw })
      let loc = ''
      try {
        await mod.authGuard({ event: event as never, resolve: resolveSpy } as never)
      } catch (e) {
        loc = (e as { location?: string }).location ?? ''
      }
      expect(loc).toBe(`/auth/login?callbackUrl=${encodeURIComponent(raw)}`)
    }
  })

  it('requestPathHandle precedes tenantResolveHandle and authGuard in the handle sequence', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(process.cwd() + '/src/hooks.server.ts', 'utf8')
    const seq = src.slice(src.indexOf('export const handle = sequence('))
    const idx = (n: string) => seq.indexOf(n + ',')
    expect(idx('requestPathHandle')).toBeGreaterThan(-1)
    expect(idx('requestPathHandle')).toBeLessThan(idx('tenantResolveHandle'))
    expect(idx('requestPathHandle')).toBeLessThan(idx('authHandleUnlessExempt'))
    expect(idx('requestPathHandle')).toBeLessThan(idx('authGuard'))
  })
})
