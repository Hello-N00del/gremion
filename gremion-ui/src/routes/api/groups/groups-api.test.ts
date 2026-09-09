import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockListOrgUnits, mockCreateOrgUnit, mockDeleteOrgUnit } = vi.hoisted(() => ({
  mockListOrgUnits: vi.fn(),
  mockCreateOrgUnit: vi.fn(),
  mockDeleteOrgUnit: vi.fn(),
}))
const { mockProvision, mockDeprovision, mockWantedSubsystems } = vi.hoisted(() => ({
  mockProvision: vi.fn(),
  mockDeprovision: vi.fn(),
  mockWantedSubsystems: vi.fn().mockReturnValue([]),
}))
const { mockGetResources, mockEnqueueResources } = vi.hoisted(() => ({
  mockGetResources: vi.fn(),
  mockEnqueueResources: vi.fn().mockResolvedValue(undefined),
}))
const { mockHasRole } = vi.hoisted(() => ({ mockHasRole: vi.fn().mockReturnValue(true) }))

vi.mock('$lib/server/governance/org-units-db', () => ({
  listOrgUnits: mockListOrgUnits,
  createOrgUnit: mockCreateOrgUnit,
  deleteOrgUnit: mockDeleteOrgUnit,
}))
vi.mock('$lib/server/governance/provisioning/orchestrator', () => ({
  provisionOrgUnit: mockProvision,
  deprovisionOrgUnit: mockDeprovision,
  wantedSubsystems: mockWantedSubsystems,
}))
vi.mock('$lib/server/governance/provisioning/ledger', () => ({
  getResources: mockGetResources,
  enqueueResources: mockEnqueueResources,
}))
vi.mock('$lib/server/db', () => ({
  getDb: () => ({ begin: async (fn: any) => fn({} as any) }),
}))
vi.mock('$lib/auth', () => ({
  hasRole: mockHasRole,
  Role: { Guest: 'guest', Member: 'member', CouncilAdmin: 'council-admin' },
}))
// P2.2 Task 10: POST now consults the tenant org-schema before creating the
// standalone group — stub the DB loader with the StuRa default (group canBeRoot).
vi.mock('$lib/server/governance/org-schema', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/server/governance/org-schema')>()
  return { ...actual, loadOrgSchema: vi.fn().mockResolvedValue(actual.GREMION_ORG_SCHEMA) }
})

import { POST } from './+server'

function makeLocals(roles: string[] = ['council-admin']) {
  return { auth: async () => ({ user: { id: 'u-admin', roles, groups: [] } }) }
}
function req(body: unknown) {
  return new Request('http://localhost/api/groups', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
}

beforeEach(() => {
  mockListOrgUnits.mockReset()
  mockCreateOrgUnit.mockReset()
  mockDeleteOrgUnit.mockReset().mockResolvedValue(undefined)
  mockProvision.mockReset()
  mockDeprovision.mockReset().mockResolvedValue(undefined)
  mockGetResources.mockReset()
  mockEnqueueResources.mockReset().mockResolvedValue(undefined)
  mockWantedSubsystems.mockReset().mockReturnValue([])
  mockHasRole.mockReset().mockReturnValue(true)
})

describe('POST /api/groups', () => {
  it('tears down the org unit and returns 502 when provisioning fails (#185)', async () => {
    mockCreateOrgUnit.mockResolvedValue({ id: 'ou-1', name: 'AG Test' })
    mockProvision.mockResolvedValue({
      overall: 'failed',
      subsystems: [{ subsystem: 'keycloak', status: 'failed', error: 'KC unreachable' }],
    })
    // @ts-expect-error partial mock
    const res = await POST({ locals: makeLocals(), request: req({ name: 'AG Test' }) })
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.error).toContain('KC unreachable')
    expect(mockDeprovision).toHaveBeenCalledWith('ou-1')
    expect(mockDeleteOrgUnit).toHaveBeenCalledWith('ou-1')
  })

  it('returns 201 and keeps the unit when provisioning succeeds', async () => {
    mockCreateOrgUnit.mockResolvedValue({ id: 'ou-2', name: 'AG OK', wants_matrix_room: true, wants_nextcloud_folder: true })
    mockProvision.mockResolvedValue({ overall: 'ok', subsystems: [] })
    mockWantedSubsystems.mockReturnValue(['keycloak'])
    // @ts-expect-error partial mock
    const res = await POST({ locals: makeLocals(), request: req({ name: 'AG OK' }) })
    expect(res.status).toBe(201)
    expect(mockDeleteOrgUnit).not.toHaveBeenCalled()
    // F5: pin the route enqueue — enqueueResources must be called with the unit id and subsystems
    expect(mockEnqueueResources).toHaveBeenCalledWith(expect.anything(), expect.any(String), expect.arrayContaining(['keycloak']))
  })

  it('still deletes the DB row even when deprovision throws (#185)', async () => {
    mockCreateOrgUnit.mockResolvedValue({ id: 'ou-3', name: 'AG Fail' })
    mockProvision.mockResolvedValue({ overall: 'failed', subsystems: [] })
    mockDeprovision.mockRejectedValue(new Error('KC down'))
    // @ts-expect-error partial mock
    const res = await POST({ locals: makeLocals(), request: req({ name: 'AG Fail' }) })
    expect(res.status).toBe(502)
    expect(mockDeleteOrgUnit).toHaveBeenCalledWith('ou-3')
  })

  it('still returns a structured 502 when the row cleanup itself throws (#208)', async () => {
    mockCreateOrgUnit.mockResolvedValue({ id: 'ou-4', name: 'AG Cleanup' })
    mockProvision.mockResolvedValue({
      overall: 'failed',
      subsystems: [{ subsystem: 'keycloak', status: 'failed', error: 'KC unreachable' }],
    })
    mockDeleteOrgUnit.mockRejectedValue(new Error('DB delete failed'))
    // @ts-expect-error partial mock
    const res = await POST({ locals: makeLocals(), request: req({ name: 'AG Cleanup' }) })
    // A failed cleanup must NOT collapse into an opaque 500.
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.success).toBe(false)
  })
})
