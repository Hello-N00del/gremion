// gremion-ui/src/lib/server/files/backend/index.ts
// Factory: selects the files backend implementation based on the FILES_BACKEND
// environment variable.
//
//   unset / 'inprocess' → InprocessFilesClient (byte-identical to current behavior)
//   'service'           → ServiceFilesClient (HTTP ACL to FILES_SERVICE_URL)
//   anything else       → throws (fail-closed)
//
// The default is 'inprocess' until the deliberate (HELD) cutover. Only 'service'
// routes to the files-service leaf.
//
// Call sites obtain the backend once per request scope, passing the logged-in
// user's Keycloak access token as `webdavBearer` (WI-5b per-user OIDC WebDAV):
//   const backend = getFilesBackend({ webdavBearer: event.locals.accessToken ?? undefined })
//   const entries = await backend.propfind(webdavPath, uname)

import { InprocessFilesClient } from './inprocess-client'
import { ServiceFilesClient } from './service-client'
import { makeLogTracer, noopTracer } from '@gremion/ports/tracer'
import type { FilesBackendPort } from './port'

export type { FilesBackendPort, UploadChunkInput, UploadChunkResult, DavEntry } from './port'
// Re-export the NC error class so route handlers classify a bearer-drop / 401
// (the #161 "<!DOCTYPE … is not valid JSON" diagnostic) through the seam,
// never importing $lib/server/files/nextcloud-client directly.
export { NextcloudResponseError } from '../nextcloud-client'

export interface GetFilesBackendOptions {
  /** The logged-in user's Keycloak access token (locals.accessToken) — used as
   *  the WebDAV Bearer (WI-5b) on per-user file requests, and forwarded to the
   *  leaf in service mode. */
  webdavBearer?: string
  /** Optional per-request correlation id forwarded as x-correlation-id to the
   *  leaf AND used to bind files.acl.<op> spans when TRACE_EXPORTER=log. */
  correlationId?: string
}

/**
 * Resolve the files backend for the current FILES_BACKEND env.
 *
 * Default is 'inprocess': byte-identical to the monolith createNextcloudClient
 * calls. Set FILES_BACKEND=service to route to the files-service leaf.
 */
export function getFilesBackend(opts: GetFilesBackendOptions = {}): FilesBackendPort {
  const backend = process.env.FILES_BACKEND ?? 'inprocess'

  if (backend === 'inprocess') {
    return new InprocessFilesClient({ webdavBearer: opts.webdavBearer })
  }

  if (backend === 'service') {
    const traceExporter = process.env.TRACE_EXPORTER ?? 'none'
    const tracer =
      traceExporter === 'log' && opts.correlationId ? makeLogTracer(opts.correlationId) : noopTracer
    return new ServiceFilesClient({
      webdavBearer: opts.webdavBearer,
      correlationId: opts.correlationId,
      tracer,
    })
  }

  throw new Error(
    `[files-backend] Unknown FILES_BACKEND value: '${backend}'. ` +
      "Valid values are 'inprocess' (default) or 'service'.",
  )
}
