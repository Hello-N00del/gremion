// The location flag reader: where does THIS customer's board live (kernel, moving, module)?
//
// Contract for the next release (the reader is the only thing two running copies of the app share):
// it depends on nothing but the one table `board_location` of the customer's own database, the
// 5 second cache and the 300 second rule for a stale 'moving'. The age of 'moving' is computed by
// the database (now() - changed_at), the same clock the move's own checks use, never by this
// process. A copy built from an older release cannot be started next to this one in a test, so the
// tests below pin exactly those three things and nothing else.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const state = vi.hoisted(() => ({
  tenant: 'tenant-a',
  queries: [] as string[],
  // one scripted answer per query: rows, or an Error to reject with
  script: [] as Array<unknown[] | Error>,
  fallback: [] as unknown[],
}))

vi.mock('$lib/server/tenant/context', () => ({
  currentTenantId: () => {
    if (state.tenant === '') throw new Error('no tenant context')
    return state.tenant
  },
}))
vi.mock('$lib/server/db', () => ({
  getDb: () => async (strings: TemplateStringsArray) => {
    state.queries.push(strings.join('?'))
    const next = state.script.shift()
    if (next instanceof Error) throw next
    return next ?? state.fallback
  },
}))

import {
  getBoardLocation,
  resetBoardLocationCacheForTests,
  BoardLocationUnreadableError,
  BoardUnavailableError,
  BOARD_LOCATION_CACHE_TTL_MS,
  BOARD_MOVE_STALE_S,
} from './location'

const row = (location: string, age_s = 1) => [{ location, age_s }]

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2030-01-01T00:00:00Z'))
  state.tenant = 'tenant-a'
  state.queries = []
  state.script = []
  state.fallback = []
  resetBoardLocationCacheForTests()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('the contract constants', () => {
  it('holds a read for 5 seconds and reads a moving row older than 300 seconds as kernel', () => {
    expect(BOARD_LOCATION_CACHE_TTL_MS).toBe(5000)
    expect(BOARD_MOVE_STALE_S).toBe(300)
  })
})

describe('getBoardLocation: what the row says', () => {
  it('a missing row is kernel', async () => {
    state.script = [[]]
    expect(await getBoardLocation()).toBe('kernel')
  })

  it.each(['kernel', 'module'])('reads %s as it is', async (loc) => {
    state.script = [row(loc)]
    expect(await getBoardLocation()).toBe(loc)
  })

  it('a young moving row is moving', async () => {
    state.script = [row('moving', 299.9)]
    expect(await getBoardLocation()).toBe('moving')
  })

  it('a moving row older than 300 seconds is kernel (a killed move must not refuse writes for ever)', async () => {
    state.script = [row('moving', 300.1)]
    expect(await getBoardLocation()).toBe('kernel')
  })

  it('the age is only ever applied to moving: an old module row stays module', async () => {
    state.script = [row('module', 99999)]
    expect(await getBoardLocation()).toBe('module')
  })

  it('reads one table, and measures the age on the database clock', async () => {
    state.script = [row('kernel')]
    await getBoardLocation()
    expect(state.queries).toHaveLength(1)
    const q = state.queries[0]!.replace(/\s+/g, ' ')
    expect(q).toMatch(/FROM board_location/i)
    expect(q).toMatch(/now\(\)\s*-\s*changed_at/i)
    expect(q.match(/\bFROM\b/gi)).toHaveLength(2) // FROM board_location, and extract(... FROM ...)
  })
})

describe('getBoardLocation: a flag that cannot be read is never guessed', () => {
  // guard: watched RED by catching the error and answering 'kernel'
  it('a query error (also a missing table) throws BoardLocationUnreadableError', async () => {
    const missingTable = Object.assign(new Error('relation "board_location" does not exist'), { code: '42P01' })
    state.script = [missingTable]
    await expect(getBoardLocation()).rejects.toBeInstanceOf(BoardLocationUnreadableError)
  })

  it('the unreadable error is a 503 with a German text and carries the cause', async () => {
    const cause = new Error('connection refused')
    state.script = [cause]
    const err = await getBoardLocation().catch((e) => e)
    expect(err).toBeInstanceOf(BoardUnavailableError)
    expect(err.status).toBe(503)
    expect(err.retryAfterSeconds).toBeGreaterThan(0)
    expect(err.message).toBe('Das Board ist momentan nicht verfügbar.')
    expect(err.cause).toBe(cause)
  })

  it('an unknown location value, or an unusable age, throws instead of picking a side', async () => {
    state.script = [row('elsewhere')]
    await expect(getBoardLocation()).rejects.toBeInstanceOf(BoardLocationUnreadableError)
    resetBoardLocationCacheForTests()
    state.script = [[{ location: 'moving', age_s: null }]]
    await expect(getBoardLocation()).rejects.toBeInstanceOf(BoardLocationUnreadableError)
  })

  it('no tenant context is an unreadable flag, not a default customer', async () => {
    state.tenant = ''
    await expect(getBoardLocation()).rejects.toBeInstanceOf(BoardLocationUnreadableError)
    expect(state.queries).toHaveLength(0)
  })

  it('a failed read is not cached: the next call reads again', async () => {
    state.script = [new Error('boom'), row('module')]
    await expect(getBoardLocation()).rejects.toBeInstanceOf(BoardLocationUnreadableError)
    expect(await getBoardLocation()).toBe('module')
    expect(state.queries).toHaveLength(2)
  })

  it('the log line carries no customer identity', async () => {
    state.script = [new Error('boom')]
    await getBoardLocation().catch(() => {})
    const logged = JSON.stringify((console.error as unknown as { mock: { calls: unknown[] } }).mock.calls)
    expect(logged).not.toContain('tenant-a')
  })
})

describe('getBoardLocation: the 5 second cache', () => {
  it('serves a repeat within 5 seconds from the cache and sees a flip after them', async () => {
    state.script = [row('kernel'), row('module')]
    expect(await getBoardLocation()).toBe('kernel')
    vi.advanceTimersByTime(BOARD_LOCATION_CACHE_TTL_MS - 1)
    expect(await getBoardLocation()).toBe('kernel')
    expect(state.queries).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(await getBoardLocation()).toBe('module')
    expect(state.queries).toHaveLength(2)
  })

  // guard: watched RED by a cache that is one global value
  it('two customers never share a cache entry', async () => {
    state.script = [row('module')]
    state.tenant = 'tenant-a'
    expect(await getBoardLocation()).toBe('module')
    state.script = [row('kernel')]
    state.tenant = 'tenant-b'
    expect(await getBoardLocation()).toBe('kernel')
    state.tenant = 'tenant-a'
    expect(await getBoardLocation()).toBe('module') // from its own entry, no third query
    expect(state.queries).toHaveLength(2)
  })

  it('concurrent first calls of one customer share one read', async () => {
    state.script = [row('module')]
    const all = await Promise.all([getBoardLocation(), getBoardLocation(), getBoardLocation()])
    expect(all).toEqual(['module', 'module', 'module'])
    expect(state.queries).toHaveLength(1)
  })

  it('the stale rule is decided at read time and held with the cache: a young moving stays moving for the TTL', async () => {
    state.script = [row('moving', 100), row('kernel')]
    expect(await getBoardLocation()).toBe('moving')
    vi.advanceTimersByTime(BOARD_LOCATION_CACHE_TTL_MS - 1)
    expect(await getBoardLocation()).toBe('moving')
  })
})
