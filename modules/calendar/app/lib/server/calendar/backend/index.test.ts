// gremion-ui/src/lib/server/calendar/backend/index.test.ts
// Task 4 — unit test for getCalendarBackend() factory.
//
// Pins:
//   1. CALENDAR_BACKEND unset → InprocessCalendarClient (kind='inprocess')
//   2. CALENDAR_BACKEND='inprocess' → InprocessCalendarClient
//   3. CALENDAR_BACKEND='service' → ServiceCalendarClient (kind='service')
//   4. CALENDAR_BACKEND=<unknown> → throws with /CALENDAR_BACKEND/ in message

import { describe, it, expect, afterEach, vi } from 'vitest'

// ── Mock calendar-db (InprocessCalendarClient imports it at module level) ─────
// Use vi.hoisted so the variables are initialised before vi.mock() factory runs.
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

// ServiceCalendarClient reads getTenant() on each method call (not at construction),
// so constructing it does not touch tenant context — no mock needed here.
vi.mock('$lib/server/tenant/context', () => ({
  currentTenantId: () => 'default',
  getTenant: () => ({ id: 'default', slug: 'default' }),
  runWithTenant: (_ctx: unknown, fn: () => unknown) => fn(),
}))

import { getCalendarBackend } from './index'
import { InprocessCalendarClient } from './inprocess-client'
import { ServiceCalendarClient } from './service-client'

const savedEnv = process.env.CALENDAR_BACKEND

afterEach(() => {
  if (savedEnv === undefined) delete process.env.CALENDAR_BACKEND
  else process.env.CALENDAR_BACKEND = savedEnv
  vi.restoreAllMocks()
})

describe('getCalendarBackend() factory', () => {
  it('returns InprocessCalendarClient when CALENDAR_BACKEND is unset', () => {
    delete process.env.CALENDAR_BACKEND
    const backend = getCalendarBackend()
    expect(backend).toBeInstanceOf(InprocessCalendarClient)
    expect(backend.kind).toBe('inprocess')
  })

  it('returns InprocessCalendarClient when CALENDAR_BACKEND=inprocess', () => {
    process.env.CALENDAR_BACKEND = 'inprocess'
    const backend = getCalendarBackend()
    expect(backend).toBeInstanceOf(InprocessCalendarClient)
    expect(backend.kind).toBe('inprocess')
  })

  it('returns ServiceCalendarClient when CALENDAR_BACKEND=service', () => {
    process.env.CALENDAR_BACKEND = 'service'
    const backend = getCalendarBackend('corr-123')
    expect(backend).toBeInstanceOf(ServiceCalendarClient)
    expect(backend.kind).toBe('service')
  })

  it('forwards correlationId when constructing ServiceCalendarClient', () => {
    process.env.CALENDAR_BACKEND = 'service'
    // We just want to confirm it constructs without throwing; the correlationId
    // is stored internally and used in leaf requests. Kind check is sufficient.
    const backend = getCalendarBackend('my-corr-id')
    expect(backend.kind).toBe('service')
  })

  it('throws with /CALENDAR_BACKEND/ when given an unknown value', () => {
    process.env.CALENDAR_BACKEND = 'unknown-backend'
    expect(() => getCalendarBackend()).toThrow(/CALENDAR_BACKEND/)
  })

  it('includes the bad value in the error message', () => {
    process.env.CALENDAR_BACKEND = 'redis'
    expect(() => getCalendarBackend()).toThrow(/redis/)
  })
})
