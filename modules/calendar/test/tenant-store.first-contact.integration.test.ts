/**
 * Integration test: first contact of a customer is safe under concurrency.
 *
 * The leaf opens a customer's lifecycle database t_<hex32>__calendar on first contact (storeFor) and
 * creates exactly one database of its own: the catalogue database. Two requests that arrive together
 * for a customer the leaf has never seen must both be served; the same race exists between two
 * PROCESSES (an old and a new colour starting together, or two replicas), which no in-process guard
 * can see: that case is simulated here with two independent loads of the module. The race for the
 * catalogue database's creation (calendar_fc_test_control) is the one the old CREATE DATABASE race
 * moved to.
 *
 * A customer whose database does not exist is refused (404 not provisioned) and nothing is created.
 *
 * Runs against CALENDAR_TEST_PG_URL (a throwaway Postgres on a non-5432 port) and only ever touches
 * the catalogue database calendar_fc_test_control and the lifecycle databases of fixture tenants.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import postgres from 'postgres'
import type * as TenantStore from '../src/tenant-store.ts'
import { requireEphemeralTestPgUrl, assertSafeTestEnv } from './support/pg-test-guard.ts'
import { FIXTURE_DB_PATTERN, fixtureDb, fixtureId, provisionLifecycleDbs } from './support/scratch-pg.ts'

const TEST_PG_URL = requireEphemeralTestPgUrl()
const TEST_DB_PREFIX = 'calendar_fc_test_'
assertSafeTestEnv(TEST_PG_URL, TEST_DB_PREFIX)

const PARALLEL = 8
const options = { pgUrl: TEST_PG_URL, dbPrefix: TEST_DB_PREFIX, moduleUrl: TEST_PG_URL }

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
  const last12 = randomBytes(6).toString('hex')
  return { id: fixtureId(last12), slug: 'fc-' + last12.slice(0, 8) }
}

async function dropTestDbs(): Promise<void> {
  const rows = await admin<{ datname: string }[]>`
    SELECT datname FROM pg_database WHERE datname LIKE 'calendar\\_fc\\_test\\_%' OR datname ~ ${FIXTURE_DB_PATTERN}
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
  return results.flatMap((r) => (r.status === 'rejected' ? [r.reason instanceof Error ? r.reason.message : JSON.stringify(r.reason)] : []))
}

describe('first contact under concurrency (integration)', () => {
  it('parallel first requests for ONE provisioned customer all succeed and share one pool; the leaf creates only the catalogue database', async () => {
    const store = await freshInstance()
    const t = tenant()
    await provisionLifecycleDbs(TEST_PG_URL, [t.id])
    const dbsBefore = await countDatabases(fixtureDb(t.id))
    const results = await Promise.allSettled(Array.from({ length: PARALLEL }, () => store.storeFor(t, options)))
    expect(rejections(results)).toEqual([])
    const pools = results.map((r) => (r as PromiseFulfilledResult<unknown>).value)
    expect(new Set(pools).size).toBe(1)

    expect(dbsBefore).toBe(1)
    expect(await countDatabases(fixtureDb(t.id))).toBe(1)
    expect(await countDatabases(TEST_DB_PREFIX + t.slug)).toBe(0)
    expect(await countDatabases(TEST_DB_PREFIX + 'control')).toBe(1)
    const catalogued = await store.listTenants(options)
    expect(catalogued.filter((r) => r.id === t.id)).toHaveLength(1)
  })

  it('two processes (two module instances) racing on the same fresh customer both succeed', async () => {
    const a = await freshInstance()
    const b = await freshInstance()
    const t = tenant()
    await provisionLifecycleDbs(TEST_PG_URL, [t.id])
    const results = await Promise.allSettled([
      ...Array.from({ length: PARALLEL / 2 }, () => a.storeFor(t, options)),
      ...Array.from({ length: PARALLEL / 2 }, () => b.storeFor(t, options)),
    ])
    expect(rejections(results)).toEqual([])
    expect(await countDatabases(fixtureDb(t.id))).toBe(1)
    expect(await countDatabases(TEST_DB_PREFIX + 'control')).toBe(1)
  })

  it('parallel first requests for DIFFERENT customers all succeed', async () => {
    const store = await freshInstance()
    const tenants = Array.from({ length: PARALLEL }, () => tenant())
    await provisionLifecycleDbs(TEST_PG_URL, tenants.map((t) => t.id))
    const results = await Promise.allSettled(tenants.map((t) => store.storeFor(t, options)))
    expect(rejections(results)).toEqual([])
    for (const t of tenants) expect(await countDatabases(fixtureDb(t.id))).toBe(1)
  })

  it('a customer whose lifecycle database does not exist is refused as not provisioned, in every racing call, and nothing is created for it', async () => {
    const a = await freshInstance()
    const b = await freshInstance()
    const t = tenant()
    const results = await Promise.allSettled([
      ...Array.from({ length: PARALLEL / 2 }, () => a.storeFor(t, options)),
      ...Array.from({ length: PARALLEL / 2 }, () => b.storeFor(t, options)),
    ])
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    expect(refused).toHaveLength(PARALLEL)
    for (const r of refused) expect(r.reason).toMatchObject({ code: 'TENANT_NOT_PROVISIONED' })
    expect(await countDatabases(fixtureDb(t.id))).toBe(0)
    expect(await countDatabases(TEST_DB_PREFIX + t.slug)).toBe(0)
    // a refused tenant is not in the catalogue
    expect((await a.listTenants(options)).filter((r) => r.id === t.id)).toEqual([])
  })
})
