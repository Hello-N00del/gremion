/**
 * content leaf: the admin teardown routes keep the in-process pool registry and the
 * catalog consistent with the databases (follow-up to audit #534).
 *
 *  - DELETE /api/admin/tenants/:slug/db ends and evicts the tenant's pool BEFORE
 *    DROP DATABASE (an open connection blocks the drop), including a pool that was
 *    only capacity-evicted and is still inside its drain grace window;
 *  - DELETE /api/admin/tenants/:tenantId/catalog refuses (409) while the tenant's
 *    database still exists, so a new id can never be bound to an old database, and
 *    evicts the pool when the row is removed;
 *  - the reserved slug `control` (the catalog database) is never dropped.
 *
 * PG-free: the `postgres` driver is replaced by an in-memory stand-in holding a
 * catalog table and a set of databases. The real-Postgres twin is
 * admin-routes.teardown.integration.test.ts.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import type { AddressInfo } from 'node:net'

const h = vi.hoisted(() => ({
  catalog: [] as { tenant_id: string; slug: string; db_name: string }[],
  databases: new Set<string>(),
  /** Every statement that reached the driver, in order. */
  log: [] as string[],
  opened: 0,
  /** The next N DROP DATABASE statements fail with this error (a request raced the eviction). */
  dropFailures: [] as { code?: string; message: string; whileRacing?: () => void }[],
}))

vi.mock('postgres', () => {
  const run = (text: string, params: readonly unknown[]): unknown[] => {
    const sqlText = text.replace(/\s+/g, ' ').trim()
    const drop = /^DROP DATABASE IF EXISTS "([^"]+)"/i.exec(sqlText)
    if (drop) {
      h.log.push(`DROP ${drop[1]}`)
      const failure = h.dropFailures.shift()
      failure?.whileRacing?.()
      if (failure) throw Object.assign(new Error(failure.message), failure.code ? { code: failure.code } : {})
      h.databases.delete(drop[1]!)
      return []
    }
    if (/^DELETE FROM tenant_catalog/i.test(sqlText)) {
      h.log.push('DELETE catalog')
      const id = String(params[0])
      const gone = h.catalog.filter((r) => r.tenant_id === id && !h.databases.has(r.db_name))
      h.catalog = h.catalog.filter((r) => !gone.includes(r))
      return gone.map((r) => ({ slug: r.slug }))
    }
    if (/^SELECT 1 FROM tenant_catalog/i.test(sqlText)) {
      return h.catalog.filter((r) => r.tenant_id === String(params[0])).map(() => ({ '?column?': 1 }))
    }
    throw new Error(`unmodelled statement: ${sqlText}`)
  }
  const factory = (_url: string, _opts?: unknown) => {
    h.opened += 1
    return {
      unsafe: (text: string, params?: unknown[]) => {
        try {
          return Promise.resolve(run(text, params ?? []))
        } catch (err) {
          return Promise.reject(err)
        }
      },
      end: () => Promise.resolve(),
    }
  }
  return { default: factory }
})

const { createServer } = await import('../src/http/server.ts')
const { buildAdminRoutes } = await import('../src/http/admin-routes.ts')
const { buildApiRoutes } = await import('../src/http/routes.ts')
const { _poolRegistryForTests } = await import('../src/tenant-store.ts')
type Sql = ReturnType<typeof _poolRegistryForTests.get> & object

const SECRET = 'teardown-secret'
const PREFIX = 'content_test_'
const A = { id: 'a1000000-0000-4000-8000-0000000000a1', slug: 'tear-a' }
const B = { id: 'b1000000-0000-4000-8000-0000000000b1', slug: 'tear-b' }

/** A stand-in pool: records when it was ended relative to the driver's statements. */
function stubPool(): { pool: Sql; ended: () => number; endedAt: () => number[] } {
  const endedAt: number[] = []
  const pool = Object.assign((..._a: unknown[]) => Promise.resolve([]), {
    end: () => {
      endedAt.push(h.log.length)
      return Promise.resolve()
    },
  })
  return { pool: pool as unknown as Sql, ended: () => endedAt.length, endedAt: () => endedAt }
}

