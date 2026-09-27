// packages/generated-clients/src/asyncapi-compat.ts
//
// T4: AsyncAPI 3.0 payload compat — same version-bump rule as OpenAPI (T3),
// but oasdiff does not classify AsyncAPI at all, so this is a small,
// PURPOSE-BUILT structural comparator scoped to exactly what the brief §5
// (decision 6) asks for: `components.messages.*.payload`. A removed or
// newly-required property, a narrowed/changed type, or a removed enum value
// needs a MAJOR bump; a new optional property needs at least MINOR.
//
// `@asyncapi/diff` was considered first (brief's stated preference) but is
// not in this lockfile: adding it here would need a TASK-017 build-script
// allowlist entry for a dependency whose AsyncAPI-3.0 support is, per the
// brief itself, unproven ("unclassified = breaking" was the fallback
// reading). A ~30-line comparator over one well-defined shape is easier to
// trust AND to test than an opaque tool's verdict on a spec version it may
// not fully understand — this is the "or a custom comparison" branch of
// decision 6, taken because it fits comfortably in the size budget.
//
// FIX (verifier HIGH, round 1): every real payload in this repo is a `$ref`
// to a `components.schemas.*` entry, and those schemas are
// `allOf[EventEnvelope, {properties:{payload:{...}}}]` — the actual event
// data lives NESTED under the envelope's own `payload` property, one level
// below what the original version compared. The original comparator only
// read the message's inline top-level `payload.properties`, saw zero
// properties on every real spec, and reported any change there as a
// harmless "non-breaking addition". It now: (1) resolves local `$ref`s with
// the same percent-decoding pointer walk `schema.ts` uses for $ref closure,
// (2) flattens `allOf` (recursively — a member can itself be a `$ref` or
// `allOf`) into one merged shape before comparing, and (3) recurses into
// every nested `object` property, not just the top level, so a removed
// field three levels down (e.g. envelope.payload.attempts) is seen. `type`
// is compared as a SET, not with `!==`: `["string","null"]` vs
// `["string","null"]` is the same set even though they are different array
// instances, and once $ref/allOf resolution actually runs, a raw `!==` on
// the arrays would flag that as "changed" even when nothing changed.
import { stripCompatNoise, classifyVersionBump, type CompatResult } from './oasdiff-gate.js'

type SchemaType = string | string[] | undefined

interface FlatSchema {
  type?: SchemaType
  required?: string[]
  properties?: Record<string, unknown>
  enum?: unknown[]
}

interface AsyncApiMessage { payload?: unknown }

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function messagesOf(doc: unknown): Record<string, AsyncApiMessage> {
  const components = isPlainRecord(doc) ? doc.components : undefined
  const messages = isPlainRecord(components) ? components.messages : undefined
  return isPlainRecord(messages) ? (messages as Record<string, AsyncApiMessage>) : {}
}

/** Local `#/...` pointer resolution — the same percent-decode-then-unescape
 *  walk as `schema.ts`'s `collectUnresolvedRefs` (kept in sync deliberately;
 *  duplicated rather than imported because that function walks a whole doc
 *  looking for problems, this one just needs the single resolved node). */
function resolveLocalRef(doc: unknown, ref: string): unknown {
  if (!ref.startsWith('#/')) return undefined
  let node: unknown = doc
  for (const rawSeg of ref.slice(2).split('/')) {
    let decoded = rawSeg
    try {
      decoded = decodeURIComponent(rawSeg)
    } catch {
      // not valid percent-encoding — fall through with the raw segment
    }
    const key = decoded.replace(/~1/g, '/').replace(/~0/g, '~')
    if (typeof node !== 'object' || node === null || !(key in (node as Record<string, unknown>))) return undefined
    node = (node as Record<string, unknown>)[key]
  }
  return node
}

/** Resolve a local `$ref` and flatten `allOf` into one merged schema
 *  (type/required/properties/enum combined), so the comparator sees the
 *  same shape a consumer actually gets after JSON-Schema composition.
 *  Recursive with a cycle guard: an `allOf` member or `$ref` target can
 *  itself be a `$ref`/`allOf` (true here — `EnvelopeOrgUnit` is `allOf` of
 *  a `$ref` plus an inline member). Properties are left UNFLATTENED (raw
 *  sub-schemas); each is flattened lazily, on demand, when the comparison
 *  recurses into it. */
