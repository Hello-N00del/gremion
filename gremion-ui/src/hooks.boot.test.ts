import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
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

// TASK-023: steerable, so one test can load the module as a running server
// (building=false, boot starts at load) while every other test drives boot()
// by hand (building=true: the module-load boot is skipped, as in `vite build`).
const appEnv = vi.hoisted(() => ({ building: true }))
vi.mock('$app/environment', () => appEnv)

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
  // TASK-023: boot classifies its failure with the db module's classifier. The
  // real one is pinned in db-startup.test.ts; this stand-in knows the two codes
  // the tests below throw.
  isTransientDbStartupError: (err: unknown) =>
    ['ECONNREFUSED', '57P03'].includes(String((err as { code?: unknown } | null)?.code)),
}))

vi.mock('$lib/server/config', () => ({
  readConfig: () => ({
    smtp: { configured: false, host: '', port: 0, from_address: '' },
    // messages: true because the public /livekit and /element-call paths are gated on the messages module
    // (F5 r2, 8feea898: module-gate.ts PUBLIC_MODULE_PATHS); an absent key reads as OFF -> 403.
    modules: { finance: true, elections: true, messages: true },
    retention: { security_logs_days: 27 },
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
  verifyAuditChain: vi.fn(async () => ({ ok: true })),
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
// TASK-042: boot registers no tenant any more; the fleet is whatever the
// registry lists. Steerable per test (zero tenants, a failing control plane).
let listActiveTenantsImpl: () => Promise<unknown[]> = async () => [
  { id: 'default', slug: 'default', status: 'active' },
]
vi.mock('$lib/server/tenant/registry', () => ({
  // The fleet runner resolves each listed tenant's context (fleet.ts).
  resolveTenantBySlug: vi.fn(async () => ({ id: 'default', slug: 'default', issuer: 'https://kc/realms/gremion-test' })),
  // P2.1b T2: boot's fleet runner lists the active tenants and ledgers each run.
  listActiveTenants: vi.fn(() => listActiveTenantsImpl()),
  startTenantMigrationRun: vi.fn(async () => 'run-1'),
  finishTenantMigrationRun: vi.fn(async () => {}),
}))
vi.mock('$lib/server/tenant/context', () => ({
  runWithTenant: (_ctx: unknown, fn: () => unknown) => fn(),
}))

// ./auth re-exports a SvelteKit `handle`. TASK-023: faithful to the real one in
// the one way that matters here — buildAuthConfig THROWS without a resolved
// tenant — so a sequence test proves an exempt request never reaches it.
const authHandleCalls: string[] = []
vi.mock('./auth', () => ({
  handle: async ({ event, resolve }: { event: { url: URL; locals: Record<string, unknown> }; resolve: (e: unknown) => unknown }) => {
    authHandleCalls.push(event.url.pathname)
    if (!event.locals.tenant) throw new Error('buildAuthConfig: no tenant resolved (tenantResolveHandle must run first)')
    return resolve(event)
  },
}))

// @ts-expect-error — runtime-only internal entry; see hooks.tenant-wiring.test.ts.
import { with_request_store } from '@sveltejs/kit/internal/server'

/** sequence() needs SvelteKit's request store; the runtime (respond.js) provides it. */
function withRequestStore<T>(event: unknown, fn: () => T): T {
  const state = { tracing: { record_span: <R>({ fn }: { fn: (span: unknown) => Promise<R> }) => fn({}) } }
  return with_request_store({ event, state } as never, fn)
}

// nodemailer is referenced but only invoked when smtp.configured === true,
// which our config stub leaves false. A bare stub is still required so the
// `import nodemailer from 'nodemailer'` statement resolves.
vi.mock('nodemailer', () => ({ default: { createTransport: vi.fn() } }))

// TASK-023: a non-transient boot failure calls process.exit(1) through
// bootRuntime.exit. boot() starts at module load, before a test could reach the
// module's own seam, so process.exit itself is stubbed for every test.
let exitSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  // Each test gets a clean module registry so the module-scoped boot state
  // (`_bootComplete`, `_bootError`, `_bootPromise`, the readiness map) starts
  // fresh, and both steered impls reset to clean no-ops.
  vi.resetModules()
  process.exitCode = 0
  migrationsImpl = async () => {}
  controlMigrationsImpl = async () => {}
  listActiveTenantsImpl = async () => [{ id: 'default', slug: 'default', status: 'active' }]
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
  appEnv.building = true
})

afterEach(() => {
  process.exitCode = 0
  exitSpy.mockRestore()
  vi.useRealTimers()
})

// TASK-039-FU residual 3 (r30-9 gate: 6.1 s against vitest's 5 s default, 58/58
// alone). The first test of the file pays the whole transform of hooks.server's
// module graph on its first `await import`; later tests re-import against a warm
// transform cache (beforeEach resets the module registry, not the transform
// cache). The cold cost is moved onto this hook, which has its own budget, so
// every test keeps vitest's default 5 s: the project testTimeout is NOT raised.
// `building` is already true (the hoisted appEnv), so the module-load boot()
// does not run during this import.
beforeAll(async () => {
  appEnv.building = true
  await import('./hooks.server')
}, 120_000)

/**
 * Wait for the boot() that hooks.server.ts starts at module load to settle,
 * WITHOUT calling boot() — after a transient failure that call would start the
 * next attempt. Microtasks only, so it is safe under fake timers.
 */
async function settleModuleLoadBoot(mod: typeof import('./hooks.server')): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const s = mod.getBootStatus()
    if (s.complete || s.error) return
    await Promise.resolve()
  }
  throw new Error('module-load boot did not settle')
}

/**
 * Let every queued microtask run (a boot attempt is a chain of awaits). Timers
 * are untouched, so this is safe under fake timers.
 */
async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 200; i++) await Promise.resolve()
}

