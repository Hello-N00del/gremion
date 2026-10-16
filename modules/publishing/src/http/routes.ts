// services/newsletter/src/http/routes.ts
//
// Task 9: all /api/v1/* route handlers for the newsletter leaf service.
//
// All routes run under the Task-3 guard (shared secret + tenant headers).
// Handler shape: each factory receives a `storeFn` callback (DI so tests can
// inject a pre-seeded per-tenant Sql without touching the real storeFor).
//
// Error envelope: {success:false,error} — mirrors the monolith house JSON shape
// (gremion-ui/src/lib/server/response.ts sendError / sendSuccess pattern).
//
// Body reading: the server provides no body helper, so readBody() is module-local.
//
// /healthz/tenants is guard-EXEMPT per guard.ts isHealthzPath(). The server
// short-circuits all /healthz* paths; tenantHealthHandler is called from server.ts
// for the /healthz/tenants sub-path.
//
// ── Send 202 / 409 design ──────────────────────────────────────────────────────
// The brief requires: send → 202, second send while claimed → 409.
// dispatch() already does an atomic claimNewsletterForSending() internally.
// We must NOT pre-claim (that would cause dispatch's own claim to no-op).
// Instead we CHECK current status (no mutation) to produce an early 409 for
// newsletters already in 'sending'|'sent', then fire dispatch() async.
// dispatch() then does the real atomic claim. Race window (after check, before
// dispatch's claim) is intentional and extremely narrow; the atomic claim inside
// dispatch() is the authoritative gate.

import type http from 'node:http'
import { z } from 'zod'
import { TenantIdentityMismatchError, type Sql, type TenantRef } from '../tenant-store.js'
import type { Route, RouteContext } from './router.js'
import { readOrMintCorrelationId } from '@gremion/ports/tracer'
import {
  createMailingList,
  listMailingLists,
  deleteMailingList,
  addMember,
  listMembers,
  deleteMember,
  countSubscribers,
  createNewsletter,
  listNewsletters,
  getNewsletter,
  updateNewsletter,
  setNewsletterRecipients,
  getNewsletterRecipients,
  addUnsubscribeByToken,
  recordNewsletterAudit,
} from '../store/index.js'
import { dispatch, type DispatchDeps } from '../dispatch.js'

// ── types ─────────────────────────────────────────────────────────────────────

/**
 * Augmented RouteContext: includes the raw request, response, and the
 * resolved tenant identity (extracted from guard-validated headers).
 * The server.ts handle() function casts to this type after guard passes.
 */
export interface ApiContext extends RouteContext {
  req: http.IncomingMessage
  res: http.ServerResponse
  tenant: TenantRef
}

export type ApiHandler = (ctx: ApiContext) => Promise<void>

/** Per-tenant store accessor (injected so tests can supply pre-seeded pools). */
export type StoreFn = (tenant: TenantRef) => Promise<Sql>

/** Dependencies for the send route's async dispatch. */
export interface SendDeps {
  /**
   * F2 (T16): factory receives the per-request correlation id (read-or-minted
   * from the inbound x-correlation-id header) so dispatch, the outbox row, and
   * the NATS envelope all carry the kernel's id rather than falling back to
   * String(newsletterId). Scheduler-initiated dispatches pass a freshly-minted
   * UUID (no HTTP context).
   */
  dispatchDeps: (tenant: TenantRef, sql: Sql, correlationId: string) => DispatchDeps
}

// ── JSON helpers ──────────────────────────────────────────────────────────────

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>,
): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', ...extraHeaders })
  res.end(payload)
}

function sendOk(res: http.ServerResponse, data: unknown, status = 200): void {
  sendJson(res, status, { success: true, data })
}

function sendError(res: http.ServerResponse, status: number, error: string): void {
  sendJson(res, status, { success: false, error })
}

// ── body reader ───────────────────────────────────────────────────────────────

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

const CreateListSchema = z.object({
  name: z.string().min(1).max(255),
})

