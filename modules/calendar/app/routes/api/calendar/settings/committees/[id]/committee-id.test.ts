// committee_calendar_settings.committee_id is a uuid column. A route id that is
// not a UUID used to reach the driver, which refused it and the caller got a 500.
// A malformed id names nothing: 404, like a well-formed id nobody owns, before any
// query.
import { beforeEach, describe, expect, test, vi } from 'vitest'

const { mockGetSettings, mockUpsert } = vi.hoisted(() => ({ mockGetSettings: vi.fn(), mockUpsert: vi.fn() }))

vi.mock('$lib/auth', () => ({
  hasRole: () => true,
  Role: { Guest: 'guest', CouncilAdmin: 'council-admin' },
}))
vi.mock('$lib/server/calendar/backend/resolve', () => ({
  resolveCalendarBackendOr503: () => ({
    getCommitteeCalendarSettings: mockGetSettings,
    upsertCommitteeCalendarSettings: mockUpsert,
  }),
}))

import { GET, PATCH } from './+server'

const CID = '0b7c6f1e-4a8e-4c51-9f3a-2d1e8c7b6a50'
const BAD_IDS = ['not-a-uuid', '1', '..', 'x/../../lists']

function event(id: string, body?: unknown): Parameters<typeof GET>[0] {
  return {
    params: { id },
    locals: { auth: async () => ({ user: { roles: ['council-admin'], groups: [], id: 'u1' } }) },
    request: new Request('http://stura.test/api/calendar/settings/committees/x', {
      method: body === undefined ? 'GET' : 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  } as unknown as Parameters<typeof GET>[0]
}

beforeEach(() => {
  mockGetSettings.mockReset().mockResolvedValue({ committee_id: CID, color: '#112233' })
  mockUpsert.mockReset().mockResolvedValue({ committee_id: CID, color: '#112233' })
})

describe('/api/calendar/settings/committees/[id] with an id that is not a UUID', () => {
  test.each(BAD_IDS)('GET %s answers 404 before any query', async (id) => {
    const res = await GET(event(id))
    expect(res.status).toBe(404)
    expect(mockGetSettings).not.toHaveBeenCalled()
  })

  test.each(BAD_IDS)('PATCH %s answers 404 before any query', async (id) => {
    const res = await PATCH(event(id, { color: '#112233' }) as Parameters<typeof PATCH>[0])
    expect(res.status).toBe(404)
    expect(mockUpsert).not.toHaveBeenCalled()
  })

  test('a valid id still reaches the query', async () => {
    const res = await GET(event(CID))
    expect(res.status).toBe(200)
    expect(mockGetSettings).toHaveBeenCalledWith(CID)
  })
})
