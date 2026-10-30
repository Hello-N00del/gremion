// Same-origin path validation for every redirect target that comes from a request (login
// callbackUrl, step-up returnTo, locale-switch redirectTo, the Auth.js redirect callback).
// Isomorphic on purpose: it only needs the WHATWG URL class, so a +page.svelte and a
// server module can share it.

/** Longest accepted target (path + query + fragment), in UTF-16 code units. */
const MAX_LENGTH = 2048

/**
 * C0 controls, DEL and C1 controls. WHATWG URL parsing strips tab/CR/LF, so '/\t/host'
 * would resolve to '//host'; CR/LF would also break a Location header.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/

/** Percent-encoded '/' or '\' (any case). */
const ENCODED_SLASH = /%(?:2f|5c)/i

/**
 * A fixed origin to resolve against: nothing about the request (Host, proxy headers) can
 * influence what counts as "the same origin". `.invalid` never resolves (RFC 2606).
 */
const RESOLVE_BASE = new URL('https://redirect-target.invalid/')

/**
 * Accept only a same-origin relative path, returned in the URL parser's own normalised
 * serialisation (pathname + search + hash); anything else yields `fallback`.
 *
 * The raw value must be a string that starts with a single '/', carries no backslash and
 * no control character. It is then resolved against a fixed base and accepted only when
 * the origin is unchanged and the NORMALISED path still starts with a single '/', has no
 * backslash and contains no encoded slash or backslash: dot segments such as '/.//host'
 * collapse to '//host' during parsing, and '/\host' is read as '//host' by browsers.
 * Absolute URLs (including javascript: and data:) never start with '/', so they fall
 * through to the fallback.
 *
 * `fallback` is returned as given; pass a safe path.
 */
export function sameOriginPath(raw: unknown, fallback = '/'): string {
  if (typeof raw !== 'string' || raw.length > MAX_LENGTH) return fallback
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\') || CONTROL_CHARS.test(raw)) return fallback
  let target: URL
  try {
    target = new URL(raw, RESOLVE_BASE)
  } catch {
    return fallback
  }
  if (target.origin !== RESOLVE_BASE.origin) return fallback
  const { pathname } = target
  if (!pathname.startsWith('/') || pathname.startsWith('//') || pathname.includes('\\') || ENCODED_SLASH.test(pathname)) {
    return fallback
  }
  return pathname + target.search + target.hash
}

/**
 * Auth.js `callbacks.redirect`. Same contract as the library default (a relative target is
 * joined to baseUrl, an absolute one must be on baseUrl's origin, anything else lands on
 * baseUrl) with the path run through {@link sameOriginPath}.
 */
export function authRedirect({ url, baseUrl }: { url: string; baseUrl: string }): string {
  if (url.startsWith('/')) return baseUrl + sameOriginPath(url)
  try {
    const target = new URL(url)
    if (target.origin === new URL(baseUrl).origin) {
      return baseUrl + sameOriginPath(target.pathname + target.search + target.hash)
    }
  } catch {
    // not a parseable absolute URL: fall through to the root
  }
  return baseUrl
}
