/**
 * Unit tests for the per-tenant scheduler tick (Task 8).
 *
 * Dependency-free: the tenant lister, per-tenant store resolver, dispatch,
 * resetStuckSending, dueDispatch and purge are all INJECTED fakes. No PG, no
 * timers fired here (the tick fn is invoked directly; the interval wiring is
 * tested via the SCHEDULER_ENABLED gate without advancing real time).
 *
 * Failing-first anchor: SCHEDULER_ENABLED='false' → ZERO ticks.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  runSchedulerTick,
  startScheduler,
  _resetSchedulerForTests,
  type SchedulerDeps,
  type TickWork,
} from '../src/scheduler.ts'
import type { TenantRef } from '../src/tenant-store.ts'

const T1: TenantRef = { id: '11111111-1111-1111-1111-111111111111', slug: 'alpha' }
const T2: TenantRef = { id: '22222222-2222-2222-2222-222222222222', slug: 'beta' }

beforeEach(() => {
  _resetSchedulerForTests()
})

/** Build a tick-work spy set + a deps object wired to fakes. */
function makeDeps(
  tenants: TenantRef[],
  workOverride?: Partial<TickWork>,
): { deps: SchedulerDeps; calls: { reset: string[]; due: string[]; purge: string[] } } {
  const calls = { reset: [] as string[], due: [] as string[], purge: [] as string[] }
  const work: TickWork = {
    resetStuck: async (t) => { calls.reset.push(t.slug) },
    dispatchDue: async (t) => { calls.due.push(t.slug) },
    purgeTokens: async (t) => { calls.purge.push(t.slug) },
    ...workOverride,
  }
  const deps: SchedulerDeps = {
    listTenants: async () => tenants,
    work,
  }
  return { deps, calls }
}

describe('runSchedulerTick — per-tenant work', () => {
  it('runs resetStuck + dispatchDue for every active tenant in one tick', async () => {
    const { deps, calls } = makeDeps([T1, T2])
    await runSchedulerTick(deps)
    expect(calls.reset.sort()).toEqual(['alpha', 'beta'])
    expect(calls.due.sort()).toEqual(['alpha', 'beta'])
    // purge is the WEEKLY cadence — NOT run on a normal tick.
    expect(calls.purge).toEqual([])
  })

  it('runs the weekly token purge only when withPurge is requested', async () => {
    const { deps, calls } = makeDeps([T1, T2])
    await runSchedulerTick(deps, { withPurge: true })
    expect(calls.purge.sort()).toEqual(['alpha', 'beta'])
  })

  it('one tenant throwing does not stop the others (fail-safe per tenant)', async () => {
    const { deps, calls } = makeDeps([T1, T2], {
      dispatchDue: async (t) => {
        if (t.slug === 'alpha') throw new Error('alpha boom')
        calls.due.push(t.slug)
      },
    })
    await expect(runSchedulerTick(deps)).resolves.toBeUndefined()
    // beta still dispatched; reset still ran for both.
    expect(calls.due).toContain('beta')
    expect(calls.reset.sort()).toEqual(['alpha', 'beta'])
  })

  it('a control-plane listing failure is swallowed (tick never rejects)', async () => {
    const deps: SchedulerDeps = {
      listTenants: async () => { throw new Error('catalog down') },
      work: makeDeps([]).deps.work,
    }
    await expect(runSchedulerTick(deps)).resolves.toBeUndefined()
  })
})

describe('per-tenant single-flight', () => {
  it('skips a tenant whose previous tick is still in flight', async () => {
    let resolveAlpha: () => void = () => {}
    const gate = new Promise<void>((r) => { resolveAlpha = r })
    const dueCalls: string[] = []
    const deps: SchedulerDeps = {
      listTenants: async () => [T1],
      work: {
        resetStuck: async () => {},
        dispatchDue: async (t) => { dueCalls.push(t.slug); await gate },
        purgeTokens: async () => {},
      },
    }
    // First tick: starts alpha and blocks inside dispatchDue.
    const first = runSchedulerTick(deps)
    // Second tick while the first is still running alpha → alpha is skipped.
    await runSchedulerTick(deps)
    expect(dueCalls).toEqual(['alpha']) // only the first tick ran alpha
    resolveAlpha()
    await first
  })
})

