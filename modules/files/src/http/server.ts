// services/files/src/http/server.ts
// The node:http server for the files leaf (NO web framework). Request lifecycle:
//   /healthz          → guard-EXEMPT, returns {"status":"ok"}
//   /api/v1/*         → checkGuard() (403 bad secret / 400 bad tenant headers)
//                       then dispatch the WebDAV op to the WebdavClient.
//   everything else   → 404
// The leaf is a THIN proxy: it forwards the kernel-supplied webdav path + the
// user's OIDC bearer (x-webdav-bearer) to Nextcloud and relays the result.
import http from 'node:http'
import { Readable, pipeline } from 'node:stream'
import { checkGuard, isHealthzPath } from './auth.js'
import {
  createWebdavClient,
  NextcloudUpstreamError,
  WebdavAuthError,
  type WebdavClient,
} from '../nextcloud/webdav-client.js'
import { sanitizeRelPath, WebdavPathError } from '../nextcloud/webdav-path.js'

/** The ops that run AS the logged-in user (x-webdav-bearer required). */
const BROWSER_OPS: ReadonlySet<string> = new Set([
  '/api/v1/propfind',
  '/api/v1/download',
  '/api/v1/upload',
  '/api/v1/mkcol',
  '/api/v1/delete',
  '/api/v1/move',
  '/api/v1/copy',
])

export interface ServerOptions {
  /** Shared secret expected in x-internal-auth (INTERNAL_FILES_SECRET). */
  secret: string | undefined
  /** WebDAV client. Defaults to createWebdavClient() (env-configured). Injectable for tests. */
  client?: WebdavClient
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function readJson<T>(req: http.IncomingMessage): Promise<T> {
  const buf = await readBody(req)
  return JSON.parse(buf.toString('utf8') || '{}') as T
}

export function createServer(opts: ServerOptions): http.Server {
  const client = opts.client ?? createWebdavClient()

  return http.createServer((req, res) => {
    void handle(req, res).catch((err) => {
      console.error('[files] unhandled request error', err)
      if (!res.headersSent) sendJson(res, 500, { success: false, error: 'internal error' })
    })
  })

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = req.method ?? 'GET'
    const path = (req.url ?? '/').split('?')[0] ?? '/'

    // Health probe: exempt from the guard, no tenant context.
    if (isHealthzPath(path)) {
      if (method !== 'GET') return sendJson(res, 405, { success: false, error: 'method not allowed' })
      return sendJson(res, 200, { status: 'ok' })
    }

    // Internal guard: shared secret (constant-time) + tenant headers.
    const guard = checkGuard({
      path,
      headers: req.headers as Record<string, string | undefined>,
      secret: opts.secret,
    })
    if (!guard.ok) return sendJson(res, guard.status, { success: false, error: guard.message })

    if (method !== 'POST') return sendJson(res, 405, { success: false, error: 'method not allowed' })

    const bearer = (req.headers['x-webdav-bearer'] as string | undefined) || undefined

    // F1-FIX-03 / K5#3 + K5#32: a browser op runs AS the user or not at all. It
    // used to fall back to the Nextcloud ADMIN credentials when the bearer was
    // missing. Refused here before the body is read; the client enforces the
    // same (WebdavAuthError) for any other caller. upload-chunk is the one
    // system-scoped op and keeps the admin credentials.
    if (BROWSER_OPS.has(path) && !bearer) {
      return sendJson(res, 401, { success: false, error: 'missing x-webdav-bearer' })
    }

    try {
      switch (path) {
        case '/api/v1/propfind': {
          const { path: p } = await readJson<{ path: string; user: string }>(req)
          const entries = await client.propfind(p, bearer)
          return sendJson(res, 200, { entries })
        }
        case '/api/v1/download': {
          const { path: p } = await readJson<{ path: string; user: string }>(req)
          const upstream = await client.download(p, bearer)
          res.writeHead(200, {
            'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
          })
          if (upstream.body) {
            // F1-FIX-03 / S4#0 + K5#16: pipeline(), not .pipe(). .pipe() does not
            // forward errors, so an upstream reset mid-body emitted 'error' on the
            // Readable with no listener: an uncaught exception that killed the
            // whole leaf. pipeline() handles both ends: on failure it destroys the
            // response (the client sees an aborted download) and we log it.
            pipeline(Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream), res, (err) => {
              if (err) console.error('[files] download stream failed mid-body:', err.message)
            })
          } else {
            res.end()
          }
          return
        }
        case '/api/v1/upload': {
          const p = req.headers['x-webdav-path'] as string | undefined
          const contentType = (req.headers['content-type'] as string | undefined) ?? 'application/octet-stream'
          if (!p) return sendJson(res, 400, { success: false, error: 'missing x-webdav-path' })
          const buf = await readBody(req)
          await client.upload(p, bearer, buf, contentType)
          return sendJson(res, 200, { success: true })
        }
        case '/api/v1/mkcol': {
          const { path: p } = await readJson<{ path: string; user: string }>(req)
          await client.mkcol(p, bearer)
          return sendJson(res, 200, { success: true })
        }
        case '/api/v1/delete': {
          const { path: p } = await readJson<{ path: string; user: string }>(req)
          await client.delete(p, bearer)
          return sendJson(res, 200, { success: true })
        }
        case '/api/v1/move': {
          const { from, to } = await readJson<{ from: string; to: string; user: string }>(req)
          await client.move(from, to, bearer)
          return sendJson(res, 200, { success: true })
        }
        case '/api/v1/copy': {
          const { from, to } = await readJson<{ from: string; to: string; user: string }>(req)
          await client.copy(from, to, bearer)
          return sendJson(res, 200, { success: true })
        }
        case '/api/v1/upload-chunk': {
          const uploadId = req.headers['x-upload-id'] as string | undefined
          const userId = req.headers['x-upload-user'] as string | undefined
          const finalPath = req.headers['x-final-path'] as string | undefined
          if (!uploadId || !userId || !finalPath) {
            return sendJson(res, 400, { success: false, error: 'missing chunk headers' })
          }
          const chunkIndex = parseInt((req.headers['x-chunk-index'] as string) ?? '0', 10)
          const totalChunks = parseInt((req.headers['x-total-chunks'] as string) ?? '1', 10)
          const totalSize = (req.headers['x-total-size'] as string | undefined) ?? null
          const sanitizedPath = sanitizeRelPath(finalPath)
          const buf = await readBody(req)
          const result = await client.uploadChunk({
            userId,
            uploadId,
            chunkIndex,
            totalChunks,
            sanitizedPath,
            totalSize,
            body: buf.length > 0 ? buf : null,
          })
          return sendJson(res, 200, result)
        }
        default:
          return sendJson(res, 404, { success: false, error: 'not found' })
      }
    } catch (err) {
      if (err instanceof WebdavPathError) {
        return sendJson(res, 400, { success: false, error: err.message })
      }
      if (err instanceof WebdavAuthError) {
        return sendJson(res, 401, { success: false, error: 'missing x-webdav-bearer' })
      }
      if (err instanceof NextcloudUpstreamError) {
        return sendJson(res, 502, { success: false, error: err.message })
      }
      throw err
    }
  }
}
