/**
 * Integration tests for services/content/src/http/routes.ts (Task 21)
 *
 * Supertest-style tests: each test creates an in-process node:http server
 * backed by a REAL per-tenant Postgres store (CONTENT_TEST_PG_URL). The
 * guard is wired with a fixed test secret so we can exercise both the happy
 * path (with correct headers) and the guard rejection paths.
 *
 * Coverage:
 *  - POST/GET /api/v1/lists (happy + 4xx)
 *  - DELETE /api/v1/lists/:id
 *  - POST/GET /api/v1/lists/:id/members
 *  - DELETE /api/v1/lists/:id/members/:memberId
 *  - POST/GET /api/v1/posts (happy + 4xx)
 *  - GET/PATCH /api/v1/posts/:id (happy + 404)
 *  - PUT /api/v1/posts/:id/recipients
 *  - POST /api/v1/posts/:id/publish -> 202; second -> 409
 *  - POST /api/v1/unsubscribe -> {ok} | {reason}
 *  - GET /api/v1/stats
 *  - POST /api/v1/posts/:id/audit
 *  - GET /healthz -> 200 (guard-exempt)
 *  - Guard: 403 without secret; 400 without tenant headers
 *  - Tenant isolation: two tenant header sets -> disjoint data
 *
 * Fail-closed guard: refuses to run unless host is localhost/127.0.0.1
 * and all test DBs use the content_test_ prefix.
 */
import http from 'node:http'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import { storeFor, _resetTenantStoreForTests, type TenantRef } from '../src/tenant-store.ts'
import { createServer } from '../src/http/server.ts'
import { buildApiRoutes } from '../src/http/routes.ts'
import { claimPostForPublish, addSendToken } from '../src/store/index.ts'
import { requireEphemeralTestPgUrl, assertSafeTestEnv } from './support/pg-test-guard.ts'

// -- fail-closed guard --------------------------------------------------------

const TEST_PG_URL = requireEphemeralTestPgUrl()
const TEST_DB_PREFIX = 'content_test_'
assertSafeTestEnv(TEST_PG_URL, TEST_DB_PREFIX)

// -- test tenants -------------------------------------------------------------

