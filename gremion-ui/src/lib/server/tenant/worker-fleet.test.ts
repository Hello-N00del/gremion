import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Tenant } from './registry'
import type { TenantContext } from './context'

// P2.1b T4 — unit contract of the worker-fleet helper `forEachActiveTenant`:
// every background-worker tick iterates the ACTIVE registry tenants, runs the
// per-tenant work inside an EXPLICIT runWithTenant scope, single-flights per
// (label, tenantId) — replacing the old process-global `_running` booleans —
// and fail-safes per tenant (one tenant's throw never stops the rest, a
// control-plane listing failure skips the tick instead of rejecting it).
//
// The registry is mocked; the tenant CONTEXT module is deliberately REAL so
// these tests pin that the work executes inside the EXPLICIT per-tenant ALS
// scope the helper establishes — never an ambient/harness default
// ([[als-default-tenant-test-harness-masks-fail-closed]]). The READINESS
// module is REAL too: the D-READY worker-plane gate below must consult the
// same map the boot fleet populates (start/finishTenantMigrationRun are in
// the registry mock ONLY so the no-worker-retry test can assert they are
// never called — fleet.ts imports them transitively via readiness.ts).
vi.mock('./registry', () => ({
  listActiveTenants: vi.fn(),
  resolveTenantBySlug: vi.fn(),
  startTenantMigrationRun: vi.fn(),
  finishTenantMigrationRun: vi.fn(),
}))

import { listActiveTenants, resolveTenantBySlug, startTenantMigrationRun } from './registry'
import { currentTenantId } from './context'
import {
  setTenantReadinessFromFleet,
  getTenantReadiness,
  _resetReadinessForTests,
} from './readiness'
import { forEachActiveTenant, _resetWorkerFleetForTests } from './worker-fleet'

const tenantRow = (id: string, slug: string) =>
  ({ id, slug, status: 'active' }) as unknown as Tenant
const ctxFor = (id: string, slug: string) => ({ id, slug }) as unknown as TenantContext

beforeEach(() => {
  vi.clearAllMocks()
  _resetWorkerFleetForTests()
  // D-READY worker gate: ticks only serve tenants the boot fleet marked
  // ready — populate the map so the helper-contract tests above the gate
  // exercise the normal (all-ready) path.
  _resetReadinessForTests()
  setTenantReadinessFromFleet(
    new Map([
      ['tid-default', { ok: true }],
      ['tid-beta', { ok: true }],
    ]),
  )
  vi.mocked(listActiveTenants).mockResolvedValue([
    tenantRow('tid-default', 'default'),
    tenantRow('tid-beta', 'beta'),
  ])
  vi.mocked(resolveTenantBySlug).mockImplementation(async (slug: string) =>
    slug === 'default' ? ctxFor('tid-default', 'default') : ctxFor('tid-beta', 'beta'),
  )
})

describe('forEachActiveTenant — P2.1b T4 worker-fleet helper', () => {
  it('runs the work for every ACTIVE tenant inside its own explicit tenant scope', async () => {
    const seen: string[] = []
    await forEachActiveTenant('test-worker', () => {
      // currentTenantId() THROWS outside an ALS scope — recording it proves
      // the helper wrapped this tenant's work in runWithTenant(ctx, …).
      seen.push(currentTenantId())
    })
    expect(seen).toEqual(['tid-default', 'tid-beta'])
  })

  it('passes the resolved TenantContext to the work fn', async () => {
    const seen: TenantContext[] = []
    await forEachActiveTenant('test-worker', (ctx) => {
      seen.push(ctx)
    })
    expect(seen.map((c) => c.slug)).toEqual(['default', 'beta'])
  })

  it('skips an in-flight (label, tenant) pair but still serves the other tenants (single-flight)', async () => {
    const calls: string[] = []
    let enterDefault!: () => void
    const entered = new Promise<void>((r) => {
      enterDefault = r
    })
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })

    const work = async () => {
      const id = currentTenantId()
      calls.push(id)
      if (id === 'tid-default') {
        enterDefault()
        await gate
      }
    }

    const tick1 = forEachActiveTenant('test-worker', work)
    await entered // tick1 is now blocked inside the default tenant's work
    const tick2 = forEachActiveTenant('test-worker', work)
    await tick2 // tick2 must SKIP the in-flight default and still drain beta
    release()
    await tick1

    expect(calls.filter((id) => id === 'tid-default')).toHaveLength(1)
    expect(calls.filter((id) => id === 'tid-beta')).toHaveLength(2)
  })

  it('single-flight is keyed per (label, tenant): a DIFFERENT worker label is not blocked', async () => {
    const calls: string[] = []
    let enterDefault!: () => void
    const entered = new Promise<void>((r) => {
      enterDefault = r
    })
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })

    const tick1 = forEachActiveTenant('worker-a', async () => {
      if (currentTenantId() === 'tid-default') {
        enterDefault()
        await gate
      }
    })
    await entered
    // Same tenant, different label — must NOT be skipped.
    await forEachActiveTenant('worker-b', () => {
      calls.push(`b:${currentTenantId()}`)
    })
    release()
    await tick1

    expect(calls).toEqual(['b:tid-default', 'b:tid-beta'])
  })

  it("one tenant's throw never stops the other tenants, and is logged with the worker label", async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const seen: string[] = []

    await forEachActiveTenant('test-worker', () => {
      const id = currentTenantId()
      if (id === 'tid-default') throw new Error('boom-default')
      seen.push(id)
    })

    expect(seen).toEqual(['tid-beta'])
    const lines = errSpy.mock.calls.map((c) => c.join(' '))
    expect(lines.some((l) => l.includes('test-worker') && l.includes('default'))).toBe(true)
    errSpy.mockRestore()
  })

  it('releases the single-flight key after a throw — the next tick runs that tenant again', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const calls: string[] = []
    const work = () => {
      calls.push(currentTenantId())
      throw new Error('always boom')
    }
    await forEachActiveTenant('test-worker', work)
    await forEachActiveTenant('test-worker', work)
    expect(calls).toEqual(['tid-default', 'tid-beta', 'tid-default', 'tid-beta'])
    errSpy.mockRestore()
  })

  it('a tenant that no longer resolves is skipped with a log; the fleet continues', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(resolveTenantBySlug).mockImplementation(async (slug: string) =>
      slug === 'default' ? null : ctxFor('tid-beta', 'beta'),
    )
    const seen: string[] = []
    await forEachActiveTenant('test-worker', () => {
      seen.push(currentTenantId())
    })
    expect(seen).toEqual(['tid-beta'])
    const lines = errSpy.mock.calls.map((c) => c.join(' '))
    expect(lines.some((l) => l.includes('test-worker') && l.includes('default'))).toBe(true)
    errSpy.mockRestore()
  })

  it('a control-plane listing failure fail-safes: the tick logs and resolves (workers must never crash on it)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(listActiveTenants).mockRejectedValue(new Error('control db down'))
    const fn = vi.fn()
    await expect(forEachActiveTenant('test-worker', fn)).resolves.toBeUndefined()
    expect(fn).not.toHaveBeenCalled()
    const lines = errSpy.mock.calls.map((c) => c.join(' '))
    expect(lines.some((l) => l.includes('test-worker') && l.includes('control db down'))).toBe(true)
    errSpy.mockRestore()
  })
})

