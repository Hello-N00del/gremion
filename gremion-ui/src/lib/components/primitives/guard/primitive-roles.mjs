#!/usr/bin/env node
// TRD-413 guard (TASK-082): dialogs, selects, comboboxes and menus are built on
// the Bits UI primitives in src/lib/components/primitives. Its inspection is
// "a lint rule flags these roles outside the Bits UI wrappers", so in every
// .svelte file in scope and outside primitives/** it flags
//   (a) a raw <dialog> or <select> element (also <svelte:element this="...">);
//   (b) role="dialog|alertdialog|listbox|combobox|menu|menubar".
//
// Scope = the route directories in PRIMITIVE_GUARD_SCOPE PLUS every file those
// routes import, followed transitively through $lib and relative imports
// (static import/export-from and dynamic import()). An import the walk cannot
// resolve is itself a finding: a guard that silently skipped a component would
// pass vacuously. A scope whose route directory does not exist yet passes as
// the NAMED case 'empty-scope' (today: no routes/sitzungen on main; TASK-095,
// 096 and 097 create it), never as an unexplained zero.
//
//   node src/lib/components/primitives/guard/primitive-roles.mjs            (gremion-ui as cwd)
//   node .../primitive-roles.mjs --root <appRoot> --scope src/routes/x ...
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The one scope constant. `f2Governance` is gate F2's slice of TRD-413 (the
 * governance route tree); TASK-109 reuses this list and TASK-165 widens the
 * guard to the rest of the app at the verdict gate.
 */
export const PRIMITIVE_GUARD_SCOPE = Object.freeze({
  f2Governance: Object.freeze(['src/routes/sitzungen']),
})

export const PRIMITIVES_DIR = 'src/lib/components/primitives'
export const FLAGGED_TAGS = Object.freeze(['dialog', 'select'])
export const FLAGGED_ROLES = Object.freeze(['dialog', 'alertdialog', 'listbox', 'combobox', 'menu', 'menubar'])

const SOURCE_EXT = ['.svelte', '.ts', '.js', '.mjs']
const RESOLVE_SUFFIXES = ['', '.ts', '.js', '.mjs', '.svelte', '.svelte.ts', '.svelte.js', '/index.ts', '/index.js']

/**
 * @typedef {{ exists(p: string): boolean, isDir(p: string): boolean, list(p: string): string[], read(p: string): string }} GuardFs
 * @typedef {{ file: string, line: number, kind: 'raw-tag' | 'role' | 'unresolved-import', match: string }} Violation
 * @typedef {{ status: 'empty-scope' | 'scanned', reason?: string, roots: string[], scanned: string[], violations: Violation[] }} GuardResult
 */

/**
 * A GuardFs over the real disk, rooted at appRoot; paths are appRoot-relative
 * with forward slashes.
 * @param {string} appRoot
 * @returns {GuardFs}
 */
export function diskFs(appRoot) {
  const abs = (/** @type {string} */ p) => join(appRoot, p)
  return {
    exists: (p) => existsSync(abs(p)),
    isDir: (p) => existsSync(abs(p)) && statSync(abs(p)).isDirectory(),
    list: (p) => readdirSync(abs(p)),
    read: (p) => readFileSync(abs(p), 'utf8'),
  }
}

/** Normalise `a/./b/../c` (forward slashes, no leading ./). @param {string} p */
function normalise(p) {
  /** @type {string[]} */
  const out = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return out.join('/')
}

/** @param {string} p */
const dirOf = (p) => p.split('/').slice(0, -1).join('/')

/**
 * Replace a region with spaces, keeping newlines, so line numbers survive.
 * @param {string} text
 * @param {RegExp} re
 */
function blank(text, re) {
  return text.replace(re, (m) => m.replace(/[^\n]/g, ' '))
}

/**
 * Markup of a .svelte file with <script>, <style> and comments blanked out.
 * @param {string} text
 */
function markupOf(text) {
  let t = blank(text, /<script[\s\S]*?<\/script>/g)
  t = blank(t, /<style[\s\S]*?<\/style>/g)
  return blank(t, /<!--[\s\S]*?-->/g)
}

/** @param {string} text @param {number} index */
const lineAt = (text, index) => text.slice(0, index).split('\n').length

/**
 * Raw tags and flagged roles in one .svelte file's markup.
 * @param {string} file
 * @param {string} text
 * @returns {Violation[]}
 */
export function findViolations(file, text) {
  const markup = markupOf(text)
  /** @type {Violation[]} */
  const out = []
  const tag = new RegExp(`<(${FLAGGED_TAGS.join('|')})(?=[\\s/>])`, 'g')
  for (const m of markup.matchAll(tag)) out.push({ file, line: lineAt(markup, m.index ?? 0), kind: 'raw-tag', match: `<${m[1]}>` })
  const dyn = new RegExp(`<svelte:element[^>]*\\bthis\\s*=\\s*\\{?\\s*["'\`](${FLAGGED_TAGS.join('|')})["'\`]`, 'g')
  for (const m of markup.matchAll(dyn)) out.push({ file, line: lineAt(markup, m.index ?? 0), kind: 'raw-tag', match: `<svelte:element this="${m[1]}">` })
  const role = new RegExp(`\\brole\\s*=\\s*(?:\\{\\s*)?["'\`]?\\s*(${FLAGGED_ROLES.join('|')})(?=["'\`\\s}>])`, 'g')
  for (const m of markup.matchAll(role)) out.push({ file, line: lineAt(markup, m.index ?? 0), kind: 'role', match: `role="${m[1]}"` })
  return out
}

