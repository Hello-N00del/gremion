// The public portal address of this instance, or null when none is set up.
//
// The tenant brand falls back to a neutral "localhost" placeholder when the
// configured org domain is empty (see $lib/brand DEFAULT_BRAND). That value is
// a stand-in for "nothing configured", never a real portal address, so the
// dashboard and the portal admin page must treat it as absent instead of
// presenting it as if it were published.

const LOCAL_ONLY = /^(localhost|127\.0\.0\.1|\[?::1\]?)$|\.localhost$/i

export function configuredPortalDomain(raw: string | null | undefined): string | null {
  const value = (raw ?? '').trim()
  if (value === '' || LOCAL_ONLY.test(value)) return null
  return value
}
