// src/lib/server/tenant/reserved-hosts.ts
// Spec A §C / §H.2 — the platform-reserved names under PLATFORM_DOMAIN. None
// may ever be a tenant host. This is the ONE module that owns the list: the
// normaliser lives in ./host.ts and imports nothing from here.
//
// The refusal lives on registry.addTenantDomain (spec B §T.1), BEFORE any DNS
// pre-flight: the pre-flight asks "does this name point at us?", which is
// exactly TRUE for every name below, so it can never catch them.
//
// Checked on BOTH the raw (trimmed, lowercased) candidate and on the
// normaliseHost output, returning the SAME named error either way. The raw
// check is what catches `_dmarc.<apex>`, whose underscore host.ts:43 rejects
// outright — without it that one name would be refused with a "not a valid
// host" message and never reach this list at all.
//
// The eight labels are the same list an operator sees as RESERVED_HOSTS at
// infra/host/templates/env/state.env.tmpl:69; reserved-hosts.test.ts asserts
// the two are equal.
//
// PURE: no I/O, no env, no DB. The apex is passed in so this stays testable and
// so B18's router emitter can call it with the same value the assembler wrote.

/** The eight reserved LABELS; the apex itself is the ninth reserved name. */
export const RESERVED_PLATFORM_LABELS: readonly string[] = Object.freeze([
  'www', 'control', 'rs1', 'mail', 'mta-sts', 'autoconfig', 'autodiscover', '_dmarc',
])

/** The nine reserved names for a given PLATFORM_DOMAIN, apex first. */
export function reservedPlatformHosts(platformDomain: string): readonly string[] {
  const apex = platformDomain.trim().toLowerCase().replace(/\.$/, '')
  if (!apex) {
    throw new Error(
      'reservedPlatformHosts: PLATFORM_DOMAIN is unset — refusing to compute an empty reserved set',
    )
  }
  return [apex, ...RESERVED_PLATFORM_LABELS.map((l) => `${l}.${apex}`)]
}

/**
 * Is `candidate` one of the nine? Compared as a literal string against the set,
 * after trimming, lowercasing, stripping one trailing FQDN dot and a numeric
 * port suffix — the same spellings host.ts collapses, done here without
 * re-implementing the normaliser (there is exactly one of those).
 */
export function isReservedPlatformHost(candidate: string, platformDomain: string): boolean {
  if (typeof candidate !== 'string') return false
  let c = candidate.trim().toLowerCase()
  c = c.replace(/:[0-9]{1,5}$/, '')
  c = c.replace(/\.$/, '')
  return reservedPlatformHosts(platformDomain).includes(c)
}
