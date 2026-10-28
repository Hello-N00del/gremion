// P2.3 (#202) T3 — blueprint-registry unit tests.
// The pure ref → blueprint lookup the per-tenant seed path uses to feed a
// non-default tenant ITS OWN blueprint. A vertical's blueprint is DATA
// (verticals/<id>/blueprint.json, read through @gremion/member-import's
// loadVertical); the kernel default is a neutral one with no vertical in it.
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { loadVertical } from '@gremion/member-import'
import { resolveBlueprint, DEFAULT_BLUEPRINT_REF, KERNEL_BLUEPRINT_REF } from './blueprint-registry'
import { MUNICIPAL_BLUEPRINT } from './municipal-fixture'
import { parseBlueprintDocument } from './blueprint-schema'

const STURA_DIR = join(import.meta.dirname, '..', '..', '..', '..', '..', 'verticals', 'stura')
const stura = loadVertical((f) => readFileSync(join(STURA_DIR, f), 'utf8'), 'stura')
const MUNICIPAL_DIR = join(import.meta.dirname, '..', '..', '..', '..', '..', 'verticals', 'municipal')
const municipal = loadVertical((f) => readFileSync(join(MUNICIPAL_DIR, f), 'utf8'), 'municipal')

describe('resolveBlueprint', () => {
  it('serves STURA_BLUEPRINT@1 from verticals/stura data (tree, offices, kinds)', () => {
    const bp = resolveBlueprint('STURA_BLUEPRINT@1')
    expect(bp.orgUnits).toEqual(stura.blueprint.orgUnits)
    expect(bp.roles).toEqual(stura.blueprint.seats)
    expect(bp.orgSchema).toEqual(stura.blueprint.orgSchema)
    expect(bp.orgUnits).toHaveLength(11)
  })

  it('the data-served StuRa blueprint validates through the same two-layer path', () => {
    const r = parseBlueprintDocument(resolveBlueprint('STURA_BLUEPRINT@1'))
    expect(r).toMatchObject({ ok: true })
  })

  it('serves MUNICIPAL_BLUEPRINT@1 from verticals/municipal data (tree, kinds, Fraktionen, demo set; no people)', () => {
    const bp = resolveBlueprint('MUNICIPAL_BLUEPRINT@1')
    expect(bp.orgUnits).toEqual(municipal.blueprint.orgUnits)
    expect(bp.orgSchema).toEqual(municipal.blueprint.orgSchema)
    expect(bp.demoSeeder).toBe('municipal')
    expect(bp.caucuses).toEqual(municipal.blueprint.caucuses)
    expect(bp.caucuses?.caucuses).toHaveLength(3)
    expect(bp.orgUnits.filter((o) => o.parentKey === null)).toHaveLength(4)
    expect(bp.users).toEqual([])
    expect(bp.memberships).toEqual([])
    expect(bp.caucuses?.caucuses.every((c) => c.members.length === 0)).toBe(true)
    expect(parseBlueprintDocument(bp)).toMatchObject({ ok: true })
  })

  it('the data-served StuRa blueprint keeps the default demo set (no demoSeeder)', () => {
    expect(resolveBlueprint('STURA_BLUEPRINT@1').demoSeeder).toBeUndefined()
  })

  it('the people fixture layers on the municipal data tree', () => {
    expect(MUNICIPAL_BLUEPRINT.orgUnits).toEqual(resolveBlueprint('MUNICIPAL_BLUEPRINT@1').orgUnits)
    expect(MUNICIPAL_BLUEPRINT.users.some((u) => u.username === 'dev.admin')).toBe(true)
  })

  it('the default ref is the neutral kernel blueprint, not a vertical', () => {
    expect(DEFAULT_BLUEPRINT_REF).toBe(KERNEL_BLUEPRINT_REF)
    expect(DEFAULT_BLUEPRINT_REF).toBe('KERNEL_BLUEPRINT@1')
    const bp = resolveBlueprint(DEFAULT_BLUEPRINT_REF)
    expect(bp.users).toEqual([])
    expect(bp.memberships).toEqual([])
    expect(bp.roles).toEqual([])
    expect(bp.orgUnits).toHaveLength(1)
    expect(bp.orgUnits[0].parentKey).toBeNull()
    expect(parseBlueprintDocument(bp)).toMatchObject({ ok: true })
    expect(JSON.stringify(bp)).not.toMatch(/stura|studierenden/i)
  })

  it('throws loudly on an unknown ref (no silent fall-through)', () => {
    expect(() => resolveBlueprint('NOPE@9')).toThrow(/unknown blueprint ref/i)
  })

  it('refuses a well-formed ref whose vertical data does not exist', () => {
    expect(() => resolveBlueprint('NOSUCHVERTICAL_BLUEPRINT@1')).toThrow(/unknown blueprint ref/i)
  })

  it('refuses vertical data that names a demo set the kernel does not have', () => {
    const root = mkdtempSync(join(tmpdir(), 'verticals-'))
    cpSync(MUNICIPAL_DIR, join(root, 'odd'), { recursive: true })
    const manifestPath = join(root, 'odd', 'vertical.json')
    writeFileSync(manifestPath, readFileSync(manifestPath, 'utf8').replace('"municipal"', '"odd"'))
    const bpPath = join(root, 'odd', 'blueprint.json')
    writeFileSync(bpPath, readFileSync(bpPath, 'utf8').replace('"demoSeeder": "municipal"', '"demoSeeder": "elsewhere"'))
    const prev = process.env.GREMION_VERTICALS_DIR
    process.env.GREMION_VERTICALS_DIR = root
    try {
      expect(() => resolveBlueprint('ODD_BLUEPRINT@1')).toThrow(/demo/i)
    } finally {
      if (prev === undefined) delete process.env.GREMION_VERTICALS_DIR
      else process.env.GREMION_VERTICALS_DIR = prev
    }
  })

  it('refuses a path-shaped ref (no traversal out of the verticals directory)', () => {
    expect(() => resolveBlueprint('../STURA_BLUEPRINT@1')).toThrow(/unknown blueprint ref/i)
  })
})
