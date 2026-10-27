// P2.3 (#202) T3 — blueprint-registry unit tests.
// The pure ref → blueprint lookup the per-tenant seed path uses to feed a
// non-default tenant ITS OWN blueprint. A vertical's blueprint is DATA
// (verticals/<id>/blueprint.json, read through @gremion/member-import's
// loadVertical); the kernel default is a neutral one with no vertical in it.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { loadVertical } from '@gremion/member-import'
import { resolveBlueprint, DEFAULT_BLUEPRINT_REF, KERNEL_BLUEPRINT_REF } from './blueprint-registry'
import { MUNICIPAL_BLUEPRINT } from './municipal-blueprint'
import { parseBlueprintDocument } from './blueprint-schema'

const STURA_DIR = join(import.meta.dirname, '..', '..', '..', '..', '..', 'verticals', 'stura')
const stura = loadVertical((f) => readFileSync(join(STURA_DIR, f), 'utf8'), 'stura')

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

  it('resolves the municipal ref to the municipal blueprint', () => {
    expect(resolveBlueprint('MUNICIPAL_BLUEPRINT@1')).toBe(MUNICIPAL_BLUEPRINT)
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

  it('refuses a path-shaped ref (no traversal out of the verticals directory)', () => {
    expect(() => resolveBlueprint('../STURA_BLUEPRINT@1')).toThrow(/unknown blueprint ref/i)
  })
})