function flattenSchema(doc: unknown, schema: unknown, seenRefs: ReadonlySet<string> = new Set()): FlatSchema {
  if (!isPlainRecord(schema)) return {}

  if (typeof schema.$ref === 'string') {
    if (seenRefs.has(schema.$ref)) return {} // cycle guard
    const resolved = resolveLocalRef(doc, schema.$ref)
    return flattenSchema(doc, resolved, new Set([...seenRefs, schema.$ref]))
  }

  const merged: FlatSchema = {
    type: (schema.type as SchemaType) ?? undefined,
    required: Array.isArray(schema.required) ? (schema.required as string[]) : undefined,
    properties: isPlainRecord(schema.properties) ? (schema.properties as Record<string, unknown>) : undefined,
    enum: Array.isArray(schema.enum) ? (schema.enum as unknown[]) : undefined,
  }

  if (Array.isArray(schema.allOf)) {
    for (const member of schema.allOf) {
      const flat = flattenSchema(doc, member, seenRefs)
      if (flat.type !== undefined) merged.type = flat.type
      if (flat.required) merged.required = [...(merged.required ?? []), ...flat.required]
      if (flat.properties) merged.properties = { ...merged.properties, ...flat.properties }
      if (flat.enum) merged.enum = flat.enum
    }
  }

  return merged
}

function typeSet(t: SchemaType): Set<string> | undefined {
  if (t === undefined) return undefined
  return new Set((Array.isArray(t) ? t : [t]).map(String))
}

/** Compare `type` as a SET, not by reference/order — `["string","null"]` and
 *  `["string","null"]` (different array instances, or reordered) are the
 *  same type. */
function typesEqual(a: SchemaType, b: SchemaType): boolean {
  const sa = typeSet(a)
  const sb = typeSet(b)
  if (sa === undefined || sb === undefined) return sa === sb
  if (sa.size !== sb.size) return false
  for (const v of sa) if (!sb.has(v)) return false
  return true
}

function describeType(t: SchemaType): string {
  if (t === undefined) return 'undefined'
  return Array.isArray(t) ? t.join('|') : t
}

/** Recursive structural comparison of one resolved+flattened schema against
 *  its counterpart, at `path`. Handles the four brief-scoped rules (removed
 *  property, newly-required property, narrowed/changed type, removed enum
 *  value) at EVERY level, not just the top one — this is what lets a change
 *  nested under `payload.properties.payload.properties.<field>` (the real
 *  shape after $ref/allOf resolution) be seen at all. Returns whether this
 *  subtree is breaking; pushes human-readable reasons into `reasons`. */
function compareSchemas(
  oldDoc: unknown,
  newDoc: unknown,
  oldRaw: unknown,
  newRaw: unknown,
  path: string,
  reasons: string[],
): boolean {
  const oldFlat = flattenSchema(oldDoc, oldRaw)
  const newFlat = flattenSchema(newDoc, newRaw)
  let breaking = false

  if (!typesEqual(oldFlat.type, newFlat.type)) {
    breaking = true
    reasons.push(`${path}: type changed/narrowed "${describeType(oldFlat.type)}" -> "${describeType(newFlat.type)}"`)
  }

  if (Array.isArray(oldFlat.enum) && Array.isArray(newFlat.enum)) {
    const newSet = new Set(newFlat.enum)
    const removedValues = oldFlat.enum.filter((v) => !newSet.has(v))
    if (removedValues.length > 0) {
      breaking = true
      reasons.push(`${path}: enum value(s) removed: ${removedValues.map(String).join(', ')}`)
    }
  }

  const oldProps = oldFlat.properties ?? {}
  const newProps = newFlat.properties ?? {}
  const oldRequired = new Set(oldFlat.required ?? [])
  const newRequired = new Set(newFlat.required ?? [])

  for (const prop of Object.keys(oldProps)) {
    const propPath = `${path}.${prop}`
    if (!(prop in newProps)) {
      breaking = true
      reasons.push(`${propPath}: property removed`)
      continue
    }
    if (!oldRequired.has(prop) && newRequired.has(prop)) {
      breaking = true
      reasons.push(`${propPath}: property became required`)
    }
    if (compareSchemas(oldDoc, newDoc, oldProps[prop], newProps[prop], propPath, reasons)) {
      breaking = true
    }
  }

  for (const prop of Object.keys(newProps)) {
    if (prop in oldProps) continue
    const propPath = `${path}.${prop}`
    if (newRequired.has(prop)) {
      breaking = true
      reasons.push(`${propPath}: new REQUIRED property added`)
    } else {
      reasons.push(`${propPath}: new optional property added`)
    }
  }

  return breaking
}

