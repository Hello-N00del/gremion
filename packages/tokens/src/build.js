// The token build (UX-032 web target; brief Q1: a custom build, no Style
// Dictionary). Reads the DTCG documents, emits app-agnostic CSS custom
// properties for light (:root) and dark (.dark), derives the per-palette
// accent overrides through the engine, and keeps a consumer stylesheet's
// /* tokens:generated */ fences in sync.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { emitDeclarations, literalText } from './emit-css.js'
import { instanceAccentVars } from './engine/accent.js'
import { lintTiers } from './lint.js'
import { flatten, mergeDocs } from './model.js'
import { parseStrictJson } from './strict-json.js'
import { validateResolverDocument, validateTokenDocument } from './validate.js'

/** @typedef {[string, string][]} Declarations */
/** @typedef {{ light: Declarations, dark: Declarations }} BuiltCss */
/** @typedef {{ base: Record<string, any>, dark: Record<string, any> }} TokenSets */
/**
 * @typedef {{ H: number, hue?: string, light: Record<string, string>, dark: Record<string, string> }} PaletteOverride
 */

const TOKENS_DIR = new URL('../tokens/', import.meta.url)
/** @param {string} rel */
const tokensPath = (rel) => fileURLToPath(new URL(rel, TOKENS_DIR))

/**
 * Load, validate and lint the shipped token sets. Throws on any schema or
 * tier violation, so nothing downstream ever sees an invalid document.
 * @returns {TokenSets}
 */
export function loadTokens() {
  /** @type {string[]} */
  const problems = []
  /** @param {string} rel */
  const read = (rel) => {
    const text = readFileSync(tokensPath(rel), 'utf8')
    const res = validateTokenDocument(text, rel)
    problems.push(...res.errors)
    return res.ok ? parseStrictJson(text, rel) : {}
  }
  const base = read('gremion.tokens.json')
  const dark = read('modes/dark.tokens.json')
  const resolver = validateResolverDocument(readFileSync(tokensPath('gremion.resolver.json'), 'utf8'), 'gremion.resolver.json')
  problems.push(...resolver.errors)
  problems.push(...lintTiers(base).map((v) => `gremion.tokens.json: ${v.message}`))
  problems.push(...lintTiers(dark, { against: base }).map((v) => `modes/dark.tokens.json: ${v.message}`))
  if (problems.length > 0) throw new Error(`@gremion/tokens: invalid token sets:\n  ${problems.join('\n  ')}`)
  return { base, dark }
}

/**
 * Light declarations for :root; dark declarations for .dark are the emitted
 * tokens whose text differs once the dark set is layered over the base.
 * @param {TokenSets} sets
 * @returns {BuiltCss}
 */
export function buildCss(sets) {
  const light = emitDeclarations(flatten(sets.base))
  const darkAll = emitDeclarations(flatten(mergeDocs(sets.base, sets.dark)))
  const lightMap = new Map(light)
  const dark = darkAll.filter(([name, text]) => lightMap.get(name) !== text)
  return { light, dark }
}

/**
 * The fully resolved literal CSS text of a token (no var()).
 * @param {Map<string, import('./model.js').FlatToken>} universe
 * @param {string} path
 */
export function resolveTokenValue(universe, path) {
  return literalText(universe, path)
}

/**
 * Per-palette accent overrides: for every core hue marked `palette`, the
 * engine's output for that hue. The engine is injectable only so a test can
 * prove it is called; the default is the one instanceAccentVars.
 * @param {Record<string, any>} base
 * @param {{ engine?: (H: number) => { light: Record<string, string>, dark: Record<string, string> } }} [opts]
 * @returns {Record<string, PaletteOverride>}
 */
export function buildPalettes(base, opts = {}) {
  const engine = opts.engine ?? instanceAccentVars
  /** @type {Record<string, PaletteOverride>} */
  const out = {}
  for (const t of flatten(base).values()) {
    if (!t.path.startsWith('core.hue.') || !t.ext.palette) continue
    if (t.type !== 'number' || typeof t.value !== 'number') throw new Error(`${t.path}: a palette hue is a number token`)
    const { light, dark } = engine(t.value)
    out[t.path.slice('core.hue.'.length)] = { H: t.value, ...(t.ext.hue ? { hue: t.ext.hue } : {}), light, dark }
  }
  if (Object.keys(out).length === 0) throw new Error('core.hue holds no palette hue: the palette set would be empty')
  return out
}

