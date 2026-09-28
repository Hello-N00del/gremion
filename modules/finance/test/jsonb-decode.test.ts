// Unit guard for decodeJsonbColumn (TASK-009 fix round 5) — the leaf's read-boundary
// guarantee that a JSONB column reaches consumers as the contract's array/object, even
// for a legacy DOUBLE-ENCODED row (a jsonb string scalar, read back as a JS string).
// The real-Postgres wire shape is asserted in jsonb-shape.integration.test.ts.
import { describe, it, expect } from 'vitest'
import { decodeJsonbColumn } from '../src/store/index.ts'

describe('decodeJsonbColumn', () => {
  it('passes a parsed array / object through unchanged', () => {
    const arr = [{ role: 'KV' }]
    expect(decodeJsonbColumn(arr, 'array', 'c')).toBe(arr)
    const obj = { meta: {} }
    expect(decodeJsonbColumn(obj, 'object', 'c')).toBe(obj)
  })

  it('unwraps ONE layer of a double-encoded value (the live finanzordnung 500 shape)', () => {
    const live = '[{"role":"KV","required_group":"ref-finanzen-kv","certifies":["sachlich"]}]'
    expect(decodeJsonbColumn(live, 'array', 'c')).toEqual([
      { role: 'KV', required_group: 'ref-finanzen-kv', certifies: ['sachlich'] },
    ])
    expect(decodeJsonbColumn('{"meta":{"x":1}}', 'object', 'c')).toEqual({ meta: { x: 1 } })
  })

  it('fails loudly, naming the column, when the shape is wrong', () => {
    expect(() => decodeJsonbColumn({ a: 1 }, 'array', 'finanzordnung_profile.signer_stages'))
      .toThrow(/finanzordnung_profile\.signer_stages: expected a jsonb array, got object/)
    expect(() => decodeJsonbColumn([1], 'object', 'budget_plan.statement'))
      .toThrow(/budget_plan\.statement: expected a jsonb object, got array/)
    expect(() => decodeJsonbColumn(null, 'array', 'x')).toThrow(/got null/)
    expect(() => decodeJsonbColumn(undefined, 'array', 'x')).toThrow(/got undefined/)
    expect(() => decodeJsonbColumn('not json', 'array', 'x')).toThrow(/non-JSON string scalar/)
    // A triple-encoded value is NOT silently accepted: one layer only.
    expect(() => decodeJsonbColumn(JSON.stringify(JSON.stringify([1])), 'array', 'x'))
      .toThrow(/expected a jsonb array, got string/)
  })
})
