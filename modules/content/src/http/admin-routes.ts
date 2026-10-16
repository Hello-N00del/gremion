// services/content/src/http/admin-routes.ts
//
// Task 23 fix: admin HTTP endpoints for tenant teardown, called by the kernel
// provisioning script (tenant-provision.ts makeContentLeafShredExecutor).
// These routes are guarded by x-internal-auth ONLY — they do NOT require
// x-tenant-id / x-tenant-slug because they operate across/on behalf of a
// tenant being deleted.
//
// Endpoints:
//   DELETE /api/admin/tenants/:slug/db
//     — ends and evicts the tenant's in-process pool(s), then drops the
//       content_<slug> database (DROP DATABASE IF EXISTS). An open connection
//       blocks the drop, and a pool left in the registry would keep serving a
//       database that is gone.
//     — idempotent: missing DB is a no-op (returns 200).
//     — the reserved slug `control` (the catalog database) is refused (400).
//     — guard: x-internal-auth timingSafeEqual vs INTERNAL_CONTENT_SECRET.
//
//   DELETE /api/admin/tenants/:tenantId/catalog
//     — removes the tenant row from the control catalog and evicts the tenant's
//       in-process pool(s).
//     — refused with 409 while the tenant's database still exists: the catalog
//       row is what binds the id to that database, and removing it first would
//       let a new id be bound to an old database. Drop the database first.
//     — idempotent: missing row is a no-op (returns 200).
//     — guard: x-internal-auth timingSafeEqual vs INTERNAL_CONTENT_SECRET.

import type http from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import postgres from 'postgres'
import type { Route } from './router.js'
import { SLUG_PATTERN } from './guard.js'
import { RESERVED_SLUGS, evictTenantPools } from '../tenant-store.js'

// ── secret check (secret-only, no tenant-header requirement) ─────────────────

function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  const len = Math.max(a.length, b.length)
  const pa = Buffer.alloc(len)
  const pb = Buffer.alloc(len)
  a.copy(pa)
  b.copy(pb)
  return timingSafeEqual(pa, pb) && a.length === b.length
}

function checkAdminSecret(
  headers: Record<string, string | string[] | undefined>,
  secret: string | undefined,
): boolean {
  if (!secret) return false
  const provided = headers['x-internal-auth']
  if (!provided || Array.isArray(provided)) return false
  return secretMatches(provided, secret)
}

// ── response helper ───────────────────────────────────────────────────────────

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(payload)
}

// ── admin route factory ───────────────────────────────────────────────────────

export interface AdminRouteDeps {
  /** INTERNAL_CONTENT_SECRET — required for auth. */
  secret: string | undefined
  /**
   * Admin PG URL for the content Postgres instance (CONTENT_PG_URL).
   * Used to DROP DATABASE and to reach the control catalog.
   * Falls back to the process env at call time if not supplied.
   */
  pgUrl?: string
  /** Database name prefix. Production = `content_` (the default); tests override. */
  dbPrefix?: string
}

/**
 * Build the admin Route[] for the content leaf teardown pipeline.
 * Mount into the server BEFORE the tenant-guard route table so the server
 * can dispatch them via the admin-router (bypassing checkGuard entirely).
 */
