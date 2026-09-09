import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { isRedirect } from '@sveltejs/kit'
import { startTenantEvictListener } from '$lib/server/tenant/evict-listener'

/**
 * T4.1 (G-014): boot sequencing must be atomic — never serve requests against
 * a half-migrated DB. P2.1b T3 (D-READY) keeps that invariant but moves it to
 * TENANT granularity for the DATA plane:
 *
 *   (a) a CONTROL-plane boot failure (control migrations, registration, fleet
 *       listing)  =>  _bootComplete stays false, _bootError set,
 *                     process.exitCode = 1 (process-wide 503 — nothing can
 *                     resolve without the control plane)
 *   (b) a per-tenant DATA-plane migration failure (default included) no longer
 *       fails boot: the tenant is marked `failed` in the readiness map and
 *       tenantResolveHandle serves it a tenant-scoped 503 (readiness.test.ts
 *       pins that no traffic reaches a half-migrated tenant)
 *   (c) authGuard returns 503 + Retry-After while booting
 *   (d) authGuard returns 503 (no retry hint) once boot has definitively failed
 *
 * Importing hooks.server.ts is heavy (touches Auth.js, schedulers, sqlite, …),
 * so every module-scoped dependency is stubbed with vi.mock below. The
 * stubs are intentionally inert — we only want to observe the boot()
 * branch logic, not exercise the downstream side-effects.
 */

// ── Stubs for every side-effect hooks.server.ts pulls in on import. ─────────
//
// The vi.mock factories run before module evaluation, so we need to install
// them ALL before any `await import('./hooks.server')` call. `runMigrations`
// (the default tenant's DATA-plane migration) and `runControlMigrations` (the
// CONTROL plane) are steered per-test via the shared impl refs.

let migrationsImpl: () => Promise<void> = async () => {}
let controlMigrationsImpl: () => Promise<void> = async () => {}

vi.mock('$app/environment', () => ({ building: true }))

vi.mock('$env/dynamic/private', () => ({
  env: {
    DATABASE_URL: 'postgresql://gremion:gremion@localhost:5432/gremion',
  },
}))

vi.mock('$lib/server/db', () => ({
  // boot() awaits waitForDbReady() BEFORE runMigrations(); stub it as an
  // already-resolved probe so the boot sequence proceeds straight to the
  // migrationsImpl branch each test steers.
  waitForDbReady: vi.fn(async () => {}),
  runMigrations: () => migrationsImpl(),
  getDb: () => ({}),
}))

vi.mock('$lib/server/config', () => ({
  readConfig: () => ({
    smtp: { configured: false, host: '', port: 0, from_address: '' },
    modules: { finance: true, elections: true },
    retention: { security_logs_days: 90 },
    // P2.1c (T15 / §6-P2.2): the boot fleet asserts a COMPLETE brand identity per
    // tenant after its migrations succeed. The default tenant is MATERIALIZED in
    // production (real brand values), so the mock carries a complete brand — a
    // successful migration flips it `ready`, not `failed`. (A migration FAILURE
    // throws before the brand guard runs, so the failure-path test is unaffected.)
    brand: { product: 'StuRa', org_short: 'StuRa' },
  }),
}))

vi.mock('$lib/server/calendar/notification-scheduler', () => ({
  startNotificationScheduler: vi.fn(),
}))
vi.mock('$lib/server/calendar/caldav-sync', () => ({
  startCalDavSyncWorker: vi.fn(),
}))
vi.mock('$lib/server/governance/provisioning/worker', () => ({
  startProvisioningWorker: vi.fn(),
}))
vi.mock('$lib/server/tenant/evict-listener', () => ({
  startTenantEvictListener: vi.fn(),
}))
// Task 23: hooks.server.ts no longer boots a newsletter SQLite store or scheduler
// (the leaf service owns them), so there are no newsletter modules to mock here.
vi.mock('$lib/server/jwt-verify', () => ({
  verifyBearerJwt: vi.fn(async () => null),
}))
vi.mock('$lib/server/audit-db', () => ({
  purgeAuditLogsOlderThan: vi.fn(async () => ({ purged: 0 })),
}))

