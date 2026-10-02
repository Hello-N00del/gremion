// apps/control-panel/src/lib/server/gate.ts — the TRD-048 gate, PURE.
//
// hooks.server.ts runs it on EVERY request that is not an Auth.js route or one
// of the two exempt probes, BEFORE SvelteKit resolves a page, a form action or
// a +server endpoint (a gate in +layout.server.ts would miss actions and
// endpoints). The session is the ops realm's or it is nothing:
//   - an Authorization header             -> 403 (the panel accepts no bearer token)
//   - a session cookie that does not decode -> 403, the cookie is cleared (forged or stale)
//   - no session                          -> GET: sign-in at the ops realm (acr loa2); else 403
//   - a session signed in more than SESSION_ABSOLUTE_SECONDS ago (or with no
//     sign-in time)                       -> GET: sign-in; else 403, the cookie is cleared
//   - a session whose iss is not the ops issuer (a customer realm) -> 403
//   - no `operator` realm role            -> 403
//   - acr below the required loa2         -> GET: step-up sign-in; else 403
// The iss check compares strings exactly (OIDC Core §3.1.3.7 item 2).

export interface Operator {
  id: string
  email: string | null
  iss: string
  acr: string
}

export interface SessionClaims {
  iss?: string
  acr?: string
  uid?: string
  email?: string | null
  roles?: string[]
  /** Epoch seconds of the authorization code exchange that made this session. */
  authAt?: number
  error?: string
}

/**
 * ABSOLUTE session lifetime (ASVS 5.0 V7.3.2), counted from the sign-in, never
 * from the last request: Auth.js renews a JWT session's expiry on every read,
 * so its maxAge alone is only an idle timeout (review r2 HIGH). Roles and acr
 * are read at sign-in only, so this is also the bound on how long a revoked
 * operator keeps the panel.
 */
export const SESSION_ABSOLUTE_SECONDS = 3600

/** Clock skew tolerated on a sign-in time that lies in the future. */
const FUTURE_SKEW_SECONDS = 60

/** True when a sign-in time is missing, malformed, in the future or too old. */
export function sessionTooOld(authAt: unknown, now: number): boolean {
  if (typeof authAt !== 'number' || !Number.isFinite(authAt)) return true
  if (authAt > now + FUTURE_SKEW_SECONDS) return true
  return now - authAt > SESSION_ABSOLUTE_SECONDS
}

export type GateDecision =
  | { kind: 'allow'; operator: Operator }
  | { kind: 'sign-in'; reason: 'anonymous' | 'step-up' | 'expired' }
  | { kind: 'refuse'; status: 403; reason: string; clearCookie: boolean }

export interface GateInput {
  method: string
  path: string
  session: SessionClaims | null
  /** An Auth.js session cookie was presented. */
  sessionCookie: boolean
  authorization: string | null
  issuer: string
  requiredAcr: string
  /** Epoch seconds, now. */
  now: number
}

export const OPERATOR_ROLE = 'operator'

/** Routes the gate does not guard: Auth.js's own, and the two probes. */
export function isExempt(path: string): boolean {
  return path === '/healthz' || path === '/api/internal/evict' || path === '/auth' || path.startsWith('/auth/')
}

/**
 * [D R29-I11] The panel answers on ONE host name, the host of its ORIGIN (the
 * operator-supplied name behind the edge, or 127.0.0.1:<port> behind `ssh -L`).
 * The comparison is exact up to case (host names are case-insensitive): no
 * suffix, no subdomain, no port that ORIGIN does not carry.
 */
export function hostAllowed(hostHeader: string | null, origin: string): boolean {
  if (!hostHeader) return false
  let want: string
  try {
    want = new URL(origin).host
  } catch {
    return false
  }
  return want !== '' && hostHeader.toLowerCase() === want.toLowerCase()
}

/** The unverified `iss` of a bearer token, for the refusal message only. */
function bearerIss(authorization: string): string | null {
  const m = /^Bearer\s+([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\./.exec(authorization)
  if (!m) return null
  try {
    const payload = JSON.parse(Buffer.from(m[2]!, 'base64url').toString('utf8')) as { iss?: unknown }
    return typeof payload.iss === 'string' ? payload.iss : null
  } catch {
    return null
  }
}

export function decide(input: GateInput): GateDecision {
  const read = input.method === 'GET' || input.method === 'HEAD'
  const refuse = (reason: string, clearCookie = false): GateDecision => ({ kind: 'refuse', status: 403, reason, clearCookie })

  if (input.authorization) {
    const iss = bearerIss(input.authorization)
    return refuse(
      iss !== null && iss !== input.issuer
        ? `a token of ${iss} is not accepted: the panel serves the ops realm only`
        : 'the panel accepts no bearer token; sign in through the ops realm',
    )
  }
  const s = input.session
  if (!s) {
    if (input.sessionCookie) return refuse('the session cookie does not decode (forged or stale); it is cleared, sign in again', true)
    return read ? { kind: 'sign-in', reason: 'anonymous' } : refuse('not signed in')
  }
  if (s.error) return read ? { kind: 'sign-in', reason: 'expired' } : refuse('the session has expired; sign in again', true)
  if (sessionTooOld(s.authAt, input.now)) {
    return read
      ? { kind: 'sign-in', reason: 'expired' }
      : refuse(`the session is past its absolute session lifetime (${SESSION_ABSOLUTE_SECONDS} s since sign-in); sign in again`, true)
  }
  if (s.iss !== input.issuer) return refuse(`a session of ${s.iss ?? 'no issuer'} is not accepted: the panel serves the ops realm only`)
  if (!(s.roles ?? []).includes(OPERATOR_ROLE)) return refuse('the account holds no operator role')
  if (!s.uid) return refuse('the session carries no subject')
  if (s.acr !== input.requiredAcr) {
    return read ? { kind: 'sign-in', reason: 'step-up' } : refuse(`the session is ${s.acr ?? 'without acr'}, ${input.requiredAcr} is required`)
  }
  return { kind: 'allow', operator: { id: s.uid, email: s.email ?? null, iss: s.iss, acr: s.acr } }
}
