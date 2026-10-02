// gremion-ui/src/lib/server/files/backend/service-client.ts
// HTTP ACL client: implements FilesBackendPort over the files-service leaf
// (FILES_SERVICE_URL). Only active when FILES_BACKEND=service (the HELD cutover);
// unused at runtime while the flag is OFF, but pinned by service-client.test.ts
// against contracts/files/openapi.files-internal.json.
//
// The leaf is a THIN Nextcloud WebDAV proxy: the kernel forwards the pre-built
// webdav path + the logged-in user's OIDC access token (x-webdav-bearer) and the
// leaf performs the WebDAV op against Nextcloud AS that user (WI-5b). Every
// request also carries x-internal-auth (INTERNAL_FILES_SECRET) + x-tenant-id +
// x-tenant-slug (+ x-correlation-id). Reads (propfind/download) retry ONCE on a
// network error or 503; writes never retry. Timeout: 5000ms per attempt.
//
// Mirrors the pattern in calendar/backend/service-client.ts.

import { getTenant } from '$lib/server/tenant/context'
import { noopTracer, type TracerPort } from '@gremion/ports/tracer'
import type {
  DavEntry,
  FilesBackendPort,
  UploadChunkInput,
  UploadChunkResult,
} from './port'

/** Thrown when the files leaf returns a non-2xx response. `status` mirrors the
 *  HTTP status so callers can map it to SvelteKit errors / Responses. */
export class FilesServiceError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(`[files-service-client] Leaf returned ${status}: ${message}`)
    this.name = 'FilesServiceError'
    this.status = status
  }
}

export interface ServiceFilesClientOptions {
  /** The logged-in user's Keycloak access token — forwarded as x-webdav-bearer. */
  webdavBearer?: string
  /** Optional correlation-id forwarded as x-correlation-id to the leaf. */
  correlationId?: string
  /** Optional TracerPort for span emission. Defaults to noopTracer. */
  tracer?: TracerPort
  /** Optional injectable fetch implementation (for testing). Defaults to globalThis.fetch. */
  fetchImpl?: typeof globalThis.fetch
}

const REQUEST_TIMEOUT_MS = 5000

function resolveServiceUrl(): string {
  const url = process.env.FILES_SERVICE_URL
  if (!url) {
    throw new Error(
      '[files-service-client] FILES_SERVICE_URL is not set. ' +
        "Configure it to point to the files leaf service (e.g. 'http://files-service:8080').",
    )
  }
  return url.replace(/\/$/, '')
}

function resolveSecret(): string {
  const secret = process.env.INTERNAL_FILES_SECRET
  if (!secret) {
    throw new Error(
      '[files-service-client] INTERNAL_FILES_SECRET is not set. ' +
        'The files leaf requires this shared secret in x-internal-auth.',
    )
  }
  return secret
}

export class ServiceFilesClient implements FilesBackendPort {
  readonly kind = 'service' as const

  private readonly webdavBearer: string | undefined
  private readonly correlationId: string | undefined
  private readonly tracer: TracerPort
  private readonly fetchImpl: typeof globalThis.fetch

  constructor(opts: ServiceFilesClientOptions = {}) {
    this.webdavBearer = opts.webdavBearer
    this.correlationId = opts.correlationId
    this.tracer = opts.tracer ?? noopTracer
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch
  }

  private buildHeaders(extra: Record<string, string> = {}): Record<string, string> {
    const secret = resolveSecret()
    const tenant = getTenant()
    const headers: Record<string, string> = {
      'x-internal-auth': secret,
      'x-tenant-id': tenant.id,
      'x-tenant-slug': tenant.slug,
      ...extra,
    }
    if (this.webdavBearer) headers['x-webdav-bearer'] = this.webdavBearer
    if (this.correlationId) headers['x-correlation-id'] = this.correlationId
    return headers
  }

