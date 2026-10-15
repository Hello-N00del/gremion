// gremion-ui/src/routes/api/internal/newsletter/render/+server.ts
// Task 11 — kernel callback: render an ODT newsletter body to HTML.
//
// The newsletter leaf calls this via kernel-client.ts `render(odtPath)`.
// The kernel owns Nextcloud + Collabora access; the leaf never touches either.
//
// Guard: x-internal-auth header validated with timingSafeEqual against
//   INTERNAL_NEWSLETTER_SECRET (mirrors the api/internal/push pattern).
// This path is exempted from session-auth in hooks.server.ts publicPaths.
import { json } from '@sveltejs/kit'
import { z } from 'zod'
import type { RequestHandler } from './$types'
// TASK-205c: the shared constant-time compare replaces the local copy (the kernel Q4 guard in boot-exempt.test.ts
// requires every /api/internal/ handler to call isInternalTrustRequest or constantTimeEqual).
import { constantTimeEqual } from '$lib/server/internal-fetch'
import { createNextcloudClient } from '$lib/server/files/nextcloud-client'
import { convertOdtToHtml } from '$lib/server/newsletter/collabora-convert'

const RenderBody = z.object({
  odtPath: z.string().min(1),
})

export const POST: RequestHandler = async ({ request }) => {
  // ── 1. Guard: validate shared internal secret ─────────────────────────────
  const secret = request.headers.get('x-internal-auth')
  const expected = process.env.INTERNAL_NEWSLETTER_SECRET
  if (!expected || !secret || !constantTimeEqual(secret, expected)) {
    return json({ success: false, error: 'Forbidden' }, { status: 403 })
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

  // ── 2. Validate body ──────────────────────────────────────────────────────
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json({ success: false, error: 'Invalid JSON' }, { status: 400 })
  }

  const parsed = RenderBody.safeParse(body)
  if (!parsed.success) {
    return json(
      { success: false, error: 'Missing or invalid odtPath' },
      { status: 400 }
    )
  }

  const { odtPath } = parsed.data

  // ── 3. Fetch ODT from Nextcloud + convert via Collabora ───────────────────
  try {
    const nc = createNextcloudClient()
    const res = await nc.download(odtPath, 'admin')
    const odtBuffer = await res.arrayBuffer()
    const html = await convertOdtToHtml(odtBuffer)
    return json({ html })
  } catch (err) {
    console.error('[newsletter:render] render failed', { odtPath, err })
    return json({ success: false, error: 'Render failed' }, { status: 500 })
  }
}
