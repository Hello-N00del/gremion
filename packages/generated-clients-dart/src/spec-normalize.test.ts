// openapi-generator 7.12.0 in OpenAPI 3.1 mode ignores the 3.0 keyword
// `nullable: true` (it is not a 3.1 keyword), so a REQUIRED nullable field
// came out non-nullable in Dart and would fail to deserialize a null. The
// real governance spec (openapi 3.1.0) uses `nullable: true` 20 times
// (child_term and the delete-200 `data` are required). Normalised here, in
// the generator input only; contracts/** is not touched.
import { describe, it, expect } from 'vitest'
import { normalizeNullableFor31 } from './spec-normalize.ts'

describe('normalizeNullableFor31', () => {
  it('rewrites typed nullable: true to a 3.1 type array and drops nullable', () => {
    const { doc, rewritten } = normalizeNullableFor31({
      openapi: '3.1.0',
      components: { schemas: { A: { type: 'object', required: ['x'], properties: { x: { type: 'string', format: 'date', nullable: true }, y: { type: 'object', nullable: true }, z: { type: 'integer', nullable: false } } } } },
    })
    const props = (doc as { components: { schemas: { A: { properties: Record<string, unknown> } } } }).components.schemas.A.properties
    expect(props.x).toEqual({ type: ['string', 'null'], format: 'date' })
    expect(props.y).toEqual({ type: ['object', 'null'] })
    expect(props.z).toEqual({ type: 'integer' })
    expect(rewritten).toEqual(['/components/schemas/A/properties/x', '/components/schemas/A/properties/y', '/components/schemas/A/properties/z'])
  })

  it('leaves an existing type array alone apart from adding null', () => {
    const { doc } = normalizeNullableFor31({ openapi: '3.1.0', s: { type: ['string', 'integer'], nullable: true } })
    expect((doc as { s: unknown }).s).toEqual({ type: ['string', 'integer', 'null'] })
  })

  it('does not touch examples, defaults, enums or a property NAMED nullable', () => {
    const input = { openapi: '3.1.0', s: { type: 'object', properties: { nullable: { type: 'boolean' } }, example: { nullable: true }, default: { nullable: true } } }
    const { doc, rewritten } = normalizeNullableFor31(input)
    expect(doc).toEqual(input)
    expect(rewritten).toEqual([])
  })

  it('fails closed on a nullable it cannot map faithfully (no type, or an enum)', () => {
    expect(() => normalizeNullableFor31({ openapi: '3.1.0', s: { $ref: '#/x', nullable: true } })).toThrow(/\/s/)
    expect(() => normalizeNullableFor31({ openapi: '3.1.0', s: { type: 'string', enum: ['a'], nullable: true } })).toThrow(/enum/)
  })

  it('is the identity on an OpenAPI 3.0 document (the generator reads nullable there)', () => {
    const input = { openapi: '3.0.3', s: { type: 'string', nullable: true } }
    expect(normalizeNullableFor31(input)).toEqual({ doc: input, rewritten: [] })
  })

  it('does not mutate its input', () => {
    const input = { openapi: '3.1.0', s: { type: 'string', nullable: true } }
    normalizeNullableFor31(input)
    expect(input.s).toEqual({ type: 'string', nullable: true })
  })
})
