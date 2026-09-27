// DTCG 2025.10 values -> CSS custom-property text (the web target of UX-032).
//
// A token is EMITTED when it carries `$extensions["org.gremion"].css` and is
// not marked `handWritten`. Aliases resolve hop by hop: the first hop that
// lands on a token with a CSS variable (emitted or hand-written) becomes
// `var(--name)`, so the cascade that overrides that variable (per-tenant
// accent injection, html.cb-*, html.density-compact, html.radius-sharp) still
// reaches every consumer; a chain that never meets one resolves to the core
// literal. An alias that does not resolve, a cycle, a type mismatch or an
// unsupported value throws: nothing falls back to a raw guess.
import { aliasTarget } from './model.js'

/** @typedef {import('./model.js').FlatToken} FlatToken */
/** @typedef {Map<string, FlatToken>} Universe */

const GENERIC_FAMILIES = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
  'math',
  'emoji',
  'fangsong',
])

/** DTCG 2025.10 font-weight keywords -> numeric weights. */
const WEIGHTS = /** @type {Record<string, number>} */ ({
  thin: 100,
  hairline: 100,
  'extra-light': 200,
  'ultra-light': 200,
  light: 300,
  normal: 400,
  regular: 400,
  book: 400,
  medium: 500,
  'semi-bold': 600,
  'demi-bold': 600,
  bold: 700,
  'extra-bold': 800,
  'ultra-bold': 800,
  black: 900,
  heavy: 900,
  'extra-black': 950,
  'ultra-black': 950,
})

/** Compact decimal text without float noise (0.42*100 -> "42"). @param {number} n */
function num(n) {
  return String(Number(n.toFixed(6)))
}

/**
 * @param {string} path  for error messages
 * @param {any} v
 */
function color(path, v) {
  const { colorSpace, components, alpha } = v
  if (!Array.isArray(components) || components.some((c) => typeof c !== 'number')) {
    throw new Error(`${path}: colour components must be numbers (the "none" keyword has no CSS emission here)`)
  }
  const hasAlpha = typeof alpha === 'number' && alpha !== 1
  if (colorSpace === 'oklch') {
    const [l, c, h] = components
    return `oklch(${num(l * 100)}% ${num(c)} ${num(h)}${hasAlpha ? ` / ${num(alpha)}` : ''})`
  }
  if (colorSpace === 'srgb') {
    const [r, g, b] = components.map((x) => Math.round(x * 255))
    if (hasAlpha) return `rgba(${r}, ${g}, ${b}, ${num(alpha)})`
    return `#${[r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('')}`
  }
  throw new Error(`${path}: colour space ${colorSpace} has no CSS emitter yet (oklch and srgb only)`)
}

/** @param {string} path @param {any} v */
function dimension(path, v) {
  if (!v || typeof v.value !== 'number' || (v.unit !== 'px' && v.unit !== 'rem')) {
    throw new Error(`${path}: a dimension is {value: number, unit: "px" | "rem"}`)
  }
  return `${num(v.value)}${v.unit}`
}

/** @param {string} path @param {any} v */
function duration(path, v) {
  if (!v || typeof v.value !== 'number' || (v.unit !== 'ms' && v.unit !== 's')) {
    throw new Error(`${path}: a duration is {value: number, unit: "ms" | "s"}`)
  }
  return `${num(v.value)}${v.unit}`
}

/** @param {string} path @param {any} v */
function fontWeight(path, v) {
  if (typeof v === 'number') return num(v)
  if (typeof v === 'string' && v in WEIGHTS) return String(WEIGHTS[v])
  throw new Error(`${path}: unknown fontWeight ${JSON.stringify(v)}`)
}

/** @param {any} v */
function fontFamily(v) {
  const list = Array.isArray(v) ? v : [v]
  return list.map((f) => (GENERIC_FAMILIES.has(f) ? f : `"${f}"`)).join(', ')
}

/**
 * Resolution context: how to turn a (possibly aliased) sub-value into text.
 * @typedef {{ u: Universe, literal: boolean, stack: string[] }} Ctx
 */

/**
 * Text of `raw` (a $value or composite part) of DTCG type `type`.
 * @param {Ctx} ctx
 * @param {string} path  owning token, for messages
 * @param {string} type
 * @param {any} raw
 * @returns {string}
 */
