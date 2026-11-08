// @vitest-environment node
//
// Module Karenz (phase 2, Task 8): the boot hook of the per-tenant pass. It starts a tick every five
// minutes per active tenant, and a listener that runs the pass at once for a tenant whose switch just
// reached the tenant (so a switch-off is not left waiting for the next tick).
//
// It does NOT depend on the council pool being configured: the pass itself says (and, with a Karenz on
// record, logs loudly) that nothing can be reported, which the module-switch hook would never get to do.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  hooks: [] as Array<() => unknown>,
  listeners: [] as Array<(e: unknown) => Promise<void>>,
  forEachActiveTenant: vi.fn(),
  runPass: vi.fn(),
  resolveTenantBySlug: vi.fn(),
  runWithTenant: vi.fn(),
  registerPreApplyHook: vi.fn(),
  replayHook: vi.fn(),
}))

vi.mock('$lib/server/modules/runtime-registry', () => ({
  registerServerInitHook: vi.fn((fn: () => unknown) => {
    h.hooks.push(fn)
  }),
}))
vi.mock('$lib/server/tenant/worker-fleet', () => ({ forEachActiveTenant: h.forEachActiveTenant }))
vi.mock('$lib/server/tenant/registry', () => ({ resolveTenantBySlug: h.resolveTenantBySlug }))
vi.mock('$lib/server/tenant/context', () => ({ runWithTenant: h.runWithTenant }))
vi.mock('$lib/server/module-switch/listeners', () => ({
  registerModuleSwitchListener: vi.fn((l: (e: unknown) => Promise<void>) => {
    h.listeners.push(l)
  }),
}))
vi.mock('$lib/server/module-switch/reconciler', () => ({ registerPreApplyHook: h.registerPreApplyHook }))
vi.mock('./erasure', () => ({ erasureReplayPreApply: h.replayHook }))
vi.mock('./engine', () => ({ KARENZ_PASS_INTERVAL_MS: 300_000, runKarenzPass: h.runPass }))

const { MODULE_KARENZ_WORKER } = await import('./register.server')

beforeEach(() => {
  h.listeners.length = 0
  h.forEachActiveTenant.mockReset()
  h.runPass.mockReset()
  h.resolveTenantBySlug.mockReset()
  h.runWithTenant.mockReset()
  h.registerPreApplyHook.mockReset()
  h.runWithTenant.mockImplementation(async (_ctx: unknown, fn: () => unknown) => fn())
  vi.useFakeTimers()
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('module Karenz boot hook', () => {
  it('registers exactly one boot hook', () => {
    expect(h.hooks).toHaveLength(1)
  })

  it('runs a pass per active tenant every five minutes, and once shortly after boot', async () => {
    await h.hooks[0]!()
    expect(h.forEachActiveTenant).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.forEachActiveTenant).toHaveBeenCalledTimes(1)
    expect(h.forEachActiveTenant.mock.calls[0]![0]).toBe(MODULE_KARENZ_WORKER)
    const ctx = { id: 't', slug: 'rat-a' }
    ;(h.forEachActiveTenant.mock.calls[0]![1] as (c: unknown) => unknown)(ctx)
    expect(h.runPass).toHaveBeenCalledWith(ctx)
    await vi.advanceTimersByTimeAsync(300_000)
    expect(h.forEachActiveTenant).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(300_000)
    expect(h.forEachActiveTenant).toHaveBeenCalledTimes(3)
  })

  it('registers the erasure replay as a pre-apply hook of the module switch (Task 12): it runs before an enabled module comes back', async () => {
    await h.hooks[0]!()
    expect(h.registerPreApplyHook).toHaveBeenCalledTimes(1)
    expect(h.registerPreApplyHook).toHaveBeenCalledWith(h.replayHook)
  })

  it('registers a switch listener that runs the pass at once for an applied request, inside the tenant scope', async () => {
    await h.hooks[0]!()
    expect(h.listeners).toHaveLength(1)
    const ctx = { id: 't', slug: 'rat-a' }
    h.resolveTenantBySlug.mockResolvedValue(ctx)
    await h.listeners[0]!({ slug: 'rat-a', outcome: 'applied', action: 'disable' })
    expect(h.resolveTenantBySlug).toHaveBeenCalledWith('rat-a')
    expect(h.runWithTenant).toHaveBeenCalledTimes(1)
    expect(h.runPass).toHaveBeenCalledWith(ctx)
  })

  it('the listener ignores a request that was not applied, and a tenant that no longer resolves', async () => {
    await h.hooks[0]!()
    await h.listeners[0]!({ slug: 'rat-a', outcome: 'refused', action: 'disable' })
    expect(h.runPass).not.toHaveBeenCalled()
    h.resolveTenantBySlug.mockResolvedValue(null)
    await h.listeners[0]!({ slug: 'gone', outcome: 'applied', action: 'enable' })
    expect(h.runPass).not.toHaveBeenCalled()
  })

  it('a pass that throws inside the listener does not reject (the tick is the safety net)', async () => {
    await h.hooks[0]!()
    h.resolveTenantBySlug.mockResolvedValue({ id: 't', slug: 'rat-a' })
    h.runPass.mockRejectedValue(new Error('tenant database down'))
    await expect(h.listeners[0]!({ slug: 'rat-a', outcome: 'applied', action: 'enable' })).resolves.toBeUndefined()
    expect(console.error).toHaveBeenCalled()
  })
})