// ── fences ──────────────────────────────────────────────────────────────

const MODES = /** @type {const} */ (['light', 'dark'])
/** @param {'light' | 'dark'} mode */
const beginRe = (mode) => new RegExp(`^([ \\t]*)/\\* tokens:generated:${mode}:begin\\b[^*]*\\*/[ \\t]*$`, 'gm')
/** @param {'light' | 'dark'} mode */
const endRe = (mode) => new RegExp(`^[ \\t]*/\\* tokens:generated:${mode}:end \\*/[ \\t]*$`, 'gm')

/**
 * @param {string} css
 * @param {'light' | 'dark'} mode
 * @returns {{ start: number, end: number, indent: string, eol: string } | string}
 *   the span of the fenced body (between the marker lines), or a problem
 */
function locate(css, mode) {
  const begins = [...css.matchAll(beginRe(mode))]
  const ends = [...css.matchAll(endRe(mode))]
  if (begins.length !== 1 || ends.length !== 1) {
    return `${mode}: expected exactly one tokens:generated:${mode}:begin and one :end fence, found ${begins.length} and ${ends.length}`
  }
  const b = /** @type {RegExpMatchArray & { index: number }} */ (begins[0])
  const e = /** @type {RegExpMatchArray & { index: number }} */ (ends[0])
  if (e.index <= b.index) return `${mode}: the :end fence comes before the :begin fence`
  const eol = css.includes('\r\n') ? '\r\n' : '\n'
  const start = css.indexOf('\n', b.index) + 1
  // The fenced block must sit inside the right rule: :root for light, the
  // first .dark rule for dark (design-tokens-presence.test.ts reads that one).
  const before = css.slice(0, b.index)
  const openRule = before.lastIndexOf('{')
  const closeRule = before.lastIndexOf('}')
  const commentEnd = before.lastIndexOf('*/', openRule)
  const selector = before.slice(Math.max(closeRule + 1, commentEnd === -1 ? 0 : commentEnd + 2), openRule).trim()
  const want = mode === 'light' ? ':root' : '.dark'
  if (openRule < closeRule || selector !== want) {
    return `${mode}: the fence is not directly inside the ${want} rule`
  }
  return { start, end: e.index, indent: b[1] ?? '', eol }
}

/**
 * @param {Declarations} decls
 * @param {string} indent
 * @param {string} eol
 */
function renderBody(decls, indent, eol) {
  return decls.map(([n, v]) => `${indent}${n}: ${v};${eol}`).join('')
}

/**
 * Problems with a consumer stylesheet's fences (missing, duplicated,
 * misplaced, or stale against the build). Empty means in sync.
 * @param {string} css
 * @param {BuiltCss} built
 * @returns {string[]}
 */
export function checkFences(css, built) {
  /** @type {string[]} */
  const problems = []
  for (const mode of MODES) {
    const at = locate(css, mode)
    if (typeof at === 'string') {
      problems.push(at)
      continue
    }
    if (css.slice(at.start, at.end) !== renderBody(built[mode], at.indent, at.eol)) {
      problems.push(`${mode}: the generated block is stale; run pnpm --filter @gremion/tokens build -- --write <stylesheet>`)
    }
  }
  return problems
}

/**
 * Rewrite only the fenced bodies. Throws when a fence is missing or misplaced
 * (it never appends a block of its own).
 * @param {string} css
 * @param {BuiltCss} built
 * @returns {string}
 */
export function syncFences(css, built) {
  let out = css
  for (const mode of MODES) {
    const at = locate(out, mode)
    if (typeof at === 'string') throw new Error(at)
    out = out.slice(0, at.start) + renderBody(built[mode], at.indent, at.eol) + out.slice(at.end)
  }
  return out
}
