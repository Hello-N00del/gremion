// services/board/src/http/server.ts
// The node:http server (NO web framework). It owns the request lifecycle:
//   /healthz          → guard-EXEMPT, returns {"status":"ok"}
//   everything else   → checkGuard() (403 bad secret / 400 bad tenant headers)
//                       then the router (404 unknown path / 405 wrong method / dispatch)
// Routes receive an extended RouteContext carrying req + res + tenant so handlers
// in routes.ts can read the body and write the response directly.
import http from 'node:http'
import { createRouter, type Route, type RouteContext } from './router.js'
import { checkGuard, isHealthzPath } from './guard.js'

export interface ServerOptions {
  /** Shared secret expected in x-internal-auth (INTERNAL_BOARD_SECRET). */
  secret: string | undefined
  /** API routes. */
  routes?: Route[]
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
  res.writeHead(status, { 'content-type': 'application/json', ...extraHeaders })
  res.end(JSON.stringify(body))
}

export function createServer(opts: ServerOptions): http.Server {
  const router = createRouter(opts.routes ?? [])

  return http.createServer((req, res) => {
    void handle(req, res).catch((err) => {
      console.error('[board] unhandled request error', err)
      if (!res.headersSent) sendJson(res, 500, { success: false, error: 'internal error' })
    })
  })

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = req.method ?? 'GET'
    const path = (req.url ?? '/').split('?')[0] ?? '/'

    // Health probe: exempt from the guard, no tenant context.
    if (isHealthzPath(path)) {
      if (method !== 'GET') {
        return sendJson(res, 405, { success: false, error: 'method not allowed' }, { allow: 'GET' })
      }
      return sendJson(res, 200, { status: 'ok' })
    }

    // Internal guard: shared secret + tenant headers.
    const guard = checkGuard({
      path,
      headers: req.headers as Record<string, string | undefined>,
      secret: opts.secret,
    })
    if (!guard.ok) {
      return sendJson(res, guard.status, { success: false, error: guard.message })
    }

    const m = router.match(method, path)
    if (m.type === 'not-found') {
      return sendJson(res, 404, { success: false, error: 'not found' })
    }
    if (m.type === 'method-not-allowed') {
      return sendJson(res, 405, { success: false, error: 'method not allowed' }, { allow: [...m.allowed].join(', ') })
    }
    const ctx = { params: m.params, req, res, tenant: guard.tenant } as unknown as RouteContext
    await m.handler(ctx)
  }
}
