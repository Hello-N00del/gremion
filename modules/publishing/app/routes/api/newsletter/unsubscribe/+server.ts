import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { resolveNewsletterBackendOr503 } from '$lib/server/newsletter/backend/resolve'
import { requireUnsubscribeRateLimit } from '$lib/server/rate-limit'
import { clientIpWithReason } from '$lib/server/client-ip'

// The single-use unsubscribe token is consumed by a POST only. Mail-security
// scanners and client prefetchers GET every link in a message; a GET that
// consumed the token unsubscribed recipients who never clicked and burned the
// link. The mailed link opens the confirm page (/newsletter/unsubscribe), which
// POSTs the token here when the recipient confirms. This module exports POST
// and nothing else, so SvelteKit answers a GET (or any other method) with 405
// and `Allow: POST` before any handler runs. The token travels in a JSON body,
// never in the query string (URLs end up in history, logs and referrers).
// SvelteKit's origin check on form-typed cross-site POSTs is left untouched, and
// a non-JSON content type is refused here as well.
//
// Not an RFC 8058 one-click endpoint: the mail path carries no List-Unsubscribe
// or List-Unsubscribe-Post header, so no mail advertises one.

async function readToken(request: Request): Promise<string | null> {
  const contentType = request.headers.get('content-type') ?? ''
  if (!/^application\/json(\s*;|$)/i.test(contentType.trim())) return null
  try {
    const body: unknown = await request.json()
    const token = (body as { token?: unknown } | null)?.token
    return typeof token === 'string' && token !== '' ? token : null
  } catch {
    return null
  }
}

export const POST: RequestHandler = async (event) => {
  // T3.1: 10/hour IP-keyed limit. Public, unauthenticated endpoint — the IP
  // is the only stable identity. Limit applies BEFORE the body is read and the
  // token looked up, so failed token attempts still count.
  const limited = requireUnsubscribeRateLimit(clientIpWithReason(event))
  if (limited) return limited
  const token = await readToken(event.request)
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
  // the response may be logged or cached on the way, so emitting the address
  // would turn the token into a small email-disclosure oracle (G-009 finding).
  const result = await backend.consumeUnsubscribeToken(token)
  if (result.ok) return json({ ok: true })
  if (result.reason === 'expired') return json({ ok: false }, { status: 410 })
  return json({ ok: false }, { status: 404 })
}
