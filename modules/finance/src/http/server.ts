// services/finance/src/http/server.ts
// The node:http server for the finance leaf (NO web framework). Request lifecycle:
//   /healthz          → guard-EXEMPT, returns {"status":"ok"}
//   /healthz/tenants  → internal secret required (401 otherwise), booleans only
//   everything else   → checkGuard() (403 bad secret / 400 bad tenant headers)
//                       then the router (404 unknown path / 405 wrong method /
//                       dispatch to the matched — currently surface-locked — handler)
import http from 'node:http'
import { createRouter, type Route, type RouteContext } from './router.js'
import { checkGuard, hasInternalSecret, isHealthzPath } from './guard.js'
import { BadJsonBodyError, tenantHealthHandler, type TenantLister, type StoreFn } from './routes.js'
import { InvalidTenantIdError, InvalidTenantSlugError, TenantIdentityMismatchError } from '../tenant-store.js'

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
        // F1-FIX-05-K (K4#32): the per-tenant probe is internal-only. Plain /healthz
        // (the container healthcheck) stays unauthenticated.
        if (!hasInternalSecret(req.headers as Record<string, string | undefined>, opts.secret)) {
          return sendJson(res, 401, { success: false, error: 'unauthorized' })
        }
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
    try {
      await m.handler(ctx)
    } catch (err) {
      // F1-FIX-05-K (K4#4): a malformed / non-object JSON body is the caller's error.
      if (err instanceof BadJsonBodyError && !res.headersSent) {
        return sendJson(res, 400, { success: false, error: err.message })
      }
      // The (id, slug) pair is not the one the catalog binds (audit #534): a stale or
      // forged pair, never a server fault. The body names neither tenant.
      if (err instanceof TenantIdentityMismatchError && !res.headersSent) {
        console.warn(`[finance] ${err.message}`)
        return sendJson(res, 409, { success: false, error: 'tenant_identity_mismatch' })
      }
      // A tenant id that is not a canonical lowercase uuid, or a slug storeFor will not
      // build a database name from (follow-up to audit #534): the caller's error, never
      // a server fault. The body names nothing.
      if (err instanceof InvalidTenantIdError && !res.headersSent) {
        console.warn(`[finance] ${err.message}`)
        return sendJson(res, 400, { success: false, error: 'invalid_tenant_id' })
      }
      if (err instanceof InvalidTenantSlugError && !res.headersSent) {
        console.warn(`[finance] ${err.message}`)
        return sendJson(res, 400, { success: false, error: 'invalid_tenant_slug' })
      }
      throw err
    }
  }
}
