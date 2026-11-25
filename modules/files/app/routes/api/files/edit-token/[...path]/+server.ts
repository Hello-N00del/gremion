import { error, json } from '@sveltejs/kit'
import type { RequestEvent, RequestHandler } from '@sveltejs/kit'
import { createNextcloudClient } from '$lib/server/files/nextcloud-client'
import { buildWebdavPath } from '$lib/server/files/webdav-path'
import { isEditableFile } from '$lib/files/editable-types'
import type { SessionUser } from '$lib/auth'

/**
 * WOPI token endpoint for collaborative document editing.
 *
 * Given a Nextcloud-relative file path, returns a short-lived WOPI access
 * token plus the Collabora editor URL that the browser should load in an
 * iframe. The browser then opens a direct connection to Collabora — file
 * content never transits through SvelteKit.
 *
 * Flow:
 *   1. PROPFIND the file via WebDAV to resolve its Nextcloud fileId.
 *   2. Call the richdocuments OCS API with that fileId to mint a WOPI
 *      token and obtain the Collabora editor URL.
 *   3. Return { token, tokenTtl, editorUrl } to the caller.
 *
 * Shared dependency: Streams A4 (newsletter) and B4 (minutes) consume
 * this endpoint. Keep the response shape stable.
 */

export interface EditTokenResponse {
  token: string
  tokenTtl: number
  editorUrl: string
}

function requireAuth(event: RequestEvent): SessionUser {
  const user = event.locals.user as SessionUser | undefined
  if (!user) throw error(401, 'Unauthenticated')
  return user
}

function ncUsername(user: SessionUser): string {
  // Nextcloud user id = Keycloak UUID (user_oidc --unique-uid=0), not the
  // username. WebDAV/WOPI paths must key by user.id or they 404. See the
  // list endpoint in ../../[...path]/+server.ts for the full rationale.
  return user.id
}

export const GET: RequestHandler = async (event) => {
  const user = requireAuth(event)
  const paramPath = event.params.path ?? ''
  const fileName = paramPath.split('/').pop() ?? paramPath

  if (!isEditableFile(fileName)) {
    throw error(400, `File type not supported for editing: ${fileName}`)
  }

  const username = ncUsername(user)
  const webdavPath = buildWebdavPath(username, paramPath)
  const nc = createNextcloudClient({ webdavBearer: event.locals.accessToken ?? undefined })

  try {
    const fileId = await nc.getFileId(webdavPath, username)
    // getCollaboraEditorUrl resolves the full Collabora URL server-side.
    // Split the embedded token params back out for callers that need them separately.
    const { editorUrl: fullUrlStr, tokenTtl } = await nc.getCollaboraEditorUrl(fileId, username, { publicOrigin: event.url.origin })
    const fullUrl = new URL(fullUrlStr)
    const token = fullUrl.searchParams.get('access_token') ?? ''
    fullUrl.searchParams.delete('access_token')
    fullUrl.searchParams.delete('access_token_ttl')
    const body: EditTokenResponse = { token, tokenTtl, editorUrl: fullUrl.toString() }
    return json(body)
  } catch (err) {
    // A file the caller does not have in their own Nextcloud root, or one Nextcloud refuses, is the caller's 404 or
    // 403 (the files route maps it the same way). Rethrowing the upstream error object would reach the client as a
    // 500, because it is not an HttpError.
    const upstream = (err as { status?: number }).status
    const msg = err instanceof Error ? err.message : String(err)
    const fromMessage = /→ (40[34]):/.exec(msg)?.[1]
    const refused = upstream === 403 || upstream === 404 ? upstream : fromMessage ? Number(fromMessage) : undefined
    if (refused === 403) throw error(403, 'Forbidden')
    if (refused === 404) throw error(404, 'Not found')
    if (upstream) throw err
    throw error(502, msg)
  }
}
