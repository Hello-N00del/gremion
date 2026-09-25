// src/lib/server/tenant/host.ts
// Tenancy D1 (design spec §1.3) — the ONE host normaliser.
//
// It replaces resolve.ts:extractLeftmostLabel, which derived the tenant slug
// from the LEFTMOST DNS label of the edge-forwarded host. Under D1 a tenant
// brings its own domain, so the WHOLE host is the lookup key
// (tenant_domain.host, a PRIMARY KEY) and there is no label arithmetic left.
//
// Used by BOTH sides on purpose:
//   * the READ path — registry.resolveTenantByHost / getTenantStatusByHost,
//     which the resolver calls with the edge-injected `x-forwarded-host`;
//   * the WRITE path — registry.addTenantDomain, so a host that this function
//     could never produce can never be persisted. Read and write therefore
//     agree by construction: no registered row is unreachable, and no reachable
//     request can match a row the write path would have rejected.
//
// #256-2 hardening, carried over verbatim in intent from extractLeftmostLabel
// (the P2.1c edge makes every one of these header forms REACHABLE):
//  - comma/whitespace-joined lists (duplicate or chained X-Forwarded-Host
//    headers join to 'client-value, edge-value') are REJECTED outright —
//    taking the first (client-most) value would let an attacker-supplied
//    value win over the trusted hop's appended value; ambiguous = fail closed.
//  - exactly ONE trailing dot (FQDN root form) is stripped, so 'example.org.'
//    normalises to the SAME key as 'example.org' instead of missing the lookup
//    (or, under the old model, bypassing the labels.length < 3 rule).
//  - EMPTY labels anywhere ('tenant..org', '.t.example.org') are rejected.
//
// Additional D1 hardening, because the host is now the whole selector:
//  - the ASCII LDH charset check runs BEFORE lowercasing, so no Unicode case
//    fold (U+212A KELVIN SIGN -> 'k', U+0130 -> 'i'+combining) can smuggle a
//    non-ASCII byte into a key that matches a registered ASCII host. IDN must
//    arrive as punycode A-labels ('xn--bcher-kva.example'), which is what the
//    edge and every HTTP client actually send; raw Unicode is rejected.
//  - the port suffix must be a plain numeric ':<digits>' or the whole value is
//    rejected. The old `split(':', 1)[0]` silently accepted 'evil.com:80@x' as
//    'evil.com' and turned an IPv6 literal '[::1]:443' into '['. Ambiguous
//    authority forms now fail closed instead of resolving to *something*.
//  - RFC 1035 length limits (253 total, 63 per label) are enforced.
//
// PURE: no I/O, no env, no DB — safe to import from anywhere on the server.

/** RFC-1035 letter-digit-hyphen plus the label separator, plus the port colon. */
const ASCII_HOST_CHARS = /^[A-Za-z0-9.:-]+$/
/** A port suffix is a plain 1..5 digit number and nothing else. */
const NUMERIC_PORT = /^[0-9]{1,5}$/
/** RFC 1035 §2.3.4 — 255 octets of wire form, 253 characters of presentation form. */
const MAX_HOST_LENGTH = 253
/** RFC 1035 §2.3.4 — one label is at most 63 octets. */
const MAX_LABEL_LENGTH = 63

/**
 * Normalise a raw `x-forwarded-host` (or an operator-supplied domain) into the
 * canonical `tenant_domain.host` lookup key, or null when the value is absent,
 * malformed or in ANY way ambiguous.
 *
 * Null is the ONLY failure signal, and every caller MUST treat it as "reject" —
 * never as "fall back to a default tenant" (spec §1.7 / §6 fail-closed RULE).
 * There is no default tenant for an unrecognised host, ever.
 */
export function normaliseHost(raw: string | undefined | null): string | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed) return null

  // Multi-value list (comma-joined) or any embedded whitespace — fail closed.
  if (/[,\s]/.test(trimmed)) return null

  // ASCII-only BEFORE toLowerCase(), so no Unicode fold can produce an ASCII
  // key. Also rejects '@' (userinfo), '/' (path), '[' / ']' (IPv6 literal),
  // '*' (wildcard), '_' and every control character.
  if (!ASCII_HOST_CHARS.test(trimmed)) return null

  // Strip a port suffix, but only a well-formed one. Anything else is ambiguous.
  let host = trimmed
  const colon = trimmed.indexOf(':')
  if (colon !== -1) {
    if (!NUMERIC_PORT.test(trimmed.slice(colon + 1))) return null
    host = trimmed.slice(0, colon)
  }

  host = host.toLowerCase()

  // Exactly ONE trailing FQDN root dot; a second one leaves an empty label and
  // is rejected by the label check below.
  if (host.endsWith('.')) host = host.slice(0, -1)
  if (!host) return null
  if (host.length > MAX_HOST_LENGTH) return null

  const labels = host.split('.')
  for (const label of labels) {
    if (label.length === 0) return null // empty label anywhere — reject
    if (label.length > MAX_LABEL_LENGTH) return null
  }

  return host
}

/** The scheme + authority prefix of an absolute URL; group 1 is the authority. */
const URL_AUTHORITY = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]+)/

/**
 * The `tenant_domain.host` a tenant's `issuer` implies — `normaliseHost` applied
 * to the issuer's authority. Null when the issuer has no authority this resolver
 * could ever match.
 *
 * Tenancy D1 (§1.2/§1.4). `iss-match.ts:assertIssMatch` is BYTE-STRICT, so a
 * tenant's primary host and its issuer host must agree exactly; the only way to
 * guarantee that is to derive one from the other with a SINGLE parser. This is
 * that parser, and migration 004's seed is its byte-for-byte SQL twin
 * (`substring(issuer from '^[a-zA-Z][a-zA-Z0-9+.-]*://([^/?#]+)')`, a numeric
 * port stripped, lowercased, LDH/length-checked) — so the migration's seed and
 * `registerDefaultTenant`'s env reconcile cannot disagree about what a given
 * issuer means.
 *
 * ⚠ Deliberately NOT `new URL(issuer).host`, which diverges from that SQL twin
 * in two measured ways and would reintroduce exactly the host/issuer drift this
 * exists to prevent:
 *   * `new URL('https:///auth/realms/x').host` is `'auth'` — WHATWG collapses
 *     the empty authority and promotes the first PATH SEGMENT to the hostname.
 *     A typo'd issuer would silently become a tenant's canonical host. The SQL
 *     matches nothing there, and so does this.
 *   * `new URL()` IDNA-encodes, so raw-unicode `https://bücher.example/…`
 *     becomes `xn--bcher-kva.example`. The SQL sees the raw bytes and rejects
 *     them, and so does this — host.ts's standing rule is that IDN must ARRIVE
 *     as punycode A-labels, because that is what the wire carries and therefore
 *     what Keycloak stamps into `iss`.
 */
export function hostFromIssuer(issuer: string | undefined | null): string | null {
  if (!issuer) return null
  const authority = URL_AUTHORITY.exec(issuer.trim())?.[1]
  if (!authority) return null
  return normaliseHost(authority)
}
