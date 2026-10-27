// gremion-ui/src/lib/server/seed/vertical-parity.test.ts
// TASK-031 G5: verticals/stura/ (the vertical as DATA, read by @gremion/member-import's
// loader; kernel-owned since the operator decision of 2026-10-27) IS the StuRa blueprint:
// the registry serves STURA_BLUEPRINT@1 from it, there is no second copy in code. What this
// file still guards: the data files load, the registry serves exactly the data, and the
// fictional-people fixture (stura-fixture.ts, test-only) stays consistent with the data
// tree it is layered on. The product repo keeps its own guard against ITS fork.
import { readFileSync } from 'node:fs'
import { loadVertical } from '@gremion/member-import'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { STURA_BLUEPRINT } from './stura-fixture'
import { resolveBlueprint } from './blueprint-registry'
import { validateBlueprint } from './org-blueprint'
import { orgSchemaFromBlueprint } from '../governance/org-schema'

const DIR = join(import.meta.dirname, '..', '..', '..', '..', '..', 'verticals', 'stura')
const read = (file: string): unknown => JSON.parse(readFileSync(join(DIR, file), 'utf8'))
// JSON has no `undefined`: compare what a JSON round-trip of the code copy keeps.
const viaJson = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

describe('verticals/stura loads through the kernel loader', () => {
  it('id stura, all four files parse, the blueprint is internally consistent', () => {
    const v = loadVertical((f) => readFileSync(join(DIR, f), 'utf8'), 'stura')
    expect(v.manifest.id).toBe('stura')
    expect(v.blueprint.orgUnits).toHaveLength(11)
    expect(v.blueprint.seats.length).toBeGreaterThan(0)
  })
})

describe('verticals/stura is the StuRa blueprint (G5)', () => {
  const blueprint = read('blueprint.json') as { schema_version: number; orgUnits: unknown[]; seats: unknown[]; orgSchema?: unknown }

  it('vertical.json names its three data files and the id stura', () => {
    expect(read('vertical.json')).toEqual({
      schema_version: 1,
      id: 'stura',
      name: expect.any(String),
      blueprint: 'blueprint.json',
      wording: 'wording.de.json',
      roles: 'roles.json',
    })
  })

  it('the registry serves the data tree and offices unchanged (11 units)', () => {
    const served = resolveBlueprint('STURA_BLUEPRINT@1')
    expect(blueprint.schema_version).toBe(1)
    expect(blueprint.orgUnits).toHaveLength(11)
    expect(served.orgUnits).toEqual(blueprint.orgUnits)
    expect(served.roles).toEqual(blueprint.seats)
    expect(served.orgSchema).toEqual(blueprint.orgSchema)
    expect(served.users).toEqual([])
  })

  it('the people fixture sits on the data tree: it validates, and owns no tree of its own', () => {
    expect(STURA_BLUEPRINT.orgUnits).toEqual(resolveBlueprint('STURA_BLUEPRINT@1').orgUnits)
    const schema = STURA_BLUEPRINT.orgSchema ? orgSchemaFromBlueprint(STURA_BLUEPRINT.orgSchema) : undefined
    expect(validateBlueprint(STURA_BLUEPRINT, schema)).toEqual([])
  })

  it('carries no pointer into code (no blueprintRef, no *_BLUEPRINT token)', () => {
    for (const f of ['vertical.json', 'blueprint.json', 'wording.de.json', 'roles.json']) {
      const text = readFileSync(join(DIR, f), 'utf8')
      expect(text, f).not.toMatch(/blueprint_?ref/i)
      expect(text, f).not.toMatch(/\b[A-Z][A-Z0-9_]*_BLUEPRINT\b/)
    }
  })

  it('wording is a flat string record (StuRa defines no overrides: the code defaults are its terms)', () => {
    const wording = read('wording.de.json') as Record<string, unknown>
    for (const v of Object.values(wording)) expect(typeof v).toBe('string')
  })
})

describe('verticals/stura roles.json: the helper default (PRD-IDN-003)', () => {
  const doc = read('roles.json') as {
    schema_version: number
    roles: Array<{ key: string; importable: boolean; membership_type: string; voting: boolean; capabilities: string[]; withheld: string[] }>
  }
  const role = (k: string) => doc.roles.find((r) => r.key === k)!

  it('member = elected + voting; helper = unelected + non-voting', () => {
    expect(role('member')).toMatchObject({ importable: true, membership_type: 'elected', voting: true })
    expect(role('helper')).toMatchObject({ importable: true, membership_type: 'unelected', voting: false })
  })

  it('five granted, four withheld, no id both granted and withheld', () => {
    const h = role('helper')
    expect(h.capabilities).toEqual(['gov.nonpublic.read', 'gov.agenda_item.propose', 'gov.motion.propose', 'brd.card.own', 'brd.card.be_assigned'])
    expect(h.withheld).toEqual(['gov.vote.cast', 'gov.quorum.count', 'gov.office.hold', 'gov.portfolio.hold'])
    expect(h.capabilities.filter((c) => h.withheld.includes(c))).toEqual([])
  })

  it('role keys are unique', () => {
    const keys = doc.roles.map((r) => r.key)
    expect(new Set(keys).size).toBe(keys.length)
  })
})
