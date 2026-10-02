// @vitest-environment node
// gremion-ui/src/lib/server/calendar/backend/service-client.test.ts
// Task 3 — TDD test suite for ServiceCalendarClient.
//
// Runs in the `node` environment (not the suite-default jsdom): this is a
// pure server-side client driving a real node:http stub via the native undici
// `fetch`. Under jsdom, the installed AbortController/AbortSignal globals are a
// DIFFERENT realm than the one undici's fetch closed over, so the client's
// `new AbortController().signal` is rejected with
// "RequestInit: Expected signal ... to be an instance of AbortSignal". The
// `node` env leaves the native fetch/AbortSignal pair intact (matching the many
// other server-only specs that use this same pragma). No DOM is used here.
//
// Strategy: spin up a real node:http stub server per test suite; point
// CALENDAR_SERVICE_URL at it; assert header forwarding, error mapping,
// and retry behaviour. The stub captures every request so assertions are
// deterministic without any real network I/O.
//
// RED: written BEFORE service-client.ts exists → import fails → all FAIL.
// GREEN: service-client.ts implemented → all PASS.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Server } from 'node:http'
import { runWithTenant, type TenantContext } from '$lib/server/tenant/context'
import { ServiceCalendarClient, CalendarServiceError } from './service-client'
import type { CalendarBackendPort } from './port'

// ── Fake tenant context ──────────────────────────────────────────────────────
const FAKE_TENANT: TenantContext = {
  id: 'tenant-uuid-calendar',
  slug: 'cal-test',
} as unknown as TenantContext

// ── Shared stub server state ─────────────────────────────────────────────────

interface CapturedRequest {
  method: string
  url: string
  headers: Record<string, string | string[] | undefined>
  body: unknown
}

interface StubBehaviour {
  /** Status to return on the FIRST call to this handler (default 200). */
  firstStatus?: number
  /** Status to return on subsequent calls (default firstStatus). */
  subsequentStatus?: number
  /** JSON body to return (default {}). */
  body?: unknown
  /** Call counter — incremented by the stub handler. */
  callCount: number
}

let server: Server
let port: number
let lastRequest: CapturedRequest | null = null
let stubBehaviour: StubBehaviour = { callCount: 0 }

function resetStub(opts: Omit<StubBehaviour, 'callCount'> = {}) {
  lastRequest = null
  stubBehaviour = { callCount: 0, ...opts }
}

beforeAll(async () => {
  server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    stubBehaviour.callCount++
    const callIdx = stubBehaviour.callCount

    // Collect body
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(chunk as Buffer)
    }
    const rawBody = Buffer.concat(chunks).toString('utf8')
    let parsedBody: unknown = undefined
    if (rawBody) {
      try {
        parsedBody = JSON.parse(rawBody)
      } catch {
        parsedBody = rawBody
      }
    }

    // Capture the request
    lastRequest = {
      method: req.method ?? 'GET',
      url: req.url ?? '/',
      headers: req.headers as Record<string, string | string[] | undefined>,
      body: parsedBody,
    }

    const status =
      callIdx === 1
        ? (stubBehaviour.firstStatus ?? 200)
        : (stubBehaviour.subsequentStatus ?? stubBehaviour.firstStatus ?? 200)

    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(stubBehaviour.body ?? {}))
  })

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as { port: number }).port
      resolve()
    })
  })
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  )
})

// ── Set environment before each test ────────────────────────────────────────
beforeEach(() => {
  process.env.CALENDAR_SERVICE_URL = `http://127.0.0.1:${port}`
  process.env.INTERNAL_CALENDAR_SECRET = 'cal-secret-5678'
  resetStub({ body: {} })
})

// ── Helper: run inside tenant context ────────────────────────────────────────
function withTenant<T>(fn: () => T): T {
  return runWithTenant(FAKE_TENANT, fn)
}

