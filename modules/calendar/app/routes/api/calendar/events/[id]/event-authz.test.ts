// F1-FIX-08 (S3#29): any Member could edit or delete ANY calendar event and
// flip isPublic, publishing another committee's internal meeting to the public
// portal. Mutations are now limited to the event's creator, members of one of
// its committees, or CouncilAdmin (and above); publishing (isPublic=true) and
// tagging a committee need CouncilAdmin or membership in that committee.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Role } from '$lib/auth'

const UNIT_A = '0f8fad5b-d9cb-469f-a165-70867728950e'
const UNIT_B = '7c9e6679-7425-40de-944b-e07fc1f90ae7'

const { backend, getOrgUnitIdsForUser } = vi.hoisted(() => ({
  backend: {
    kind: 'inprocess' as const,
    getEvent: vi.fn(),
    updateEvent: vi.fn(),
    deleteEvent: vi.fn(),
    createEvent: vi.fn(),
    listEvents: vi.fn(),
  },
  getOrgUnitIdsForUser: vi.fn(),
}))

vi.mock('$lib/server/calendar/backend/resolve', () => ({
  resolveCalendarBackendOr503: () => backend,
}))
vi.mock('$lib/server/governance/org-units-db', () => ({
  getOrgUnitIdsForUser: (id: string) => getOrgUnitIdsForUser(id),
}))

import { PATCH, DELETE } from './+server'
import { POST } from '../+server'

function event(over: Record<string, unknown> = {}) {
  return {
    id: 'ev-1',
    title: 'AStA-Sitzung',
    createdBy: 'kc-creator',
    committeeIds: [UNIT_A],
    readOnly: false,
    ...over,
  }
}

function locals(id: string, roles: Role[]) {
  return { auth: async () => ({ user: { id, roles } }) }
}

const JSON_HEADERS = { 'content-type': 'application/json' }

async function patch(userId: string, roles: Role[], body: unknown) {
  const request = new Request('http://x/api/calendar/events/ev-1', {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  })
  // @ts-expect-error partial RequestEvent
  return PATCH({ params: { id: 'ev-1' }, request, locals: locals(userId, roles) })
}
async function del(userId: string, roles: Role[]) {
  // @ts-expect-error partial RequestEvent
  return DELETE({ params: { id: 'ev-1' }, locals: locals(userId, roles) })
}
async function post(userId: string, roles: Role[], body: unknown) {
  const request = new Request('http://x/api/calendar/events', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  })
  // @ts-expect-error partial RequestEvent
  return POST({ request, locals: locals(userId, roles) })
}

const createBody = (over: Record<string, unknown> = {}) => ({
  title: 'Treffen',
  startAt: '2026-11-02T17:00:00.000Z',
  endAt: '2026-11-02T18:00:00.000Z',
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  backend.getEvent.mockResolvedValue(event())
  backend.updateEvent.mockImplementation(async (_id: string, input: unknown) => ({ ...event(), ...(input as object) }))
  backend.deleteEvent.mockResolvedValue(null)
  backend.createEvent.mockImplementation(async (input: unknown) => ({ id: 'new', ...(input as object) }))
  getOrgUnitIdsForUser.mockImplementation(async (id: string) => (id === 'kc-unit-a-member' ? [UNIT_A] : []))
})

describe('PATCH/DELETE /api/calendar/events/[id] — S3#29 authorisation', () => {
  it('a Member who is neither creator nor committee member gets 403 on PATCH, DELETE and isPublic=true', async () => {
    expect((await patch('kc-stranger', [Role.Member], { title: 'gekapert' })).status).toBe(403)
    expect((await patch('kc-stranger', [Role.Member], { isPublic: true })).status).toBe(403)
    expect((await del('kc-stranger', [Role.Member])).status).toBe(403)
    expect(backend.updateEvent).not.toHaveBeenCalled()
    expect(backend.deleteEvent).not.toHaveBeenCalled()
  })

  it('the creator may edit and delete their own event', async () => {
    expect((await patch('kc-creator', [Role.Member], { title: 'Neu' })).status).toBe(200)
    expect((await del('kc-creator', [Role.Member])).status).toBe(200)
  })

  it('a member of one of the event committees may edit it and publish it', async () => {
    expect((await patch('kc-unit-a-member', [Role.Member], { title: 'Neu' })).status).toBe(200)
    expect((await patch('kc-unit-a-member', [Role.Member], { isPublic: true })).status).toBe(200)
  })

  it('the creator who is not in any of the event committees cannot publish it', async () => {
    expect((await patch('kc-creator', [Role.Member], { isPublic: true })).status).toBe(403)
    expect(backend.updateEvent).not.toHaveBeenCalled()
  })

  it('a non-admin cannot tag a committee they do not belong to', async () => {
    expect((await patch('kc-unit-a-member', [Role.Member], { committeeIds: [UNIT_A, UNIT_B] })).status).toBe(403)
    expect(backend.updateEvent).not.toHaveBeenCalled()
  })

  it('CouncilAdmin may edit, publish, retag and delete any event', async () => {
    expect((await patch('kc-admin', [Role.CouncilAdmin], { isPublic: true, committeeIds: [UNIT_B] })).status).toBe(200)
    expect((await del('kc-admin', [Role.CouncilAdmin])).status).toBe(200)
  })

  it('read-only automation events stay 403 even for CouncilAdmin', async () => {
    backend.getEvent.mockResolvedValue(event({ readOnly: true }))
    expect((await patch('kc-admin', [Role.CouncilAdmin], { title: 'x' })).status).toBe(403)
  })
})

describe('POST /api/calendar/events — S3#29 committee tagging and publishing', () => {
  it('a Member may create a private event tagged with their own committee', async () => {
    const res = await post('kc-unit-a-member', [Role.Member], createBody({ committeeIds: [UNIT_A] }))
    expect(res.status).toBe(201)
  })

  it('a Member cannot tag a committee they do not belong to', async () => {
    const res = await post('kc-unit-a-member', [Role.Member], createBody({ committeeIds: [UNIT_B] }))
    expect(res.status).toBe(403)
    expect(backend.createEvent).not.toHaveBeenCalled()
  })

  it('a Member cannot create a public event outside their committees', async () => {
    const res = await post('kc-stranger', [Role.Member], createBody({ isPublic: true }))
    expect(res.status).toBe(403)
    expect(backend.createEvent).not.toHaveBeenCalled()
  })

  it('a committee member may create a public event for their committee; CouncilAdmin may publish anything', async () => {
    expect((await post('kc-unit-a-member', [Role.Member], createBody({ isPublic: true, committeeIds: [UNIT_A] }))).status).toBe(201)
    expect((await post('kc-admin', [Role.CouncilAdmin], createBody({ isPublic: true }))).status).toBe(201)
  })
})
