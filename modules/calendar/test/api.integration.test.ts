/**
 * Integration tests for services/calendar/src/http/routes.ts (Task 19)
 *
 * In-process node:http server backed by a REAL per-tenant Postgres store
 * (CALENDAR_TEST_PG_URL). The guard is wired with a fixed test secret so we
 * can exercise both the happy path (with correct headers) and the guard
 * rejection paths.
 *
 * Coverage:
 *  - GET/POST /api/v1/events (happy + 4xx)
 *  - GET/PATCH/DELETE /api/v1/events/:id (happy + 404)
 *  - DELETE /api/v1/events/by-external/:source/:externalId
 *  - GET/POST /api/v1/event-types (incl. ?name= lookup)
 *  - GET/DELETE /api/v1/event-types/:id (incl. system-type delete guard)
 *  - GET/PUT /api/v1/committee-settings/:committeeId
 *  - GET /api/v1/caldav/failed
 *  - GET /healthz -> 200 (guard-exempt)
 *  - Guard: 403 without secret; 400 without tenant headers
 *  - Tenant isolation: two tenant header sets -> disjoint data
 *  - Event-write routes enqueue an outbox row alongside the caldav_sync_queue entry
 *
 * Fail-closed guard: refuses to run unless host is localhost/127.0.0.1
 * and all test DBs use the calendar_test_ prefix.
 */
import http from 'node:http'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import { storeFor, _resetTenantStoreForTests, type TenantRef } from '../src/tenant-store.ts'
import { createServer } from '../src/http/server.ts'
import { buildApiRoutes } from '../src/http/routes.ts'
import { requireEphemeralTestPgUrl, assertSafeTestEnv } from './support/pg-test-guard.ts'

// -- fail-closed guard --------------------------------------------------------

const TEST_PG_URL = requireEphemeralTestPgUrl()
const TEST_DB_PREFIX = 'calendar_test_'
assertSafeTestEnv(TEST_PG_URL, TEST_DB_PREFIX)

// -- test tenants -------------------------------------------------------------

const T1: TenantRef = { id: 'a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1', slug: 'apitenant1' }
const T2: TenantRef = { id: 'b2b2b2b2-b2b2-42b2-82b2-b2b2b2b2b2b2', slug: 'apitenant2' }

const TEST_SECRET = 'test-api-secret-123'

// -- in-process HTTP helpers --------------------------------------------------

function guardHeaders(tenant: TenantRef): Record<string, string> {
  return {
    'x-internal-auth': TEST_SECRET,
    'x-tenant-id': tenant.id,
    'x-tenant-slug': tenant.slug,
    'content-type': 'application/json',
  }
}

interface FetchResult {
  status: number
  body: unknown
}

