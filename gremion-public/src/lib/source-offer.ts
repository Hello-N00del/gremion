// gremion-public/src/lib/source-offer.ts
// AGPL-3.0 section 13: a user interacting with this program over a network must
// be offered the Corresponding Source of the version they are running. A licence
// file in the repository does not satisfy that — the offer has to be reachable
// from the running application, which is why both app shells render it in their
// footer chrome.
//
// PUBLIC_SOURCE_URL lets an operator point at THEIR fork: if they modified the
// program, the upstream repository is not the corresponding source and pointing
// at it would make the offer false. Unset, it falls back to upstream, which is
// correct for an unmodified deployment.

/** The upstream repository — the corresponding source of an unmodified deploy. */
export const DEFAULT_SOURCE_URL = 'https://github.com/Hello-N00del/gremion'

/** Link text. Names the licence so the offer is recognisable as the AGPL one. */
export const SOURCE_OFFER_LABEL = 'Source code (AGPL-3.0)'

/**
 * The URL to offer. Blank, whitespace-only and unset all mean "not configured"
 * — compose substitutes `${VAR:-}` as an EMPTY STRING, so `??` would happily
 * pass one through and render a link to nowhere.
 */
export function resolveSourceUrl(configured?: string | null): string {
  const v = configured?.trim()
  return v ? v : DEFAULT_SOURCE_URL
}
