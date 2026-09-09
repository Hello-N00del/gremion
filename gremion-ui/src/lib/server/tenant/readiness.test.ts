import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { TenantContext } from './context'

// P2.1b T3 (D-READY) — per-tenant boot readiness. The registry (control-DB
// SQL) and $lib/server/db (data-plane migrations) are MOCKED; context, fleet,
// readiness and resolve are REAL so these tests pin that (a) the healthy
// tenant's downstream runs inside ITS explicit runWithTenant scope and (b) the
// lazy re-migration retry runs inside the FAILED tenant's explicit scope —
// never an ambient/harness default
// ([[als-default-tenant-test-harness-masks-fail-closed]]).
vi.mock('./registry', () => ({
  listActiveTenants: vi.fn(),
  resolveTenantBySlug: vi.fn(),
  startTenantMigrationRun: vi.fn(),
  finishTenantMigrationRun: vi.fn(),
}))
vi.mock('$lib/server/db', () => ({
  runMigrations: vi.fn(),
  getDb: vi.fn(),
}))
// P2.1c (T15 / §6-P2.2): the REAL fleet now asserts a COMPLETE brand identity
// per tenant (reading THAT tenant's config via readConfig) after migrations
// succeed. These D-READY tests pin re-migration BEHAVIOR, not branding, so mock
// readConfig to return a complete brand — otherwise an unmocked readConfig reads
// a non-existent path → neutral blank brand → the guard would (correctly) keep
// the tenant `failed`, masking the migration-success assertions here. The
// fleet's own brand-guard wiring is covered in fleet.test.ts.
vi.mock('$lib/server/config', () => ({
  readConfig: vi.fn(() => ({
    brand: { product: 'GovOS', org_short: 'Stadt WR' },
  })),
}))

import { resolveTenantBySlug, startTenantMigrationRun, finishTenantMigrationRun } from './registry'
import { runMigrations, getDb } from '$lib/server/db'
import { currentTenantId } from './context'
import { tenantResolveHandle } from './resolve'
import {
  setTenantReadinessFromFleet,
  getTenantReadiness,
  getTenantReadinessError,
  isFleetPopulated,
  triggerTenantMigrationRetry,
  _resetReadinessForTests,
} from './readiness'

const ctxFor = (id: string, slug: string) => ({ id, slug }) as unknown as TenantContext

function makeEvent(forwardedHost: string, path = '/dashboard') {
  const headers = new Headers()
  headers.set('x-forwarded-host', forwardedHost)
  const url = new URL(`http://internal${path}`)
  return { url, request: new Request(url, { headers }), locals: {} as Record<string, unknown>, params: {} }
}

beforeEach(() => {
  vi.clearAllMocks()
  _resetReadinessForTests()
  vi.mocked(resolveTenantBySlug).mockImplementation(async (slug: string) => {
    if (slug === 'alpha') return ctxFor('tid-a', 'alpha')
    if (slug === 'beta') return ctxFor('tid-b', 'beta')
    return null
  })
  vi.mocked(startTenantMigrationRun).mockImplementation(async (tenantId: string) => `run-${tenantId}`)
  vi.mocked(finishTenantMigrationRun).mockResolvedValue(undefined)
  vi.mocked(runMigrations).mockResolvedValue(undefined)
  vi.mocked(getDb).mockReturnValue(
    (async () => [{ filename: '039_x.sql' }]) as unknown as ReturnType<typeof getDb>,
  )
})

