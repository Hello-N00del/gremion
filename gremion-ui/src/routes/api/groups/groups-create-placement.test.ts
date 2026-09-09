// P2.2-data (#202) Task 10: POST /api/groups consults the SAME shared
// org-schema validator as the other two create paths. StuRa catalog: group
// canBeRoot → standalone top-level groups keep working (201, D-RB pin); a
// tenant catalog that forbids root groups → 400 from the shared validator.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Role } from '$lib/auth'
import type { OrgSchema } from '$lib/server/governance/org-schema'

const { mockListOrgUnits, mockCreateOrgUnit, mockDeleteOrgUnit } = vi.hoisted(() => ({
  mockListOrgUnits: vi.fn(),
  mockCreateOrgUnit: vi.fn(),
  mockDeleteOrgUnit: vi.fn(),
}))
const { mockProvision, mockDeprovision } = vi.hoisted(() => ({
  mockProvision: vi.fn(),
  mockDeprovision: vi.fn(),
}))
const { mockGetResources } = vi.hoisted(() => ({ mockGetResources: vi.fn() }))
const { mockLoadOrgSchema } = vi.hoisted(() => ({ mockLoadOrgSchema: vi.fn() }))

vi.mock('$lib/server/governance/org-units-db', () => ({
  listOrgUnits: mockListOrgUnits,
  createOrgUnit: mockCreateOrgUnit,
  deleteOrgUnit: mockDeleteOrgUnit,
}))
vi.mock('$lib/server/governance/provisioning/orchestrator', () => ({
  provisionOrgUnit: mockProvision,
  deprovisionOrgUnit: mockDeprovision,
  wantedSubsystems: vi.fn().mockReturnValue([]),
}))
// P0.3a (merged from master): the create is transactional — createOrgUnit(tx, …)
// + enqueueResources(tx, …) inside getDb().begin. Mirror committees-access.test.ts.
vi.mock('$lib/server/governance/provisioning/ledger', () => ({
  getResources: mockGetResources,
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

/** A tenant vocabulary where groups must live under a council (no root groups). */
const NO_ROOT_GROUPS_SCHEMA: OrgSchema = {
  kinds: {
    council: { key: 'council', label: 'Rat', childTerm: null, allowedParentKinds: [], canBeRoot: true, rootMin: 1, rootMax: 1, sortOrder: 0 },
    group:   { key: 'group',   label: 'Gruppe', childTerm: null, allowedParentKinds: ['council'], canBeRoot: false, rootMin: 0, rootMax: 0, sortOrder: 1 },
  },
}

function postEvent(body: unknown) {
  return {
    locals: {
      auth: async () => ({
        user: { id: 'u-admin', roles: [Role.CouncilAdmin], groups: [], email: 'a@example.org', name: 'Admin' },
      }),
    },
    request: new Request('http://localhost/api/groups', {
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
  mockProvision.mockReset()
  mockDeprovision.mockReset().mockResolvedValue(undefined)
  mockGetResources.mockReset()
  mockLoadOrgSchema.mockReset().mockResolvedValue(GREMION_ORG_SCHEMA)
})

describe('POST /api/groups — org-schema placement rules (#202 Task 10)', () => {
  it('still creates parentId:null standalone groups under the StuRa schema (201, D-RB)', async () => {
    mockCreateOrgUnit.mockResolvedValue({ id: 'ou-1', name: 'AG Standalone' })
    mockProvision.mockResolvedValue({ overall: 'ok', subsystems: [] })
    const res = await POST(postEvent({ name: 'AG Standalone' }))
    expect(res.status, await res.clone().text()).toBe(201)
    // P0.3a: tx-first overload — createOrgUnit(tx, data)
    expect(mockCreateOrgUnit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: 'group', parentId: null })
    )
  })

  it('rejects with 400 when the tenant catalog forbids root groups (shared validator wired)', async () => {
    mockLoadOrgSchema.mockResolvedValue(NO_ROOT_GROUPS_SCHEMA)
    const res = await POST(postEvent({ name: 'AG Standalone' }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(body.error).toContain("kind 'group' cannot be a root")
    expect(mockCreateOrgUnit).not.toHaveBeenCalled()
  })
})