  private async doFetch(
    method: string,
    path: string,
    headers: Record<string, string>,
    body: BodyInit | undefined,
  ): Promise<Response> {
    const url = `${resolveServiceUrl()}${path}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      return await this.fetchImpl(url, {
        method,
        headers,
        body,
        signal: controller.signal,
        // Node fetch requires duplex for a streaming request body.
        ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
      } as RequestInit)
    } finally {
      clearTimeout(timer)
    }
  }

  /** Raw leaf call (used by download / upload / uploadChunk — binary bodies).
   *  Returns the raw Response; throws FilesServiceError on non-2xx. `idempotent`
   *  retries ONCE on a network error or 503. */
  private async leafFetchRaw(
    op: string,
    method: string,
    path: string,
    headers: Record<string, string>,
    body: BodyInit | undefined,
    idempotent: boolean,
  ): Promise<Response> {
    const span = this.tracer.startSpan(`files.acl.${op}`, {
      correlationId: this.correlationId ?? 'none',
    })
    try {
      let res: Response
      try {
        res = await this.doFetch(method, path, headers, body)
        if (res.status === 503 && idempotent) res = await this.doFetch(method, path, headers, body)
      } catch (err) {
        if (idempotent) {
          res = await this.doFetch(method, path, headers, body)
        } else {
          throw err
        }
      }
      if (!res.ok) {
        const msg = await res.text().catch(() => `HTTP ${res.status}`)
        throw new FilesServiceError(res.status, msg.slice(0, 200))
      }
      span.end()
      return res
    } catch (err) {
      span.end(err)
      throw err
    }
  }

  /** JSON leaf call. Serializes `body` as JSON, parses the JSON response. */
  private async leafJson<T>(
    op: string,
    method: string,
    path: string,
    body: unknown,
    idempotent: boolean,
  ): Promise<T> {
    const headers = this.buildHeaders({ 'content-type': 'application/json' })
    const res = await this.leafFetchRaw(
      op,
      method,
      path,
      headers,
      body !== undefined ? JSON.stringify(body) : undefined,
      idempotent,
    )
    return (await res.json()) as T
  }

  // ── Browser WebDAV ops ───────────────────────────────────────────────────────

  async propfind(webdavPath: string, uname: string): Promise<DavEntry[]> {
    const res = await this.leafJson<{ entries: DavEntry[] }>(
      'propfind',
      'POST',
      '/api/v1/propfind',
      { path: webdavPath, user: uname },
      true,
    )
    return res.entries ?? []
  }

  async download(webdavPath: string, uname: string): Promise<Response> {
    const headers = this.buildHeaders({ 'content-type': 'application/json' })
    // Returns the raw streaming Response (binary body preserved for the route).
    return this.leafFetchRaw(
      'download',
      'POST',
      '/api/v1/download',
      headers,
      JSON.stringify({ path: webdavPath, user: uname }),
      true,
    )
  }

  async upload(webdavPath: string, uname: string, body: BodyInit, contentType: string): Promise<void> {
    const headers = this.buildHeaders({
      'content-type': contentType,
      'x-webdav-path': webdavPath,
      'x-webdav-user': uname,
    })
    await this.leafFetchRaw('upload', 'POST', '/api/v1/upload', headers, body, false)
  }

  async mkcol(webdavPath: string, uname: string): Promise<void> {
    await this.leafJson('mkcol', 'POST', '/api/v1/mkcol', { path: webdavPath, user: uname }, false)
  }

  async delete(webdavPath: string, uname: string): Promise<void> {
    await this.leafJson('delete', 'POST', '/api/v1/delete', { path: webdavPath, user: uname }, false)
  }

  async move(fromPath: string, toPath: string, uname: string): Promise<void> {
    await this.leafJson('move', 'POST', '/api/v1/move', { from: fromPath, to: toPath, user: uname }, false)
  }

  async copy(fromPath: string, toPath: string, uname: string): Promise<void> {
    await this.leafJson('copy', 'POST', '/api/v1/copy', { from: fromPath, to: toPath, user: uname }, false)
  }

  async uploadChunk(input: UploadChunkInput): Promise<UploadChunkResult> {
    const headers = this.buildHeaders({
      'content-type': 'application/octet-stream',
      'x-upload-id': input.uploadId,
      'x-upload-user': input.userId,
      'x-chunk-index': String(input.chunkIndex),
      'x-total-chunks': String(input.totalChunks),
      'x-final-path': input.sanitizedPath,
      ...(input.totalSize ? { 'x-total-size': input.totalSize } : {}),
    })
    const res = await this.leafFetchRaw(
      'upload-chunk',
      'POST',
      '/api/v1/upload-chunk',
      headers,
      input.body ?? undefined,
      false,
    )
    return (await res.json()) as UploadChunkResult
  }
}
