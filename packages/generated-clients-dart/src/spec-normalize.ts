// packages/generated-clients-dart/src/spec-normalize.ts
//
// OpenAPI 3.1 dropped the `nullable` keyword (null is a JSON Schema type
// there), and openapi-generator 7.12.0 in 3.1 mode ignores it, verified with
// the integration fixture: a required `{type: string, nullable: true}` became
// a non-nullable `String`, which fails to deserialize a null. Specs in this
// repo are 3.1.0 but spell nullability the 3.0 way, so the GENERATOR INPUT
// (never the committed spec) is rewritten to the 3.1 spelling the author
// meant: `type: T` + `nullable: true` -> `type: [T, "null"]`.
// This matches how the TS client (openapi-typescript) already reads these
// specs. Anything that cannot be mapped faithfully fails closed. Once
// contracts/ spells nullability the 3.1 way, this becomes a no-op.

const NOT_SCHEMA = new Set(['example', 'examples', 'default', 'enum', 'const'])

function pointerToken(k: string): string {
  return k.replace(/~/g, '~0').replace(/\//g, '~1')
}

export function normalizeNullableFor31(input: unknown): { doc: unknown; rewritten: string[] } {
  const version = (input as { openapi?: unknown } | null)?.openapi
  if (typeof version !== 'string' || !version.startsWith('3.1')) return { doc: input, rewritten: [] }
  const rewritten: string[] = []
  const walk = (node: unknown, ptr: string): unknown => {
    if (Array.isArray(node)) return node.map((v, i) => walk(v, `${ptr}/${i}`))
    if (!node || typeof node !== 'object') return node
    const src = node as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(src)) {
      if (k === 'nullable' && typeof v === 'boolean') continue
      out[k] = NOT_SCHEMA.has(k) || k.startsWith('x-') ? v : walk(v, `${ptr}/${pointerToken(k)}`)
    }
    if (typeof src.nullable === 'boolean') {
      const at = ptr === '' ? '/' : ptr
      if (src.nullable) {
        if ('enum' in src) throw new Error(`${at}: "nullable: true" with an enum cannot be mapped to 3.1 faithfully (null must join the enum too); spell it the 3.1 way in the spec`)
        if (typeof src.type === 'string') out.type = [src.type, 'null']
        else if (Array.isArray(src.type)) out.type = src.type.includes('null') ? src.type : [...src.type, 'null']
        else throw new Error(`${at}: "nullable: true" without a "type" ($ref/allOf/oneOf/anyOf) cannot be mapped to 3.1 faithfully; spell it the 3.1 way in the spec`)
      }
      rewritten.push(at)
    }
    return out
  }
  return { doc: walk(input, ''), rewritten }
}
