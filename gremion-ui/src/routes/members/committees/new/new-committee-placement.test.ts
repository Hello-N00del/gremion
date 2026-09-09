// P2.2-data (#202) Task 10: the members/committees/new form action validates
// the submitted kind against the TENANT catalog (loadOrgSchema()), not the
// hardcoded council/committee/group triple, and enforces the shared
// validateCreatePlacement rules (council parent stays forced null; a committee
// without a parent is rejected with the validator message).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Role } from '$lib/auth'
import type { OrgSchema } from '$lib/server/governance/org-schema'

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
const { mockWriteAuditEntry } = vi.hoisted(() => ({ mockWriteAuditEntry: vi.fn() }))
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
vi.mock('$lib/server/audit-db', () => ({ writeAuditEntry: mockWriteAuditEntry }))
// Keep the REAL validators/messages (no drift); only the DB loader is mocked.
vi.mock('$lib/server/governance/org-schema', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/server/governance/org-schema')>()
  return { ...actual, loadOrgSchema: mockLoadOrgSchema }
})

import { GREMION_ORG_SCHEMA } from '$lib/server/governance/org-schema'
import { actions } from './+page.server'

/** A municipal tenant catalog — carries a kind OUTSIDE the StuRa triple. */
const MUNICIPAL_SCHEMA: OrgSchema = {
  kinds: {
    council:          { key: 'council',          label: 'Gemeinderat',  childTerm: null, allowedParentKinds: [],          canBeRoot: true, rootMin: 1, rootMax: 1,    sortOrder: 0 },
    district_council: { key: 'district_council', label: 'Ortschaftsrat', childTerm: null, allowedParentKinds: [],          canBeRoot: true, rootMin: 0, rootMax: null, sortOrder: 1 },
    committee:        { key: 'committee',        label: 'Ausschuss',    childTerm: null, allowedParentKinds: ['council'], canBeRoot: false, rootMin: 0, rootMax: 0,   sortOrder: 2 },
  },
}

function actionEvent(fields: Record<string, string>) {
  const form = new FormData()
  for (const [k, v] of Object.entries(fields)) form.set(k, v)
  return {
    locals: {
      auth: async () => ({
        user: { id: 'u-admin', roles: [Role.CouncilAdmin], groups: [], email: 'a@example.org', name: 'Admin' },
      }),
    },
    request: { formData: async () => form },
  } as never
}

beforeEach(() => {
  mockListOrgUnits.mockReset()
  mockCreateOrgUnit.mockReset()
  mockDeleteOrgUnit.mockReset().mockResolvedValue(undefined)
  mockGetOrgUnit.mockReset()
  mockProvision.mockReset()
  mockDeprovision.mockReset().mockResolvedValue(undefined)
  mockWriteAuditEntry.mockReset().mockResolvedValue(undefined)
  mockLoadOrgSchema.mockReset().mockResolvedValue(GREMION_ORG_SCHEMA)
})

describe('members/committees/new action — tenant-catalog kinds + placement (#202 Task 10)', () => {
  it("rejects a kind that is not in the tenant catalog with fail(400) 'Ungültige Art.'", async () => {
    const result = (await actions.default(actionEvent({ name: 'Fraktion X', kind: 'fraktion' }))) as {
      status: number
      data: { error: string }
    }
    expect(result.status).toBe(400)
    expect(result.data.error).toBe('Ungültige Art.')
    expect(mockCreateOrgUnit).not.toHaveBeenCalled()
  })

  it('accepts a tenant-catalog kind beyond the hardcoded triple (district_council → created)', async () => {
    mockLoadOrgSchema.mockResolvedValue(MUNICIPAL_SCHEMA)
    mockCreateOrgUnit.mockResolvedValue({ id: 'ou-dc', name: 'Ortschaftsrat Nord' })
    mockProvision.mockResolvedValue({ overall: 'ok', subsystems: [] })
    let redirected: { status?: number } | null = null
    try {
      await actions.default(actionEvent({ name: 'Ortschaftsrat Nord', kind: 'district_council' }))
    } catch (e) {
      redirected = e as { status?: number }
    }
    expect(redirected?.status).toBe(303)
    // P0.3a: tx-first overload — createOrgUnit(tx, data)
    expect(mockCreateOrgUnit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: 'district_council', parentId: null })
    )
  })

  it('forces the parent to null for a council (unchanged behavior)', async () => {
    mockCreateOrgUnit.mockResolvedValue({ id: 'ou-c', name: 'StuRa' })
    mockProvision.mockResolvedValue({ overall: 'ok', subsystems: [] })
    let redirected: { status?: number } | null = null
    try {
      await actions.default(
        actionEvent({ name: 'StuRa', kind: 'council', parentId: '11111111-1111-4111-8111-111111111111' })
      )
    } catch (e) {
      redirected = e as { status?: number }
    }
    expect(redirected?.status).toBe(303)
    // P0.3a: tx-first overload — createOrgUnit(tx, data)
    expect(mockCreateOrgUnit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: 'council', parentId: null })
    )
  })

  it('rejects a committee with no parent via the shared validator message (fail 400)', async () => {
    const result = (await actions.default(actionEvent({ name: 'Referat X', kind: 'committee' }))) as {
      status: number
      data: { error: string }
    }
    expect(result.status).toBe(400)
    expect(result.data.error).toContain("kind 'committee' cannot be a root")
    expect(mockCreateOrgUnit).not.toHaveBeenCalled()
  })
})