describe('SCHEDULER_ENABLED gate (§D.3 step-0 cutover hold)', () => {
  it("SCHEDULER_ENABLED='false' → zero ticks, no interval scheduled", async () => {
    const { deps, calls } = makeDeps([T1, T2])
    const setIntervalSpy = vi.fn(() => 0 as unknown as NodeJS.Timeout)

    const handle = startScheduler(deps, {
      enabled: false,
      setIntervalImpl: setIntervalSpy as unknown as typeof setInterval,
    })

    // No interval registered AT ALL — the whole tick is held.
    expect(setIntervalSpy).not.toHaveBeenCalled()
    expect(handle.enabled).toBe(false)

    // Even invoking the returned tick is a guaranteed no-op set (defensive):
    // no tenant work happened.
    expect(calls.reset).toEqual([])
    expect(calls.due).toEqual([])
    handle.stop()
  })

  it("SCHEDULER_ENABLED default ('true') → an interval IS scheduled at 60s", async () => {
    const { deps } = makeDeps([T1])
    const setIntervalSpy = vi.fn(() => 123 as unknown as NodeJS.Timeout)
    const clearIntervalSpy = vi.fn()

    const handle = startScheduler(deps, {
      enabled: true,
      setIntervalImpl: setIntervalSpy as unknown as typeof setInterval,
      clearIntervalImpl: clearIntervalSpy as unknown as typeof clearInterval,
    })

    expect(handle.enabled).toBe(true)
    expect(setIntervalSpy).toHaveBeenCalledTimes(1)
    // 60s tick interval.
    expect(setIntervalSpy.mock.calls[0]![1]).toBe(60_000)

    handle.stop()
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1)
  })

  it('reads SCHEDULER_ENABLED from env (default true when unset)', async () => {
    const { deps } = makeDeps([T1])
    const prev = process.env.SCHEDULER_ENABLED
    try {
      delete process.env.SCHEDULER_ENABLED
      const spyOn = vi.fn(() => 1 as unknown as NodeJS.Timeout)
      const h1 = startScheduler(deps, { setIntervalImpl: spyOn as unknown as typeof setInterval })
      expect(h1.enabled).toBe(true)
      expect(spyOn).toHaveBeenCalledTimes(1)
      h1.stop()

      process.env.SCHEDULER_ENABLED = 'false'
      const spyOff = vi.fn(() => 2 as unknown as NodeJS.Timeout)
      const h2 = startScheduler(deps, { setIntervalImpl: spyOff as unknown as typeof setInterval })
      expect(h2.enabled).toBe(false)
      expect(spyOff).not.toHaveBeenCalled()
      h2.stop()
    } finally {
      if (prev === undefined) delete process.env.SCHEDULER_ENABLED
      else process.env.SCHEDULER_ENABLED = prev
    }
  })
})

describe('per-service scheduler kill-switch (H4)', () => {
  // Per-service override for THIS leaf. Precedence: per-service (when set to a
  // non-empty value) wins over the shared SCHEDULER_ENABLED; an unset or empty
  // per-service value falls through to the shared flag (back-compat).
  const PER_SERVICE = 'NEWSLETTER_SCHEDULER_ENABLED'

  function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
    const keys = Object.keys(vars)
    const prev: Record<string, string | undefined> = {}
    for (const k of keys) prev[k] = process.env[k]
    try {
      for (const k of keys) {
        const v = vars[k]
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
      fn()
    } finally {
      for (const k of keys) {
        if (prev[k] === undefined) delete process.env[k]
        else process.env[k] = prev[k]
      }
    }
  }

  /** Resolve enabled purely from env by starting a scheduler with a spy interval. */
  function enabledFromEnv(): boolean {
    const { deps } = makeDeps([T1])
    const spy = vi.fn(() => 1 as unknown as NodeJS.Timeout)
    const handle = startScheduler(deps, { setIntervalImpl: spy as unknown as typeof setInterval })
    handle.stop()
    return handle.enabled
  }

  it("per-service='false' disables this leaf even when SCHEDULER_ENABLED='true'", () => {
    withEnv({ [PER_SERVICE]: 'false', SCHEDULER_ENABLED: 'true' }, () => {
      expect(enabledFromEnv()).toBe(false)
    })
  })

  it("per-service='false' disables this leaf even when SCHEDULER_ENABLED is unset", () => {
    withEnv({ [PER_SERVICE]: 'false', SCHEDULER_ENABLED: undefined }, () => {
      expect(enabledFromEnv()).toBe(false)
    })
  })

  it('ALL scheduler vars unset → enabled=true (byte-identity with the base)', () => {
    withEnv({ [PER_SERVICE]: undefined, SCHEDULER_ENABLED: undefined }, () => {
      expect(enabledFromEnv()).toBe(true)
    })
  })

  it("shared SCHEDULER_ENABLED='false' + per-service unset → held (back-compat)", () => {
    withEnv({ [PER_SERVICE]: undefined, SCHEDULER_ENABLED: 'false' }, () => {
      expect(enabledFromEnv()).toBe(false)
    })
  })

  it("per-service='' (compose empty default) counts as unset → shared applies (still held)", () => {
    withEnv({ [PER_SERVICE]: '', SCHEDULER_ENABLED: 'false' }, () => {
      expect(enabledFromEnv()).toBe(false)
    })
  })

  it("per-service='true' re-enables this leaf even when shared SCHEDULER_ENABLED='false'", () => {
    withEnv({ [PER_SERVICE]: 'true', SCHEDULER_ENABLED: 'false' }, () => {
      expect(enabledFromEnv()).toBe(true)
    })
  })
})
