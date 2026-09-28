// services/content/src/http/server.ts
// The node:http server (NO web framework — D-P1-1). It owns the request lifecycle:
//   /healthz          → guard-EXEMPT, returns {"status":"ok"}
//   /healthz/tenants  → guard-EXEMPT, per-tenant DB ping
//   /api/admin/*      → secret-only guard (NO tenant headers), adminRoutes router
//   everything else   → checkGuard() (403 bad secret / 400 bad tenant headers) then
//                       the router (404 unknown path / 405 wrong method / dispatch)
// Routes receive an extended RouteContext carrying req + res + tenant so
// handlers in routes.ts can read the body and write the response directly.
import http from 'node:http'
import { createRouter, type Route, type RouteContext } from './router.js'
import { checkGuard, isHealthzPath } from './guard.js'
import type { TenantLister, StoreFn } from './routes.js'
import { tenantHealthHandler } from './routes.js'

export interface ServerOptions {
  /** Shared secret expected in x-internal-auth (INTERNAL_CONTENT_SECRET). */
  secret: string | undefined
  /** API routes. Empty array in the scaffold. */
  routes?: Route[]
  /**
   * Admin routes (secret-only guard — no tenant headers required).
   * Matched for any path under /api/admin/.
   */
  adminRoutes?: Route[]
  /** Optional per-tenant health data source (/healthz/tenants). */
  healthz?: {
    listTenants: TenantLister
    storeFn: StoreFn
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', ...extraHeaders })
  res.end(payload)
}

export function createServer(opts: ServerOptions): http.Server {
  const router = createRouter(opts.routes ?? [])
  const adminRouter = createRouter(opts.adminRoutes ?? [])

  return http.createServer((req, res) => {
    void handle(req, res).catch((err) => {
      // Last-resort handler — never leak internals.
      console.error('[content] unhandled request error', err)
      if (!res.headersSent) sendJson(res, 500, { success: false, error: 'internal error' })
    })
  })

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = req.method ?? 'GET'
    // Strip the query string; node gives us a path-relative URL.
    const path = (req.url ?? '/').split('?')[0] ?? '/'

    // Health probe: exempt from the guard, no tenant context.
    if (isHealthzPath(path)) {
      if (method !== 'GET') {
        return sendJson(res, 405, { success: false, error: 'method not allowed' }, { allow: 'GET' })
      }
      // /healthz/tenants → per-tenant DB ping.
      if (path === '/healthz/tenants' && opts.healthz) {
        return tenantHealthHandler(res, opts.healthz.listTenants, opts.healthz.storeFn)
      }
      return sendJson(res, 200, { status: 'ok' })
    }

    // Admin routes (/api/admin/*): secret-only guard, NO tenant headers required.
    // These are operator lifecycle endpoints (tenant teardown) called by the kernel
    // provisioning script. The secret check is handled inside each handler so that
    // the router can return 404/405 before the secret check on unmatched paths.
    if (path.startsWith('/api/admin/')) {
      const am = adminRouter.match(method, path)
      if (am.type === 'not-found') {
        return sendJson(res, 404, { success: false, error: 'not found' })
      }
      if (am.type === 'method-not-allowed') {
        return sendJson(
          res,
          405,
          { success: false, error: 'method not allowed' },
          { allow: [...am.allowed].join(', ') },
        )
      }
      const adminCtx = { params: am.params, req, res } as unknown as RouteContext
      return am.handler(adminCtx)
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

    // Route dispatch. Thread req + res + tenant into the context so
    // handlers in routes.ts can read the body and write the response directly.
    const m = router.match(method, path)
    if (m.type === 'not-found') {
      return sendJson(res, 404, { success: false, error: 'not found' })
    }
    if (m.type === 'method-not-allowed') {
      return sendJson(res, 405, { success: false, error: 'method not allowed' }, { allow: [...m.allowed].join(', ') })
    }
    // Cast to include the extended ApiContext fields that routes.ts handlers expect.
    const ctx = { params: m.params, req, res, tenant: guard.tenant } as unknown as RouteContext
    await m.handler(ctx)
  }
}