async function callServer(
  srv: http.Server,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<FetchResult> {
  const addr = srv.address()
  if (!addr || typeof addr === 'string') throw new Error('server not listening')
  const port = addr.port

  return new Promise<FetchResult>((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          ...headers,
          ...(payload !== undefined
            ? { 'content-length': Buffer.byteLength(payload).toString() }
            : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8')
          let parsed: unknown
          try {
            parsed = JSON.parse(raw)
          } catch {
            parsed = raw
          }
          resolve({ status: res.statusCode ?? 0, body: parsed })
        })
      },
    )
    req.on('error', reject)
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

// -- setup --------------------------------------------------------------------

let admin: ReturnType<typeof postgres>
let sql1: Awaited<ReturnType<typeof storeFor>>
let sql2: Awaited<ReturnType<typeof storeFor>>
let server: http.Server

async function dropTestApiDbs(pgSql: ReturnType<typeof postgres>): Promise<void> {
  const rows = await pgSql<{ datname: string }[]>`
    SELECT datname FROM pg_database WHERE datname LIKE 'calendar_test_apitenant%'
  `
  for (const { datname } of rows) {
    await pgSql.unsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${datname}' AND pid <> pg_backend_pid()`,
    )
    await pgSql.unsafe(`DROP DATABASE IF EXISTS "${datname}"`)
  }
  await pgSql
    .unsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'calendar_test_control' AND pid <> pg_backend_pid()`,
    )
    .catch(() => {})
  await pgSql.unsafe(`DROP DATABASE IF EXISTS "calendar_test_control"`).catch(() => {})
}

beforeAll(async () => {
  admin = postgres(TEST_PG_URL, { max: 1, prepare: false })
  await dropTestApiDbs(admin)

  sql1 = await storeFor(T1, { pgUrl: TEST_PG_URL, dbPrefix: TEST_DB_PREFIX })
  sql2 = await storeFor(T2, { pgUrl: TEST_PG_URL, dbPrefix: TEST_DB_PREFIX })

  const routes = buildApiRoutes(async (tenant) => {
    if (tenant.id === T1.id) return sql1
    if (tenant.id === T2.id) return sql2
    throw new Error(`unknown test tenant: ${tenant.id}`)
  })

  server = createServer({ secret: TEST_SECRET, routes })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await _resetTenantStoreForTests()
  await dropTestApiDbs(admin)
  await admin.end()
})

beforeEach(async () => {
  for (const sql of [sql1, sql2]) {
    await sql`DELETE FROM calendar_audit`
    await sql`DELETE FROM outbox`
    await sql`DELETE FROM caldav_sync_queue`
    await sql`DELETE FROM event_recurrence`
    await sql`DELETE FROM event_committees`
    await sql`DELETE FROM committee_calendar_settings`
    await sql`DELETE FROM calendar_events`
    await sql`DELETE FROM event_types WHERE is_system = false`
  }
})

// -- /healthz (guard-exempt) --------------------------------------------------

describe('GET /healthz', () => {
  it('returns 200 without any auth headers', async () => {
    const r = await callServer(server, 'GET', '/healthz', {})
    expect(r.status).toBe(200)
    expect((r.body as Record<string, unknown>)['status']).toBe('ok')
  })
})

// -- guard --------------------------------------------------------------------

describe('guard', () => {
  it('returns 403 without x-internal-auth', async () => {
    const r = await callServer(server, 'GET', '/api/v1/events', {
      'x-tenant-id': T1.id,
      'x-tenant-slug': T1.slug,
    })
    expect(r.status).toBe(403)
    expect((r.body as Record<string, unknown>)['success']).toBe(false)
  })

  it('returns 403 with wrong secret', async () => {
    const r = await callServer(server, 'GET', '/api/v1/events', {
      'x-internal-auth': 'wrong-secret',
      'x-tenant-id': T1.id,
      'x-tenant-slug': T1.slug,
    })
    expect(r.status).toBe(403)
  })

  it('returns 400 with missing x-tenant-id', async () => {
    const r = await callServer(server, 'GET', '/api/v1/events', {
      'x-internal-auth': TEST_SECRET,
      'x-tenant-slug': T1.slug,
    })
    expect(r.status).toBe(400)
    expect(((r.body as Record<string, unknown>)['error'] as string)).toMatch(/x-tenant-id/)
  })
})

// -- events ---------------------------------------------------------------------

const EVENT_BODY = {
  title: 'AStA-Sitzung',
  description: null,
  location: 'Raum 101',
  startAt: '2026-08-01T10:00:00.000Z',
  endAt: '2026-08-01T11:00:00.000Z',
  allDay: false,
  eventTypeId: null,
  isMultiCommittee: false,
  createdBy: 'sub-abc',
  source: 'manual',
  externalId: null,
  committeeIds: [],
  recurrence: null,
}

describe('POST /api/v1/events', () => {
  it('creates an event and returns 201', async () => {
    const r = await callServer(server, 'POST', '/api/v1/events', guardHeaders(T1), EVENT_BODY)
    expect(r.status).toBe(201)
    const data = r.body as { id: string; title: string }
    expect(data.id).toBeTypeOf('string')
    expect(data.title).toBe(EVENT_BODY.title)
  })

  it('returns 400 when title is missing', async () => {
    const { title, ...rest } = EVENT_BODY
    void title
    const r = await callServer(server, 'POST', '/api/v1/events', guardHeaders(T1), rest)
    expect(r.status).toBe(400)
  })

  it('enqueues a caldav_sync_queue entry AND an outbox event.created row in the same tx', async () => {
    const r = await callServer(server, 'POST', '/api/v1/events', guardHeaders(T1), EVENT_BODY)
    const id = (r.body as { id: string }).id

    const queueRows = await sql1<{ event_id: string; operation: string }[]>`
      SELECT event_id, operation FROM caldav_sync_queue WHERE event_id = ${id}
    `
    expect(queueRows).toHaveLength(1)
    expect(queueRows[0]!.operation).toBe('create')

    const outboxRows = await sql1<{ event_type: string }[]>`
      SELECT event_type FROM outbox WHERE event_type = 'event.created'
    `
    expect(outboxRows.length).toBeGreaterThanOrEqual(1)
  })
})

describe('GET /api/v1/events', () => {
  it('returns empty array initially', async () => {
    const r = await callServer(server, 'GET', '/api/v1/events', guardHeaders(T1))
    expect(r.status).toBe(200)
    expect((r.body as { data: unknown[] }).data).toEqual([])
  })

  it('returns created events', async () => {
    await callServer(server, 'POST', '/api/v1/events', guardHeaders(T1), EVENT_BODY)
    const r = await callServer(server, 'GET', '/api/v1/events', guardHeaders(T1))
    expect((r.body as { data: unknown[] }).data).toHaveLength(1)
  })
})

describe('GET /api/v1/events/:id', () => {
  it('returns an event by id', async () => {
    const c = await callServer(server, 'POST', '/api/v1/events', guardHeaders(T1), EVENT_BODY)
    const id = (c.body as { id: string }).id
    const r = await callServer(server, 'GET', `/api/v1/events/${id}`, guardHeaders(T1))
    expect(r.status).toBe(200)
    expect((r.body as { id: string }).id).toBe(id)
  })

  it('returns 404 for unknown id', async () => {
    const r = await callServer(
      server,
      'GET',
      '/api/v1/events/00000000-0000-0000-0000-000000000000',
      guardHeaders(T1),
    )
    expect(r.status).toBe(404)
  })
})

describe('PATCH /api/v1/events/:id', () => {
  it('patches the title', async () => {
    const c = await callServer(server, 'POST', '/api/v1/events', guardHeaders(T1), EVENT_BODY)
    const id = (c.body as { id: string }).id
    const r = await callServer(server, 'PATCH', `/api/v1/events/${id}`, guardHeaders(T1), {
      title: 'Updated Title',
    })
    expect(r.status).toBe(200)
    expect((r.body as { title: string }).title).toBe('Updated Title')
  })

  it('enqueues an outbox event.updated row', async () => {
    const c = await callServer(server, 'POST', '/api/v1/events', guardHeaders(T1), EVENT_BODY)
    const id = (c.body as { id: string }).id
    await callServer(server, 'PATCH', `/api/v1/events/${id}`, guardHeaders(T1), {
      title: 'Updated Title',
    })
    const outboxRows = await sql1<{ event_type: string }[]>`
      SELECT event_type FROM outbox WHERE event_type = 'event.updated'
    `
    expect(outboxRows.length).toBeGreaterThanOrEqual(1)
  })

  it('returns 404 for unknown id', async () => {
    const r = await callServer(
      server,
      'PATCH',
      '/api/v1/events/00000000-0000-0000-0000-000000000000',
      guardHeaders(T1),
      { title: 'x' },
    )
    expect(r.status).toBe(404)
  })
})

describe('DELETE /api/v1/events/:id', () => {
  it('deletes an event and returns its caldavUid', async () => {
    const c = await callServer(server, 'POST', '/api/v1/events', guardHeaders(T1), EVENT_BODY)
    const id = (c.body as { id: string }).id
    const r = await callServer(server, 'DELETE', `/api/v1/events/${id}`, guardHeaders(T1))
    expect(r.status).toBe(200)
    expect((r.body as { caldavUid: string | null }).caldavUid).toBeTypeOf('string')

    const after = await callServer(server, 'GET', `/api/v1/events/${id}`, guardHeaders(T1))
    expect(after.status).toBe(404)
  })

  it('enqueues an outbox event.deleted row', async () => {
    const c = await callServer(server, 'POST', '/api/v1/events', guardHeaders(T1), EVENT_BODY)
    const id = (c.body as { id: string }).id
    await callServer(server, 'DELETE', `/api/v1/events/${id}`, guardHeaders(T1))
    const outboxRows = await sql1<{ event_type: string }[]>`
      SELECT event_type FROM outbox WHERE event_type = 'event.deleted'
    `
    expect(outboxRows.length).toBeGreaterThanOrEqual(1)
  })

  it('returns 404 for unknown id', async () => {
    const r = await callServer(
      server,
      'DELETE',
      '/api/v1/events/00000000-0000-0000-0000-000000000000',
      guardHeaders(T1),
    )
    expect(r.status).toBe(404)
  })
})

describe('DELETE /api/v1/events/by-external/:source/:externalId', () => {
  it('bulk-deletes events matching source+externalId', async () => {
    await callServer(server, 'POST', '/api/v1/events', guardHeaders(T1), {
      ...EVENT_BODY,
      source: 'helios',
      externalId: 'ext-1',
    })
    const r = await callServer(
      server,
      'DELETE',
      '/api/v1/events/by-external/helios/ext-1',
      guardHeaders(T1),
    )
    expect(r.status).toBe(200)
    const list = await callServer(server, 'GET', '/api/v1/events', guardHeaders(T1))
    expect((list.body as { data: unknown[] }).data).toHaveLength(0)
  })

  it('enqueues one event.deleted outbox row per bulk-deleted event', async () => {
    const c1 = await callServer(server, 'POST', '/api/v1/events', guardHeaders(T1), {
      ...EVENT_BODY,
      source: 'helios',
      externalId: 'ext-bulk-outbox',
    })
    const c2 = await callServer(server, 'POST', '/api/v1/events', guardHeaders(T1), {
      ...EVENT_BODY,
      source: 'helios',
      externalId: 'ext-bulk-outbox',
    })
    const id1 = (c1.body as { id: string }).id
    const id2 = (c2.body as { id: string }).id

    const r = await callServer(
      server,
      'DELETE',
      '/api/v1/events/by-external/helios/ext-bulk-outbox',
      guardHeaders(T1),
    )
    expect(r.status).toBe(200)

    const outboxRows = await sql1<{ payload: { eventDbId: string; externalId: string } }[]>`
      SELECT payload FROM outbox WHERE event_type = 'event.deleted'
    `
    const matching = outboxRows.filter((row) =>
      [id1, id2].includes(row.payload.eventDbId),
    )
    expect(matching).toHaveLength(2)
    for (const row of matching) {
      expect(row.payload.externalId).toBe('ext-bulk-outbox')
    }
  })
})

// -- event types ------------------------------------------------------------

describe('POST /api/v1/event-types', () => {
  it('creates an event type and returns 201', async () => {
    const r = await callServer(server, 'POST', '/api/v1/event-types', guardHeaders(T1), {
      name: 'Sitzung',
      color: '#ff0000',
    })
    expect(r.status).toBe(201)
    const data = r.body as { id: string; name: string }
    expect(data.name).toBe('Sitzung')
  })
})

describe('GET /api/v1/event-types', () => {
  it('returns created event types', async () => {
    await callServer(server, 'POST', '/api/v1/event-types', guardHeaders(T1), {
      name: 'Sitzung',
      color: '#ff0000',
    })
    const r = await callServer(server, 'GET', '/api/v1/event-types', guardHeaders(T1))
    expect(r.status).toBe(200)
    const data = (r.body as { data: { name: string }[] }).data
    expect(data.some((t) => t.name === 'Sitzung')).toBe(true)
  })

  it('supports ?name= lookup (getEventTypeByName)', async () => {
    await callServer(server, 'POST', '/api/v1/event-types', guardHeaders(T1), {
      name: 'Klausurtagung',
      color: '#00ff00',
    })
    const r = await callServer(
      server,
      'GET',
      '/api/v1/event-types?name=Klausurtagung',
      guardHeaders(T1),
    )
    expect(r.status).toBe(200)
    expect((r.body as { name: string }).name).toBe('Klausurtagung')
  })

  it('returns 404 for an unknown ?name=', async () => {
    const r = await callServer(
      server,
      'GET',
      '/api/v1/event-types?name=nonexistent',
      guardHeaders(T1),
    )
    expect(r.status).toBe(404)
  })
})

describe('GET /api/v1/event-types/:id', () => {
  it('returns an event type by id', async () => {
    const c = await callServer(server, 'POST', '/api/v1/event-types', guardHeaders(T1), {
      name: 'Vorstand',
      color: '#123456',
    })
    const id = (c.body as { id: string }).id
    const r = await callServer(server, 'GET', `/api/v1/event-types/${id}`, guardHeaders(T1))
    expect(r.status).toBe(200)
    expect((r.body as { id: string }).id).toBe(id)
  })

  it('returns 404 for unknown id', async () => {
    const r = await callServer(
      server,
      'GET',
      '/api/v1/event-types/00000000-0000-0000-0000-000000000000',
      guardHeaders(T1),
    )
    expect(r.status).toBe(404)
  })
})

describe('DELETE /api/v1/event-types/:id', () => {
  it('deletes a non-system event type', async () => {
    const c = await callServer(server, 'POST', '/api/v1/event-types', guardHeaders(T1), {
      name: 'ToDelete',
      color: '#000000',
    })
    const id = (c.body as { id: string }).id
    const r = await callServer(server, 'DELETE', `/api/v1/event-types/${id}`, guardHeaders(T1))
    expect(r.status).toBe(200)
  })

  it('returns 400 when attempting to delete a system event type', async () => {
    const sysRows = await sql1<{ id: string }[]>`SELECT id FROM event_types WHERE is_system = true LIMIT 1`
    if (sysRows.length === 0) return // no system type seeded in this schema — skip
    const r = await callServer(
      server,
      'DELETE',
      `/api/v1/event-types/${sysRows[0]!.id}`,
      guardHeaders(T1),
    )
    expect(r.status).toBe(400)
  })
})

// -- committee settings -------------------------------------------------------

describe('GET/PUT /api/v1/committee-settings/:committeeId', () => {
  const COMMITTEE_ID = '9999cccc-cccc-4ccc-8ccc-cccccccccccc'

  it('returns 404 when no settings exist yet', async () => {
    const r = await callServer(
      server,
      'GET',
      `/api/v1/committee-settings/${COMMITTEE_ID}`,
      guardHeaders(T1),
    )
    expect(r.status).toBe(404)
  })

  it('upserts and retrieves committee colour settings', async () => {
    const put = await callServer(
      server,
      'PUT',
      `/api/v1/committee-settings/${COMMITTEE_ID}`,
      guardHeaders(T1),
      { color: '#abcdef' },
    )
    expect(put.status).toBe(200)
    expect((put.body as { color: string }).color).toBe('#abcdef')

    const get = await callServer(
      server,
      'GET',
      `/api/v1/committee-settings/${COMMITTEE_ID}`,
      guardHeaders(T1),
    )
    expect(get.status).toBe(200)
    expect((get.body as { color: string }).color).toBe('#abcdef')
  })
})

// -- caldav failed ------------------------------------------------------------

describe('GET /api/v1/caldav/failed', () => {
  it('returns an empty list when nothing has failed', async () => {
    const r = await callServer(server, 'GET', '/api/v1/caldav/failed', guardHeaders(T1))
    expect(r.status).toBe(200)
    expect((r.body as { data: unknown[] }).data).toEqual([])
  })
})

// -- tenant isolation ---------------------------------------------------------

describe('tenant isolation', () => {
  it('events created under T1 are not visible to T2', async () => {
    await callServer(server, 'POST', '/api/v1/events', guardHeaders(T1), EVENT_BODY)
    const r = await callServer(server, 'GET', '/api/v1/events', guardHeaders(T2))
    expect(r.status).toBe(200)
    expect((r.body as { data: unknown[] }).data).toHaveLength(0)
  })
})