describe('tenant readiness map (D-READY, plan T3)', () => {
  it('defaults to pending for unknown tenants; fleet outcomes map ok→ready / !ok→failed', () => {
    expect(isFleetPopulated()).toBe(false)
    expect(getTenantReadiness('tid-a')).toBe('pending')

    setTenantReadinessFromFleet(
      new Map([
        ['tid-a', { ok: true }],
        ['tid-b', { ok: false, error: 'schema drift: column "foo" missing' }],
      ]),
    )

    expect(isFleetPopulated()).toBe(true)
    expect(getTenantReadiness('tid-a')).toBe('ready')
    expect(getTenantReadiness('tid-b')).toBe('failed')
    expect(getTenantReadinessError('tid-b')).toContain('schema drift')
    // A tenant the fleet never saw (e.g. registered after boot) stays pending.
    expect(getTenantReadiness('tid-unknown')).toBe('pending')
  })

  it('before the boot fleet populates the map, retry triggers are a NO-OP (boot owns the first attempt — no double migration during boot)', () => {
    const p = triggerTenantMigrationRetry({ id: 'tid-a', slug: 'alpha' })
    expect(p).toBeNull()
    expect(runMigrations).not.toHaveBeenCalled()
    expect(startTenantMigrationRun).not.toHaveBeenCalled()
  })
})

describe('lazy re-migration retry (single-flighted, D-READY)', () => {
  beforeEach(() => {
    setTenantReadinessFromFleet(
      new Map([
        ['tid-a', { ok: true }],
        ['tid-b', { ok: false, error: 'boom' }],
      ]),
    )
  })

  it('a ready tenant never re-migrates', () => {
    expect(triggerTenantMigrationRetry({ id: 'tid-a', slug: 'alpha' })).toBeNull()
    expect(runMigrations).not.toHaveBeenCalled()
  })

  it('retries a failed tenant inside its EXPLICIT tenant scope; success flips it ready and is ledgered', async () => {
    const seen: string[] = []
    vi.mocked(runMigrations).mockImplementation(async () => {
      // currentTenantId() THROWS outside an ALS scope — recording it proves the
      // retry wrapped runMigrations() in runWithTenant(ctx, …) for tid-b.
      seen.push(currentTenantId())
    })

    const attempt = triggerTenantMigrationRetry({ id: 'tid-b', slug: 'beta' })
    expect(attempt).not.toBeNull()
    await attempt

    expect(seen).toEqual(['tid-b'])
    expect(getTenantReadiness('tid-b')).toBe('ready')
    // The lazy retry is ledgered exactly like a boot fleet run (D-FLEET).
    expect(finishTenantMigrationRun).toHaveBeenCalledWith('run-tid-b', {
      ok: true,
      lastApplied: '039_x.sql',
    })
  })

  it('concurrent triggers single-flight onto ONE in-flight attempt', async () => {
    let release!: () => void
    vi.mocked(runMigrations).mockImplementation(
      () => new Promise<void>((res) => { release = res }),
    )

    const p1 = triggerTenantMigrationRetry({ id: 'tid-b', slug: 'beta' })
    const p2 = triggerTenantMigrationRetry({ id: 'tid-b', slug: 'beta' })
    expect(p1).not.toBeNull()
    expect(p2).toBe(p1) // the SAME in-flight attempt — not a second migration

    await vi.waitFor(() => expect(runMigrations).toHaveBeenCalledTimes(1))
    // Still in flight: a third trigger coalesces too.
    expect(triggerTenantMigrationRetry({ id: 'tid-b', slug: 'beta' })).toBe(p1)

    release()
    await p1
    expect(runMigrations).toHaveBeenCalledTimes(1)
    expect(getTenantReadiness('tid-b')).toBe('ready')
  })

  it('a failed retry stays failed with the new error; a LATER trigger attempts again (next resolution re-checks)', async () => {
    vi.mocked(runMigrations).mockRejectedValueOnce(new Error('still drifting'))

    const p1 = triggerTenantMigrationRetry({ id: 'tid-b', slug: 'beta' })
    await p1
    expect(getTenantReadiness('tid-b')).toBe('failed')
    expect(getTenantReadinessError('tid-b')).toContain('still drifting')

    const p2 = triggerTenantMigrationRetry({ id: 'tid-b', slug: 'beta' })
    expect(p2).not.toBeNull()
    expect(p2).not.toBe(p1)
    await p2
    expect(getTenantReadiness('tid-b')).toBe('ready')
  })
})