// P2.1a boot path: hooks.server.ts now control-migrates, registers the default
// tenant, resolves its context and ALS-wraps the data-plane runMigrations. Stub
// each so boot() does NOT hit the real control DB or default-context resolution
// (mirrors hooks.tenant-wiring.test.ts). tenantResolveHandle is imported by the
// sequence but never invoked here (these tests call authGuard/cspGuard directly).
vi.mock('$lib/server/tenant/resolve', () => ({
  tenantResolveHandle: vi.fn(async ({ event, resolve }: { event: unknown; resolve: (e: unknown) => unknown }) =>
    resolve(event),
  ),
  // hooks.server.ts also wires tenantForwardFetch as `handleFetch` (gremion#22
  // finding 1) — stub so the module loads; its own behavior is pinned in
  // forward-fetch.test.ts.
  tenantForwardFetch: vi.fn(),
}))
vi.mock('$lib/server/tenant/control-migrations', () => ({
  runControlMigrations: () => controlMigrationsImpl(),
}))
vi.mock('$lib/server/tenant/register-default', () => ({
  registerDefaultTenant: vi.fn(async () => ({ id: 'default' })),
}))
vi.mock('$lib/server/tenant/registry', () => ({
  resolveTenantBySlug: vi.fn(async () => ({ id: 'default', slug: 'default', issuer: 'https://kc/realms/sturaos' })),
  // P2.1b T2: boot's fleet runner lists the active tenants and ledgers each
  // run. The id must match registerDefaultTenant's mock so boot's default-
  // outcome gate finds the fleet result.
  listActiveTenants: vi.fn(async () => [{ id: 'default', slug: 'default', status: 'active' }]),
  startTenantMigrationRun: vi.fn(async () => 'run-1'),
  finishTenantMigrationRun: vi.fn(async () => {}),
}))
vi.mock('$lib/server/tenant/context', () => ({
  runWithTenant: (_ctx: unknown, fn: () => unknown) => fn(),
}))
vi.mock('$lib/server/tenant/default-tenant', () => ({
  DEFAULT_TENANT: { id: 'default', configPath: '/tmp/config.json' },
}))

// ./auth re-exports a SvelteKit `handle` — we just need a passthrough so the
// `sequence(authHandle, …)` at the bottom of hooks.server.ts doesn't blow up.
vi.mock('./auth', () => ({
  handle: async ({ event, resolve }: { event: unknown; resolve: (e: unknown) => unknown }) =>
    resolve(event),
}))

// nodemailer is referenced but only invoked when smtp.configured === true,
// which our config stub leaves false. A bare stub is still required so the
// `import nodemailer from 'nodemailer'` statement resolves.
vi.mock('nodemailer', () => ({ default: { createTransport: vi.fn() } }))

beforeEach(() => {
  // Each test gets a clean module registry so the module-scoped boot state
  // (`_bootComplete`, `_bootError`, `_bootPromise`, the readiness map) starts
  // fresh, and both steered impls reset to clean no-ops.
  vi.resetModules()
  process.exitCode = 0
  migrationsImpl = async () => {}
  controlMigrationsImpl = async () => {}
})

afterEach(() => {
  process.exitCode = 0
})

