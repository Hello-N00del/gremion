/**
 * Integration test: first contact of a customer is safe under concurrency.
 *
 * The leaf creates a customer's database on first contact (storeFor). Two requests that arrive
 * together for a customer the leaf has never seen both used to run CREATE DATABASE; the loser died
 * with 23505 on pg_database_datname_index and the caller got a 500. The same race exists between
 * two PROCESSES (an old and a new colour starting together, or two replicas), which no in-process
 * guard can see: that case is simulated here with two independent loads of the module.
 *
 * Runs against CONTENT_TEST_PG_URL (a throwaway Postgres on a non-5432 port) and only ever
 * touches databases named content_test_*; the shared content_test_control is dropped and
 * re-created by the first contact itself (that creation races too).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import type * as TenantStore from '../src/tenant-store.ts'
import { requireEphemeralTestPgUrl, assertSafeTestEnv } from './support/pg-test-guard.ts'

const TEST_PG_URL = requireEphemeralTestPgUrl()
const TEST_DB_PREFIX = 'content_test_'
assertSafeTestEnv(TEST_PG_URL, TEST_DB_PREFIX)

const PARALLEL = 8
const options = { pgUrl: TEST_PG_URL, dbPrefix: TEST_DB_PREFIX }

let admin: ReturnType<typeof postgres>
/** Every module instance a test loaded, so the pools of all of them are drained afterwards. */
const loaded: (typeof TenantStore)[] = []

async function freshInstance(): Promise<typeof TenantStore> {
  vi.resetModules()
  const mod = (await import('../src/tenant-store.ts')) as typeof TenantStore
  loaded.push(mod)
  return mod
}

function tenant(): TenantStore.TenantRef {
  return { id: randomUUID(), slug: 'fc-' + randomUUID().slice(0, 8) }
}

async function dropTestDbs(): Promise<void> {
  const rows = await admin<{ datname: string }[]>`
    SELECT datname FROM pg_database WHERE datname LIKE 'content\\_test\\_%'
  `
  for (const { datname } of rows) {
    await admin.unsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${datname}' AND pid <> pg_backend_pid()`,
    )
    await admin.unsafe(`DROP DATABASE IF EXISTS "${datname}"`)
  }
}

async function drainLoaded(): Promise<void> {
  for (const mod of loaded.splice(0)) await mod._resetTenantStoreForTests()
}

async function countDatabases(name: string): Promise<number> {
  const rows = await admin<{ n: string }[]>`SELECT count(*) AS n FROM pg_database WHERE datname = ${name}`
  return Number(rows[0].n)
}

beforeAll(async () => {
  admin = postgres(TEST_PG_URL, { max: 1, prepare: false })
  await dropTestDbs()
})

beforeEach(async () => {
  await drainLoaded()
  await dropTestDbs()
})

afterAll(async () => {
  await drainLoaded()
  await dropTestDbs()
  await admin.end()
})

/** What a request sees: the reasons of every rejected call (empty when all succeeded). */
function rejections(results: PromiseSettledResult<unknown>[]): string[] {
  return results.flatMap((r) => (r.status === 'rejected' ? [String((r.reason as Error)?.message ?? r.reason)] : []))
}

describe('first contact under concurrency (integration)', () => {
  it('parallel first requests for ONE customer all succeed and create one database', async () => {
    const store = await freshInstance()
    const t = tenant()
    const results = await Promise.allSettled(
      Array.from({ length: PARALLEL }, () => store.storeFor(t, options)),
    )
    expect(rejections(results)).toEqual([])
    const pools = results.map((r) => (r as PromiseFulfilledResult<unknown>).value)
    expect(new Set(pools).size).toBe(1)

    expect(await countDatabases(TEST_DB_PREFIX + t.slug)).toBe(1)
    const u = new URL(TEST_PG_URL)
    u.pathname = '/' + TEST_DB_PREFIX + t.slug
    const tenantDb = postgres(u.toString(), { max: 1 })
    try {
      const tables = await tenantDb<{ n: string }[]>`
        SELECT count(*) AS n FROM information_schema.tables WHERE table_schema = 'public'
      `
      expect(Number(tables[0].n)).toBeGreaterThan(0)
    } finally {
      await tenantDb.end()
    }
    const catalogued = await store.listTenants(options)
    expect(catalogued.filter((r) => r.id === t.id)).toHaveLength(1)
  })

  it('two processes (two module instances) racing on the same fresh customer both succeed', async () => {
    const a = await freshInstance()
    const b = await freshInstance()
    const t = tenant()
    const results = await Promise.allSettled([
      ...Array.from({ length: PARALLEL / 2 }, () => a.storeFor(t, options)),
      ...Array.from({ length: PARALLEL / 2 }, () => b.storeFor(t, options)),
    ])
    expect(rejections(results)).toEqual([])
    expect(await countDatabases(TEST_DB_PREFIX + t.slug)).toBe(1)
    expect(await countDatabases(TEST_DB_PREFIX + 'control')).toBe(1)
  })

  it('parallel first requests for DIFFERENT customers all succeed', async () => {
    const store = await freshInstance()
    const tenants = Array.from({ length: PARALLEL }, () => tenant())
    const results = await Promise.allSettled(tenants.map((t) => store.storeFor(t, options)))
    expect(rejections(results)).toEqual([])
    for (const t of tenants) expect(await countDatabases(TEST_DB_PREFIX + t.slug)).toBe(1)
  })
})
