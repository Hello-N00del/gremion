// gremion-ui/src/lib/server/calendar/backend/service-client.ts
// Task 3 — HTTP ACL client: implements CalendarBackendPort over the
// calendar leaf service (CALENDAR_SERVICE_URL).
//
// Retry policy: ONE retry on idempotent GET/HEAD requests only (not on
// POST/PUT/PATCH/DELETE). Retry only on network errors or 503 responses.
// Timeout: 5000ms per attempt.
//
// Mirrors the pattern established in newsletter/backend/service-client.ts.

import { getTenant } from '$lib/server/tenant/context'
import { noopTracer, type TracerPort } from '@gremion/ports/tracer'
import type {
  CalendarBackendPort,
  DbEvent,
  DbEventType,
  DbCommitteeCalendarSettings,
  DbCalDavQueueEntry,
  CreateEventInput,
  UpdateEventInput,
  ListEventsFilter,
  EventSource,
} from './port'

// ── Error class ───────────────────────────────────────────────────────────────

/**
 * Thrown when the calendar leaf returns a non-2xx response. `status` mirrors
 * the HTTP status code so callers can map it to SvelteKit errors / Responses.
 */
export class CalendarServiceError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(`[calendar-service-client] Leaf returned ${status}: ${message}`)
    this.name = 'CalendarServiceError'
    this.status = status
  }
}

// ── Config ────────────────────────────────────────────────────────────────────

export interface ServiceCalendarClientOptions {
  /** Optional correlation-id forwarded as x-correlation-id to the leaf. */
  correlationId?: string
  /** Optional TracerPort for span emission. Defaults to noopTracer. */
  tracer?: TracerPort
  /** Optional injectable fetch implementation (for testing). Defaults to globalThis.fetch. */
  fetchImpl?: typeof globalThis.fetch
}

const REQUEST_TIMEOUT_MS = 5000
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

// ── Internal helpers ──────────────────────────────────────────────────────────

function resolveServiceUrl(): string {
  const url = process.env.CALENDAR_SERVICE_URL
  if (!url) {
    throw new Error(
      '[calendar-service-client] CALENDAR_SERVICE_URL is not set. ' +
        "Configure it to point to the calendar leaf service (e.g. 'http://calendar-service:3002')."
    )
  }
  return url.replace(/\/$/, '')
}

function resolveSecret(): string {
  const secret = process.env.INTERNAL_CALENDAR_SECRET
  if (!secret) {
    throw new Error(
      '[calendar-service-client] INTERNAL_CALENDAR_SECRET is not set. ' +
        'The calendar leaf requires this shared secret in x-internal-auth.'
    )
  }
  return secret
}

// ── Date deserialization ──────────────────────────────────────────────────────
// The leaf returns ISO strings; we coerce them back to Date objects so callers
// get the same DbEvent shape as the inprocess client.

function toDate(v: string | null | undefined): Date | null {
  if (!v) return null
  return new Date(v)
}

function deserializeEvent(raw: Record<string, unknown>): DbEvent {
  return {
    id: raw.id as string,
    title: raw.title as string,
    description: (raw.description as string | null) ?? null,
    location: (raw.location as string | null) ?? null,
    startAt: new Date(raw.startAt as string),
    endAt: new Date(raw.endAt as string),
    allDay: raw.allDay as boolean,
    eventTypeId: (raw.eventTypeId as string | null) ?? null,
    eventTypeColor: (raw.eventTypeColor as string | null) ?? null,
    eventTypeName: (raw.eventTypeName as string | null) ?? null,
    isMultiCommittee: raw.isMultiCommittee as boolean,
    createdBy: raw.createdBy as string,
    source: raw.source as DbEvent['source'],
    externalId: (raw.externalId as string | null) ?? null,
    caldavUid: (raw.caldavUid as string | null) ?? null,
    caldavSyncedAt: toDate(raw.caldavSyncedAt as string | null),
    createdAt: new Date(raw.createdAt as string),
    updatedAt: new Date(raw.updatedAt as string),
    committeeIds: (raw.committeeIds as string[]) ?? [],
    recurrence: (raw.recurrence as DbEvent['recurrence']) ?? null,
    colour: (raw.colour as { primary: string; secondary: string }) ?? {
      primary: '#888',
      secondary: '#ccc',
    },
    readOnly: (raw.readOnly as boolean) ?? false,
  }
}

