// services/calendar/src/http/routes.ts
//
// Task 19: all /api/v1/* route handlers for the calendar leaf service.
//
// All routes run under the guard (shared secret + tenant headers). Handler
// shape: each factory receives a `storeFn` callback (DI so tests can inject
// a pre-seeded per-tenant Sql without touching the real storeFor).
//
// Error envelope: {success:false,error} — mirrors the monolith house JSON
// shape (gremion-ui/src/lib/server/response.ts sendError / sendSuccess pattern).
//
// Response shape note: entity-returning routes (GET/POST/PATCH one event,
// GET/POST one event-type, GET/PUT one committee-settings row) return the
// entity DIRECTLY (no {success,data} envelope) — this matches
// gremion-ui/src/lib/server/calendar/backend/service-client.ts's deserialize*
// helpers, which read the response body's fields straight off (e.g. raw.id,
// raw.startAt), not raw.data.id. List-returning routes wrap in {data: [...]}
// to match service-client.ts's `(res.data ?? [])` reads.
//
// Body reading: the server provides no body helper, so readBody() is module-local.
//
// Event-write routes (create/update/delete, including the bulk
// delete-by-external route) enqueue BOTH a caldav_sync_queue entry (via the
// store/events.ts side-effect) AND an outbox event.created/event.updated/
// event.deleted row IN THE SAME TRANSACTION as the domain mutation
// (co-commit guarantee, per outbox.integration.test.ts's pattern and the
// cross-task notes on enqueueOutbox()). Since store/events.ts's
// createEvent/updateEvent/deleteEvent/deleteEventsByExternalId do not
// themselves open the transaction, the route handlers wrap the store call +
// enqueueOutbox in one sql.begin() block, passing the transaction Sql to
// both. The bulk delete-by-external route enqueues ONE event.deleted row
// PER deleted event (using deleteEventsByExternalId's returned ids as the
// eventDbId anchor), matching the AsyncAPI contract's per-event payload
// shape (contracts/calendar/asyncapi.calendar.json).

import type http from 'node:http'
import { z } from 'zod'
import {
  InvalidTenantIdError,
  InvalidTenantSlugError,
  TenantIdentityMismatchError,
  type Sql,
  type TenantRef,
} from '../tenant-store.js'
import type { Route, RouteContext } from './router.js'
import { enqueueOutbox } from '../outbox.js'
import { BYDAY_PATTERN } from '../caldav/client.js'
import type { CalendarEvent } from '@gremion/ports/broker'
import {
  listEvents,
  getEvent,
  createEvent,
  updateEvent,
  deleteEvent,
  deleteEventsByExternalId,
  findEventByExternalId,
  listEventTypes,
  getEventType,
  getEventTypeByName,
  createEventType,
  deleteEventType,
  getCommitteeCalendarSettings,
  upsertCommitteeCalendarSettings,
  listFailedCaldavSync,
  type EventSource,
} from '../store/index.js'

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

const EVENT_SOURCES = ['manual', 'helios', 'minutes', 'holiday', 'newsletter'] as const

export const RecurrenceSchema = z
  .object({
    frequency: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
    interval: z.number().int().positive().optional().default(1),
    count: z.number().int().positive().nullable().optional().default(null),
    until: z.coerce.date().nullable().optional().default(null),
    // K4#21: BYDAY is written verbatim into the ICS RRULE, so it is validated here
    // (and again in buildRRule): RFC 5545 weekday with an optional ordinal.
    byday: z.array(z.string().regex(BYDAY_PATTERN, 'invalid BYDAY value')).nullable().optional().default(null),
    exceptions: z.array(z.coerce.date()).nullable().optional().default(null),
  })
  .nullable()

const CreateEventSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().nullable().optional().default(null),
  location: z.string().nullable().optional().default(null),
  startAt: z.coerce.date(),
  endAt: z.coerce.date(),
  allDay: z.boolean().optional().default(false),
  isPublic: z.boolean().optional(),
  eventTypeId: z.string().nullable().optional().default(null),
  isMultiCommittee: z.boolean().optional().default(false),
  createdBy: z.string().min(1),
  source: z.enum(EVENT_SOURCES).optional().default('manual'),
  externalId: z.string().nullable().optional().default(null),
  committeeIds: z.array(z.string()).optional().default([]),
  recurrence: RecurrenceSchema.optional().default(null),
})

const UpdateEventSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  startAt: z.coerce.date().optional(),
  endAt: z.coerce.date().optional(),
  allDay: z.boolean().optional(),
  isPublic: z.boolean().optional(),
  eventTypeId: z.string().nullable().optional(),
  isMultiCommittee: z.boolean().optional(),
  committeeIds: z.array(z.string()).optional(),
  recurrence: RecurrenceSchema.optional(),
})

const CreateEventTypeSchema = z.object({
  name: z.string().min(1).max(255),
  color: z.string().min(1).max(32),
})

const UpsertCommitteeSettingsSchema = z.object({
  color: z.string().min(1).max(32),
})

// ── route builder ─────────────────────────────────────────────────────────────

/**
 * Build all /api/v1/* routes.
 *
 * The server extends RouteContext to carry req+res+tenant via a type cast in
 * server.ts. Each handler receives an ApiContext which is the extended
 * RouteContext.
 */
