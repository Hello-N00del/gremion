import { error, json } from '@sveltejs/kit'
import type { RequestEvent, RequestHandler } from '@sveltejs/kit'
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto'
import { getMessagesBackend } from '$lib/server/messages/backend'
import type { SessionUser } from '$lib/auth'

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024 // 20 MB
const ALLOWED_MIME_PREFIXES = ['image/', 'video/', 'audio/', 'application/pdf', 'text/plain']

function requireAuth(event: RequestEvent): SessionUser {
  const user = event.locals.user as SessionUser | undefined
  if (!user) throw error(401, 'Unauthenticated')
  return user
}

async function getKeycloakJwt(event: RequestEvent): Promise<string> {
  const authHeader = event.request.headers.get('Authorization')
  if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7)
  const session = await event.locals.auth()
  const accessToken = (session as unknown as { accessToken?: string })?.accessToken
  if (!accessToken) throw error(401, 'No Keycloak access token in session')
  return accessToken
}

function getAuthSecret(): string {
  const s = process.env.AUTH_SECRET
  if (!s) throw new Error('AUTH_SECRET not set')
  return s
}

// Signed media URLs bind {mxc, roomId, exp}. The key is HKDF-derived from AUTH_SECRET with a
// purpose label, so the session-signing secret itself never keys these MACs.
const MEDIA_URL_TTL_SECONDS = 15 * 60
const MEDIA_KEY_INFO = 'gremion/messaging/media-url/v1'

function mediaKey(): Buffer {
  return Buffer.from(hkdfSync('sha256', getAuthSecret(), '', MEDIA_KEY_INFO, 32))
}

function signMedia(mxcUri: string, roomId: string, exp: number): string {
  return createHmac('sha256', mediaKey()).update(`${mxcUri}\n${roomId}\n${exp}`).digest('hex')
}

function verifyMedia(mxcUri: string, roomId: string, exp: number, sig: string): boolean {
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false
  const expected = Buffer.from(signMedia(mxcUri, roomId, exp), 'hex')
  const given = Buffer.from(sig, 'hex')
  return given.length === expected.length && timingSafeEqual(given, expected)
}

// Content types that are safe to echo. Anything else (html, svg, xml, js, ...) is
// served as an opaque download.
const SAFE_DOWNLOAD_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif',
  'video/mp4', 'video/webm', 'audio/mpeg', 'audio/ogg', 'audio/mp4', 'audio/webm', 'audio/wav',
  'application/pdf', 'text/plain',
])

function safeContentType(upstream: string | undefined): string {
  const base = (upstream ?? '').split(';')[0]!.trim().toLowerCase()
  return SAFE_DOWNLOAD_TYPES.has(base) ? base : 'application/octet-stream'
}

// Documented request shape: `multipart/form-data` with a single `file` field.
// The Content-Type allowlist is enforced against the UPLOADED FILE's own MIME
// type (file.type), NOT the request Content-Type — the request Content-Type is
// always `multipart/form-data; boundary=…`, which by construction never matches
// a media prefix. (The previous implementation allowlisted the request
// Content-Type and then called formData(): multipart 415'd on the allowlist and
// a raw body 500'd inside formData(); no shape satisfied both.)
export const POST: RequestHandler = async (event) => {
  requireAuth(event)

  const contentLength = parseInt(event.request.headers.get('Content-Length') ?? '0', 10)
  if (contentLength > MAX_UPLOAD_BYTES) throw error(413, 'File too large (max 20 MB)')

  const requestContentType = event.request.headers.get('Content-Type') ?? ''
  if (!requestContentType.toLowerCase().includes('multipart/form-data')) {
    throw error(415, 'Expected multipart/form-data upload with a "file" field')
  }

  let formData: FormData
  try {
    formData = await event.request.formData()
  } catch {
    throw error(400, 'Invalid multipart form data')
  }
  const file = formData.get('file')
  if (!(file instanceof File)) throw error(400, 'Missing file field')

  // Validate the FILE's own content type against the media allowlist.
  const fileType = file.type || 'application/octet-stream'
  const isAllowed = ALLOWED_MIME_PREFIXES.some(
    (prefix) => fileType === prefix || fileType.startsWith(prefix)
  )
  if (!isAllowed) throw error(415, 'Unsupported media type')
  if (file.size > MAX_UPLOAD_BYTES) throw error(413, 'File too large (max 20 MB)')

  const mc = getMessagesBackend().matrix()
  const keycloakJwt = await getKeycloakJwt(event)
  const matrixToken = await mc.getMatrixToken(keycloakJwt)

  const mxcUri = await mc.uploadMedia(matrixToken, await file.arrayBuffer(), file.type, file.name)

  // Sign the mxc URI — proxy URL prevents arbitrary SSRF
  const roomId = event.params.roomId ?? ''
  const exp = Math.floor(Date.now() / 1000) + MEDIA_URL_TTL_SECONDS
  const sig = signMedia(mxcUri, roomId, exp)
  const proxyUrl = `/api/messages/rooms/${encodeURIComponent(roomId)}/media?mxc=${encodeURIComponent(mxcUri)}&exp=${exp}&sig=${sig}`

  return json({
    success: true,
    data: { url: proxyUrl, filename: file.name, mimeType: file.type }
  })
}

export const GET: RequestHandler = async (event) => {
  requireAuth(event)

  const mxcUri = event.url.searchParams.get('mxc')
  const sig = event.url.searchParams.get('sig')
  const exp = Number(event.url.searchParams.get('exp'))
  const roomId = event.params.roomId ?? ''

  if (!mxcUri || !sig) throw error(400, 'Missing mxc or sig params')
  if (!verifyMedia(mxcUri, roomId, exp, sig)) throw error(403, 'Invalid or expired media signature')

  // The URL is a capability for ONE room: the caller must still be a member of it.
  const backend = getMessagesBackend()
  const creds = await backend.resolveMatrixCreds(event)
  if (!creds.userId || !(await backend.synapse().isRoomMember(roomId, creds.userId))) {
    throw error(403, 'Not a member of this room')
  }

  const { data, contentType } = await backend.matrix().downloadMedia(mxcUri)

  return new Response(data, {
    headers: {
      'Content-Type': safeContentType(contentType),
      'Content-Disposition': 'attachment',
      'X-Content-Type-Options': 'nosniff',
    }
  })
}
