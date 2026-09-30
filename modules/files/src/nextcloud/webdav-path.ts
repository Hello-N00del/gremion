// services/files/src/nextcloud/webdav-path.ts
// Server-side validation + canonicalisation for Nextcloud WebDAV paths, scoped
// to the files leaf. Mirrors gremion-ui/src/lib/server/files/webdav-path.ts —
// this is a SEPARATE process so the guard is duplicated, not imported; keep the
// two in sync. Used as defense-in-depth on paths the kernel forwards, and to
// build the chunked-upload assemble destination.

/** Loop-decode → reject residual `%` → reject `..` segments → strip leading `/`.
 *  Throws on a malformed percent-escape or a traversal attempt. */
export function sanitizeRelPath(paramPath: string): string {
  let decoded = paramPath
  for (let i = 0; i < 8; i++) {
    let next: string
    try {
      next = decodeURIComponent(decoded)
    } catch {
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

/** Build the `/remote.php/dav/files/<user>/<path>` WebDAV URL fragment. */
export function buildWebdavPath(ncUsername: string, paramPath: string): string {
  const clean = sanitizeRelPath(paramPath)
  return `/remote.php/dav/files/${encodeURIComponent(ncUsername)}/${clean}`
}

/** Percent-encode each segment of an already-sanitised relative path exactly
 *  once ('/' separators kept). '#', '?', spaces and non-ASCII characters then
 *  survive a URL and a header value intact (K5#2 / S4#24). */
export function encodeRelPath(sanitizedRel: string): string {
  return sanitizedRel.split('/').map(encodeURIComponent).join('/')
}

const DAV_FILES_PREFIX = '/remote.php/dav/files/'

/**
 * F1-FIX-03 / K5#3 + K5#32: validate a kernel-forwarded WebDAV path and return
 * its wire form. Every op runs its path (and a move/copy destination) through
 * this before anything reaches Nextcloud; the leaf used to validate 1 of 8 ops
 * and forward any other string by concatenation.
 *
 *   - must be a string starting with `/remote.php/dav/files/<user>/` (so it can
 *     name neither another DAV tree nor another host);
 *   - `<user>` must be non-empty, not `.`/`..`, and in its canonical
 *     encodeURIComponent form (what buildWebdavPath produces; kept as sent);
 *   - the rest goes through sanitizeRelPath (decode, reject residual `%`, reject
 *     `..`) and is re-encoded per segment with encodeRelPath.
 *
 * Throws WebdavPathError (-> HTTP 400) on any violation.
 */
export function toUpstreamDavPath(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.startsWith(DAV_FILES_PREFIX)) {
    throw new WebdavPathError('path must start with /remote.php/dav/files/<user>/')
  }
  const rest = raw.slice(DAV_FILES_PREFIX.length)
  const slash = rest.indexOf('/')
  const userSeg = slash === -1 ? rest : rest.slice(0, slash)
  const rel = slash === -1 ? '' : rest.slice(slash + 1)
  let user: string
  try {
    user = decodeURIComponent(userSeg)
  } catch {
    throw new WebdavPathError('Invalid path encoding')
  }
  if (!user || user === '.' || user === '..' || encodeURIComponent(user) !== userSeg) {
    throw new WebdavPathError('Invalid user segment')
  }
  return `${DAV_FILES_PREFIX}${userSeg}/${encodeRelPath(sanitizeRelPath(rel))}`
}

/** Thrown when a path fails validation — the server maps it to HTTP 400. */
export class WebdavPathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WebdavPathError'
  }
}
