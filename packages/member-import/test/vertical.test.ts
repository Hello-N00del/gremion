import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { effectiveCapabilities, loadVertical, mergeTerms, planSeed, subsystemsFor, VerticalError, type ExistingUnit } from '../src/index.ts'
import { FIXTURE_DIR, MODULE_NAMES, SRC_DIR, fixtureVertical, sourceFiles, sveltekitImports, verticalLiterals } from './helpers.ts'

const files = (over: Record<string, string> = {}) => (f: string) => over[f] ?? readFileSync(join(FIXTURE_DIR, f), 'utf8')

describe('vertical loader', () => {
  it('loads an id-generic vertical and checks the requested id', () => {
    const v = fixtureVertical()
    expect(v.blueprint.orgUnits).toHaveLength(3)
    expect(() => loadVertical(files(), 'other')).toThrow(/not the requested vertical/)
  })
  it('refuses a blueprintRef (a pointer into code) in any file', () => {
    const manifest = JSON.parse(readFileSync(join(FIXTURE_DIR, 'vertical.json'), 'utf8'))
    expect(() => loadVertical(files({ 'vertical.json': JSON.stringify({ ...manifest, blueprintRef: 'X_BLUEPRINT@1' }) }))).toThrow(VerticalError)
    const bp = JSON.parse(readFileSync(join(FIXTURE_DIR, 'blueprint.json'), 'utf8'))
    bp.orgUnits[0].description = 'SOME_BLUEPRINT@1'
    expect(() => loadVertical(files({ 'blueprint.json': JSON.stringify(bp) }))).toThrow(/reference into a code-side blueprint registry/)
  })
  it('refuses broken data: two roots, unknown parent, unknown field, a role that grants and withholds', () => {
    const bp = () => JSON.parse(readFileSync(join(FIXTURE_DIR, 'blueprint.json'), 'utf8'))
    const two = bp()
    two.orgUnits[1].parentKey = null
    expect(() => loadVertical(files({ 'blueprint.json': JSON.stringify(two) }))).toThrow(/exactly one root/)
    const orphan = bp()
    orphan.orgUnits[2].parentKey = 'ghost'
    expect(() => loadVertical(files({ 'blueprint.json': JSON.stringify(orphan) }))).toThrow(/unknown parent/)
    const extra = bp()
    extra.orgUnits[0].surprise = true
    expect(() => loadVertical(files({ 'blueprint.json': JSON.stringify(extra) }))).toThrow()
    const roles = JSON.parse(readFileSync(join(FIXTURE_DIR, 'roles.json'), 'utf8'))
    roles.roles[0].withheld = ['gov.vote.cast']
    expect(() => loadVertical(files({ 'roles.json': JSON.stringify(roles) }))).toThrow(/grants and withholds/)
  })
})

describe('roles: helper capability read-back', () => {
  it('five granted, four withheld; the board ids are inert data, never an error', () => {
    const v = fixtureVertical()
    const helper = v.roles.roles.find((r) => r.key === 'helper')!
    expect(effectiveCapabilities(v.roles, 'helper')).toEqual(['gov.nonpublic.read', 'gov.agenda_item.propose', 'gov.motion.propose', 'brd.card.own', 'brd.card.be_assigned'])
    expect(helper.withheld).toEqual(['gov.vote.cast', 'gov.quorum.count', 'gov.office.hold', 'gov.portfolio.hold'])
    expect(effectiveCapabilities(v.roles, 'helper').some((c) => helper.withheld.includes(c))).toBe(false)
  })
})

describe('seed plan', () => {
  const bp = fixtureVertical().blueprint
  const root: ExistingUnit = { id: 'root', parentId: null, name: 'My Council', childTerm: null, wantsMatrixRoom: false, wantsNextcloudFolder: false }

  it('adopts the root (name kept), creates the rest parents-first', () => {
    const ops = planSeed(bp, [root], { messaging: true, files: true })
    expect(ops.map((o) => `${o.type}:${o.key}`)).toEqual(['adopt-root:assembly', 'create:board', 'create:ops'])
    expect(ops[0]).toMatchObject({ patch: { childTerm: 'Teams', wantsMatrixRoom: true, wantsNextcloudFolder: true } })
  })
  it('D-8: with messaging and files OFF no unit wants a matrix room or a folder (no projection rows)', () => {
    const ops = planSeed(bp, [root], { messaging: false, files: false })
    for (const o of ops) {
      const w = o.type === 'adopt-root' ? o.patch : o.type === 'create' ? o.data : null
      if (w) expect(subsystemsFor(w)).toEqual(['keycloak'])
    }
    expect(ops[0]).toMatchObject({ type: 'adopt-root', patch: { wantsMatrixRoom: false, wantsNextcloudFolder: false } })
  })
  it('D-8: messaging on, files off writes only the matrix flag', () => {
    const ops = planSeed(bp, [root], { messaging: true, files: false })
    expect(ops[0]).toMatchObject({ patch: { wantsMatrixRoom: true, wantsNextcloudFolder: false } })
    expect(ops.find((o) => o.type === 'create' && o.key === 'ops')).toMatchObject({ data: { wantsMatrixRoom: false, wantsNextcloudFolder: false } })
  })
  it('a rerun over a seeded tree is all `present`', () => {
    const tree: ExistingUnit[] = [
      { ...root, childTerm: 'Teams', wantsMatrixRoom: true, wantsNextcloudFolder: true },
      { id: 'b', parentId: 'root', name: 'executive', childTerm: null, wantsMatrixRoom: true, wantsNextcloudFolder: false },
      { id: 'o', parentId: 'b', name: 'Operations', childTerm: null, wantsMatrixRoom: false, wantsNextcloudFolder: true },
    ]
    expect(planSeed(bp, tree, { messaging: true, files: true }).every((o) => o.type === 'present')).toBe(true)
  })
  it('refuses a customer with two roots', () => {
    expect(() => planSeed(bp, [root, { ...root, id: 'r2' }], { messaging: true, files: true })).toThrow(/top-level bodies/)
  })
  it('the vertical never overrides an operator term (terms merge keeps the tenant value)', () => {
    expect(mergeTerms({ 'unit.plural': 'Eigene' }, { 'unit.plural': 'Gremien', 'member.singular': 'Teilnehmer' })).toEqual({ 'unit.plural': 'Eigene', 'member.singular': 'Teilnehmer' })
  })
})

describe('source ratchets (walk packages/member-import/src only)', () => {
  const src = sourceFiles(SRC_DIR)
  it('collects source files', () => expect(src.length).toBeGreaterThan(5))
  it('SvelteKit-import guard: no $lib, $app, $env, @sveltejs or app-tree import', () => {
    for (const f of src) expect(sveltekitImports(readFileSync(f, 'utf8')), f).toEqual([])
    // guard efficacy: the scanner flags a seeded violation
    expect(sveltekitImports(`import { x } from '$lib/server/db'`)).toEqual(['$lib/server/db'])
    expect(sveltekitImports(`import { y } from '@sveltejs/kit'`)).toHaveLength(1)
  })
  it('vertical-literal ratchet: the core spells no vertical', () => {
    for (const f of src) expect(verticalLiterals(readFileSync(f, 'utf8')), f).toEqual([])
    expect(verticalLiterals('const root = "Studierendenrat"')).toEqual(['Studierend'])
  })
  it('module-blind: the import core imports and names no module path', () => {
    for (const f of src) expect(readFileSync(f, 'utf8').match(MODULE_NAMES), f).toBeNull()
    expect(MODULE_NAMES.test("import x from '../../modules/board/index'")).toBe(true)
  })
})
