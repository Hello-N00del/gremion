/**
 * calendar leaf: a (tenant id, slug) pair the catalog does not bind is answered
 * 409 tenant_identity_mismatch (audit #534).
 *
 * storeFor refuses the pair (tenant-store.identity-binding.test.ts); this pins
 * what the caller sees. A refusal is neither a server fault (500) nor a served
 * request: the response names the refusal and carries nothing of either tenant.
 *
 * Also what the caller sees of the lifecycle refusals: a customer whose calendar database is gone or
 * blocked (the module is switched off) is 404 tenant_not_provisioned, one whose schema is not current or
 * whose connection was lost is 503 with Retry-After, and a query that fails because the database went away
 * under it is the same state, never a 500.
 *
 * PG-free: `postgres` and the package store are the stand-ins of support/fake-lifecycle-store.ts; the
 * bound slug is set by one real storeFor call, so later calls answer on the warm path.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import type { AddressInfo } from 'node:net'

vi.mock('postgres', async () => ({ default: (await import('./support/fake-lifecycle-store.ts')).fakePostgres }))
vi.mock('@gremion/tenant-store', async (importOriginal) =>
  (await import('./support/fake-lifecycle-store.ts')).fakeTenantStorePackage(await importOriginal<object>()),
)
import { fake, resetFake } from './support/fake-lifecycle-store.ts'

const { createServer } = await import('../src/http/server.ts')
const { buildApiRoutes } = await import('../src/http/routes.ts')
const {
  storeFor,
  InvalidTenantIdError,
  TenantIdentityMismatchError,
  TenantNotProvisionedError,
  TenantUnavailableError,
  _resetTenantStoreForTests,
} = await import('../src/tenant-store.ts')
type Sql = import('../src/tenant-store.ts').Sql
type TenantRef = import('../src/tenant-store.ts').TenantRef

const SECRET = 'identity-mismatch-secret'
const BOUND: TenantRef = { id: '01920000-0000-7000-8000-0000000000a1', slug: 'bind-a' }
const STORE_OPTS = {
  // Never port 5432. Nothing is dialled: the driver is the stand-in.
  pgUrl: 'postgres://u:p@127.0.0.1:59999/postgres',
  dbPrefix: 'calendar_test_',
  moduleUrl: 'postgres://m_calendar_app:p@127.0.0.1:59999/postgres',
} as const
const ROUTE = '/api/v1/event-types'

const headers = (slug: string, id: string = BOUND.id): Record<string, string> => ({
  'x-internal-auth': SECRET,
  'x-tenant-id': id,
  'x-tenant-slug': slug,
  'content-type': 'application/json',
})

/** A pool that answers every query with no rows: enough for a list route. */
function stubPool(): Sql {
  const pool = Object.assign((..._args: unknown[]) => Promise.resolve([]), {
    end: () => Promise.resolve(),
    begin: async (cb: (tx: unknown) => unknown) => cb(pool),
  })
  return pool as unknown as Sql
}

describe('calendar http: tenant_identity_mismatch', () => {
  let base: string
  let server: ReturnType<typeof createServer>
  let storeCalls: TenantRef[] = []

  beforeAll(async () => {
    const storeFn = (t: TenantRef): Promise<Sql> => {
      storeCalls.push(t)
      return storeFor(t, STORE_OPTS)
    }
    server = createServer({ secret: SECRET, routes: buildApiRoutes(storeFn) })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await _resetTenantStoreForTests()
  })

  beforeEach(async () => {
    await _resetTenantStoreForTests()
    resetFake()
    fake.tenantPool = stubPool()
    await storeFor(BOUND, STORE_OPTS)
    storeCalls = []
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('the bound slug is served', async () => {
    const res = await fetch(`${base}${ROUTE}`, { headers: headers(BOUND.slug) })
    expect(res.status).not.toBe(409)
    expect(res.status).toBeLessThan(500)
  })

  it.each(['not-a-uuid', BOUND.id.toUpperCase(), '11111111-1111-1111-1111-111111111111', ''])(
    'an x-tenant-id that is not a canonical lowercase uuid (%j) is a 400 at the guard, before any store access',
    async (id) => {
      const res = await fetch(`${base}${ROUTE}`, { headers: headers(BOUND.slug, id) })
      expect(res.status).toBe(400)
      expect(storeCalls).toHaveLength(0)
    },
  )

  it('a canonical lowercase uuid that is not a UUIDv7 passes the guard and is refused by the store as a 400 invalid_tenant_id', async () => {
    const res = await fetch(`${base}${ROUTE}`, { headers: headers(BOUND.slug, 'a1000000-0000-4000-8000-0000000000a1') })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ success: false, error: 'invalid_tenant_id' })
    expect(storeCalls).toHaveLength(1)
  })

  it('another slug for the same id is a 409 tenant_identity_mismatch, not a 500 and not a served response', async () => {
    const res = await fetch(`${base}${ROUTE}`, { headers: headers('bind-b') })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { success: boolean; error: string }
    expect(body).toEqual({ success: false, error: 'tenant_identity_mismatch' })
    expect(storeCalls).toHaveLength(1)
  })

  it('the refusal body names neither tenant', async () => {
    const res = await fetch(`${base}${ROUTE}`, { headers: headers('bind-b') })
    const text = await res.text()
    expect(text).not.toContain(BOUND.id)
    expect(text).not.toContain(BOUND.slug)
    expect(text).not.toContain('bind-b')
  })

  it('the reserved slug "control" reaches the store and is a 400 invalid_tenant_slug, not a 500', async () => {
    const res = await fetch(`${base}${ROUTE}`, { headers: headers('control', '01920000-0000-7000-8000-0000000000a2') })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ success: false, error: 'invalid_tenant_slug' })
    expect(storeCalls).toHaveLength(1)
  })

  it('exports the refusal as a coded error', () => {
    const err = new TenantIdentityMismatchError(BOUND, { id: BOUND.id, slug: 'other' })
    expect(err).toBeInstanceOf(Error)
    expect(err.code).toBe('TENANT_IDENTITY_MISMATCH')
    expect(err.name).toBe('TenantIdentityMismatchError')
  })
})

