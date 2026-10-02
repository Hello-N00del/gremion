// gremion-ui/src/lib/server/calendar/backend/resolve.test.ts
// Task 5 — graceful-503 contract for the calendar backend resolver.
//
// Pins:
//   1. resolveCalendarBackendOr503() → returns 503 Response on construction error
//   2. resolveCalendarBackendOr503() → does NOT throw on unknown backend
//   3. resolveCalendarBackendOr503() → returns InprocessCalendarClient when env unset
//   4. resolveCalendarBackendOr503() → returns InprocessCalendarClient when CALENDAR_BACKEND=inprocess
//   5. resolveCalendarBackendForPage() → throws SvelteKit error(503) on construction error
//   6. resolveCalendarBackendForPage() → returns InprocessCalendarClient when env unset

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Mock calendar-db so InprocessCalendarClient can be constructed without a real DB.
const { mockListEvents } = vi.hoisted(() => ({
  mockListEvents: vi.fn(),
}))

vi.mock('../calendar-db', () => ({
  listEvents: mockListEvents,
  getEvent: vi.fn(),
  createEvent: vi.fn(),
  updateEvent: vi.fn(),
  deleteEvent: vi.fn(),
  deleteEventsByExternalId: vi.fn(),
  listEventTypes: vi.fn(),
  getEventType: vi.fn(),
  getEventTypeByName: vi.fn(),
  createEventType: vi.fn(),
  deleteEventType: vi.fn(),
  getCommitteeCalendarSettings: vi.fn(),
  upsertCommitteeCalendarSettings: vi.fn(),
  listFailedCaldavSync: vi.fn(),
}))

// Stub tenant context so neither InprocessCalendarClient nor ServiceCalendarClient
// hits a real tenant store during construction.
vi.mock('$lib/server/tenant/context', () => ({
  currentTenantId: () => 'default',
  getTenant: () => ({ id: 'default', slug: 'default' }),
  runWithTenant: (_ctx: unknown, fn: () => unknown) => fn(),
}))

import {
  resolveCalendarBackendOr503,
  resolveCalendarBackendForPage,
} from './resolve'
import { InprocessCalendarClient } from './inprocess-client'

const savedEnv = process.env.CALENDAR_BACKEND

beforeEach(() => {
  // Silence the intentional console.error from the 503 mapping path.
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  if (savedEnv === undefined) delete process.env.CALENDAR_BACKEND
  else process.env.CALENDAR_BACKEND = savedEnv
  vi.restoreAllMocks()
})

describe('resolveCalendarBackendOr503 — unknown backend maps to graceful 503', () => {
  it('returns a 503 Response (with Retry-After) when CALENDAR_BACKEND=invalid-backend', () => {
    process.env.CALENDAR_BACKEND = 'invalid-backend'
    const result = resolveCalendarBackendOr503()
    expect(result).toBeInstanceOf(Response)
    const res = result as Response
    expect(res.status).toBe(503)
    expect(res.headers.get('Retry-After')).toBe('30')
  })

  it('does NOT throw for an unknown backend (no 500 / uncaught)', () => {
    process.env.CALENDAR_BACKEND = 'invalid-backend'
    expect(() => resolveCalendarBackendOr503()).not.toThrow()
  })

  it('default mode (env unset) returns an InprocessCalendarClient, not a Response', () => {
    delete process.env.CALENDAR_BACKEND
    const result = resolveCalendarBackendOr503()
    expect(result).not.toBeInstanceOf(Response)
    expect(result).toBeInstanceOf(InprocessCalendarClient)
  })

  it('inprocess mode returns an InprocessCalendarClient', () => {
    process.env.CALENDAR_BACKEND = 'inprocess'
    const result = resolveCalendarBackendOr503()
    expect(result).not.toBeInstanceOf(Response)
    expect(result).toBeInstanceOf(InprocessCalendarClient)
  })
})

describe('resolveCalendarBackendForPage — unknown backend throws error(503)', () => {
  it('throws a SvelteKit error with status 503 when CALENDAR_BACKEND=invalid-backend', () => {
    process.env.CALENDAR_BACKEND = 'invalid-backend'
    try {
      resolveCalendarBackendForPage()
      expect.unreachable('expected resolveCalendarBackendForPage to throw')
    } catch (err) {
      // SvelteKit error() throws an HttpError-shaped object: { status, body }.
      expect((err as { status?: number }).status).toBe(503)
    }
  })

  it('default mode (env unset) returns an InprocessCalendarClient', () => {
    delete process.env.CALENDAR_BACKEND
    expect(resolveCalendarBackendForPage()).toBeInstanceOf(InprocessCalendarClient)
  })
})
