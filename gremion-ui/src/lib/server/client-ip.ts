// src/lib/server/client-ip.ts
//
// ONE client-address helper for gremion-ui. T04 round 2 replaced five
// byte-identical private copies of it — api/setup/config, api/setup/admins,
// api/setup/seed, api/setup/test-smtp and api/newsletter/unsubscribe — each of
// which returned the literal string `'unknown'` when the address could not be
// resolved.
//
// WHY THE SENTINEL HAD TO GO, and why now.
//
// `'unknown'` is not an address, and using it as a rate-limit key merges every
// un-addressable caller into ONE shared bucket: `setup:unknown` and
// `unsubscribe:unknown`. That is a 5/hour and a 10/hour budget for the whole
// internet combined, on endpoints that are unauthenticated by design and gate
// the bootstrap wizard — and the entire budget is available to anyone who can
// make their own address unresolvable.
//
// It was latent before this change and is not any more. Those copies wrapped
// `getClientAddress()` in try/catch because a partial test event might omit it;
// in production the call read the socket and could not throw, so the catch was
// dead code. docker-compose.prod.yml now sets ADDRESS_HEADER=x-forwarded-for on
// gremion-ui, and adapter-node THROWS when a configured ADDRESS_HEADER is
// absent from a request. The catch is live, so the sentinel is reachable.
//
// `null` is deliberate and is NOT a string: callers must decide what an absent
// address means for them, and a shared placeholder makes that decision
// invisibly and wrongly. This mirrors gremion-public's
// `lib/server/rate-limit.ts` `clientIp`, which was given the same shape in
// round 1 — the two are intentionally identical so the two packages cannot
// drift into different answers for the same question.
//
// In production the value is the REAL client address only because the container
// is given ADDRESS_HEADER + XFF_DEPTH (docker-compose.prod.yml, and XFF_DEPTH=2
// under the Cloudflare overlay, which has one more proxy hop). Without them
// adapter-node reports the socket address, which behind Traefik is Traefik's
// own container IP — one bucket for everyone.

/**
 * The requesting client's address, or `null` when there is none to be had.
 *
 * Returns `null` rather than a sentinel string for a missing, blank, or
 * throwing `getClientAddress()`. Callers that key a rate limit on the result
 * MUST fail closed on `null` (see `requireSetupRateLimit` /
 * `requireUnsubscribeRateLimit`), never substitute a placeholder.
 */
export function clientIp(event: { getClientAddress?: () => string }): string | null {
  return clientIpWithReason(event).ip
}

// ── T04 round 3 — the address is not the whole answer ────────────────────────
//
// Returning a bare `null` made both callers issue an unconditional 429, and an
// operator then has a status code and nothing else. The three ways an address
// goes missing have completely different remedies, and only one of them is a
// client's doing:
//
//   'threw'         adapter-node has ADDRESS_HEADER configured and the request
//                   carried no X-Forwarded-For. This is the LIVE production
//                   case: a host-local call straight to gremion-ui:3000 (which
//                   is how the netcup runbook seeds) has no forwarded header at
//                   all, so a documented deploy step was refused before it
//                   reached the handler.
//   'unavailable'   the event exposes no getClientAddress — a partial event,
//                   i.e. a test.
//   'blank' /       the adapter returned something unusable.
//   'not-a-string'
//
// `clientIp` keeps its exact previous contract and is DEFINED in terms of the
// richer function, so the two can never disagree about the same input.

/** Why `clientIpWithReason` could not produce an address (`'ok'` when it did). */
export type ClientIpReason = 'ok' | 'unavailable' | 'threw' | 'blank' | 'not-a-string'

/** An address, or the reason there is none. */
export interface ClientAddress {
  readonly ip: string | null
  readonly reason: ClientIpReason
}

/**
 * The requesting client's address together with the reason it is absent.
 *
 * Callers that key a rate limit on the result MUST NOT use a placeholder for a
 * null `ip` — see `requireSetupRateLimit`, which gives un-addressable callers
 * their own separately-bounded bucket and logs `reason`.
 */
export function clientIpWithReason(event: { getClientAddress?: () => string }): ClientAddress {
  let address: unknown
  try {
    if (typeof event.getClientAddress !== 'function') return { ip: null, reason: 'unavailable' }
    address = event.getClientAddress()
  } catch {
    // adapter-node throws when ADDRESS_HEADER is configured but absent from the
    // request. That is an un-addressable caller, not an error to propagate: the
    // request still gets a decision, and the decision is made by the caller.
    return { ip: null, reason: 'threw' }
  }
  if (typeof address !== 'string') return { ip: null, reason: 'not-a-string' }
  const trimmed = address.trim()
  return trimmed === '' ? { ip: null, reason: 'blank' } : { ip: trimmed, reason: 'ok' }
}
