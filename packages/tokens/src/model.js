// The token model shared by the validator, the tier lint, the resolver and
// the emitters: walk a DTCG document, flatten it to dotted paths, find
// aliases, merge a mode set over the base set.

/** The three tiers of UX-031, in downward order. */
export const TIERS = /** @type {const} */ (['component', 'semantic', 'core'])

/** Vendor extension namespace used by this package (DTCG `$extensions`). */
export const EXT = 'org.gremion'

const ALIAS_RE = /^\{([^{}]+)\}$/

/**
 * @typedef {{
 *   path: string,
 *   type: string | undefined,
 *   value: unknown,
 *   description?: string,
 *   ext: { css?: string, handWritten?: boolean, palette?: boolean, defaultHue?: boolean, hue?: string },
 * }} FlatToken
 */

/**
 * The target path of a whole-value alias (`"{a.b.c}"`), else null.
 * @param {unknown} v
 * @returns {string | null}
 */
export function aliasTarget(v) {
  if (typeof v !== 'string') return null
  const m = ALIAS_RE.exec(v)
  return m ? m[1] : null
}

/**
 * Every alias target anywhere inside a value (whole value or composite part).
 * @param {unknown} v
 * @returns {string[]}
 */
export function aliasesIn(v) {
  const t = aliasTarget(v)
  if (t) return [t]
  if (Array.isArray(v)) return v.flatMap(aliasesIn)
  if (v && typeof v === 'object') return Object.values(v).flatMap(aliasesIn)
  return []
}

/**
 * The tier a dotted path belongs to (its first segment), or null.
 * @param {string} path
 */
export function tierOf(path) {
  const head = path.split('.')[0]
  return /** @type {readonly string[]} */ (TIERS).includes(head) ? head : null
}

/**
 * @param {unknown} node
 * @returns {node is Record<string, any>}
 */
function isObject(node) {
  return node !== null && typeof node === 'object' && !Array.isArray(node)
}

/**
 * Flatten a DTCG document to its tokens, in document order.
 * A token is any object that carries `$value`; `$`-prefixed keys of a group
 * are group metadata, not children.
 * @param {Record<string, any>} doc
 * @returns {Map<string, FlatToken>}
 */
export function flatten(doc) {
  /** @type {Map<string, FlatToken>} */
  const out = new Map()
  /**
   * @param {Record<string, any>} node
   * @param {string[]} path
   * @param {string | undefined} inheritedType
   */
  const walk = (node, path, inheritedType) => {
    const groupType = typeof node.$type === 'string' ? node.$type : inheritedType
    for (const [key, child] of Object.entries(node)) {
      if (key.startsWith('$') || !isObject(child)) continue
      const p = [...path, key]
      if ('$value' in child) {
        out.set(p.join('.'), {
          path: p.join('.'),
          type: typeof child.$type === 'string' ? child.$type : groupType,
          value: child.$value,
          description: child.$description,
          ext: (child.$extensions && child.$extensions[EXT]) || {},
        })
      } else {
        walk(child, p, groupType)
      }
    }
  }
  walk(doc, [], undefined)
  return out
}

/**
 * Deep-merge a mode set over a base document: groups merge key by key, a
 * token in the override replaces the base token wholesale.
 * @param {Record<string, any>} base
 * @param {Record<string, any>} over
 * @returns {Record<string, any>}
 */
export function mergeDocs(base, over) {
  /** @type {Record<string, any>} */
  const out = { ...base }
  for (const [k, v] of Object.entries(over)) {
    if (k.startsWith('$')) continue
    if (isObject(v) && !('$value' in v) && isObject(base[k]) && !('$value' in base[k])) {
      out[k] = mergeDocs(base[k], v)
    } else {
      out[k] = v
    }
  }
  return out
}
