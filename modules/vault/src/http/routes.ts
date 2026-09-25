// services/vault/src/http/routes.ts
//
// All route handlers for the vault leaf service. Every route runs under the guard
// (shared secret + tenant headers). The pinned route set:
//   GET    /items?orgUnitId=…   → { data: VaultItem[] }  (list — NO secret field)
//   POST   /items               → VaultItem (201)        (create — encrypts secret)
//   GET    /items/:id           → VaultItem | 404        (get metadata — NO secret)
//   PUT    /items/:id           → VaultItem | 404        (update metadata; re-encrypts
//                                                          when a new secret is sent)
//   GET    /items/:id/secret    → { secret } | 404       (reveal — decrypt + log one
//                                                          access_log row)
//   DELETE /items/:id           → { success:true } | 404 (delete — the item's
//                                                          access_log rows SURVIVE)
//   GET    /access-log?orgUnitIds=…  → { data: AccessLogEntry[] }  (reveal audit,
//                                       newest first, limit/offset paginated)
//
// The metadata routes (list/get/create) return the item WITHOUT the secret — the
// plaintext only ever leaves through the explicit /items/:id/secret reveal, which
// decrypts the AES-256-GCM blob and records the access. Entity-returning routes
// return the entity DIRECTLY (no {data} envelope); the list route wraps in { data }.
//
// Error envelope: { success:false, error } — the house JSON shape.

import type http from 'node:http'
import { z } from 'zod'
import type { Sql, TenantRef } from '../store/index.js'
import type { Route, RouteContext } from './router.js'
import {
  createItem,
  listItemsForOrgUnits,
  getItem,
  updateItem,
  revealSecret,
  deleteItem,
  listAccessLog,
} from '../store/index.js'
import { encryptSecret, decryptSecret } from '../crypto.js'

export interface ApiContext extends RouteContext {
  req: http.IncomingMessage
  res: http.ServerResponse
  tenant: TenantRef
}

export type ApiHandler = (ctx: ApiContext) => Promise<void>

/** Per-tenant store accessor (injected so tests can supply a pre-seeded pool). */
export type StoreFn = (tenant: TenantRef) => Promise<Sql>

/** Caller user-id header — mirrors the finance `x-finance-user-id` / files
 *  `x-upload-user` precedent. The kernel sets it to the authenticated actor; the
 *  reveal endpoint REQUIRES it (an anonymous secret reveal is never allowed) and
 *  every mutating route records it in the audit trail. */
const USER_ID_HEADER = 'x-vault-user-id'

/** Read a single-valued request header (node lower-cases header names; a repeated
 *  header arrives as an array — take the first). Returns '' when absent/blank. */
function header(req: http.IncomingMessage, name: string): string {
  const raw = req.headers[name]
  const val = Array.isArray(raw) ? raw[0] : raw
  return (val ?? '').trim()
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
  res.writeHead(status, { 'content-type': 'application/json', ...extraHeaders })
  res.end(JSON.stringify(body))
}

