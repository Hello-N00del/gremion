// F1-FIX-08 round 2: the dashboard 'calendar:upcoming-events' provider expands
// recurring series (S1c#12). Every occurrence keeps the series id, and the
// dashboard renders `{#each upcoming as ev (ev.id)}`, so two occurrences of one
// weekly series inside the 30-day window threw Svelte's each_key_duplicate and
// crashed the dashboard for every user. The provider now yields one row per
// series: its next occurrence (like gremion-public getUpcomingPublicEvents).
import { describe, expect, it, vi } from 'vitest'
import type { DbEvent, DbRecurrence } from './backend/port'

const h = vi.hoisted(() => ({
  providers: new Map<string, (range: { from: Date; to: Date }) => Promise<unknown>>(),
  listEvents: vi.fn(),
}))

vi.mock('$lib/server/modules/runtime-registry', () => ({
  registerServerInitHook: vi.fn(),
  registerErasureHook: vi.fn(),
  registerDataProvider: vi.fn((key: string, fn: (range: { from: Date; to: Date }) => Promise<unknown>) => {
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

function ev(over: Partial<DbEvent> & { id: string; startAt: Date; endAt: Date }, recurrence: DbRecurrence | null = null): DbEvent {
  return {
    title: 'Plenum',
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
  }
}

const weekly: DbRecurrence = { frequency: 'weekly', interval: 1, until: null, count: null, byday: null, exceptions: null }

describe("dashboard 'calendar:upcoming-events' provider with a weekly series", () => {
  it('returns one row per series (its next occurrence), so the dashboard each key stays unique', async () => {
    // Monday 18:00 Berlin weekly since January; the 30-day window holds 4 Mondays.
    h.listEvents.mockResolvedValueOnce([
      ev({ id: 'series', startAt: new Date('2026-01-05T17:00:00Z'), endAt: new Date('2026-01-05T18:00:00Z') }, weekly),
      ev({ id: 'single', startAt: new Date('2026-04-08T10:00:00Z'), endAt: new Date('2026-04-08T11:00:00Z') }),
    ])
    const provider = h.providers.get('calendar:upcoming-events')!
    const rows = (await provider({
      from: new Date('2026-04-01T00:00:00Z'),
      to: new Date('2026-05-01T00:00:00Z'),
    })) as Array<{ id: string; startAt: Date }>

    const ids = rows.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(rows.map((r) => [r.id, r.startAt.toISOString()])).toEqual([
      ['series', '2026-04-06T16:00:00.000Z'],
      ['single', '2026-04-08T10:00:00.000Z'],
    ])
  })

  it('skips an occurrence that is already running and keeps the next one that starts in the window', async () => {
    h.listEvents.mockResolvedValueOnce([
      ev({ id: 'series', startAt: new Date('2026-01-05T17:00:00Z'), endAt: new Date('2026-01-05T18:00:00Z') }, weekly),
    ])
    const provider = h.providers.get('calendar:upcoming-events')!
    // 2026-04-06 16:30Z: the 16:00Z occurrence is still running.
    const rows = (await provider({
      from: new Date('2026-04-06T16:30:00Z'),
      to: new Date('2026-05-06T16:30:00Z'),
    })) as Array<{ id: string; startAt: Date }>

    expect(rows.map((r) => [r.id, r.startAt.toISOString()])).toEqual([['series', '2026-04-13T16:00:00.000Z']])
  })
})
