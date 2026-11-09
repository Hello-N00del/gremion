import { redirect, error } from '@sveltejs/kit'
import type { PageServerLoad } from './$types'
import { createNextcloudClient } from '$lib/server/files/nextcloud-client'
import { buildWebdavPath } from '$lib/server/files/webdav-path'
import { isEditableFile } from '$lib/files/editable-types'
import type { SessionUser } from '$lib/auth'

export const load: PageServerLoad = async ({ params, locals }) => {
  const user = locals.user as SessionUser | undefined
  if (!user) throw redirect(302, '/auth/login')

  const paramPath = params.path ?? ''
  const fileName = paramPath.split('/').pop() ?? paramPath

  if (!isEditableFile(fileName)) throw redirect(302, '/files')

  // Nextcloud user id = Keycloak UUID (user_oidc --unique-uid=0), not username.
  const username = user.id
  // The same guard as every files route (loop decode, backslash and control
  // characters, `..`): a hand-rolled copy let `.<LF>.` and `%252e%252e` through.
  const webdavPath = buildWebdavPath(username, paramPath)

  // Back URL: parent folder so "← Zurück" lands in the right directory.
  const parts = paramPath.split('/').filter(Boolean)
  parts.pop()
  const backPath = parts.length > 0 ? '/files/' + parts.join('/') : '/files'

  // WI-5b: authenticate WebDAV as this user via their OIDC bearer (locals.accessToken).
  const nc = createNextcloudClient({ webdavBearer: locals.accessToken ?? undefined })
  try {
    const fileId = await nc.getFileId(webdavPath, username)
    const { editorUrl, tokenTtl } = await nc.getCollaboraEditorUrl(fileId, username)
    // paramPath flows back to the client so the editor can call
    // /api/files/edit-token/<path> for silent token refresh without
    // reconstructing the URL-encoded path on its own.
    return { editorUrl, tokenTtl, fileName, backPath, paramPath }
  } catch (err) {
    if ((err as { status?: number }).status) throw err
    const msg = err instanceof Error ? err.message : String(err)
    throw error(502, `Editor konnte nicht geöffnet werden: ${msg}`)
  }
}
