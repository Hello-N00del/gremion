// One decoded request path, computed once and used by EVERY path-prefix check
// in the hook chain (module gate, public paths, boot/resolve exemption, tenant
// leaf-callback claim, session-endpoint guard, ...).
//
// `event.url.pathname` is the RAW (still percent-encoded) path, while
// SvelteKit's router matches on the DECODED one. Comparing the raw value let
// `/api/fin%61nce` route to the finance handler while skipping every gate keyed
// on `/api/finance`. Decode once, here, and compare only that value.

/**
 * Decode a raw pathname exactly as the router does (decodeURI), so every check
 * sees the path the router will match. (%2F stays encoded here, as in the
 * router; module-gate.ts additionally folds it for its prefix match.)
 * Returns null for a malformed escape (caller answers 400).
 */
export function decodeRequestPath(rawPathname: string): string | null {
  try {
    return decodeURI(rawPathname)
  } catch {
    return null
  }
}

type PathEvent = { url: { pathname: string }; locals?: { decodedPath?: string } }

/** The decoded path of this request (cached on locals by requestPathHandle). */
export function requestPath(event: PathEvent): string {
  const cached = event.locals?.decodedPath
  if (cached !== undefined) return cached
  // Malformed input is rejected with 400 before any check runs; this fallback
  // only keeps the helper total (the raw path then matches no gated prefix).
  return decodeRequestPath(event.url.pathname) ?? event.url.pathname
}
