/**
 * calendar leaf: what storeFor does when first contact races (PG-free).
 *
 * The leaf creates exactly ONE database: the catalogue database `<prefix>control`. A customer's calendar
 * database is the lifecycle's (t_<tenant>__calendar) and is only opened. So the races that matter here
 * are the catalogue database's: a creator that took no lock (an older colour) loses or wins the race at
 * CREATE DATABASE, and the error it causes must not reach the caller as a 500; and concurrent first
 * requests for one customer in this process share one flight.
 *
 * The real-Postgres twin is tenant-store.first-contact.integration.test.ts. The `postgres` driver and
 * the package store are the in-memory stand-ins of support/fake-lifecycle-store.ts, which can be told to
 * fail the next CREATE DATABASE with a given error.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('postgres', async () => ({ default: (await import('./support/fake-lifecycle-store.ts')).fakePostgres }))
vi.mock('@gremion/tenant-store', async (importOriginal) =>
  (await import('./support/fake-lifecycle-store.ts')).fakeTenantStorePackage(await importOriginal<object>()),
)
import { fake as h, resetFake } from './support/fake-lifecycle-store.ts'

// Imported AFTER vi.mock so the stand-ins are in place.
const { storeFor, _resetTenantStoreForTests } = await import('../src/tenant-store.ts')
const { tenantModuleDbName } = await import('@gremion/tenant-store')

const PREFIX = 'calendar_test_'
const CONTROL_DB = PREFIX + 'control'
const OPTS = {
  // Never port 5432 - that is the LIVE Postgres on the staging host. The driver is mocked anyway.
  pgUrl: 'postgres://u:p@127.0.0.1:59999/postgres',
  dbPrefix: PREFIX,
  moduleUrl: 'postgres://m_calendar_app:p@127.0.0.1:59999/postgres',
} as const

const T = { id: '01920000-0000-7000-8000-0000000000d1', slug: 'race-a' }
const TENANT_DB = tenantModuleDbName(T.id, 'calendar')

function pgError(code: string, message: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), { code, ...extra })
}

const duplicateDatabase = (): Error & { alsoCreate?: boolean } =>
  Object.assign(pgError('42P04', `database "${CONTROL_DB}" already exists`), { alsoCreate: true })
const datnameIndexViolation = (): Error & { alsoCreate?: boolean } =>
  Object.assign(
    pgError('23505', 'duplicate key value violates unique constraint "pg_database_datname_index"', {
      constraint_name: 'pg_database_datname_index',
    }),
    { alsoCreate: true },
  )

beforeEach(async () => {
  await _resetTenantStoreForTests()
  resetFake()
})

describe('CREATE DATABASE of the catalogue database lost to another creator is not a failure', () => {
  it('42P04 (duplicate_database): the caller gets its pool', async () => {
    h.createFailures.push(duplicateDatabase())
    await expect(storeFor(T, OPTS)).resolves.toBeDefined()
    expect(h.databases.has(CONTROL_DB)).toBe(true)
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
    expect(h.log).toContain(`CREATE DATABASE ${CONTROL_DB}`)
  })
})

describe('CREATE DATABASE runs under the server-wide lock, and only when the catalogue database is missing', () => {
  it('the lock is taken on the maintenance database before the CREATE DATABASE', async () => {
    await storeFor(T, OPTS)
    const lock = h.log.indexOf('LOCK@postgres')
    const create = h.log.indexOf(`CREATE DATABASE ${CONTROL_DB}`)
    expect(lock).toBeGreaterThanOrEqual(0)
    expect(create).toBeGreaterThan(lock)
  })

  it('an existing catalogue database is used without taking that lock', async () => {
    h.databases.add(CONTROL_DB)
    await storeFor(T, OPTS)
    expect(h.log).not.toContain('LOCK@postgres')
    expect(h.log.filter((l) => l.startsWith('CREATE DATABASE'))).toEqual([])
  })

  it('the customer database is never created, whatever the catalogue database did', async () => {
    await storeFor(T, OPTS)
    expect(h.databases.has(TENANT_DB)).toBe(false)
    expect(h.log.filter((l) => l.includes(TENANT_DB))).toEqual([])
  })
})

describe('concurrent first requests in one process share one flight', () => {
  it('N parallel storeFor calls open the customer database once and hand out one pool', async () => {
    h.databases.add(CONTROL_DB)
    const pools = await Promise.all(Array.from({ length: 6 }, () => storeFor(T, OPTS)))
    expect(new Set(pools).size).toBe(1)
    expect(h.storeOpens.filter(([, m]) => m === 'calendar')).toHaveLength(1)
    expect(h.catalog.map((r) => r.tenant_id)).toEqual([T.id])
  })

  it('a failed flight is not cached: the next call starts again', async () => {
    h.createFailures.push(pgError('42501', 'permission denied to create database'))
    await expect(storeFor(T, OPTS)).rejects.toMatchObject({ code: '42501' })
    await expect(storeFor(T, OPTS)).resolves.toBeDefined()
  })
})