export function buildAdminRoutes(deps: AdminRouteDeps): Route[] {
  const dbPrefix = deps.dbPrefix ?? 'content_'

  function getPgUrl(): string {
    const url = deps.pgUrl ?? process.env.CONTENT_PG_URL
    if (!url) throw new Error('[admin] CONTENT_PG_URL is not set')
    return url
  }

  return [
    // ── DELETE /api/admin/tenants/:slug/db ──────────────────────────────────
    {
      method: 'DELETE',
      path: '/api/admin/tenants/:slug/db',
      handler: async (ctx) => {
        const { req, res } = ctx as unknown as {
          req: http.IncomingMessage
          res: http.ServerResponse
          params: Record<string, string>
        }
        const params = ctx.params

        if (!checkAdminSecret(req.headers, deps.secret)) {
          return sendJson(res, 403, { success: false, error: 'forbidden' })
        }

        const slug = params['slug'] ?? ''
        // Validate slug before interpolating into an identifier.
        if (!SLUG_PATTERN.test(slug)) {
          return sendJson(res, 400, {
            success: false,
            error: 'invalid slug: must match ^[a-z0-9-]{1,30}$',
          })
        }

        // <prefix>control is the catalog database, not a tenant's.
        if (RESERVED_SLUGS.has(slug)) {
          return sendJson(res, 400, { success: false, error: 'invalid slug: reserved' })
        }

        const dbName = `${dbPrefix}${slug}`
        const pgUrl = getPgUrl()
        const admin = postgres(pgUrl, { max: 1, prepare: false })
        try {
          // End this process's pool(s) for the tenant first: an open connection
          // blocks DROP DATABASE, and a pool left behind would outlive its database.
          await evictTenantPools({ slug })
          // DROP DATABASE cannot run inside a transaction.
          await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}"`)
          console.log(`[admin] dropped database ${dbName} (IF EXISTS)`)
          return sendJson(res, 200, { success: true, dropped: dbName })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          console.error(`[admin] DROP DATABASE ${dbName} failed:`, msg)
          return sendJson(res, 500, { success: false, error: msg })
        } finally {
          await admin.end({ timeout: 5 }).catch(() => {})
        }
      },
    },

    // ── DELETE /api/admin/tenants/:tenantId/catalog ─────────────────────────
    {
      method: 'DELETE',
      path: '/api/admin/tenants/:tenantId/catalog',
      handler: async (ctx) => {
        const { req, res } = ctx as unknown as {
          req: http.IncomingMessage
          res: http.ServerResponse
          params: Record<string, string>
        }
        const params = ctx.params

        if (!checkAdminSecret(req.headers, deps.secret)) {
          return sendJson(res, 403, { success: false, error: 'forbidden' })
        }

        const rawTenantId = params['tenantId'] ?? ''
        // Validate UUID format (basic check — postgres will reject a bad cast anyway).
        const UUID_PATTERN =
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
        if (!UUID_PATTERN.test(rawTenantId)) {
          return sendJson(res, 400, {
            success: false,
            error: 'invalid tenantId: must be a UUID',
          })
        }
        // The pool registry and the catalog comparison use the lowercase spelling.
        const tenantId = rawTenantId.toLowerCase()

        // Connect to the control DB directly (not through the storeFor LRU cache,
        // since the tenant being deleted may already be gone from the registry).
        const pgUrl = getPgUrl()
        const controlDbName = `${dbPrefix}control`
        const controlUrl = pgUrl.replace(/\/[^/?#]*(\?|$)/, `/${controlDbName}$1`)
        const ctrl = postgres(controlUrl, { max: 1, prepare: false })
        try {
          // One statement: the row goes only while its database is gone. A row for
          // a database that still exists is what keeps an old database bound to its
          // tenant; deleting it would let a NEW id be bound to that database.
          const deleted = await ctrl.unsafe<{ slug: string }[]>(
            `DELETE FROM tenant_catalog t
              WHERE t.tenant_id = $1::uuid
                AND NOT EXISTS (SELECT 1 FROM pg_database d WHERE d.datname = t.db_name)
          RETURNING t.slug`,
            [tenantId],
          )
          if (deleted.length === 0) {
            const held = await ctrl.unsafe(`SELECT 1 FROM tenant_catalog WHERE tenant_id = $1::uuid`, [tenantId])
            if (held.length > 0) {
              return sendJson(res, 409, {
                success: false,
                error: 'tenant database still exists: drop it first',
              })
            }
          }
          await evictTenantPools({ id: tenantId, slug: deleted[0]?.slug })
          console.log(`[admin] deleted tenant_catalog row for ${tenantId} (IF EXISTS)`)
          return sendJson(res, 200, { success: true, tenantId })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          console.error(`[admin] catalog DELETE for ${tenantId} failed:`, msg)
          return sendJson(res, 500, { success: false, error: msg })
        } finally {
          await ctrl.end({ timeout: 5 }).catch(() => {})
        }
      },
    },
  ]
}