const AddMemberSchema = z.object({
  email: z.string().email(),
  name: z.string().max(255).nullable().optional(),
  source: z.enum(['csv', 'manual']).optional().default('manual'),
})

const CreateNewsletterSchema = z.object({
  title: z.string().min(1).max(255),
  odt_path: z.string().min(1),
  subject: z.string().min(1).max(998),
  created_by: z.string().min(1),
})

const PatchNewsletterSchema = z.object({
  subject: z.string().min(1).max(998).optional(),
  scheduled_at: z.string().nullable().optional(),
  sent_at: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
})

const SetRecipientsSchema = z.object({
  recipients: z.array(
    z.object({
      mailing_list_id: z.number().int().positive().optional(),
      keycloak_group_id: z.string().min(1).optional(),
    }),
  ),
})

const ScheduleSchema = z.object({
  scheduled_at: z.string().datetime(),
})

const SendSchema = z.object({
  actor: z.string().min(1),
})

const UnsubscribeSchema = z.object({
  token: z.string().min(1),
})

const AuditSchema = z.object({
  actor_sub: z.string().min(1),
  action: z.string().min(1),
})

// ── route builder ─────────────────────────────────────────────────────────────

/**
 * Build all /api/v1/* routes.
 *
 * The server extends RouteContext to carry req+res+tenant via a type cast in
 * server.ts (see T9 note in server.ts handle()). Each handler receives an
 * ApiContext which is the extended RouteContext.
 */
