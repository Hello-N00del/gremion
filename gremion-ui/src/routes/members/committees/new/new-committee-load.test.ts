// The new-unit form offers the kinds of the customer's own catalogue (org_unit_kind) and lets the
// person pick a parent from every unit the server would accept for the chosen kind. The load hands
// the form the catalogue (in its sort order) and every unit with its kind; which units may be a
// parent of which kind is decided by the catalogue's allowedParentKinds, the same rule
// validateCreatePlacement applies when the form is submitted.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Role } from '$lib/auth'
import type { OrgSchema } from '$lib/server/governance/org-schema'

const h = vi.hoisted(() => ({ listOrgUnits: vi.fn(), loadOrgSchema: vi.fn() }))

vi.mock('$lib/server/governance/org-units-db', () => ({
  listOrgUnits: h.listOrgUnits,
  createOrgUnit: vi.fn(),
  deleteOrgUnit: vi.fn(),
  getOrgUnit: vi.fn(),
}))
vi.mock('$lib/server/governance/provisioning/orchestrator', () => ({
  provisionOrgUnit: vi.fn(),
  deprovisionOrgUnit: vi.fn(),
  wantedSubsystems: vi.fn().mockReturnValue([]),
}))
vi.mock('$lib/server/governance/provisioning/ledger', () => ({ enqueueResources: vi.fn() }))
vi.mock('$lib/server/db', () => ({ getDb: () => ({}) }))
vi.mock('$lib/server/audit-db', () => ({ writeAuditEntry: vi.fn() }))
vi.mock('$lib/server/governance/org-schema', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/server/governance/org-schema')>()
  return { ...actual, loadOrgSchema: h.loadOrgSchema }
})

import { load } from './+page.server'

const SCHEMA: OrgSchema = {
  kinds: {
    group: { key: 'group', label: 'Gruppe', childTerm: null, allowedParentKinds: ['council', 'committee', 'group'], canBeRoot: true, rootMin: 0, rootMax: null, sortOrder: 5 },
    council: { key: 'council', label: 'Gremium', childTerm: null, allowedParentKinds: [], canBeRoot: true, rootMin: 1, rootMax: 1, sortOrder: 0 },
    referat: { key: 'referat', label: 'Referat', childTerm: null, allowedParentKinds: ['council'], canBeRoot: false, rootMin: 0, rootMax: 0, sortOrder: 1 },
    ag: { key: 'ag', label: 'AG', childTerm: null, allowedParentKinds: ['referat', 'council'], canBeRoot: false, rootMin: 0, rootMax: 0, sortOrder: 2 },
  },
}

function event(roles: string[]) {
  return { locals: { auth: async () => ({ user: { id: 'u1', roles, groups: [], email: 'a@example.org', name: 'A' } }) } } as never
}

beforeEach(() => {
  h.loadOrgSchema.mockReset().mockResolvedValue(SCHEMA)
  h.listOrgUnits.mockReset().mockResolvedValue([
    { id: 'ou-1', name: 'Fachschaftsrat', kind: 'council' },
    { id: 'ou-2', name: 'Referat Finanzen', kind: 'referat' },
    { id: 'ou-3', name: 'Lesekreis', kind: 'group' },
  ])
})

describe('members/committees/new load', () => {
  it('offers the catalogue kinds in the catalogue order, not a fixed triple', async () => {
    const out = (await load(event([Role.CouncilAdmin]))) as { kinds: { key: string; label: string; canBeRoot: boolean; allowedParentKinds: string[] }[] }
    expect(out.kinds.map((k) => k.key)).toEqual(['council', 'referat', 'ag', 'group'])
    expect(out.kinds.map((k) => k.label)).toEqual(['Gremium', 'Referat', 'AG', 'Gruppe'])
    expect(out.kinds[2]).toMatchObject({ canBeRoot: false, allowedParentKinds: ['referat', 'council'] })
  })

  it('hands over every unit with its kind, groups included', async () => {
    const out = (await load(event([Role.CouncilAdmin]))) as { parents: { id: string; name: string; kind: string }[] }
    expect(out.parents).toEqual([
      { id: 'ou-1', name: 'Fachschaftsrat', kind: 'council' },
      { id: 'ou-2', name: 'Referat Finanzen', kind: 'referat' },
      { id: 'ou-3', name: 'Lesekreis', kind: 'group' },
    ])
  })

  it('still sends a non-admin away', async () => {
    await expect(load(event([Role.Member]))).rejects.toMatchObject({ status: 303 })
  })
})
