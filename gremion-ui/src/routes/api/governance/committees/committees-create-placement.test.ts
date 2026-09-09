// P2.2-data (#202) Task 10: POST /api/governance/committees enforces the
// shared org-schema placement rules (validateCreatePlacement). TODAY a
// committee with parentId:null is created unvalidated — the recon gap this
// closes: committees cannot be roots (StuRa catalog: canBeRoot=false) and
// their parents must be council|committee.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Role } from '$lib/auth'

const { mockListOrgUnits, mockCreateOrgUnit, mockDeleteOrgUnit, mockGetOrgUnit } = vi.hoisted(() => ({
  mockListOrgUnits: vi.fn(),
  mockCreateOrgUnit: vi.fn(),
  mockDeleteOrgUnit: vi.fn(),
  mockGetOrgUnit: vi.fn(),
}))
const { mockProvision, mockDeprovision } = vi.hoisted(() => ({
  mockProvision: vi.fn(),
  mockDeprovision: vi.fn(),
}))
const { mockLoadOrgSchema } = vi.hoisted(() => ({ mockLoadOrgSchema: vi.fn() }))

vi.mock('$lib/server/governance/org-units-db', () => ({
  listOrgUnits: mockListOrgUnits,
  createOrgUnit: mockCreateOrgUnit,
  deleteOrgUnit: mockDeleteOrgUnit,
  getOrgUnit: mockGetOrgUnit,
}))
vi.mock('$lib/server/governance/provisioning/orchestrator', () => ({
  provisionOrgUnit: mockProvision,
  deprovisionOrgUnit: mockDeprovision,
  wantedSubsystems: vi.fn().mockReturnValue([]),
}))
// P0.3a (merged from master): the create is transactional — createOrgUnit(tx, …)
// + enqueueResources(tx, …) inside getDb().begin. Mirror committees-access.test.ts.
vi.mock('$lib/server/governance/provisioning/ledger', () => ({
  enqueueResources: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('$lib/server/db', () => ({
  getDb: () => ({ begin: async (fn: (tx: unknown) => unknown) => fn({}) }),
}))
// Keep the REAL validators/messages (no drift); only the DB loader is mocked.
vi.mock('$lib/server/governance/org-schema', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/server/governance/org-schema')>()
  return { ...actual, loadOrgSchema: mockLoadOrgSchema }
})

import { GREMION_ORG_SCHEMA } from '$lib/server/governance/org-schema'
import { POST } from './+server'

const COUNCIL_ID = '11111111-1111-4111-8111-111111111111'
const GROUP_ID = '22222222-2222-4222-8222-222222222222'
const MISSING_ID = '33333333-3333-4333-8333-333333333333'

function postEvent(body: unknown) {
  return {
    locals: {
      auth: async () => ({
        user: { id: 'u-admin', roles: [Role.CouncilAdmin], groups: [], email: 'a@example.org', name: 'Admin' },
      }),
    },
    request: new Request('http://localhost/api/governance/committees', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  } as never
}

beforeEach(() => {
  mockListOrgUnits.mockReset()
  mockCreateOrgUnit.mockReset()
  mockDeleteOrgUnit.mockReset().mockResolvedValue(undefined)
  mockGetOrgUnit.mockReset()
  mockProvision.mockReset()
  mockDeprovision.mockReset().mockResolvedValue(undefined)
  mockLoadOrgSchema.mockReset().mockResolvedValue(GREMION_ORG_SCHEMA)
})

describe('POST /api/governance/committees — org-schema placement rules (#202 Task 10)', () => {
  it('rejects parentId:null with 400 — committees cannot be roots (closes the recon gap)', async () => {
    const res = await POST(postEvent({ name: 'Referat X', parentId: null }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(body.error).toContain("kind 'committee' cannot be a root")
    expect(mockCreateOrgUnit).not.toHaveBeenCalled()
  })

  it('rejects a parent of kind group with 400 (allowed parents: council|committee)', async () => {
    mockGetOrgUnit.mockResolvedValue({ id: GROUP_ID, kind: 'group' })
    const res = await POST(postEvent({ name: 'Referat X', parentId: GROUP_ID }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/cannot be created under kind 'group'/)
    expect(mockCreateOrgUnit).not.toHaveBeenCalled()
  })

  it('rejects a missing parent with 400 (not-found message preserved)', async () => {
    mockGetOrgUnit.mockResolvedValue(null)
    const res = await POST(postEvent({ name: 'Referat X', parentId: MISSING_ID }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('Übergeordnete Einheit nicht gefunden.')
    expect(mockCreateOrgUnit).not.toHaveBeenCalled()
  })

  it('creates the committee under a council parent (happy path, 201)', async () => {
    mockGetOrgUnit.mockResolvedValue({ id: COUNCIL_ID, kind: 'council' })
    mockCreateOrgUnit.mockResolvedValue({ id: 'ou-new', name: 'Referat X' })
    mockProvision.mockResolvedValue({ overall: 'ok', subsystems: [] })
    const res = await POST(postEvent({ name: 'Referat X', parentId: COUNCIL_ID }))
    expect(res.status, await res.clone().text()).toBe(201)
    // P0.3a: tx-first overload — createOrgUnit(tx, data)
    expect(mockCreateOrgUnit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: 'committee', parentId: COUNCIL_ID })
    )
  })
})