function deserializeEventType(raw: Record<string, unknown>): DbEventType {
  return {
    id: raw.id as string,
    name: raw.name as string,
    color: raw.color as string,
    isSystem: raw.isSystem as boolean,
    createdAt: new Date(raw.createdAt as string),
  }
}

function deserializeCommitteeSettings(raw: Record<string, unknown>): DbCommitteeCalendarSettings {
  return {
    committeeId: raw.committeeId as string,
    color: raw.color as string,
    updatedAt: new Date(raw.updatedAt as string),
  }
}

function deserializeCaldavQueueEntry(raw: Record<string, unknown>): DbCalDavQueueEntry {
  return {
    id: raw.id as string,
    eventId: (raw.eventId as string | null) ?? null,
    caldavUid: raw.caldavUid as string,
    operation: raw.operation as DbCalDavQueueEntry['operation'],
    attempts: raw.attempts as number,
    lastError: (raw.lastError as string | null) ?? null,
    createdAt: new Date(raw.createdAt as string),
  }
}

// ── ServiceCalendarClient ─────────────────────────────────────────────────────

export class ServiceCalendarClient implements CalendarBackendPort {
  readonly kind = 'service' as const

  private readonly correlationId: string | undefined
  private readonly tracer: TracerPort
  private readonly fetchImpl: typeof globalThis.fetch

  constructor(opts: ServiceCalendarClientOptions = {}) {
    this.correlationId = opts.correlationId
    this.tracer = opts.tracer ?? noopTracer
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch
  }

  // ── Core fetch with retry ─────────────────────────────────────────────────

