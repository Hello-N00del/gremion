import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'

// calendar-automations.ts now routes through getCalendarBackend() (Task 6). With
// CALENDAR_BACKEND unset (default 'inprocess'), that resolves to an
// InprocessCalendarClient which delegates to calendar-db — mocking calendar-db
// still pins the same behavior transitively.
vi.mock('./calendar-db', () => ({
  createEvent: vi.fn().mockResolvedValue({ id: 'new-evt' }),
  deleteEventsByExternalId: vi.fn().mockResolvedValue(0),
  // A2: the holiday dedup now reads through the port's findEventByExternalId
  // (which the inprocess client delegates here) — NOT getDb. Default: no
  // existing row, so createEvent runs.
  findEventByExternalId: vi.fn().mockResolvedValue(null),
  listEventTypes: vi.fn().mockResolvedValue([
    { id: 'type-treffen', name: 'Treffen', color: '#3b82f6', isSystem: true, createdAt: new Date() },
    { id: 'type-frist', name: 'Frist', color: '#ef4444', isSystem: true, createdAt: new Date() },
    { id: 'type-wahl', name: 'Wahl', color: '#8b5cf6', isSystem: true, createdAt: new Date() },
    { id: 'type-feiertag', name: 'Feiertag', color: '#f59e0b', isSystem: true, createdAt: new Date() },
  ]),
}))

// getDb is a hoisted spy so a test can assert the holiday dedup NEVER touches
// it (A2: dedup must go through the port, not the kernel DB directly).
const { mockGetDb } = vi.hoisted(() => ({
  mockGetDb: vi.fn(() =>
    Object.assign((strings: TemplateStringsArray) => {
      void strings
      return Promise.resolve([] as unknown[])
    }, {}),
  ),
}))

vi.mock('../db', () => ({
  getDb: mockGetDb,
}))

import {
  createHeliosCalendarEvents,
  extractEventsFromMinutes,
  syncPublicHolidays,
} from './calendar-automations'
import { createEvent, deleteEventsByExternalId, findEventByExternalId } from './calendar-db'

describe('createHeliosCalendarEvents', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('creates one event per provided date and clears any previous entries', async () => {
    await createHeliosCalendarEvents({
      electionId: '11111111-1111-1111-1111-111111111111',
      name: 'Vorstandswahl',
      committeeId: null,
      nominationDeadline: new Date('2026-06-01T00:00:00Z'),
      votingStartsAt: new Date('2026-06-10T00:00:00Z'),
      votingEndsAt: new Date('2026-06-17T00:00:00Z'),
      resultsAt: new Date('2026-06-18T00:00:00Z'),
      createdBy: 'user-1',
    })

    expect(deleteEventsByExternalId).toHaveBeenCalledWith(
      'helios',
      '11111111-1111-1111-1111-111111111111',
    )
    expect(createEvent).toHaveBeenCalledTimes(4)
    const firstCall = vi.mocked(createEvent).mock.calls[0][0]
    expect(firstCall.source).toBe('helios')
    expect(firstCall.externalId).toBe('11111111-1111-1111-1111-111111111111')
    expect(firstCall.eventTypeId).toBe('type-frist')
  })

  it('skips dates that are null', async () => {
    await createHeliosCalendarEvents({
      electionId: '22222222-2222-2222-2222-222222222222',
      name: 'Wahl',
      committeeId: null,
      nominationDeadline: null,
      votingStartsAt: new Date('2026-06-10T00:00:00Z'),
      votingEndsAt: null,
      resultsAt: null,
      createdBy: 'user-1',
    })
    expect(createEvent).toHaveBeenCalledTimes(1)
  })
})

