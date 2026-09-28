// services/finance/src/nextcloud/webdav-path.ts
// #383 Lane E, (d) — Nextcloud WebDAV path building + traversal guard for the
// receipt-storage backend. Ported verbatim from the native oracle
// gremion-ui/.../files/webdav-path.ts (G-023 / #257-2), with the SvelteKit `error()`
// replaced by a typed WebdavPathError the leaf's HTTP layer maps to 400.
//
// The guard loop-decodes until stable so an over-encoded traversal
// (`%252e%252e%252f`) cannot survive one decode and be re-decoded downstream into
// `../`; any residual `%` after full decoding is refused for the same reason.

/** Thrown on an unsafe/invalid WebDAV path; the route layer maps it to HTTP 400. */
export class WebdavPathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WebdavPathError'
  }
}

/**
 * Validate + canonicalise a client-supplied relative path. Loop-decodes (bounded)
 * until stable, rejects a residual `%`, rejects any `..` segment, and strips leading
 * slashes so the result is a clean namespace-relative path.
 */
export function sanitizeRelPath(paramPath: string): string {
  let decoded = paramPath
  for (let i = 0; i < 8; i++) {
    let next: string
    try {
      next = decodeURIComponent(decoded)
    } catch {
      // Malformed percent-escape (e.g. a lone `%`) — refuse rather than guess.
      throw new WebdavPathError('Invalid path encoding')
    }
    if (next === decoded) break
    decoded = next
  }
  if (decoded.includes('%')) {
    throw new WebdavPathError('Invalid path encoding')
  }
  if (decoded.split('/').some((seg) => seg === '..')) {
    throw new WebdavPathError('Path traversal not allowed')
  }
  return decoded.replace(/^\/+/, '')
}

/**
 * Build the `/remote.php/dav/files/<user>/<path>` WebDAV URL fragment for a
 * Nextcloud username and a client-supplied relative path. The username is
 * URL-encoded to support email-style `preferred_username` values.
 */
export function buildWebdavPath(ncUsername: string, paramPath: string): string {
  const clean = sanitizeRelPath(paramPath)
  return `/remote.php/dav/files/${encodeURIComponent(ncUsername)}/${clean}`
}
