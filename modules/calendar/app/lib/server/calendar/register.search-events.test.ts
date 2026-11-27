// The calendar's 'calendar:search-events' provider: what the kernel's command palette asks for.
// Events whose title or day (DD.MM.YYYY, YYYY-MM-DD) contains the query, the nearest to today first (what is coming up, then what just
// was), one row per series (its next occurrence), at most `limit`, read from a window around today.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DbEvent, DbRecurrence } from './backend/port'

type SearchProvider = (q: { query: string; limit: number }) => Promise<Array<{ id: string; title: string; startAt: Date; allDay: boolean }>>

const h = vi.hoisted(() => ({
  providers: new Map<string, unknown>(),
  listEvents: vi.fn(),
}))

vi.mock('$lib/server/modules/runtime-registry', () => ({
  registerServerInitHook: vi.fn(),
  registerErasureHook: vi.fn(),
  registerDataProvider: vi.fn((key: string, fn: unknown) => {
    h.providers.set(key, fn)
  }),
}))
vi.mock('./notification-scheduler', () => ({ startNotificationScheduler: vi.fn() }))
vi.mock('./caldav-sync', () => ({ startCalDavSyncWorker: vi.fn() }))
vi.mock('./backend', () => ({ getCalendarBackend: () => ({ listEvents: h.listEvents }) }))
vi.mock('$lib/server/ports/tracer', () => ({ makeLogTracer: vi.fn(), noopTracer: {} }))
vi.mock('$lib/server/env/platform-env', () => ({ platformEnv: vi.fn() }))
vi.mock('$lib/server/events/calendar-audit-consumer', () => ({
  startCalendarAuditConsumer: vi.fn(),
  CALENDAR_AUDIT_WORKER: 'calendar-audit',
}))
vi.mock('$lib/server/events/consumer-state', () => ({ superviseWorker: vi.fn(), markWorkerOff: vi.fn() }))

await import('./register.server')

const NOW = new Date('2026-06-10T09:00:00Z')

function ev(over: Partial<DbEvent> & { id: string; title: string; startAt: Date }, recurrence: DbRecurrence | null = null): DbEvent {
  return {
    endAt: new Date(over.startAt.getTime() + 3_600_000),
    description: null,
    location: null,
    allDay: false,
    eventTypeId: null,
    eventTypeColor: null,
    eventTypeName: null,
    isMultiCommittee: false,
    createdBy: 'u',
    source: 'manual',
    externalId: null,
    caldavUid: null,
    caldavSyncedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    committeeIds: [],
    colour: { primary: '#000', secondary: '#111' },
    readOnly: false,
    recurrence,
    ...over,
  } as DbEvent
}

const weekly: DbRecurrence = { frequency: 'weekly', interval: 1, until: null, count: null, byday: null, exceptions: null }

function provider(): SearchProvider {
  const p = h.providers.get('calendar:search-events')
  expect(p, 'the calendar registers calendar:search-events').toBeTypeOf('function')
  return p as SearchProvider
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  h.listEvents.mockReset()
})
afterEach(() => vi.useRealTimers())

