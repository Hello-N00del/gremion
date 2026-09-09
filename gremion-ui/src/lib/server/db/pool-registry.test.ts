import { describe, it, expect, vi, beforeEach } from 'vitest'

const { createDbSpy, ends } = vi.hoisted(() => {
  const ends: Array<ReturnType<typeof vi.fn>> = []
  const createDbSpy = vi.fn(() => {
    const end = vi.fn(() => Promise.resolve())
    ends.push(end)
    return { end, __id: ends.length } as unknown as import('@gremion/db').Sql
  })
  return { createDbSpy, ends }
})
vi.mock('@gremion/db', () => ({ createDb: createDbSpy }))

import {
  getPoolForTenant, evictTenantPool, _resetPoolRegistryForTests, POOL_REGISTRY_MAX,
  EVICTED_POOL_DRAIN_GRACE_MS,
} from './pool-registry'

const ctx = (id: string) => ({ id, dbUrl: `postgres://${id}`, dbMax: 3, dbPrepare: true })

describe('pool-registry', () => {
  beforeEach(() => { _resetPoolRegistryForTests(); createDbSpy.mockClear(); ends.length = 0 })

  it('returns the SAME pool for the same canonical tenant id', () => {
    const a = getPoolForTenant(ctx('default'))
    const b = getPoolForTenant(ctx('default'))
    expect(a).toBe(b)
    expect(createDbSpy).toHaveBeenCalledTimes(1)
    expect(createDbSpy).toHaveBeenCalledWith({ url: 'postgres://default', max: 3, prepare: true })
  })
  it('returns DISTINCT pools for distinct tenant ids', () => {
    expect(getPoolForTenant(ctx('default'))).not.toBe(getPoolForTenant(ctx('t2')))
    expect(createDbSpy).toHaveBeenCalledTimes(2)
  })
  it('drains an evicted pool (dispose fires sql.end())', async () => {
    getPoolForTenant(ctx('default'))
    expect(ends[0]).not.toHaveBeenCalled()
    evictTenantPool('default')
    expect(ends[0]).toHaveBeenCalledTimes(1)
    await Promise.resolve()
  })
  // #256-4 (P2.1b T8): EXPLICIT eviction (tenant suspend/delete via
  // evictTenantRuntime) drains immediately — the tenant is being shut off, no
  // in-flight work deserves a grace period. CAPACITY (LRU) eviction is
  // different: a burst of other tenants can evict a pool whose owner still
  // has queries (or a 30s-cached resolution context) in flight — that drain
  // is DEFERRED by a grace period and logged loudly.
  it('#256-4: explicit eviction drains immediately and does NOT warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      getPoolForTenant(ctx('default'))
      evictTenantPool('default')
      expect(ends[0]).toHaveBeenCalledTimes(1)
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
  it('#256-4: capacity (LRU) eviction defers the drain by the grace period + warns loudly', () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      for (let i = 0; i <= POOL_REGISTRY_MAX; i++) getPoolForTenant(ctx(`t${i}`))
      expect(createDbSpy).toHaveBeenCalledTimes(POOL_REGISTRY_MAX + 1)
      // The LRU pool (t0) was capacity-evicted but is NOT drained immediately…
      expect(ends[0]).not.toHaveBeenCalled()
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0][0])).toMatch(/capacity/i)
      // …only after the grace period elapses.
      vi.advanceTimersByTime(EVICTED_POOL_DRAIN_GRACE_MS - 1)
      expect(ends[0]).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(ends[0]).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
      vi.useRealTimers()
    }
  })
})

import { DEFAULT_DB_MAX, ADMIN_RESERVE, MAX_CONNECTIONS, TENANT_DB_MAX_LIMIT } from './pool-registry'
import { RESOLUTION_CACHE_TTL_MS } from '../tenant/registry'

describe('connection budget (P2.1a acceptance)', () => {
  it('worst-case live pools + admin reserve fit the per-instance max_connections', () => {
    // The LRU caps live per-tenant pools at POOL_REGISTRY_MAX, each up to
    // DEFAULT_DB_MAX connections; plus a reserve for the control pool + KC admin.
    expect(POOL_REGISTRY_MAX * DEFAULT_DB_MAX + ADMIN_RESERVE).toBeLessThanOrEqual(MAX_CONNECTIONS)
  })
  // P2.1b T11: getPoolForTenant sizes pools from the operator-controlled
  // per-tenant dbMax, NOT DEFAULT_DB_MAX — so the budget only holds if the
  // registry-write clamp (clampConnProfile) bounds every persisted value by
  // TENANT_DB_MAX_LIMIT. These assertions catch a future POOL_REGISTRY_MAX /
  // ADMIN_RESERVE / MAX_CONNECTIONS change that would break the derivation.
  it('T11: the WRITE-clamp limit keeps the true worst case (every slot at the limit) within budget', () => {
    expect(POOL_REGISTRY_MAX * TENANT_DB_MAX_LIMIT + ADMIN_RESERVE).toBeLessThanOrEqual(MAX_CONNECTIONS)
  })
  it('T11: the clamp limit admits the default pool size (tenant #1 profile never clamps)', () => {
    expect(TENANT_DB_MAX_LIMIT).toBeGreaterThanOrEqual(DEFAULT_DB_MAX)
  })

  // INVARIANT (#256-4 cross-module pin): a resolution-cached TenantContext
  // must NEVER outlive its capacity-evicted pool's drain grace. The cache
  // hands out a context (holding a pool reference) for up to
  // RESOLUTION_CACHE_TTL_MS; if the LRU capacity-evicts that pool, the
  // deferred drain must cover the WHOLE window in which such a stale context
  // may still query — so EVICTED_POOL_DRAIN_GRACE_MS >= RESOLUTION_CACHE_TTL_MS.
  // Both constants are 30s today by design; this assertion makes a future
  // drift (e.g. shortening the grace or lengthening the cache TTL) fail at
  // unit-test time instead of as a yanked-connection error in prod.
  it('cached-context window: EVICTED_POOL_DRAIN_GRACE_MS covers RESOLUTION_CACHE_TTL_MS', () => {
    expect(EVICTED_POOL_DRAIN_GRACE_MS).toBeGreaterThanOrEqual(RESOLUTION_CACHE_TTL_MS)
  })
})
