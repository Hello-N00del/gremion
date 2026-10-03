import { describe, expect, it, vi, beforeEach } from 'vitest'
import { GET, POST } from './+server'
import {
  HeliosAppError,
  HeliosUnavailableError,
  HeliosServiceAuthError,
} from '$lib/server/elections/helios-client'

// helios-client imports $env/dynamic/private at module load (read lazily).
// Provide a stub so importActual() in the mock below can load the real module
// (and thus the real error classes) without a missing-env failure.
vi.mock('$env/dynamic/private', () => ({ env: {} }))

const { mockFindAll, mockFindVisibleToUser, mockInsert, mockMarkCalendarLinked } = vi.hoisted(() => ({
  mockFindAll: vi.fn(),
  mockFindVisibleToUser: vi.fn(),
  mockInsert: vi.fn(),
  mockMarkCalendarLinked: vi.fn(),
}))
const { mockGetElection, mockCreateElection, mockSetQuestions, mockBulkUploadVoters, mockFreeze } = vi.hoisted(() => ({
  mockGetElection: vi.fn(),
  mockCreateElection: vi.fn(),
  mockSetQuestions: vi.fn(),
  mockBulkUploadVoters: vi.fn(),
  mockFreeze: vi.fn(),
}))
const { mockHasRole } = vi.hoisted(() => ({ mockHasRole: vi.fn().mockReturnValue(true) }))
const { mockListOrgUnitMembers } = vi.hoisted(() => ({ mockListOrgUnitMembers: vi.fn() }))
const { mockGetUser } = vi.hoisted(() => ({ mockGetUser: vi.fn() }))

vi.mock('$lib/server/elections/election-db', () => ({
  ElectionDb: {
    findAll: mockFindAll,
    findVisibleToUser: mockFindVisibleToUser,
    insert: mockInsert,
    markCalendarLinked: mockMarkCalendarLinked,
  },
}))
vi.mock('$lib/server/elections/helios-client', async (importOriginal) => {
  // Keep the REAL error classes (HeliosAppError / HeliosUnavailableError /
  // HeliosServiceAuthError) so the route's `instanceof` classification matches
  // the errors thrown in these tests; only the HeliosClient methods are mocked.
  const actual = await importOriginal<typeof import('$lib/server/elections/helios-client')>()
  return {
    ...actual,
    HeliosClient: {
      getElection: mockGetElection,
      createElection: mockCreateElection,
      setQuestions: mockSetQuestions,
      bulkUploadVoters: mockBulkUploadVoters,
      freeze: mockFreeze,
    },
    deriveLifecycle: vi.fn().mockReturnValue('open'),
  }
})
vi.mock('$lib/auth', () => ({
  hasRole: mockHasRole,
  Role: { Member: 'member', CouncilAdmin: 'council-admin', ITAdmin: 'it-admin' },
}))
vi.mock('$lib/server/keycloak-admin', () => ({
  getKeycloakAdminClient: () => ({ getUser: mockGetUser }),
}))
vi.mock('$lib/server/governance/org-units-db', () => ({
  listOrgUnitMembers: mockListOrgUnitMembers,
}))

const mockElection = {
  uuid: 'abc-123', short_name: 'wahl-2026', name: 'StuMV Wahl', description: '',
  voting_starts_at: '2026-05-01T10:00:00Z', voting_ends_at: '2026-05-08T10:00:00Z',
  frozen_at: '2026-04-30T00:00:00Z', archived_at: null, num_cast_votes: 10,
  result: null, result_proof: null,
}
const mockRow = {
  id: 'row-uuid', helios_uuid: 'abc-123', org_unit_id: 'comm-1',
  created_by: 'user-1', calendar_linked: false, created_at: new Date(), archived_at: null,
}

function makeLocals(roles: string[] = ['member'], userId = 'user-1') {
  return { auth: async () => ({ user: { id: userId, roles, groups: [] } }) }
}

beforeEach(() => {
  mockHasRole.mockReset().mockReturnValue(true)
  mockFindAll.mockReset()
  mockFindVisibleToUser.mockReset()
  mockInsert.mockReset()
  mockMarkCalendarLinked.mockReset()
  mockGetElection.mockReset()
  mockCreateElection.mockReset()
  mockSetQuestions.mockReset()
  mockBulkUploadVoters.mockReset()
  mockFreeze.mockReset()
  mockListOrgUnitMembers.mockReset()
  mockGetUser.mockReset()
})