describe('hooks.server boot sequencing (T4.1 / G-014 + P2.1b T3 / D-READY)', () => {
  it('a CONTROL-plane boot failure leaves _bootComplete=false and populates _bootError (process-wide 503)', async () => {
    const failure = new Error('control migration 002 failed')
    controlMigrationsImpl = async () => {
      throw failure
    }

    const mod = await import('./hooks.server')
    // hooks.server.ts kicks off boot() at module load and does NOT await it.
    // Wait for that in-flight boot to settle before asserting.
    await mod.boot()

    const status = mod.getBootStatus()
    expect(status.complete).toBe(false)
    expect(status.error).toBe(failure)
    // The unhealthy-exit signal is how an orchestrator notices and recycles
    // the container; without it the pod would just sit there serving 503s.
    expect(process.exitCode).toBe(1)
  })

  it('a default-tenant DATA-plane migration failure no longer fails boot — readiness is tenant-scoped (D-READY)', async () => {
    migrationsImpl = async () => {
      throw new Error('schema drift: column "foo" missing')
    }

    const mod = await import('./hooks.server')
    await mod.boot()

    // Boot completes: the process serves (other tenants are unaffected) and
    // self-heals the failed tenant via the lazy retry instead of crash-looping.
    const status = mod.getBootStatus()
    expect(status.complete).toBe(true)
    expect(status.error).toBeNull()
    expect(process.exitCode).toBe(0)

    // The failed tenant is gated tenant-scoped: marked `failed` in the
    // readiness map (tenantResolveHandle 503s it — pinned in readiness.test.ts,
    // so no traffic ever reaches the half-migrated tenant, G-014 preserved).
    const readiness = await import('$lib/server/tenant/readiness')
    expect(readiness.isFleetPopulated()).toBe(true)
    expect(readiness.getTenantReadiness('default')).toBe('failed')
    expect(readiness.getTenantReadinessError('default')).toContain('schema drift')
  })

  it('successful migrations flip _bootComplete=true with no error and a ready default tenant', async () => {
    migrationsImpl = async () => {
      /* no-op */
    }

    const mod = await import('./hooks.server')
    await mod.boot()

    const status = mod.getBootStatus()
    expect(status.complete).toBe(true)
    expect(status.error).toBeNull()
    expect(process.exitCode).toBe(0)

    // Byte-identical default-tenant-only run: fleet populated, default ready —
    // the seam gate passes its requests straight through (readiness.test.ts).
    const readiness = await import('$lib/server/tenant/readiness')
    expect(readiness.isFleetPopulated()).toBe(true)
    expect(readiness.getTenantReadiness('default')).toBe('ready')
  })

  it('boot subscribes THIS process to cross-process tenant evictions (G-XPROC)', async () => {
    migrationsImpl = async () => {}
    vi.mocked(startTenantEvictListener).mockClear()

    const mod = await import('./hooks.server')
    await mod.boot()

    expect(mod.getBootStatus().complete).toBe(true)
    expect(vi.mocked(startTenantEvictListener)).toHaveBeenCalledTimes(1)
  })

  it('a tenant-evict listener failure does NOT fail boot — it degrades to the TTL bound (non-fatal)', async () => {
    migrationsImpl = async () => {}
    vi.mocked(startTenantEvictListener).mockRejectedValueOnce(new Error('control DB unreachable'))

    const mod = await import('./hooks.server')
    await mod.boot()

    // The listener is best-effort: a subscribe failure is caught and logged, the
    // ~30s RESOLUTION_CACHE_TTL still guarantees eventual eviction, and boot
    // completes cleanly (no process-wide 503 over an evict-listener hiccup).
    const status = mod.getBootStatus()
    expect(status.complete).toBe(true)
    expect(status.error).toBeNull()
    expect(process.exitCode).toBe(0)
  })
})

describe('hooks.server authGuard 503 while booting (T4.1 / G-014)', () => {
  it('returns 503 + Retry-After: 5 while boot is still in flight', async () => {
    // A migration that never resolves keeps `_bootComplete` false WITHOUT
    // setting `_bootError`. The authGuard should pick the "booting" branch.
    // Captured-via-closure pattern: TS' flow analysis can't see that the
    // Promise executor assigns the resolver, so type the holder loosely.
    const pending: { resolve?: () => void } = {}
    migrationsImpl = () =>
      new Promise<void>((resolve) => {
        pending.resolve = resolve
      })

    const mod = await import('./hooks.server')
    // Don't await mod.boot() — we WANT it pending here.

    const event = makeFakeEvent('/dashboard')
    const res = await mod.authGuard({
      event: event as never,
      resolve: async () => new Response('should-not-reach', { status: 200 }),
    } as never)

    expect(res).toBeInstanceOf(Response)
    const response = res as Response
    expect(response.status).toBe(503)
    expect(response.headers.get('Retry-After')).toBe('5')
    expect(await response.text()).toBe('Service Unavailable: booting')

    // Release the migration so vitest doesn't hold the promise forever.
    pending.resolve?.()
    await mod.boot()
  })

  it('returns 503 with no Retry-After once boot has definitively failed (control plane)', async () => {
    // Post-T3 only a CONTROL-plane failure fails boot process-wide; a tenant's
    // data-plane failure is gated tenant-scoped at the resolution seam instead.
    controlMigrationsImpl = async () => {
      throw new Error('boom')
    }

    const mod = await import('./hooks.server')
    await mod.boot()

    const event = makeFakeEvent('/dashboard')
    const res = await mod.authGuard({
      event: event as never,
      resolve: async () => new Response('should-not-reach', { status: 200 }),
    } as never)

    const response = res as Response
    expect(response.status).toBe(503)
    expect(response.headers.get('Retry-After')).toBeNull()
    expect(await response.text()).toBe('Service Unavailable: boot failed')
  })
})

