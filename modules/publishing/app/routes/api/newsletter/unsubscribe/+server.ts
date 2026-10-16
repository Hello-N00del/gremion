import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { resolveNewsletterBackendOr503 } from '$lib/server/newsletter/backend/resolve'
import { requireUnsubscribeRateLimit } from '$lib/server/rate-limit'
import { clientIpWithReason } from '$lib/server/client-ip'

export const GET: RequestHandler = async (event) => {
  const { url } = event
  // T3.1: 10/hour IP-keyed limit. Public, unauthenticated endpoint — the IP
  // is the only stable identity. Limit applies BEFORE token lookup so failed
  // token attempts still count.
  const limited = requireUnsubscribeRateLimit(clientIpWithReason(event))
  if (limited) return limited
  const token = url.searchParams.get('token')
  if (!token) {
    return json({ ok: false }, { status: 400 })
  }

  const backend = resolveNewsletterBackendOr503()
  if (backend instanceof Response) return backend

  // T3.2 (G-009 route half): expire-on-use + success-only response. The
  // helper wraps lookup, expiry check, insert into `unsubscribes`, and the
  // token DELETE in a single better-sqlite3 transaction (SQLite re-cast of
  // the Postgres-flavoured plan body — see addendum 1 Finding 1).
  //
  // The response body is intentionally `{ ok: true }` only on success — we
  // do NOT echo the email back. Even though the caller already knows the
  // address that received the link, the endpoint is unauthenticated and
  // the URL ends up in browser history, server logs, and possibly
  // referrers, so emitting the address would turn the token into a small
  // email-disclosure oracle (G-009 finding).
  const result = await backend.consumeUnsubscribeToken(token)
  if (result.ok) return json({ ok: true })
  if (result.reason === 'expired') return json({ ok: false }, { status: 410 })
  return json({ ok: false }, { status: 404 })
}