export function buildApiRoutes(storeFn: StoreFn, sendDeps?: SendDeps): Route[] {
  const wrap =
    (handler: ApiHandler): Route['handler'] =>
    async (ctx) => {
      const extended = ctx as unknown as ApiContext
      try {
        await handler(extended)
      } catch (err) {
        if (err instanceof z.ZodError) {
          sendError(extended.res, 400, err.issues.map((e) => e.message).join('; '))
        } else if (
          err instanceof SyntaxError ||
          (err instanceof Error && err.message === 'invalid JSON body')
        ) {
          sendError(extended.res, 400, 'invalid JSON body')
        } else if (err instanceof TenantIdentityMismatchError) {
          // The (id, slug) pair is not the one the catalog binds (audit #534): a
          // stale or forged pair, never a server fault. The body names neither tenant.
          console.warn(`[newsletter:api] ${err.message}`)
          sendError(extended.res, 409, 'tenant_identity_mismatch')
        } else {
          console.error('[newsletter:api] unhandled route error', err)
          if (!extended.res.headersSent) {
            sendError(extended.res, 500, 'internal error')
          }
        }
      }
    }

  return [
    // ── POST /api/v1/lists ──────────────────────────────────────────────────
    {
      method: 'POST',
      path: '/api/v1/lists',
      handler: wrap(async ({ req, res, tenant }) => {
        const body = CreateListSchema.parse(await readBody(req))
        const sql = await storeFn(tenant)
        const list = await createMailingList(sql, body.name)
        sendOk(res, list, 201)
      }),
    },

    // ── GET /api/v1/lists ───────────────────────────────────────────────────
    {
      method: 'GET',
      path: '/api/v1/lists',
      handler: wrap(async ({ res, tenant }) => {
        const sql = await storeFn(tenant)
        const lists = await listMailingLists(sql)
        sendOk(res, lists)
      }),
    },

    // ── DELETE /api/v1/lists/:id ────────────────────────────────────────────
    {
      method: 'DELETE',
      path: '/api/v1/lists/:id',
      handler: wrap(async ({ res, params, tenant }) => {
        const id = Number(params['id'])
        if (!Number.isInteger(id) || id <= 0) return sendError(res, 400, 'invalid list id')
        const sql = await storeFn(tenant)
        await deleteMailingList(sql, id)
        sendJson(res, 200, { success: true })
      }),
    },

    // ── POST /api/v1/lists/:id/members ──────────────────────────────────────
    {
      method: 'POST',
      path: '/api/v1/lists/:id/members',
      handler: wrap(async ({ req, res, params, tenant }) => {
        const listId = Number(params['id'])
        if (!Number.isInteger(listId) || listId <= 0) return sendError(res, 400, 'invalid list id')
        const body = AddMemberSchema.parse(await readBody(req))
        const sql = await storeFn(tenant)
        await addMember(sql, listId, body.email, body.name ?? null, body.source)
        sendJson(res, 201, { success: true })
      }),
    },

    // ── GET /api/v1/lists/:id/members ───────────────────────────────────────
    {
      method: 'GET',
      path: '/api/v1/lists/:id/members',
      handler: wrap(async ({ res, params, tenant }) => {
        const listId = Number(params['id'])
        if (!Number.isInteger(listId) || listId <= 0) return sendError(res, 400, 'invalid list id')
        const sql = await storeFn(tenant)
        const members = await listMembers(sql, listId)
        sendOk(res, members)
      }),
    },

    // ── DELETE /api/v1/lists/:id/members/:memberId ──────────────────────────
    {
      method: 'DELETE',
      path: '/api/v1/lists/:id/members/:memberId',
      handler: wrap(async ({ res, params, tenant }) => {
        const memberId = Number(params['memberId'])
        if (!Number.isInteger(memberId) || memberId <= 0)
          return sendError(res, 400, 'invalid member id')
        const sql = await storeFn(tenant)
        await deleteMember(sql, memberId)
        sendJson(res, 200, { success: true })
      }),
    },

    // ── POST /api/v1/newsletters ────────────────────────────────────────────
    {
      method: 'POST',
      path: '/api/v1/newsletters',
      handler: wrap(async ({ req, res, tenant }) => {
        const body = CreateNewsletterSchema.parse(await readBody(req))
        const sql = await storeFn(tenant)
        const newsletter = await createNewsletter(sql, body)
        sendOk(res, newsletter, 201)
      }),
    },

    // ── GET /api/v1/newsletters ─────────────────────────────────────────────
    {
      method: 'GET',
      path: '/api/v1/newsletters',
      handler: wrap(async ({ res, tenant }) => {
        const sql = await storeFn(tenant)
        const newsletters = await listNewsletters(sql)
        sendOk(res, newsletters)
      }),
    },

    // ── GET /api/v1/newsletters/:id ─────────────────────────────────────────
    {
      method: 'GET',
      path: '/api/v1/newsletters/:id',
      handler: wrap(async ({ res, params, tenant }) => {
        const id = Number(params['id'])
        if (!Number.isInteger(id) || id <= 0) return sendError(res, 400, 'invalid newsletter id')
        const sql = await storeFn(tenant)
        const nl = await getNewsletter(sql, id)
        if (!nl) return sendError(res, 404, 'not found')
        sendOk(res, nl)
      }),
    },

    // ── PATCH /api/v1/newsletters/:id ───────────────────────────────────────
    {
      method: 'PATCH',
      path: '/api/v1/newsletters/:id',
      handler: wrap(async ({ req, res, params, tenant }) => {
        const id = Number(params['id'])
        if (!Number.isInteger(id) || id <= 0) return sendError(res, 400, 'invalid newsletter id')
        const body = PatchNewsletterSchema.parse(await readBody(req))
        const sql = await storeFn(tenant)
        const existing = await getNewsletter(sql, id)
        if (!existing) return sendError(res, 404, 'not found')
        await updateNewsletter(sql, id, body)
        const updated = await getNewsletter(sql, id)
        sendOk(res, updated)
      }),
    },

    // ── GET /api/v1/newsletters/:id/recipients ──────────────────────────────
    // Kernel contract endpoint: ServiceNewsletterClient.getNewsletterRecipients
    // (→ countNewsletterRecipients → the /newsletter page loader) reads this.
    // It was never registered at extraction (only PUT existed on this path), so
    // the kernel GET hit a 405 → the ACL client surfaced a 500 on any tenant
    // with ≥1 newsletter. Mirrors the PUT tail: 404 for a missing newsletter,
    // else the recipient set via the standard {success,data} envelope.
    {
      method: 'GET',
      path: '/api/v1/newsletters/:id/recipients',
      handler: wrap(async ({ res, params, tenant }) => {
        const id = Number(params['id'])
        if (!Number.isInteger(id) || id <= 0) return sendError(res, 400, 'invalid newsletter id')
        const sql = await storeFn(tenant)
        const existing = await getNewsletter(sql, id)
        if (!existing) return sendError(res, 404, 'not found')
        const recipients = await getNewsletterRecipients(sql, id)
        sendOk(res, recipients)
      }),
    },

    // ── PUT /api/v1/newsletters/:id/recipients ──────────────────────────────
    {
      method: 'PUT',
      path: '/api/v1/newsletters/:id/recipients',
      handler: wrap(async ({ req, res, params, tenant }) => {
        const id = Number(params['id'])
        if (!Number.isInteger(id) || id <= 0) return sendError(res, 400, 'invalid newsletter id')
        const body = SetRecipientsSchema.parse(await readBody(req))
        const sql = await storeFn(tenant)
        const existing = await getNewsletter(sql, id)
        if (!existing) return sendError(res, 404, 'not found')
        await setNewsletterRecipients(sql, id, body.recipients)
        const recipients = await getNewsletterRecipients(sql, id)
        sendOk(res, recipients)
      }),
    },

    // ── POST /api/v1/newsletters/:id/schedule ───────────────────────────────
    {
      method: 'POST',
      path: '/api/v1/newsletters/:id/schedule',
      handler: wrap(async ({ req, res, params, tenant }) => {
        const id = Number(params['id'])
        if (!Number.isInteger(id) || id <= 0) return sendError(res, 400, 'invalid newsletter id')
        const body = ScheduleSchema.parse(await readBody(req))
        const sql = await storeFn(tenant)
        const existing = await getNewsletter(sql, id)
        if (!existing) return sendError(res, 404, 'not found')
        await updateNewsletter(sql, id, { status: 'scheduled', scheduled_at: body.scheduled_at })
        const updated = await getNewsletter(sql, id)
        sendOk(res, updated)
      }),
    },

    // ── POST /api/v1/newsletters/:id/send ────────────────────────────────────
    // Returns 202 immediately; fires dispatch async.
    // 409 if status is already 'sending' or 'sent'.
    //
    // Design: we check status optimistically (no mutation) to produce a 409 for
    // newsletters already claimed. Then we return 202 and fire dispatch() async —
    // dispatch() does the real atomic claim. The race window is extremely narrow
    // and acceptable (the atomic claim in dispatch is the authoritative gate).
    {
      method: 'POST',
      path: '/api/v1/newsletters/:id/send',
      handler: wrap(async ({ req, res, params, tenant }) => {
        const id = Number(params['id'])
        if (!Number.isInteger(id) || id <= 0) return sendError(res, 400, 'invalid newsletter id')
        const body = SendSchema.parse(await readBody(req))
        const sql = await storeFn(tenant)
        const existing = await getNewsletter(sql, id)
        if (!existing) return sendError(res, 404, 'not found')

        // Optimistic 409: if already sending or sent, reject immediately.
        if (existing.status === 'sending' || existing.status === 'sent') {
          return sendError(res, 409, 'newsletter already sending or sent')
        }

        // F2 (T16): read the inbound x-correlation-id forwarded by the kernel
        // ACL client and validate/mint via readOrMintCorrelationId so the leaf
        // dispatch, outbox row, and NATS envelope carry the kernel's id.
        const rawCorrId = req.headers['x-correlation-id']
        const correlationId = readOrMintCorrelationId(
          Array.isArray(rawCorrId) ? rawCorrId[0] : rawCorrId,
        )

        // 202 immediately — dispatch fires async.
        sendJson(res, 202, { success: true, data: { newsletterId: id, status: 'sending' } })

        if (sendDeps) {
          const deps = sendDeps.dispatchDeps(tenant, sql, correlationId)
          void dispatch(tenant, id, body.actor, deps).catch((err) => {
            console.error(
              `[newsletter:send] async dispatch failed for newsletter #${id}:`,
              err instanceof Error ? err.message : String(err),
            )
          })
        } else {
          console.warn(
            `[newsletter:send] no sendDeps injected — newsletter #${id} not dispatched`,
          )
        }
      }),
    },

    // ── POST /api/v1/unsubscribe ─────────────────────────────────────────────
    {
      method: 'POST',
      path: '/api/v1/unsubscribe',
      handler: wrap(async ({ req, res, tenant }) => {
        const body = UnsubscribeSchema.parse(await readBody(req))
        const sql = await storeFn(tenant)
        const result = await addUnsubscribeByToken(sql, body.token)
        if (result.ok) {
          sendJson(res, 200, { ok: true })
        } else {
          sendJson(res, 200, { ok: false, reason: result.reason })
        }
      }),
    },

    // ── GET /api/v1/stats ────────────────────────────────────────────────────
    {
      method: 'GET',
      path: '/api/v1/stats',
      handler: wrap(async ({ res, tenant }) => {
        const sql = await storeFn(tenant)
        const subscribers = await countSubscribers(sql)
        const newsletterRows = await sql<{ c: string }[]>`SELECT COUNT(*) AS c FROM newsletters`
        const newsletters = Number(newsletterRows[0]!.c)
        sendOk(res, { subscribers, newsletters })
      }),
    },

    // ── POST /api/v1/newsletters/:id/audit ───────────────────────────────────
    {
      method: 'POST',
      path: '/api/v1/newsletters/:id/audit',
      handler: wrap(async ({ req, res, params, tenant }) => {
        const id = Number(params['id'])
        if (!Number.isInteger(id) || id <= 0) return sendError(res, 400, 'invalid newsletter id')
        const body = AuditSchema.parse(await readBody(req))
        const sql = await storeFn(tenant)
        const existing = await getNewsletter(sql, id)
        if (!existing) return sendError(res, 404, 'not found')
        await recordNewsletterAudit(sql, id, body.actor_sub, body.action)
        sendJson(res, 200, { success: true })
      }),
    },
  ]
}