export interface PayloadCompatResult { breaking: boolean; reasons: string[] }

/** Structural comparison of every `components.messages.*.payload` between two
 *  AsyncAPI documents — resolving `$ref` and flattening `allOf` first, then
 *  recursing into nested object properties. Scoped deliberately narrow
 *  (brief §5 decision 6): it does not attempt full JSON Schema compatibility
 *  (e.g. numeric ranges, `oneOf`/`anyOf`), only the four rules the brief
 *  names, applied at whatever depth they actually occur at. */
export function compareAsyncApiPayloads(oldDoc: unknown, newDoc: unknown): PayloadCompatResult {
  const reasons: string[] = []
  let breaking = false
  const oldMsgs = messagesOf(oldDoc)
  const newMsgs = messagesOf(newDoc)

  for (const name of Object.keys(oldMsgs)) {
    if (!(name in newMsgs)) {
      breaking = true
      reasons.push(`message "${name}" removed`)
      continue
    }
    const oldPayload = oldMsgs[name]?.payload
    const newPayload = newMsgs[name]?.payload
    if (compareSchemas(oldDoc, newDoc, oldPayload, newPayload, `${name}.payload`, reasons)) {
      breaking = true
    }
  }

  for (const name of Object.keys(newMsgs)) {
    if (!(name in oldMsgs)) reasons.push(`message "${name}" added`)
  }

  return { breaking, reasons }
}

function structurallyEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(stripCompatNoise(a)) === JSON.stringify(stripCompatNoise(b))
}

/** The same rule as `checkOpenApiCompat` (oasdiff-gate.ts), applied via
 *  `compareAsyncApiPayloads` instead of oasdiff — T4 mirrors T3 exactly. */
export function checkAsyncApiCompat(oldRaw: string, newRaw: string): CompatResult {
  const oldDoc = JSON.parse(oldRaw) as { info?: { version?: string } }
  const newDoc = JSON.parse(newRaw) as { info?: { version?: string } }
  const oldVersion = oldDoc.info?.version ?? ''
  const newVersion = newDoc.info?.version ?? ''

  if (structurallyEqual(oldDoc, newDoc)) {
    return { ok: true, breaking: false, structuralChange: false, bump: classifyVersionBump(oldVersion, newVersion), reason: 'no structural change (description-only or identical)' }
  }

  const { breaking, reasons } = compareAsyncApiPayloads(oldDoc, newDoc)
  const bump = classifyVersionBump(oldVersion, newVersion)

  if (breaking) {
    const ok = bump === 'major'
    return {
      ok,
      breaking: true,
      structuralChange: true,
      bump,
      reason: ok
        ? `breaking AsyncAPI payload change, major bump ${oldVersion} -> ${newVersion}: OK`
        : `breaking AsyncAPI payload change requires a MAJOR bump; got ${oldVersion} -> ${newVersion} (${bump}).\n${reasons.join('\n')}`,
    }
  }
  const ok = bump === 'major' || bump === 'minor'
  return {
    ok,
    breaking: false,
    structuralChange: true,
    bump,
    reason: ok
      ? `non-breaking AsyncAPI payload addition, ${bump} bump ${oldVersion} -> ${newVersion}: OK`
      : `non-breaking AsyncAPI payload addition (an addition) requires at least a MINOR bump; got ${oldVersion} -> ${newVersion} (${bump}).\n${reasons.join('\n')}`,
  }
}