describe('calendar http: the lifecycle refusals', () => {
  let base: string
  let server: ReturnType<typeof createServer>
  let next: () => Promise<Sql>

  beforeAll(async () => {
    server = createServer({ secret: SECRET, routes: buildApiRoutes(() => next()) })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  const get = (): Promise<Response> => fetch(`${base}${ROUTE}`, { headers: headers(BOUND.slug) })

  it('TenantNotProvisionedError is a 404 tenant_not_provisioned that names nothing', async () => {
    next = () => Promise.reject(new TenantNotProvisionedError())
    const res = await get()
    expect(res.status).toBe(404)
    const text = await res.text()
    expect(JSON.parse(text)).toEqual({ success: false, error: 'tenant_not_provisioned' })
    expect(text).not.toContain(BOUND.id)
  })

  it('TenantUnavailableError is a 503 with its reason and Retry-After', async () => {
    next = () => Promise.reject(new TenantUnavailableError('schema_not_current', 30))
    const res = await get()
    expect(res.status).toBe(503)
    expect(res.headers.get('retry-after')).toBe('30')
    expect(await res.json()).toEqual({ success: false, error: 'schema_not_current' })
  })

  it('a query that fails because the database is gone (3D000) is a 404, not a 500', async () => {
    next = () => Promise.reject(Object.assign(new Error('database does not exist'), { code: '3D000' }))
    expect((await get()).status).toBe(404)
  })

  it.each(['57P01', 'CONNECTION_CLOSED', 'ECONNRESET'])('a connection lost under the query (%s) is a 503 with Retry-After, not a 500', async (code) => {
    next = () => Promise.reject(Object.assign(new Error('terminating connection'), { code }))
    const res = await get()
    expect(res.status).toBe(503)
    expect(res.headers.get('retry-after')).toBe('30')
    expect(await res.json()).toEqual({ success: false, error: 'tenant_unavailable' })
  })

  it('any other database error is still a 500: only the availability of the database is mapped', async () => {
    next = () => Promise.reject(Object.assign(new Error('permission denied for table x'), { code: '42501' }))
    expect((await get()).status).toBe(500)
  })
})

describe('calendar http: invalid_tenant_id', () => {
  let base: string
  let server: ReturnType<typeof createServer>

  beforeAll(async () => {
    // A store that refuses the id the way tenant-store does when the guard is bypassed.
    server = createServer({
      secret: SECRET,
      routes: buildApiRoutes(() => Promise.reject(new InvalidTenantIdError())),
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('InvalidTenantIdError is a 400 invalid_tenant_id that names nothing, not a 500', async () => {
    const res = await fetch(`${base}${ROUTE}`, { headers: headers(BOUND.slug) })
    expect(res.status).toBe(400)
    const text = await res.text()
    expect(JSON.parse(text)).toEqual({ success: false, error: 'invalid_tenant_id' })
    expect(text).not.toContain(BOUND.id)
    expect(text).not.toContain(BOUND.slug)
  })

  it('exports the refusal as a coded error', () => {
    const err = new InvalidTenantIdError()
    expect(err).toBeInstanceOf(Error)
    expect(err.code).toBe('TENANT_ID_INVALID')
    expect(err.name).toBe('InvalidTenantIdError')
  })
})