const T1: TenantRef = { id: 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1', slug: 'apitenant1' }
const T2: TenantRef = { id: 'b2b2b2b2-b2b2-b2b2-b2b2-b2b2b2b2b2b2', slug: 'apitenant2' }

const TEST_SECRET = 'test-content-api-secret-123'

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
    SELECT datname FROM pg_database WHERE datname LIKE 'content_test_apitenant%'
  `
  for (const { datname } of rows) {
    await pgSql.unsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${datname}' AND pid <> pg_backend_pid()`,
    )
    await pgSql.unsafe(`DROP DATABASE IF EXISTS "${datname}"`)
  }
  await pgSql
    .unsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'content_test_control' AND pid <> pg_backend_pid()`,
    )
    .catch(() => {})
  await pgSql.unsafe(`DROP DATABASE IF EXISTS "content_test_control"`).catch(() => {})
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
    await sql`DELETE FROM content.content_audit`
    await sql`DELETE FROM content.send_tokens`
    await sql`DELETE FROM content.unsubscribes`
    await sql`DELETE FROM content.post_recipients`
    await sql`DELETE FROM content.deliveries`
    await sql`DELETE FROM outbox`
    await sql`DELETE FROM content.publications`
    await sql`DELETE FROM content.publish_ops`
    await sql`DELETE FROM content.post_media`
    await sql`DELETE FROM content.posts`
    await sql`DELETE FROM content.mailing_list_members`
    await sql`DELETE FROM content.mailing_lists`
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
    const r = await callServer(server, 'GET', '/api/v1/posts', {
      'x-tenant-id': T1.id,
      'x-tenant-slug': T1.slug,
    })
    expect(r.status).toBe(403)
    expect((r.body as Record<string, unknown>)['success']).toBe(false)
  })

  it('returns 403 with wrong secret', async () => {
    const r = await callServer(server, 'GET', '/api/v1/posts', {
      'x-internal-auth': 'wrong-secret',
      'x-tenant-id': T1.id,
      'x-tenant-slug': T1.slug,
    })
    expect(r.status).toBe(403)
  })

  it('returns 400 with missing x-tenant-id', async () => {
    const r = await callServer(server, 'GET', '/api/v1/posts', {
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
    const data = r.body as { id: string; name: string }
    expect(typeof data.id).toBe('string')
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
    expect(r.body as unknown[]).toEqual([])
  })

  it('returns created lists', async () => {
    await callServer(server, 'POST', '/api/v1/lists', guardHeaders(T1), { name: 'List A' })
    const r = await callServer(server, 'GET', '/api/v1/lists', guardHeaders(T1))
    expect(r.body as unknown[]).toHaveLength(1)
  })
})

describe('DELETE /api/v1/lists/:id', () => {
  it('deletes a list', async () => {
    const created = await callServer(server, 'POST', '/api/v1/lists', guardHeaders(T1), {
      name: 'ToDelete',
    })
    const id = (created.body as { id: string }).id
    const r = await callServer(server, 'DELETE', `/api/v1/lists/${id}`, guardHeaders(T1))
    expect(r.status).toBe(200)
    const list = await callServer(server, 'GET', '/api/v1/lists', guardHeaders(T1))
    expect(list.body as unknown[]).toHaveLength(0)
  })
})

describe('POST /api/v1/lists/:id/members', () => {
  it('adds a member and returns 201', async () => {
    const created = await callServer(server, 'POST', '/api/v1/lists', guardHeaders(T1), {
      name: 'Members List',
    })
    const listId = (created.body as { id: string }).id
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
    const r = await callServer(server, 'POST', '/api/v1/lists/some-id/members', guardHeaders(T1), {
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
    const listId = (created.body as { id: string }).id
    await callServer(server, 'POST', `/api/v1/lists/${listId}/members`, guardHeaders(T1), {
      email: 'bob@example.com',
      name: 'Bob',
    })
    const r = await callServer(server, 'GET', `/api/v1/lists/${listId}/members`, guardHeaders(T1))
    expect(r.status).toBe(200)
    const members = r.body as { email: string }[]
    expect(members).toHaveLength(1)
    expect(members[0]!.email).toBe('bob@example.com')
  })
})

describe('DELETE /api/v1/lists/:id/members/:memberId', () => {
  it('deletes a member', async () => {
    const created = await callServer(server, 'POST', '/api/v1/lists', guardHeaders(T1), {
      name: 'List',
    })
    const listId = (created.body as { id: string }).id
    await callServer(server, 'POST', `/api/v1/lists/${listId}/members`, guardHeaders(T1), {
      email: 'carol@example.com',
    })
    const membersRes = await callServer(
      server,
      'GET',
      `/api/v1/lists/${listId}/members`,
      guardHeaders(T1),
    )
    const members = membersRes.body as { id: string }[]
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
    expect(after.body as unknown[]).toHaveLength(0)
  })
})

// -- posts --------------------------------------------------------------------

const POST_BODY = {
  title: 'Juni-Bulletin',
  body_html: '<p>Hello world</p>',
  created_by: 'sub-abc',
}

describe('POST /api/v1/posts', () => {
  it('creates a post and returns 201', async () => {
    const r = await callServer(server, 'POST', '/api/v1/posts', guardHeaders(T1), POST_BODY)
    expect(r.status).toBe(201)
    const data = r.body as { id: string; title: string; status: string }
    expect(typeof data.id).toBe('string')
    expect(data.title).toBe(POST_BODY.title)
    expect(data.status).toBe('draft')
  })

  it('returns 400 when title is missing', async () => {
    const r = await callServer(server, 'POST', '/api/v1/posts', guardHeaders(T1), {
      body_html: '<p>hi</p>',
      created_by: 'sub',
    })
    expect(r.status).toBe(400)
  })
})

describe('GET /api/v1/posts', () => {
  it('returns all posts', async () => {
    await callServer(server, 'POST', '/api/v1/posts', guardHeaders(T1), POST_BODY)
    const r = await callServer(server, 'GET', '/api/v1/posts', guardHeaders(T1))
    expect(r.status).toBe(200)
    expect(r.body as unknown[]).toHaveLength(1)
  })
})

describe('GET /api/v1/posts/:id', () => {
  it('returns a post by id', async () => {
    const c = await callServer(server, 'POST', '/api/v1/posts', guardHeaders(T1), POST_BODY)
    const id = (c.body as { id: string }).id
    const r = await callServer(server, 'GET', `/api/v1/posts/${id}`, guardHeaders(T1))
    expect(r.status).toBe(200)
    expect((r.body as { id: string }).id).toBe(id)
  })

  it('returns 404 for unknown id', async () => {
    const r = await callServer(server, 'GET', '/api/v1/posts/00000000-0000-0000-0000-000000000000', guardHeaders(T1))
    expect(r.status).toBe(404)
  })
})

describe('PATCH /api/v1/posts/:id', () => {
  it('patches the title', async () => {
    const c = await callServer(server, 'POST', '/api/v1/posts', guardHeaders(T1), POST_BODY)
    const id = (c.body as { id: string }).id
    const r = await callServer(server, 'PATCH', `/api/v1/posts/${id}`, guardHeaders(T1), {
      title: 'Updated Title',
    })
    expect(r.status).toBe(200)
    expect((r.body as { title: string }).title).toBe('Updated Title')
  })

  it('returns 404 for unknown id', async () => {
    const r = await callServer(server, 'PATCH', '/api/v1/posts/00000000-0000-0000-0000-000000000000', guardHeaders(T1), {
      title: 'x',
    })
    expect(r.status).toBe(404)
  })
})

describe('PUT /api/v1/posts/:id/recipients', () => {
  it('sets recipients and returns them', async () => {
    const c = await callServer(server, 'POST', '/api/v1/posts', guardHeaders(T1), POST_BODY)
    const postId = (c.body as { id: string }).id

    const listRes = await callServer(server, 'POST', '/api/v1/lists', guardHeaders(T1), {
      name: 'Recipient List',
    })
    const listId = (listRes.body as { id: string }).id

    const r = await callServer(
      server,
      'PUT',
      `/api/v1/posts/${postId}/recipients`,
      guardHeaders(T1),
      { channel: 'email', recipients: [{ mailing_list_id: listId }] },
    )
    expect(r.status).toBe(200)
    const data = (r.body as { data: { mailing_list_id: string }[] }).data
    expect(data).toHaveLength(1)
    expect(data[0]!.mailing_list_id).toBe(listId)
  })
})

// -- publish: 202 + 409 -------------------------------------------------------

describe('POST /api/v1/posts/:id/publish', () => {
  it('returns 202 on first publish (draft post)', async () => {
    const c = await callServer(server, 'POST', '/api/v1/posts', guardHeaders(T1), POST_BODY)
    const id = (c.body as { id: string }).id
    const r = await callServer(
      server,
      'POST',
      `/api/v1/posts/${id}/publish`,
      guardHeaders(T1),
      { actor: 'sub-abc' },
    )
    expect(r.status).toBe(202)
    expect((r.body as { success: boolean }).success).toBe(true)
  })

  it('returns 409 when post is already sending', async () => {
    const c = await callServer(server, 'POST', '/api/v1/posts', guardHeaders(T1), POST_BODY)
    const id = (c.body as { id: string }).id

    // Force status=sending via store directly.
    await claimPostForPublish(sql1, id)

    const r = await callServer(
      server,
      'POST',
      `/api/v1/posts/${id}/publish`,
      guardHeaders(T1),
      { actor: 'sub-abc' },
    )
    expect(r.status).toBe(409)
    expect((r.body as { success: boolean }).success).toBe(false)
  })

  it('returns 409 when post is already sent', async () => {
    const c = await callServer(server, 'POST', '/api/v1/posts', guardHeaders(T1), POST_BODY)
    const id = (c.body as { id: string }).id

    // Force status=sent via direct SQL.
    await sql1`UPDATE content.posts SET status = 'sent' WHERE id = ${id}`

    const r = await callServer(
      server,
      'POST',
      `/api/v1/posts/${id}/publish`,
      guardHeaders(T1),
      { actor: 'sub-abc' },
    )
    expect(r.status).toBe(409)
  })

  it('returns 404 for unknown post', async () => {
    const r = await callServer(server, 'POST', '/api/v1/posts/00000000-0000-0000-0000-000000000000/publish', guardHeaders(T1), {
      actor: 'sub',
    })
    expect(r.status).toBe(404)
  })

  it('returns 400 when actor is missing', async () => {
    const c = await callServer(server, 'POST', '/api/v1/posts', guardHeaders(T1), POST_BODY)
    const id = (c.body as { id: string }).id
    const r = await callServer(
      server,
      'POST',
      `/api/v1/posts/${id}/publish`,
      guardHeaders(T1),
      {},
    )
    expect(r.status).toBe(400)
  })
})

// -- per-channel publish route wrapper (POST /publish/:channel) ----------------
// This server is built WITHOUT publishDeps, so a valid channel short-circuits to
// 503 ('publish not configured') — the guard that keeps a mis-wired deploy from
// publishing. The channel-validation (400) runs BEFORE that guard. The full
// per-channel publish behavior (200 / 409 / email-failed) is covered by
// publish-channel.integration.test.ts.
describe('POST /api/v1/posts/:id/publish/:channel', () => {
  it('returns 400 for an invalid channel (before the publishDeps guard)', async () => {
    const c = await callServer(server, 'POST', '/api/v1/posts', guardHeaders(T1), POST_BODY)
    const id = (c.body as { id: string }).id
    const r = await callServer(server, 'POST', `/api/v1/posts/${id}/publish/tiktok`, guardHeaders(T1))
    expect(r.status).toBe(400)
  })

  it('returns 503 for a valid channel when publishDeps is not injected', async () => {
    const c = await callServer(server, 'POST', '/api/v1/posts', guardHeaders(T1), POST_BODY)
    const id = (c.body as { id: string }).id
    const r = await callServer(server, 'POST', `/api/v1/posts/${id}/publish/email`, guardHeaders(T1))
    expect(r.status).toBe(503)
  })
})

// -- unsubscribe --------------------------------------------------------------

describe('POST /api/v1/unsubscribe', () => {
  it('returns 404 for unknown token (consume-token action)', async () => {
    const r = await callServer(server, 'POST', '/api/v1/unsubscribe', guardHeaders(T1), {
      action: 'consume-token',
      token: 'nonexistent-token-abc',
    })
    expect(r.status).toBe(404)
  })

  it('returns 404 via legacy shape for unknown token', async () => {
    const r = await callServer(server, 'POST', '/api/v1/unsubscribe', guardHeaders(T1), {
      token: 'nonexistent-token-legacy',
    })
    expect(r.status).toBe(404)
  })

  it('returns 200 {ok:true} for a valid token (consume-token action)', async () => {
    const c = await callServer(server, 'POST', '/api/v1/posts', guardHeaders(T1), POST_BODY)
    const postId = (c.body as { id: string }).id
    const token = 'valid-test-token-xyz'
    await addSendToken(sql1, token, postId, 'dave@example.com')

    const r = await callServer(server, 'POST', '/api/v1/unsubscribe', guardHeaders(T1), {
      action: 'consume-token',
      token,
    })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ ok: true })
  })

  it('returns 200 {ok:true} via legacy shape for a valid token', async () => {
    const c = await callServer(server, 'POST', '/api/v1/posts', guardHeaders(T1), POST_BODY)
    const postId = (c.body as { id: string }).id
    const token = 'valid-legacy-token-zyx'
    await addSendToken(sql1, token, postId, 'legacy@example.com')

    const r = await callServer(server, 'POST', '/api/v1/unsubscribe', guardHeaders(T1), { token })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ ok: true })
  })

  it('filters unsubscribed emails (filter action)', async () => {
    // Add an unsubscribe directly.
    const c = await callServer(server, 'POST', '/api/v1/posts', guardHeaders(T1), POST_BODY)
    const postId = (c.body as { id: string }).id
    const token = 'filter-test-token-abc'
    await addSendToken(sql1, token, postId, 'filtered@example.com')
    // Consume token to create unsubscribe.
    await callServer(server, 'POST', '/api/v1/unsubscribe', guardHeaders(T1), {
      action: 'consume-token',
      token,
    })

    const r = await callServer(server, 'POST', '/api/v1/unsubscribe', guardHeaders(T1), {
      action: 'filter',
      emails: ['filtered@example.com', 'notsubscribed@example.com'],
    })
    expect(r.status).toBe(200)
    expect(r.body).toEqual(['filtered@example.com'])
  })

  it('adds an unsubscribe directly (add action)', async () => {
    const r = await callServer(server, 'POST', '/api/v1/unsubscribe', guardHeaders(T1), {
      action: 'add',
      email: 'directadd@example.com',
    })
    expect(r.status).toBe(204)

    // Verify it shows up in filter.
    const check = await callServer(server, 'POST', '/api/v1/unsubscribe', guardHeaders(T1), {
      action: 'filter',
      emails: ['directadd@example.com'],
    })
    expect(check.body).toEqual(['directadd@example.com'])
  })

  it('returns 400 when body is empty (no action, no token)', async () => {
    const r = await callServer(server, 'POST', '/api/v1/unsubscribe', guardHeaders(T1), {})
    expect(r.status).toBe(400)
  })
})

// -- stats --------------------------------------------------------------------

describe('GET /api/v1/stats', () => {
  it('returns subscriber and post counts', async () => {
    const listRes = await callServer(server, 'POST', '/api/v1/lists', guardHeaders(T1), {
      name: 'Stats List',
    })
    const listId = (listRes.body as { id: string }).id
    await callServer(server, 'POST', `/api/v1/lists/${listId}/members`, guardHeaders(T1), {
      email: 'eve@example.com',
    })
    await callServer(server, 'POST', '/api/v1/posts', guardHeaders(T1), POST_BODY)

    const r = await callServer(server, 'GET', '/api/v1/stats', guardHeaders(T1))
    expect(r.status).toBe(200)
    const data = (r.body as { data: { subscribers: number; posts: number } }).data
    expect(data.subscribers).toBe(1)
    expect(data.posts).toBe(1)
  })
})

// -- audit --------------------------------------------------------------------

describe('POST /api/v1/posts/:id/audit', () => {
  it('records an audit entry', async () => {
    const c = await callServer(server, 'POST', '/api/v1/posts', guardHeaders(T1), POST_BODY)
    const id = (c.body as { id: string }).id
    const r = await callServer(
      server,
      'POST',
      `/api/v1/posts/${id}/audit`,
      guardHeaders(T1),
      { actor_sub: 'sub-xyz', action: 'viewed' },
    )
    expect(r.status).toBe(200)
    expect((r.body as { success: boolean }).success).toBe(true)
  })

  it('returns 400 when action is missing', async () => {
    const c = await callServer(server, 'POST', '/api/v1/posts', guardHeaders(T1), POST_BODY)
    const id = (c.body as { id: string }).id
    const r = await callServer(
      server,
      'POST',
      `/api/v1/posts/${id}/audit`,
      guardHeaders(T1),
      { actor_sub: 'sub-xyz' },
    )
    expect(r.status).toBe(400)
  })

  it('returns 404 for unknown post', async () => {
    const r = await callServer(
      server,
      'POST',
      '/api/v1/posts/00000000-0000-0000-0000-000000000000/audit',
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
    expect(r.body as unknown[]).toHaveLength(0)
  })

  it('posts created under T1 are not visible to T2', async () => {
    await callServer(server, 'POST', '/api/v1/posts', guardHeaders(T1), POST_BODY)
    const r = await callServer(server, 'GET', '/api/v1/posts', guardHeaders(T2))
    expect(r.status).toBe(200)
    expect(r.body as unknown[]).toHaveLength(0)
  })
})

// -- response envelope contract (kernel ServiceContentClient expects bare JSON) --------
//
// These assertions lock the leaf to the client's contract: domain fields must
// appear at the TOP LEVEL and no {success, data} wrapper may be present.
// If a future change re-introduces sendOk() on these routes these tests break
// immediately instead of silently at CONTENT_BACKEND=service cutover.

describe('response envelope contract (kernel ServiceContentClient expects bare JSON)', () => {
  it('POST /api/v1/lists returns bare object (no wrapper)', async () => {
    const r = await callServer(server, 'POST', '/api/v1/lists', guardHeaders(T1), {
      name: 'Envelope Guard List',
    })
    expect(r.status).toBe(201)
    const body = r.body as Record<string, unknown>
    expect(body['success']).toBeUndefined()
    expect(body['data']).toBeUndefined()
    expect(typeof body['id']).toBe('string')
  })

  it('GET /api/v1/lists returns bare array (no wrapper)', async () => {
    const r = await callServer(server, 'GET', '/api/v1/lists', guardHeaders(T1))
    expect(r.status).toBe(200)
    expect(Array.isArray(r.body)).toBe(true)
  })

  it('GET /api/v1/lists/:id/members returns bare array (no wrapper)', async () => {
    const created = await callServer(server, 'POST', '/api/v1/lists', guardHeaders(T1), {
      name: 'Members Guard List',
    })
    const listId = (created.body as { id: string }).id
    const r = await callServer(server, 'GET', `/api/v1/lists/${listId}/members`, guardHeaders(T1))
    expect(r.status).toBe(200)
    expect(Array.isArray(r.body)).toBe(true)
  })

  it('POST /api/v1/posts returns bare object (no wrapper)', async () => {
    const r = await callServer(server, 'POST', '/api/v1/posts', guardHeaders(T1), POST_BODY)
    expect(r.status).toBe(201)
    const body = r.body as Record<string, unknown>
    expect(body['success']).toBeUndefined()
    expect(body['data']).toBeUndefined()
    expect(typeof body['id']).toBe('string')
  })

  it('GET /api/v1/posts returns bare array (no wrapper)', async () => {
    const r = await callServer(server, 'GET', '/api/v1/posts', guardHeaders(T1))
    expect(r.status).toBe(200)
    expect(Array.isArray(r.body)).toBe(true)
  })

  it('GET /api/v1/posts/:id returns bare object (no wrapper)', async () => {
    const c = await callServer(server, 'POST', '/api/v1/posts', guardHeaders(T1), POST_BODY)
    const id = (c.body as { id: string }).id
    const r = await callServer(server, 'GET', `/api/v1/posts/${id}`, guardHeaders(T1))
    expect(r.status).toBe(200)
    const body = r.body as Record<string, unknown>
    expect(body['success']).toBeUndefined()
    expect(body['data']).toBeUndefined()
    expect(body['id']).toBe(id)
  })

  it('PATCH /api/v1/posts/:id returns bare object (no wrapper)', async () => {
    const c = await callServer(server, 'POST', '/api/v1/posts', guardHeaders(T1), POST_BODY)
    const id = (c.body as { id: string }).id
    const r = await callServer(server, 'PATCH', `/api/v1/posts/${id}`, guardHeaders(T1), {
      title: 'Envelope Patch Test',
    })
    expect(r.status).toBe(200)
    const body = r.body as Record<string, unknown>
    expect(body['success']).toBeUndefined()
    expect(body['data']).toBeUndefined()
    expect(typeof body['id']).toBe('string')
  })

  it('GET /api/v1/posts/:id/recipients returns bare array (no wrapper)', async () => {
    const c = await callServer(server, 'POST', '/api/v1/posts', guardHeaders(T1), POST_BODY)
    const id = (c.body as { id: string }).id
    const r = await callServer(server, 'GET', `/api/v1/posts/${id}/recipients`, guardHeaders(T1))
    expect(r.status).toBe(200)
    expect(Array.isArray(r.body)).toBe(true)
  })
})