// ── Minimal event fixture ─────────────────────────────────────────────────────
function makeEventBody(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ev-1',
    title: 'Test event',
    description: null,
    location: null,
    startAt: '2025-01-01T10:00:00.000Z',
    endAt: '2025-01-01T11:00:00.000Z',
    allDay: false,
    eventTypeId: null,
    eventTypeColor: null,
    eventTypeName: null,
    isMultiCommittee: false,
    createdBy: 'user-1',
    source: 'manual',
    externalId: null,
    caldavUid: null,
    caldavSyncedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    committeeIds: [],
    recurrence: null,
    colour: { primary: '#888', secondary: '#ccc' },
    readOnly: false,
    ...overrides,
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// kind discriminant
// ═══════════════════════════════════════════════════════════════════════════════

describe('ServiceCalendarClient — kind', () => {
  it('has kind === service', () => {
    const client: CalendarBackendPort = new ServiceCalendarClient()
    expect(client.kind).toBe('service')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Header forwarding
// ═══════════════════════════════════════════════════════════════════════════════

describe('ServiceCalendarClient — header forwarding', () => {
  it('forwards x-tenant-id, x-tenant-slug, and x-internal-auth on createEvent', async () => {
    resetStub({ firstStatus: 201, body: makeEventBody() })
    const client = new ServiceCalendarClient()
    await withTenant(() =>
      client.createEvent({
        title: 'Test',
        description: null,
        location: null,
        startAt: new Date('2025-01-01T10:00:00Z'),
        endAt: new Date('2025-01-01T11:00:00Z'),
        allDay: false,
        eventTypeId: null,
        isMultiCommittee: false,
        createdBy: 'user-1',
        source: 'manual',
        externalId: null,
        committeeIds: [],
        recurrence: null,
      })
    )
    expect(lastRequest).not.toBeNull()
    expect(lastRequest!.headers['x-tenant-id']).toBe('tenant-uuid-calendar')
    expect(lastRequest!.headers['x-tenant-slug']).toBe('cal-test')
    expect(lastRequest!.headers['x-internal-auth']).toBe('cal-secret-5678')
  })

  it('forwards x-correlation-id when provided in constructor', async () => {
    resetStub({ body: { data: [] } })
    const client = new ServiceCalendarClient({ correlationId: 'corr-abc' })
    await withTenant(() => client.listEvents())
    expect(lastRequest!.headers['x-correlation-id']).toBe('corr-abc')
  })

  it('omits x-correlation-id when not provided', async () => {
    resetStub({ body: { data: [] } })
    const client = new ServiceCalendarClient()
    await withTenant(() => client.listEvents())
    expect(lastRequest!.headers['x-correlation-id']).toBeUndefined()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Error mapping
// ═══════════════════════════════════════════════════════════════════════════════

describe('ServiceCalendarClient — error mapping', () => {
  it('getEvent returns null when leaf returns 404', async () => {
    resetStub({ firstStatus: 404, body: { error: 'Not found' } })
    const client = new ServiceCalendarClient()
    const result = await withTenant(() => client.getEvent('missing-id'))
    expect(result).toBeNull()
  })

  it('throws CalendarServiceError with correct status on POST 500', async () => {
    resetStub({ firstStatus: 500, body: { error: 'Internal error' } })
    const client = new ServiceCalendarClient()
    await expect(
      withTenant(() =>
        client.createEvent({
          title: 'Fail',
          description: null,
          location: null,
          startAt: new Date('2025-01-01T10:00:00Z'),
          endAt: new Date('2025-01-01T11:00:00Z'),
          allDay: false,
          eventTypeId: null,
          isMultiCommittee: false,
          createdBy: 'user-1',
          source: 'manual',
          externalId: null,
          committeeIds: [],
          recurrence: null,
        })
      )
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof CalendarServiceError && e.status === 500
    )
    // POST must NOT retry → only one call
    expect(stubBehaviour.callCount).toBe(1)
  })

  it('throws an error when CALENDAR_SERVICE_URL is not set', async () => {
    delete process.env.CALENDAR_SERVICE_URL
    const client = new ServiceCalendarClient()
    await expect(withTenant(() => client.listEvents())).rejects.toThrow(/CALENDAR_SERVICE_URL/)
    process.env.CALENDAR_SERVICE_URL = `http://127.0.0.1:${port}`
  })

  it('throws an error when INTERNAL_CALENDAR_SECRET is not set', async () => {
    delete process.env.INTERNAL_CALENDAR_SECRET
    const client = new ServiceCalendarClient()
    await expect(withTenant(() => client.listEvents())).rejects.toThrow(/INTERNAL_CALENDAR_SECRET/)
    process.env.INTERNAL_CALENDAR_SECRET = 'cal-secret-5678'
  })

  it('throws CalendarServiceError with status 503 when leaf returns 503 on both attempts (GET)', async () => {
    resetStub({ firstStatus: 503, subsequentStatus: 503, body: { error: 'Service unavailable' } })
    const client = new ServiceCalendarClient()
    await expect(withTenant(() => client.listEvents())).rejects.toSatisfy(
      (e: unknown) => e instanceof CalendarServiceError && e.status === 503
    )
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Retry policy
// ═══════════════════════════════════════════════════════════════════════════════

describe('ServiceCalendarClient — retry policy', () => {
  it('retries once on GET when leaf returns 503 first then 200', async () => {
    resetStub({
      firstStatus: 503,
      subsequentStatus: 200,
      body: { data: [] },
    })
    const client = new ServiceCalendarClient()
    const result = await withTenant(() => client.listEvents())
    expect(Array.isArray(result)).toBe(true)
    expect(stubBehaviour.callCount).toBe(2)
  })

  it('does NOT retry on POST even when leaf returns 503', async () => {
    resetStub({
      firstStatus: 503,
      subsequentStatus: 200,
      body: makeEventBody(),
    })
    const client = new ServiceCalendarClient()
    await expect(
      withTenant(() =>
        client.createEvent({
          title: 'No-retry',
          description: null,
          location: null,
          startAt: new Date('2025-01-01T10:00:00Z'),
          endAt: new Date('2025-01-01T11:00:00Z'),
          allDay: false,
          eventTypeId: null,
          isMultiCommittee: false,
          createdBy: 'user-1',
          source: 'manual',
          externalId: null,
          committeeIds: [],
          recurrence: null,
        })
      )
    ).rejects.toSatisfy((e: unknown) => e instanceof CalendarServiceError && e.status === 503)
    // Only one call — no retry on POST
    expect(stubBehaviour.callCount).toBe(1)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Method routing — verifies correct HTTP verbs and path shapes
// ═══════════════════════════════════════════════════════════════════════════════

describe('ServiceCalendarClient — method routing', () => {
  it('listEvents → GET /api/v1/events', async () => {
    resetStub({ body: { data: [] } })
    const client = new ServiceCalendarClient()
    await withTenant(() => client.listEvents())
    expect(lastRequest!.method).toBe('GET')
    expect(lastRequest!.url).toMatch(/^\/api\/v1\/events/)
  })

  it('listEvents with filter → GET /api/v1/events?from=...', async () => {
    resetStub({ body: { data: [] } })
    const client = new ServiceCalendarClient()
    const from = new Date('2025-01-01T00:00:00Z')
    await withTenant(() => client.listEvents({ from }))
    expect(lastRequest!.method).toBe('GET')
    expect(lastRequest!.url).toContain('/api/v1/events')
  })

  it('getEvent → GET /api/v1/events/ev-1', async () => {
    resetStub({ body: makeEventBody() })
    const client = new ServiceCalendarClient()
    const result = await withTenant(() => client.getEvent('ev-1'))
    expect(lastRequest!.method).toBe('GET')
    expect(lastRequest!.url).toBe('/api/v1/events/ev-1')
    expect(result).not.toBeNull()
    expect(result!.id).toBe('ev-1')
  })

  it('createEvent → POST /api/v1/events', async () => {
    resetStub({ firstStatus: 201, body: makeEventBody() })
    const client = new ServiceCalendarClient()
    await withTenant(() =>
      client.createEvent({
        title: 'New',
        description: null,
        location: null,
        startAt: new Date('2025-01-01T10:00:00Z'),
        endAt: new Date('2025-01-01T11:00:00Z'),
        allDay: false,
        eventTypeId: null,
        isMultiCommittee: false,
        createdBy: 'user-1',
        source: 'manual',
        externalId: null,
        committeeIds: [],
        recurrence: null,
      })
    )
    expect(lastRequest!.method).toBe('POST')
    expect(lastRequest!.url).toBe('/api/v1/events')
    expect((lastRequest!.body as Record<string, unknown>).title).toBe('New')
  })

  it('updateEvent → PATCH /api/v1/events/ev-1', async () => {
    resetStub({ body: makeEventBody({ title: 'Updated' }) })
    const client = new ServiceCalendarClient()
    await withTenant(() => client.updateEvent('ev-1', { title: 'Updated' }))
    expect(lastRequest!.method).toBe('PATCH')
    expect(lastRequest!.url).toBe('/api/v1/events/ev-1')
    expect((lastRequest!.body as Record<string, unknown>).title).toBe('Updated')
  })

  it('deleteEvent → DELETE /api/v1/events/ev-1', async () => {
    resetStub({ body: { caldavUid: 'uid@stura' } })
    const client = new ServiceCalendarClient()
    const result = await withTenant(() => client.deleteEvent('ev-1'))
    expect(lastRequest!.method).toBe('DELETE')
    expect(lastRequest!.url).toBe('/api/v1/events/ev-1')
    expect(result).toBe('uid@stura')
  })

  it('deleteEventsByExternalId → DELETE /api/v1/events/by-external/helios/ext-123', async () => {
    resetStub({ body: {} })
    const client = new ServiceCalendarClient()
    await withTenant(() => client.deleteEventsByExternalId('helios', 'ext-123'))
    expect(lastRequest!.method).toBe('DELETE')
    expect(lastRequest!.url).toBe('/api/v1/events/by-external/helios/ext-123')
  })

  it('findEventByExternalId → GET /api/v1/events/by-external/holiday/h-1', async () => {
    resetStub({ body: makeEventBody({ id: 'ev-h', source: 'holiday', externalId: 'h-1' }) })
    const client = new ServiceCalendarClient()
    const result = await withTenant(() => client.findEventByExternalId('holiday', 'h-1'))
    expect(lastRequest!.method).toBe('GET')
    expect(lastRequest!.url).toBe('/api/v1/events/by-external/holiday/h-1')
    expect(result).not.toBeNull()
    expect(result!.id).toBe('ev-h')
  })

  it('findEventByExternalId returns null when leaf returns 404', async () => {
    resetStub({ firstStatus: 404, body: { error: 'not found' } })
    const client = new ServiceCalendarClient()
    const result = await withTenant(() => client.findEventByExternalId('holiday', 'missing'))
    expect(result).toBeNull()
  })

  it('findEventByExternalId retries once on 503 then 200 (idempotent GET)', async () => {
    resetStub({
      firstStatus: 503,
      subsequentStatus: 200,
      body: makeEventBody({ id: 'ev-h', source: 'holiday', externalId: 'h-1' }),
    })
    const client = new ServiceCalendarClient()
    const result = await withTenant(() => client.findEventByExternalId('holiday', 'h-1'))
    expect(result!.id).toBe('ev-h')
    expect(stubBehaviour.callCount).toBe(2)
  })

  it('listEventTypes → GET /api/v1/event-types', async () => {
    resetStub({ body: { data: [] } })
    const client = new ServiceCalendarClient()
    await withTenant(() => client.listEventTypes())
    expect(lastRequest!.method).toBe('GET')
    expect(lastRequest!.url).toBe('/api/v1/event-types')
  })

  it('getEventType → GET /api/v1/event-types/et-1', async () => {
    const etBody = { id: 'et-1', name: 'Sitzung', color: '#f00', isSystem: false, createdAt: new Date().toISOString() }
    resetStub({ body: etBody })
    const client = new ServiceCalendarClient()
    const result = await withTenant(() => client.getEventType('et-1'))
    expect(lastRequest!.method).toBe('GET')
    expect(lastRequest!.url).toBe('/api/v1/event-types/et-1')
    expect(result!.id).toBe('et-1')
  })

  it('getEventType returns null when leaf returns 404', async () => {
    resetStub({ firstStatus: 404, body: { error: 'Not found' } })
    const client = new ServiceCalendarClient()
    const result = await withTenant(() => client.getEventType('missing'))
    expect(result).toBeNull()
  })

  it('getEventTypeByName → GET /api/v1/event-types?name=Sitzung', async () => {
    const etBody = { id: 'et-2', name: 'Sitzung', color: '#00f', isSystem: false, createdAt: new Date().toISOString() }
    resetStub({ body: etBody })
    const client = new ServiceCalendarClient()
    await withTenant(() => client.getEventTypeByName('Sitzung'))
    expect(lastRequest!.method).toBe('GET')
    expect(lastRequest!.url).toContain('/api/v1/event-types')
    expect(lastRequest!.url).toContain('name=Sitzung')
  })

  it('getEventTypeByName returns null when leaf returns 404', async () => {
    resetStub({ firstStatus: 404, body: { error: 'Not found' } })
    const client = new ServiceCalendarClient()
    const result = await withTenant(() => client.getEventTypeByName('Unknown'))
    expect(result).toBeNull()
  })

  it('createEventType → POST /api/v1/event-types', async () => {
    const etBody = { id: 'et-new', name: 'Plenum', color: '#0f0', isSystem: false, createdAt: new Date().toISOString() }
    resetStub({ firstStatus: 201, body: etBody })
    const client = new ServiceCalendarClient()
    await withTenant(() => client.createEventType({ name: 'Plenum', color: '#0f0' }))
    expect(lastRequest!.method).toBe('POST')
    expect(lastRequest!.url).toBe('/api/v1/event-types')
    expect((lastRequest!.body as Record<string, unknown>).name).toBe('Plenum')
  })

  it('deleteEventType → DELETE /api/v1/event-types/et-1', async () => {
    resetStub({ body: {} })
    const client = new ServiceCalendarClient()
    await withTenant(() => client.deleteEventType('et-1'))
    expect(lastRequest!.method).toBe('DELETE')
    expect(lastRequest!.url).toBe('/api/v1/event-types/et-1')
  })

  it('getCommitteeCalendarSettings → GET /api/v1/committee-settings/c-1', async () => {
    const settingsBody = { committeeId: 'c-1', color: '#abc', updatedAt: new Date().toISOString() }
    resetStub({ body: settingsBody })
    const client = new ServiceCalendarClient()
    const result = await withTenant(() => client.getCommitteeCalendarSettings('c-1'))
    expect(lastRequest!.method).toBe('GET')
    expect(lastRequest!.url).toBe('/api/v1/committee-settings/c-1')
    expect(result!.committeeId).toBe('c-1')
  })

  it('getCommitteeCalendarSettings returns null when leaf returns 404', async () => {
    resetStub({ firstStatus: 404, body: { error: 'Not found' } })
    const client = new ServiceCalendarClient()
    const result = await withTenant(() => client.getCommitteeCalendarSettings('missing'))
    expect(result).toBeNull()
  })

  it('upsertCommitteeCalendarSettings → PUT /api/v1/committee-settings/c-1', async () => {
    const settingsBody = { committeeId: 'c-1', color: '#def', updatedAt: new Date().toISOString() }
    resetStub({ body: settingsBody })
    const client = new ServiceCalendarClient()
    const result = await withTenant(() => client.upsertCommitteeCalendarSettings('c-1', '#def'))
    expect(lastRequest!.method).toBe('PUT')
    expect(lastRequest!.url).toBe('/api/v1/committee-settings/c-1')
    expect((lastRequest!.body as Record<string, unknown>).color).toBe('#def')
    expect(result.committeeId).toBe('c-1')
  })

  it('listFailedCaldavSync → GET /api/v1/caldav/failed', async () => {
    resetStub({ body: { data: [] } })
    const client = new ServiceCalendarClient()
    const result = await withTenant(() => client.listFailedCaldavSync())
    expect(lastRequest!.method).toBe('GET')
    expect(lastRequest!.url).toBe('/api/v1/caldav/failed')
    expect(Array.isArray(result)).toBe(true)
  })
})
