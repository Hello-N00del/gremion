import type { Handle } from '@sveltejs/kit'
import { requestPath } from '$lib/server/request-path'

// Request-size guard. The app container lifts adapter-node's body cap to 100 MiB
// (BODY_SIZE_LIMIT in docker-compose.app.yml) because the authenticated Files PUT
// streams one file of up to that size. Every OTHER route buffers its body whole
// (Auth.js reads the sign-in form with req.text() before any session or CSRF
// check, JSON endpoints call request.json()), so on those routes an anonymous
// client could hold ~100 MiB per request in a 1 GiB container. This guard keeps a
// small cap everywhere except the upload routes:
//
//   - Content-Length above MAX_BUFFERED_BODY_BYTES (512 KiB) -> 413, body never read.
//   - A body with no Content-Length (Transfer-Encoding present) -> 413: the size
//     is unknown, so it cannot be bounded before it is buffered.
//
// It sits before every handle that can read a body and answers without touching
// the stream. The adapter's 100M limit stays as the outer cap for the exempt
// upload routes.

/** Largest body a buffering route accepts: 512 KiB, the adapter default the app had before the 100M lift. */
export const MAX_BUFFERED_BODY_BYTES = 512 * 1024

/** Streaming upload routes (authenticated, never buffered whole) keep the adapter cap. */
export const STREAMING_UPLOAD_PREFIX = '/api/files/'

function tooLarge(reason: string): Response {
  return new Response(JSON.stringify({ error: 'Payload Too Large', reason }), {
    status: 413,
    headers: { 'content-type': 'application/json' },
  })
}

export const bodySizeGuard: Handle = ({ event, resolve }) => {
  if (requestPath(event).startsWith(STREAMING_UPLOAD_PREFIX)) return resolve(event)

  const { headers } = event.request
  const length = headers.get('content-length')
  if (length !== null) {
    if (!/^\d+$/.test(length.trim())) return new Response('Bad Request', { status: 400 })
    return Number(length) > MAX_BUFFERED_BODY_BYTES ? tooLarge('body_too_large') : resolve(event)
  }
  if (headers.get('transfer-encoding') !== null) return tooLarge('body_length_unknown')
  return resolve(event)
}
