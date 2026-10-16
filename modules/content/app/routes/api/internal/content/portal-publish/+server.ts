// gremion-ui/src/routes/api/internal/content/portal-publish/+server.ts
// Task 9 — kernel callback: idempotent POST /api/internal/content/portal-publish
//
// The content-service leaf calls this endpoint when publishing a post to the
// portal channel. It creates or updates a `news_posts` row in the kernel DB
// anchored by `content_origin_post_id` (the leaf's content post UUID).
//
// Idempotency: the UNIQUE index on news_posts.content_origin_post_id (migration
// 047) prevents duplicates. A retry with the same contentPostId finds the
// existing row and updates it — no orphan rows, no 500 on retry.
//
// Guard: x-internal-auth header validated with timingSafeEqual against
//   INTERNAL_CONTENT_SECRET (mirrors the api/internal/push + send-mail pattern).
// This path must be exempted from session-auth in hooks.server.ts publicPaths.

import { json } from '@sveltejs/kit'
import { z } from 'zod'
import { portalCallback } from '$lib/server/news/portal-callback'
import { readOrMintCorrelationId } from '@gremion/ports/tracer'
// TASK-205c: the shared constant-time compare replaces the local copy (the kernel Q4 guard in boot-exempt.test.ts
// requires every /api/internal/ handler to call isInternalTrustRequest or constantTimeEqual).
import { constantTimeEqual } from '$lib/server/internal-fetch'

// UUID validation: use a format-only regex (not RFC-4122 variant-strict) so
// the leaf can send any UUID-shaped string including test UUIDs with repeated
// digits. The uniqueness constraint on the column is the real guard.
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const PortalPublishBody = z.object({
  /** UUID of the content-service post — the idempotency anchor. */
  contentPostId: z.string().regex(UUID_REGEX, 'contentPostId must be a UUID'),
  title: z.string().min(1),
  bodyHtml: z.string(),
  /** Optional: existing news_posts id (string form) if the leaf already has one. */
  externalRef: z.string().optional(),
})

export async function POST({ request }: { request: Request }): Promise<Response> {
  // F3 observability: echo the leaf's inbound x-correlation-id so a failure here is
  // traceable end-to-end across the two processes; mint one when it is absent or
  // not a valid UUID. The id is observability-only — never used for auth.
  const correlationId = readOrMintCorrelationId(request.headers.get('x-correlation-id'))

  // ── 1. Guard: validate shared internal secret ────────────────────────────────
  const secret = request.headers.get('x-internal-auth')
  const expected = process.env.INTERNAL_CONTENT_SECRET
  if (!expected || !secret || !constantTimeEqual(secret, expected)) {
    // Structured warn — carries the correlation id + a coarse reason, but NEVER the
    // secret value (neither the expected nor the presented one).
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'content.portal-publish.unauthorized',
        correlationId,
        reason: !expected ? 'secret-unconfigured' : !secret ? 'missing-auth' : 'bad-auth',
      }),
    )
    return json({ success: false, error: 'Forbidden' }, { status: 401 })
  }

  // Tenancy D1 HARDENING-3: there is no tenant cross-check here any more, and
  // its absence is not a gap. It existed because the leaf carried a REPLICA of
  // the tenant's registered host and picked the tenant with it, so a stale
  // replica could aim this write at another tenant and the check made that a
  // loud 409. The element-0 resolver now selects this request's tenant FROM the
  // `x-tenant-id` the leaf sends, under the same secret validated above
  // (tenant/leaf-trust.ts) — so "the leaf's tenant" and "the resolved tenant"
  // are the same value by construction. Asserting they agree would be a
  // tautology; the property is now structural rather than checked.

  // ── 2. Parse + validate body ─────────────────────────────────────────────────
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return json({ success: false, error: 'Invalid JSON' }, { status: 400 })
  }

  const parsed = PortalPublishBody.safeParse(raw)
  if (!parsed.success) {
    return json(
      { success: false, error: 'Missing or invalid fields: contentPostId (uuid), title, bodyHtml required' },
      { status: 400 },
    )
  }

  const { contentPostId, title, bodyHtml, externalRef } = parsed.data

  // ── 3. Idempotent kernel-local transaction ────────────────────────────────────
  // Wrap the DB transaction so an unexpected failure becomes a STABLE 500 body
  // (the leaf's C6 retry keys off the status, not a leaked stack) plus a structured
  // error log carrying the correlation id.
  let result
  try {
    result = await portalCallback({
      contentPostId,
      title,
      bodyHtml,
      authorId: 'system',
      externalRef,
    })
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'content.portal-publish.failed',
        correlationId,
        contentPostId,
        error: err instanceof Error ? err.message : String(err),
      }),
    )
    return json({ success: false, error: 'Internal error' }, { status: 500 })
  }

  // ── 4. Return the news_posts row identity ─────────────────────────────────────
  // `id` is the native numeric news_posts id; the leaf records String(id) as
  // external_ref so it can target the same row on future re-publishes.
  return json({
    id: result.newsId,
    slug: result.slug,
    published_at: result.published_at?.toISOString() ?? new Date().toISOString(),
    content_origin_post_id: result.content_origin_post_id,
  })
}