  private buildHeaders(): Record<string, string> {
    const secret = resolveSecret()
    const tenant = getTenant()
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-internal-auth': secret,
      'x-tenant-id': tenant.id,
      'x-tenant-slug': tenant.slug,
    }
    if (this.correlationId) {
      headers['x-correlation-id'] = this.correlationId
    }
    return headers
  }

  private async doLeafFetch(
    method: string,
    path: string,
    body: unknown,
    headers: Record<string, string>
  ): Promise<unknown> {
    const baseUrl = resolveServiceUrl()
    const url = `${baseUrl}${path}`

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const res = await this.fetchImpl(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      })
      if (!res.ok) {
        let errMsg = `HTTP ${res.status}`
        try {
          const errBody = (await res.json()) as { error?: string }
          if (errBody.error) errMsg = errBody.error
        } catch {
          /* ignore JSON parse failure */
        }
        throw new CalendarServiceError(res.status, errMsg)
      }
      return res.json()
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Execute a leaf HTTP call wrapped in a 'calendar.acl.<op>' span.
   * Retries once on idempotent GET/HEAD methods for network errors or 503.
   */
  private async leafFetch(method: string, path: string, body?: unknown): Promise<unknown> {
    const headers = this.buildHeaders()
    const isIdempotent = IDEMPOTENT_METHODS.has(method.toUpperCase())
    const span = this.tracer.startSpan(`calendar.acl.${method} ${path}`, {
      correlationId: this.correlationId ?? 'none',
    })

    try {
      let result: unknown
      try {
        result = await this.doLeafFetch(method, path, body, headers)
      } catch (err) {
        // ONE retry on idempotent methods only, for network errors or 503
        if (isIdempotent && (!(err instanceof CalendarServiceError) || err.status === 503)) {
          result = await this.doLeafFetch(method, path, body, headers)
        } else {
          throw err
        }
      }
      span.end()
      return result
    } catch (err) {
      span.end(err)
      throw err
    }
  }

  // ── Events ────────────────────────────────────────────────────────────────

  async listEvents(filter?: ListEventsFilter): Promise<DbEvent[]> {
    const params = new URLSearchParams()
    if (filter?.from) params.set('from', filter.from.toISOString())
    if (filter?.to) params.set('to', filter.to.toISOString())
    if (filter?.committeeId) params.set('committeeId', filter.committeeId)
    if (filter?.eventTypeId) params.set('eventTypeId', filter.eventTypeId)
    const qs = params.toString()
    const path = qs ? `/api/v1/events?${qs}` : '/api/v1/events'
    const res = (await this.leafFetch('GET', path)) as { data: Record<string, unknown>[] }
    return (res.data ?? []).map(deserializeEvent)
  }

  async getEvent(id: string): Promise<DbEvent | null> {
    try {
      const res = (await this.leafFetch('GET', `/api/v1/events/${id}`)) as Record<string, unknown>
      return deserializeEvent(res)
    } catch (err) {
      if (err instanceof CalendarServiceError && err.status === 404) return null
      throw err
    }
  }

  async createEvent(input: CreateEventInput): Promise<DbEvent> {
    const res = (await this.leafFetch('POST', '/api/v1/events', input)) as Record<string, unknown>
    return deserializeEvent(res)
  }

  async updateEvent(id: string, input: UpdateEventInput): Promise<DbEvent> {
    const res = (await this.leafFetch('PATCH', `/api/v1/events/${id}`, input)) as Record<
      string,
      unknown
    >
    return deserializeEvent(res)
  }

  async deleteEvent(id: string): Promise<string | null> {
    const res = (await this.leafFetch('DELETE', `/api/v1/events/${id}`)) as {
      caldavUid?: string | null
    }
    return res.caldavUid ?? null
  }

  async deleteEventsByExternalId(source: EventSource, externalId: string): Promise<void> {
    await this.leafFetch('DELETE', `/api/v1/events/by-external/${source}/${externalId}`)
  }

  async findEventByExternalId(source: EventSource, externalId: string): Promise<DbEvent | null> {
    try {
      const res = (await this.leafFetch(
        'GET',
        `/api/v1/events/by-external/${encodeURIComponent(source)}/${encodeURIComponent(externalId)}`
      )) as Record<string, unknown>
      return deserializeEvent(res)
    } catch (err) {
      if (err instanceof CalendarServiceError && err.status === 404) return null
      throw err
    }
  }

  // ── Event types ───────────────────────────────────────────────────────────

  async listEventTypes(): Promise<DbEventType[]> {
    const res = (await this.leafFetch('GET', '/api/v1/event-types')) as {
      data: Record<string, unknown>[]
    }
    return (res.data ?? []).map(deserializeEventType)
  }

  async getEventType(id: string): Promise<DbEventType | null> {
    try {
      const res = (await this.leafFetch('GET', `/api/v1/event-types/${id}`)) as Record<
        string,
        unknown
      >
      return deserializeEventType(res)
    } catch (err) {
      if (err instanceof CalendarServiceError && err.status === 404) return null
      throw err
    }
  }

  async getEventTypeByName(name: string): Promise<DbEventType | null> {
    const params = new URLSearchParams({ name })
    try {
      const res = (await this.leafFetch('GET', `/api/v1/event-types?${params.toString()}`)) as Record<
        string,
        unknown
      >
      return deserializeEventType(res)
    } catch (err) {
      if (err instanceof CalendarServiceError && err.status === 404) return null
      throw err
    }
  }

  async createEventType(input: { name: string; color: string }): Promise<DbEventType> {
    const res = (await this.leafFetch('POST', '/api/v1/event-types', input)) as Record<
      string,
      unknown
    >
    return deserializeEventType(res)
  }

  async deleteEventType(id: string): Promise<void> {
    await this.leafFetch('DELETE', `/api/v1/event-types/${id}`)
  }

  // ── Committee colour settings ─────────────────────────────────────────────

  async getCommitteeCalendarSettings(
    committeeId: string
  ): Promise<DbCommitteeCalendarSettings | null> {
    try {
      const res = (await this.leafFetch(
        'GET',
        `/api/v1/committee-settings/${committeeId}`
      )) as Record<string, unknown>
      return deserializeCommitteeSettings(res)
    } catch (err) {
      if (err instanceof CalendarServiceError && err.status === 404) return null
      throw err
    }
  }

  async upsertCommitteeCalendarSettings(
    committeeId: string,
    color: string
  ): Promise<DbCommitteeCalendarSettings> {
    const res = (await this.leafFetch('PUT', `/api/v1/committee-settings/${committeeId}`, {
      color,
    })) as Record<string, unknown>
    return deserializeCommitteeSettings(res)
  }

  // ── CalDAV queue admin reads ──────────────────────────────────────────────

  async listFailedCaldavSync(): Promise<DbCalDavQueueEntry[]> {
    const res = (await this.leafFetch('GET', '/api/v1/caldav/failed')) as {
      data: Record<string, unknown>[]
    }
    return (res.data ?? []).map(deserializeCaldavQueueEntry)
  }
}
