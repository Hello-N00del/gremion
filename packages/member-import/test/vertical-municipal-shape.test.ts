// A vertical may carry the two blueprint sections a code-side blueprint used to own:
// `demoSeeder` (which demo set the opt-in demo path seeds) and `caucuses` (the Fraktion
// structure; the people stay out of data). A vertical that declares its own kind catalogue
// may also have several top-level bodies, bounded per kind by rootMin/rootMax.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadVertical, planSeed, SeedRefused, type ExistingUnit } from '../src/index.ts'
import { FIXTURE_DIR } from './helpers.ts'

const base = () => JSON.parse(readFileSync(join(FIXTURE_DIR, 'blueprint.json'), 'utf8')) as Record<string, any>
const load = (bp: unknown) =>
  loadVertical((f) => (f === 'blueprint.json' ? JSON.stringify(bp) : readFileSync(join(FIXTURE_DIR, f), 'utf8')), 'fixture')

const unit = (key: string, kind: string, parentKey: string | null) => ({
  key, name: key, description: null, kind, parentKey, visibility: 'all_members', wantsMatrixRoom: false, wantsNextcloudFolder: false,
})
const multiRoot = () => ({
  schema_version: 1,
  orgSchema: [
    { key: 'council', label: 'Council', allowedParentKinds: [], canBeRoot: true, rootMin: 1, rootMax: 1, sortOrder: 0 },
    { key: 'administration', label: 'Administration', allowedParentKinds: [], canBeRoot: true, rootMin: 1, rootMax: 1, sortOrder: 1 },
    { key: 'district', label: 'District', allowedParentKinds: [], canBeRoot: true, rootMin: 0, rootMax: null, sortOrder: 2 },
    { key: 'committee', label: 'Committee', allowedParentKinds: ['council'], canBeRoot: false, rootMin: 0, rootMax: 0, sortOrder: 3 },
  ],
  orgUnits: [
    unit('gr', 'council', null), unit('vw', 'administration', null), unit('d1', 'district', null), unit('d2', 'district', null),
    unit('ha', 'committee', 'gr'),
  ],
  seats: [],
})

describe('blueprint.demoSeeder and blueprint.caucuses', () => {
  it('carries a valid demoSeeder and caucus structure through the loader', () => {
    const bp = { ...multiRoot(), demoSeeder: 'municipal', caucuses: { policy: { min_size: 2 }, caucuses: [{ key: 'fa', councilOrgUnitKey: 'gr', name: 'Fraktion A', color: '#e11d48', members: [] }] } }
    const v = load(bp)
    expect(v.blueprint.demoSeeder).toBe('municipal')
    expect(v.blueprint.caucuses?.caucuses[0]?.key).toBe('fa')
  })
  it('stays strict: malformed demoSeeder, unknown caucus field, a caucus on an unknown council, a duplicate caucus key', () => {
    expect(() => load({ ...base(), demoSeeder: 'Not A Key' })).toThrow()
    expect(() => load({ ...base(), caucuses: { caucuses: [{ key: 'a', councilOrgUnitKey: 'assembly', name: 'A', members: [], surprise: 1 }] } })).toThrow()
    expect(() => load({ ...base(), caucuses: { caucuses: [{ key: 'a', councilOrgUnitKey: 'ghost', name: 'A', members: [] }] } })).toThrow(/unknown council/)
    const dup = { key: 'a', councilOrgUnitKey: 'assembly', name: 'A', members: [] }
    expect(() => load({ ...base(), caucuses: { caucuses: [dup, dup] } })).toThrow(/appears twice/)
  })
})

describe('several top-level bodies (per-kind root bounds)', () => {
  it('loads four roots when the kind catalogue allows them', () => {
    expect(load(multiRoot()).blueprint.orgUnits.filter((u) => u.parentKey === null)).toHaveLength(4)
  })
  it('refuses a second root of a kind capped at one, a missing required root, and a root of a non-root kind', () => {
    const two = multiRoot(); two.orgUnits.push(unit('gr2', 'council', null))
    expect(() => load(two)).toThrow(/root/)
    const none = multiRoot(); none.orgUnits = none.orgUnits.filter((u) => u.kind !== 'administration')
    expect(() => load(none)).toThrow(/root/)
    const bad = multiRoot(); bad.orgUnits.push(unit('c2', 'committee', null))
    expect(() => load(bad)).toThrow(/root/)
  })
  it('without a kind catalogue exactly one root is still required', () => {
    const two = base(); two.orgUnits[1].parentKey = null
    expect(() => load(two)).toThrow(/exactly one root/)
  })
})

describe('planSeed with several top-level bodies', () => {
  const bp = load(multiRoot()).blueprint
  const mods = { messaging: false, files: false }
  const root: ExistingUnit = { id: 'r1', parentId: null, name: 'Mein Rat', childTerm: null, wantsMatrixRoom: false, wantsNextcloudFolder: false }

  it('adopts the one existing root for the first body and creates the other roots', () => {
    const ops = planSeed(bp, [root], mods).map((o) => `${o.type}:${'key' in o ? o.key : ''}`)
    expect(ops).toEqual(expect.arrayContaining(['present:gr', 'create:vw', 'create:d1', 'create:d2', 'create:ha']))
    expect(ops.filter((o) => o.endsWith(':gr'))).toHaveLength(1)
  })
  it('on an empty customer creates every root', () => {
    const ops = planSeed(bp, [], mods)
    expect(ops.filter((o) => o.type === 'create' && o.parentKey === null)).toHaveLength(4)
  })
  it('a second run (all four roots exist) matches them by name and creates nothing', () => {
    const names = ['gr', 'vw', 'd1', 'd2']
    const existing: ExistingUnit[] = names.map((n, i) => ({ id: `r${i}`, parentId: null, name: n, childTerm: null, wantsMatrixRoom: false, wantsNextcloudFolder: false }))
    const ha: ExistingUnit = { id: 'h', parentId: 'r0', name: 'ha', childTerm: null, wantsMatrixRoom: false, wantsNextcloudFolder: false }
    expect(planSeed(bp, [...existing, ha], mods).filter((o) => o.type === 'create')).toEqual([])
  })
  it('still refuses more existing roots than the blueprint has', () => {
    const extra = [0, 1, 2, 3, 4].map((i) => ({ ...root, id: `x${i}`, name: `x${i}` }))
    expect(() => planSeed(bp, extra, mods)).toThrow(SeedRefused)
  })
})
