import { describe, expect, it, vi } from 'vitest'
import type { DbProfile } from '@gremion/db'
import { createTenantStore } from './store.js'
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

  it('evicts the least recently used pool and ends it', async () => {
    const f = fakeFactory()
    const store = createTenantStore({ resolveTarget, createDb: f.createDb, maxPools: 2 })
    await store.openTenantDb(A, 'calendar')
    await store.openTenantDb(A, 'finance')
    await store.openTenantDb(A, 'calendar') // touch: finance is now the LRU
    await store.openTenantDb(B, 'calendar')
    expect(store.size()).toBe(2)
    expect(f.made[1]?.end).toHaveBeenCalledTimes(1)
    expect(f.made[0]?.end).not.toHaveBeenCalled()
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