describe('authGuard publicPaths segment-boundary matching (netcup T03)', () => {
  beforeEach(() => {
    migrationsImpl = async () => {}
  })

  /**
   * The public allow-list was matched with a bare `path.startsWith(p)`, so any
   * path that merely EXTENDS a public entry without a segment boundary --
   * '/setupmalicious' extends '/setup', '/api/healthz' extends '/api/health' --
   * short-circuited past the session guard as if it were public. A route the
   * kernel later adds under such a name would be served unauthenticated. The
   * matcher must require an exact hit or a '/'-delimited prefix.
   *
   * Only the entries WITHOUT a trailing slash carry that hazard: '/auth/',
   * '/legal/' and '/api/public/protocols/' already end on a separator, so no
   * extension of them can slip past a bare startsWith. The three boundary-less
   * entries below are therefore the complete negative set, and each one is
   * exercised — a single '/setupmalicious' case would have left the other two
   * unguarded.
   */
  const BOUNDARY_LESS_ENTRIES = [
    { entry: '/setup', attack: '/setupmalicious' },
    { entry: '/api/setup/seed', attack: '/api/setup/seedling' },
    { entry: '/api/health', attack: '/api/healthz' },
  ] as const

  for (const { entry, attack } of BOUNDARY_LESS_ENTRIES) {
    it(`does NOT short-circuit '${attack}', which merely extends public entry '${entry}'`, async () => {
      const mod = await import('./hooks.server')
      await mod.boot()

      const event = makeFakeEvent(attack)
      // Unauthenticated: reaching the auth path must reject, not serve.
      event.locals.auth = async () => null

      let resolveCalled = false
      // `authGuard` is typed `MaybePromise<Response>`, so it has no `.then` to
      // chain onto — await it inside a try/catch instead (a page path REJECTS
      // with a SvelteKit redirect, an /api path RETURNS a 401 Response).
      let outcome: { kind: 'returned' | 'threw'; value: unknown }
      try {
        const value = await mod.authGuard({
          event: event as never,
          resolve: async () => {
            resolveCalled = true
            return new Response('public-short-circuit', { status: 200 })
          },
        } as never)
        outcome = { kind: 'returned', value }
      } catch (err) {
        outcome = { kind: 'threw', value: err }
      }

      // The public short-circuit must NOT have fired ...
      expect(resolveCalled).toBe(false)

      // ... and the request must have reached the auth path. API routes answer
      // with a machine-readable 401; page routes redirect to the login screen.
      if (attack.startsWith('/api/')) {
        expect(outcome.kind).toBe('returned')
        const res = outcome.value as Response
        expect(res.status).toBe(401)
        expect(await res.json()).toEqual({ error: 'Unauthenticated', reason: 'no_session' })
      } else {
        expect(outcome.kind).toBe('threw')
        expect(isRedirect(outcome.value)).toBe(true)
        const red = outcome.value as { status: number; location: string }
        expect(red.status).toBe(302)
        expect(red.location).toBe(`/auth/login?callbackUrl=${encodeURIComponent(attack)}`)
      }
    })
  }

  /**
   * Positive coverage for ALL SIX publicPaths entries — the tightened matcher
   * must not have closed a door that was legitimately open. Each entry appears
   * as an exact hit where that is a real URL, and as a '/'-delimited child.
   */
  const PUBLIC_HITS = [
    { entry: '/auth/', path: '/auth/login' },
    { entry: '/auth/', path: '/auth/signout' },
    { entry: '/legal/', path: '/legal/imprint' },
    { entry: '/setup', path: '/setup' },
    { entry: '/setup', path: '/setup/wizard' },
    { entry: '/api/setup/seed', path: '/api/setup/seed' },
    { entry: '/api/setup/seed', path: '/api/setup/seed/status' },
    { entry: '/api/health', path: '/api/health' },
    { entry: '/api/health', path: '/api/health/db' },
    { entry: '/api/public/protocols/', path: '/api/public/protocols/42/pdf' },
  ] as const

  it('covers every one of the six publicPaths entries', async () => {
    const covered = new Set(PUBLIC_HITS.map((h) => h.entry))
    expect([...covered].sort()).toEqual(
      ['/api/health', '/api/public/protocols/', '/api/setup/seed', '/auth/', '/legal/', '/setup'].sort()
    )
  })

  for (const { entry, path } of PUBLIC_HITS) {
    it(`still treats '${path}' as public (entry '${entry}')`, async () => {
      const mod = await import('./hooks.server')
      await mod.boot()

      const event = makeFakeEvent(path)
      event.locals.auth = async () => {
        throw new Error(`auth must not run for public path ${path}`)
      }
      const res = (await mod.authGuard({
        event: event as never,
        resolve: async () => new Response('public', { status: 200 }),
      } as never)) as Response
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('public')
    })
  }
})