describe('GET /api/elections', () => {
  it('returns elections for council-admin (all committees)', async () => {
    mockHasRole.mockReturnValue(true)
    mockFindAll.mockResolvedValue([mockRow])
    mockGetElection.mockResolvedValue(mockElection)

    // @ts-expect-error partial mock
    const response = await GET({ locals: makeLocals(['council-admin']) })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.data[0].uuid).toBe('abc-123')
  })

  it('returns 403 for guest', async () => {
    mockHasRole.mockReturnValueOnce(false)
    // @ts-expect-error partial mock
    const response = await GET({ locals: makeLocals(['guest']) })
    expect(response.status).toBe(403)
  })

  it('skips elections that Helios cannot fetch', async () => {
    mockHasRole.mockReturnValue(true)
    mockFindAll.mockResolvedValue([mockRow])
    mockGetElection.mockRejectedValue(new Error('Helios unreachable'))

    // @ts-expect-error partial mock
    const response = await GET({ locals: makeLocals(['council-admin']) })
    const body = await response.json()
    expect(body.data).toHaveLength(0)
  })
})

describe('POST /api/elections', () => {
  it('returns 403 for member role', async () => {
    mockHasRole
      .mockReturnValueOnce(true) // hasRole(Member) — passes auth
      .mockReturnValueOnce(false) // hasRole(CouncilAdmin) — fails admin check

    const request = new Request('http://localhost/api/elections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    // @ts-expect-error partial mock
    const response = await POST({ locals: makeLocals(['member']), request })
    expect(response.status).toBe(403)
  })

  it('creates election, writes DB row, returns uuid', async () => {
    mockHasRole.mockReturnValue(true)
    mockCreateElection.mockResolvedValue({ ...mockElection, uuid: 'new-uuid' })
    mockSetQuestions.mockResolvedValue(undefined)
    mockBulkUploadVoters.mockResolvedValue({ num_voters: 2, warnings: [] })
    mockInsert.mockResolvedValue({ ...mockRow, helios_uuid: 'new-uuid' })
    mockListOrgUnitMembers.mockResolvedValue([
      { user_keycloak_id: 'u1' },
    ])
    mockGetUser.mockResolvedValue({
      id: 'u1', username: 'anna.m', email: 'a@uni.de', firstName: 'Anna', lastName: 'M',
      enabled: true, emailVerified: true,
    })

    const wizardData = {
      title: 'Test Wahl', shortName: 'test-wahl', description: '',
      committeeId: 'comm-1',
      votingStartsAt: '2026-05-01T10:00:00Z', votingEndsAt: '2026-05-08T10:00:00Z',
      questions: [{
        question: 'Ja oder Nein?', shortName: 'q1',
        answers: ['Ja', 'Nein', 'Enthaltung'], min: 1, max: 1,
      }],
      removedVoterEmails: [],
      createCalendarEvents: false,
      freeze: false,
    }

    const request = new Request('http://localhost/api/elections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(wizardData),
    })
    // @ts-expect-error partial mock
    const response = await POST({ locals: makeLocals(['council-admin']), request })
    const body = await response.json()

    expect(response.status).toBe(201)
    expect(body.success).toBe(true)
    expect(body.data.uuid).toBe('new-uuid')
    expect(mockCreateElection).toHaveBeenCalledOnce()
    expect(mockSetQuestions).toHaveBeenCalledOnce()
    expect(mockListOrgUnitMembers).toHaveBeenCalledWith('comm-1')
    expect(mockGetUser).toHaveBeenCalledWith('u1')
    expect(mockBulkUploadVoters).toHaveBeenCalledOnce()
    expect(mockBulkUploadVoters).toHaveBeenCalledWith('new-uuid', [{ email: 'a@uni.de', name: 'Anna M' }])
    expect(mockInsert).toHaveBeenCalledOnce()
  })

  // ── Error classification (#153) ──────────────────────────────────────────
  // The create flow has six steps; before this fix, steps 2-6 were unguarded,
  // so any failure surfaced as an opaque 500 ("connection error"). Each failure
  // class must now map to a specific, structured response.

  function wizardRequest(overrides: Record<string, unknown> = {}) {
    const wizardData = {
      title: 'Test Wahl', shortName: 'test-wahl', description: '',
      committeeId: 'comm-1',
      votingStartsAt: '2026-05-01T10:00:00Z', votingEndsAt: '2026-05-08T10:00:00Z',
      questions: [{ question: 'Ja oder Nein?', shortName: 'q1', answers: ['Ja', 'Nein'], min: 1, max: 1 }],
      removedVoterEmails: [],
      createCalendarEvents: false,
      freeze: false,
      ...overrides,
    }
    return new Request('http://localhost/api/elections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(wizardData),
    })
  }

  it('returns 503 when the Helios service account cannot authenticate', async () => {
    mockHasRole.mockReturnValue(true)
    mockCreateElection.mockRejectedValue(new HeliosServiceAuthError('login failed (200)'))

    // @ts-expect-error partial mock
    const response = await POST({ locals: makeLocals(['council-admin']), request: wizardRequest() })
    const body = await response.json()
    expect(response.status).toBe(503)
    expect(body.success).toBe(false)
  })

  it('maps a Helios application error to 422', async () => {
    mockHasRole.mockReturnValue(true)
    mockCreateElection.mockRejectedValue(new HeliosAppError('Kurzname bereits vergeben'))

    // @ts-expect-error partial mock
    const response = await POST({ locals: makeLocals(['council-admin']), request: wizardRequest() })
    expect(response.status).toBe(422)
  })

  it('returns 502 when a post-create step finds Helios unavailable', async () => {
    mockHasRole.mockReturnValue(true)
    mockCreateElection.mockResolvedValue({ ...mockElection, uuid: 'u' })
    mockSetQuestions.mockRejectedValue(new HeliosUnavailableError('down', null))

    // @ts-expect-error partial mock
    const response = await POST({ locals: makeLocals(['council-admin']), request: wizardRequest() })
    const body = await response.json()
    expect(response.status).toBe(502)
    expect(body.success).toBe(false)
  })

  it('returns a structured 502 (not an unhandled 500) on a generic post-create failure', async () => {
    mockHasRole.mockReturnValue(true)
    mockCreateElection.mockResolvedValue({ ...mockElection, uuid: 'u' })
    mockSetQuestions.mockResolvedValue(undefined)
    mockListOrgUnitMembers.mockResolvedValue([{ user_keycloak_id: 'u1' }])
    mockGetUser.mockResolvedValue({ email: 'a@uni.de', firstName: 'A', lastName: 'B' })
    mockBulkUploadVoters.mockRejectedValue(
      new Error('Helios voter processing did not complete within 30s for u'),
    )

    // @ts-expect-error partial mock
    const response = await POST({ locals: makeLocals(['council-admin']), request: wizardRequest() })
    const body = await response.json()
    expect(response.status).toBe(502)
    expect(body.success).toBe(false)
  })

  it('returns a structured 502 (not a crash) when the early DB insert itself fails (#185)', async () => {
    mockHasRole.mockReturnValue(true)
    mockCreateElection.mockResolvedValue({ ...mockElection, uuid: 'u' })
    mockInsert.mockRejectedValue(new Error('DB down'))

    // @ts-expect-error partial mock
    const response = await POST({ locals: makeLocals(['council-admin']), request: wizardRequest() })
    const body = await response.json()
    expect(response.status).toBe(502)
    expect(body.success).toBe(false)
  })

  it('writes the DB row before post-create steps so a later failure leaves a visible draft (#185)', async () => {
    mockHasRole.mockReturnValue(true)
    mockCreateElection.mockResolvedValue({ ...mockElection, uuid: 'draft-uuid' })
    mockInsert.mockResolvedValue({ ...mockRow, helios_uuid: 'draft-uuid' })
    mockSetQuestions.mockRejectedValue(new HeliosUnavailableError('down', null))

    // @ts-expect-error partial mock
    const response = await POST({ locals: makeLocals(['council-admin']), request: wizardRequest() })
    expect(response.status).toBe(502)
    // the row was persisted despite the later failure ...
    expect(mockInsert).toHaveBeenCalledOnce()
    expect(mockInsert).toHaveBeenCalledWith(expect.objectContaining({ heliosUuid: 'draft-uuid' }))
    // ... and it ran BEFORE setQuestions
    expect(mockInsert.mock.invocationCallOrder[0]).toBeLessThan(mockSetQuestions.mock.invocationCallOrder[0])
  })
})