/**
 * Module specifiers a source file imports (static, re-export, dynamic).
 * @param {string} text
 */
export function importsOf(text) {
  const code = blank(blank(text, /\/\*[\s\S]*?\*\//g), /(^|[^:])\/\/[^\n]*/g)
  /** @type {string[]} */
  const out = []
  const res = [
    /\bimport\s+(?:type\s+)?(?:[\w*{}\s,$]+?\s+from\s+)?["']([^"']+)["']/g,
    /\bexport\s+(?:type\s+)?(?:\*|\{[^}]*\})(?:\s+as\s+\w+)?\s+from\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ]
  for (const re of res) for (const m of code.matchAll(re)) out.push(m[1])
  return out
}

/**
 * Resolve a specifier from `from` to an appRoot-relative file, null for a
 * package or a SvelteKit virtual module, or 'unresolved'.
 * @param {GuardFs} fs
 * @param {string} from
 * @param {string} spec
 * @returns {string | null}
 */
function resolveImport(fs, from, spec) {
  // SvelteKit's generated route types (./$types) are type-only and exist
  // only under .svelte-kit/; they carry no markup.
  if (spec === './$types' || spec.endsWith('/$types')) return null
  let base
  if (spec.startsWith('$lib/') || spec === '$lib') base = `src/lib${spec.slice(4)}`
  else if (spec.startsWith('./') || spec.startsWith('../')) base = `${dirOf(from)}/${spec}`
  else return null // bare package, $app/*, $env/*, virtual modules: outside the app tree
  const p = normalise(base)
  for (const suffix of RESOLVE_SUFFIXES) {
    const cand = `${p}${suffix}`
    if (fs.exists(cand) && !fs.isDir(cand)) return cand
  }
  return 'unresolved'
}

/**
 * Every source file under a directory, recursively, in a stable order.
 * @param {GuardFs} fs
 * @param {string} dir
 * @returns {string[]}
 */
function walkDir(fs, dir) {
  /** @type {string[]} */
  const out = []
  for (const name of [...fs.list(dir)].sort()) {
    const p = `${dir}/${name}`
    if (fs.isDir(p)) out.push(...walkDir(fs, p))
    else if (SOURCE_EXT.some((e) => name.endsWith(e))) out.push(p)
  }
  return out
}

/**
 * @param {{ fs: GuardFs, roots?: readonly string[] }} opts
 * @returns {GuardResult}
 */
export function checkPrimitiveRoles({ fs, roots = PRIMITIVE_GUARD_SCOPE.f2Governance }) {
  const present = roots.filter((r) => fs.isDir(r))
  const missing = roots.filter((r) => !fs.isDir(r))
  const start = present.flatMap((r) => walkDir(fs, r))
  if (start.length === 0) {
    return {
      status: 'empty-scope',
      reason:
        missing.length > 0
          ? `no route tree yet at ${missing.join(', ')} (created by TASK-095/096/097); nothing to inspect`
          : `the scope roots ${present.join(', ')} hold no source files`,
      roots: [...roots],
      scanned: [],
      violations: [],
    }
  }
  /** @type {Violation[]} */
  const violations = []
  /** @type {Set<string>} */
  const seen = new Set()
  const queue = [...start]
  while (queue.length > 0) {
    const file = /** @type {string} */ (queue.shift())
    if (seen.has(file)) continue
    seen.add(file)
    const text = fs.read(file)
    const inPrimitives = file === PRIMITIVES_DIR || file.startsWith(`${PRIMITIVES_DIR}/`)
    if (inPrimitives) continue // the wrappers are where these roles belong
    if (file.endsWith('.svelte')) violations.push(...findViolations(file, text))
    for (const spec of importsOf(text)) {
      const target = resolveImport(fs, file, spec)
      if (target === null) continue
      if (target === 'unresolved') {
        const idx = text.indexOf(spec)
        violations.push({ file, line: lineAt(text, idx < 0 ? 0 : idx), kind: 'unresolved-import', match: spec })
        continue
      }
      if (!seen.has(target)) queue.push(target)
    }
  }
  return { status: 'scanned', roots: [...roots], scanned: [...seen].sort(), violations }
}

/** @param {GuardResult} r */
export function formatResult(r) {
  if (r.status === 'empty-scope') return `[primitive-roles] PASS (empty-scope): ${r.reason}`
  const head = `[primitive-roles] scanned ${r.scanned.length} file(s) from ${r.roots.join(', ')} and their imports`
  if (r.violations.length === 0) return `${head}: PASS, no raw <dialog>/<select> or dialog/listbox/combobox/menu role outside ${PRIMITIVES_DIR}`
  const lines = r.violations.map((v) =>
    v.kind === 'unresolved-import'
      ? `  ${v.file}:${v.line} cannot resolve import '${v.match}' (the walk would miss what it imports)`
      : `  ${v.file}:${v.line} ${v.match}: use the Bits UI primitives in ${PRIMITIVES_DIR} (TRD-413)`,
  )
  return `${head}: FAIL, ${r.violations.length} finding(s)\n${lines.join('\n')}`
}

// CLI
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const rootAt = args.indexOf('--root')
  const appRoot = resolve(rootAt === -1 ? process.cwd() : args[rootAt + 1])
  /** @type {string[]} */
  const scope = []
  args.forEach((a, i) => {
    if (a === '--scope' && args[i + 1]) scope.push(args[i + 1])
  })
  const result = checkPrimitiveRoles({ fs: diskFs(appRoot), roots: scope.length > 0 ? scope : undefined })
  console.log(formatResult(result))
  process.exit(result.violations.length > 0 ? 1 : 0)
}
