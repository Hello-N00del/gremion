import { beforeEach, describe, expect, it, vi } from 'vitest'

// G-075 — verify the consumer route accepts the internal Bearer secret
// AND that the previous session-cookie path still works. The route still
// requires Role.Member for session-authenticated callers; the Bearer path
// short-circuits that role check because the caller (an in-process
// trusted producer holding the shared secret) is already vetted.

const { mockIsInternalBearerRequest, mockHasRole, mockExtract } = vi.hoisted(() => ({
  mockIsInternalBearerRequest: vi.fn(),
  mockHasRole: vi.fn(),
  mockExtract: vi.fn(),
}))

vi.mock('$lib/server/internal-fetch', () => ({
  isInternalBearerRequest: mockIsInternalBearerRequest,
}))

vi.mock('$lib/auth', () => ({
  hasRole: mockHasRole,
  Role: { Member: 'member' },
}))

vi.mock('$lib/server/calendar/calendar-automations', () => ({
  extractEventsFromMinutes: mockExtract,
}))

import { POST } from './+server'

type RouteEvent = Parameters<typeof POST>[0]

function makeEvent(opts: { user?: { roles: string[] } | null; bodyText: string }): RouteEvent {
  const request = new Request('http://stura.test/api/calendar/automations/minutes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: opts.bodyText }),
  })
  const locals = {
    auth: vi.fn(async () => (opts.user ? { user: opts.user } : null)),
  }
  return { request, locals } as unknown as RouteEvent
}

describe('POST /api/calendar/automations/minutes — G-075 Bearer path', () => {
  beforeEach(() => {
    mockIsInternalBearerRequest.mockReset()
    mockHasRole.mockReset()
    mockExtract.mockReset()
    mockExtract.mockReturnValue([])
  })

  it('200s on a trusted internal Bearer request without invoking locals.auth() or hasRole', async () => {
    mockIsInternalBearerRequest.mockReturnValue(true)
    const event = makeEvent({ user: null, bodyText: 'Nächstes Treffen: 14.05.2026' })
    const res = await POST(event)
    expect(res.status).toBe(200)
    // The session-auth path must NOT have been exercised — that's the
    // whole point of the Bearer short-circuit.
    expect(mockHasRole).not.toHaveBeenCalled()
    // The extractor must still be called with the body text.
    expect(mockExtract).toHaveBeenCalledOnce()
    expect(mockExtract.mock.calls[0][0]).toBe('Nächstes Treffen: 14.05.2026')
  })

  it('falls back to session-cookie auth when no Bearer header is supplied', async () => {
    mockIsInternalBearerRequest.mockReturnValue(false)
    mockHasRole.mockReturnValue(true)
    const event = makeEvent({ user: { roles: ['member'] }, bodyText: 'Notes' })
    const res = await POST(event)
    expect(res.status).toBe(200)
    expect(mockHasRole).toHaveBeenCalledOnce()
  })

  it('403s when neither Bearer nor a member session is supplied', async () => {
    mockIsInternalBearerRequest.mockReturnValue(false)
    mockHasRole.mockReturnValue(false)
    const event = makeEvent({ user: { roles: ['guest'] }, bodyText: 'Notes' })
    const res = await POST(event)
    expect(res.status).toBe(403)
  })

  it('403s when there is no session AND no Bearer (unauthenticated stranger)', async () => {
    mockIsInternalBearerRequest.mockReturnValue(false)
    const event = makeEvent({ user: null, bodyText: 'Notes' })
    const res = await POST(event)
    expect(res.status).toBe(403)
    expect(mockHasRole).not.toHaveBeenCalled()
  })
})