function valueText(ctx, path, type, raw) {
  const target = aliasTarget(raw)
  if (target !== null) return aliasText(ctx, path, type, target)
  switch (type) {
    case 'color':
      return color(path, raw)
    case 'dimension':
      return dimension(path, raw)
    case 'duration':
      return duration(path, raw)
    case 'number':
      if (typeof raw !== 'number') throw new Error(`${path}: a number token needs a JSON number`)
      return num(raw)
    case 'fontWeight':
      return fontWeight(path, raw)
    case 'fontFamily':
      return fontFamily(raw)
    case 'cubicBezier':
      if (!Array.isArray(raw) || raw.length !== 4) throw new Error(`${path}: cubicBezier needs four numbers`)
      return `cubic-bezier(${raw.map(num).join(', ')})`
    case 'shadow': {
      const layers = Array.isArray(raw) ? raw : [raw]
      return layers
        .map((l) => {
          const len = (/** @type {any} */ d) => {
            const t = valueText(ctx, path, 'dimension', d)
            return /^-?0(px|rem)$/.test(t) ? '0' : t
          }
          const spread = len(l.spread)
          return [
            l.inset ? 'inset' : null,
            len(l.offsetX),
            len(l.offsetY),
            len(l.blur),
            spread === '0' ? null : spread,
            valueText(ctx, path, 'color', l.color),
          ]
            .filter((x) => x !== null)
            .join(' ')
        })
        .join(', ')
    }
    case 'typography':
      return `${valueText(ctx, path, 'fontWeight', raw.fontWeight)} ${valueText(ctx, path, 'dimension', raw.fontSize)}/${valueText(
        ctx,
        path,
        'number',
        raw.lineHeight,
      )} ${valueText(ctx, path, 'fontFamily', raw.fontFamily)}`
    default:
      throw new Error(`${path}: $type ${type} has no CSS emitter yet`)
  }
}

/**
 * @param {Ctx} ctx
 * @param {string} path
 * @param {string} type  the type the referring position expects
 * @param {string} target
 * @param {string} [suffix]  '-tracking' for the typography companion
 * @returns {string}
 */
function aliasText(ctx, path, type, target, suffix = '') {
  const t = ctx.u.get(target)
  if (!t) throw new Error(`${path}: alias {${target}} does not resolve to a token`)
  if (t.type !== type) throw new Error(`${path}: alias {${target}} is of type ${t.type}, expected type ${type}`)
  if (ctx.stack.includes(target)) throw new Error(`${path}: alias cycle ${[...ctx.stack, target].join(' -> ')}`)
  if (!ctx.literal && t.ext.css) return `var(${t.ext.css}${suffix})`
  const inner = { ...ctx, stack: [...ctx.stack, target] }
  return suffix ? trackingText(inner, t) : valueText(inner, t.path, t.type ?? '', t.value)
}

/**
 * The letter-spacing companion of a typography token.
 * @param {Ctx} ctx
 * @param {FlatToken} t
 * @returns {string}
 */
function trackingText(ctx, t) {
  const target = aliasTarget(t.value)
  if (target !== null) return aliasText(ctx, t.path, 'typography', target, '-tracking')
  return valueText(ctx, t.path, 'dimension', /** @type {any} */ (t.value).letterSpacing)
}

/**
 * @param {Universe} u
 * @param {string} path
 */
function tokenOf(u, path) {
  const t = u.get(path)
  if (!t) throw new Error(`no token ${path}`)
  if (!t.type) throw new Error(`${path}: no $type`)
  return t
}

/**
 * The CSS text of one token: `var(--x)` for an alias to a CSS-variable token.
 * @param {Universe} u
 * @param {string} path
 */
export function cssText(u, path) {
  const t = tokenOf(u, path)
  return valueText({ u, literal: false, stack: [path] }, path, /** @type {string} */ (t.type), t.value)
}

/**
 * The fully resolved literal of one token (no var(), however it aliases).
 * @param {Universe} u
 * @param {string} path
 */
export function literalText(u, path) {
  const t = tokenOf(u, path)
  return valueText({ u, literal: true, stack: [path] }, path, /** @type {string} */ (t.type), t.value)
}

/**
 * Every emitted declaration, in document order. A typography token emits the
 * font shorthand under its name and letter-spacing under `<name>-tracking`.
 * @param {Universe} u
 * @returns {[string, string][]}
 */
export function emitDeclarations(u) {
  /** @type {[string, string][]} */
  const out = []
  for (const t of u.values()) {
    const name = t.ext.css
    if (!name || t.ext.handWritten) continue
    out.push([name, cssText(u, t.path)])
    if (t.type === 'typography') {
      out.push([`${name}-tracking`, trackingText({ u, literal: false, stack: [t.path] }, t)])
    }
  }
  return out
}
