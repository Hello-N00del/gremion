// @vitest-environment node
//
// register.server.test.ts - the council module switch reconciler's boot hook.
//
// Not configured (no PLATFORM_MODULES_DATABASE_URL) -> no timer starts. Configured -> one tick per
// MODULE_SWITCH_INTERVAL_MS runs a pass for every active tenant through the worker-fleet seam.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  hooks: [] as Array<() => unknown>,
  getCouncilDb: vi.fn(),
  forEachActiveTenant: vi.fn(),
  runPass: vi.fn(),
}))

vi.mock('$lib/server/modules/runtime-registry', () => ({
  registerServerInitHook: vi.fn((fn: () => unknown) => {
    h.hooks.push(fn)
  }),
}))
vi.mock('$lib/server/tenant/worker-fleet', () => ({ forEachActiveTenant: h.forEachActiveTenant }))
vi.mock('./council-db', async () => {
  class CouncilNotConfigured extends Error {}
  return { CouncilNotConfigured, getCouncilDb: h.getCouncilDb }
})
vi.mock('./reconciler', () => ({ MODULE_SWITCH_INTERVAL_MS: 10_000, runModuleSwitchPass: h.runPass }))

const { MODULE_SWITCH_WORKER } = await import('./register.server')
const { CouncilNotConfigured } = await import('./council-db')
const { switchOffBlockedReason } = await import('./guards')

beforeEach(() => {
  h.getCouncilDb.mockReset()
  h.forEachActiveTenant.mockReset()
  h.runPass.mockReset()
  vi.useFakeTimers()
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('module switch boot hook', () => {
  it('registers exactly one hook', () => {
    expect(h.hooks).toHaveLength(1)
  })

  it('starts no timer when the council pool is not configured', async () => {
    h.getCouncilDb.mockImplementation(() => {
      throw new CouncilNotConfigured()
    })
    await h.hooks[0]!()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.forEachActiveTenant).not.toHaveBeenCalled()
  })

  it('starts no timer, and does not throw, when the pool cannot be created', async () => {
    h.getCouncilDb.mockImplementation(() => {
      throw new Error('invalid url')
    })
    expect(() => h.hooks[0]!()).not.toThrow()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.forEachActiveTenant).not.toHaveBeenCalled()
  })

  it('runs a pass per active tenant every 10 seconds when configured', async () => {
    h.getCouncilDb.mockReturnValue({})
    await h.hooks[0]!()
    expect(h.forEachActiveTenant).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.forEachActiveTenant).toHaveBeenCalledTimes(1)
    expect(h.forEachActiveTenant.mock.calls[0]![0]).toBe(MODULE_SWITCH_WORKER)
    const ctx = { id: 't', slug: 'rat-a' }
    ;(h.forEachActiveTenant.mock.calls[0]![1] as (c: unknown) => unknown)(ctx)
    expect(h.runPass).toHaveBeenCalledWith(ctx)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.forEachActiveTenant).toHaveBeenCalledTimes(2)
  })
})

// The calendar runs as a leaf with its own database in the pilot, and the Karenz export of a switch-off
// reads a different, empty one. A council admin who passes the confirmation phrase must not reach it.
describe('calendar switch-off guard (leaf backend)', () => {
  const tenant = { id: 't', slug: 'rat-a' } as never
  afterEach(() => vi.unstubAllEnvs())

  it('refuses a calendar switch-off while the calendar runs as a leaf service', async () => {
    vi.stubEnv('CALENDAR_BACKEND', 'service')
    const reason = await switchOffBlockedReason(tenant, 'calendar')
    expect(reason).toMatch(/Kalender/)
  })

  it('fails closed on a backend value it does not know', async () => {
    vi.stubEnv('CALENDAR_BACKEND', 'redis')
    expect(await switchOffBlockedReason(tenant, 'calendar')).toMatch(/Kalender/)
  })

  it('does not object when the calendar runs in-process (unset, empty or inprocess)', async () => {
    for (const v of [undefined, '', 'inprocess']) {
      if (v === undefined) vi.stubEnv('CALENDAR_BACKEND', undefined as unknown as string)
      else vi.stubEnv('CALENDAR_BACKEND', v)
      expect(await switchOffBlockedReason(tenant, 'calendar'), String(v)).toBeNull()
    }
  })

  it('does not touch any other module', async () => {
    vi.stubEnv('CALENDAR_BACKEND', 'service')
    expect(await switchOffBlockedReason(tenant, 'votes')).toBeNull()
  })
})
