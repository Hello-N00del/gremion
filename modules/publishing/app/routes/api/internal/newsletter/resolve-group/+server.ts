// gremion-ui/src/routes/api/internal/newsletter/resolve-group/+server.ts
// Task 11 — kernel callback: resolve a Keycloak group id to email-bearing members.
//
// The newsletter leaf calls this via kernel-client.ts `resolveGroup(groupId)`.
// The kernel owns KC-admin credentials; the leaf never touches Keycloak directly.
//
// Filter/format: EXACT parity with the scheduler's makeGroupFetcher (lines 131-140):
//   - .filter((m) => !!m.email)         — drops empty/null/undefined email
//   - .map: name = [firstName, lastName].filter(Boolean).join(' ') || null
//
// Guard: x-internal-auth header validated with timingSafeEqual against
//   INTERNAL_NEWSLETTER_SECRET (mirrors the api/internal/push pattern).
// This path is exempted from session-auth in hooks.server.ts publicPaths.
import { json } from '@sveltejs/kit'
import { timingSafeEqual } from 'crypto'
import { z } from 'zod'
import type { RequestHandler } from './$types'
import { getKeycloakAdminClientForCurrentTenant } from '$lib/server/keycloak-admin'

/** Constant-time string comparison — prevents timing-side-channel secret leaks. */
function safeCompare(a: string, b: string): boolean {
  try {
    const bufA = Buffer.from(a.padEnd(b.length))
    const bufB = Buffer.from(b.padEnd(a.length))
    const len = Math.max(bufA.length, bufB.length)
    return (
      timingSafeEqual(Buffer.concat([bufA], len), Buffer.concat([bufB], len)) &&
      a.length === b.length
    )
  } catch {
    return false
  }
}

const ResolveGroupBody = z.object({
  groupId: z.string().min(1),
})

export const POST: RequestHandler = async ({ request }) => {
  // ── 1. Guard: validate shared internal secret ─────────────────────────────
  const secret = request.headers.get('x-internal-auth')
  const expected = process.env.INTERNAL_NEWSLETTER_SECRET
  if (!expected || !secret || !safeCompare(secret, expected)) {
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

  const parsed = ResolveGroupBody.safeParse(body)
  if (!parsed.success) {
    return json(
      { success: false, error: 'Missing or invalid groupId' },
      { status: 400 }
    )
  }

  const { groupId } = parsed.data

  // ── 3. Fetch KC group members and filter/format (scheduler parity) ────────
  try {
    const kc = getKeycloakAdminClientForCurrentTenant()
    const rawMembers = await kc.getGroupMembers(groupId)
    // Exact parity with newsletter-scheduler.ts makeGroupFetcher (lines 131-140):
    //   filter: drop members without an email address
    //   map:    name = [firstName, lastName].filter(Boolean).join(' ') || null
    const members = rawMembers
      .filter((m) => !!m.email)
      .map((m) => ({
        email: m.email,
        name: [m.firstName, m.lastName].filter(Boolean).join(' ') || null,
      }))
    return json({ members })
  } catch (err) {
    console.error('[newsletter:resolve-group] KC lookup failed', { groupId, err })
    return json({ success: false, error: 'KC group lookup failed' }, { status: 500 })
  }
}
