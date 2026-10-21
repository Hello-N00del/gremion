import { describe, expect, it, vi } from 'vitest'
import type { DbProfile } from '@gremion/db'
import { createTenantStore, openMigrationDb } from './store.js'
import { tenantModuleDbName } from './names.js'

const A = '01928f4e-8c3b-7a51-9d2e-3f4a5b6c7d8e'
const B = '01928f4e-8c3b-7a51-9d2e-3f4a5b6c7d8f'

function fakeFactory() {
  const made: { profile: DbProfile; end: ReturnType<typeof vi.fn> }[] = []
  const createDb = (profile: DbProfile) => {
    const end = vi.fn(async () => {})
    made.push({ profile, end })
    return { end, profile } as never
  }
  return { made, createDb }
}

const resolveTarget = (t: string, m: string) => ({ url: `postgres://u@h/${tenantModuleDbName(t, m)}` })

describe('createTenantStore().openTenantDb', () => {
  it('keys the pool on (tenant, module): same pair same pool, any other pair a new one', async () => {
    const f = fakeFactory()
    const store = createTenantStore({ resolveTarget, createDb: f.createDb })
    const a1 = await store.openTenantDb(A, 'calendar')
    expect(await store.openTenantDb(A, 'calendar')).toBe(a1)
    const a2 = await store.openTenantDb(A, 'finance')
    const b1 = await store.openTenantDb(B, 'calendar')
    expect(new Set([a1, a2, b1]).size).toBe(3)
    expect(f.made.map((m) => new URL(m.profile.url).pathname)).toEqual([
      `/${tenantModuleDbName(A, 'calendar')}`,
      `/${tenantModuleDbName(A, 'finance')}`,
      `/${tenantModuleDbName(B, 'calendar')}`,
    ])
  })

  it('opens runtime pools with prepare:false (Q3: pooler-safe)', async () => {
    const f = fakeFactory()
    const store = createTenantStore({ resolveTarget, createDb: f.createDb })
    await store.openTenantDb(A, 'calendar')
    expect(f.made[0]?.profile.prepare).toBe(false)
  })

  it('evicts the least recently used pool, and ends it only after the grace (a caller may still hold it)', async () => {
    vi.useFakeTimers()
    try {
      const f = fakeFactory()
      const store = createTenantStore({ resolveTarget, createDb: f.createDb, maxPools: 2, evictGraceMs: 1000 })
      await store.openTenantDb(A, 'calendar')
      await store.openTenantDb(A, 'finance')
      await store.openTenantDb(A, 'calendar') // touch: finance is now the LRU
      await store.openTenantDb(B, 'calendar')
      expect(store.size()).toBe(2)
      expect(f.made[1]?.end).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1000)
      expect(f.made[1]?.end).toHaveBeenCalledTimes(1)
      expect(f.made[0]?.end).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('evictTenantDb retires one pair: the next open resolves afresh (a rotated secret), the old pool ends after the grace and is never handed out again', async () => {
    vi.useFakeTimers()
    try {
      const f = fakeFactory()
      let pw = 'old'
      const rotating = (t: string, m: string) => ({ url: `postgres://u:${pw}@h/${tenantModuleDbName(t, m)}` })
      const store = createTenantStore({ resolveTarget: rotating, createDb: f.createDb, evictGraceMs: 1000 })
      const first = await store.openTenantDb(A, 'kernel')
      const other = await store.openTenantDb(B, 'kernel')
      pw = 'new'
      expect(await store.openTenantDb(A, 'kernel')).toBe(first) // cached: the rotation is not seen
      expect(store.evictTenantDb(A, 'kernel')).toBe(true)
      expect(store.evictTenantDb(A, 'kernel')).toBe(false)
      const second = await store.openTenantDb(A, 'kernel')
      expect(second).not.toBe(first)
      expect(f.made[2]!.profile.url).toContain(':new@')
      expect(await store.openTenantDb(B, 'kernel')).toBe(other) // only the named pair
      expect(f.made[0]!.end).not.toHaveBeenCalled() // a caller may still hold it
      await vi.advanceTimersByTimeAsync(1001)
      expect(f.made[0]!.end).toHaveBeenCalledTimes(1)
      await store.close()
      expect(f.made[0]!.end).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('close() ends a retired pool still in its grace', async () => {
    const f = fakeFactory()
    const store = createTenantStore({ resolveTarget, createDb: f.createDb, evictGraceMs: 60_000 })
    await store.openTenantDb(A, 'kernel')
    store.evictTenantDb(A, 'kernel')
    await store.close()
    expect(f.made[0]!.end).toHaveBeenCalledTimes(1)
  })

  it('a pair requested again during its grace gets its draining pool back, not a second pool', async () => {
    const f = fakeFactory()
    const store = createTenantStore({ resolveTarget, createDb: f.createDb, maxPools: 1, evictGraceMs: 60_000 })
    const a = await store.openTenantDb(A, 'calendar')
    await store.openTenantDb(B, 'calendar') // evicts A (draining)
    expect(await store.openTenantDb(A, 'calendar')).toBe(a) // back; evicts B
    expect(f.made).toHaveLength(2)
    await store.close()
  })

  it('caps the draining pools at maxPools, ending the oldest early', async () => {
    const f = fakeFactory()
    const store = createTenantStore({ resolveTarget, createDb: f.createDb, maxPools: 1, evictGraceMs: 60_000 })
    await store.openTenantDb(A, 'calendar')
    await store.openTenantDb(A, 'finance') // A/calendar draining
    await store.openTenantDb(B, 'calendar') // A/finance draining; A/calendar ended early
    expect(f.made.map((m) => m.end.mock.calls.length)).toEqual([1, 0, 0])
    await store.close()
  })

  it('close() also ends a pool still in its eviction grace', async () => {
    const f = fakeFactory()
    const store = createTenantStore({ resolveTarget, createDb: f.createDb, maxPools: 1, evictGraceMs: 60_000 })
    await store.openTenantDb(A, 'calendar')
    await store.openTenantDb(B, 'calendar')
    await store.close()
    expect(f.made.map((m) => m.end.mock.calls.length)).toEqual([1, 1])
  })

  it.each([['maxConnections', 0], ['maxPools', 0], ['drainSeconds', -1], ['evictGraceMs', 1.5]])('refuses %s = %s', (k, v) => {
    expect(() => createTenantStore({ resolveTarget, [k]: v })).toThrow(new RegExp(k))
  })

  it('shares one in-flight open between concurrent callers of the same pair', async () => {
    const f = fakeFactory()
    const slow = async (t: string, m: string) => {
      await new Promise((r) => setTimeout(r, 10))
      return resolveTarget(t, m)
    }
    const store = createTenantStore({ resolveTarget: slow, createDb: f.createDb })
    const [x, y] = await Promise.all([store.openTenantDb(A, 'calendar'), store.openTenantDb(A, 'calendar')])
    expect(x).toBe(y)
    expect(f.made).toHaveLength(1)
  })

  it('refuses a resolver answer that names another database, and pools nothing', async () => {
    const f = fakeFactory()
    const wrong = () => ({ url: `postgres://u@h/${tenantModuleDbName(B, 'calendar')}` })
    const store = createTenantStore({ resolveTarget: wrong, createDb: f.createDb })
    await expect(store.openTenantDb(A, 'calendar')).rejects.toThrow(/does not name database/)
    expect(f.made).toHaveLength(0)
    expect(store.size()).toBe(0)
  })

  it('validates both ids before calling the resolver', async () => {
    const r = vi.fn(resolveTarget)
    const store = createTenantStore({ resolveTarget: r, createDb: fakeFactory().createDb })
    await expect(store.openTenantDb('x', 'calendar')).rejects.toThrow(/tenant id/)
    await expect(store.openTenantDb(A, 'Cal')).rejects.toThrow(/module id/)
    expect(r).not.toHaveBeenCalled()
  })

  it('does not cache a failed open: the next call retries', async () => {
    const f = fakeFactory()
    let n = 0
    const flaky = (t: string, m: string) => {
      if (n++ === 0) throw new Error('registry down')
      return resolveTarget(t, m)
    }
    const store = createTenantStore({ resolveTarget: flaky, createDb: f.createDb })
    await expect(store.openTenantDb(A, 'calendar')).rejects.toThrow(/registry down/)
    await expect(store.openTenantDb(A, 'calendar')).resolves.toBeDefined()
  })

  it('close() ends every pool and empties the store', async () => {
    const f = fakeFactory()
    const store = createTenantStore({ resolveTarget, createDb: f.createDb })
    await store.openTenantDb(A, 'calendar')
    await store.openTenantDb(B, 'calendar')
    await store.close()
    expect(f.made.every((m) => m.end.mock.calls.length === 1)).toBe(true)
    expect(store.size()).toBe(0)
  })

  it('refuses to open after close(), including an open that was in flight', async () => {
    const f = fakeFactory()
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const slow = async (t: string, m: string) => {
      await gate
      return resolveTarget(t, m)
    }
    const store = createTenantStore({ resolveTarget: slow, createDb: f.createDb })
    const inflight = store.openTenantDb(A, 'calendar')
    await store.close()
    release()
    await expect(inflight).rejects.toThrow(/closed/)
    await expect(store.openTenantDb(A, 'calendar')).rejects.toThrow(/closed/)
    expect(f.made).toHaveLength(0)
  })
})

describe('openMigrationDb', () => {
  it('opens a direct, unpooled connection (max 2, prepared statements on) to exactly the pair\'s database', async () => {
    const f = fakeFactory()
    await openMigrationDb(A, 'calendar', { resolveTarget, createDb: f.createDb })
    expect(f.made[0]?.profile).toEqual({ url: `postgres://u@h/${tenantModuleDbName(A, 'calendar')}`, max: 2, prepare: true })
  })

  it('refuses a resolver answer naming another database', async () => {
    const wrong = () => ({ url: `postgres://u@h/${tenantModuleDbName(B, 'calendar')}` })
    await expect(openMigrationDb(A, 'calendar', { resolveTarget: wrong, createDb: fakeFactory().createDb })).rejects.toThrow(/does not name database/)
  })
})
