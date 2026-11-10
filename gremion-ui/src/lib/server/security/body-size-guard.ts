import type { Handle } from '@sveltejs/kit'
import { requestPath } from '$lib/server/request-path'

// Request-size guard. The app container lifts adapter-node's body cap to 100 MiB
// (BODY_SIZE_LIMIT in docker-compose.app.yml) because the authenticated Files PUT
// streams one file of up to that size. Every OTHER route buffers its body whole
// (Auth.js reads the sign-in form with req.text() before any session or CSRF
// check, JSON endpoints call request.json()), so on those routes an anonymous
// client could hold ~100 MiB per request in a 1 GiB container. This guard keeps a
// small cap everywhere except the routes in BODY_SIZE_EXEMPTIONS:
//
//   - Content-Length above MAX_BUFFERED_BODY_BYTES (512 KiB) -> 413, body never read.
//   - A body with no Content-Length (Transfer-Encoding present) -> 413: the size
//     is unknown, so it cannot be bounded before it is buffered.
//
// Exemptions are keyed on method AND path. A buffering route that takes a larger
// body by design (the chat media upload, which reads a multipart form whole)
// carries its handler's own cap as maxBytes: Content-Length is required and must
// not exceed it. A streaming route (never buffered whole) carries no cap here and
// keeps the adapter's 100 MiB outer limit.
//
// It sits before every handle that can read a body and answers without touching
// the stream.
//
// Inventory (every route and form action reading a request body, checked when
// this table was written): the only bodies above 512 KiB by design are the chat
// media upload (buffered, 20 MiB) and the Files uploads (PUT /api/files/**, POST
// /api/files/upload-chunk; both streamed to Nextcloud). Every other handler reads
// a small JSON or urlencoded body; the .arrayBuffer() calls elsewhere read a
// RESPONSE (Collabora conversion), not the request. A new route that takes a larger
// body must add a row here and a test.

/** Largest body a buffering route accepts: 512 KiB, the adapter default the app had before the 100M lift. */
export const MAX_BUFFERED_BODY_BYTES = 512 * 1024

export interface BodySizeExemption {
  name: string
  method: string
  /** Matched against the decoded request path. */
  matches: (path: string) => boolean
  /** The handler's own cap. Undefined: a streamed body, left to the adapter's outer cap. */
  maxBytes?: number
}

export const BODY_SIZE_EXEMPTIONS: readonly BodySizeExemption[] = [
  {
    // Authenticated streaming upload of one file; never buffered.
    name: 'files-put',
    method: 'PUT',
    matches: (p) => p.startsWith('/api/files/'),
  },
  {
    // Authenticated streaming chunk upload; the body is piped to Nextcloud.
    name: 'files-upload-chunk',
    method: 'POST',
    matches: (p) => p === '/api/files/upload-chunk',
  },
  {
    // Chat attachment (photo, voice note, video): the handler reads the multipart
    // form whole and refuses above its own MAX_UPLOAD_BYTES (20 MiB).
    name: 'chat-media',
    method: 'POST',
    matches: (p) => /^\/api\/messages\/rooms\/[^/]+\/media$/.test(p),
    maxBytes: 20 * 1024 * 1024,
  },
]

function tooLarge(reason: string): Response {
  return new Response(JSON.stringify({ error: 'Payload Too Large', reason }), {
    status: 413,
    headers: { 'content-type': 'application/json' },
  })
}

export const bodySizeGuard: Handle = ({ event, resolve }) => {
  const path = requestPath(event)
  const exemption = BODY_SIZE_EXEMPTIONS.find((e) => e.method === event.request.method && e.matches(path))
  if (exemption && exemption.maxBytes === undefined) return resolve(event)
  const limit = exemption?.maxBytes ?? MAX_BUFFERED_BODY_BYTES

  const { headers } = event.request
  const length = headers.get('content-length')
  if (length !== null) {
    if (!/^\d+$/.test(length.trim())) return new Response('Bad Request', { status: 400 })
    return Number(length) > limit ? tooLarge('body_too_large') : resolve(event)
  }
  if (headers.get('transfer-encoding') !== null) return tooLarge('body_length_unknown')
  return resolve(event)
}
