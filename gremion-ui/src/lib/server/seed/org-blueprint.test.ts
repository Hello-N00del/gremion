import { describe, it, expect } from 'vitest'
import { validateBlueprint, type OrgBlueprint } from './org-blueprint'
import { GREMION_ORG_SCHEMA, type OrgSchema } from '../governance/org-schema'

function base(): OrgBlueprint {
  return {
    schema_version: 1,
    users: [
      { username: 'a.one', firstName: 'A', lastName: 'One', email: 'a.one@council.example', realmRole: 'member' }
    ],
    orgUnits: [
      { key: 'root', name: 'Root', description: null, kind: 'council', parentKey: null,
        visibility: 'all_members', wantsMatrixRoom: true, wantsNextcloudFolder: true }
    ],
    memberships: [
      { userKey: 'a.one', orgUnitKey: 'root', membershipType: 'elected', termStart: null, termEnd: null }
    ],
    roles: [
      { key: 'r1', orgUnitKey: 'root', name: 'Chair', electionMethod: 'manual', isElected: false }
    ],
    assignments: [
      { roleKey: 'r1', userKey: 'a.one', startDate: '2026-01-01', endDate: '2026-12-31' }
    ]
    // Carve note: no finance section — the finance feature module is not part of
    // the governance-only kernel, so GremionBlueprint no longer carries `finance`.
  }
}

describe('validateBlueprint', () => {
  it('returns no errors for a valid blueprint', () => {
    expect(validateBlueprint(base())).toEqual([])
  })

  it('flags a dangling parentKey', () => {
    const bp = base()
    bp.orgUnits.push({ key: 'child', name: 'C', description: null, kind: 'group',
      parentKey: 'missing', visibility: 'all_members', wantsMatrixRoom: true, wantsNextcloudFolder: true })
    expect(validateBlueprint(bp).join(' ')).toContain('parentKey')
  })

  it('flags a duplicate username', () => {
    const bp = base()
    bp.users.push({ ...bp.users[0] })
    expect(validateBlueprint(bp).join(' ')).toContain('username')
  })

  it('flags two council roots (root_max 1)', () => {
    const bp = base()
    bp.orgUnits.push({ key: 'root2', name: 'R2', description: null, kind: 'council',
      parentKey: null, visibility: 'all_members', wantsMatrixRoom: true, wantsNextcloudFolder: true })
    expect(validateBlueprint(bp).join(' ')).toMatch(/at most 1 root .* 'council'/)
  })

  it('flags a single committee root with two errors (cannot be root + council root_min unmet)', () => {
    const bp = base()
    bp.orgUnits[0].kind = 'committee'
    const errors = validateBlueprint(bp)
    expect(errors).toHaveLength(2)
    expect(errors.join(' ')).toMatch(/'committee' cannot be a root/)
    expect(errors.join(' ')).toMatch(/at least 1 root .* 'council'/)
  })

  it('accepts one council root plus a standalone top-level group (runtime parity, D-RB)', () => {
    const bp = base()
    bp.orgUnits.push({ key: 'ag-solo', name: 'AG Solo', description: null, kind: 'group',
      parentKey: null, visibility: 'all_members', wantsMatrixRoom: true, wantsNextcloudFolder: true })
    expect(validateBlueprint(bp)).toEqual([])
  })

  it('flags a unit with an unknown kind', () => {
    const bp = base()
    bp.orgUnits.push({ key: 'frak1', name: 'Fraktion 1', description: null, kind: 'fraktion',
      parentKey: 'root', visibility: 'all_members', wantsMatrixRoom: true, wantsNextcloudFolder: true })
    expect(validateBlueprint(bp).join(' ')).toMatch(/unknown kind: 'fraktion'/)
  })

  it('flags a committee whose parent is a group (allowed parents: council, committee)', () => {
    const bp = base()
    bp.orgUnits.push({ key: 'g1', name: 'G1', description: null, kind: 'group',
      parentKey: 'root', visibility: 'all_members', wantsMatrixRoom: true, wantsNextcloudFolder: true })
    bp.orgUnits.push({ key: 'c1', name: 'C1', description: null, kind: 'committee',
      parentKey: 'g1', visibility: 'all_members', wantsMatrixRoom: true, wantsNextcloudFolder: true })
    expect(validateBlueprint(bp).join(' '))
      .toMatch(/kind 'committee' cannot be created under kind 'group'/)
  })

  it('flags a parent cycle', () => {
    const bp = base()
    bp.orgUnits[0].parentKey = 'root' // self-parent
    expect(validateBlueprint(bp).join(' ')).toContain('cycle')
  })

  it('flags a dangling membership reference', () => {
    const bp = base()
    bp.memberships[0].userKey = 'nobody'
    expect(validateBlueprint(bp).join(' ')).toContain('membership')
  })

  it('flags a dangling assignment reference', () => {
    const bp = base()
    bp.assignments[0].roleKey = 'nope'
    expect(validateBlueprint(bp).join(' ')).toContain('assignment')
  })
})

