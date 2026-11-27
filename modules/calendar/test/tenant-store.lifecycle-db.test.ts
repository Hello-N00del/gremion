/**
 * calendar leaf: a customer's calendar lives in the database the module lifecycle owns,
 * t_<tenant uuid as 32 hex>__calendar (enableModule creates and migrates it, disableModule exports,
 * blocks and drops it). The leaf only OPENS it.
 *
 * Three invariants, each pinned here without a Postgres:
 *   - NAME  the database name comes from the tenant id alone (tenantModuleDbName), never the slug;
 *   - ROLE  customer pools log in with the module URL (the module's app role), never with the admin URL
 *           that only the catalogue database still uses;
 *   - DDL   the leaf never creates or migrates a t_ database. A missing, blocked or unreachable one is a
 *           typed refusal (404 not provisioned / 503), and a refused tenant is not entered in the catalogue.
 *
 * PG-free: `postgres` is an in-memory stand-in for the catalogue; @gremion/tenant-store keeps its real
 * naming functions and gets a recording store and a controllable schema gate. The real-Postgres twin is
 * lifecycle.integration.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('postgres', async () => ({ default: (await import('./support/fake-lifecycle-store.ts')).fakePostgres }))
vi.mock('@gremion/tenant-store', async (importOriginal) =>
  (await import('./support/fake-lifecycle-store.ts')).fakeTenantStorePackage(await importOriginal<object>()),
)
import { fake as h, resetFake } from './support/fake-lifecycle-store.ts'

const {
  storeFor,
  closeAllPools,
  TenantNotProvisionedError,
  TenantUnavailableError,
  MIGRATIONS_DIR,
  _resetTenantStoreForTests,
} = await import('../src/tenant-store.ts')
const { tenantModuleDbName } = await import('@gremion/tenant-store')

const PREFIX = 'calendar_test_'
const CONTROL_DB = PREFIX + 'control'
const ADMIN_URL = 'postgres://calendar_admin:admin-pw@127.0.0.1:59999/postgres'
const APP_URL = 'postgres://m_calendar_app:app-pw@127.0.0.1:59999/postgres'
const OPTS = { pgUrl: ADMIN_URL, dbPrefix: PREFIX, moduleUrl: APP_URL } as const

const A = { id: '01920000-0000-7000-8000-0000000000a1', slug: 'life-a' }
const B = { id: '01920000-0000-7000-8000-0000000000b1', slug: 'life-b' }
const DB_A = tenantModuleDbName(A.id, 'calendar')

beforeEach(async () => {
  await _resetTenantStoreForTests()
  resetFake()
})

describe('NAME: the database is the lifecycle name, from the id alone', () => {
  it('opens (tenant id, "calendar") through the package store, whose name is t_<hex32>__calendar', async () => {
    await storeFor(A, OPTS)
    expect(h.storeOpens).toEqual([[A.id, 'calendar']])
    expect(DB_A).toBe('t_019200000000700080000000000000a1__calendar')
  })

  it('the slug takes no part in the name: another slug for the same id is refused, the same id always opens the same database', async () => {
    await storeFor(A, OPTS)
    await expect(storeFor({ id: A.id, slug: 'life-renamed' }, OPTS)).rejects.toMatchObject({ code: 'TENANT_IDENTITY_MISMATCH' })
    expect(h.storeOpens).toEqual([[A.id, 'calendar']])
  })

  it('no connection is made to a database named after the slug (calendar_<slug> is the retired layout)', async () => {
    await storeFor(A, OPTS)
    expect(h.opened.filter((u) => u.includes(A.slug))).toEqual([])
    expect(h.opened.filter((u) => u.endsWith('/' + PREFIX + A.slug))).toEqual([])
  })

  it('the catalogue row names the lifecycle database', async () => {
    await storeFor(A, OPTS)
    expect(h.catalog).toEqual([{ tenant_id: A.id, slug: A.slug, db_name: DB_A }])
  })

  it('an id that is not a UUIDv7 is the typed InvalidTenantIdError and touches nothing', async () => {
    const v4 = 'a1000000-0000-4000-8000-0000000000a1'
    const err = await storeFor({ id: v4, slug: A.slug }, OPTS).catch((e: unknown) => e)
    expect(err).toMatchObject({ code: 'TENANT_ID_INVALID', name: 'InvalidTenantIdError' })
    expect(h.opened).toEqual([])
    expect(h.storeOpens).toEqual([])
  })
})

describe('ROLE: customer pools use the module URL, never the admin URL', () => {
  it('the package store resolves (tenant, calendar) to the module server as the module URL user, on the lifecycle database', async () => {
    await storeFor(A, OPTS)
    expect(h.resolveTarget).not.toBeNull()
    const { url } = await h.resolveTarget!(A.id, 'calendar')
    const u = new URL(url)
    expect(decodeURIComponent(u.username)).toBe('m_calendar_app')
    expect(u.pathname).toBe('/' + DB_A)
  })

  it('without a module URL the leaf refuses, naming GREMION_CALENDAR_PG_URL, and does not fall back to the admin URL', async () => {
    const saved = process.env.GREMION_CALENDAR_PG_URL
    delete process.env.GREMION_CALENDAR_PG_URL
    try {
      await expect(storeFor(A, { pgUrl: ADMIN_URL, dbPrefix: PREFIX })).rejects.toThrow(/GREMION_CALENDAR_PG_URL/)
      expect(h.storeOpens).toEqual([])
    } finally {
      if (saved !== undefined) process.env.GREMION_CALENDAR_PG_URL = saved
    }
  })

  it('the admin URL serves only the catalogue database: no customer connection is opened with it', async () => {
    await storeFor(A, OPTS)
    const adminDbs = h.opened.map((u) => new URL(u)).filter((u) => decodeURIComponent(u.username) === 'calendar_admin')
    for (const u of adminDbs) expect([ '/postgres', '/' + CONTROL_DB ]).toContain(u.pathname)
  })
})

describe('DDL: the leaf never creates or migrates a customer database', () => {
  it('the only CREATE DATABASE of a first contact is the catalogue database', async () => {
    await storeFor(A, OPTS)
    expect(h.writes.filter((w) => w.startsWith('CREATE DATABASE'))).toEqual([`CREATE DATABASE ${CONTROL_DB}`])
    expect(h.databases.has(DB_A)).toBe(false)
  })

  it('a database that does not exist (3D000) is TenantNotProvisionedError and no catalogue row is written', async () => {
    h.verdict = { ok: false, reason: 'unavailable', retryAfterSeconds: 30 }
    h.probeError = { code: '3D000' }
    const err = await storeFor(A, OPTS).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TenantNotProvisionedError)
    expect(err).toMatchObject({ code: 'TENANT_NOT_PROVISIONED' })
    expect(h.catalog).toEqual([])
    expect(h.writes.filter((w) => w.startsWith('INSERT'))).toEqual([])
  })

  it('a blocked database (42501: the module Karenz revoked CONNECT) is TenantNotProvisionedError too', async () => {
    h.verdict = { ok: false, reason: 'unavailable', retryAfterSeconds: 30 }
    h.probeError = { code: '42501' }
    await expect(storeFor(A, OPTS)).rejects.toBeInstanceOf(TenantNotProvisionedError)
    expect(h.catalog).toEqual([])
  })

  it('any other failure of the check is TenantUnavailableError (503, retry later), not a 404', async () => {
    h.verdict = { ok: false, reason: 'unavailable', retryAfterSeconds: 30 }
    h.probeError = { code: '57P03' }
    const err = await storeFor(A, OPTS).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TenantUnavailableError)
    expect(err).toMatchObject({ code: 'TENANT_UNAVAILABLE', reason: 'tenant_unavailable', retryAfterSeconds: 30 })
    expect(h.catalog).toEqual([])
  })

  it('a database behind or diverged from the migrations is TenantUnavailableError schema_not_current: the leaf never migrates', async () => {
    for (const reason of ['behind', 'diverged'] as const) {
      h.verdict = { ok: false, reason, retryAfterSeconds: 30 }
      const err = await storeFor(A, OPTS).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(TenantUnavailableError)
      expect(err).toMatchObject({ reason: 'schema_not_current', retryAfterSeconds: 30 })
    }
    expect(h.writes.filter((w) => w.startsWith('INSERT'))).toEqual([])
  })

  it('a refusal is not cached: once the database exists the very next call serves it', async () => {
    h.verdict = { ok: false, reason: 'unavailable', retryAfterSeconds: 30 }
    h.probeError = { code: '3D000' }
    await expect(storeFor(A, OPTS)).rejects.toBeInstanceOf(TenantNotProvisionedError)
    h.verdict = { ok: true }
    h.probeError = null
    await expect(storeFor(A, OPTS)).resolves.toBeDefined()
    expect(h.catalog.map((r) => r.tenant_id)).toEqual([A.id])
  })

  it('the second tenant is independent of the first one refused', async () => {
    h.verdict = { ok: false, reason: 'unavailable', retryAfterSeconds: 30 }
    h.probeError = { code: '3D000' }
    await expect(storeFor(A, OPTS)).rejects.toBeInstanceOf(TenantNotProvisionedError)
    h.verdict = { ok: true }
    h.probeError = null
    await expect(storeFor(B, OPTS)).resolves.toBeDefined()
    expect(h.catalog.map((r) => r.tenant_id)).toEqual([B.id])
  })
})

describe('MOVE: a customer not yet moved out of calendar_<slug> is refused until the catalogue names the lifecycle database', () => {
  const legacyRow = () => ({ tenant_id: A.id, slug: A.slug, db_name: PREFIX + A.slug })

  it('a catalogue row that still names calendar_<slug> is a 503 move_pending: the customer database is not opened and nothing is written', async () => {
    h.databases.add(CONTROL_DB)
    h.catalog.push(legacyRow())
    const err = await storeFor(A, OPTS).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TenantUnavailableError)
    expect(err).toMatchObject({ code: 'TENANT_UNAVAILABLE', reason: 'move_pending', retryAfterSeconds: 30 })
    expect(h.storeOpens).toEqual([])
    expect(h.writes).toEqual([])
    expect(h.catalog).toEqual([legacyRow()])
  })

  it('stays refused on every call, and is served the moment the catalogue names the lifecycle database', async () => {
    h.databases.add(CONTROL_DB)
    h.catalog.push(legacyRow())
    await expect(storeFor(A, OPTS)).rejects.toMatchObject({ reason: 'move_pending' })
    await expect(storeFor(A, OPTS)).rejects.toMatchObject({ reason: 'move_pending' })
    h.catalog[0]!.db_name = DB_A
    await expect(storeFor(A, OPTS)).resolves.toBeDefined()
    expect(h.storeOpens).toEqual([[A.id, 'calendar']])
  })

  it('a customer with no catalogue row yet is a new customer: claimed under the lifecycle name, never refused', async () => {
    await expect(storeFor(B, OPTS)).resolves.toBeDefined()
    expect(h.catalog).toEqual([{ tenant_id: B.id, slug: B.slug, db_name: tenantModuleDbName(B.id, 'calendar') }])
  })
})

describe('BUNDLE: the schema gate finds the migrations manifest from src/ and from the bundle', () => {
  it('MIGRATIONS_DIR is <leaf>/migrations, resolved at src/ depth 1 (dist/index.js sits at the same depth), and holds manifest.json', async () => {
    const { existsSync } = await import('node:fs')
    const { basename, dirname, join, resolve } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const leaf = resolve(dirname(fileURLToPath(import.meta.url)), '..')
    expect(resolve(MIGRATIONS_DIR)).toBe(join(leaf, 'migrations'))
    expect(existsSync(join(MIGRATIONS_DIR, 'manifest.json'))).toBe(true)
    // the file that resolves it stays directly under src/ (a deeper file would resolve to /migrations from the bundle)
    expect(basename(dirname(fileURLToPath(new URL('../src/tenant-store.ts', import.meta.url))))).toBe('src')
  })
})

describe('shutdown goes through the package store', () => {
  it('closeAllPools closes the package store and counts the catalogue pool', async () => {
    await storeFor(A, OPTS)
    const counts = await closeAllPools()
    expect(h.storeClosed).toBe(1)
    expect(counts.control).toBe(1)
    await expect(storeFor(A, OPTS)).rejects.toMatchObject({ code: 'SHUTTING_DOWN' })
  })

})
