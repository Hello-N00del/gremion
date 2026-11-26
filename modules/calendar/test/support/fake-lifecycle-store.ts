/**
 * PG-free stand-ins for the two things the calendar leaf's store talks to, shared by the unit suites:
 *
 *   - `postgres` (the driver): an in-memory catalogue database. It knows `pg_database`, CREATE DATABASE,
 *     advisory locks, `tenant_catalog` with the real table's constraints (tenant_id PRIMARY KEY, slug
 *     UNIQUE), and it records what every connection did. A suite can make the next CREATE DATABASE fail.
 *   - `@gremion/tenant-store` (the package store behind the schema gate): it keeps its real naming
 *     functions, records which (tenant, module) pool is asked for and with which resolved target, and
 *     answers the gate and the `SELECT 1` classification probe as the suite tells it to.
 *
 * A suite wires them with
 *   vi.mock('postgres', async () => ({ default: (await import('./support/fake-lifecycle-store.ts')).fakePostgres }))
 *   vi.mock('@gremion/tenant-store', async (orig) =>
 *     (await import('./support/fake-lifecycle-store.ts')).fakeTenantStorePackage(await orig()))
 * and imports `fake` and `resetFake` from this file (one module instance per test file).
 */

export interface FakeState {
  catalog: { tenant_id: string; slug: string; db_name: string }[]
  databases: Set<string>
  /** CREATE DATABASE and every catalogue write, in order. */
  writes: string[]
  /** Everything of interest in order: `LOCK@<database>`, `CREATE DATABASE <name>`. */
  log: string[]
  /** Every url handed to the `postgres` driver factory. */
  opened: string[]
  /** Errors the next CREATE DATABASE statements throw (one each). `alsoCreate`: the other creator won. */
  createFailures: (Error & { alsoCreate?: boolean })[]
  /** The catalogue table's CREATE TABLE fails with this many errors first (the init-retry shape). */
  failNextQueries: number
  /** Pools ended through the driver (control pool). */
  ended: number
  /** The driver's end() rejects (a broken connection). */
  endRejects: boolean
  /** The package store's close() rejects. */
  storeCloseRejects: boolean
  /** What the package store was asked for: [tenantId, moduleId]. */
  storeOpens: [string, string][]
  /** The resolveTarget the leaf handed to createTenantStore. */
  resolveTarget: null | ((tenantId: string, moduleId: string) => { url: string } | Promise<{ url: string }>)
  /** What the schema gate answers. */
  verdict:
    | { ok: true }
    | { ok: false; reason: 'unavailable' | 'behind' | 'diverged'; retryAfterSeconds: number }
  /** What `SELECT 1` on the tenant pool does (the classification probe). */
  probeError: null | { code: string }
  /** The pool every openTenantDb answers with (a stand-in the suite may replace). */
  tenantPool: unknown
  storeClosed: number
}

export const fake: FakeState = {
  catalog: [],
  databases: new Set(),
  writes: [],
  log: [],
  opened: [],
  createFailures: [],
  failNextQueries: 0,
  ended: 0,
  endRejects: false,
  storeCloseRejects: false,
  storeOpens: [],
  resolveTarget: null,
  verdict: { ok: true },
  probeError: null,
  tenantPool: null,
  storeClosed: 0,
}

export function resetFake(): void {
  fake.catalog.length = 0
  fake.databases.clear()
  fake.writes.length = 0
  fake.log.length = 0
  fake.opened.length = 0
  fake.createFailures.length = 0
  fake.failNextQueries = 0
  fake.ended = 0
  fake.endRejects = false
  fake.storeCloseRejects = false
  fake.storeOpens.length = 0
  fake.resolveTarget = null
  fake.verdict = { ok: true }
  fake.probeError = null
  fake.tenantPool = null
  fake.storeClosed = 0
}

type AnySql = Record<string, unknown> & ((...a: unknown[]) => Promise<unknown[]>)

function uniqueViolation(): Error & { code: string } {
  return Object.assign(new Error('duplicate key value violates unique constraint "tenant_catalog_slug_key"'), {
    code: '23505',
  })
}

