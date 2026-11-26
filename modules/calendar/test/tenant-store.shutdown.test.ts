/**
 * tenant-store shutdown: every pool the leaf holds is ended, reported, and never re-opened behind the drain.
 *
 * The leaf holds two kinds of pool: the customer pools (opened through the package store, which owns their
 * capacity bound and eviction: packages/tenant-store/src/store.test.ts) and the control-DB pool (never
 * evicted, always present in a running leaf). closeAllPools is the SIGTERM drain; it must
 *   - end both kinds and count them,
 *   - report a rejecting end() as a FAILURE instead of a clean shutdown,
 *   - latch: a request that lands after the drain is refused (ShuttingDownError), never given a pool that
 *     nothing would ever close.
 *
 * PG-free: `postgres` and the package store are the stand-ins of support/fake-lifecycle-store.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('postgres', async () => ({ default: (await import('./support/fake-lifecycle-store.ts')).fakePostgres }))
vi.mock('@gremion/tenant-store', async (importOriginal) =>
  (await import('./support/fake-lifecycle-store.ts')).fakeTenantStorePackage(await importOriginal<object>()),
)
import { fake as h, resetFake } from './support/fake-lifecycle-store.ts'

const { closeAllPools, listTenants, requireRuntimePgUrl, ShuttingDownError, storeFor, _resetTenantStoreForTests } =
  await import('../src/tenant-store.ts')

const OPTS = {
  // Never port 5432 - that is the LIVE Postgres on the staging host. The driver is mocked anyway.
  pgUrl: 'postgres://u:p@127.0.0.1:59999/postgres',
  dbPrefix: 'calendar_test_',
  moduleUrl: 'postgres://m_calendar_app:p@127.0.0.1:59999/postgres',
} as const

const A = { id: '01920000-0000-7000-8000-0000000000a1', slug: 'down-a' }
const B = { id: '01920000-0000-7000-8000-0000000000b1', slug: 'down-b' }

let log: ReturnType<typeof vi.spyOn>
let err: ReturnType<typeof vi.spyOn>

beforeEach(async () => {
  await _resetTenantStoreForTests()
  resetFake()
  log = vi.spyOn(console, 'log').mockImplementation(() => {})
  err = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(async () => {
  await _resetTenantStoreForTests()
  log.mockRestore()
  err.mockRestore()
})

describe('requireRuntimePgUrl — an explicit empty string is a misconfiguration', () => {
  it('refuses an explicitly-passed empty url instead of falling through to the env', () => {
    const ENV = 'T05R4_PROBE_PG_URL'
    process.env[ENV] = 'postgres://should-not-be-reached/db'
    try {
      expect(
        () => requireRuntimePgUrl('', ENV),
        'explicit || process.env[...] silently swaps a caller-supplied empty string for the ' +
          'ambient env value — the caller asked for THAT endpoint and got a different one',
      ).toThrow(/no Postgres URL configured/)
    } finally {
      delete process.env[ENV]
    }
  })

  it('refuses an unset env and names it, with no localhost fallback', () => {
    expect(() => requireRuntimePgUrl(undefined, 'T05R4_UNSET_PG_URL')).toThrow(/T05R4_UNSET_PG_URL/)
  })
})

describe('closeAllPools — every pool is a pool', () => {
  it('ends the customer pools through the package store and the control pool, and counts them', async () => {
    await storeFor(A, OPTS)
    await storeFor(B, OPTS)
    const endedBefore = h.ended

    const counts = await closeAllPools()

    expect(h.storeClosed, 'the package store owns the customer pools: closing it ends them').toBe(1)
    expect(h.ended - endedBefore, 'the control pool is the one pool every leaf is guaranteed to hold').toBe(1)
    expect(counts).toEqual({ live: 2, evicted: 0, control: 1, failed: 0 })
  })

  it('reports a rejecting end() of the control pool and a rejecting close of the package store as FAILURES', async () => {
    await storeFor(A, OPTS)
    h.endRejects = true
    h.storeCloseRejects = true

    const counts = await closeAllPools()

    expect(counts.failed, 'a swallowed rejection is a leaked pool reported as a clean shutdown').toBe(2)
    expect(counts.control).toBe(1)
  })

  it('counts zero pools when the leaf never opened any', async () => {
    const counts = await closeAllPools()
    expect(counts).toEqual({ live: 0, evicted: 0, control: 0, failed: 0 })
  })
})

describe('closeAllPools — the store stays closed afterwards', () => {
  it('refuses storeFor() with ShuttingDownError once the pools are gone', async () => {
    await closeAllPools()
    await expect(
      storeFor(A, OPTS),
      'an in-flight request that lands after the drain re-opened a pool the shutdown had ' +
        'just closed, and nothing would ever close THAT one',
    ).rejects.toBeInstanceOf(ShuttingDownError)
    expect(h.storeOpens).toEqual([])
  })

  it('refuses the catalogue pool (listTenants) with ShuttingDownError once the pools are gone', async () => {
    await closeAllPools()
    await expect(
      listTenants(OPTS),
      'the control pool re-opens itself on demand: without this guard the drain ends it and ' +
        'the next listTenants() opens a replacement seconds before process.exit()',
    ).rejects.toBeInstanceOf(ShuttingDownError)
  })

  it('names the leaf state in the error so the log is diagnosable', async () => {
    await closeAllPools()
    const e = await storeFor(A, OPTS).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(ShuttingDownError)
    expect((e as Error).message).toMatch(/shutting down/i)
  })

  it('the test reset clears the latch', async () => {
    await closeAllPools()
    await _resetTenantStoreForTests()
    await expect(storeFor(A, OPTS)).resolves.toBeDefined()
  })
})