// ── /healthz/tenants handler ──────────────────────────────────────────────────
// Guard-EXEMPT (served from the /healthz* path in server.ts).
// Returns per-tenant DB ping + subscriber + newsletter counts (Task-21 feed).

export interface TenantHealth {
  tenant_id: string
  tenant_slug: string
  db_ok: boolean
  subscribers?: number
  newsletters?: number
  error?: string
}

export type TenantLister = () => Promise<TenantRef[]>

export async function tenantHealthHandler(
  res: http.ServerResponse,
  listTenants: TenantLister,
  storeFn: StoreFn,
): Promise<void> {
  let tenants: TenantRef[]
  try {
    tenants = await listTenants()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    res.writeHead(503, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ success: false, error: `tenant listing failed: ${msg}` }))
    return
  }

  const results: TenantHealth[] = await Promise.all(
    tenants.map(async (t): Promise<TenantHealth> => {
      try {
        const sql = await storeFn(t)
        const [subRows, nlRows] = await Promise.all([
          sql<{ c: string }[]>`SELECT COUNT(DISTINCT email) AS c FROM mailing_list_members`,
          sql<{ c: string }[]>`SELECT COUNT(*) AS c FROM newsletters`,
        ])
        return {
          tenant_id: t.id,
          tenant_slug: t.slug,
          db_ok: true,
          subscribers: Number(subRows[0]!.c),
          newsletters: Number(nlRows[0]!.c),
        }
      } catch (err) {
        return {
          tenant_id: t.id,
          tenant_slug: t.slug,
          db_ok: false,
          error: err instanceof Error ? err.message : String(err),
        }
      }
    }),
  )

  const allOk = results.every((r) => r.db_ok)
  res.writeHead(allOk ? 200 : 503, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ success: allOk, data: results }))
}