describe("calendar 'calendar:search-events' provider", () => {
  it('reads a window from 90 days back to 400 days ahead', async () => {
    h.listEvents.mockResolvedValueOnce([])
    await provider()({ query: 'plenum', limit: 5 })
    const filter = h.listEvents.mock.calls[0]![0] as { from: Date; to: Date }
    expect(filter.from.toISOString()).toBe('2026-03-12T09:00:00.000Z')
    expect(filter.to.toISOString()).toBe('2027-07-15T09:00:00.000Z')
  })

  it('keeps the events whose title contains the query, ignoring case and diacritics, and nothing else', async () => {
    h.listEvents.mockResolvedValueOnce([
      ev({ id: 'a', title: 'Plenum Juni', startAt: new Date('2026-06-20T17:00:00Z') }),
      ev({ id: 'b', title: 'Fachschaftsrat Übergabe', startAt: new Date('2026-06-21T17:00:00Z') }),
      ev({ id: 'c', title: 'Sitzung', location: 'Plenum-Raum', description: 'plenum', startAt: new Date('2026-06-22T17:00:00Z') }),
    ])
    expect((await provider()({ query: 'PLENUM', limit: 5 })).map((r) => r.id)).toEqual(['a'])
    h.listEvents.mockResolvedValueOnce([ev({ id: 'b', title: 'Fachschaftsrat Übergabe', startAt: new Date('2026-06-21T17:00:00Z') })])
    expect((await provider()({ query: 'ubergabe', limit: 5 })).map((r) => r.id)).toEqual(['b'])
  })

  it('finds an event by its day, typed as DD.MM.YYYY or YYYY-MM-DD, counted in Europe/Berlin', async () => {
    const rows = () => [
      ev({ id: 'a', title: 'Plenum', startAt: new Date('2026-06-20T17:00:00Z') }),
      // 22:30 UTC is 00:30 the next day in Berlin (summer time)
      ev({ id: 'late', title: 'Spaetsitzung', startAt: new Date('2026-06-20T22:30:00Z') }),
      ev({ id: 'c', title: 'Sprechstunde', startAt: new Date('2026-07-02T09:00:00Z') }),
    ]
    for (const [query, expected] of [
      ['20.06.2026', ['a']],
      ['2026-06-20', ['a']],
      ['21.06.2026', ['late']],
      ['2026-06-21', ['late']],
      ['02.07.2026', ['c']],
      ['22.06.2026', []],
    ] as const) {
      h.listEvents.mockResolvedValueOnce(rows())
      expect((await provider()({ query, limit: 5 })).map((r) => r.id), query).toEqual(expected)
    }
  })

  it('lists what is coming up first (soonest first), then what has passed (most recent first)', async () => {
    h.listEvents.mockResolvedValueOnce([
      ev({ id: 'old', title: 'Plenum alt', startAt: new Date('2026-04-01T17:00:00Z') }),
      ev({ id: 'later', title: 'Plenum spaet', startAt: new Date('2026-09-01T17:00:00Z') }),
      ev({ id: 'recent', title: 'Plenum neulich', startAt: new Date('2026-06-01T17:00:00Z') }),
      ev({ id: 'soon', title: 'Plenum bald', startAt: new Date('2026-06-12T17:00:00Z') }),
    ])
    expect((await provider()({ query: 'plenum', limit: 10 })).map((r) => r.id)).toEqual(['soon', 'later', 'recent', 'old'])
  })

  it('returns at most `limit` rows', async () => {
    h.listEvents.mockResolvedValueOnce(
      Array.from({ length: 8 }, (_, i) => ev({ id: `e${i}`, title: `Plenum ${i}`, startAt: new Date(Date.UTC(2026, 6, 1 + i, 17)) })),
    )
    expect(await provider()({ query: 'plenum', limit: 3 })).toHaveLength(3)
  })

  it('a weekly series is one row, its next occurrence', async () => {
    h.listEvents.mockResolvedValueOnce([
      ev({ id: 'series', title: 'Plenum woechentlich', startAt: new Date('2026-01-05T17:00:00Z'), endAt: new Date('2026-01-05T18:00:00Z') }, weekly),
    ])
    const rows = await provider()({ query: 'plenum', limit: 5 })
    expect(rows.map((r) => [r.id, r.startAt.toISOString()])).toEqual([['series', '2026-06-15T16:00:00.000Z']])
  })

  it('hands back only id, title, start and the all-day flag', async () => {
    h.listEvents.mockResolvedValueOnce([
      ev({ id: 'a', title: 'Plenum', allDay: true, description: 'geheim', location: 'Raum 1', startAt: new Date('2026-06-20T00:00:00Z') }),
    ])
    expect(await provider()({ query: 'plenum', limit: 5 })).toEqual([
      { id: 'a', title: 'Plenum', startAt: new Date('2026-06-20T00:00:00Z'), allDay: true },
    ])
  })

  it('a failing calendar read is not hidden as "no events": the caller logs it and degrades', async () => {
    h.listEvents.mockRejectedValueOnce(new Error('calendar database down'))
    await expect(provider()({ query: 'plenum', limit: 5 })).rejects.toThrow('calendar database down')
  })
})
