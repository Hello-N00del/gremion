/**
 * Integration tests for services/newsletter/src/http/routes.ts (Task 9)
 *
 * Supertest-style tests: each test creates an in-process node:http server
 * backed by a REAL per-tenant Postgres store (NEWSLETTER_TEST_PG_URL). The
 * guard is wired with a fixed test secret so we can exercise both the happy
 * path (with correct headers) and the guard rejection paths.
 *
 * Coverage:
 *  - POST/GET /api/v1/lists (happy + 4xx)
 *  - DELETE /api/v1/lists/:id
 *  - POST/GET /api/v1/lists/:id/members
 *  - DELETE /api/v1/lists/:id/members/:memberId
 *  - POST/GET /api/v1/newsletters (happy + 4xx)
 *  - GET/PATCH /api/v1/newsletters/:id (happy + 404)
 *  - PUT /api/v1/newsletters/:id/recipients
 *  - POST /api/v1/newsletters/:id/schedule
 *  - POST /api/v1/newsletters/:id/send -> 202; second -> 409
 *  - POST /api/v1/unsubscribe -> {ok} | {reason:'invalid'|'expired'}
 *  - GET /api/v1/stats
 *  - POST /api/v1/newsletters/:id/audit
 *  - GET /healthz -> 200 (guard-exempt)
 *  - Guard: 403 without secret; 400 without tenant headers
 *  - Tenant isolation: two tenant header sets -> disjoint data
 *
 * Fail-closed guard: refuses to run unless host is localhost/127.0.0.1
 * and all test DBs use the newsletter_test_ prefix.
 */
import http from 'node:http'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import { storeFor, _resetTenantStoreForTests, type TenantRef } from '../src/tenant-store.ts'
import { createServer } from '../src/http/server.ts'
import { buildApiRoutes } from '../src/http/routes.ts'
import { addSendToken, claimNewsletterForSending } from '../src/store/index.ts'
import { requireEphemeralTestPgUrl, assertSafeTestEnv } from './support/pg-test-guard.ts'

// -- fail-closed guard --------------------------------------------------------

const TEST_PG_URL = requireEphemeralTestPgUrl()
const TEST_DB_PREFIX = 'newsletter_test_'
assertSafeTestEnv(TEST_PG_URL, TEST_DB_PREFIX)

// -- test tenants -------------------------------------------------------------

const T1: TenantRef = { id: 'a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1', slug: 'apitenant1' }
const T2: TenantRef = { id: 'b2b2b2b2-b2b2-42b2-82b2-b2b2b2b2b2b2', slug: 'apitenant2' }

const TEST_SECRET = 'test-api-secret-123'

// -- in-process HTTP helpers --------------------------------------------------

function guardHeaders(tenant: TenantRef): Record<string, string> {
  return {
    'x-internal-auth': TEST_SECRET,
    'x-tenant-id': tenant.id,
    'x-tenant-slug': tenant.slug,
    'content-type': 'application/json',
  }
}

interface FetchResult {
  status: number
  body: unknown
}