/** The `postgres` driver factory: postgres(url, options) -> a connection stand-in. */
export function fakePostgres(url: string): AnySql {
  fake.opened.push(url)
  const dbOf = (): string => new URL(url).pathname.slice(1)
  const run = (text: string, params: readonly unknown[]): unknown[] => {
    if (fake.failNextQueries > 0) {
      fake.failNextQueries--
      throw Object.assign(new Error('the database system is starting up'), { code: '57P03', severity: 'FATAL' })
    }
    if (/SELECT count\(\*\) AS count FROM pg_database/i.test(text)) {
      return [{ count: fake.databases.has(typeof params[0] === 'string' ? params[0] : '') ? '1' : '0' }]
    }
    if (/pg_advisory_lock\(/i.test(text)) {
      fake.log.push('LOCK@' + dbOf())
      return []
    }
    const create = /^\s*CREATE DATABASE "([^"]+)"/i.exec(text)
    if (create) {
      const failure = fake.createFailures.shift()
      if (failure !== undefined) {
        if (failure.alsoCreate) fake.databases.add(create[1]!)
        throw failure
      }
      fake.databases.add(create[1]!)
      fake.writes.push(`CREATE DATABASE ${create[1]}`)
      fake.log.push(`CREATE DATABASE ${create[1]}`)
      return []
    }
    if (/FROM tenant_catalog WHERE tenant_id = \$1 OR slug = \$2/i.test(text)) {
      return fake.catalog
        .filter((r) => r.tenant_id === params[0] || r.slug === params[1])
        .map(({ tenant_id, slug }) => ({ tenant_id, slug }))
    }
    if (/INSERT INTO tenant_catalog/i.test(text)) {
      fake.writes.push(text.replace(/\s+/g, ' ').trim())
      const [id, slug, dbName] = params as [string, string, string]
      const sameId = fake.catalog.find((r) => r.tenant_id === id)
      const sameSlug = fake.catalog.find((r) => r.slug === slug)
      if (/ON CONFLICT DO NOTHING/i.test(text)) {
        if (!sameId && !sameSlug) fake.catalog.push({ tenant_id: id, slug, db_name: dbName })
        return []
      }
      if (/ON CONFLICT \(tenant_id\) DO UPDATE/i.test(text)) {
        if (sameId) {
          if (sameSlug !== undefined && sameSlug !== sameId) throw uniqueViolation()
          sameId.slug = slug
          sameId.db_name = dbName
        } else {
          if (sameSlug !== undefined) throw uniqueViolation()
          fake.catalog.push({ tenant_id: id, slug, db_name: dbName })
        }
        return []
      }
      throw new Error(`unmodelled INSERT: ${text}`)
    }
    if (/SELECT tenant_id, slug FROM tenant_catalog/i.test(text)) {
      return fake.catalog.map(({ tenant_id, slug }) => ({ tenant_id, slug }))
    }
    return [] // CREATE TABLE, advisory xact lock ...
  }
  const guarded = (text: string, params: readonly unknown[]): Promise<unknown[]> => {
    try {
      return Promise.resolve(run(text, params))
    } catch (err) {
      return Promise.reject(err)
    }
  }
  const sql = ((strings: TemplateStringsArray | string, ...vals: unknown[]) => {
    const text = typeof strings === 'string' ? strings : strings.join(' ? ')
    return guarded(text, vals)
  }) as unknown as AnySql
  sql.unsafe = (text: string, params?: unknown[]) => guarded(text, params ?? [])
  sql.end = () => {
    fake.ended++
    return fake.endRejects ? Promise.reject(new Error('end exploded')) : Promise.resolve()
  }
  sql.begin = async (fn: (tx: unknown) => Promise<unknown>) => fn(sql)
  return sql
}

/** A pool stand-in for a customer database: answers the probe `SELECT 1`, ends without effect. */
export function makeTenantPool(): AnySql {
  const sql = (async (): Promise<unknown[]> => {
    if (fake.probeError) throw Object.assign(new Error('probe'), fake.probeError)
    return [{ '?column?': 1 }]
  }) as unknown as AnySql
  sql.end = () => Promise.resolve()
  return sql
}

/** @gremion/tenant-store with a recording store and a controllable gate; the naming functions are real. */
export function fakeTenantStorePackage<T extends object>(real: T): T {
  return {
    ...real,
    createTenantStore: (options: { resolveTarget: FakeState['resolveTarget'] }) => {
      fake.resolveTarget = options.resolveTarget
      const pools = new Map<string, unknown>()
      return {
        async openTenantDb(tenantId: string, moduleId: string) {
          fake.storeOpens.push([tenantId, moduleId])
          const key = `${tenantId}/${moduleId}`
          if (!pools.has(key)) pools.set(key, fake.tenantPool ?? makeTenantPool())
          return pools.get(key)
        },
        evictTenantDb: () => true,
        size: () => pools.size,
        async close() {
          fake.storeClosed++
          pools.clear()
          if (fake.storeCloseRejects) throw new Error('close exploded')
        },
      }
    },
    schemaGate: () => ({
      check: async () => fake.verdict,
      guard: async () => true,
    }),
  } as T
}