// Adversarial-review fix (P2.1b, als-worker): workers are the OTHER traffic
// source besides HTTP — their ticks WRITE to tenant DBs (provisioning marks,
// caldav failure records, newsletter audit entries, audit-purge DELETEs), so
// the per-tenant D-READY readiness gate at the HTTP seam (resolve.ts) must
// hold on the worker plane too, or those writes race the single-flighted lazy
// re-migration's DDL on a half-migrated tenant DB (G-014 per tenant).
describe('forEachActiveTenant — D-READY worker-plane readiness gate', () => {
  it('fail-closed BEFORE the boot fleet populates readiness: the WHOLE tick is skipped (nothing is known to be migrated)', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    _resetReadinessForTests() // pre-boot: fleet has not populated the map
    const fn = vi.fn()

    await expect(forEachActiveTenant('test-worker', fn)).resolves.toBeUndefined()

    expect(fn).not.toHaveBeenCalled()
    // Skipped before even listing — there is nothing a worker may touch yet.
    expect(listActiveTenants).not.toHaveBeenCalled()
    const lines = infoSpy.mock.calls.map((c) => c.join(' '))
    expect(lines.some((l) => l.includes('test-worker') && l.includes('skipped'))).toBe(true)
    infoSpy.mockRestore()
  })

  it('skips a tenant whose migration FAILED — the worker never touches a half-migrated DB; ready tenants still run', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    setTenantReadinessFromFleet(
      new Map([['tid-default', { ok: false, error: 'schema drift: column "foo" missing' }]]),
    )
    const seen: string[] = []

    await forEachActiveTenant('test-worker', () => {
      seen.push(currentTenantId())
    })

    expect(seen).toEqual(['tid-beta'])
    const lines = warnSpy.mock.calls.map((c) => c.join(' '))
    expect(
      lines.some((l) => l.includes('test-worker') && l.includes('default') && l.includes('failed')),
    ).toBe(true)
    warnSpy.mockRestore()
  })

  it('skips a PENDING tenant the boot fleet never saw (registered after boot) and resumes once it heals to ready', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    _resetReadinessForTests()
    setTenantReadinessFromFleet(new Map([['tid-default', { ok: true }]])) // beta absent → pending
    const seen: string[] = []
    const work = () => {
      seen.push(currentTenantId())
    }

    await forEachActiveTenant('test-worker', work)
    expect(seen).toEqual(['tid-default'])

    // The tenant heals (the request-driven lazy retry at the resolution seam
    // flips it ready) — the NEXT tick serves it without a restart.
    setTenantReadinessFromFleet(new Map([['tid-beta', { ok: true }]]))
    await forEachActiveTenant('test-worker', work)
    expect(seen).toEqual(['tid-default', 'tid-default', 'tid-beta'])
    warnSpy.mockRestore()
  })

  it('a skipped tenant is NOT re-migrated from the worker plane — the lazy retry stays request-driven (resolution seam)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    setTenantReadinessFromFleet(
      new Map([['tid-default', { ok: false, error: 'boom' }]]),
    )

    await forEachActiveTenant('test-worker', () => {})

    // Any re-migration attempt ledgers via startTenantMigrationRun FIRST
    // (fleet.ts migrateTenant) — cron pressure must never drive DDL retries.
    expect(startTenantMigrationRun).not.toHaveBeenCalled()
    expect(getTenantReadiness('tid-default')).toBe('failed')
    warnSpy.mockRestore()
  })
})
