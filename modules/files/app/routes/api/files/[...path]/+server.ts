import { error, json } from '@sveltejs/kit'
import type { RequestEvent, RequestHandler } from '@sveltejs/kit'
import { resolveFilesBackendOr503 } from '$lib/server/files/backend/resolve'
import { NextcloudResponseError } from '$lib/server/files/backend'
import { buildWebdavPath } from '$lib/server/files/webdav-path'
import { Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth'
import { fileResponseContentType, isViewableFile } from '$lib/files/editable-types'

/** F1-FIX-03 / H17: the CSP of every user-file response (see GET). */
const FILE_RESPONSE_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'"

function requireAuth(event: RequestEvent): SessionUser {
  const user = event.locals.user as SessionUser | undefined
  if (!user) throw error(401, 'Unauthenticated')
  return user
}

/** True for a user whose ONLY role is Guest. Guests are not provisioned a
 *  Nextcloud account (no OIDC user, no WebDAV root), so any files call on their
 *  bearer 404s → 502 → "<!DOCTYPE … is not valid JSON" in the browser (#194).
 *  Callers short-circuit such users with a clean, typed JSON response. */
function isGuestOnly(user: SessionUser): boolean {
  return user.roles.length === 1 && user.roles[0] === Role.Guest
}

function requireWrite(user: SessionUser): void {
  if (isGuestOnly(user)) {
    throw error(403, 'Read-only')
  }
}

/**
 * #161 instrumentation: emit a structured diagnostic when Nextcloud answers a
 * files request with an HTML page / non-JSON body / 401 where WebDAV XML was
 * expected — the non-reproducible "<!DOCTYPE … is not valid JSON" failure that
 * recurs for normal users "after concurrent work". We do NOT claim a root-cause
 * fix; this log captures enough state (request path, NC status + key headers +
 * body snippet, and the bearer/token expiry state) to diagnose it from a real
 * occurrence. The single-line `[files:nc-bearer-drop]` tag matches the
 * `[routeTag]` console.error convention used by finance/route-errors.ts.
 */
function logBearerDropDiagnostic(
  event: RequestEvent,
  paramPath: string,
  ncErr: NextcloudResponseError
): void {
  const now = Date.now()
  const expires = event.locals.accessTokenExpires
  // We never trigger a refresh here — the Auth.js jwt() callback owns refresh and
  // runs before this handler. So "refreshAttempted" is always false at this seam;
  // the value worth capturing is whether the bearer was ALREADY expired when NC
  // rejected it (would point at a refresh/clock-skew gap) vs. still-valid (would
  // point at NC-side config drift / user_oidc cache eviction).
  const tokenState = {
    hasBearer: Boolean(event.locals.accessToken),
    expiresAt: expires ? new Date(expires).toISOString() : null,
    expiresInMs: expires ? expires - now : null,
    expiredAtRequest: expires ? expires <= now : null,
    refreshAttemptedHere: false,
  }
  console.error('[files:nc-bearer-drop]', {
    requestPath: paramPath,
    webdavMethod: ncErr.method,
    ncStatus: ncErr.status,
    ncContentType: ncErr.contentType,
    ncIsHtml: ncErr.isHtml,
    ncBodySnippet: ncErr.bodySnippet,
    tokenState,
  })
}

function ncUsername(user: SessionUser): string {
  // Nextcloud provisions OIDC users with --unique-uid=0, so the Nextcloud
  // user id IS the Keycloak UUID (token.sub → user.id), NOT preferred_username.
  // The WebDAV root is /remote.php/dav/files/<uuid>/; using the username 404s
  // (→ 502 → "unexpected token" in the Dokumente browser). Matches the
  // provisioning side and upload-chunk, which already key by user.id.
  return user.id
}

export const GET: RequestHandler = async (event) => {
  const user = requireAuth(event)
  // #194: guests are never provisioned a Nextcloud account, so a WebDAV call on
  // their bearer always fails (404 → 502 → "<!DOCTYPE … is not valid JSON"). The
  // /files page + nav entry are now member-gated, but answer a clean, typed JSON
  // 403 here too (defense in depth) so a direct API hit or a stale client never
  // sees a raw parse error. The client renders this reason as a "kein
  // Dokumentenzugriff" state instead of an error banner.
  if (isGuestOnly(user)) {
    return json(
      { success: false, error: 'no_document_access', reason: 'no_document_access' },
      { status: 403 }
    )
  }
  const resolved = resolveFilesBackendOr503({ webdavBearer: event.locals.accessToken ?? undefined })
  if (resolved instanceof Response) return resolved
  const backend = resolved
  const paramPath = event.params.path ?? ''
  const webdavPath = buildWebdavPath(ncUsername(user), paramPath)

  try {
    const hasExtension = /\.[a-zA-Z0-9]+$/.test(paramPath.split('/').pop() ?? '')
    if (hasExtension) {
      const upstream = await backend.download(webdavPath, ncUsername(user))
      const filename = paramPath.split('/').pop() ?? 'download'
      // F1-FIX-03 / H17: the Content-Type is fixed per extension (never the
      // upstream value, which follows the uploaded file), and only the fixed
      // viewable list (no .svg) is ever inline.
      const contentType = fileResponseContentType(filename)
      const inline = event.url.searchParams.get('inline') === '1' && isViewableFile(filename)
      const disposition = inline
        ? `inline; filename*=UTF-8''${encodeURIComponent(filename)}`
        : `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`
      const headers: Record<string, string> = {
        'Content-Type': contentType,
        'Content-Disposition': disposition,
        'X-Content-Type-Options': 'nosniff',
      }
      // A user file never runs script on the app origin: `sandbox` gives the
      // document an opaque origin with scripts off, `default-src 'none'` loads
      // nothing. Images and text still display under it. The one exception is
      // an inline PDF: browsers refuse to start their PDF viewer in a sandboxed
      // document, and that viewer does not run the file's script in this origin.
      if (!(inline && contentType === 'application/pdf')) {
        headers['Content-Security-Policy'] = FILE_RESPONSE_CSP
      }
      return new Response(upstream.body, { headers })
    }
    const uname = ncUsername(user)
    const entries = await backend.propfind(webdavPath, uname)
    // Strip the full DAV prefix so paths returned to the client are relative
    // (e.g. "Projects/Plan.pdf", not "/remote.php/dav/files/testuser/Projects/Plan.pdf").
    // This prevents path doubling when the client appends the path back to the API URL.
    const baseDavPath = `/remote.php/dav/files/${encodeURIComponent(uname)}/`
    const files = entries
      .map((e) => {
        // Nextcloud emits hrefs with the configured webroot prefix
        // (overwritewebroot=/cloud → "/cloud/remote.php/dav/files/<user>/…"),
        // so locate the DAV base within the href instead of assuming it starts it.
        const baseIdx = e.href.indexOf(baseDavPath)
        const rel = baseIdx >= 0
          ? e.href.slice(baseIdx + baseDavPath.length).replace(/\/$/, '')
          : e.href.replace(/\/$/, '')
        return {
          path: rel,
          name: e.displayName,
          is_dir: e.isCollection,
          is_locked: false,
          etag: e.etag ?? '',
          size: e.contentLength ?? 0,
          last_modified: new Date(e.lastModified).toISOString(),
        }
      })
      // Skip the entry for the directory itself (empty rel path = current dir)
      .filter((f) => f.path !== '')
    return json({ success: true, files })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // #161: when Nextcloud rejects the bearer it returns an HTML login/error page
    // (or a 401) where WebDAV XML was expected — the non-reproducible
    // "<!DOCTYPE … is not valid JSON" failure that recurs "after concurrent
    // work". Capture a structured diagnostic so a real occurrence can be
    // root-caused (this is NOT a fix — the trigger is still unknown), then return
    // a clean, typed JSON error the client can render as a retry state rather
    // than letting the raw HTML reach res.json().
    if (err instanceof NextcloudResponseError && (err.isHtml || err.status === 401)) {
      logBearerDropDiagnostic(event, paramPath, err)
      // 502 (not 401): by the time this handler runs the authGuard has validated
      // the stura session and the Auth.js jwt() callback has refreshed the access
      // token, so an NC 401/HTML means NC rejected an otherwise-valid bearer — a
      // server-side condition, not a user session expiry. Returning 401 would
      // bounce the browser to /auth/login and, with auto-sign-in, loop forever.
      // A typed 502 lets the client show a reportable "could not load" retry
      // state instead of an unbreakable redirect cycle.
      return json(
        { success: false, error: 'nextcloud_unavailable', reason: 'nextcloud_unavailable' },
        { status: 502 }
      )
    }
    // A WebDAV 404/403 (folder absent or no access for this user) must surface
    // as a clean status — not a 502. A 502 from this endpoint is re-wrapped by
    // the edge proxy as an HTML error page, and the client's res.json() then
    // throws "Unexpected token '<'". Map the upstream status through instead.
    const upstream = /→ (40[34]):/.exec(msg)?.[1]
    if (upstream) throw error(Number(upstream), msg)
    throw error(502, msg)
  }
}

export const PUT: RequestHandler = async (event) => {
  const user = requireAuth(event)
  requireWrite(user)
  const resolved = resolveFilesBackendOr503({ webdavBearer: event.locals.accessToken ?? undefined })
  if (resolved instanceof Response) return resolved
  const backend = resolved
  const paramPath = event.params.path ?? ''
  const uname = ncUsername(user)
  const webdavPath = buildWebdavPath(uname, paramPath)
  const mkdir = event.url.searchParams.get('mkdir') === 'true'

  try {
    if (mkdir) {
      await backend.mkcol(webdavPath, uname)
    } else {
      const contentType = event.request.headers.get('Content-Type') ?? 'application/octet-stream'
      await backend.upload(webdavPath, uname, event.request.body as ReadableStream<Uint8Array>, contentType)
    }
    return json({ success: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw error(502, msg)
  }
}

export const DELETE: RequestHandler = async (event) => {
  const user = requireAuth(event)
  requireWrite(user)
  const resolved = resolveFilesBackendOr503({ webdavBearer: event.locals.accessToken ?? undefined })
  if (resolved instanceof Response) return resolved
  const backend = resolved
  const paramPath = event.params.path ?? ''
  const uname = ncUsername(user)
  const webdavPath = buildWebdavPath(uname, paramPath)

  try {
    await backend.delete(webdavPath, uname)
    return json({ success: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw error(502, msg)
  }
}

export const PATCH: RequestHandler = async (event) => {
  const user = requireAuth(event)
  requireWrite(user)
  const resolved = resolveFilesBackendOr503({ webdavBearer: event.locals.accessToken ?? undefined })
  if (resolved instanceof Response) return resolved
  const backend = resolved
  const paramPath = event.params.path ?? ''
  const uname = ncUsername(user)
  const webdavPath = buildWebdavPath(uname, paramPath)

  let body: { action: string; destination: string }
  try {
    body = await event.request.json()
  } catch {
    throw error(400, 'Invalid JSON body')
  }

  const { action, destination } = body
  if (!action || !destination) throw error(400, 'Missing action or destination')

  try {
    if (action === 'move' || action === 'rename') {
      // G-021: route the rename destination through buildWebdavPath so the
      // shared path-traversal guard catches `..` segments. This makes rename
      // semantics match move/copy: `destination` is interpreted as a path
      // relative to the user's webdav root, not appended to the source dir.
      const destPath = buildWebdavPath(uname, destination)
      await backend.move(webdavPath, destPath, uname)
    } else if (action === 'copy') {
      await backend.copy(webdavPath, buildWebdavPath(uname, destination), uname)
    } else {
      throw error(400, `Unknown action: ${action}`)
    }
    return json({ success: true })
  } catch (err) {
    if ((err as { status?: number }).status) throw err
    const msg = err instanceof Error ? err.message : String(err)
    throw error(502, msg)
  }
}
