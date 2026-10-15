// gremion-ui/src/routes/api/internal/newsletter/send-mail/+server.ts
// Task 11 — kernel callback: send a newsletter email via the per-tenant SMTP transport.
//
// SP-2 seam (B2 send-in-kernel): the newsletter leaf POSTs the fully-rendered
// per-recipient message; the kernel resolves the per-tenant transport via SP-2's
// sendMailForTenant() and sends. SMTP credentials NEVER leave the kernel.
//
// SmtpUnconfiguredError → 503 {error:"smtp-unconfigured"} (NOT 500) so the
// leaf can distinguish configuration errors from infrastructure failures and
// surface them to the operator rather than endlessly retrying.
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
import { sendMailForTenant, SmtpUnconfiguredError } from '$lib/server/mail/tenant-mail'

const SendMailBody = z.object({
  to: z.string().min(1),
  subject: z.string().min(1),
  html: z.string().min(1),
  from_address: z.string().optional(),
  from_name: z.string().optional(),
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

  const parsed = SendMailBody.safeParse(body)
  if (!parsed.success) {
    return json(
      { success: false, error: 'Missing required fields: to, subject, html' },
      { status: 400 }
    )
  }

  const { to, subject, html, from_address, from_name } = parsed.data

  // ── 3. Send via per-tenant SMTP transport (SP-2 seam) ─────────────────────
  try {
    const info = await sendMailForTenant({
      to,
      subject,
      html,
      ...(from_address !== undefined ? { from_address } : {}),
      ...(from_name !== undefined ? { from_name } : {}),
    })
    return json({ messageId: info.messageId })
  } catch (err) {
    if (err instanceof SmtpUnconfiguredError) {
      // SP-2: tenant SMTP not configured — return a typed error the leaf can handle
      // (operator needs to configure SMTP for this tenant; retry will not help)
      return json({ success: false, error: 'smtp-unconfigured' }, { status: 503 })
    }
    console.error('[newsletter:send-mail] SMTP send failed', { to, err })
    return json({ success: false, error: 'Send failed' }, { status: 500 })
  }
}
