// gremion-ui/src/lib/server/files/backend/resolve.ts
// Consumer-facing resolution helper that maps a backend-construction failure to
// a graceful 503 instead of an uncaught 500.
//
// Why: getFilesBackend() (index.ts) THROWS for an unknown FILES_BACKEND value.
// The files-browser routes obtain their backend through this helper so a
// misconfiguration (or any other backend-construction error) surfaces as a 503
// the client can retry, NOT a 500. With FILES_BACKEND unset (the flag-OFF
// default) construction always succeeds, so this is byte-identical to the
// pre-seam route at runtime.

import { getFilesBackend, type FilesBackendPort, type GetFilesBackendOptions } from './index'

/** Body returned by the API 503. */
const UNAVAILABLE_BODY = 'Files backend unavailable'

/**
 * API-route resolver: returns the backend, or a 503 Response when the backend
 * cannot be constructed (e.g. FILES_BACKEND=unknown-value).
 *
 * Usage:
 *   const resolved = resolveFilesBackendOr503({ webdavBearer })
 *   if (resolved instanceof Response) return resolved
 *   const backend = resolved
 */
export function resolveFilesBackendOr503(
  opts: GetFilesBackendOptions = {},
): FilesBackendPort | Response {
  try {
    return getFilesBackend(opts)
  } catch (err) {
    console.error('[files-backend] resolution failed → 503:', err)
    return new Response(UNAVAILABLE_BODY, {
      status: 503,
      headers: { 'Retry-After': '30' },
    })
  }
}
