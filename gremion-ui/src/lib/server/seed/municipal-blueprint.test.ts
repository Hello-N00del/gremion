// P2.3 (#202) T2 — the municipal fixture, promoted to a seedable artifact.
// MUNICIPAL_BLUEPRINT lifts the validated fixture out of municipal-fixture.test.ts
// and adds the dev.admin superuser the seeder hard-requires (seedAssignments /
// seedDevAdminGroups both key on userMap.get('dev.admin')). It must pass BOTH
// validation layers via the same `parseBlueprintDocument` path StuRa uses, while
// STURA_BLUEPRINT keeps validating unchanged (anti-regression — mirrors
// municipal-fixture.test.ts:137).
import { describe, it, expect } from 'vitest'
import { parseBlueprintDocument } from './blueprint-schema'
import { validateBlueprint, STURA_BLUEPRINT } from './org-blueprint'
import { GREMION_ORG_SCHEMA, orgSchemaFromBlueprint } from '../governance/org-schema'
import { MUNICIPAL_BLUEPRINT } from './municipal-blueprint'

describe('MUNICIPAL_BLUEPRINT seedable artifact (P2.3 #202 T2)', () => {
  it('passes BOTH validation layers via parseBlueprintDocument', () => {
    const result = parseBlueprintDocument(MUNICIPAL_BLUEPRINT)
    expect(result.ok ? [] : result.errors).toEqual([])
    expect(result.ok).toBe(true)
  })

  it('has zero integrity errors against its OWN org schema', () => {
    expect(
      validateBlueprint(MUNICIPAL_BLUEPRINT, orgSchemaFromBlueprint(MUNICIPAL_BLUEPRINT.orgSchema!))
    ).toEqual([])
  })

  it('carries a dev.admin user the seeder hard-requires', () => {
    // seedAssignments (seed.ts:312) and seedDevAdminGroups both key on
    // userMap.get('dev.admin'); without it a seed of this blueprint throws.
    const devAdmin = MUNICIPAL_BLUEPRINT.users.find((u) => u.username === 'dev.admin')
    expect(devAdmin).toBeDefined()
    expect(devAdmin!.realmRole).toBe('it-admin')
    // dev.admin must be placed on the Gemeinderat so it can act there.
    expect(
      MUNICIPAL_BLUEPRINT.memberships.some(
        (m) => m.userKey === 'dev.admin' && m.orgUnitKey === 'gemeinderat'
      )
    ).toBe(true)
  })

  it('carries no finance section (governance-only kernel — finance module carved out)', () => {
    expect('finance' in MUNICIPAL_BLUEPRINT).toBe(false)
  })

  it('preserves the municipal shape: multi-root + advisory + non-voting', () => {
    const roots = MUNICIPAL_BLUEPRINT.orgUnits.filter((o) => o.parentKey === null)
    expect(roots).toHaveLength(4)
    expect(new Set(roots.map((o) => o.kind)))
      .toEqual(new Set(['council', 'administration', 'district_council']))
    expect(MUNICIPAL_BLUEPRINT.orgUnits.filter((o) => o.authority === 'advisory')).toHaveLength(1)
    expect(MUNICIPAL_BLUEPRINT.memberships.filter((m) => m.voting === false)).toHaveLength(1)
  })

  it('does not regress tenant #1: STURA_BLUEPRINT validates through the SAME code path', () => {
    const result = parseBlueprintDocument(STURA_BLUEPRINT)
    expect(result.ok ? [] : result.errors).toEqual([])
    expect(result.ok).toBe(true)
    expect(validateBlueprint(STURA_BLUEPRINT, GREMION_ORG_SCHEMA)).toEqual([])
  })
})
