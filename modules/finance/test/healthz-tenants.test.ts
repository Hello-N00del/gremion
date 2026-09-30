// test/healthz-tenants.test.ts -- F1-FIX-05-K (K4#32).
//
// /healthz/tenants was guard-exempt: any unauthenticated caller got every tenant's
// id and slug, per-tenant finance counts (bank accounts, bookings) and raw DB error
// text, and each call opened / migrated a pool for every tenant. It now sits behind
// the internal secret (401 otherwise) and answers booleans only; the detail is logged
// server-side. Plain /healthz stays unauthenticated (container healthcheck).

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import { createServer } from '../src/http/server.ts'
import type { Sql, TenantRef } from '../src/tenant-store.ts'

const SECRET = 'healthz-secret'
const T_OK: TenantRef = { id: 'aaaaaaaa-0000-4000-8000-00000000000a', slug: 'okay' }
const T_BAD: TenantRef = { id: 'bbbbbbbb-0000-4000-8000-00000000000b', slug: 'broken' }

function okSql(): Sql {
  const fn = (() => Promise.resolve([{ '?column?': 1, count: '7' }])) as unknown as Sql
  return fn
}

describe('/healthz/tenants (K4#32)', () => {
  let base: string
  let server: ReturnType<typeof createServer>
  const tenants: TenantRef[] = [T_OK]

  beforeAll(async () => {
    server = createServer({
      secret: SECRET,
      routes: [],
      healthz: {
        listTenants: async () => tenants,
        storeFn: async (t) => {
          if (t.id === T_BAD.id) throw new Error('connect ECONNREFUSED leak-marker-host detail=leak-marker-detail')
          return okSql()
        },
      },
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('unauthenticated -> 401 and no tenant data', async () => {
    const res = await fetch(`${base}/healthz/tenants`)
    expect(res.status).toBe(401)
    const text = await res.text()
    expect(text).not.toContain(T_OK.id)
    expect(text).not.toContain(T_OK.slug)
  })

  it('a wrong secret -> 401', async () => {
    const res = await fetch(`${base}/healthz/tenants`, { headers: { 'x-internal-auth': 'nope' } })
    expect(res.status).toBe(401)
  })

  it('with the internal secret -> booleans only: no ids, slugs, counts or error text', async () => {
    tenants.splice(0, tenants.length, T_OK)
    const res = await fetch(`${base}/healthz/tenants`, { headers: { 'x-internal-auth': SECRET } })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ success: true, db_ok: true })
  })

  it('a failing tenant -> 503 with booleans only; the detail goes to the server log', async () => {
    tenants.splice(0, tenants.length, T_OK, T_BAD)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const res = await fetch(`${base}/healthz/tenants`, { headers: { 'x-internal-auth': SECRET } })
      expect(res.status).toBe(503)
      const text = await res.text()
      expect(JSON.parse(text)).toEqual({ success: false, db_ok: false })
      expect(text).not.toMatch(/ECONNREFUSED|leak-marker|broken|bbbbbbbb/)
      expect(spy.mock.calls.flat().join(' ')).toContain(T_BAD.id)
    } finally {
      spy.mockRestore()
    }
  })

  it('plain /healthz stays unauthenticated', async () => {
    const res = await fetch(`${base}/healthz`)
    expect(res.status).toBe(200)
  })
})
