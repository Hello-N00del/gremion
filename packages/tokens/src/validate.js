// UX-030: validate a token document against the DTCG 2025.10 JSON Schema
// (vendored in schema/2025.10/, see schema/2025.10/NOTICE.md) plus the two
// rules the schema cannot express:
//   - no key appears twice in one object (JSON.parse keeps the last `$value`
//     silently, so the schema never sees the first one);
//   - every token carries an explicit `$type` (the 2025.10 schema only
//     type-checks `$value` when the token itself names its `$type`, so an
//     inherited type would let a CSS string through unchecked).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import AjvModule from 'ajv'

import { findDuplicateKeys } from './strict-json.js'

/** @typedef {{ ok: boolean, errors: string[], tokenCount: number }} ValidationResult */

const SCHEMA_DIR = new URL('../schema/2025.10/', import.meta.url)

/** @param {string} name */
function loadSchema(name) {
  return JSON.parse(readFileSync(fileURLToPath(new URL(name, SCHEMA_DIR)), 'utf8'))
}

// ajv ships CommonJS; under ESM the class is the module's default (or its
// `.default`, depending on the loader).
/** @type {any} */
const AjvCtor = /** @type {any} */ (AjvModule).default ?? AjvModule

/** @type {Map<string, any>} */
const compiled = new Map()
/** @param {string} name */
function validatorFor(name) {
  let v = compiled.get(name)
  if (!v) {
    // One Ajv instance per bundle: both bundles embed the same $id'd
    // sub-schemas, and one instance refuses a second schema with the same id.
    const ajv = new AjvCtor({ strict: false, allErrors: true, validateFormats: false })
    v = ajv.compile(loadSchema(name))
    compiled.set(name, v)
  }
  return v
}

/**
 * Dotted token path for an ajv instancePath (`/core/space/s-1/$value/unit`
 * -> `core.space.s-1`): everything before the first `$`-prefixed segment.
 * @param {string} instancePath
 */
function tokenPathOf(instancePath) {
  const segs = instancePath
    .split('/')
    .slice(1)
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'))
  const cut = segs.findIndex((s) => s.startsWith('$'))
  return (cut === -1 ? segs : segs.slice(0, cut)).join('.') || '(root)'
}

/**
 * @param {Record<string, any>} doc
 * @returns {{ path: string, token: Record<string, any> }[]}
 */
function tokensOf(doc) {
  /** @type {{ path: string, token: Record<string, any> }[]} */
  const out = []
  /** @param {any} node @param {string[]} path */
  const walk = (node, path) => {
    for (const [k, child] of Object.entries(node)) {
      if (k.startsWith('$') || child === null || typeof child !== 'object' || Array.isArray(child)) continue
      if ('$value' in child) out.push({ path: [...path, k].join('.'), token: child })
      else walk(child, [...path, k])
    }
  }
  walk(doc, [])
  return out
}

/**
 * @param {string} text  the raw JSON text (raw, so duplicate keys are visible)
 * @param {string} source  a name for messages
 * @returns {ValidationResult}
 */
export function validateTokenDocument(text, source) {
  /** @type {string[]} */
  const errors = []
  let doc
  try {
    doc = JSON.parse(text)
  } catch (e) {
    return { ok: false, errors: [`${source}: not JSON: ${/** @type {Error} */ (e).message}`], tokenCount: 0 }
  }
  for (const d of findDuplicateKeys(text)) {
    errors.push(`${source}: ${d.path || '(root)'}: duplicate key "${d.key}" (a token has exactly one $value)`)
  }
  const tokens = tokensOf(doc)
  for (const { path, token } of tokens) {
    if (typeof token.$type !== 'string') errors.push(`${source}: ${path}: missing explicit $type`)
  }
  const validate = validatorFor('format.json')
  if (!validate(doc)) {
    /** @type {Map<string, string[]>} */
    const byToken = new Map()
    for (const err of validate.errors ?? []) {
      const p = tokenPathOf(err.instancePath)
      const list = byToken.get(p) ?? []
      list.push(`${err.instancePath || '/'} ${err.message}`)
      byToken.set(p, list)
    }
    for (const [p, msgs] of byToken) {
      errors.push(`${source}: ${p}: does not match the DTCG 2025.10 schema (${[...new Set(msgs)].slice(0, 4).join('; ')})`)
    }
  }
  return { ok: errors.length === 0, errors, tokenCount: tokens.length }
}

/**
 * @param {string} text
 * @param {string} source
 * @returns {ValidationResult}
 */
export function validateResolverDocument(text, source) {
  /** @type {string[]} */
  const errors = []
  let doc
  try {
    doc = JSON.parse(text)
  } catch (e) {
    return { ok: false, errors: [`${source}: not JSON: ${/** @type {Error} */ (e).message}`], tokenCount: 0 }
  }
  for (const d of findDuplicateKeys(text)) errors.push(`${source}: ${d.path || '(root)'}: duplicate key "${d.key}"`)
  const validate = validatorFor('resolver.json')
  if (!validate(doc)) {
    for (const err of validate.errors ?? []) errors.push(`${source}: ${err.instancePath || '/'} ${err.message}`)
  }
  return { ok: errors.length === 0, errors, tokenCount: 0 }
}
