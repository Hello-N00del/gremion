// The new-unit form offers the kinds of the customer's own catalogue (org_unit_kind) and lets the
// person pick a parent from every unit the server would accept for the chosen kind. The load hands
// the form the catalogue (in its sort order) and every unit with its kind; which units may be a
// parent of which kind is decided by the catalogue's allowedParentKinds, the same rule
// validateCreatePlacement applies when the form is submitted.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Role } from '$lib/auth'
import type { OrgSchema } from '$lib/server/governance/org-schema'

const h = vi.hoisted(() => ({
  listOrgUnits: vi.fn(),
  loadOrgSchema: vi.fn(),
  createOrgUnit: vi.fn(),
  getOrgUnit: vi.fn(),
  provisionOrgUnit: vi.fn(),
}))

vi.mock('$lib/server/governance/org-units-db', () => ({
  listOrgUnits: h.listOrgUnits,
  createOrgUnit: h.createOrgUnit,
  deleteOrgUnit: vi.fn(),
  getOrgUnit: h.getOrgUnit,
}))
vi.mock('$lib/server/governance/provisioning/orchestrator', () => ({
  provisionOrgUnit: h.provisionOrgUnit,
  deprovisionOrgUnit: vi.fn(),
  wantedSubsystems: vi.fn().mockReturnValue([]),
}))
vi.mock('$lib/server/governance/provisioning/ledger', () => ({ enqueueResources: vi.fn() }))
vi.mock('$lib/server/db', () => ({ getDb: () => ({ begin: async (fn: (tx: object) => unknown) => fn({}) }) }))
vi.mock('$lib/server/audit-db', () => ({ writeAuditEntry: vi.fn() }))
vi.mock('$lib/server/governance/org-schema', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/server/governance/org-schema')>()
  return { ...actual, loadOrgSchema: h.loadOrgSchema }
})

import { load, actions } from './+page.server'

// The catalogue every customer starts with (migration 0038): Gremium, Referat, Gruppe.
const SCHEMA: OrgSchema = {
  kinds: {
    group: { key: 'group', label: 'Gruppe', childTerm: null, allowedParentKinds: ['council', 'committee', 'group'], canBeRoot: true, rootMin: 0, rootMax: null, sortOrder: 2 },
    council: { key: 'council', label: 'Gremium', childTerm: 'Referate', allowedParentKinds: [], canBeRoot: true, rootMin: 1, rootMax: 1, sortOrder: 0 },
    committee: { key: 'committee', label: 'Referat', childTerm: 'Arbeitsgruppen', allowedParentKinds: ['council', 'committee'], canBeRoot: false, rootMin: 0, rootMax: 0, sortOrder: 1 },
  },
}

function event(roles: string[]) {
  return { locals: { auth: async () => ({ user: { id: 'u1', roles, groups: [], email: 'a@example.org', name: 'A' } }) } } as never
}

beforeEach(() => {
  h.loadOrgSchema.mockReset().mockResolvedValue(SCHEMA)
  h.listOrgUnits.mockReset().mockResolvedValue([
    { id: 'ou-1', name: 'Fachschaftsrat', kind: 'council', kind_label: null },
    { id: 'ou-2', name: 'Referat Finanzen', kind: 'committee', kind_label: null },
    { id: 'ou-3', name: 'Lesekreis', kind: 'group', kind_label: 'Initiative' },
    { id: 'ou-4', name: 'Fachschaft Beispiel', kind: 'group', kind_label: 'Fachschaft' },
    { id: 'ou-5', name: 'Vorstand', kind: 'committee', kind_label: 'Vorstand' },
    { id: 'ou-6', name: 'Zweite Fachschaft', kind: 'group', kind_label: 'Fachschaft' },
  ])
})

describe('members/committees/new load', () => {
  it('offers the catalogue kinds in the catalogue order, not a fixed triple', async () => {
    const out = (await load(event([Role.CouncilAdmin]))) as { kinds: { key: string; label: string; canBeRoot: boolean; allowedParentKinds: string[] }[] }
    expect(out.kinds.map((k) => k.key)).toEqual(['council', 'committee', 'group'])
    expect(out.kinds.map((k) => k.label)).toEqual(['Gremium', 'Referat', 'Gruppe'])
    expect(out.kinds[1]).toMatchObject({ canBeRoot: false, allowedParentKinds: ['council', 'committee'] })
  })

  it('hands over every unit with its kind, groups included', async () => {
    const out = (await load(event([Role.CouncilAdmin]))) as { parents: { id: string; name: string; kind: string }[] }
    expect(out.parents.map((p) => [p.id, p.kind])).toEqual([
      ['ou-1', 'council'],
      ['ou-2', 'committee'],
      ['ou-3', 'group'],
      ['ou-4', 'group'],
      ['ou-5', 'committee'],
      ['ou-6', 'group'],
    ])
  })

  it('suggests the display labels the customer already uses, each once, sorted', async () => {
    const out = (await load(event([Role.CouncilAdmin]))) as { kindLabels: string[] }
    expect(out.kindLabels).toEqual(['Fachschaft', 'Initiative', 'Vorstand'])
  })

  it('still sends a non-admin away', async () => {
    await expect(load(event([Role.Member]))).rejects.toMatchObject({ status: 303 })
  })
})

function submit(fields: Record<string, string>) {
  const form = new FormData()
  for (const [k, v] of Object.entries(fields)) form.set(k, v)
  return {
    request: { formData: async () => form },
    locals: { auth: async () => ({ user: { id: 'u1', roles: [Role.CouncilAdmin], groups: [], email: 'a@example.org', name: 'A' } }) },
  } as never
}

async function outcome(fields: Record<string, string>) {
  try {
    return await actions.default(submit(fields))
  } catch (e) {
    return e as { status: number; location?: string }
  }
}

describe('members/committees/new action: the display label', () => {
  beforeEach(() => {
    h.createOrgUnit.mockReset().mockResolvedValue({ id: 'ou-new' })
    h.getOrgUnit.mockReset().mockResolvedValue({ id: 'ou-1', kind: 'council' })
    h.provisionOrgUnit.mockReset().mockResolvedValue({ overall: 'ok', subsystems: [] })
  })

  it('stores a typed label on the unit, trimmed', async () => {
    const res = await outcome({ name: 'Fachschaft Beispiel', kind: 'group', kindLabel: '  Fachschaft ' })
    expect(res).toMatchObject({ status: 303 })
    expect(h.createOrgUnit).toHaveBeenCalledOnce()
    expect(h.createOrgUnit.mock.calls[0]?.[1]).toMatchObject({ kind: 'group', kindLabel: 'Fachschaft' })
  })

  it('stores no label when the field is empty or repeats the kind label', async () => {
    await outcome({ name: 'A', kind: 'group', kindLabel: '   ' })
    await outcome({ name: 'B', kind: 'group', kindLabel: 'Gruppe' })
    await outcome({ name: 'C', kind: 'group' })
    expect(h.createOrgUnit.mock.calls.map((c) => c[1].kindLabel)).toEqual([null, null, null])
  })

  it('refuses a label longer than 40 characters, before anything is created', async () => {
    const res = await outcome({ name: 'A', kind: 'group', kindLabel: 'x'.repeat(41) })
    expect(res).toMatchObject({ status: 400 })
    expect(h.createOrgUnit).not.toHaveBeenCalled()
  })
})
