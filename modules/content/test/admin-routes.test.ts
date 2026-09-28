/**
 * Unit tests for services/content/src/http/admin-routes.ts (Task 23 fix)
 *
 * Tests the secret-only guard and route dispatch for admin teardown endpoints.
 * Uses an in-process node:http server with a stub pgUrl / DB that never
 * actually connects (the handlers check auth before touching PG).
 *
 * No Postgres connection required — bad-secret / bad-param paths all return
 * before the PG call, and the PG call itself is tested via a fake pgUrl that
 * would fail at connection time (so we test up to the auth/validation layer).
 */
import http from 'node:http'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer } from '../src/http/server.ts'
import { buildAdminRoutes } from '../src/http/admin-routes.ts'
import { buildApiRoutes } from '../src/http/routes.ts'

const TEST_SECRET = 'test-admin-secret-xyz'
const VALID_UUID = '11111111-2222-3333-4444-555555555555'
const VALID_SLUG = 'my-tenant'

// ── tiny test HTTP client ─────────────────────────────────────────────────────

interface FetchResponse {
  status: number
  body: unknown
}

function request(
  server: http.Server,
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<FetchResponse> {
  return new Promise((resolve, reject) => {
    const addr = server.address()
    if (!addr || typeof addr === 'string') {
      return reject(new Error('server not listening'))
    }
    const req = http.request(
      { host: '127.0.0.1', port: addr.port, method, path, headers },
      (res) => {
        let data = ''
        res.on('data', (chunk: Buffer) => { data += chunk.toString() })
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) })
          } catch {
            resolve({ status: res.statusCode ?? 0, body: data })
          }
        })
      },
    )
    req.on('error', reject)
    req.end()
  })
}

// ── server setup ──────────────────────────────────────────────────────────────

let server: http.Server

beforeAll(async () => {
  const adminRoutes = buildAdminRoutes({
    secret: TEST_SECRET,
    // Use an invalid pgUrl — tests that hit PG would fail, but the guard/validation
    // tests we care about return BEFORE the PG call.
    pgUrl: 'postgres://invalid@localhost:1/nonexistent',
  })
  server = createServer({
    secret: TEST_SECRET,
    routes: buildApiRoutes(() => Promise.reject(new Error('no store in admin tests'))),
    adminRoutes,
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  )
})

// ── DELETE /api/admin/tenants/:slug/db ────────────────────────────────────────

describe('DELETE /api/admin/tenants/:slug/db', () => {
  it('returns 403 when x-internal-auth is missing', async () => {
    const res = await request(server, 'DELETE', `/api/admin/tenants/${VALID_SLUG}/db`)
    expect(res.status).toBe(403)
    expect((res.body as { success: boolean }).success).toBe(false)
  })

  it('returns 403 when x-internal-auth is wrong', async () => {
    const res = await request(server, 'DELETE', `/api/admin/tenants/${VALID_SLUG}/db`, {
      'x-internal-auth': 'wrong-secret',
    })
    expect(res.status).toBe(403)
    expect((res.body as { success: boolean }).success).toBe(false)
  })

  it('returns 400 when slug contains invalid characters', async () => {
    const res = await request(server, 'DELETE', `/api/admin/tenants/INVALID_SLUG/db`, {
      'x-internal-auth': TEST_SECRET,
    })
    expect(res.status).toBe(400)
    expect((res.body as { success: boolean }).success).toBe(false)
  })

  it('returns 404 for GET on the drop-db path (method not allowed → 405)', async () => {
    const res = await request(server, 'GET', `/api/admin/tenants/${VALID_SLUG}/db`, {
      'x-internal-auth': TEST_SECRET,
    })
    expect(res.status).toBe(405)
  })
})

// ── DELETE /api/admin/tenants/:tenantId/catalog ───────────────────────────────

describe('DELETE /api/admin/tenants/:tenantId/catalog', () => {
  it('returns 403 when x-internal-auth is missing', async () => {
    const res = await request(server, 'DELETE', `/api/admin/tenants/${VALID_UUID}/catalog`)
    expect(res.status).toBe(403)
    expect((res.body as { success: boolean }).success).toBe(false)
  })

  it('returns 403 when x-internal-auth is wrong', async () => {
    const res = await request(server, 'DELETE', `/api/admin/tenants/${VALID_UUID}/catalog`, {
      'x-internal-auth': 'wrong-secret',
    })
    expect(res.status).toBe(403)
    expect((res.body as { success: boolean }).success).toBe(false)
  })

  it('returns 400 when tenantId is not a UUID', async () => {
    const res = await request(server, 'DELETE', `/api/admin/tenants/not-a-uuid/catalog`, {
      'x-internal-auth': TEST_SECRET,
    })
    expect(res.status).toBe(400)
    expect((res.body as { success: boolean }).success).toBe(false)
  })

  it('returns 404 for an unknown sub-path under /api/admin/', async () => {
    const res = await request(server, 'DELETE', `/api/admin/unknown/path`, {
      'x-internal-auth': TEST_SECRET,
    })
    expect(res.status).toBe(404)
  })
})

// ── admin routes do NOT require tenant headers ────────────────────────────────

describe('admin routes bypass tenant-header requirement', () => {
  it('returns 403 (auth) not 400 (missing tenant headers) for bad secret on drop-db', async () => {
    // If the server were routing this through checkGuard(), missing tenant headers
    // would yield 400. The 403 proves the admin path skips checkGuard entirely.
    const res = await request(server, 'DELETE', `/api/admin/tenants/${VALID_SLUG}/db`, {
      'x-internal-auth': 'wrong',
      // NOTE: no x-tenant-id or x-tenant-slug — would cause 400 through checkGuard
    })
    expect(res.status).toBe(403)
  })
})
