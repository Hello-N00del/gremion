// F1-FIX-08 round 2 (verifier MEDIUM): GET /api/calendar/events now returns the
// expanded occurrences of a recurring series, all carrying the series id. The
// Flutter client PATCHes the whole event it listed, startAt/endAt included, so
// editing the title of a LATER occurrence moved the series DTSTART to that
// occurrence and every earlier occurrence vanished.
// PATCH now translates: times that name an occurrence of the series are not a
// move (the other fields apply to the series); a time change on a recurring
// event without an explicit `recurrence` in the body is refused with 409.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Role } from '$lib/auth'

const { backend } = vi.hoisted(() => ({
  backend: {
    kind: 'inprocess' as const,
    getEvent: vi.fn(),
    updateEvent: vi.fn(),
    deleteEvent: vi.fn(),
    createEvent: vi.fn(),
    listEvents: vi.fn(),
  },
}))

vi.mock('$lib/server/calendar/backend/resolve', () => ({
  resolveCalendarBackendOr503: () => backend,
}))
vi.mock('$lib/server/governance/org-units-db', () => ({
  getOrgUnitIdsForUser: async () => [],
}))

import { PATCH } from './+server'

// Weekly, Monday 18:00 Berlin since 2026-01-05 (17:00Z in CET, 16:00Z in CEST).
const SERIES_START = '2026-01-05T17:00:00.000Z'
const SERIES_END = '2026-01-05T18:00:00.000Z'

function event(over: Record<string, unknown> = {}) {
  return {
    id: 'ev-1',
    title: 'Plenum',
    description: null,
    location: null,
    allDay: false,
    createdBy: 'kc-creator',
    committeeIds: [],
    readOnly: false,
    startAt: new Date(SERIES_START),
    endAt: new Date(SERIES_END),
    recurrence: { frequency: 'weekly', interval: 1, until: null, count: null, byday: null, exceptions: null },
    ...over,
  }
}

async function patch(body: unknown) {
  const request = new Request('http://x/api/calendar/events/ev-1', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  // @ts-expect-error partial RequestEvent
  return PATCH({ params: { id: 'ev-1' }, request, locals: { auth: async () => ({ user: { id: 'kc-creator', roles: [Role.Member] } }) } })
}

beforeEach(() => {
  vi.clearAllMocks()
  backend.getEvent.mockResolvedValue(event())
  backend.updateEvent.mockImplementation(async (_id: string, input: unknown) => ({ ...event(), ...(input as object) }))
})

describe('PATCH a recurring event with occurrence times (mobile edit of a listed occurrence)', () => {
  it('an edit that carries a later occurrence\'s own times applies to the series and does not move it', async () => {
    const res = await patch({ title: 'Plenum (neu)', startAt: '2026-04-13T16:00:00.000Z', endAt: '2026-04-13T17:00:00.000Z' })

    expect(res.status).toBe(200)
    expect(backend.updateEvent).toHaveBeenCalledOnce()
    const input = backend.updateEvent.mock.calls[0]![1] as { title?: string; startAt?: Date; endAt?: Date }
    expect(input.title).toBe('Plenum (neu)')
    expect(input.startAt).toBeUndefined()
    expect(input.endAt).toBeUndefined()
  })

  it('moving one occurrence of a series is refused with 409 (no silent move of the whole series)', async () => {
    const res = await patch({ title: 'Plenum', startAt: '2026-04-13T17:00:00.000Z', endAt: '2026-04-13T18:00:00.000Z' })

    expect(res.status).toBe(409)
    expect(backend.updateEvent).not.toHaveBeenCalled()
  })

  it('the series\' own times pass through unchanged', async () => {
    const res = await patch({ title: 'x', startAt: SERIES_START, endAt: SERIES_END })

    expect(res.status).toBe(200)
    const input = backend.updateEvent.mock.calls[0]![1] as { startAt?: Date }
    expect(input.startAt?.toISOString()).toBe(SERIES_START)
  })

  it('an explicit series edit (body carries recurrence) may move DTSTART', async () => {
    const res = await patch({
      startAt: '2026-01-06T17:00:00.000Z',
      endAt: '2026-01-06T18:00:00.000Z',
      recurrence: { frequency: 'weekly' },
    })

    expect(res.status).toBe(200)
    const input = backend.updateEvent.mock.calls[0]![1] as { startAt?: Date }
    expect(input.startAt?.toISOString()).toBe('2026-01-06T17:00:00.000Z')
  })

  it('a non-recurring event can still be moved', async () => {
    backend.getEvent.mockResolvedValue(event({ recurrence: null }))
    const res = await patch({ startAt: '2026-04-13T17:00:00.000Z', endAt: '2026-04-13T18:00:00.000Z' })

    expect(res.status).toBe(200)
    const input = backend.updateEvent.mock.calls[0]![1] as { startAt?: Date }
    expect(input.startAt?.toISOString()).toBe('2026-04-13T17:00:00.000Z')
  })
})