describe('extractEventsFromMinutes', () => {
  it('extracts a template field with date + time + location', () => {
    const text = 'Protokoll...\nNächstes Treffen: 15.06.2026 14:00 Raum 101\n'
    const result = extractEventsFromMinutes(text)
    expect(result).toHaveLength(1)
    expect(result[0].source).toBe('template')
    expect(result[0].title).toBe('Nächstes Treffen')
    expect(result[0].date.getUTCFullYear()).toBe(2026)
    expect(result[0].date.getUTCMonth()).toBe(5) // June = 5
    expect(result[0].location).toContain('Raum 101')
  })

  it('falls back to body-scanned numeric dates', () => {
    const text = 'Notizen — siehe 03.07.2026 für das nächste Event.'
    const result = extractEventsFromMinutes(text)
    expect(result.length).toBeGreaterThan(0)
    expect(result[0].source).toBe('body')
  })

  it('dedupes body matches that are within 5 minutes of a template match', () => {
    const text =
      'Nächstes Treffen: 15.06.2026 14:00 Raum 101\n' +
      'Erinnerung: siehe 15.06.2026 14:00\n'
    const result = extractEventsFromMinutes(text)
    // Both detect the same moment — only one should remain.
    expect(result).toHaveLength(1)
    expect(result[0].source).toBe('template')
  })

  it('returns an empty list when no dates are present', () => {
    expect(extractEventsFromMinutes('No dates here at all.')).toEqual([])
  })
})

describe('syncPublicHolidays', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterAll(() => {
    globalThis.fetch = originalFetch
  })

  function mockFetchOk(payload: unknown): void {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(payload),
    }) as unknown as typeof fetch
  }

  it('throws on non-2xx API response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve([]),
    }) as unknown as typeof fetch

    await expect(
      syncPublicHolidays({ countryCode: 'DE', subdivisionCode: 'DE', year: 2026 }),
    ).rejects.toThrow(/500/)
  })

  it('inserts each returned holiday once', async () => {
    mockFetchOk([
      {
        id: 'holiday-1',
        name: [{ language: 'DE', text: 'Tag der Arbeit' }],
        startDate: '2026-05-01',
        endDate: '2026-05-01',
      },
      {
        id: 'holiday-2',
        name: [{ language: 'DE', text: 'Tag der Deutschen Einheit' }],
        startDate: '2026-10-03',
        endDate: '2026-10-03',
      },
    ])

    await syncPublicHolidays({ countryCode: 'DE', subdivisionCode: 'DE', year: 2026 })

    expect(createEvent).toHaveBeenCalledTimes(2)
    const firstCall = vi.mocked(createEvent).mock.calls[0][0]
    expect(firstCall.source).toBe('holiday')
    expect(firstCall.allDay).toBe(true)
    expect(firstCall.title).toBe('Tag der Arbeit')
  })

  // ── A2: dedup goes through CalendarBackendPort.findEventByExternalId ──────────

  it('skips a holiday that already exists (dedup via the port, not getDb)', async () => {
    mockFetchOk([
      {
        id: 'holiday-1',
        name: [{ language: 'DE', text: 'Tag der Arbeit' }],
        startDate: '2026-05-01',
        endDate: '2026-05-01',
      },
    ])
    // The port reports the holiday already exists on the WRITE backend.
    vi.mocked(findEventByExternalId).mockResolvedValue({
      id: 'existing-evt',
      source: 'holiday',
      externalId: 'holiday-1',
    } as never)

    await syncPublicHolidays({ countryCode: 'DE', subdivisionCode: 'DE', year: 2026 })

    expect(findEventByExternalId).toHaveBeenCalledWith('holiday', 'holiday-1')
    expect(createEvent).not.toHaveBeenCalled()
  })

  it('reads the port for dedup — never getDb — so it is backend-correct in service mode', async () => {
    mockFetchOk([
      {
        id: 'holiday-9',
        name: [{ language: 'DE', text: 'Testtag' }],
        startDate: '2026-12-24',
        endDate: '2026-12-24',
      },
    ])
    // Port says "not present" → createEvent must run, and getDb is never consulted
    // (the old cross-DB dead-read is gone).
    vi.mocked(findEventByExternalId).mockResolvedValue(null)

    await syncPublicHolidays({ countryCode: 'DE', subdivisionCode: 'DE', year: 2026 })

    expect(createEvent).toHaveBeenCalledTimes(1)
    expect(mockGetDb).not.toHaveBeenCalled()
  })
})

