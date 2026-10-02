// F1-FIX-08 acceptance 6 (S1c#12): a weekly event queried in a later window is
// returned. The backend now includes recurring masters that started before the
// window; the API expands them into the window's occurrences.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Role } from '$lib/auth'

const { backend } = vi.hoisted(() => ({
  backend: { kind: 'inprocess' as const, listEvents: vi.fn() },
}))

vi.mock('$lib/server/calendar/backend/resolve', () => ({
  resolveCalendarBackendOr503: () => backend,
}))
vi.mock('$lib/server/governance/org-units-db', () => ({
  getOrgUnitIdsForUser: async () => [],
}))

import { GET } from './+server'

const master = {
  id: 'weekly-1',
  title: 'Plenum',
  description: null,
  location: null,
  startAt: new Date('2026-01-05T17:00:00Z'),
  endAt: new Date('2026-01-05T18:00:00Z'),
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
  recurrence: { frequency: 'weekly', interval: 1, until: null, count: null, byday: null, exceptions: null },
  colour: { primary: '#000', secondary: '#111' },
  readOnly: false,
}

beforeEach(() => {
  vi.clearAllMocks()
  backend.listEvents.mockResolvedValue([master])
})

describe('GET /api/calendar/events — recurring events (S1c#12)', () => {
  it('returns the occurrences of a weekly event created months earlier', async () => {
    const url = new URL('http://x/api/calendar/events?from=2026-04-01T00:00:00.000Z&to=2026-04-15T00:00:00.000Z')
    // @ts-expect-error partial RequestEvent
    const res = await GET({ url, locals: { auth: async () => ({ user: { id: 'kc', roles: [Role.Member] } }) } })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: Array<{ id: string; startAt: string }> }
    expect(body.data.map((e) => e.startAt)).toEqual(['2026-04-06T16:00:00.000Z', '2026-04-13T16:00:00.000Z'])
    expect(body.data.every((e) => e.id === 'weekly-1')).toBe(true)
  })
})
