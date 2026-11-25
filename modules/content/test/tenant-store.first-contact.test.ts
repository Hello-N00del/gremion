/**
 * content leaf: what storeFor does when first contact races (PG-free).
 *
 * The real-Postgres twin is tenant-store.first-contact.integration.test.ts: it proves that parallel
 * first requests succeed. This file pins the pieces that cannot be reached there, because the lock
 * makes them rare on a real server: a creator that took no lock (an older colour) loses or wins the
 * race at CREATE DATABASE or inside a migration file, and the error it causes must not reach the
 * caller as a 500.
 *
 * The `postgres` driver is replaced by an in-memory stand-in that records, in order, what each
 * connection did, and that can be told to fail the next CREATE DATABASE or migration statement with
 * a given error.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  databases: new Set<string>(),
  catalog: [] as { tenant_id: string; slug: string; db_name: string }[],
  /** Everything of interest, in order: `LOCK@<database>`, `CREATE DATABASE <name>`. */
  log: [] as string[],
  /** Errors the next CREATE DATABASE statements throw (one each). `alsoCreate`: the other creator won. */
  createFailures: [] as (Error & { alsoCreate?: boolean })[],
  /** Errors the next migration statements throw (one each, first file statement first). */
  migrationFailures: [] as Error[],
  /** How many migration failures were actually thrown. */
  migrationThrown: 0,
  ended: 0,
}))

vi.mock('postgres', () => {
  const dbOf = (url: string): string => new URL(url).pathname.slice(1)

  const factory = (url: string, _opts?: unknown) => {
    const run = (text: string, params: readonly unknown[]): unknown[] => {
      if (/SELECT count\(\*\) AS count FROM pg_database/i.test(text)) {
        return [{ count: h.databases.has(typeof params[0] === 'string' ? params[0] : '') ? '1' : '0' }]
      }
      if (/pg_advisory_lock\(/i.test(text)) {
        h.log.push('LOCK@' + dbOf(url))
        return []
      }
      const create = /^\s*CREATE DATABASE "([^"]+)"/i.exec(text)
      if (create) {
        const failure = h.createFailures.shift()
        if (failure !== undefined) {
          if (failure.alsoCreate) h.databases.add(create[1]!)
          throw failure
        }
        h.databases.add(create[1]!)
        h.log.push(`CREATE DATABASE ${create[1]}`)
        return []
      }
      if (/FROM tenant_catalog WHERE tenant_id = \$1 OR slug = \$2/i.test(text)) {
        return h.catalog
          .filter((r) => r.tenant_id === params[0] || r.slug === params[1])
          .map(({ tenant_id, slug }) => ({ tenant_id, slug }))
      }
      if (/INSERT INTO tenant_catalog/i.test(text)) {
        const [id, slug, dbName] = params as [string, string, string]
        if (!h.catalog.some((r) => r.tenant_id === id || r.slug === slug)) {
          h.catalog.push({ tenant_id: id, slug, db_name: dbName })
        }
        return []
      }
      if (/CREATE TABLE IF NOT EXISTS (?!tenant_catalog)/i.test(text)) {
        const failure = h.migrationFailures.shift()
        if (failure !== undefined) {
          h.migrationThrown++
          throw failure
        }
      }
      return []
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
    }) as unknown as Record<string, unknown> & ((...a: unknown[]) => Promise<unknown[]>)
    sql.unsafe = (text: string, params?: unknown[]) => guarded(text, params ?? [])
    sql.end = () => {
      h.ended++
      return Promise.resolve()
    }
    sql.begin = async (fn: (tx: unknown) => Promise<unknown>) => fn(sql)
    return sql
  }
  return { default: factory }
})

// Imported AFTER vi.mock so the stand-in driver is in place.
const { storeFor, _resetTenantStoreForTests } = await import('../src/tenant-store.ts')

const PREFIX = 'content_test_'
const CONTROL_DB = PREFIX + 'control'
const OPTS = {
  // Never port 5432 - that is the LIVE Postgres on the staging host. The driver is mocked anyway.
  pgUrl: 'postgres://u:p@127.0.0.1:59999/postgres',
  dbPrefix: PREFIX,
} as const

const T = { id: 'd1000000-0000-4000-8000-0000000000d1', slug: 'race-a' }
const TENANT_DB = PREFIX + T.slug

function pgError(code: string, message: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), { code, ...extra })
}

const duplicateDatabase = (): Error & { alsoCreate?: boolean } =>
  Object.assign(pgError('42P04', `database "${TENANT_DB}" already exists`), { alsoCreate: true })
const datnameIndexViolation = (): Error & { alsoCreate?: boolean } =>
  Object.assign(
    pgError('23505', 'duplicate key value violates unique constraint "pg_database_datname_index"', {
      constraint_name: 'pg_database_datname_index',
    }),
    { alsoCreate: true },
  )

beforeEach(async () => {
  await _resetTenantStoreForTests()
  h.databases.clear()
  h.catalog.length = 0
  h.log.length = 0
  h.createFailures.length = 0
  h.migrationFailures.length = 0
  h.migrationThrown = 0
  h.ended = 0
  // the control database exists: these tests are about the customer's own database
  h.databases.add(CONTROL_DB)
})

