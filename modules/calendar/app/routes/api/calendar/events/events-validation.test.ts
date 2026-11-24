// Calendar: an event whose end lies before its start is refused with 400 and a
// German message (POST here, PATCH in [id]/event-validation.test.ts). An end
// equal to the start stays valid: the dialog sends exactly that for an
// all-day event (start and end are both the one date).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Role } from '$lib/auth'

const { backend } = vi.hoisted(() => ({
  backend: {
    kind: 'inprocess' as const,
    createEvent: vi.fn(),
  },
}))

vi.mock('$lib/server/calendar/backend/resolve', () => ({
  resolveCalendarBackendOr503: () => backend,
}))
vi.mock('$lib/server/governance/org-units-db', () => ({
  getOrgUnitIdsForUser: async () => [],
}))

import { POST } from './+server'

async function post(body: unknown) {
  const request = new Request('http://x/api/calendar/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  // @ts-expect-error partial RequestEvent
  return POST({ request, locals: { auth: async () => ({ user: { id: 'kc-member', roles: [Role.Member] } }) } })
}

beforeEach(() => {
  vi.clearAllMocks()
  backend.createEvent.mockImplementation(async (input: object) => ({ id: 'ev-new', ...input }))
})

describe('POST /api/calendar/events: end before start', () => {
  it('refuses an end before the start with 400 and a German message, and stores nothing', async () => {
    const res = await post({
      title: 'Sitzung',
      startAt: '2026-11-11T10:00:00.000Z',
      endAt: '2026-11-11T09:00:00.000Z',
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { success: boolean; error: string }
    expect(body.success).toBe(false)
    expect(body.error).toBe('Das Ende darf nicht vor dem Beginn liegen.')
    expect(backend.createEvent).not.toHaveBeenCalled()
  })

  it('accepts an end after the start', async () => {
    const res = await post({
      title: 'Sitzung',
      startAt: '2026-11-11T10:00:00.000Z',
      endAt: '2026-11-11T11:00:00.000Z',
    })
    expect(res.status).toBe(201)
    expect(backend.createEvent).toHaveBeenCalledOnce()
  })

  it('accepts an end equal to the start (an all-day event is one date)', async () => {
    const res = await post({
      title: 'Tag der offenen Tür',
      allDay: true,
      startAt: '2026-11-11T00:00:00.000Z',
      endAt: '2026-11-11T00:00:00.000Z',
    })
    expect(res.status).toBe(201)
    expect(backend.createEvent).toHaveBeenCalledOnce()
  })
})
