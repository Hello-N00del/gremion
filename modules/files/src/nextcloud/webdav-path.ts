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

/** Thrown when a path fails validation — the server maps it to HTTP 400. */
export class WebdavPathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WebdavPathError'
  }
}