describe('tenantResolveHandle readiness gate (D-READY seam)', () => {
  it('a failed tenant serves a tenant-scoped 503 while a healthy tenant 200s in its own explicit scope', async () => {
    setTenantReadinessFromFleet(
      new Map([
        ['tid-a', { ok: true }],
        ['tid-b', { ok: false, error: 'boom' }],
      ]),
    )

    const seenTenantIds: string[] = []
    const resolveSpy = vi.fn(async () => {
      seenTenantIds.push(currentTenantId()) // throws unless inside the explicit per-tenant scope
      return new Response('ok', { status: 200 })
    })

    const healthy = makeEvent('alpha.example.org')
    const okRes = (await tenantResolveHandle({ event: healthy as never, resolve: resolveSpy } as never)) as Response
    expect(okRes.status).toBe(200)
    expect(seenTenantIds).toEqual(['tid-a'])

    const failing = makeEvent('beta.example.org')
    const failRes = (await tenantResolveHandle({ event: failing as never, resolve: resolveSpy } as never)) as Response
    expect(failRes.status).toBe(503)
    expect(failRes.headers.get('Retry-After')).toBe('5')
    expect(await failRes.text()).toBe('Service Unavailable: tenant not ready')
    // Downstream NEVER ran for the failed tenant; no context leaked onto locals.
    expect(resolveSpy).toHaveBeenCalledTimes(1)
    expect(failing.locals.tenant).toBeUndefined()
  })

  it("the failed tenant's 503 lazily re-migrates it (single-flighted) and the NEXT request 200s", async () => {
    setTenantReadinessFromFleet(new Map([['tid-b', { ok: false, error: 'boom' }]]))
    const migratedIn: string[] = []
    vi.mocked(runMigrations).mockImplementation(async () => {
      migratedIn.push(currentTenantId())
    })

    const resolveSpy = vi.fn(async () => new Response('ok', { status: 200 }))
    const first = (await tenantResolveHandle({
      event: makeEvent('beta.example.org') as never,
      resolve: resolveSpy,
    } as never)) as Response
    expect(first.status).toBe(503)

    await vi.waitFor(() => expect(getTenantReadiness('tid-b')).toBe('ready'))
    // Exactly ONE re-attempt, inside tid-b's explicit tenant scope.
    expect(migratedIn).toEqual(['tid-b'])

    const second = (await tenantResolveHandle({
      event: makeEvent('beta.example.org') as never,
      resolve: resolveSpy,
    } as never)) as Response
    expect(second.status).toBe(200)
    expect(resolveSpy).toHaveBeenCalledTimes(1)
  })

  it('a PENDING tenant (registered after boot) 503s, then lazily migrates to ready', async () => {
    setTenantReadinessFromFleet(new Map([['tid-a', { ok: true }]])) // tid-b absent → pending
    const res = (await tenantResolveHandle({
      event: makeEvent('beta.example.org') as never,
      resolve: vi.fn(async () => new Response('ok')),
    } as never)) as Response
    expect(res.status).toBe(503)
    await vi.waitFor(() => expect(getTenantReadiness('tid-b')).toBe('ready'))
  })

  it('while the fleet has NOT populated the map the seam passes through (the process-wide boot gate owns pre-boot 503s) and never re-migrates', async () => {
    const resolveSpy = vi.fn(async () => new Response('ok', { status: 200 }))
    const res = (await tenantResolveHandle({
      event: makeEvent('alpha.example.org') as never,
      resolve: resolveSpy,
    } as never)) as Response
    expect(res.status).toBe(200)
    expect(resolveSpy).toHaveBeenCalledTimes(1)
    expect(runMigrations).not.toHaveBeenCalled()
  })
})