describe('cspGuard (G-011b)', () => {
  beforeEach(() => {
    migrationsImpl = async () => {}
  })

  it('CSP_HEADER_VALUE contains the headline directives', async () => {
    const mod = await import('./hooks.server')
    const v = mod.CSP_HEADER_VALUE
    expect(v).toContain("default-src 'self'")
    // 'self' (not 'none') so the same-origin Element Call iframe can render;
    // cross-origin framing (clickjacking) stays blocked.
    expect(v).toContain("frame-ancestors 'self'")
    expect(v).toContain("object-src 'none'")
    expect(v).toContain("base-uri 'self'")
    expect(v).toContain("form-action 'self'")
    expect(v).toContain("script-src 'self' 'unsafe-inline'")
  })

  it('attaches the CSP header to text/html responses', async () => {
    const mod = await import('./hooks.server')
    const inner = new Response('<html>x</html>', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })
    const out = (await mod.cspGuard({
      event: makeFakeEvent('/dashboard') as never,
      resolve: async () => inner,
    } as never)) as Response
    expect(out.headers.get('Content-Security-Policy')).toBe(mod.CSP_HEADER_VALUE)
  })

  it('leaves application/json responses unchanged', async () => {
    const mod = await import('./hooks.server')
    const inner = new Response('{"x":1}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
    const out = (await mod.cspGuard({
      event: makeFakeEvent('/api/finance/budgets') as never,
      resolve: async () => inner,
    } as never)) as Response
    expect(out.headers.get('Content-Security-Policy')).toBeNull()
  })

  it('leaves responses with no content-type header unchanged', async () => {
    const mod = await import('./hooks.server')
    // 204 No Content per the Fetch spec MUST have a null body; passing a
    // string body to `new Response(body, { status: 204 })` throws TypeError.
    // We just need ANY response with no auto-Content-Type — passing `null`
    // as the body achieves that without binding the test to a specific code.
    const inner = new Response(null, { status: 204 })
    const out = (await mod.cspGuard({
      event: makeFakeEvent('/api/files/foo') as never,
      resolve: async () => inner,
    } as never)) as Response
    expect(out.headers.get('Content-Security-Policy')).toBeNull()
  })
})

// ── Minimal Handle event shape — authGuard's pre-boot branch only touches
//    the resolve()/Response path, but it dereferences event.url.pathname
//    *after* the 503 check (in the success branch). The 503 short-circuit
//    means the rest of the event object is never read, so a bare URL is
//    enough.
function makeFakeEvent(path: string) {
  return {
    url: new URL(`http://localhost${path}`),
    request: new Request(`http://localhost${path}`),
    locals: {} as Record<string, unknown>,
    params: {},
  }
}
