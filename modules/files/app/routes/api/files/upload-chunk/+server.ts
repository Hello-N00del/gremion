import { error, json } from '@sveltejs/kit'
import type { RequestEvent, RequestHandler } from '@sveltejs/kit'
import { Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth'
import { sanitizeRelPath } from '$lib/server/files/webdav-path'
import { resolveFilesBackendOr503 } from '$lib/server/files/backend/resolve'

function requireAuth(event: RequestEvent): SessionUser {
  const user = event.locals.user as SessionUser | undefined
  if (!user) throw error(401, 'Unauthenticated')
  return user
}

function requireWrite(user: SessionUser): void {
  if (user.roles.length === 1 && user.roles[0] === Role.Guest) {
    throw error(403, 'Read-only')
  }
}

// G-023: uploadId is interpolated into the Nextcloud DAV URL between
// `/dav/uploads/<userId>/` and `/<chunk>`. Without a format check a hostile
// client could send `../other-user-id/some-upload` to escape its per-user
// namespace. The session-user prefix already namespaces writes (an attacker
// would also need to write into that other user's path), so this regex is
// defence-in-depth — restrict to a safe character set typical of UUID/ULID
// upload IDs so the URL stays well-formed.
const UPLOAD_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/

export const POST: RequestHandler = async (event) => {
  const user = requireAuth(event)
  requireWrite(user)

  const p = event.url.searchParams
  const uploadId = p.get('uploadId')
  const chunkIndex = parseInt(p.get('chunkIndex') ?? '0', 10)
  const totalChunks = parseInt(p.get('totalChunks') ?? '1', 10)
  const finalPath = p.get('finalPath')
  const totalSize = p.get('totalSize')

  if (!uploadId || !finalPath) throw error(400, 'Missing uploadId or finalPath')
  if (!UPLOAD_ID_PATTERN.test(uploadId)) throw error(400, 'Invalid uploadId format')
  if (isNaN(chunkIndex) || isNaN(totalChunks)) throw error(400, 'Invalid chunk params')

  // Apply the same path-traversal guard as `routes/api/files/[...path]`:
  // decodeURIComponent → reject `..` segments → strip leading slashes.
  const sanitizedPath = sanitizeRelPath(finalPath)

  const body = event.request.body
  if (!body && totalChunks > 1) throw error(400, 'Empty chunk')

  // The chunk PUT + assemble MOVE go through the files backend seam. Flag OFF
  // (FILES_BACKEND unset) → the inprocess client runs the SAME raw admin-Basic
  // fetch path this handler used before the seam (env via $env/dynamic/private,
  // PUT the padded chunk, MOVE-assemble on the last chunk — byte-identical);
  // FILES_BACKEND=service routes the chunk to the files leaf, which assembles it
  // Nextcloud-side. Auth + uploadId/path validation stay above so a rejected
  // request never reaches Nextcloud.
  const resolved = resolveFilesBackendOr503()
  if (resolved instanceof Response) return resolved
  const { complete } = await resolved.uploadChunk({
    userId: user.id,
    uploadId,
    chunkIndex,
    totalChunks,
    sanitizedPath,
    totalSize,
    body: body as ReadableStream<Uint8Array> | null
  })

  return json({ success: true, complete })
}