/** An error the db classifier calls transient (Postgres went away mid-boot). */
function refused(): Error {
  return Object.assign(new Error('connect ECONNREFUSED 10.0.0.2:5432'), { code: 'ECONNREFUSED' })
}

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
    // TASK-023: a non-transient failure exits, so `restart: unless-stopped`
    // recycles the container instead of it latching a permanent 503.
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  // TASK-042 TDD 3 (PRD-PLAT-012, TRD-075): a platform with zero customers boots.
  it('boots with ZERO active tenants: complete, no error, exitCode 0, nothing exits', async () => {
    listActiveTenantsImpl = async () => []

    const mod = await import('./hooks.server')
    await mod.boot()

    const status = mod.getBootStatus()
    expect(status.error).toBeNull()
    expect(status.complete).toBe(true)
    expect(process.exitCode).toBe(0)
    expect(exitSpy).not.toHaveBeenCalled()
    const readiness = await import('$lib/server/tenant/readiness')
    expect(readiness.isFleetPopulated()).toBe(true)
  })

  // TASK-042 §9: the deleted "default must resolve" check doubled as a control-
  // plane check; listing the fleet keeps that role.
  it('a failing listActiveTenants (control plane) still fails boot and exits 1', async () => {
    const failure = new Error('relation "tenant" does not exist')
    listActiveTenantsImpl = async () => {
      throw failure
    }

    const mod = await import('./hooks.server')
    await mod.boot()

    const status = mod.getBootStatus()
    expect(status.complete).toBe(false)
    expect(status.error).toBe(failure)
    expect(process.exitCode).toBe(1)
    expect(exitSpy).toHaveBeenCalledWith(1)
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
    // Start boot but don't await it — we WANT it pending here.
    const inflight = mod.boot()

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
    await vi.waitFor(() => expect(pending.resolve).toBeTypeOf('function'))
    pending.resolve?.()
    await inflight
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

describe('boot self-heal (TASK-023 items 3 and 6, Q2, Q3)', () => {
  it('a transient failure drops the memo: no exit, exitCode untouched (Q3), and the 2nd call re-attempts', async () => {
    let calls = 0
    controlMigrationsImpl = async () => {
      calls++
      if (calls === 1) throw refused()
    }
    const mod = await import('./hooks.server')
    await mod.boot()

    expect(mod.getBootStatus().complete).toBe(false)
    expect(mod.getBootStatus().error?.message).toContain('ECONNREFUSED')
    expect(process.exitCode).toBe(0)
    expect(exitSpy).not.toHaveBeenCalled()

    await mod.boot()
    expect(calls).toBe(2)
    expect(mod.getBootStatus()).toEqual({ complete: true, error: null })
  })

  it('concurrent callers share one attempt', async () => {
    const pending: { resolve?: () => void } = {}
    let calls = 0
    controlMigrationsImpl = () => {
      calls++
      return new Promise<void>((r) => {
        pending.resolve = r
      })
    }
    const mod = await import('./hooks.server')
    const a = mod.boot()
    const b = mod.boot()
    expect(a).toBe(b)
    await vi.waitFor(() => expect(pending.resolve).toBeTypeOf('function'))
    pending.resolve?.()
    await Promise.all([a, b])
    expect(calls).toBe(1)
    expect(mod.getBootStatus().complete).toBe(true)
  })

  it('a non-transient failure calls bootRuntime.exit(1) and sets exitCode = 1 (Q3)', async () => {
    controlMigrationsImpl = async () => {
      throw Object.assign(new Error('password authentication failed for user "gremion"'), { code: '28P01' })
    }
    const mod = await import('./hooks.server')
    await mod.boot()
    expect(exitSpy).toHaveBeenCalledTimes(1)
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(process.exitCode).toBe(1)
    // The memo is kept: nothing re-attempts a non-transient failure.
    expect(mod.boot()).toBe(mod.boot())
  })

  it('bootRuntime.exit delegates to process.exit; bootRuntime.schedule unrefs its timer', async () => {
    const mod = await import('./hooks.server')
    await mod.boot()
    mod.bootRuntime.exit(7)
    expect(exitSpy).toHaveBeenCalledWith(7)
    const t = mod.bootRuntime.schedule(() => {}, 60_000)
    expect(t.hasRef()).toBe(false)
    clearTimeout(t)
  })

  it('Q2: one re-attempt is scheduled on a timer of at most 30 s, and it completes boot', async () => {
    vi.useFakeTimers()
    let calls = 0
    controlMigrationsImpl = async () => {
      calls++
      if (calls === 1) throw refused()
    }
    const mod = await import('./hooks.server')
    expect(mod.BOOT_RETRY_DELAY_MS).toBeGreaterThan(0)
    expect(mod.BOOT_RETRY_DELAY_MS).toBeLessThanOrEqual(30_000)
    await mod.boot()
    expect(mod.getBootStatus().complete).toBe(false)
    expect(vi.getTimerCount()).toBe(1)

    await vi.advanceTimersByTimeAsync(mod.BOOT_RETRY_DELAY_MS - 1)
    await drainMicrotasks()
    expect(calls).toBe(1)
    // Nothing but the timer calls boot() here: the re-attempt is the timer's.
    await vi.advanceTimersByTimeAsync(1)
    await drainMicrotasks()
    expect(calls).toBe(2)
    expect(mod.getBootStatus().complete).toBe(true)
    // Nothing re-attempts a completed boot.
    await vi.advanceTimersByTimeAsync(mod.BOOT_RETRY_DELAY_MS * 2)
    expect(calls).toBe(2)
  })

  it('Q2: repeated transient failures never stack more than one pending re-attempt', async () => {
    vi.useFakeTimers()
    let calls = 0
    controlMigrationsImpl = async () => {
      calls++
      throw refused()
    }
    const mod = await import('./hooks.server')
    await mod.boot()
    await mod.boot()
    await mod.boot()
    expect(calls).toBe(3)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('/healthz never triggers a re-attempt', async () => {
    vi.useFakeTimers()
    let calls = 0
    controlMigrationsImpl = async () => {
      calls++
      throw refused()
    }
    const mod = await import('./hooks.server')
    await mod.boot()
    expect(calls).toBe(1)
    for (let i = 0; i < 5; i++) {
      const res = (await mod.authGuard({
        event: makeFakeEvent('/healthz') as never,
        resolve: async () => new Response('{"ok":true}', { status: 200 }),
      } as never)) as Response
      expect(res.status).toBe(200)
    }
    // A re-attempt would take a few awaits to reach controlMigrations; give it
    // every chance to, without advancing the (fake) re-attempt timer.
    await drainMicrotasks()
    expect(calls).toBe(1)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('the re-attempts have a ceiling: the BOOT_MAX_TRANSIENT_FAILURES-th consecutive transient failure exits 1', async () => {
    vi.useFakeTimers()
    let calls = 0
    controlMigrationsImpl = async () => {
      calls++
      throw refused()
    }
    const mod = await import('./hooks.server')
    expect(mod.BOOT_MAX_TRANSIENT_FAILURES).toBeGreaterThan(1)
    await mod.boot()
    for (let i = 1; i < mod.BOOT_MAX_TRANSIENT_FAILURES; i++) {
      expect(exitSpy).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(mod.BOOT_RETRY_DELAY_MS)
      await drainMicrotasks()
    }
    expect(calls).toBe(mod.BOOT_MAX_TRANSIENT_FAILURES)
    expect(exitSpy).toHaveBeenCalledTimes(1)
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(process.exitCode).toBe(1)
    // Nothing further is scheduled once the ceiling is reached.
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('an unresolved exempt request with no route (TASK-023)', () => {
  // SvelteKit would render its 404 through the root layout, whose load needs
  // locals.auth and a tenant — neither exists for such a request (Auth.js was
  // skipped). Found on the running system as a 500 for /api/internal/<unknown>.
  for (const booted of [false, true]) {
    it(`is a plain 404 without rendering anything (${booted ? 'after boot' : 'while booting'})`, async () => {
      const pending: { resolve?: () => void } = {}
      if (!booted) {
        controlMigrationsImpl = () =>
          new Promise<void>((r) => {
            pending.resolve = r
          })
      }
      const mod = await import('./hooks.server')
      const inflight = mod.boot()
      if (booted) await inflight
      let reached = false
      const res = (await mod.authGuard({
        event: makeFakeEvent('/api/internal/nope', null) as never,
        resolve: async () => {
          reached = true
          return new Response('rendered', { status: 404 })
        },
      } as never)) as Response
      expect(reached).toBe(false)
      expect(res.status).toBe(404)
      expect(await res.text()).toBe('Not Found')
      /* oxlint-disable vitest/no-conditional-expect -- keyed on the case's own parameter (whether the boot already ran) */
      if (!booted) {
        await vi.waitFor(() => expect(pending.resolve).toBeTypeOf('function'))
        pending.resolve?.()
        await inflight
      }
      /* oxlint-enable vitest/no-conditional-expect */
    })
  }
})

describe('the full handle sequence (TASK-023)', () => {
  async function throughHandle(mod: typeof import('./hooks.server'), path: string, tenant?: unknown) {
    const event = makeFakeEvent(path)
    if (tenant) event.locals.tenant = tenant
    event.locals.auth = async () => null
    return (await withRequestStore(event, () =>
      mod.handle({ event: event as never, resolve: async () => new Response('{"ok":true}', { status: 200 }) }),
    )) as Response
  }

  beforeEach(() => {
    authHandleCalls.length = 0
  })

  it('an unresolved /healthz never reaches Auth.js (which throws without a tenant), during and after boot', async () => {
    const pending: { resolve?: () => void } = {}
    controlMigrationsImpl = () =>
      new Promise<void>((r) => {
        pending.resolve = r
      })
    const mod = await import('./hooks.server')
    const inflight = mod.boot()
    expect((await throughHandle(mod, '/healthz')).status).toBe(200)
    await vi.waitFor(() => expect(pending.resolve).toBeTypeOf('function'))
    pending.resolve?.()
    await inflight
    expect((await throughHandle(mod, '/healthz')).status).toBe(200)
    expect((await throughHandle(mod, '/api/internal/evict')).status).toBe(200)
    expect(authHandleCalls).toEqual([])
  })

  it('a tenant-resolved request still goes through Auth.js', async () => {
    const mod = await import('./hooks.server')
    await mod.boot()
    const tenant = { id: 't1', slug: 't1', issuer: 'https://kc/realms/t1' }
    // TASK-205c: the newsletter callbacks are public (exact PUBLIC_PATHS entries, each self-guarded by its secret); the
    // content callback is not until the content half is enabled, so it still takes the session gate.
    const res = await throughHandle(mod, '/api/internal/content/portal-publish', tenant)
    expect(authHandleCalls).toEqual(['/api/internal/content/portal-publish'])
    // ...and then the session guard: no session, so a machine-readable 401.
    expect(res.status).toBe(401)
  })
})

describe('boot at module load (TASK-023)', () => {
  it('is skipped while SvelteKit builds: an exit(1) there would kill `vite build`', async () => {
    let calls = 0
    controlMigrationsImpl = async () => {
      calls++
      throw new Error('CONTROL_DATABASE_URL not configured')
    }
    const mod = await import('./hooks.server')
    for (let i = 0; i < 50; i++) await Promise.resolve()
    expect(calls).toBe(0)
    expect(exitSpy).not.toHaveBeenCalled()
    expect(mod.getBootStatus()).toEqual({ complete: false, error: null })
  })

  it('starts on import in a running server', async () => {
    appEnv.building = false
    let calls = 0
    controlMigrationsImpl = async () => {
      calls++
    }
    const mod = await import('./hooks.server')
    await settleModuleLoadBoot(mod)
    expect(calls).toBe(1)
    expect(mod.getBootStatus().complete).toBe(true)
  })
})

describe('authGuard boot gate (TASK-023 item 3)', () => {
  async function guard(mod: typeof import('./hooks.server'), path: string, tenant?: unknown) {
    const event = makeFakeEvent(path)
    if (tenant) event.locals.tenant = tenant
    let reached = false
    const res = (await mod.authGuard({
      event: event as never,
      resolve: async () => {
        reached = true
        return new Response('handler', { status: 200 })
      },
    } as never)) as Response
    return { res, reached }
  }

  it('while booting: /healthz answers, every other path is 503 booting with Retry-After: 5', async () => {
    const pending: { resolve?: () => void } = {}
    controlMigrationsImpl = () =>
      new Promise<void>((r) => {
        pending.resolve = r
      })
    const mod = await import('./hooks.server')
    const inflight = mod.boot()

    const h = await guard(mod, '/healthz')
    expect(h.reached).toBe(true)
    expect(h.res.status).toBe(200)

    for (const path of ['/dashboard', '/api/health', '/healthzx', '/api/members']) {
      const o = await guard(mod, path)
      expect(o.reached, path).toBe(false)
      expect(o.res.status).toBe(503)
      expect(o.res.headers.get('Retry-After')).toBe('5')
      expect(await o.res.text()).toBe('Service Unavailable: booting')
    }
    await vi.waitFor(() => expect(pending.resolve).toBeTypeOf('function'))
    pending.resolve?.()
    await inflight
  })

  it('while booting: an unresolved /api/internal/ request passes, a tenant-resolved one is gated', async () => {
    const pending: { resolve?: () => void } = {}
    controlMigrationsImpl = () =>
      new Promise<void>((r) => {
        pending.resolve = r
      })
    const mod = await import('./hooks.server')
    const inflight = mod.boot()

    expect((await guard(mod, '/api/internal/evict')).reached).toBe(true)
    const resolved = await guard(mod, '/api/internal/newsletter/render', { id: 't1', slug: 't1' })
    expect(resolved.reached).toBe(false)
    expect(resolved.res.status).toBe(503)

    await vi.waitFor(() => expect(pending.resolve).toBeTypeOf('function'))
    pending.resolve?.()
    await inflight
  })

  it('after a transient failure (re-attempt pending) other paths stay 503 booting with Retry-After: 5', async () => {
    vi.useFakeTimers()
    controlMigrationsImpl = async () => {
      throw refused()
    }
    const mod = await import('./hooks.server')
    await mod.boot()
    const o = await guard(mod, '/dashboard')
    expect(o.res.status).toBe(503)
    expect(o.res.headers.get('Retry-After')).toBe('5')
    expect(await o.res.text()).toBe('Service Unavailable: booting')
  })

  it("after a non-retryable failure other paths are 503 'boot failed'; /healthz still answers 200 (Q5)", async () => {
    controlMigrationsImpl = async () => {
      throw new Error('control migration 002 failed')
    }
    const mod = await import('./hooks.server')
    await mod.boot()
    const o = await guard(mod, '/dashboard')
    expect(o.res.status).toBe(503)
    expect(await o.res.text()).toBe('Service Unavailable: boot failed')
    // Q5 (accepted, handed off to TASK-040/086): /healthz is liveness, not
    // readiness. A switch gate must read /api/health as well.
    expect((await guard(mod, '/healthz')).res.status).toBe(200)
  })

  it('after boot: an unresolved /healthz or /api/internal/ request skips the session guard, with locals defaulted', async () => {
    const mod = await import('./hooks.server')
    await mod.boot()
    for (const path of ['/healthz', '/api/internal/evict']) {
      const event = makeFakeEvent(path)
      event.locals.auth = async () => {
        throw new Error(`auth must not run for ${path}`)
      }
      const res = (await mod.authGuard({
        event: event as never,
        resolve: async () => new Response('ok', { status: 200 }),
      } as never)) as Response
      expect(res.status, path).toBe(200)
      expect(event.locals.user).toBeNull()
      expect(event.locals.accessToken).toBeNull()
    }
  })

  it('after boot: a tenant-resolved /api/internal/ request (anything through the edge) still needs a session', async () => {
    const mod = await import('./hooks.server')
    await mod.boot()
    const o = await (async () => {
      // TASK-205c: not a newsletter callback (those are public by exact path, each self-guarded by its secret): the
      // content callback stays behind the session until the content half is enabled.
      const event = makeFakeEvent('/api/internal/content/portal-publish')
      event.locals.tenant = { id: 't1', slug: 't1', issuer: 'https://kc/realms/t1' }
      event.locals.auth = async () => null
      let reached = false
      const res = (await mod.authGuard({
        event: event as never,
        resolve: async () => {
          reached = true
          return new Response('handler', { status: 200 })
        },
      } as never)) as Response
      return { res, reached }
    })()
    expect(o.reached).toBe(false)
    expect(o.res.status).toBe(401)
    expect(await o.res.json()).toEqual({ error: 'Unauthenticated', reason: 'no_session' })
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
   * '/legal/', '/livekit/', '/element-call/' and '/api/public/protocols/' already end on a separator, so no
   * extension of them can slip past a bare startsWith. The boundary-less
   * entries below are therefore the complete negative set, and each one is
   * exercised. ('/setup' left the list with the first-run wizard, TASK-042 Q1;
   * '/setupmalicious' is covered by the deleted-wizard case further down.)
   */
  const BOUNDARY_LESS_ENTRIES = [
    { entry: '/api/setup/seed', attack: '/api/setup/seedling' },
    { entry: '/api/health', attack: '/api/healthz' },
    { entry: '/element-call', attack: '/element-callXYZ' },
    // TASK-205c: publishing's entries are exact; a longer name or a child path is not public.
    { entry: '/newsletter/unsubscribe', attack: '/newsletter/unsubscribeX' },
    { entry: '/newsletter/unsubscribe', attack: '/newsletter/unsubscribe/extra' },
    { entry: '/api/newsletter/unsubscribe', attack: '/api/newsletter/unsubscribes' },
    { entry: '/api/newsletter/unsubscribe', attack: '/api/newsletter/unsubscribe/extra' },
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
      /* oxlint-disable vitest/no-conditional-expect -- keyed on the case's own input (the attack path), and each arm asserts the outcome kind first */
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
      /* oxlint-enable vitest/no-conditional-expect */
    })
  }

  /**
   * Positive coverage for ALL FIVE publicPaths entries — the tightened matcher
   * must not have closed a door that was legitimately open. Each entry appears
   * as an exact hit where that is a real URL, and as a '/'-delimited child.
   */
  const PUBLIC_HITS = [
    { entry: '/auth/', path: '/auth/login' },
    { entry: '/auth/', path: '/auth/signout' },
    { entry: '/legal/', path: '/legal/imprint' },
    { entry: '/livekit/', path: '/livekit/jwt' },
    { entry: '/element-call/', path: '/element-call/index.html' },
    { entry: '/element-call', path: '/element-call' },
    { entry: '/newsletter/unsubscribe', path: '/newsletter/unsubscribe' },
    { entry: '/api/newsletter/unsubscribe', path: '/api/newsletter/unsubscribe' },
    { entry: '/api/internal/newsletter/render', path: '/api/internal/newsletter/render' },
    { entry: '/api/internal/newsletter/resolve-group', path: '/api/internal/newsletter/resolve-group' },
    { entry: '/api/internal/newsletter/send-mail', path: '/api/internal/newsletter/send-mail' },
    { entry: '/api/setup/seed', path: '/api/setup/seed' },
    { entry: '/api/health', path: '/api/health' },
    { entry: '/api/public/protocols/*/pdf', path: '/api/public/protocols/42/pdf' },
  ] as const

  // TASK-042 TDD 5 (Q1): the first-run wizard is gone, so '/setup' is no
  // longer public. The pin reads the SHIPPED list, not a copy of it.
  // F1-FIX-03 / S1a#28: the /api entries are EXACT routes now, not subtrees;
  // only the two page trees '/auth/' and '/legal/' stay prefixes.
  // TASK-205b: plus the messaging module's three public entries (LiveKit proxy, Element Call SPA).
  // TASK-205c: plus the publishing module's five (unsubscribe page and API, the three leaf callbacks), all exact.
  const FIVE = [
    '/api/health',
    '/api/internal/newsletter/render',
    '/api/internal/newsletter/resolve-group',
    '/api/internal/newsletter/send-mail',
    '/api/newsletter/unsubscribe',
    '/api/public/protocols/*/pdf',
    '/api/setup/seed',
    '/auth/',
    '/element-call',
    '/element-call/',
    '/legal/',
    '/livekit/',
    '/newsletter/unsubscribe',
  ]

  // F1-FIX-03 / S1a#28: a path BELOW or BESIDE a public /api route is not public.
  // A route the kernel later adds there must not be served unauthenticated just
  // because it shares a prefix with a public one.
  for (const path of [
    '/api/health/db',
    '/api/setup/seed/status',
    '/api/public/protocols/42',
    '/api/public/protocols/42/pdf/extra',
    '/api/public/protocols/42/attachments',
    '/api/public/protocols/',
    '/api/public/protocols//pdf',
    // TASK-205c: the rest of the newsletter API stays behind the session.
    '/api/newsletter',
    '/api/newsletter/lists',
    '/api/newsletter/42/send-now',
  ]) {
    it(`does NOT treat '${path}' as public (S1a#28): an unauthenticated call is a 401`, async () => {
      const mod = await import('./hooks.server')
      await mod.boot()
      const event = makeFakeEvent(path)
      event.locals.auth = async () => null
      let resolveCalled = false
      const res = (await mod.authGuard({
        event: event as never,
        resolve: async () => {
          resolveCalled = true
          return new Response('public-short-circuit', { status: 200 })
        },
      } as never)) as Response
      expect(resolveCalled).toBe(false)
      expect(res.status).toBe(401)
    })
  }

  // The five publishing entries are exact string matches on the raw pathname: a trailing slash, a doubled slash (leading
  // or inside), another letter case, or a %-encoded letter is a different path and takes the session gate, not the
  // public short-circuit.
  const PUBLISHING_EXACT = [
    '/newsletter/unsubscribe',
    '/api/newsletter/unsubscribe',
    '/api/internal/newsletter/render',
    '/api/internal/newsletter/resolve-group',
    '/api/internal/newsletter/send-mail',
  ]
  for (const entry of PUBLISHING_EXACT) {
    for (const path of nearMisses(entry)) {
      it(`does NOT treat the near-miss '${path}' of '${entry}' as public`, async () => {
        const mod = await import('./hooks.server')
        await mod.boot()
        const event = makeFakeEvent(path)
        // Tenant-resolved, as every edge request is: an /api/internal/ path with no tenant is the container-network
        // exemption (boot-exempt.ts), which is a different gate.
        event.locals.tenant = { id: 't1', slug: 't1', issuer: 'https://kc/realms/t1' }
        event.locals.auth = async () => null
        let resolveCalled = false
        let thrown: unknown = null
        let res: Response | null = null
        try {
          res = (await mod.authGuard({
            event: event as never,
            resolve: async () => {
              resolveCalled = true
              return new Response('public-short-circuit', { status: 200 })
            },
          } as never)) as Response
        } catch (err) {
          thrown = err
        }
        expect(resolveCalled).toBe(false)
        // An /api/ path answers a machine-readable 401; anything else redirects to the login page.
        const outcome = res ? res.status : isRedirect(thrown) ? 'redirect' : 'other'
        expect(outcome).toBe(path.startsWith('/api/') ? 401 : 'redirect')
      })
    }
  }

  // Raw-vs-decoded: the router serves '/newsletter/%75nsubscribe' as '/newsletter/unsubscribe', so the guard must
  // judge it exactly as it judges the plain spelling (public), not by the raw string.
  for (const entry of PUBLISHING_EXACT) {
    it(`treats the encoded spelling of '${entry}' exactly like the plain path (public)`, async () => {
      const mod = await import('./hooks.server')
      await mod.boot()
      const event = makeFakeEvent(encodedSpelling(entry))
      event.locals.tenant = { id: 't1', slug: 't1', issuer: 'https://kc/realms/t1' }
      event.locals.auth = async () => null
      let resolveCalled = false
      await mod.authGuard({
        event: event as never,
        resolve: async () => {
          resolveCalled = true
          return new Response('public-short-circuit', { status: 200 })
        },
      } as never)
      expect(resolveCalled).toBe(true)
    })
  }

  it('the shipped publicPaths list is exactly the pinned entries (no /setup)', async () => {
    const mod = await import('./hooks.server')
    expect([...mod.PUBLIC_PATHS].sort()).toEqual([...FIVE].sort())
  })

  it('covers every one of the pinned publicPaths entries', async () => {
    const covered = new Set(PUBLIC_HITS.map((h) => h.entry))
    expect([...covered].sort()).toEqual([...FIVE].sort())
  })

  // Q9: no authGuard change for the deleted wizard paths; an unauthenticated
  // request for one is answered exactly like a never-existing path.
  for (const path of ['/setup', '/setup/wizard', '/setupmalicious', '/t042-no-such-route']) {
    it(`redirects unauthenticated '${path}' to the login page like any unknown path`, async () => {
      const mod = await import('./hooks.server')
      await mod.boot()
      const event = makeFakeEvent(path)
      event.locals.auth = async () => null
      let resolveCalled = false
      let thrown: unknown = null
      try {
        await mod.authGuard({
          event: event as never,
          resolve: async () => {
            resolveCalled = true
            return new Response('public-short-circuit', { status: 200 })
          },
        } as never)
      } catch (err) {
        thrown = err
      }
      expect(resolveCalled).toBe(false)
      expect(isRedirect(thrown)).toBe(true)
      const red = thrown as { status: number; location: string }
      expect(red.status).toBe(302)
      expect(red.location).toBe(`/auth/login?callbackUrl=${encodeURIComponent(path)}`)
    })
  }

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

// TASK-205c: the publishing leaf's three callbacks are public ONLY by exact path, and a request the resolver handed on
// WITH a tenant (the leaf sends x-tenant-id, tenant/leaf-trust.ts) takes the same short-circuit; their handlers then
// refuse without the shared secret (modules/publishing/app/routes/api/internal/newsletter/callback-auth.test.ts).
describe('authGuard leaf callbacks (TASK-205c)', () => {
  beforeEach(() => {
    migrationsImpl = async () => {}
  })

  const tenant = { id: 't1', slug: 't1', issuer: 'https://kc/realms/t1' }
  const NEWSLETTER_CALLBACKS = ['/api/internal/newsletter/render', '/api/internal/newsletter/resolve-group', '/api/internal/newsletter/send-mail']

  async function guard(path: string): Promise<{ res: Response; resolved: boolean }> {
    const mod = await import('./hooks.server')
    await mod.boot()
    const event = makeFakeEvent(path)
    event.locals.tenant = tenant
    event.locals.auth = async () => null
    let resolved = false
    const res = (await mod.authGuard({
      event: event as never,
      resolve: async () => {
        resolved = true
        return new Response('public', { status: 200 })
      },
    } as never)) as Response
    return { res, resolved }
  }

  for (const path of NEWSLETTER_CALLBACKS) {
    it(`serves the tenant-resolved callback '${path}' without a session (its handler checks the secret)`, async () => {
      const { res, resolved } = await guard(path)
      expect(resolved).toBe(true)
      expect(res.status).toBe(200)
    })
  }

  for (const path of [
    '/api/internal/newsletter/render/extra',
    '/api/internal/newsletter/renderX',
    '/api/internal/newsletter/',
    '/api/internal/newsletter/other',
    '/api/internal/content/portal-publish',
    '/api/internal/push',
  ]) {
    it(`does NOT serve the tenant-resolved '${path}' without a session: a 401`, async () => {
      const { res, resolved } = await guard(path)
      expect(resolved).toBe(false)
      expect(res.status).toBe(401)
    })
  }

  it('PUBLIC_PATHS holds exactly the newsletter keys of LEAF_CALLBACK_ROUTES (content stays guarded until its half is enabled)', async () => {
    const mod = await import('./hooks.server')
    const { LEAF_CALLBACK_ROUTES } = await import('$lib/server/tenant/leaf-trust')
    const newsletterKeys = Object.keys(LEAF_CALLBACK_ROUTES).filter((k) => k.startsWith('/api/internal/newsletter/'))
    expect(newsletterKeys.toSorted()).toEqual([...NEWSLETTER_CALLBACKS].toSorted())
    for (const key of newsletterKeys) expect(mod.PUBLIC_PATHS).toContain(key)
    for (const key of Object.keys(LEAF_CALLBACK_ROUTES).filter((k) => !k.startsWith('/api/internal/newsletter/'))) {
      expect(mod.PUBLIC_PATHS, `${key} is a content callback: public only with the content half`).not.toContain(key)
    }
  })
})

describe('cspGuard (G-011b)', () => {
  beforeEach(() => {
    migrationsImpl = async () => {}
  })

  it('CSP_HEADER_VALUE is the header-only frame-ancestors directive', async () => {
    const mod = await import('./hooks.server')
    const v = mod.CSP_HEADER_VALUE
    // The script/style/resource directives live in svelte.config.js kit.csp (nonce-based).
    // The app-page addition carries ONLY frame-ancestors: 'self' (not 'none') so the
    // same-origin Element Call iframe can render while cross-origin framing stays blocked.
    expect(v).toBe("frame-ancestors 'self'")
    // The nonce migration's point: no 'unsafe-inline' script source, and no script-src or
    // default-src in the appended policy (a second policy intersects with the first, and
    // either directive here could block the nonced hydration script kit.csp allows).
    expect(v).not.toContain('unsafe-inline')
    expect(v).not.toContain('script-src')
    expect(v).not.toContain('default-src')
  })

  it('NON_PAGE_CSP_HEADER_VALUE keeps the full baseline for proxied HTML', async () => {
    const mod = await import('./hooks.server')
    const v = mod.NON_PAGE_CSP_HEADER_VALUE
    // The proxied Element Call document never passes through kit.csp, so cspGuard is its
    // only CSP layer and it keeps the full policy (a trusted, proxied third-party document
    // that cannot be nonced from here).
    expect(v).toContain("default-src 'self'")
    expect(v).toContain("script-src 'self' 'unsafe-inline'")
    expect(v).toContain("frame-ancestors 'self'")
    expect(v).toContain("object-src 'none'")
    expect(v).toContain("base-uri 'self'")
    expect(v).toContain("form-action 'self'")
  })

  it('sets nosniff + Referrer-Policy on EVERY response, including non-html', async () => {
    const mod = await import('./hooks.server')
    for (const [label, contentType] of [
      ['json api', 'application/json'],
      ['attachment', 'application/octet-stream'],
      ['html page', 'text/html; charset=utf-8'],
    ] as const) {
      const inner = new Response('x', { status: 200, headers: { 'content-type': contentType } })
      const out = (await mod.cspGuard({
        event: makeFakeEvent('/api/files/1') as never,
        resolve: async () => inner,
      } as never)) as Response
      expect(out.headers.get('X-Content-Type-Options'), label).toBe('nosniff')
      expect(out.headers.get('Referrer-Policy'), label).toBe('strict-origin-when-cross-origin')
    }
  })

  it('appends only frame-ancestors to a SvelteKit page (existing kit.csp nonce policy)', async () => {
    // On SSR pages SvelteKit has already set the nonce-based CSP header before cspGuard
    // runs. cspGuard must add frame-ancestors as a SECOND policy and leave the nonce
    // policy intact: overwriting it would strip the script nonce and break hydration.
    const mod = await import('./hooks.server')
    const kitPolicy = "default-src 'self'; script-src 'self' 'nonce-abc123'; style-src 'self' 'unsafe-inline'"
    const inner = new Response('<html>x</html>', {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': kitPolicy,
      },
    })
    const out = (await mod.cspGuard({
      event: makeFakeEvent('/dashboard') as never,
      resolve: async () => inner,
    } as never)) as Response
    const combined = out.headers.get('Content-Security-Policy') ?? ''
    expect(combined).toContain("script-src 'self' 'nonce-abc123'")
    expect(combined).toContain("frame-ancestors 'self'")
    expect(combined).not.toContain("script-src 'self' 'unsafe-inline'")
    // A page render carries authenticated content: no-store keeps the browser from
    // restoring it from bfcache or the disk cache after logout.
    expect(out.headers.get('Cache-Control')).toBe('no-store')
  })

  it('sets the baseline CSP on non-page text/html with no kit.csp header (Element Call proxy)', async () => {
    // The Element Call endpoint returns proxied text/html with NO CSP header (kit.csp only
    // runs for page renders). cspGuard must give it the full baseline policy.
    const mod = await import('./hooks.server')
    const inner = new Response('<html>element-call</html>', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })
    const out = (await mod.cspGuard({
      event: makeFakeEvent('/element-call/index.html') as never,
      resolve: async () => inner,
    } as never)) as Response
    expect(out.headers.get('Content-Security-Policy')).toBe(mod.NON_PAGE_CSP_HEADER_VALUE)
    // The proxied HTML is text/html too, so it also gets no-store.
    expect(out.headers.get('Cache-Control')).toBe('no-store')
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
    // JSON APIs are not text/html: no no-store is forced onto them.
    expect(out.headers.get('Cache-Control')).toBeNull()
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
    expect(out.headers.get('Cache-Control')).toBeNull()
  })
})

// ── Minimal Handle event shape — authGuard's pre-boot branch only touches
//    the resolve()/Response path, but it dereferences event.url.pathname
//    *after* the 503 check (in the success branch). The 503 short-circuit
//    means the rest of the event object is never read, so a bare URL is
//    enough.
// Paths that differ from an exact public entry only by a trailing slash, a leading or an inner doubled slash, letter case,
// or a %-encoded first letter of the last segment.
function nearMisses(entry: string): string[] {
  const i = entry.lastIndexOf('/')
  // A %-encoded letter is NOT a near miss: the router decodes it, so it is the same route as the plain entry and is
  // checked against the DECODED path (see 'encoded spelling' below).
  return [`${entry}/`, `/${entry}`, `${entry.slice(0, i)}/${entry.slice(i)}`, entry.toUpperCase()]
}

function encodedSpelling(entry: string): string {
  const i = entry.lastIndexOf('/')
  const last = entry.slice(i + 1)
  return `${entry.slice(0, i + 1)}%${last.charCodeAt(0).toString(16)}${last.slice(1)}`
}

function makeFakeEvent(path: string, routeId: string | null = path) {
  return {
    url: new URL(`http://localhost${path}`),
    request: new Request(`http://localhost${path}`),
    locals: {} as Record<string, unknown>,
    params: {},
    // SvelteKit matches the route before `handle` runs; null = no route.
    route: { id: routeId },
  }
}
