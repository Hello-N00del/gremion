// The generator INPUT normaliser (never the committed spec). Findings it
// exists for, all reproduced with the pinned openapi-generator 7.12.0:
//  - 3.1 mode ignores the 3.0 keyword `nullable: true`: a required nullable
//    field came out non-nullable (fails to deserialize a null). The real
//    governance spec (openapi 3.1.0) uses it 20 times.
//  - `nullable` + `default: null` came out as the STRING default 'null', sent
//    on every create-committee call (description/parentId/heliosElectionId).
//  - an untyped `const: true` came out as `JsonObject?` (21 `success` fields),
//    and a TYPED const as a single-value EnumClass with wire name 'true' (a
//    string), which cannot decode the JSON boolean true.
import { describe, it, expect } from 'vitest'
import { normalizeFor31 } from './spec-normalize.ts'

type Rec = Record<string, unknown>
const props = (doc: unknown) => ((doc as Rec).components as { schemas: { A: { properties: Rec } } }).schemas.A.properties
const wrap = (properties: Rec) => ({ openapi: '3.1.0', components: { schemas: { A: { type: 'object', properties } } } })

describe('normalizeFor31 — nullable', () => {
  it('rewrites typed nullable: true to a 3.1 type array and drops nullable', () => {
    const { doc, report } = normalizeFor31(wrap({ x: { type: 'string', format: 'date', nullable: true }, y: { type: 'object', nullable: true }, z: { type: 'integer', nullable: false } }))
    expect(props(doc)).toEqual({ x: { type: ['string', 'null'], format: 'date' }, y: { type: ['object', 'null'] }, z: { type: 'integer' } })
    expect(report.nullable).toEqual(['/components/schemas/A/properties/x', '/components/schemas/A/properties/y'])
    expect(report.nullableFalseDropped).toEqual(['/components/schemas/A/properties/z'])
  })

  it('adds null to an existing type array', () => {
    const { doc } = normalizeFor31(wrap({ s: { type: ['string', 'integer'], nullable: true } }))
    expect(props(doc).s).toEqual({ type: ['string', 'integer', 'null'] })
  })

  it('walks by POSITION: properties named default/enum/const/example/x-*, responses.default and a schema named default are all normalised', () => {
    const n = { type: 'string', nullable: true }
    const input = {
      openapi: '3.1.0',
      paths: { '/p': { get: { responses: { default: { content: { 'application/json': { schema: { type: 'object', properties: { err: n } } } } } } } } },
      components: { schemas: { default: { type: 'object', properties: { default: n, enum: n, const: n, example: n, 'x-note': n } } } },
    }
    const { report } = normalizeFor31(input)
    expect(report.nullable.sort()).toEqual([
      '/components/schemas/default/properties/const',
      '/components/schemas/default/properties/default',
      '/components/schemas/default/properties/enum',
      '/components/schemas/default/properties/example',
      '/components/schemas/default/properties/x-note',
      '/paths/~1p/get/responses/default/content/application~1json/schema/properties/err',
    ])
  })

  it('does not touch example/default/enum VALUES, and keeps a boolean schema property NAMED nullable', () => {
    const input = wrap({ nullable: true, o: { type: 'object', example: { nullable: true }, default: { nullable: true } } })
    const { doc, report } = normalizeFor31(input)
    expect(doc).toEqual(input)
    expect(report.nullable).toEqual([])
  })

  it('fails closed on a nullable it cannot map faithfully', () => {
    expect(() => normalizeFor31(wrap({ s: { $ref: '#/x', nullable: true } }))).toThrow(/properties\/s/)
    expect(() => normalizeFor31(wrap({ s: { type: 'object', allOf: [{ $ref: '#/x' }], nullable: true } }))).toThrow(/allOf/)
    expect(() => normalizeFor31(wrap({ s: { type: 'string', enum: ['a'], nullable: true } }))).toThrow(/enum/)
  })
})

describe('normalizeFor31 — default: null', () => {
  it('drops default: null where null is allowed (3.0 and 3.1 spellings) so the generator emits no string "null" default', () => {
    const { doc, report } = normalizeFor31(wrap({ a: { type: 'string', nullable: true, default: null }, b: { type: ['string', 'null'], default: null }, c: { type: 'string', default: 'x' } }))
    expect(props(doc)).toEqual({ a: { type: ['string', 'null'] }, b: { type: ['string', 'null'] }, c: { type: 'string', default: 'x' } })
    expect(report.defaultNullDropped).toEqual(['/components/schemas/A/properties/a', '/components/schemas/A/properties/b'])
  })

  it('fails closed on default: null where null is NOT allowed', () => {
    expect(() => normalizeFor31(wrap({ a: { type: 'string', default: null } }))).toThrow(/default: null/)
  })
})

describe('normalizeFor31 — const / non-string enum', () => {
  it('drops a scalar const, keeping (or inferring) its type: the generator turns any const into a string-wire EnumClass that cannot decode a JSON true', () => {
    const { doc, report } = normalizeFor31(wrap({ ok: { const: true }, s: { const: 'x' }, i: { const: 3 }, f: { const: 1.5 }, t: { type: 'boolean', const: false } }))
    expect(props(doc)).toEqual({ ok: { type: 'boolean' }, s: { type: 'string' }, i: { type: 'integer' }, f: { type: 'number' }, t: { type: 'boolean' } })
    expect(report.constDropped).toHaveLength(5)
  })

  it('fails closed on a non-string enum (same string-wire EnumClass problem)', () => {
    expect(() => normalizeFor31(wrap({ b: { type: 'boolean', enum: [true] } }))).toThrow(/non-string enum/)
    expect(() => normalizeFor31(wrap({ n: { type: 'integer', enum: [1, 2] } }))).toThrow(/non-string enum/)
    expect(() => normalizeFor31(wrap({ s: { type: 'string', enum: ['a', 'b'] } }))).not.toThrow()
    expect(() => normalizeFor31(wrap({ s: { type: ['string', 'null'], enum: ['a', null] } }))).toThrow(/null/)
  })

  it('fails closed on a non-scalar const (null, object, array)', () => {
    expect(() => normalizeFor31(wrap({ c: { const: null } }))).toThrow(/const/)
    expect(() => normalizeFor31(wrap({ c: { const: { a: 1 } } }))).toThrow(/const/)
    expect(() => normalizeFor31(wrap({ c: { const: [1] } }))).toThrow(/const/)
  })
})

describe('normalizeFor31 — scope', () => {
  it('is the identity on an OpenAPI 3.0 document (the generator reads nullable there)', () => {
    const input = { openapi: '3.0.3', s: { type: 'string', nullable: true } }
    expect(normalizeFor31(input).doc).toBe(input)
  })

  it('does not mutate its input', () => {
    const input = wrap({ s: { type: 'string', nullable: true, default: null } })
    const before = JSON.stringify(input)
    normalizeFor31(input)
    expect(JSON.stringify(input)).toBe(before)
  })
})
