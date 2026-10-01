// services/content/src/http/routes.ts
//
// Task 21: all /api/v1/* route handlers for the content leaf service.
//
// All routes run under the Task-21 guard (shared secret + tenant headers).
// Handler shape: each factory receives a `storeFn` callback (DI so tests can
// inject a pre-seeded per-tenant Sql without touching the real storeFor).
//
// Error envelope: {success:false,error} — mirrors the monolith house JSON shape.
// Body reading: the server provides no body helper, so readBody() is module-local.
//
// /healthz/tenants is exempt from the TENANT-header guard per guard.ts
// isHealthzPath(), but server.ts requires the internal secret on it (K5#31)
// before calling tenantHealthHandler.
//
// ── Publish 202 / 409 design ──────────────────────────────────────────────────────
// POST /api/v1/posts/:id/publish → 202; second send while claimed → 409.
// dispatch() does an atomic claimPostForPublish() internally.
// We CHECK current status (no mutation) to produce an early 409 for
// posts already in 'sending'|'sent', then fire dispatch() async.
//
// ── Unsubscribe multi-action design ───────────────────────────────────────────
// POST /api/v1/unsubscribe handles three action variants:
//   {action:'filter', emails:[...]}        → 200 string[] (filtered subset)
//   {action:'add', email}                  → 204
//   {action:'consume-token', token}        → 200 {ok:true} on success
//                                          → 404 when token not found
//                                          → 410 when token expired
// Legacy {token:...} body (no action field) also works as consume-token.
//
// ── service-client contract routes (Task 21 SEAM NOTE v2) ────────────────────
// GET  /api/v1/posts/:id/recipients
// POST /api/v1/posts/:id/recipients        (action='mint-token')
// DELETE /api/v1/posts/:id
// GET  /api/v1/posts/:id/media
// POST /api/v1/posts/:id/media
// GET  /api/v1/posts/:id/channels
// POST /api/v1/posts/:id/channels          (ensureChannels — idempotent upsert)
// PATCH /api/v1/posts/:id/channels/:channel
// POST /api/v1/deliveries/claim
// POST /api/v1/deliveries/:postId/:email/sent
// POST /api/v1/deliveries/:postId/:email/failed
// GET  /api/v1/publications/:postId/:channel
// PUT  /api/v1/publications/:postId/:channel
// DELETE /api/v1/publications/:postId/:channel
// POST /api/v1/publish-ops                 (actions: enqueue / mark-ok / mark-failed)
// GET  /api/v1/publish-ops/due

import type http from 'node:http'
import { z } from 'zod'
import type { Sql, TenantRef } from '../tenant-store.js'
import type { Route, RouteContext } from './router.js'
import { readOrMintCorrelationId } from '@gremion/ports/tracer'
import {
  createMailingList,
  listMailingLists,
  deleteMailingList,
  addListMember,
  listMembers,
  removeListMember,
  createPost,
  listPosts,
  getPost,
  updatePost,
  setPostChannelRecipients,
  getPostChannelRecipients,
  addUnsubscribe,
  isUnsubscribed,
  addSendToken,
  recordContentAudit,
  createMedia,
  listMediaByPost,
  claimRecipient,
  markSent,
  markFailed,
  createPublication,
  getPublication,
  createPublishOp,
  drainPublishOps,
  updatePublishOp,
} from '../store/index.js'
import { dispatch, type DispatchDeps } from '../dispatch.js'
import { publishChannel, ChannelNotPublishableError } from '../publish-channel.js'
import { randomUUID } from 'node:crypto'

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