function sendError(res: http.ServerResponse, status: number, error: string): void {
  sendJson(res, status, { success: false, error })
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8')
      if (!raw) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new Error('invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

// ── Zod schemas ───────────────────────────────────────────────────────────────

const CreateItemSchema = z.object({
  orgUnitId: z.string().min(1),
  name: z.string().min(1).max(200),
  secret: z.string().min(1),
  username: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  createdBy: z.string().nullable().optional(),
})

// Update: every field optional (absent = keep, null = clear on the nullable
// columns), but a PROVIDED field is validated exactly like on create.
const UpdateItemSchema = z.object({
  orgUnitId: z.string().min(1).optional(),
  name: z.string().min(1).max(200).optional(),
  secret: z.string().min(1).optional(),
  username: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
})

// Access-log pagination bounds — the leaf clamps rather than 400s so a sloppy
// caller degrades gracefully (the kernel passes sanitized values anyway).
const ACCESS_LOG_DEFAULT_LIMIT = 50
const ACCESS_LOG_MAX_LIMIT = 200

/** Parse a non-negative integer query param, falling back when absent/invalid. */
function intParam(raw: string | null, fallback: number): number {
  if (raw === null || raw.trim() === '') return fallback
  const n = Number(raw)
  return Number.isInteger(n) && n >= 0 ? n : fallback
}

// ── route builder ─────────────────────────────────────────────────────────────

/**
 * @param storeFn per-tenant store accessor (injected)
 * @param key     32-byte AES-256-GCM key, or null when VAULT_ENCRYPTION_KEY was
 *                unset at boot — in which case the secret create/reveal routes
 *                fail closed with 503 (the leaf still boots for health probes).
 */
export function buildApiRoutes(storeFn: StoreFn, key: Buffer | null): Route[] {
  const wrap =
    (handler: ApiHandler): Route['handler'] =>
    async (ctx) => {
      const extended = ctx as unknown as ApiContext
      try {
        await handler(extended)
      } catch (err) {
        if (err instanceof z.ZodError) {
          sendError(extended.res, 400, err.issues.map((e) => e.message).join('; '))
        } else if (err instanceof SyntaxError || (err instanceof Error && err.message === 'invalid JSON body')) {
          sendError(extended.res, 400, 'invalid JSON body')
        } else {
          console.error('[vault:api] unhandled route error', err)
          if (!extended.res.headersSent) sendError(extended.res, 500, 'internal error')
        }
      }
    }

  return [
    // ── GET /items?orgUnitId=… ───────────────────────────────────────────────
    {
      method: 'GET',
      path: '/items',
      handler: wrap(async ({ req, res, tenant }) => {
        const url = new URL(req.url ?? '/', 'http://internal')
        const orgUnitIds = url.searchParams.getAll('orgUnitId')
        const sql = await storeFn(tenant)
        const items = await listItemsForOrgUnits(sql, orgUnitIds)
        sendJson(res, 200, { data: items })
      }),
    },

    // ── POST /items ──────────────────────────────────────────────────────────
    {
      method: 'POST',
      path: '/items',
      handler: wrap(async ({ req, res, tenant }) => {
        const body = CreateItemSchema.parse(await readBody(req))
        if (!key) return sendError(res, 503, 'vault encryption key not configured')
        const secretCiphertext = encryptSecret(body.secret, key)
        const sql = await storeFn(tenant)
        // The caller user-id header is the authoritative actor for the audit trail;
        // fall back to a body-supplied createdBy only when the header is absent.
        const createdBy = header(req, USER_ID_HEADER) || body.createdBy || null
        const item = await createItem(sql, {
          orgUnitId: body.orgUnitId,
          name: body.name,
          username: body.username,
          url: body.url,
          notes: body.notes,
          secretCiphertext,
          createdBy,
        })
        sendJson(res, 201, item)
      }),
    },

    // ── GET /items/:id ───────────────────────────────────────────────────────
    {
      method: 'GET',
      path: '/items/:id',
      handler: wrap(async ({ res, params, tenant }) => {
        const sql = await storeFn(tenant)
        const item = await getItem(sql, params['id']!)
        if (!item) return sendError(res, 404, 'not found')
        sendJson(res, 200, item)
      }),
    },

    // ── PUT /items/:id ───────────────────────────────────────────────────────
    // Update metadata (orgUnitId/name/username/url/notes); when a new `secret`
    // is provided it is re-encrypted and replaces the stored ciphertext. The
    // response is the updated METADATA (never the secret). 404 when absent.
    {
      method: 'PUT',
      path: '/items/:id',
      handler: wrap(async ({ req, res, params, tenant }) => {
        const body = UpdateItemSchema.parse(await readBody(req))
        let secretCiphertext: string | undefined
        if (body.secret !== undefined) {
          // Fail closed exactly like POST: no key → no (re-)encryption path.
          if (!key) return sendError(res, 503, 'vault encryption key not configured')
          secretCiphertext = encryptSecret(body.secret, key)
        }
        const sql = await storeFn(tenant)
        const item = await updateItem(sql, params['id']!, {
          orgUnitId: body.orgUnitId,
          name: body.name,
          username: body.username,
          url: body.url,
          notes: body.notes,
          secretCiphertext,
        })
        if (!item) return sendError(res, 404, 'not found')
        sendJson(res, 200, item)
      }),
    },

    // ── GET /items/:id/secret ────────────────────────────────────────────────
    // Reveal: decrypt the stored ciphertext and record one access_log row. 404
    // (and NO log row) when the item does not exist.
    {
      method: 'GET',
      path: '/items/:id/secret',
      handler: wrap(async ({ req, res, params, tenant }) => {
        // A secret reveal MUST be attributable — reject an anonymous caller BEFORE
        // any decryption or DB read, so the access_log can never record a null actor.
        const accessedBy = header(req, USER_ID_HEADER)
        if (!accessedBy) return sendError(res, 400, `missing ${USER_ID_HEADER} header`)
        if (!key) return sendError(res, 503, 'vault encryption key not configured')
        const sql = await storeFn(tenant)
        const ciphertext = await revealSecret(sql, params['id']!, accessedBy, tenant.id)
        if (ciphertext === null) return sendError(res, 404, 'not found')
        const secret = decryptSecret(ciphertext, key)
        sendJson(res, 200, { secret })
      }),
    },

    // ── DELETE /items/:id ────────────────────────────────────────────────────
    {
      method: 'DELETE',
      path: '/items/:id',
      handler: wrap(async ({ res, params, tenant }) => {
        const sql = await storeFn(tenant)
        const ok = await deleteItem(sql, params['id']!)
        if (!ok) return sendError(res, 404, 'not found')
        sendJson(res, 200, { success: true })
      }),
    },

    // ── GET /access-log?orgUnitIds=a,b&limit=…&offset=… ─────────────────────
    // Reveal-audit read surface (#405): rows with the reveal-time item-name
    // snapshot (mig 002 — rows survive item deletion, append-only), newest
    // first, limit/offset paginated. orgUnitIds is a REQUIRED csv — the leaf
    // trusts it (the kernel resolves + enforces the caller's org-unit scope,
    // exactly like the /items list contract).
    {
      method: 'GET',
      path: '/access-log',
      handler: wrap(async ({ req, res, tenant }) => {
        const url = new URL(req.url ?? '/', 'http://internal')
        const csv = url.searchParams.get('orgUnitIds')
        if (csv === null || csv.trim() === '') {
          return sendError(res, 400, 'orgUnitIds query param (csv) is required')
        }
        const orgUnitIds = csv
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
        if (orgUnitIds.length === 0) {
          return sendError(res, 400, 'orgUnitIds query param (csv) is required')
        }
        const limit = Math.min(
          Math.max(intParam(url.searchParams.get('limit'), ACCESS_LOG_DEFAULT_LIMIT), 1),
          ACCESS_LOG_MAX_LIMIT,
        )
        const offset = intParam(url.searchParams.get('offset'), 0)
        const sql = await storeFn(tenant)
        const entries = await listAccessLog(sql, orgUnitIds, { limit, offset })
        sendJson(res, 200, { data: entries })
      }),
    },
  ]
}