describe('validateBlueprint — caucus integrity (in-memory mirror of the D-CD constraints)', () => {
  function withCaucuses(): OrgBlueprint {
    const bp = base()
    bp.caucuses = {
      caucuses: [
        { key: 'f1', councilOrgUnitKey: 'root', name: 'Fraktion A', members: [{ userKey: 'a.one' }] }
      ]
    }
    return bp
  }

  it('accepts a valid caucus section', () => {
    expect(validateBlueprint(withCaucuses())).toEqual([])
  })

  it('flags a caucus referencing an unknown councilOrgUnitKey', () => {
    const bp = withCaucuses()
    bp.caucuses!.caucuses[0]!.councilOrgUnitKey = 'missing'
    expect(validateBlueprint(bp).join(' '))
      .toMatch(/caucus f1 references unknown org-unit: missing/)
  })

  it('flags a caucus member with an unknown userKey', () => {
    const bp = withCaucuses()
    bp.caucuses!.caucuses[0]!.members[0]!.userKey = 'nobody'
    expect(validateBlueprint(bp).join(' '))
      .toMatch(/caucus f1 member references unknown user: nobody/)
  })

  it('flags the same user in two caucuses of the same council', () => {
    const bp = withCaucuses()
    bp.caucuses!.caucuses.push({ key: 'f2', councilOrgUnitKey: 'root', name: 'Fraktion B',
      members: [{ userKey: 'a.one' }] })
    expect(validateBlueprint(bp).join(' ')).toMatch(/one caucus per member per council/)
  })

  it('accepts the same user in caucuses of two DIFFERENT councils', () => {
    // The one-faction rule is scoped per council (UNIQUE(council_org_unit_id,
    // user_keycloak_id)) — a second council needs a schema that allows it.
    const twoCouncilSchema: OrgSchema = {
      kinds: {
        ...GREMION_ORG_SCHEMA.kinds,
        council: { ...GREMION_ORG_SCHEMA.kinds['council']!, rootMax: 2 }
      }
    }
    const bp = withCaucuses()
    bp.orgUnits.push({ key: 'root2', name: 'Second Council', description: null, kind: 'council',
      parentKey: null, visibility: 'all_members', wantsMatrixRoom: true, wantsNextcloudFolder: true })
    bp.caucuses!.caucuses.push({ key: 'f2', councilOrgUnitKey: 'root2', name: 'Fraktion B',
      members: [{ userKey: 'a.one' }] })
    expect(validateBlueprint(bp, twoCouncilSchema)).toEqual([])
  })

  it('flags a duplicate caucus key', () => {
    const bp = withCaucuses()
    bp.caucuses!.caucuses.push({ key: 'f1', councilOrgUnitKey: 'root', name: 'Fraktion B',
      members: [] })
    expect(validateBlueprint(bp).join(' ')).toMatch(/duplicate caucus key: f1/)
  })
})

import { STURA_BLUEPRINT } from './org-blueprint'

describe('STURA_BLUEPRINT', () => {
  it('is internally valid', () => {
    expect(validateBlueprint(STURA_BLUEPRINT)).toEqual([])
  })
  it('has the expected counts', () => {
    expect(STURA_BLUEPRINT.users).toHaveLength(15)
    expect(STURA_BLUEPRINT.orgUnits).toHaveLength(11)
    expect(STURA_BLUEPRINT.memberships).toHaveLength(32)
    expect(STURA_BLUEPRINT.roles).toHaveLength(8)
    expect(STURA_BLUEPRINT.assignments).toHaveLength(8)
  })
  it('pins tenant #1: exactly 1 root org-unit and its kind is council', () => {
    const roots = STURA_BLUEPRINT.orgUnits.filter((o) => o.parentKey === null)
    expect(roots).toHaveLength(1)
    expect(roots[0]!.kind).toBe('council')
  })

  it('defines a 3-layer hierarchy with child_term on the council', () => {
    const bp = STURA_BLUEPRINT
    const council = bp.orgUnits.find((o) => o.kind === 'council')!
    expect(council.parentKey).toBeNull()
    expect(council.childTerm).toBeTruthy()
    const l2 = bp.orgUnits.filter((o) => o.parentKey === council.key)
    expect(l2.length).toBeGreaterThanOrEqual(2)
    const l2keys = new Set(l2.map((o) => o.key))
    const l3 = bp.orgUnits.filter((o) => o.parentKey && l2keys.has(o.parentKey))
    expect(l3.length).toBeGreaterThanOrEqual(1)
  })
})
