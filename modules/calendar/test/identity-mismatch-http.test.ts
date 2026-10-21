/**
 * calendar leaf: a (tenant id, slug) pair the catalog does not bind is answered
 * 409 tenant_identity_mismatch (audit #534).
 *
 * storeFor refuses the pair (tenant-store.identity-binding.test.ts); this pins
 * what the caller sees. A refusal is neither a server fault (500) nor a served
 * request: the response names the refusal and carries nothing of either tenant.
 *
 * PG-free: the pool registry is seeded with a stand-in pool, so storeFor answers
 * on its warm path and never dials the (unreachable) url it is given.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import { createServer } from '../src/http/server.ts'
import { buildApiRoutes } from '../src/http/routes.ts'
import {
  storeFor,
  InvalidTenantIdError,
  TenantIdentityMismatchError,
  _poolRegistryForTests,
  _resetTenantStoreForTests,
  type Sql,
  type TenantRef,
} from '../src/tenant-store.ts'

const SECRET = 'identity-mismatch-secret'
const BOUND: TenantRef = { id: 'a1000000-0000-4000-8000-0000000000a1', slug: 'bind-a' }
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
      // Never port 5432. The warm path answers before any connection is made.
      return storeFor(t, { pgUrl: 'postgres://u:p@127.0.0.1:59999/postgres', dbPrefix: 'calendar_test_' })
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
    storeCalls = []
    _poolRegistryForTests.set(BOUND.id, stubPool(), BOUND.slug)
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
    const res = await fetch(`${base}${ROUTE}`, { headers: headers('control', 'a2000000-0000-4000-8000-0000000000a2') })
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
