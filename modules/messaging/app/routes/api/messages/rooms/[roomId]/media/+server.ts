import { error, json } from '@sveltejs/kit'
import type { RequestEvent, RequestHandler } from '@sveltejs/kit'
import { createHmac } from 'crypto'
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

function signMxc(mxcUri: string): string {
  return createHmac('sha256', getAuthSecret()).update(mxcUri).digest('hex')
}

function verifyMxc(mxcUri: string, sig: string): boolean {
  const expected = signMxc(mxcUri)
  // Constant-time comparison
  if (expected.length !== sig.length) return false
  let result = 0
  for (let i = 0; i < expected.length; i++) result |= expected.charCodeAt(i) ^ sig.charCodeAt(i)
  return result === 0
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
  const sig = signMxc(mxcUri)
  const roomId = event.params.roomId ?? ''
  const proxyUrl = `/api/messages/rooms/${encodeURIComponent(roomId)}/media?mxc=${encodeURIComponent(mxcUri)}&sig=${sig}`

  return json({
    success: true,
    data: { url: proxyUrl, filename: file.name, mimeType: file.type }
  })
}

export const GET: RequestHandler = async (event) => {
  requireAuth(event)

  const mxcUri = event.url.searchParams.get('mxc')
  const sig = event.url.searchParams.get('sig')

  if (!mxcUri || !sig) throw error(400, 'Missing mxc or sig params')
  if (!verifyMxc(mxcUri, sig)) throw error(403, 'Invalid media signature')

  const mc = getMessagesBackend().matrix()
  const { data, contentType } = await mc.downloadMedia(mxcUri)

  return new Response(data, {
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': 'attachment'
    }
  })
}
