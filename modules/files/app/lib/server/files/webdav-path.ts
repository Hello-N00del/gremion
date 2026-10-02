import { error } from '@sveltejs/kit'

/**
 * Server-side validation + canonicalisation for Nextcloud WebDAV paths.
 *
 * Centralised here so every files-API route applies the same guard against
 * path-traversal segments and the same URL-encoded user namespace prefix.
 * Previously inlined in `routes/api/files/[...path]/+server.ts` and
 * `routes/api/files/edit-token/[...path]/+server.ts`; consolidated as part
 * of G-023 so chunked uploads share the same validation.
 *
 * Decoding is intentional: SvelteKit passes the URL-encoded segments
 * through `params.path`, so a literal "%2E%2E" must collapse to ".."
 * before the traversal guard runs.
 *
 * #257-2: the guard previously decoded exactly ONCE, a shallower depth than the
 * admin-credentialed upload-chunk consumer + Nextcloud's own decode. An
 * over-encoded segment (e.g. `%25252e%25252e%25252f`) survived one decode as
 * `%2e%2e%2f` — no literal `..` segment, so it passed — then Nextcloud decoded
 * it again into `../`, escaping the per-user namespace. We now loop-decode until
 * the string is stable (bounded), reject any RESIDUAL `%` so no encoded
 * traversal can be decoded downstream, and only then run the `..`/absolute-path
 * checks on the fully-decoded form. Applied uniformly here so every files route
 * — including the admin-credentialed upload-chunk path — is covered.
 */
export function sanitizeRelPath(paramPath: string): string {
  // Loop-decode until the value stops changing (or a malformed escape throws),
  // bounded to defeat a pathological deeply-nested encoding.
  let decoded = paramPath
  for (let i = 0; i < 8; i++) {
    let next: string
    try {
      next = decodeURIComponent(decoded)
    } catch {
      // Malformed percent-escape (e.g. a lone `%`) — refuse rather than guess.
      throw error(400, 'Invalid path encoding')
    }
    if (next === decoded) break
    decoded = next
  }
  // Any residual `%` after full decoding is a smuggled (or malformed) escape that
  // a downstream decoder could turn into a traversal — reject it.
  if (decoded.includes('%')) {
    throw error(400, 'Invalid path encoding')
  }
  if (decoded.split('/').some((seg) => seg === '..')) {
    throw error(400, 'Path traversal not allowed')
  }
  return decoded.replace(/^\/+/, '')
}

/**
 * Builds the full `/remote.php/dav/files/<user>/<path>` WebDAV URL fragment
 * for the given Nextcloud username and a client-supplied relative path.
 *
 * The username is URL-encoded to support email-style usernames and other
 * non-alphanumeric identifiers Keycloak may emit as `preferred_username`.
 */
export function buildWebdavPath(ncUsername: string, paramPath: string): string {
  const clean = sanitizeRelPath(paramPath)
  return `/remote.php/dav/files/${encodeURIComponent(ncUsername)}/${clean}`
}

/**
 * #241: validate a stored `pdf_nextcloud_path` before it is used to build an
 * admin-credentialed WebDAV download of a published protocol PDF.
 *
 * `uploadPublishedPdf` (protocol-wopi.ts) writes this column as
 * `/protocols/published/<id>/protocol.pdf`, so the value is server-controlled —
 * but this guard is the last line of defence against a future writer, a manual
 * edit, or SQL-level tampering turning the download into an arbitrary read of
 * the storage user's whole namespace. We pin the published-protocols prefix
 * (allowlist), reject any `..` segment, and reject a raw `%` so an encoded
 * traversal (`%2e%2e`) can never be decoded into `..` downstream.
 */
export function validatePublishedPdfPath(pdfPath: string): string {
  const ok =
    pdfPath.startsWith('/protocols/published/') &&
    !pdfPath.includes('%') &&
    !pdfPath.split('/').some((seg) => seg === '..')
  if (!ok) throw error(400, 'Invalid published PDF path')
  return pdfPath
}