const row = (t: { id: string; slug: string }) => ({ tenant_id: t.id, slug: t.slug, db_name: PREFIX + t.slug })

let server: ReturnType<typeof createServer>
let base: string

beforeAll(async () => {
  server = createServer({
    secret: SECRET,
    routes: buildApiRoutes(() => Promise.reject(new Error('no store in admin tests'))),
    adminRoutes: buildAdminRoutes({ secret: SECRET, pgUrl: 'postgres://u:p@127.0.0.1:59999/postgres', dbPrefix: PREFIX }),
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

beforeEach(() => {
  _poolRegistryForTests.reset()
  h.catalog = []
  h.databases.clear()
  h.log.length = 0
  h.opened = 0
  h.dropFailures.length = 0
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

const del = (path: string) => fetch(`${base}${path}`, { method: 'DELETE', headers: { 'x-internal-auth': SECRET } })

describe('DELETE /api/admin/tenants/:slug/db evicts the pool', () => {
  it('ends the tenant pool and removes it from the registry BEFORE the database is dropped', async () => {
    h.databases.add(PREFIX + A.slug)
    const a = stubPool()
    const b = stubPool()
    _poolRegistryForTests.set(A.id, a.pool, A.slug)
    _poolRegistryForTests.set(B.id, b.pool, B.slug)

    const res = await del(`/api/admin/tenants/${A.slug}/db`)
    expect(res.status).toBe(200)

    expect(a.ended()).toBe(1)
    expect(_poolRegistryForTests.get(A.id)).toBeUndefined()
    // ended before the DROP statement reached the driver (an open connection blocks it)
    expect(a.endedAt()[0]).toBeLessThanOrEqual(h.log.indexOf(`DROP ${PREFIX}${A.slug}`))
    // another tenant's pool is untouched
    expect(b.ended()).toBe(0)
    expect(_poolRegistryForTests.get(B.id)).toBe(b.pool)
    expect(h.databases.has(PREFIX + A.slug)).toBe(false)
  })

  it('also ends a pool that was only capacity-evicted and is still inside its drain grace window', async () => {
    const a = stubPool()
    _poolRegistryForTests.set(A.id, a.pool, A.slug)
    for (let i = 0; i < _poolRegistryForTests.MAX; i += 1) {
      _poolRegistryForTests.set(`c${String(i).padStart(7, '0')}-0000-4000-8000-000000000000`, stubPool().pool, `fill-${i}`)
    }
    expect(_poolRegistryForTests.get(A.id)).toBeUndefined() // pushed out of the live registry
    expect(_poolRegistryForTests.pending()).toBe(1)

    const res = await del(`/api/admin/tenants/${A.slug}/db`)
    expect(res.status).toBe(200)
    expect(a.ended()).toBe(1)
    expect(_poolRegistryForTests.pending()).toBe(0)
  })

  it('is idempotent: a tenant with no pool and no database is a 200', async () => {
    const res = await del(`/api/admin/tenants/${A.slug}/db`)
    expect(res.status).toBe(200)
  })

  const inUse = (db: string) => ({ code: '55006', message: `database "${db}" is being accessed by other users` })

  it('retries the DROP once after a second eviction when a request raced the first one', async () => {
    h.databases.add(PREFIX + A.slug)
    const first = stubPool()
    _poolRegistryForTests.set(A.id, first.pool, A.slug)
    // The raced request re-opens a pool for the slug after the first eviction.
    const late = stubPool()
    h.dropFailures.push({
      ...inUse(PREFIX + A.slug),
      whileRacing: () => _poolRegistryForTests.set(A.id, late.pool, A.slug),
    })

    const res = await del(`/api/admin/tenants/${A.slug}/db`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, dropped: PREFIX + A.slug })
    expect(h.log.filter((l) => l.startsWith('DROP '))).toEqual([`DROP ${PREFIX}${A.slug}`, `DROP ${PREFIX}${A.slug}`])
    expect(first.ended()).toBe(1)
    expect(late.ended()).toBe(1) // the second eviction ended the pool the racing request opened
    expect(late.endedAt()[0]).toBeLessThanOrEqual(h.log.lastIndexOf(`DROP ${PREFIX}${A.slug}`))
    expect(_poolRegistryForTests.get(A.id)).toBeUndefined()
    expect(h.databases.has(PREFIX + A.slug)).toBe(false)
  })

  it('recognises the in-use error by its message alone (a driver error without a code)', async () => {
    h.databases.add(PREFIX + A.slug)
    h.dropFailures.push({ message: inUse(PREFIX + A.slug).message })
    const res = await del(`/api/admin/tenants/${A.slug}/db`)
    expect(res.status).toBe(200)
    expect(h.log.filter((l) => l.startsWith('DROP '))).toHaveLength(2)
    expect(h.databases.has(PREFIX + A.slug)).toBe(false)
  })

  it('gives up after one retry: a second in-use failure is a 500 and the database is kept', async () => {
    h.databases.add(PREFIX + A.slug)
    h.dropFailures.push(inUse(PREFIX + A.slug), inUse(PREFIX + A.slug))
    const res = await del(`/api/admin/tenants/${A.slug}/db`)
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ success: false, error: expect.stringContaining('being accessed by other users') })
    expect(h.log.filter((l) => l.startsWith('DROP '))).toHaveLength(2)
    expect(h.databases.has(PREFIX + A.slug)).toBe(true)
  })

  it('does not retry any other DROP failure', async () => {
    h.databases.add(PREFIX + A.slug)
    h.dropFailures.push({ code: '42501', message: 'permission denied to drop database' })
    const res = await del(`/api/admin/tenants/${A.slug}/db`)
    expect(res.status).toBe(500)
    expect(h.log.filter((l) => l.startsWith('DROP '))).toHaveLength(1)
    expect(h.databases.has(PREFIX + A.slug)).toBe(true)
  })

  it('refuses the reserved slug control: <prefix>control is the catalog database, it is never dropped', async () => {
    h.databases.add(PREFIX + 'control')
    const res = await del('/api/admin/tenants/control/db')
    expect(res.status).toBe(400)
    expect(h.log).toEqual([])
    expect(h.opened).toBe(0)
    expect(h.databases.has(PREFIX + 'control')).toBe(true)
  })
})

describe('DELETE /api/admin/tenants/:tenantId/catalog', () => {
  it('refuses with 409 while the tenant database still exists: row kept, pool kept', async () => {
    h.databases.add(PREFIX + A.slug)
    h.catalog.push(row(A))
    const a = stubPool()
    _poolRegistryForTests.set(A.id, a.pool, A.slug)

    const res = await del(`/api/admin/tenants/${A.id}/catalog`)
    expect(res.status).toBe(409)
    const text = await res.text()
    expect(JSON.parse(text)).toMatchObject({ success: false })
    expect(text).not.toContain(A.id)
    expect(text).not.toContain(A.slug)

    expect(h.catalog).toEqual([row(A)])
    expect(a.ended()).toBe(0)
    expect(_poolRegistryForTests.get(A.id)).toBe(a.pool)
  })

  it('removes the row and evicts the pool once the database is gone', async () => {
    h.catalog.push(row(A), row(B))
    h.databases.add(PREFIX + B.slug)
    const a = stubPool()
    const b = stubPool()
    _poolRegistryForTests.set(A.id, a.pool, A.slug)
    _poolRegistryForTests.set(B.id, b.pool, B.slug)

    const res = await del(`/api/admin/tenants/${A.id}/catalog`)
    expect(res.status).toBe(200)
    expect(h.catalog).toEqual([row(B)])
    expect(a.ended()).toBe(1)
    expect(_poolRegistryForTests.get(A.id)).toBeUndefined()
    expect(b.ended()).toBe(0)
  })

  it('an upper-case spelling of the id removes the same row', async () => {
    h.catalog.push(row(A))
    const res = await del(`/api/admin/tenants/${A.id.toUpperCase()}/catalog`)
    expect(res.status).toBe(200)
    expect(h.catalog).toEqual([])
  })

  it('is idempotent: no row is a 200', async () => {
    const res = await del(`/api/admin/tenants/${A.id}/catalog`)
    expect(res.status).toBe(200)
  })
})