export function buildApiRoutes(storeFn: StoreFn): Route[] {
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
        } else if (err instanceof Error && err.message === 'Event type not found') {
          sendError(extended.res, 404, err.message)
        } else if (err instanceof Error && err.message === 'Cannot delete system event type') {
          sendError(extended.res, 400, err.message)
        } else if (err instanceof TenantIdentityMismatchError) {
          // The (id, slug) pair is not the one the catalog binds (audit #534): a
          // stale or forged pair, never a server fault. The body names neither tenant.
          console.warn(`[calendar:api] ${err.message}`)
          sendError(extended.res, 409, 'tenant_identity_mismatch')
        } else if (err instanceof InvalidTenantIdError) {
          // A tenant id that is not a canonical lowercase uuid (follow-up to audit
          // #534): the caller's error, never a server fault. The body names nothing.
          console.warn(`[calendar:api] ${err.message}`)
          sendError(extended.res, 400, 'invalid_tenant_id')
        } else if (err instanceof InvalidTenantSlugError) {
          // A slug storeFor will not build a database name from (reserved, or the
          // grammar): the caller's error. The body names nothing.
          console.warn(`[calendar:api] ${err.message}`)
          sendError(extended.res, 400, 'invalid_tenant_slug')
        } else {
          console.error('[calendar:api] unhandled route error', err)
          if (!extended.res.headersSent) {
            sendError(extended.res, 500, 'internal error')
          }
        }
      }
    }

  return [
    // ── GET /api/v1/events ───────────────────────────────────────────────────
    {
      method: 'GET',
      path: '/api/v1/events',
      handler: wrap(async ({ req, res, tenant }) => {
        const url = new URL(req.url ?? '/', 'http://internal')
        const from = url.searchParams.get('from')
        const to = url.searchParams.get('to')
        const committeeId = url.searchParams.get('committeeId') ?? undefined
        const eventTypeId = url.searchParams.get('eventTypeId') ?? undefined
        const sql = await storeFn(tenant)
        const events = await listEvents(sql, {
          from: from ? new Date(from) : undefined,
          to: to ? new Date(to) : undefined,
          committeeId,
          eventTypeId,
        })
        sendJson(res, 200, { data: events })
      }),
    },

    // ── POST /api/v1/events ──────────────────────────────────────────────────
    {
      method: 'POST',
      path: '/api/v1/events',
      handler: wrap(async ({ req, res, tenant }) => {
        const body = CreateEventSchema.parse(await readBody(req))
        const sql = await storeFn(tenant)

        const event = await sql.begin(async (tx) => {
          const created = await createEvent(tx as unknown as Sql, body)
          await enqueueOutbox(
            tx as unknown as Sql,
            'event.created' as CalendarEvent,
            { eventDbId: created.id, committeeId: created.committeeIds[0] ?? null, source: created.source },
            created.id,
          )
          return created
        })

        sendJson(res, 201, event)
      }),
    },

    // ── GET /api/v1/events/:id ───────────────────────────────────────────────
    {
      method: 'GET',
      path: '/api/v1/events/:id',
      handler: wrap(async ({ res, params, tenant }) => {
        const sql = await storeFn(tenant)
        const event = await getEvent(sql, params['id']!)
        if (!event) return sendError(res, 404, 'not found')
        sendJson(res, 200, event)
      }),
    },

    // ── PATCH /api/v1/events/:id ─────────────────────────────────────────────
    {
      method: 'PATCH',
      path: '/api/v1/events/:id',
      handler: wrap(async ({ req, res, params, tenant }) => {
        const id = params['id']!
        const body = UpdateEventSchema.parse(await readBody(req))
        const sql = await storeFn(tenant)

        const existing = await getEvent(sql, id)
        if (!existing) return sendError(res, 404, 'not found')

        const updated = await sql.begin(async (tx) => {
          const result = await updateEvent(tx as unknown as Sql, id, body)
          await enqueueOutbox(
            tx as unknown as Sql,
            'event.updated' as CalendarEvent,
            { eventDbId: result.id, changedFields: Object.keys(body) },
            result.id,
          )
          return result
        })

        sendJson(res, 200, updated)
      }),
    },

    // ── DELETE /api/v1/events/:id ────────────────────────────────────────────
    {
      method: 'DELETE',
      path: '/api/v1/events/:id',
      handler: wrap(async ({ res, params, tenant }) => {
        const id = params['id']!
        const sql = await storeFn(tenant)

        const existing = await getEvent(sql, id)
        if (!existing) return sendError(res, 404, 'not found')

        const caldavUid = await sql.begin(async (tx) => {
          const uid = await deleteEvent(tx as unknown as Sql, id)
          await enqueueOutbox(
            tx as unknown as Sql,
            'event.deleted' as CalendarEvent,
            { eventDbId: id, externalId: existing.externalId },
            id,
          )
          return uid
        })

        sendJson(res, 200, { caldavUid })
      }),
    },

    // ── GET /api/v1/events/by-external/:source/:externalId ──────────────────
    // Cross-DB-safe dedup read (CalendarBackendPort.findEventByExternalId).
    // Returns the entity directly (like GET /:id) or 404 when none matches.
    {
      method: 'GET',
      path: '/api/v1/events/by-external/:source/:externalId',
      handler: wrap(async ({ res, params, tenant }) => {
        const source = params['source'] as EventSource
        const externalId = params['externalId']!
        const sql = await storeFn(tenant)
        const event = await findEventByExternalId(sql, source, externalId)
        if (!event) return sendError(res, 404, 'not found')
        sendJson(res, 200, event)
      }),
    },

    // ── DELETE /api/v1/events/by-external/:source/:externalId ───────────────
    {
      method: 'DELETE',
      path: '/api/v1/events/by-external/:source/:externalId',
      handler: wrap(async ({ res, params, tenant }) => {
        const source = params['source'] as EventSource
        const externalId = params['externalId']!
        const sql = await storeFn(tenant)

        await sql.begin(async (tx) => {
          const deletedIds = await deleteEventsByExternalId(tx as unknown as Sql, source, externalId)
          for (const eventDbId of deletedIds) {
            await enqueueOutbox(
              tx as unknown as Sql,
              'event.deleted' as CalendarEvent,
              { eventDbId, externalId },
              eventDbId,
            )
          }
        })

        sendJson(res, 200, { success: true })
      }),
    },

    // ── POST /api/v1/event-types ─────────────────────────────────────────────
    {
      method: 'POST',
      path: '/api/v1/event-types',
      handler: wrap(async ({ req, res, tenant }) => {
        const body = CreateEventTypeSchema.parse(await readBody(req))
        const sql = await storeFn(tenant)
        const eventType = await createEventType(sql, body)
        sendJson(res, 201, eventType)
      }),
    },

    // ── GET /api/v1/event-types (+ ?name= lookup) ────────────────────────────
    {
      method: 'GET',
      path: '/api/v1/event-types',
      handler: wrap(async ({ req, res, tenant }) => {
        const url = new URL(req.url ?? '/', 'http://internal')
        const name = url.searchParams.get('name')
        const sql = await storeFn(tenant)
        if (name !== null) {
          const eventType = await getEventTypeByName(sql, name)
          if (!eventType) return sendError(res, 404, 'not found')
          return sendJson(res, 200, eventType)
        }
        const eventTypes = await listEventTypes(sql)
        sendJson(res, 200, { data: eventTypes })
      }),
    },

    // ── GET /api/v1/event-types/:id ───────────────────────────────────────────
    {
      method: 'GET',
      path: '/api/v1/event-types/:id',
      handler: wrap(async ({ res, params, tenant }) => {
        const sql = await storeFn(tenant)
        const eventType = await getEventType(sql, params['id']!)
        if (!eventType) return sendError(res, 404, 'not found')
        sendJson(res, 200, eventType)
      }),
    },

    // ── DELETE /api/v1/event-types/:id ────────────────────────────────────────
    {
      method: 'DELETE',
      path: '/api/v1/event-types/:id',
      handler: wrap(async ({ res, params, tenant }) => {
        const sql = await storeFn(tenant)
        await deleteEventType(sql, params['id']!)
        sendJson(res, 200, { success: true })
      }),
    },

    // ── GET /api/v1/committee-settings/:committeeId ──────────────────────────
    {
      method: 'GET',
      path: '/api/v1/committee-settings/:committeeId',
      handler: wrap(async ({ res, params, tenant }) => {
        const sql = await storeFn(tenant)
        const settings = await getCommitteeCalendarSettings(sql, params['committeeId']!)
        if (!settings) return sendError(res, 404, 'not found')
        sendJson(res, 200, settings)
      }),
    },

    // ── PUT /api/v1/committee-settings/:committeeId ──────────────────────────
    {
      method: 'PUT',
      path: '/api/v1/committee-settings/:committeeId',
      handler: wrap(async ({ req, res, params, tenant }) => {
        const body = UpsertCommitteeSettingsSchema.parse(await readBody(req))
        const sql = await storeFn(tenant)
        const settings = await upsertCommitteeCalendarSettings(
          sql,
          params['committeeId']!,
          body.color,
        )
        sendJson(res, 200, settings)
      }),
    },

    // ── GET /api/v1/caldav/failed ─────────────────────────────────────────────
    {
      method: 'GET',
      path: '/api/v1/caldav/failed',
      handler: wrap(async ({ res, tenant }) => {
        const sql = await storeFn(tenant)
        const failed = await listFailedCaldavSync(sql)
        sendJson(res, 200, { data: failed })
      }),
    },
  ]
}

// ── /healthz/tenants handler ──────────────────────────────────────────────────
// Guard-EXEMPT (served from the /healthz* path in server.ts).
// Returns per-tenant DB ping + event count.

export interface TenantHealth {
  tenant_id: string
  tenant_slug: string
  db_ok: boolean
  events?: number
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
        const rows = await sql<{ c: string }[]>`SELECT COUNT(*) AS c FROM calendar_events`
        return {
          tenant_id: t.id,
          tenant_slug: t.slug,
          db_ok: true,
          events: Number(rows[0]!.c),
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
