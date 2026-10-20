/**
 * Integration tests for the admin teardown routes against a real Postgres
 * (follow-up to audit #534; the PG-free twin is admin-routes.teardown.test.ts).
 *
 * Runs against CONTENT_TEST_PG_URL (a local throwaway Postgres instance), with the
 * same fail-closed guard as the other destructive suites. Every database and
 * catalog row this file makes is named tear-*, and only those are ever dropped.
 *
 *  - dropping a tenant database while the leaf itself holds a pool for it works
 *    (the pool is ended first; before, the open connection blocked the drop);
 *  - the catalog row cannot be removed while the tenant database exists (409), and
 *    can once it is gone;
 *  - after a full teardown the old id is gone from the registry, and a NEW id on the
 *    same slug is bound to a fresh database, never to the old data.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import type { AddressInfo } from 'node:net'
import { createServer } from '../src/http/server.ts'
import { buildAdminRoutes } from '../src/http/admin-routes.ts'
import { buildApiRoutes } from '../src/http/routes.ts'
import { storeFor, _poolRegistryForTests, _resetTenantStoreForTests, type TenantRef } from '../src/tenant-store.ts'
import { requireEphemeralTestPgUrl, assertSafeTestEnv } from './support/pg-test-guard.ts'

const TEST_PG_URL = requireEphemeralTestPgUrl()
const TEST_DB_PREFIX = 'content_test_'
assertSafeTestEnv(TEST_PG_URL, TEST_DB_PREFIX)

const SECRET = 'teardown-integration-secret'
const OPTS = { pgUrl: TEST_PG_URL, dbPrefix: TEST_DB_PREFIX }
const A: TenantRef = { id: 'a1000000-0000-4000-8000-0000000000a1', slug: 'tear-a' }
const B: TenantRef = { id: 'b1000000-0000-4000-8000-0000000000b1', slug: 'tear-b' }

const control = () => _poolRegistryForTests.ensureControl(TEST_PG_URL, TEST_DB_PREFIX)

async function wipe(): Promise<void> {
  await _resetTenantStoreForTests()
  const ctrl = await control()
  const rows = await ctrl<{ datname: string }[]>`
    SELECT datname FROM pg_database WHERE starts_with(datname, ${TEST_DB_PREFIX + 'tear-'})
  `
  for (const { datname } of rows) await ctrl.unsafe(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`)
  await ctrl`DELETE FROM tenant_catalog WHERE starts_with(slug, 'tear-')`
  await _resetTenantStoreForTests()
}

async function databases(): Promise<string[]> {
  const ctrl = await control()
  const rows = await ctrl<{ datname: string }[]>`
    SELECT datname FROM pg_database WHERE starts_with(datname, ${TEST_DB_PREFIX + 'tear-'}) ORDER BY datname
  `
  return rows.map((r) => r.datname)
}

async function catalogSlugs(): Promise<string[]> {
  const ctrl = await control()
  const rows = await ctrl<{ slug: string }[]>`SELECT slug FROM tenant_catalog WHERE starts_with(slug, 'tear-') ORDER BY slug`
  return rows.map((r) => r.slug)
}

let server: ReturnType<typeof createServer>
let base: string

beforeAll(async () => {
  await wipe()
  server = createServer({
    secret: SECRET,
    routes: buildApiRoutes(() => Promise.reject(new Error('no store in admin tests'))),
    adminRoutes: buildAdminRoutes({ secret: SECRET, pgUrl: TEST_PG_URL, dbPrefix: TEST_DB_PREFIX }),
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
beforeEach(wipe)
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await wipe()
})

const del = (path: string) => fetch(`${base}${path}`, { method: 'DELETE', headers: { 'x-internal-auth': SECRET } })

describe('admin teardown against a real Postgres (audit #534 follow-up)', () => {
  it('drops a database the leaf itself holds a pool for, and forgets the pool', async () => {
    const pool = await storeFor(A, OPTS)
    await pool`SELECT 1`
    expect(_poolRegistryForTests.get(A.id)).toBe(pool)

    const res = await del(`/api/admin/tenants/${A.slug}/db`)
    expect(res.status).toBe(200)
    expect(await databases()).toEqual([])
    expect(_poolRegistryForTests.get(A.id)).toBeUndefined()
  })

  it('refuses to remove the catalog row while the database exists, then removes it once the database is gone', async () => {
    const pool = await storeFor(A, OPTS)
    await storeFor(B, OPTS)

    const refused = await del(`/api/admin/tenants/${A.id}/catalog`)
    expect(refused.status).toBe(409)
    expect(await catalogSlugs()).toEqual([A.slug, B.slug])
    expect(await databases()).toEqual([TEST_DB_PREFIX + A.slug, TEST_DB_PREFIX + B.slug])
    expect(_poolRegistryForTests.get(A.id)).toBe(pool)

    expect((await del(`/api/admin/tenants/${A.slug}/db`)).status).toBe(200)
    const removed = await del(`/api/admin/tenants/${A.id}/catalog`)
    expect(removed.status).toBe(200)
    expect(await catalogSlugs()).toEqual([B.slug])
    expect(_poolRegistryForTests.get(A.id)).toBeUndefined()
    expect(_poolRegistryForTests.get(B.id)).toBeDefined()
  })

  it('after a full teardown a new id on the same slug gets a fresh database, not the old data', async () => {
    const old = await storeFor(A, OPTS)
    await old`CREATE TABLE teardown_marker (v text)`
    await old`INSERT INTO teardown_marker (v) VALUES ('old tenant data')`

    expect((await del(`/api/admin/tenants/${A.slug}/db`)).status).toBe(200)
    expect((await del(`/api/admin/tenants/${A.id}/catalog`)).status).toBe(200)

    const fresh = await storeFor({ id: B.id, slug: A.slug }, OPTS)
    const tables = await fresh<{ n: string }[]>`SELECT count(*)::text AS n FROM pg_tables WHERE tablename = 'teardown_marker'`
    expect(tables[0]!.n).toBe('0')
  })

  it('never drops the catalog database through the slug route', async () => {
    await storeFor(A, OPTS)
    const res = await del('/api/admin/tenants/control/db')
    expect(res.status).toBe(400)
    const ctrl = await control()
    const rows = await ctrl<{ datname: string }[]>`SELECT datname FROM pg_database WHERE datname = ${TEST_DB_PREFIX + 'control'}`
    expect(rows).toHaveLength(1)
  })
})
