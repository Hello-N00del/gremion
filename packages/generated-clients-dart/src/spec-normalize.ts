// packages/generated-clients-dart/src/spec-normalize.ts
//
// Rewrites the GENERATOR INPUT, never the committed spec, for the places where
// openapi-generator 7.12.0's OpenAPI 3.1 support ("still in beta", as it logs
// itself) turns what the spec author clearly meant into a wrong Dart client.
// Each case below was reproduced with the pinned image:
//
//  1. `nullable` is not a 3.1 keyword and is ignored in 3.1 mode, so a
//     required `{type: string, nullable: true}` became a non-nullable
//     `String`, which fails to deserialize a null. Rewritten to the 3.1
//     spelling `type: [T, "null"]`, which is also how the TS client
//     (openapi-typescript) already reads these specs.
//  2. `default: null` on a nullable property became the STRING default
//     `'null'`, sent on every request that did not set the field. It is
//     dropped wherever null is allowed: an absent default already means
//     "null/unset" to the client.
//  3. An untyped `const: true` became `JsonObject?`, and a typed one became a
//     single-value EnumClass with the STRING wire name 'true', which cannot
//     decode the JSON boolean. A scalar const is dropped, keeping (or
//     inferring) its type, so the field is a `bool`. A client does not
//     validate server constants. A non-string enum hits the same EnumClass
//     problem and fails closed.
//  4. JSON Schema 2020-12 requires `null` to be listed INSIDE `enum` for a
//     null instance to pass a nullable enum (the type array alone does not
//     make `enum` accept it) — the real governance spec (openapi 3.1.0)
//     spells four properties this way. openapi-generator 7.12.0 instead
//     turns that `null` into an enum member with the STRING wire name
//     'null'. Where the type already allows null, the null member is
//     dropped: the field/enum being `?` in the generated Dart already
//     expresses "may be null", so no enum member is needed for it. Where
//     the type does NOT allow null, this is not a mapping this rewrite
//     understands and it fails closed, same as an unmappable `nullable`.
//
// Anything that cannot be mapped faithfully fails closed. The walk decides
// what is a schema by POSITION, not by key name, so a property named
// `default` or `enum`, `responses.default`, or a schema named `default` is
// still normalised, and example/default/enum/const VALUES are never touched.
// Once contracts/ spells these the 3.1 way, every rewrite here is a no-op.

export interface NormalizeReport {
  nullable: string[]
  nullableFalseDropped: string[]
  defaultNullDropped: string[]
  constDropped: string[]
  enumNullDropped: string[]
}

/** Keys whose value holds data, not schemas: never walked. */
const VALUE_KEYS = new Set(['example', 'examples', 'default', 'enum', 'const'])
/** Keys whose value maps user-chosen NAMES to objects: every value is walked
 *  as a node, whatever its name. */
const NAME_MAPS = new Set([
  'properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas',
  'schemas', 'responses', 'parameters', 'requestBodies', 'headers', 'content',
  'paths', 'webhooks', 'pathItems', 'callbacks', 'links', 'encoding', 'securitySchemes',
])
const COMBINATORS = ['$ref', 'allOf', 'oneOf', 'anyOf']

function pointerToken(k: string): string {
  return k.replace(/~/g, '~0').replace(/\//g, '~1')
}

function allowsNull(type: unknown): boolean {
  return type === 'null' || (Array.isArray(type) && type.includes('null'))
}

export function normalizeFor31(input: unknown): { doc: unknown; report: NormalizeReport } {
  const report: NormalizeReport = { nullable: [], nullableFalseDropped: [], defaultNullDropped: [], constDropped: [], enumNullDropped: [] }
  const version = (input as { openapi?: unknown } | null)?.openapi
  if (typeof version !== 'string' || !version.startsWith('3.1')) return { doc: input, report }

  const walkNameMap = (node: unknown, ptr: string): unknown => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return walkNode(node, ptr)
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) out[k] = walkNode(v, `${ptr}/${pointerToken(k)}`)
    return out
  }

  const walkNode = (node: unknown, ptr: string): unknown => {
    if (Array.isArray(node)) return node.map((v, i) => walkNode(v, `${ptr}/${i}`))
    if (!node || typeof node !== 'object') return node
    const src = node as Record<string, unknown>
    const at = ptr === '' ? '/' : ptr
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(src)) {
      if (k === 'nullable' && typeof v === 'boolean') continue
      const child = `${ptr}/${pointerToken(k)}`
      out[k] = VALUE_KEYS.has(k) || k.startsWith('x-') ? v : NAME_MAPS.has(k) ? walkNameMap(v, child) : walkNode(v, child)
    }

    if (src.nullable === true) {
      if ('enum' in src) throw new Error(`${at}: "nullable: true" with an enum cannot be mapped to 3.1 faithfully (null must join the enum too); spell it the 3.1 way in the spec`)
      const combinator = COMBINATORS.find((c) => c in src)
      if (combinator) throw new Error(`${at}: "nullable: true" next to "${combinator}" cannot be mapped to 3.1 faithfully (the ${combinator} branch would still reject null); spell it the 3.1 way in the spec`)
      if (typeof src.type === 'string') out.type = [src.type, 'null']
      else if (Array.isArray(src.type)) out.type = src.type.includes('null') ? src.type : [...src.type, 'null']
      else throw new Error(`${at}: "nullable: true" without a "type" cannot be mapped to 3.1 faithfully; spell it the 3.1 way in the spec`)
      report.nullable.push(at)
    } else if (src.nullable === false) {
      report.nullableFalseDropped.push(at)
    }

    if ('default' in src && src.default === null) {
      if (!allowsNull(out.type)) throw new Error(`${at}: "default: null" on a schema whose type does not allow null (${JSON.stringify(out.type ?? 'untyped')})`)
      delete out.default
      report.defaultNullDropped.push(at)
    }

    let enumValues = Array.isArray(src.enum) ? src.enum : null
    if (enumValues && enumValues.includes(null)) {
      if (!allowsNull(out.type)) {
        throw new Error(`${at}: enum containing null ${JSON.stringify(enumValues)} — openapi-generator 7.12.0 would make an enum member with wire name 'null'; express nullability with the type only`)
      }
      // The type (left untouched) already expresses nullability; the null
      // enum member is only there for JSON Schema validation and would
      // become an undecodable wire name 'null' in the generated EnumClass.
      enumValues = enumValues.filter((v) => v !== null)
      out.enum = enumValues
      report.enumNullDropped.push(at)
    }
    if (enumValues && enumValues.some((v) => typeof v !== 'string')) {
      throw new Error(`${at}: non-string enum ${JSON.stringify(enumValues)} — openapi-generator 7.12.0 (dart-dio) makes a string-wire EnumClass that cannot decode it; use a plain type or string values`)
    }
    if ('const' in src) {
      const c = src.const
      const t = typeof c === 'boolean' ? 'boolean' : typeof c === 'string' ? 'string'
        : typeof c === 'number' ? (Number.isInteger(c) ? 'integer' : 'number') : null
      if (t === null) throw new Error(`${at}: non-scalar const ${JSON.stringify(c)} cannot be mapped faithfully for the generator; use a type`)
      // The generator turns any const into a single-value EnumClass whose
      // wire name is a STRING ('true'), which cannot decode the JSON value.
      // A client does not validate server constants; keep the type only.
      delete out.const
      if (!('type' in src)) out.type = t
      report.constDropped.push(at)
    }
    return out
  }

  return { doc: walkNode(input, ''), report }
}
