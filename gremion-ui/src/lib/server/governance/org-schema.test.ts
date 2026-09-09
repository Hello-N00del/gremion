// org-schema.test.ts — P2.2-data (#202) Task 4: pure validators for the
// data-driven org schema (no DB; loadOrgSchema is integration-covered post-#249).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import {
  GREMION_ORG_SCHEMA, validateRootCounts, validateCreatePlacement, orgSchemaFromRows,
  orgSchemaFromBlueprint
} from './org-schema'

describe('validateRootCounts', () => {
  it('passes the StuRa shape: exactly one council root', () => {
    expect(validateRootCounts(GREMION_ORG_SCHEMA, new Map([['council', 1]]))).toEqual([])
  })
  it('rejects two council roots (root_max 1)', () => {
    expect(validateRootCounts(GREMION_ORG_SCHEMA, new Map([['council', 2]]))[0])
      .toMatch(/at most 1 root .* 'council'/)
  })
  it('rejects zero council roots (root_min 1)', () => {
    expect(validateRootCounts(GREMION_ORG_SCHEMA, new Map())[0])
      .toMatch(/at least 1 root .* 'council'/)
  })
  it('allows unbounded group roots alongside the council root', () => {
    expect(validateRootCounts(GREMION_ORG_SCHEMA, new Map([['council', 1], ['group', 7]]))).toEqual([])
  })
  it('rejects a root of a kind that cannot be root', () => {
    expect(validateRootCounts(GREMION_ORG_SCHEMA, new Map([['council', 1], ['committee', 1]]))[0])
      .toMatch(/'committee' cannot be a root/)
  })
})

describe('validateCreatePlacement', () => {
  it('allows committee under council', () => {
    expect(validateCreatePlacement(GREMION_ORG_SCHEMA, 'committee', 'council')).toBeNull()
  })
  it('rejects committee at top level (cannot be root)', () => {
    expect(validateCreatePlacement(GREMION_ORG_SCHEMA, 'committee', null))
      .toMatch(/'committee' cannot be a root/)
  })
  it('allows a standalone top-level group', () => {
    expect(validateCreatePlacement(GREMION_ORG_SCHEMA, 'group', null)).toBeNull()
  })
  it('rejects council under committee (council has no allowed parents)', () => {
    expect(validateCreatePlacement(GREMION_ORG_SCHEMA, 'council', 'committee'))
      .toMatch(/'council' cannot be created under/)
  })
  it('rejects an unknown kind', () => {
    expect(validateCreatePlacement(GREMION_ORG_SCHEMA, 'fraktion', null)).toMatch(/unknown kind/)
  })
})

describe('orgSchemaFromRows', () => {
  it('round-trips catalog rows into an OrgSchema keyed by kind', () => {
    const s = orgSchemaFromRows([{
      key: 'council', label: 'Gemeinderat', child_term: null,
      allowed_parent_kinds: [], can_be_root: true, root_min: 1, root_max: 1, sort_order: 0
    }])
    expect(s.kinds['council']!.label).toBe('Gemeinderat')
  })
})

describe('orgSchemaFromBlueprint', () => {
  it('builds an OrgSchema from blueprint kinds (explicit values kept)', () => {
    const s = orgSchemaFromBlueprint([{
      key: 'council', label: 'Gemeinderat', childTerm: 'Ausschüsse',
      allowedParentKinds: [], canBeRoot: true, rootMin: 1, rootMax: 1, sortOrder: 5
    }])
    expect(s.kinds['council']).toEqual({
      key: 'council', label: 'Gemeinderat', childTerm: 'Ausschüsse',
      allowedParentKinds: [], canBeRoot: true, rootMin: 1, rootMax: 1, sortOrder: 5
    })
  })
  it('defaults childTerm→null, rootMin→0, rootMax→unbounded, sortOrder→array position', () => {
    const s = orgSchemaFromBlueprint([
      { key: 'a', label: 'A', allowedParentKinds: [], canBeRoot: true },
      { key: 'b', label: 'B', allowedParentKinds: ['a'], canBeRoot: false }
    ])
    expect(s.kinds['a']).toEqual({
      key: 'a', label: 'A', childTerm: null, allowedParentKinds: [],
      canBeRoot: true, rootMin: 0, rootMax: null, sortOrder: 0
    })
    expect(s.kinds['b']!.sortOrder).toBe(1)
  })
})

describe('GREMION_ORG_SCHEMA pins the 038 catalog seed', () => {
  // D-RB drift guard: the TS default MUST mirror the migration's INSERT
  // exactly. Read the SQL as text and assert each seeded tuple, built from
  // the TS constant, appears — so changing either side alone fails here.
  const sql = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..',
      'migrations', '038_org_unit_kind_catalog.sql'),
    'utf-8'
  )
  const lit = (v: string | null) => (v === null ? 'NULL' : `'${v}'`)
  const intLit = (v: number | null) => (v === null ? 'NULL' : String(v))

  for (const def of Object.values(GREMION_ORG_SCHEMA.kinds)) {
    it(`seeds kind '${def.key}' with the schema's exact values`, () => {
      const tuple = [
        `\\('${def.key}'`,
        lit(def.label).replace(/[{}]/g, '\\$&'),
        lit(def.childTerm),
        `'\\{${def.allowedParentKinds.join(',')}\\}'`,
        String(def.canBeRoot),
        intLit(def.rootMin),
        intLit(def.rootMax),
        `${intLit(def.sortOrder)}\\)`,
      ].join(',\\s*')
      expect(sql).toMatch(new RegExp(tuple))
    })
  }

  it('seeds exactly the schema kinds — no extra or missing catalog rows', () => {
    const insert = sql.match(/INSERT INTO org_unit_kind[\s\S]*?;/)![0]
    const seededKeys = [...insert.matchAll(/^\s*\('([a-z_]+)'/gm)].map((m) => m[1]).sort()
    expect(seededKeys).toEqual(Object.keys(GREMION_ORG_SCHEMA.kinds).sort())
  })
})