async function callServer(
  srv: http.Server,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<FetchResult> {
  const addr = srv.address()
  if (!addr || typeof addr === 'string') throw new Error('server not listening')
  const port = addr.port

  return new Promise<FetchResult>((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          ...headers,
          ...(payload !== undefined
            ? { 'content-length': Buffer.byteLength(payload).toString() }
            : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8')
          let parsed: unknown
          try {
            parsed = JSON.parse(raw)
          } catch {
            parsed = raw
          }
          resolve({ status: res.statusCode ?? 0, body: parsed })
        })
      },
    )
    req.on('error', reject)
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

// -- setup --------------------------------------------------------------------

let admin: ReturnType<typeof postgres>
let sql1: Awaited<ReturnType<typeof storeFor>>
let sql2: Awaited<ReturnType<typeof storeFor>>
let server: http.Server

async function dropTestApiDbs(pgSql: ReturnType<typeof postgres>): Promise<void> {
  const rows = await pgSql<{ datname: string }[]>`
    SELECT datname FROM pg_database WHERE datname LIKE 'newsletter_test_apitenant%'
  `
  for (const { datname } of rows) {
    await pgSql.unsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${datname}' AND pid <> pg_backend_pid()`,
    )
    await pgSql.unsafe(`DROP DATABASE IF EXISTS "${datname}"`)
  }
  await pgSql
    .unsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'newsletter_test_control' AND pid <> pg_backend_pid()`,
    )
    .catch(() => {})
  await pgSql.unsafe(`DROP DATABASE IF EXISTS "newsletter_test_control"`).catch(() => {})
}

beforeAll(async () => {
  admin = postgres(TEST_PG_URL, { max: 1, prepare: false })
  await dropTestApiDbs(admin)

  sql1 = await storeFor(T1, { pgUrl: TEST_PG_URL, dbPrefix: TEST_DB_PREFIX })
  sql2 = await storeFor(T2, { pgUrl: TEST_PG_URL, dbPrefix: TEST_DB_PREFIX })

  const routes = buildApiRoutes(async (tenant) => {
    if (tenant.id === T1.id) return sql1
    if (tenant.id === T2.id) return sql2
    throw new Error(`unknown test tenant: ${tenant.id}`)
  })

  server = createServer({ secret: TEST_SECRET, routes })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await _resetTenantStoreForTests()
  await dropTestApiDbs(admin)
  await admin.end()
})

beforeEach(async () => {
  for (const sql of [sql1, sql2]) {
    await sql`DELETE FROM newsletter_audit`
    await sql`DELETE FROM send_tokens`
    await sql`DELETE FROM unsubscribes`
    await sql`DELETE FROM newsletter_recipients`
    await sql`DELETE FROM deliveries`
    await sql`DELETE FROM outbox`
    await sql`DELETE FROM newsletters`
    await sql`DELETE FROM mailing_list_members`
    await sql`DELETE FROM mailing_lists`
  }
})

// -- /healthz (guard-exempt) --------------------------------------------------

describe('GET /healthz', () => {
  it('returns 200 without any auth headers', async () => {
    const r = await callServer(server, 'GET', '/healthz', {})
    expect(r.status).toBe(200)
    expect((r.body as Record<string, unknown>)['status']).toBe('ok')
  })
})

// -- guard --------------------------------------------------------------------

describe('guard', () => {
  it('returns 403 without x-internal-auth', async () => {
    const r = await callServer(server, 'GET', '/api/v1/lists', {
      'x-tenant-id': T1.id,
      'x-tenant-slug': T1.slug,
    })
    expect(r.status).toBe(403)
    expect((r.body as Record<string, unknown>)['success']).toBe(false)
  })

  it('returns 403 with wrong secret', async () => {
    const r = await callServer(server, 'GET', '/api/v1/lists', {
      'x-internal-auth': 'wrong-secret',
      'x-tenant-id': T1.id,
      'x-tenant-slug': T1.slug,
    })
    expect(r.status).toBe(403)
  })

  it('returns 400 with missing x-tenant-id', async () => {
    const r = await callServer(server, 'GET', '/api/v1/lists', {
      'x-internal-auth': TEST_SECRET,
      'x-tenant-slug': T1.slug,
    })
    expect(r.status).toBe(400)
    expect(((r.body as Record<string, unknown>)['error'] as string)).toMatch(/x-tenant-id/)
  })
})

// -- mailing lists ------------------------------------------------------------

describe('POST /api/v1/lists', () => {
  it('creates a list and returns 201', async () => {
    const r = await callServer(server, 'POST', '/api/v1/lists', guardHeaders(T1), {
      name: 'AStA Verteiler',
    })
    expect(r.status).toBe(201)
    const data = (r.body as { data: { id: number; name: string } }).data
    expect(data.id).toBeTypeOf('number')
    expect(data.name).toBe('AStA Verteiler')
  })

  it('returns 400 on missing name', async () => {
    const r = await callServer(server, 'POST', '/api/v1/lists', guardHeaders(T1), {})
    expect(r.status).toBe(400)
    expect((r.body as Record<string, unknown>)['success']).toBe(false)
  })
})

describe('GET /api/v1/lists', () => {
  it('returns empty array initially', async () => {
    const r = await callServer(server, 'GET', '/api/v1/lists', guardHeaders(T1))
    expect(r.status).toBe(200)
    expect((r.body as { data: unknown[] }).data).toEqual([])
  })

  it('returns created lists', async () => {
    await callServer(server, 'POST', '/api/v1/lists', guardHeaders(T1), { name: 'List A' })
    const r = await callServer(server, 'GET', '/api/v1/lists', guardHeaders(T1))
    expect((r.body as { data: unknown[] }).data).toHaveLength(1)
  })
})

describe('DELETE /api/v1/lists/:id', () => {
  it('deletes a list', async () => {
    const created = await callServer(server, 'POST', '/api/v1/lists', guardHeaders(T1), {
      name: 'ToDelete',
    })
    const id = (created.body as { data: { id: number } }).data.id
    const r = await callServer(server, 'DELETE', `/api/v1/lists/${id}`, guardHeaders(T1))
    expect(r.status).toBe(200)
    const list = await callServer(server, 'GET', '/api/v1/lists', guardHeaders(T1))
    expect((list.body as { data: unknown[] }).data).toHaveLength(0)
  })
})

describe('POST /api/v1/lists/:id/members', () => {
  it('adds a member and returns 201', async () => {
    const created = await callServer(server, 'POST', '/api/v1/lists', guardHeaders(T1), {
      name: 'Members List',
    })
    const listId = (created.body as { data: { id: number } }).data.id
    const r = await callServer(
      server,
      'POST',
      `/api/v1/lists/${listId}/members`,
      guardHeaders(T1),
      { email: 'alice@example.com', name: 'Alice', source: 'manual' },
    )
    expect(r.status).toBe(201)
  })

  it('returns 400 on invalid email', async () => {
    const r = await callServer(server, 'POST', '/api/v1/lists/1/members', guardHeaders(T1), {
      email: 'not-an-email',
    })
    expect(r.status).toBe(400)
  })
})

describe('GET /api/v1/lists/:id/members', () => {
  it('returns members for a list', async () => {
    const created = await callServer(server, 'POST', '/api/v1/lists', guardHeaders(T1), {
      name: 'My List',
    })
    const listId = (created.body as { data: { id: number } }).data.id
    await callServer(server, 'POST', `/api/v1/lists/${listId}/members`, guardHeaders(T1), {
      email: 'bob@example.com',
      name: 'Bob',
    })
    const r = await callServer(server, 'GET', `/api/v1/lists/${listId}/members`, guardHeaders(T1))
    expect(r.status).toBe(200)
    const members = (r.body as { data: { email: string }[] }).data
    expect(members).toHaveLength(1)
    expect(members[0]!.email).toBe('bob@example.com')
  })
})

describe('DELETE /api/v1/lists/:id/members/:memberId', () => {
  it('deletes a member', async () => {
    const created = await callServer(server, 'POST', '/api/v1/lists', guardHeaders(T1), {
      name: 'List',
    })
    const listId = (created.body as { data: { id: number } }).data.id
    await callServer(server, 'POST', `/api/v1/lists/${listId}/members`, guardHeaders(T1), {
      email: 'carol@example.com',
    })
    const membersRes = await callServer(
      server,
      'GET',
      `/api/v1/lists/${listId}/members`,
      guardHeaders(T1),
    )
    const members = (membersRes.body as { data: { id: number }[] }).data
    const memberId = members[0]!.id
    const r = await callServer(
      server,
      'DELETE',
      `/api/v1/lists/${listId}/members/${memberId}`,
      guardHeaders(T1),
    )
    expect(r.status).toBe(200)
    const after = await callServer(
      server,
      'GET',
      `/api/v1/lists/${listId}/members`,
      guardHeaders(T1),
    )
    expect((after.body as { data: unknown[] }).data).toHaveLength(0)
  })
})

// -- newsletters --------------------------------------------------------------

const NL_BODY = {
  title: 'Juni-Newsletter',
  odt_path: '/files/juni.odt',
  subject: 'StuRa Aktuell Juni',
  created_by: 'sub-abc',
}

describe('POST /api/v1/newsletters', () => {
  it('creates a newsletter and returns 201', async () => {
    const r = await callServer(server, 'POST', '/api/v1/newsletters', guardHeaders(T1), NL_BODY)
    expect(r.status).toBe(201)
    const data = (r.body as { data: { id: number; title: string; status: string } }).data
    expect(data.id).toBeTypeOf('number')
    expect(data.title).toBe(NL_BODY.title)
    expect(data.status).toBe('draft')
  })

  it('returns 400 when title is missing', async () => {
    const r = await callServer(server, 'POST', '/api/v1/newsletters', guardHeaders(T1), {
      odt_path: '/files/x.odt',
      subject: 'Subject',
      created_by: 'sub',
    })
    expect(r.status).toBe(400)
  })
})

describe('GET /api/v1/newsletters', () => {
  it('returns all newsletters', async () => {
    await callServer(server, 'POST', '/api/v1/newsletters', guardHeaders(T1), NL_BODY)
    const r = await callServer(server, 'GET', '/api/v1/newsletters', guardHeaders(T1))
    expect(r.status).toBe(200)
    expect((r.body as { data: unknown[] }).data).toHaveLength(1)
  })
})

describe('GET /api/v1/newsletters/:id', () => {
  it('returns a newsletter by id', async () => {
    const c = await callServer(server, 'POST', '/api/v1/newsletters', guardHeaders(T1), NL_BODY)
    const id = (c.body as { data: { id: number } }).data.id
    const r = await callServer(server, 'GET', `/api/v1/newsletters/${id}`, guardHeaders(T1))
    expect(r.status).toBe(200)
    expect((r.body as { data: { id: number } }).data.id).toBe(id)
  })

  it('returns 404 for unknown id', async () => {
    const r = await callServer(server, 'GET', '/api/v1/newsletters/99999', guardHeaders(T1))
    expect(r.status).toBe(404)
  })
})

describe('PATCH /api/v1/newsletters/:id', () => {
  it('patches the subject', async () => {
    const c = await callServer(server, 'POST', '/api/v1/newsletters', guardHeaders(T1), NL_BODY)
    const id = (c.body as { data: { id: number } }).data.id
    const r = await callServer(server, 'PATCH', `/api/v1/newsletters/${id}`, guardHeaders(T1), {
      subject: 'Updated Subject',
    })
    expect(r.status).toBe(200)
    expect((r.body as { data: { subject: string } }).data.subject).toBe('Updated Subject')
  })

  it('returns 404 for unknown id', async () => {
    const r = await callServer(server, 'PATCH', '/api/v1/newsletters/99999', guardHeaders(T1), {
      subject: 'x',
    })
    expect(r.status).toBe(404)
  })
})

describe('PUT /api/v1/newsletters/:id/recipients', () => {
  it('sets recipients and returns them', async () => {
    const c = await callServer(server, 'POST', '/api/v1/newsletters', guardHeaders(T1), NL_BODY)
    const nlId = (c.body as { data: { id: number } }).data.id

    const listRes = await callServer(server, 'POST', '/api/v1/lists', guardHeaders(T1), {
      name: 'Recipient List',
    })
    const listId = (listRes.body as { data: { id: number } }).data.id

    const r = await callServer(
      server,
      'PUT',
      `/api/v1/newsletters/${nlId}/recipients`,
      guardHeaders(T1),
      { recipients: [{ mailing_list_id: listId }] },
    )
    expect(r.status).toBe(200)
    const data = (r.body as { data: { mailing_list_id: number }[] }).data
    expect(data).toHaveLength(1)
    expect(data[0]!.mailing_list_id).toBe(listId)
  })
})

describe('GET /api/v1/newsletters/:id/recipients', () => {
  it('returns an empty set for a newsletter with no recipients', async () => {
    const c = await callServer(server, 'POST', '/api/v1/newsletters', guardHeaders(T1), NL_BODY)
    const nlId = (c.body as { data: { id: number } }).data.id
    const r = await callServer(
      server,
      'GET',
      `/api/v1/newsletters/${nlId}/recipients`,
      guardHeaders(T1),
    )
    // Regression: this path used to 405 (only PUT was registered), which the
    // kernel ACL surfaced as a 500 on the /newsletter page.
    expect(r.status).toBe(200)
    expect((r.body as { data: unknown[] }).data).toEqual([])
  })

  it('returns the recipient set previously written via PUT', async () => {
    const c = await callServer(server, 'POST', '/api/v1/newsletters', guardHeaders(T1), NL_BODY)
    const nlId = (c.body as { data: { id: number } }).data.id
    const listRes = await callServer(server, 'POST', '/api/v1/lists', guardHeaders(T1), {
      name: 'GET Recipients List',
    })
    const listId = (listRes.body as { data: { id: number } }).data.id
    await callServer(server, 'PUT', `/api/v1/newsletters/${nlId}/recipients`, guardHeaders(T1), {
      recipients: [{ mailing_list_id: listId }],
    })

    const r = await callServer(
      server,
      'GET',
      `/api/v1/newsletters/${nlId}/recipients`,
      guardHeaders(T1),
    )
    expect(r.status).toBe(200)
    const data = (r.body as { data: { newsletter_id: number; mailing_list_id: number }[] }).data
    expect(data).toHaveLength(1)
    expect(data[0]!.newsletter_id).toBe(nlId)
    expect(data[0]!.mailing_list_id).toBe(listId)
  })

  it('returns 404 for an unknown newsletter', async () => {
    const r = await callServer(
      server,
      'GET',
      '/api/v1/newsletters/99999/recipients',
      guardHeaders(T1),
    )
    expect(r.status).toBe(404)
  })
})

describe('POST /api/v1/newsletters/:id/schedule', () => {
  it('schedules a newsletter', async () => {
    const c = await callServer(server, 'POST', '/api/v1/newsletters', guardHeaders(T1), NL_BODY)
    const id = (c.body as { data: { id: number } }).data.id
    const scheduledAt = new Date(Date.now() + 3600_000).toISOString()
    const r = await callServer(
      server,
      'POST',
      `/api/v1/newsletters/${id}/schedule`,
      guardHeaders(T1),
      { scheduled_at: scheduledAt },
    )
    expect(r.status).toBe(200)
    expect((r.body as { data: { status: string } }).data.status).toBe('scheduled')
  })

  it('returns 400 on invalid datetime', async () => {
    const c = await callServer(server, 'POST', '/api/v1/newsletters', guardHeaders(T1), NL_BODY)
    const id = (c.body as { data: { id: number } }).data.id
    const r = await callServer(
      server,
      'POST',
      `/api/v1/newsletters/${id}/schedule`,
      guardHeaders(T1),
      { scheduled_at: 'not-a-date' },
    )
    expect(r.status).toBe(400)
  })
})

// -- send: 202 + 409 ----------------------------------------------------------

describe('POST /api/v1/newsletters/:id/send', () => {
  it('returns 202 on first send (draft newsletter)', async () => {
    const c = await callServer(server, 'POST', '/api/v1/newsletters', guardHeaders(T1), NL_BODY)
    const id = (c.body as { data: { id: number } }).data.id
    const r = await callServer(
      server,
      'POST',
      `/api/v1/newsletters/${id}/send`,
      guardHeaders(T1),
      { actor: 'sub-abc' },
    )
    expect(r.status).toBe(202)
    expect((r.body as { success: boolean }).success).toBe(true)
  })

  it('returns 409 when newsletter is already sending', async () => {
    const c = await callServer(server, 'POST', '/api/v1/newsletters', guardHeaders(T1), NL_BODY)
    const id = (c.body as { data: { id: number } }).data.id

    // Force status=sending via store directly (no PATCH-status backdoor).
    await claimNewsletterForSending(sql1, id)

    const r = await callServer(
      server,
      'POST',
      `/api/v1/newsletters/${id}/send`,
      guardHeaders(T1),
      { actor: 'sub-abc' },
    )
    expect(r.status).toBe(409)
    expect((r.body as { success: boolean }).success).toBe(false)
  })

  it('returns 409 when newsletter is already sent', async () => {
    const c = await callServer(server, 'POST', '/api/v1/newsletters', guardHeaders(T1), NL_BODY)
    const id = (c.body as { data: { id: number } }).data.id

    // Force status=sent via direct SQL (no PATCH-status backdoor).
    await sql1`UPDATE newsletters SET status = 'sent' WHERE id = ${id}`

    const r = await callServer(
      server,
      'POST',
      `/api/v1/newsletters/${id}/send`,
      guardHeaders(T1),
      { actor: 'sub-abc' },
    )
    expect(r.status).toBe(409)
  })

  it('returns 404 for unknown newsletter', async () => {
    const r = await callServer(server, 'POST', '/api/v1/newsletters/99999/send', guardHeaders(T1), {
      actor: 'sub',
    })
    expect(r.status).toBe(404)
  })

  it('returns 400 when actor is missing', async () => {
    const c = await callServer(server, 'POST', '/api/v1/newsletters', guardHeaders(T1), NL_BODY)
    const id = (c.body as { data: { id: number } }).data.id
    const r = await callServer(
      server,
      'POST',
      `/api/v1/newsletters/${id}/send`,
      guardHeaders(T1),
      {},
    )
    expect(r.status).toBe(400)
  })
})

// -- unsubscribe --------------------------------------------------------------

describe('POST /api/v1/unsubscribe', () => {
  it('returns {ok:false,reason:"invalid"} for unknown token', async () => {
    const r = await callServer(server, 'POST', '/api/v1/unsubscribe', guardHeaders(T1), {
      token: 'nonexistent-token-abc',
    })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ ok: false, reason: 'invalid' })
  })

  it('returns {ok:true} for a valid token', async () => {
    const c = await callServer(server, 'POST', '/api/v1/newsletters', guardHeaders(T1), NL_BODY)
    const nlId = (c.body as { data: { id: number } }).data.id
    const token = 'valid-test-token-xyz'
    await addSendToken(sql1, token, nlId, 'dave@example.com')

    const r = await callServer(server, 'POST', '/api/v1/unsubscribe', guardHeaders(T1), { token })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ ok: true })
  })

  it('returns 400 when token is missing', async () => {
    const r = await callServer(server, 'POST', '/api/v1/unsubscribe', guardHeaders(T1), {})
    expect(r.status).toBe(400)
  })
})

// -- stats --------------------------------------------------------------------

describe('GET /api/v1/stats', () => {
  it('returns subscriber and newsletter counts', async () => {
    const listRes = await callServer(server, 'POST', '/api/v1/lists', guardHeaders(T1), {
      name: 'Stats List',
    })
    const listId = (listRes.body as { data: { id: number } }).data.id
    await callServer(server, 'POST', `/api/v1/lists/${listId}/members`, guardHeaders(T1), {
      email: 'eve@example.com',
    })
    await callServer(server, 'POST', '/api/v1/newsletters', guardHeaders(T1), NL_BODY)

    const r = await callServer(server, 'GET', '/api/v1/stats', guardHeaders(T1))
    expect(r.status).toBe(200)
    const data = (r.body as { data: { subscribers: number; newsletters: number } }).data
    expect(data.subscribers).toBe(1)
    expect(data.newsletters).toBe(1)
  })
})

// -- audit --------------------------------------------------------------------

describe('POST /api/v1/newsletters/:id/audit', () => {
  it('records an audit entry', async () => {
    const c = await callServer(server, 'POST', '/api/v1/newsletters', guardHeaders(T1), NL_BODY)
    const id = (c.body as { data: { id: number } }).data.id
    const r = await callServer(
      server,
      'POST',
      `/api/v1/newsletters/${id}/audit`,
      guardHeaders(T1),
      { actor_sub: 'sub-xyz', action: 'viewed' },
    )
    expect(r.status).toBe(200)
    expect((r.body as { success: boolean }).success).toBe(true)
  })

  it('returns 400 when action is missing', async () => {
    const c = await callServer(server, 'POST', '/api/v1/newsletters', guardHeaders(T1), NL_BODY)
    const id = (c.body as { data: { id: number } }).data.id
    const r = await callServer(
      server,
      'POST',
      `/api/v1/newsletters/${id}/audit`,
      guardHeaders(T1),
      { actor_sub: 'sub-xyz' },
    )
    expect(r.status).toBe(400)
  })

  it('returns 404 for unknown newsletter', async () => {
    const r = await callServer(
      server,
      'POST',
      '/api/v1/newsletters/99999/audit',
      guardHeaders(T1),
      { actor_sub: 'sub', action: 'viewed' },
    )
    expect(r.status).toBe(404)
  })
})

// -- tenant isolation ---------------------------------------------------------

describe('tenant isolation', () => {
  it('lists created under T1 are not visible to T2', async () => {
    await callServer(server, 'POST', '/api/v1/lists', guardHeaders(T1), { name: 'T1 Only' })
    const r = await callServer(server, 'GET', '/api/v1/lists', guardHeaders(T2))
    expect(r.status).toBe(200)
    expect((r.body as { data: unknown[] }).data).toHaveLength(0)
  })

  it('newsletters created under T1 are not visible to T2', async () => {
    await callServer(server, 'POST', '/api/v1/newsletters', guardHeaders(T1), NL_BODY)
    const r = await callServer(server, 'GET', '/api/v1/newsletters', guardHeaders(T2))
    expect(r.status).toBe(200)
    expect((r.body as { data: unknown[] }).data).toHaveLength(0)
  })

  it('members added under T1 are not accessible from T2', async () => {
    const listRes = await callServer(server, 'POST', '/api/v1/lists', guardHeaders(T1), {
      name: 'Isolated',
    })
    const listId = (listRes.body as { data: { id: number } }).data.id
    await callServer(server, 'POST', `/api/v1/lists/${listId}/members`, guardHeaders(T1), {
      email: 'franck@example.com',
    })
    // T2 may return 200 with empty data or non-200 — either proves isolation.
    const r = await callServer(server, 'GET', `/api/v1/lists/${listId}/members`, guardHeaders(T2))
    if (r.status === 200) {
      expect((r.body as { data: unknown[] }).data).toHaveLength(0)
    } else {
      expect(r.status).toBeGreaterThanOrEqual(400)
    }
  })
})
