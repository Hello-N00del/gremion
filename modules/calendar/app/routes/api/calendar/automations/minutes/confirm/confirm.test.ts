import { beforeEach, describe, expect, it, vi } from 'vitest'

// F1-FIX-03 / S3#5: the protocol-publish flow commits the minutes' structured
// "Nächstes Treffen" event through this endpoint via internalFetch, so it
// accepts the trusted internal Bearer like its /minutes sibling. The internal
// caller names the acting user (createdBy); a session caller cannot.
//
// F1-FIX-03 round 2 (house review HIGH): the endpoint deletes and replaces
// every minutes event keyed on `minutesId`, which publish sets to the protocol
// id. A plain Member session could therefore wipe or overwrite the events a
// publish created. The session path is limited to CouncilAdmin, the same role
// that may publish a protocol.

const { mockIsInternalBearerRequest, created, deleted } = vi.hoisted(() => ({
  mockIsInternalBearerRequest: vi.fn(),
  created: [] as Array<Record<string, unknown>>,
  deleted: [] as Array<[string, string]>,
}))

vi.mock('$lib/server/internal-fetch', () => ({ isInternalBearerRequest: mockIsInternalBearerRequest }))
vi.mock('$lib/server/calendar/backend/resolve', () => ({
  resolveCalendarBackendOr503: () => ({
    deleteEventsByExternalId: vi.fn(async (source: string, externalId: string) => {
      deleted.push([source, externalId])
    }),
    listEventTypes: vi.fn(async () => []),
    createEvent: vi.fn(async (input: Record<string, unknown>) => {
      created.push(input)
      return { id: `ev-${created.length}` }
    }),
  }),
}))

import { POST } from './+server'
import { Role } from '$lib/auth'

type RouteEvent = Parameters<typeof POST>[0]

const EVENTS = [{ title: 'Nächstes Treffen', startAt: '2026-10-15T16:00:00.000Z', location: 'Raum 101' }]
const PROTOCOL_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7'

function makeEvent(opts: { user?: { id: string; roles: string[] } | null; body: Record<string, unknown> }): RouteEvent {
  const request = new Request('http://stura.test/api/calendar/automations/minutes/confirm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts.body),
  })
  const locals = { auth: vi.fn(async () => (opts.user ? { user: opts.user } : null)) }
  return { request, locals } as unknown as RouteEvent
}

beforeEach(() => {
  mockIsInternalBearerRequest.mockReset()
  created.length = 0
  deleted.length = 0
})

describe('POST /api/calendar/automations/minutes/confirm — internal Bearer (S3#5)', () => {
  it('the internal caller commits the events AS the named user, without a session', async () => {
    mockIsInternalBearerRequest.mockReturnValue(true)
    const event = makeEvent({ user: null, body: { minutesId: 'p-1', events: EVENTS, createdBy: 'u-admin' } })
    const res = await POST(event)
    expect(res.status).toBe(201)
    expect(created).toHaveLength(1)
    expect(created[0].createdBy).toBe('u-admin')
    expect(created[0].externalId).toBe('p-1')
    expect((event.locals as unknown as { auth: ReturnType<typeof vi.fn> }).auth).not.toHaveBeenCalled()
  })

  it('an internal caller that names no user is a 400 and creates nothing', async () => {
    mockIsInternalBearerRequest.mockReturnValue(true)
    const res = await POST(makeEvent({ user: null, body: { events: EVENTS } }))
    expect(res.status).toBe(400)
    expect(created).toEqual([])
  })

  it('an all-day event keeps allDay and its end', async () => {
    mockIsInternalBearerRequest.mockReturnValue(true)
    const res = await POST(
      makeEvent({
        user: null,
        body: {
          minutesId: PROTOCOL_ID,
          createdBy: 'u-admin',
          events: [
            {
              title: 'Nächstes Treffen',
              startAt: '2026-10-15T00:00:00.000Z',
              endAt: '2026-10-16T00:00:00.000Z',
              location: null,
              allDay: true,
            },
          ],
        },
      }),
    )
    expect(res.status).toBe(201)
    expect(created[0].allDay).toBe(true)
    expect((created[0].endAt as Date).toISOString()).toBe('2026-10-16T00:00:00.000Z')
  })
})

describe('POST /api/calendar/automations/minutes/confirm — session callers (round 2 house review HIGH)', () => {
  it('a plain Member cannot replace the minutes events a publish created: 403, nothing deleted or created', async () => {
    mockIsInternalBearerRequest.mockReturnValue(false)
    const res = await POST(
      makeEvent({
        user: { id: 'u-member', roles: [Role.Member] },
        body: { minutesId: PROTOCOL_ID, events: EVENTS },
      }),
    )
    expect(res.status).toBe(403)
    expect(deleted).toEqual([])
    expect(created).toEqual([])
  })

  it('a CouncilAdmin session commits; its createdBy is ignored: the event is always theirs', async () => {
    mockIsInternalBearerRequest.mockReturnValue(false)
    const res = await POST(
      makeEvent({
        user: { id: 'u-council', roles: [Role.Member, Role.CouncilAdmin] },
        body: { minutesId: PROTOCOL_ID, events: EVENTS, createdBy: 'u-someone-else' },
      }),
    )
    expect(res.status).toBe(201)
    expect(created[0].createdBy).toBe('u-council')
    expect(deleted).toEqual([['minutes', PROTOCOL_ID]])
  })

  it('no session and no internal Bearer is a 403', async () => {
    mockIsInternalBearerRequest.mockReturnValue(false)
    const res = await POST(makeEvent({ user: null, body: { events: EVENTS, createdBy: 'u-admin' } }))
    expect(res.status).toBe(403)
    expect(created).toEqual([])
  })
})
