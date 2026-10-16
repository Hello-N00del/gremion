import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { hasRole, Role } from '$lib/auth'
import { resolveNewsletterBackendOr503 } from '$lib/server/newsletter/backend/resolve'
import { NewsletterServiceError } from '$lib/server/newsletter/backend/service-client'
import { getKeycloakAdminClient } from '$lib/server/keycloak-admin'
import { requireNewsletterSendNowRateLimit } from '$lib/server/rate-limit'
import { writeAuditEntry } from '$lib/server/audit-db'

export const POST: RequestHandler = async ({ params, locals }) => {
  if (
    !locals.user ||
    !(hasRole(locals.user.roles, Role.ITAdmin) || hasRole(locals.user.roles, Role.CouncilAdmin))
  ) {
    return json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const id = parseInt(params.id, 10)
  if (isNaN(id)) return json({ success: false, error: 'Invalid id' }, { status: 400 })

  // T3.1: 3/hour ceiling — see gremion-ui/docs/rate-limit.md.
  const limited = requireNewsletterSendNowRateLimit(locals.user.id)
  if (limited) return limited

  const backend = resolveNewsletterBackendOr503()
  if (backend instanceof Response) return backend
  const newsletter = await backend.getNewsletter(id)
  if (!newsletter) return json({ success: false, error: 'Not found' }, { status: 404 })

  // #190: use the shared working service client (stura-admin) instead of the
  // unset KEYCLOAK_SERVICE_CLIENT_* env vars. Hoisted out of the per-group
  // closure so the admin client is resolved once per send. (In service mode the
  // leaf resolves groups via its own kernel callback, so the fetcher is unused
  // there — but resolving it is cheap and keeps the dispatchNow signature stable.)
  const kc = getKeycloakAdminClient(locals.tenant)
  const groupFetcher = async (groupId: string) => {
    const members = await kc.getGroupMembers(groupId)
    return members
      .filter((m) => !!m.email)
      .map((m) => ({
        email: m.email,
        name: [m.firstName, m.lastName].filter(Boolean).join(' ') || null,
      }))
  }

  // T3.5 (G-062): dual-write the send event to the Postgres `audit_log`
  // alongside the SQLite/leaf `newsletter_audit` row. The newsletter_audit
  // write is the operational record (immediately consistent with the
  // newsletter table it references); the Postgres write is the global
  // tamper-resistant audit trail consulted by the operator audit UI and
  // by the BSI / GDPR retention scheduler. `recipient_count` is captured
  // from the recipient-group configuration available at send-now time —
  // the deduplicated, unsubscribe-filtered delivery count is recorded
  // separately by the sender once dispatch completes.
  const recordSendAudit = async () => {
    await backend.recordNewsletterAudit(id, locals.user!.id, 'send-now')
    const recipientCount = (await backend.getNewsletterRecipients(id)).length
    try {
      await writeAuditEntry({
        userId: locals.user!.id,
        field: 'newsletter_sent',
        oldValue: null,
        newValue: JSON.stringify({ newsletter_id: id, recipient_count: recipientCount }),
      })
    } catch (auditErr) {
      // Mirrors the scheduler's last-resort console path (G-017): if the
      // Postgres audit write fails we still log to the container so we
      // don't trade one swallowed error for another. The newsletter_audit
      // row above has already landed, so the send is still tracked locally.
      console.error('[newsletter:send-now] audit write failed', { id, auditErr })
    }
  }

  if (backend.kind === 'service') {
    // ── Service mode (F-CRIT) ──────────────────────────────────────────────────
    // The leaf's POST /send performs the atomic claim ITSELF and returns 202
    // (accepted) or 409 (already sending/sent). We must NOT call
    // claimNewsletterForSending here — the service client throws
    // NotSupportedViaServiceError for it, which previously produced an uncaught
    // 500 on the primary admin action.
    //
    // dispatchNow() (→ POST /send) resolving means the leaf accepted the send and
    // will claim atomically; it throwing NewsletterServiceError(409) means the
    // leaf rejected it as already sending/sent. We map that 409 to the SAME body
    // the SQLite path returns for a lost claim, and a 404 to the route's 404.
    //
    // Audit ordering: the leaf's dispatch records only the send.succeeded/failed
    // OUTBOX event, NOT a newsletter_audit row, so there is NO double audit. We
    // record the send-now audit AFTER the leaf accepts (i.e. only on a real 202),
    // matching the SQLite path's "audit only on a successful claim, never on 409".
    try {
      await backend.dispatchNow(id, locals.user.id, groupFetcher)
    } catch (err) {
      if (err instanceof NewsletterServiceError) {
        if (err.status === 409) {
          return json(
            { success: false, error: `Cannot send newsletter with status '${newsletter.status}'` },
            { status: 409 }
          )
        }
        if (err.status === 404) {
          return json({ success: false, error: 'Not found' }, { status: 404 })
        }
      }
      // Any other failure is a genuine error reaching the leaf — surface 503 so
      // the client can retry, rather than an uncaught 500.
      console.error('[newsletter:send-now] service dispatch failed', { id, err })
      return json({ success: false, error: 'Newsletter backend unavailable' }, { status: 503 })
    }

    await recordSendAudit()
    return json({ success: true, data: { queued: true } }, { status: 202 })
  }

  // ── SQLite mode (byte-identical to pre-F-CRIT behaviour) ──────────────────────
  if (!await backend.claimNewsletterForSending(id)) {
    return json(
      { success: false, error: `Cannot send newsletter with status '${newsletter.status}'` },
      { status: 409 }
    )
  }

  await recordSendAudit()

  backend.dispatchNow(id, locals.user.id, groupFetcher).catch((err) => {
    console.error('[newsletter:send-now] dispatch failed', { id, err })
    /* status already persisted to DB by sender */
  })
  return json({ success: true, data: { queued: true } }, { status: 202 })
}