/** Dependencies for the publish route's async dispatch. */
export interface PublishDeps {
  /**
   * Factory receives the per-request correlation id (read-or-minted
   * from the inbound x-correlation-id header) so dispatch, the outbox row, and
   * the NATS envelope all carry the kernel's id rather than a synthetic fallback.
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

function sendNoContent(res: http.ServerResponse): void {
  res.writeHead(204)
  res.end()
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

const CreatePostSchema = z.object({
  title: z.string().min(1).max(255),
  body_html: z.string().optional().default(''),
  created_by: z.string().min(1),
})

const PatchPostSchema = z.object({
  title: z.string().min(1).max(255).optional(),
  body_html: z.string().optional(),
  scheduled_at: z.string().nullable().optional(),
  sent_at: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
})

const SetRecipientsSchema = z.object({
  channel: z.enum(['email', 'portal', 'instagram']).optional().default('email'),
  recipients: z.array(
    z.object({
      mailing_list_id: z.string().optional(),
      keycloak_group_id: z.string().min(1).optional(),
    }),
  ),
})

const PublishSchema = z.object({
  actor: z.string().min(1),
})

// Unsubscribe: three action variants + legacy token-only shape.
const UnsubscribeActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('filter'), emails: z.array(z.string().min(1)) }),
  z.object({ action: z.literal('add'), email: z.string().email() }),
  z.object({ action: z.literal('consume-token'), token: z.string().min(1) }),
])
const UnsubscribeLegacySchema = z.object({ token: z.string().min(1) })

const AuditSchema = z.object({
  actor_sub: z.string().min(1),
  action: z.string().min(1),
})

const AddMediaSchema = z.object({
  url: z.string().min(1),
  role: z.enum(['hero', 'slide', 'inline']),
  position: z.number().int().min(0).optional().default(0),
  alt: z.string().nullable().optional(),
})

const PatchChannelSchema = z.object({
  enabled: z.boolean().optional(),
  status: z.enum(['draft', 'scheduled', 'sent', 'published', 'failed']).optional(),
  scheduled_at: z.string().nullable().optional(),
  overrides: z.record(z.string(), z.unknown()).optional(),
})

const ClaimDeliverySchema = z.object({
  post_id: z.string().min(1),
  email: z.string().min(1),
})

const MarkSentSchema = z.object({
  message_id: z.string().min(1),
})

const MarkFailedDeliverySchema = z.object({
  error: z.string().min(1),
})

const SetPublicationSchema = z.object({
  external_ref: z.string().nullable(),
})

const PublishOpActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('enqueue'),
    post_id: z.string().min(1),
    channel: z.literal('instagram'),
    op: z.literal('publish'),
  }),
  z.object({
    action: z.literal('mark-ok'),
    op_id: z.string().min(1),
    external_ref: z.string().nullable().optional(),
  }),
  z.object({
    action: z.literal('mark-failed'),
    op_id: z.string().min(1),
    error: z.string().min(1),
  }),
])

const MintTokenActionSchema = z.object({
  action: z.literal('mint-token'),
  email: z.string().email(),
})

// ── slug generator ────────────────────────────────────────────────────────────

function slugFromTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || randomUUID().slice(0, 8)
}

// ── channel helpers ───────────────────────────────────────────────────────────

const ALL_CHANNELS = ['email', 'portal', 'instagram'] as const
type ChannelId = (typeof ALL_CHANNELS)[number]

interface PostChannelRow {
  post_id: string
  channel: ChannelId
  enabled: boolean
  status: string
  scheduled_at: string | null
  overrides: Record<string, unknown>
}

function toChannel(row: Record<string, unknown>): PostChannelRow {
  return {
    post_id: String(row['post_id']),
    channel: row['channel'] as ChannelId,
    enabled: Boolean(row['enabled']),
    status: String(row['status']),
    scheduled_at:
      row['scheduled_at'] instanceof Date
        ? row['scheduled_at'].toISOString()
        : row['scheduled_at'] != null
          ? (row['scheduled_at'] as string)
          : null,
    overrides:
      row['overrides'] != null && typeof row['overrides'] === 'object'
        ? (row['overrides'] as Record<string, unknown>)
        : {},
  }
}

async function getChannelRows(sql: Sql, postId: string): Promise<PostChannelRow[]> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT post_id, channel, enabled, status, scheduled_at, overrides
    FROM content.post_channels
    WHERE post_id = ${postId}
    ORDER BY channel
  `
  return rows.map(toChannel)
}

async function ensureChannelRows(sql: Sql, postId: string): Promise<void> {
  for (const ch of ALL_CHANNELS) {
    await sql`
      INSERT INTO content.post_channels (post_id, channel)
      VALUES (${postId}, ${ch})
      ON CONFLICT (post_id, channel) DO NOTHING
    `
  }
}

async function patchChannelRow(
  sql: Sql,
  postId: string,
  channel: ChannelId,
  patch: {
    enabled?: boolean
    status?: string
    scheduled_at?: string | null | undefined
    overrides?: Record<string, unknown>
  },
): Promise<PostChannelRow | null> {
  const setClauses: string[] = []
  const values: unknown[] = []

  if (patch.enabled !== undefined) {
    setClauses.push(`enabled = $${values.length + 1}`)
    values.push(patch.enabled)
  }
  if (patch.status !== undefined) {
    setClauses.push(`status = $${values.length + 1}`)
    values.push(patch.status)
  }
  if ('scheduled_at' in patch) {
    setClauses.push(`scheduled_at = $${values.length + 1}`)
    values.push(patch.scheduled_at ?? null)
  }
  if (patch.overrides !== undefined) {
    setClauses.push(`overrides = $${values.length + 1}::jsonb`)
    values.push(JSON.stringify(patch.overrides))
  }

  if (setClauses.length === 0) {
    const rows = await sql<Record<string, unknown>[]>`
      SELECT post_id, channel, enabled, status, scheduled_at, overrides
      FROM content.post_channels WHERE post_id = ${postId} AND channel = ${channel}
    `
    return rows.length > 0 ? toChannel(rows[0]!) : null
  }

  values.push(postId)
  values.push(channel)

  const updated = await sql.unsafe<Record<string, unknown>[]>(
    `UPDATE content.post_channels
     SET ${setClauses.join(', ')}
     WHERE post_id = $${values.length - 1} AND channel = $${values.length}
     RETURNING post_id, channel, enabled, status, scheduled_at, overrides`,
    values as Parameters<typeof sql.unsafe>[1],
  )
  return updated.length > 0 ? toChannel(updated[0]!) : null
}

// ── unsubscribe token handler ─────────────────────────────────────────────────

/**
 * Consume a send token: resolves to 200 {ok:true}, 404 (not found), or 410 (expired).
 */
async function handleConsumeToken(
  sql: Sql,
  token: string,
  res: http.ServerResponse,
): Promise<void> {
  const rows = await sql<{ email: string; expires_at: Date }[]>`
    SELECT email, expires_at FROM content.send_tokens WHERE token = ${token}
  `
  if (rows.length === 0) {
    return sendError(res, 404, 'token not found')
  }
  const { email, expires_at } = rows[0]!
  if (expires_at < new Date()) {
    return sendError(res, 410, 'token expired')
  }
  await addUnsubscribe(sql, email)
  sendJson(res, 200, { ok: true })
}

// ── route builder ─────────────────────────────────────────────────────────────

/**
 * Build all /api/v1/* routes.
 *
 * The server extends RouteContext to carry req+res+tenant via a type cast in
 * server.ts. Each handler receives an ApiContext which is the extended RouteContext.
 */
export function buildApiRoutes(storeFn: StoreFn, publishDeps?: PublishDeps): Route[] {
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
        } else {
          console.error('[content:api] unhandled route error', err)
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
        sendJson(res, 201, list)
      }),
    },

    // ── GET /api/v1/lists ───────────────────────────────────────────────────
    {
      method: 'GET',
      path: '/api/v1/lists',
      handler: wrap(async ({ res, tenant }) => {
        const sql = await storeFn(tenant)
        const lists = await listMailingLists(sql)
        sendJson(res, 200, lists)
      }),
    },

    // ── DELETE /api/v1/lists/:id ────────────────────────────────────────────
    {
      method: 'DELETE',
      path: '/api/v1/lists/:id',
      handler: wrap(async ({ res, params, tenant }) => {
        const id = params['id']!
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
        const listId = params['id']!
        const body = AddMemberSchema.parse(await readBody(req))
        const sql = await storeFn(tenant)
        await addListMember(sql, listId, body.email, body.name ?? null, body.source)
        sendJson(res, 201, { success: true })
      }),
    },

    // ── GET /api/v1/lists/:id/members ───────────────────────────────────────
    {
      method: 'GET',
      path: '/api/v1/lists/:id/members',
      handler: wrap(async ({ res, params, tenant }) => {
        const listId = params['id']!
        const sql = await storeFn(tenant)
        const members = await listMembers(sql, listId)
        sendJson(res, 200, members)
      }),
    },

    // ── DELETE /api/v1/lists/:id/members/:memberId ──────────────────────────
    {
      method: 'DELETE',
      path: '/api/v1/lists/:id/members/:memberId',
      handler: wrap(async ({ res, params, tenant }) => {
        const memberId = params['memberId']!
        const sql = await storeFn(tenant)
        await removeListMember(sql, memberId)
        sendJson(res, 200, { success: true })
      }),
    },

    // ── POST /api/v1/posts ───────────────────────────────────────────────────
    {
      method: 'POST',
      path: '/api/v1/posts',
      handler: wrap(async ({ req, res, tenant }) => {
        const body = CreatePostSchema.parse(await readBody(req))
        const sql = await storeFn(tenant)
        const slug = slugFromTitle(body.title)
        const post = await createPost(sql, {
          slug,
          title: body.title,
          body_html: body.body_html,
          created_by: body.created_by,
        })
        sendJson(res, 201, post)
      }),
    },

    // ── GET /api/v1/posts ────────────────────────────────────────────────────
    {
      method: 'GET',
      path: '/api/v1/posts',
      handler: wrap(async ({ res, tenant }) => {
        const sql = await storeFn(tenant)
        const posts = await listPosts(sql)
        sendJson(res, 200, posts)
      }),
    },

    // ── GET /api/v1/posts/:id ────────────────────────────────────────────────
    {
      method: 'GET',
      path: '/api/v1/posts/:id',
      handler: wrap(async ({ res, params, tenant }) => {
        const id = params['id']!
        const sql = await storeFn(tenant)
        const post = await getPost(sql, id)
        if (!post) return sendError(res, 404, 'not found')
        sendJson(res, 200, post)
      }),
    },

    // ── PATCH /api/v1/posts/:id ──────────────────────────────────────────────
    {
      method: 'PATCH',
      path: '/api/v1/posts/:id',
      handler: wrap(async ({ req, res, params, tenant }) => {
        const id = params['id']!
        const body = PatchPostSchema.parse(await readBody(req))
        const sql = await storeFn(tenant)
        const existing = await getPost(sql, id)
        if (!existing) return sendError(res, 404, 'not found')
        await updatePost(sql, id, body)
        const updated = await getPost(sql, id)
        sendJson(res, 200, updated)
      }),
    },

    // ── DELETE /api/v1/posts/:id ─────────────────────────────────────────────
    {
      method: 'DELETE',
      path: '/api/v1/posts/:id',
      handler: wrap(async ({ res, params, tenant }) => {
        const id = params['id']!
        const sql = await storeFn(tenant)
        const existing = await getPost(sql, id)
        if (!existing) return sendError(res, 404, 'not found')
        await sql`DELETE FROM content.posts WHERE id = ${id}`
        sendNoContent(res)
      }),
    },

    // ── GET /api/v1/posts/:id/recipients ────────────────────────────────────
    {
      method: 'GET',
      path: '/api/v1/posts/:id/recipients',
      handler: wrap(async ({ res, params, tenant }) => {
        const id = params['id']!
        const sql = await storeFn(tenant)
        const existing = await getPost(sql, id)
        if (!existing) return sendError(res, 404, 'not found')
        const recipients = await getPostChannelRecipients(sql, id, 'email')
        sendJson(res, 200, recipients)
      }),
    },

    // ── PUT /api/v1/posts/:id/recipients ────────────────────────────────────
    {
      method: 'PUT',
      path: '/api/v1/posts/:id/recipients',
      handler: wrap(async ({ req, res, params, tenant }) => {
        const id = params['id']!
        const body = SetRecipientsSchema.parse(await readBody(req))
        const sql = await storeFn(tenant)
        const existing = await getPost(sql, id)
        if (!existing) return sendError(res, 404, 'not found')
        await setPostChannelRecipients(sql, id, body.channel, body.recipients)
        const recipients = await getPostChannelRecipients(sql, id, body.channel)
        sendOk(res, recipients)
      }),
    },

    // ── POST /api/v1/posts/:id/recipients (action='mint-token') ──────────────
    {
      method: 'POST',
      path: '/api/v1/posts/:id/recipients',
      handler: wrap(async ({ req, res, params, tenant }) => {
        const id = params['id']!
        const body = MintTokenActionSchema.parse(await readBody(req))
        const sql = await storeFn(tenant)
        const existing = await getPost(sql, id)
        if (!existing) return sendError(res, 404, 'not found')
        const token = randomUUID()
        const finalToken = await addSendToken(sql, token, id, body.email)
        // Return bare string — service-client does: (await leafFetch(...)) as string
        sendJson(res, 200, finalToken)
      }),
    },

    // ── GET /api/v1/posts/:id/media ──────────────────────────────────────────
    {
      method: 'GET',
      path: '/api/v1/posts/:id/media',
      handler: wrap(async ({ res, params, tenant }) => {
        const id = params['id']!
        const sql = await storeFn(tenant)
        const existing = await getPost(sql, id)
        if (!existing) return sendError(res, 404, 'not found')
        const media = await listMediaByPost(sql, id)
        // Return bare array
        sendJson(res, 200, media)
      }),
    },

    // ── POST /api/v1/posts/:id/media ─────────────────────────────────────────
    {
      method: 'POST',
      path: '/api/v1/posts/:id/media',
      handler: wrap(async ({ req, res, params, tenant }) => {
        const id = params['id']!
        const body = AddMediaSchema.parse(await readBody(req))
        const sql = await storeFn(tenant)
        const existing = await getPost(sql, id)
        if (!existing) return sendError(res, 404, 'not found')
        const media = await createMedia(sql, {
          post_id: id,
          url: body.url,
          role: body.role,
          position: body.position,
          alt: body.alt ?? null,
        })
        // Return bare object
        sendJson(res, 201, media)
      }),
    },

    // ── GET /api/v1/posts/:id/channels ──────────────────────────────────────
    {
      method: 'GET',
      path: '/api/v1/posts/:id/channels',
      handler: wrap(async ({ res, params, tenant }) => {
        const id = params['id']!
        const sql = await storeFn(tenant)
        const existing = await getPost(sql, id)
        if (!existing) return sendError(res, 404, 'not found')
        const channels = await getChannelRows(sql, id)
        // Return bare array
        sendJson(res, 200, channels)
      }),
    },

    // ── POST /api/v1/posts/:id/channels (ensureChannels) ─────────────────────
    {
      method: 'POST',
      path: '/api/v1/posts/:id/channels',
      handler: wrap(async ({ res, params, tenant }) => {
        const id = params['id']!
        const sql = await storeFn(tenant)
        const existing = await getPost(sql, id)
        if (!existing) return sendError(res, 404, 'not found')
        await ensureChannelRows(sql, id)
        sendNoContent(res)
      }),
    },

    // ── PATCH /api/v1/posts/:id/channels/:channel ────────────────────────────
    {
      method: 'PATCH',
      path: '/api/v1/posts/:id/channels/:channel',
      handler: wrap(async ({ req, res, params, tenant }) => {
        const id = params['id']!
        const channelParam = params['channel']!
        if (!(['email', 'portal', 'instagram'] as string[]).includes(channelParam)) {
          return sendError(res, 400, `invalid channel: ${channelParam}`)
        }
        const channel = channelParam as ChannelId
        const body = PatchChannelSchema.parse(await readBody(req))
        const sql = await storeFn(tenant)
        const existing = await getPost(sql, id)
        if (!existing) return sendError(res, 404, 'not found')
        // Ensure channel row exists before patching.
        await sql`
          INSERT INTO content.post_channels (post_id, channel)
          VALUES (${id}, ${channel})
          ON CONFLICT (post_id, channel) DO NOTHING
        `
        const updated = await patchChannelRow(sql, id, channel, {
          enabled: body.enabled,
          status: body.status,
          scheduled_at: 'scheduled_at' in body ? body.scheduled_at : undefined,
          overrides: body.overrides,
        })
        if (!updated) return sendError(res, 404, 'channel not found')
        // Return bare object
        sendJson(res, 200, updated)
      }),
    },

    // ── POST /api/v1/posts/:id/publish ───────────────────────────────────────
    // Returns 202 immediately; fires dispatch async.
    // 409 if status is already 'sending' or 'sent'.
    {
      method: 'POST',
      path: '/api/v1/posts/:id/publish',
      handler: wrap(async ({ req, res, params, tenant }) => {
        const id = params['id']!
        const body = PublishSchema.parse(await readBody(req))
        const sql = await storeFn(tenant)
        const existing = await getPost(sql, id)
        if (!existing) return sendError(res, 404, 'not found')

        // Optimistic 409: if already sending or sent, reject immediately.
        if (existing.status === 'sending' || existing.status === 'sent') {
          return sendError(res, 409, 'content post already sending or sent')
        }

        // Read the inbound x-correlation-id forwarded by the kernel ACL client.
        const rawCorrId = req.headers['x-correlation-id']
        const correlationId = readOrMintCorrelationId(
          Array.isArray(rawCorrId) ? rawCorrId[0] : rawCorrId,
        )

        // 202 immediately — dispatch fires async.
        sendJson(res, 202, { success: true, data: { postId: id, status: 'sending' } })

        if (publishDeps) {
          const deps = publishDeps.dispatchDeps(tenant, sql, correlationId)
          void dispatch(tenant, id, body.actor, deps).catch((err) => {
            console.error(
              `[content:publish] async dispatch failed for post ${id}:`,
              err instanceof Error ? err.message : String(err),
            )
          })
        } else {
          console.warn(
            `[content:publish] no publishDeps injected — post ${id} not dispatched`,
          )
        }
      }),
    },

    // ── POST /api/v1/posts/:id/publish/:channel ──────────────────────────────
    // SYNCHRONOUS per-channel publish (the service-mode counterpart of the
    // kernel's publishPost). Returns 200 + the PublishResult (email 'sent'/'failed',
    // portal 'published', instagram 'scheduled'); an email 'failed' (SMTP
    // unconfigured / no recipients) is a 200 body — the KERNEL route turns that
    // into a 422. 409 when the post is unknown or the channel is missing/disabled
    // (ChannelNotPublishableError); 400 on an invalid channel param.
    {
      method: 'POST',
      path: '/api/v1/posts/:id/publish/:channel',
      handler: wrap(async ({ req, res, params, tenant }) => {
        const id = params['id']!
        const channelParam = params['channel']!
        if (!(ALL_CHANNELS as readonly string[]).includes(channelParam)) {
          return sendError(res, 400, `invalid channel: ${channelParam}`)
        }
        const channel = channelParam as ChannelId

        if (!publishDeps) {
          console.warn(`[content:publish] no publishDeps injected — cannot publish post ${id}`)
          return sendError(res, 503, 'publish not configured')
        }

        const sql = await storeFn(tenant)

        // Read the inbound x-correlation-id forwarded by the kernel ACL client.
        const rawCorrId = req.headers['x-correlation-id']
        const correlationId = readOrMintCorrelationId(
          Array.isArray(rawCorrId) ? rawCorrId[0] : rawCorrId,
        )

        const dd = publishDeps.dispatchDeps(tenant, sql, correlationId)
        const emailTransport = dd.channels.get('email')
        if (!emailTransport) {
          // The email transport is always wired in production (index.ts); guard so
          // a mis-wired deps factory fails loud rather than throwing mid-publish.
          return sendError(res, 500, 'email transport unavailable')
        }

        try {
          const result = await publishChannel(tenant, id, channel, {
            sql,
            kernel: dd.kernel,
            emailTransport,
            origin: dd.origin,
            allowLoopbackLinks: dd.allowLoopbackLinks,
            correlationId,
            tracer: dd.tracer,
          })
          sendJson(res, 200, result)
        } catch (err) {
          if (err instanceof ChannelNotPublishableError) {
            return sendError(res, 409, err.message)
          }
          throw err // wrap() → 500
        }
      }),
    },

    // ── POST /api/v1/unsubscribe ─────────────────────────────────────────────
    // Handles three action variants + legacy token-only shape (see module header).
    {
      method: 'POST',
      path: '/api/v1/unsubscribe',
      handler: wrap(async ({ req, res, tenant }) => {
        const raw = await readBody(req)
        const rawObj = raw as Record<string, unknown>
        const sql = await storeFn(tenant)

        // Legacy shape: {token:...} with no action field.
        if (!('action' in rawObj)) {
          const { token } = UnsubscribeLegacySchema.parse(raw)
          return handleConsumeToken(sql, token, res)
        }

        const parsed = UnsubscribeActionSchema.parse(raw)

        if (parsed.action === 'filter') {
          const results: string[] = []
          for (const email of parsed.emails) {
            if (await isUnsubscribed(sql, email)) results.push(email)
          }
          // Return bare string[] — service-client does new Set(arr)
          sendJson(res, 200, results)
          return
        }

        if (parsed.action === 'add') {
          await addUnsubscribe(sql, parsed.email)
          sendNoContent(res)
          return
        }

        // consume-token
        return handleConsumeToken(sql, parsed.token, res)
      }),
    },

    // ── POST /api/v1/deliveries/claim ────────────────────────────────────────
    {
      method: 'POST',
      path: '/api/v1/deliveries/claim',
      handler: wrap(async ({ req, res, tenant }) => {
        const body = ClaimDeliverySchema.parse(await readBody(req))
        const sql = await storeFn(tenant)
        const result = await claimRecipient(sql, body.post_id, body.email)
        // Return bare string — service-client does (await leafFetch(...)) as ClaimResult
        sendJson(res, 200, result)
      }),
    },

    // ── POST /api/v1/deliveries/:postId/:email/sent ──────────────────────────
    {
      method: 'POST',
      path: '/api/v1/deliveries/:postId/:email/sent',
      handler: wrap(async ({ req, res, params, tenant }) => {
        const postId = params['postId']!
        const email = params['email']! // URL-decoded by router
        const body = MarkSentSchema.parse(await readBody(req))
        const sql = await storeFn(tenant)
        await markSent(sql, postId, email, body.message_id)
        sendNoContent(res)
      }),
    },

    // ── POST /api/v1/deliveries/:postId/:email/failed ────────────────────────
    {
      method: 'POST',
      path: '/api/v1/deliveries/:postId/:email/failed',
      handler: wrap(async ({ req, res, params, tenant }) => {
        const postId = params['postId']!
        const email = params['email']!
        const body = MarkFailedDeliverySchema.parse(await readBody(req))
        const sql = await storeFn(tenant)
        await markFailed(sql, postId, email, body.error)
        sendNoContent(res)
      }),
    },

    // ── GET /api/v1/publications/:postId/:channel ────────────────────────────
    {
      method: 'GET',
      path: '/api/v1/publications/:postId/:channel',
      handler: wrap(async ({ res, params, tenant }) => {
        const postId = params['postId']!
        const channelParam = params['channel']!
        if (!(['email', 'portal', 'instagram'] as string[]).includes(channelParam)) {
          return sendError(res, 400, `invalid channel: ${channelParam}`)
        }
        const sql = await storeFn(tenant)
        const pub = await getPublication(sql, postId, channelParam as ChannelId)
        if (!pub) return sendError(res, 404, 'not found')
        // Return bare object — service-client uses nullable=true so 404→null
        sendJson(res, 200, pub)
      }),
    },

    // ── PUT /api/v1/publications/:postId/:channel ────────────────────────────
    {
      method: 'PUT',
      path: '/api/v1/publications/:postId/:channel',
      handler: wrap(async ({ req, res, params, tenant }) => {
        const postId = params['postId']!
        const channelParam = params['channel']!
        if (!(['email', 'portal', 'instagram'] as string[]).includes(channelParam)) {
          return sendError(res, 400, `invalid channel: ${channelParam}`)
        }
        const body = SetPublicationSchema.parse(await readBody(req))
        const sql = await storeFn(tenant)
        await createPublication(sql, {
          post_id: postId,
          channel: channelParam as ChannelId,
          external_ref: body.external_ref ?? undefined,
        })
        sendNoContent(res)
      }),
    },

    // ── DELETE /api/v1/publications/:postId/:channel ─────────────────────────
    {
      method: 'DELETE',
      path: '/api/v1/publications/:postId/:channel',
      handler: wrap(async ({ res, params, tenant }) => {
        const postId = params['postId']!
        const channelParam = params['channel']!
        if (!(['email', 'portal', 'instagram'] as string[]).includes(channelParam)) {
          return sendError(res, 400, `invalid channel: ${channelParam}`)
        }
        const sql = await storeFn(tenant)
        await sql`
          DELETE FROM content.publications
          WHERE post_id = ${postId} AND channel = ${channelParam}
        `
        sendNoContent(res)
      }),
    },

    // ── GET /api/v1/publish-ops/due ──────────────────────────────────────────
    {
      method: 'GET',
      path: '/api/v1/publish-ops/due',
      handler: wrap(async ({ res, tenant }) => {
        const sql = await storeFn(tenant)
        const ops = await drainPublishOps(sql)
        // Return bare array
        sendJson(res, 200, ops)
      }),
    },

    // ── POST /api/v1/publish-ops (enqueue / mark-ok / mark-failed) ───────────
    {
      method: 'POST',
      path: '/api/v1/publish-ops',
      handler: wrap(async ({ req, res, tenant }) => {
        const body = PublishOpActionSchema.parse(await readBody(req))
        const sql = await storeFn(tenant)

        if (body.action === 'enqueue') {
          await createPublishOp(sql, { post_id: body.post_id })
          sendNoContent(res)
          return
        }

        if (body.action === 'mark-ok') {
          await updatePublishOp(sql, body.op_id, {
            status: 'ok',
            external_ref: body.external_ref ?? null,
          })
          sendNoContent(res)
          return
        }

        // mark-failed
        await updatePublishOp(sql, body.op_id, {
          status: 'failed',
          last_error: body.error,
        })
        sendNoContent(res)
      }),
    },

    // ── GET /api/v1/stats ────────────────────────────────────────────────────
    {
      method: 'GET',
      path: '/api/v1/stats',
      handler: wrap(async ({ res, tenant }) => {
        const sql = await storeFn(tenant)
        const subscriberRows = await sql<{ c: string }[]>`SELECT COUNT(DISTINCT email) AS c FROM content.mailing_list_members`
        const postRows = await sql<{ c: string }[]>`SELECT COUNT(*) AS c FROM content.posts`
        const subscribers = Number(subscriberRows[0]!.c)
        const posts = Number(postRows[0]!.c)
        sendOk(res, { subscribers, posts })
      }),
    },

    // ── POST /api/v1/posts/:id/audit ─────────────────────────────────────────
    {
      method: 'POST',
      path: '/api/v1/posts/:id/audit',
      handler: wrap(async ({ req, res, params, tenant }) => {
        const id = params['id']!
        const body = AuditSchema.parse(await readBody(req))
        const sql = await storeFn(tenant)
        const existing = await getPost(sql, id)
        if (!existing) return sendError(res, 404, 'not found')
        await recordContentAudit(sql, { post_id: id, actor_sub: body.actor_sub, action: body.action })
        sendJson(res, 200, { success: true })
      }),
    },
  ]
}

// ── /healthz/tenants handler ──────────────────────────────────────────────────
// Served from the /healthz* path in server.ts, which requires the internal secret
// for this sub-path (F1-FIX-07 K5#12/K5#31, mirroring finance's K4#32). An
// operator confirms the leaf's own PG is reachable for every tenant. The response
// carries booleans ONLY: no tenant ids or slugs, no subscriber/post counts, no DB
// error text (all of which went to any unauthenticated caller before). The
// per-tenant detail is logged server-side.

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
    console.error('[content] /healthz/tenants: tenant listing failed', err)
    res.writeHead(503, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ success: false, db_ok: false }))
    return
  }

  const results: boolean[] = await Promise.all(
    tenants.map(async (t): Promise<boolean> => {
      try {
        const sql = await storeFn(t)
        await sql`SELECT 1`
        return true
      } catch (err) {
        console.error(`[content] /healthz/tenants: tenant ${t.id} (${t.slug}) DB probe failed`, err)
        return false
      }
    }),
  )

  const allOk = results.every(Boolean)
  res.writeHead(allOk ? 200 : 503, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ success: allOk, db_ok: allOk }))
}
