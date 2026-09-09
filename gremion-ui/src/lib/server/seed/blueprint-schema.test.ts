import { describe, it, expect } from 'vitest'
import { parseBlueprintDocument } from './blueprint-schema'
import { STURA_BLUEPRINT } from './org-blueprint'

/** A minimal blueprint document that passes BOTH validation layers. */
function minimalDoc(): Record<string, unknown> {
  return {
    schema_version: 1,
    users: [
      { username: 'a.one', firstName: 'A', lastName: 'One', email: 'a.one@council.example', realmRole: 'member' }
    ],
    orgUnits: [
      { key: 'root', name: 'Root', description: null, kind: 'council', parentKey: null,
        visibility: 'all_members', wantsMatrixRoom: true, wantsNextcloudFolder: true }
    ],
    memberships: [],
    roles: [],
    assignments: []
    // Carve note: no finance section — the finance feature module is not part of
    // the governance-only kernel, and blueprintDocumentSchema (strict) now rejects
    // a `finance` key, so the minimal valid document carries none.
  }
}

describe('parseBlueprintDocument — layer 1 (zod strict shape)', () => {
  it('parses a valid minimal document', () => {
    const r = parseBlueprintDocument(minimalDoc())
    expect(r).toEqual({ ok: true, bp: expect.anything() })
  })

  it('rejects an unknown top-level property (strict)', () => {
    const r = parseBlueprintDocument({ ...minimalDoc(), bogusSection: true })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/bogusSection/)
  })

  it('rejects an unknown org-unit property (strict)', () => {
    const doc = minimalDoc()
    ;(doc.orgUnits as Record<string, unknown>[])[0]!.sniffMe = 'x'
    const r = parseBlueprintDocument(doc)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/sniffMe/)
  })

  it('rejects a document missing schema_version', () => {
    const doc = minimalDoc()
    delete doc.schema_version
    const r = parseBlueprintDocument(doc)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/schema_version/)
  })

  it('rejects schema_version 2 (only version 1 is understood)', () => {
    const r = parseBlueprintDocument({ ...minimalDoc(), schema_version: 2 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/schema_version/)
  })

  it('parses STURA_BLUEPRINT itself clean (both layers)', () => {
    const r = parseBlueprintDocument(STURA_BLUEPRINT)
    expect(r).toEqual({ ok: true, bp: expect.anything() })
  })

  it('parses a caucus section', () => {
    const doc = {
      ...minimalDoc(),
      caucuses: {
        policy: { min_size: 2, allow_groups: false, proportional_committee_allocation: true },
        caucuses: [
          { key: 'frak-a', councilOrgUnitKey: 'root', name: 'Fraktion A', color: '#ff0000',
            members: [{ userKey: 'a.one', termStart: '2026-01-01', termEnd: null }] }
        ]
      }
    }
    const r = parseBlueprintDocument(doc)
    expect(r).toEqual({ ok: true, bp: expect.anything() })
  })
})

describe('parseBlueprintDocument — layer 2 composition (validateBlueprint)', () => {
  it('surfaces layer-2 errors (two council roots → root_max 1)', () => {
    const doc = minimalDoc()
    ;(doc.orgUnits as Record<string, unknown>[]).push({
      key: 'root2', name: 'Root 2', description: null, kind: 'council', parentKey: null,
      visibility: 'all_members', wantsMatrixRoom: true, wantsNextcloudFolder: true
    })
    const r = parseBlueprintDocument(doc)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/at most 1 root .* 'council'/)
  })

  it('uses the document orgSchema for layer 2 when present (non-StuRa vocabulary validates)', () => {
    const doc = minimalDoc()
    doc.orgSchema = [
      { key: 'assembly', label: 'Assembly', childTerm: null,
        allowedParentKinds: [], canBeRoot: true, rootMin: 1, rootMax: 1, sortOrder: 0 }
    ]
    ;(doc.orgUnits as Record<string, unknown>[])[0]!.kind = 'assembly'
    const r = parseBlueprintDocument(doc)
    expect(r).toEqual({ ok: true, bp: expect.anything() })
  })
})
