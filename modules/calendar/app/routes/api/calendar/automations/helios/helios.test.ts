import { beforeEach, describe, expect, it, vi } from 'vitest'

// F1-FIX-03 / S3#4 + S3#30: any Member could POST here and create undeletable
// read-only calendar events, or replace another election's events (the route
// deletes the previous events of the named electionId first). Election
// scheduling is a CouncilAdmin action; there is no internal producer of this
// endpoint, so the internal Bearer is not accepted either.

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }))
vi.mock('$lib/server/calendar/calendar-automations', () => ({ createHeliosCalendarEvents: mockCreate }))

import { POST } from './+server'
import { Role } from '$lib/auth'

type RouteEvent = Parameters<typeof POST>[0]

const BODY = {
  electionId: '0b7f6c1e-2a3d-4e5f-8a9b-1c2d3e4f5a6b',
  name: 'Wahl zum StuRa',
  votingStartsAt: '2026-11-02T08:00:00.000Z',
  votingEndsAt: '2026-11-06T16:00:00.000Z',
}

function makeEvent(user: { id: string; roles: string[] } | null, headers: Record<string, string> = {}): RouteEvent {
  const request = new Request('http://stura.test/api/calendar/automations/helios', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(BODY),
  })
  return { request, locals: { auth: vi.fn(async () => (user ? { user } : null)) } } as unknown as RouteEvent
}

beforeEach(() => {
  mockCreate.mockReset()
  mockCreate.mockResolvedValue(undefined)
})

describe('POST /api/calendar/automations/helios — CouncilAdmin only (S3#4, S3#30)', () => {
  it('a Member who is not a CouncilAdmin gets 403 and no event is written', async () => {
    const res = await POST(makeEvent({ id: 'u-m', roles: [Role.Member] }))
    expect(res.status).toBe(403)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('a Finance user (not a CouncilAdmin) gets 403', async () => {
    const res = await POST(makeEvent({ id: 'u-f', roles: [Role.Member, Role.Finance] }))
    expect(res.status).toBe(403)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('no session gets 403, even with an Authorization header', async () => {
    const res = await POST(makeEvent(null, { Authorization: 'Bearer whatever' }))
    expect(res.status).toBe(403)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('a CouncilAdmin creates the election events as themselves', async () => {
    const res = await POST(makeEvent({ id: 'u-a', roles: [Role.CouncilAdmin] }))
    expect(res.status).toBe(200)
    expect(mockCreate).toHaveBeenCalledOnce()
    expect(mockCreate.mock.calls[0][0]).toMatchObject({ electionId: BODY.electionId, createdBy: 'u-a' })
  })
})