describe('CREATE DATABASE lost to another creator is not a failure', () => {
  it('42P04 (duplicate_database): the caller gets its pool', async () => {
    h.createFailures.push(duplicateDatabase())
    await expect(storeFor(T, OPTS)).resolves.toBeDefined()
    expect(h.databases.has(TENANT_DB)).toBe(true)
  })

  it('23505 on pg_database_datname_index (the message of the field report): the caller gets its pool', async () => {
    h.createFailures.push(datnameIndexViolation())
    await expect(storeFor(T, OPTS)).resolves.toBeDefined()
  })

  it('23505 on any other constraint is still a failure', async () => {
    h.createFailures.push(
      pgError('23505', 'duplicate key value violates unique constraint "tenant_catalog_slug_key"', {
        constraint_name: 'tenant_catalog_slug_key',
      }),
    )
    await expect(storeFor(T, OPTS)).rejects.toMatchObject({ code: '23505' })
  })

  it('a refused CREATE DATABASE (42501) is still a failure', async () => {
    h.createFailures.push(pgError('42501', 'permission denied to create database'))
    await expect(storeFor(T, OPTS)).rejects.toMatchObject({ code: '42501' })
  })

  it('55006 (template busy) is retried, then succeeds', async () => {
    h.createFailures.push(pgError('55006', 'source database "template1" is being accessed by other users'))
    await expect(storeFor(T, OPTS)).resolves.toBeDefined()
    expect(h.log).toContain(`CREATE DATABASE ${TENANT_DB}`)
  })
})

describe('CREATE DATABASE runs under the server-wide lock, and only when the database is missing', () => {
  it('the lock is taken on the maintenance database before the CREATE DATABASE', async () => {
    await storeFor(T, OPTS)
    const lock = h.log.indexOf('LOCK@postgres')
    const create = h.log.indexOf(`CREATE DATABASE ${TENANT_DB}`)
    expect(lock).toBeGreaterThanOrEqual(0)
    expect(create).toBeGreaterThan(lock)
  })

  it('an existing database is opened without taking that lock', async () => {
    h.databases.add(TENANT_DB)
    await storeFor(T, OPTS)
    expect(h.log).not.toContain('LOCK@postgres')
    expect(h.log.filter((l) => l.startsWith('CREATE DATABASE'))).toEqual([])
  })

  it('the migrations run under a lock on the customer database', async () => {
    await storeFor(T, OPTS)
    expect(h.log).toContain('LOCK@' + TENANT_DB)
  })
})

describe('concurrent first requests in one process share one flight', () => {
  it('N parallel storeFor calls create the database once and hand out one pool', async () => {
    const pools = await Promise.all(Array.from({ length: 6 }, () => storeFor(T, OPTS)))
    expect(new Set(pools).size).toBe(1)
    expect(h.log.filter((l) => l === `CREATE DATABASE ${TENANT_DB}`)).toHaveLength(1)
    expect(h.log.filter((l) => l === 'LOCK@' + TENANT_DB)).toHaveLength(1)
  })

  it('a failed flight is not cached: the next call starts again', async () => {
    h.createFailures.push(pgError('42501', 'permission denied to create database'))
    await expect(storeFor(T, OPTS)).rejects.toMatchObject({ code: '42501' })
    await expect(storeFor(T, OPTS)).resolves.toBeDefined()
  })
})

describe('a migration file that collides with a creator that took no lock', () => {
  it('42P07 once: retried, the caller gets its pool', async () => {
    h.migrationFailures.push(pgError('42P07', 'relation "x" already exists'))
    await expect(storeFor(T, OPTS)).resolves.toBeDefined()
    expect(h.migrationThrown).toBe(1)
  })

  it('"tuple concurrently updated" (XX000) once: retried', async () => {
    h.migrationFailures.push(pgError('XX000', 'tuple concurrently updated'))
    await expect(storeFor(T, OPTS)).resolves.toBeDefined()
  })

  it('23505 on a pg_ catalogue index once: retried', async () => {
    h.migrationFailures.push(
      pgError('23505', 'duplicate key value violates unique constraint "pg_type_typname_nsp_index"', {
        constraint_name: 'pg_type_typname_nsp_index',
      }),
    )
    await expect(storeFor(T, OPTS)).resolves.toBeDefined()
  })

  it('the retry is bounded: a collision that never clears fails after three attempts and ends the pool', async () => {
    for (let i = 0; i < 6; i++) h.migrationFailures.push(pgError('42P07', 'relation "x" already exists'))
    const endedBefore = h.ended
    await expect(storeFor(T, OPTS)).rejects.toMatchObject({ code: '42P07' })
    expect(h.migrationThrown).toBe(3)
    expect(h.ended).toBeGreaterThan(endedBefore)
  })

  it('an error of the file itself (42601) is final, not retried', async () => {
    h.migrationFailures.push(pgError('42601', 'syntax error'), pgError('42601', 'syntax error'))
    await expect(storeFor(T, OPTS)).rejects.toMatchObject({ code: '42601' })
    expect(h.migrationThrown).toBe(1)
  })

  it('a unique violation of a USER table is final, not retried', async () => {
    h.migrationFailures.push(
      pgError('23505', 'duplicate key value violates unique constraint "mailing_lists_pkey"', {
        constraint_name: 'mailing_lists_pkey',
      }),
      pgError('23505', 'x', { constraint_name: 'mailing_lists_pkey' }),
    )
    await expect(storeFor(T, OPTS)).rejects.toMatchObject({ code: '23505' })
    expect(h.migrationThrown).toBe(1)
  })
})
