// Calendar: PATCH refuses an end before the start with 400 and a German
// message. When the body names only one side, it is compared with the stored
// other side. A series edit that names an occurrence of the series is not a
// move and must keep working (see occurrence-patch.test.ts).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Role } from '$lib/auth'

const { backend } = vi.hoisted(() => ({
  backend: {
    kind: 'inprocess' as const,
    getEvent: vi.fn(),
    updateEvent: vi.fn(),
  },
}))

vi.mock('$lib/server/calendar/backend/resolve', () => ({
  resolveCalendarBackendOr503: () => backend,
}))
vi.mock('$lib/server/governance/org-units-db', () => ({
  getOrgUnitIdsForUser: async () => [],
}))

import { PATCH } from './+server'

const MESSAGE = 'Das Ende darf nicht vor dem Beginn liegen.'

function event(over: Record<string, unknown> = {}) {
  return {
    id: 'ev-1',
    title: 'Sitzung',
    description: null,
    location: null,
    allDay: false,
    createdBy: 'kc-creator',
    committeeIds: [],
    readOnly: false,
    startAt: new Date('2026-11-11T10:00:00.000Z'),
    endAt: new Date('2026-11-11T11:00:00.000Z'),
    recurrence: null,
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
  backend.updateEvent.mockImplementation(async (_id: string, input: object) => ({ ...event(), ...input }))
})

describe('PATCH /api/calendar/events/[id]: end before start', () => {
  it('refuses a body whose end is before its start', async () => {
    const res = await patch({ startAt: '2026-11-12T10:00:00.000Z', endAt: '2026-11-12T09:00:00.000Z' })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe(MESSAGE)
    expect(backend.updateEvent).not.toHaveBeenCalled()
  })

  it('refuses a new end that is before the stored start', async () => {
    const res = await patch({ endAt: '2026-11-11T09:00:00.000Z' })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe(MESSAGE)
    expect(backend.updateEvent).not.toHaveBeenCalled()
  })

  it('refuses a new start that is after the stored end', async () => {
    const res = await patch({ startAt: '2026-11-11T12:00:00.000Z' })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe(MESSAGE)
    expect(backend.updateEvent).not.toHaveBeenCalled()
  })

  it('accepts a valid move and an end equal to the start', async () => {
    expect((await patch({ startAt: '2026-11-12T10:00:00.000Z', endAt: '2026-11-12T11:00:00.000Z' })).status).toBe(200)
    expect((await patch({ endAt: '2026-11-11T10:00:00.000Z' })).status).toBe(200)
    expect(backend.updateEvent).toHaveBeenCalledTimes(2)
  })

  it('an edit without times is not blocked by stored data that is itself out of order', async () => {
    backend.getEvent.mockResolvedValue(
      event({ startAt: new Date('2026-11-11T12:00:00.000Z'), endAt: new Date('2026-11-11T11:00:00.000Z') }),
    )
    expect((await patch({ title: 'Neu' })).status).toBe(200)
  })

  it('a later occurrence of a series sent with only its start is still a series edit', async () => {
    backend.getEvent.mockResolvedValue(
      event({
        startAt: new Date('2026-01-05T17:00:00.000Z'),
        endAt: new Date('2026-01-05T18:00:00.000Z'),
        recurrence: { frequency: 'weekly', interval: 1, until: null, count: null, byday: null, exceptions: null },
      }),
    )
    const res = await patch({ title: 'Plenum (neu)', startAt: '2026-04-13T16:00:00.000Z' })
    expect(res.status).toBe(200)
    const input = backend.updateEvent.mock.calls[0]![1] as { startAt?: Date }
    expect(input.startAt).toBeUndefined()
  })
})
