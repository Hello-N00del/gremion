// services/finance/src/http/server.ts
// The node:http server for the finance leaf (NO web framework). Request lifecycle:
//   /healthz          → guard-EXEMPT, returns {"status":"ok"}
//   /healthz/tenants  → guard-EXEMPT, per-tenant DB ping
//   everything else   → checkGuard() (403 bad secret / 400 bad tenant headers)
//                       then the router (404 unknown path / 405 wrong method /
//                       dispatch to the matched — currently surface-locked — handler)
import http from 'node:http'
import { createRouter, type Route, type RouteContext } from './router.js'
import { checkGuard, isHealthzPath } from './guard.js'
import { tenantHealthHandler, type TenantLister, type StoreFn } from './routes.js'

export interface ServerOptions {
  /** Shared secret expected in x-internal-auth (INTERNAL_FINANCE_SECRET). */
  secret: string | undefined
  /** API routes (the FinanceBackend surface). */
  routes?: Route[]
  /** Optional per-tenant health data source (/healthz/tenants). */
  healthz?: {
    listTenants: TenantLister
    storeFn: StoreFn
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
  res.writeHead(status, { 'content-type': 'application/json', ...extraHeaders })
  res.end(JSON.stringify(body))
}

export function createServer(opts: ServerOptions): http.Server {
  const router = createRouter(opts.routes ?? [])

  return http.createServer((req, res) => {
    void handle(req, res).catch((err) => {
      console.error('[finance] unhandled request error', err)
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
      if (path === '/healthz/tenants' && opts.healthz) {
        return tenantHealthHandler(res, opts.healthz.listTenants, opts.healthz.storeFn)
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

    // Route dispatch. Thread req + res + tenant into the context so handlers
    // in routes.ts can read the body and write the response directly.
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
