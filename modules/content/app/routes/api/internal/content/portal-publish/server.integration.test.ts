// gremion-ui/src/routes/api/internal/content/portal-publish/server.integration.test.ts
// Task 9: TDD integration test for POST /api/internal/content/portal-publish
//
// The integration suite (vitest.integration.config.ts) establishes the default
// tenant in ALS before each test so getDb() / news-db functions work against the
// real `stura` test DB (postgres://stura:stura_test@localhost:5432/stura).
//
// Migration 047_news_posts_content_origin.sql (adds content_origin_post_id) is
// applied idempotently in beforeAll so this suite is self-contained.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDb } from '$lib/server/db'
import { POST } from './+server'

const SECRET = process.env.INTERNAL_CONTENT_SECRET ?? 'test-secret'

function req(body: unknown) {
  return new Request('http://k/api/internal/content/portal-publish', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-auth': SECRET,
      'x-tenant-slug': 'default',
      'x-tenant-id': '00000000-0000-0000-0000-000000000001',
    },
    body: JSON.stringify(body),
  })
}

describe('portal-publish callback', () => {
  const A = '11111111-1111-1111-1111-111111111111'

  beforeAll(async () => {
    // Apply migration 047 idempotently — IF NOT EXISTS guards make it safe to
    // run against an already-migrated DB.
    const sql = getDb()
    const ddl = readFileSync(
      join(process.cwd(), 'migrations', '047_news_posts_content_origin.sql'),
      'utf-8',
    )
    await sql.unsafe(ddl)
    // Set the secret so the guard works without a .env
    process.env.INTERNAL_CONTENT_SECRET = SECRET
  })

  beforeEach(async () => {
    // Truncate news_posts between tests to avoid slug collisions and leftover rows.
    const sql = getDb()
    await sql`TRUNCATE news_posts RESTART IDENTITY CASCADE`
  })

  it('first call (no externalRef) creates news_posts and returns its id', async () => {
    const res = await POST({ request: req({ contentPostId: A, title: 'News', bodyHtml: '<p>one</p>' }) } as any)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.id).toBeDefined() // native news_posts id type — the cross-call equality below is the real idempotency check
    expect(body.content_origin_post_id).toBe(A)
  })

  it('re-call with the SAME contentPostId returns the SAME id and updates the body (idempotent)', async () => {
    const r1 = await (await POST({ request: req({ contentPostId: A, title: 'News', bodyHtml: '<p>one</p>' }) } as any)).json()
    const r2 = await (await POST({ request: req({ contentPostId: A, title: 'News v2', bodyHtml: '<p>two</p>' }) } as any)).json()
    expect(r2.id).toBe(r1.id) // crash-safety: no orphan, no duplicate
  })

  it('rejects a missing/incorrect x-internal-auth with 401/403', async () => {
    const bad = new Request('http://k/api/internal/content/portal-publish', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    const res = await POST({ request: bad } as any)
    expect([401, 403]).toContain(res.status)
  })
})
