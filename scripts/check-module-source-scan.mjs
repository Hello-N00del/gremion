#!/usr/bin/env node
// In-tree module source scan — TASK-200 (L5-27), TDD 2 + TDD 4.
//
// A module under modules/<id>/ may reach nothing outside its own directory by
// source path. Every file under a module (node_modules skipped everywhere;
// dist, coverage and .svelte-kit only at the module root) is read:
//   *.{ts,tsx,mts,cts,js,jsx,mjs,cjs,svelte} — comments are blanked first by a
//     string/regex-aware lexer, then these are judged:
//       - import / export-from / import() / require() / require.resolve() /
//         import.meta.resolve() / createRequire(..)-bound calls / vi.mock()
//         specifiers;
//       - path.join|resolve(...) calls, resolved statically (see resolveBase);
//       - new URL('<lit>', import.meta.url);
//       - fs calls with a literal path (judged from the module root: the
//         package scripts and vitest run there);
//       - FAIL-CLOSED: every other string literal carrying a `..` path segment,
//         judged from the file's directory (a `${__dirname}/..` template too).
//   package.json — file:/link:/portal: dependency specs.
//   tsconfig*.json — extends, references[].path, compilerOptions.paths, include/files.
//   Dockerfile / Dockerfile.* / *.Dockerfile / Containerfile — COPY/ADD sources
//     (heredocs and URLs are not paths).
// A finding is a path that resolves outside its own modules/<id>/, any
// upstream/, services/ or StuRaOS segment, an @stura* package, or a SvelteKit
// alias ($lib/, $app/, $env/) OUTSIDE an app/ half. Inside modules/<id>/app/**
// those aliases are the host app's by design (the app half is assembled into it,
// TASK-205) and are counted, not judged.
//
// A finding passes only when a REASONED allowance names it, per finding, not per file:
//   - modules/COUPLED-TESTS.json — a test file (under the module's test/, a
//     *.test.* the vitest include collects) with reason, owning task and the
//     exact targets it may reach ("allows"); the same list feeds the per-package
//     test runs as vitest --exclude (coupledExcludes);
//   - DOCKERFILE_ALLOWLIST — each leaf Dockerfile may COPY exactly its own
//     services/<svc> tree and upstream/gremion/packages/ports (the frozen StuRa
//     build context), nothing else.
// An allowance that excuses nothing is STALE and fails. The scan refuses zero files.
//
// Discovery (TDD 4): every directory under modules/ must be a workspace package
// check-toolchain.mjs's resolvePackageDirs actually returns ('modules/*/*' is
// joined literally, finds nothing and would silently drop every module).
//
// Run:  node scripts/check-module-source-scan.mjs
//       node scripts/check-module-source-scan.mjs --coupled-excludes <id>
// Test: node --test scripts/check-module-source-scan.test.mjs

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { resolvePackageDirs } from './check-toolchain.mjs'

export const KERNEL_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const COUPLED_PATH = 'modules/COUPLED-TESTS.json'
export const DISABLED_PATH = 'modules/disabled.json'

const LEAF_DOCKERFILE_REASON =
  'leaf image Dockerfile, copied byte-equal: its COPY sources (upstream/gremion/packages/ports, ' +
  'services/<svc>) are the frozen StuRa build context, not an in-tree coupling. The in-tree image ' +
  'build is owned by TASK-038/TASK-198, which rewrites the build context.'

const SVC_OF = { board: 'board', calendar: 'calendar', content: 'content', files: 'files', finance: 'finance', messaging: 'messages', publishing: 'newsletter', vault: 'vault', votes: 'votes' }

/** path -> { reason, sources }: the exact COPY sources each leaf Dockerfile may name. */
export const DOCKERFILE_ALLOWLIST = Object.freeze(
  Object.fromEntries(
    Object.entries(SVC_OF).map(([id, svc]) => [
      `modules/${id}/Dockerfile`,
      {
        reason: LEAF_DOCKERFILE_REASON,
        sources: [
          `services/${svc}`,
          `services/${svc}/package.json`,
          'upstream/gremion/packages/ports',
          'upstream/gremion/packages/ports/package.json',
        ],
      },
    ]),
  ),
)

const SOURCE_RE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|svelte)$/
const DOCKERFILE_RE = /(^|\/)(([^/]*\.)?Dockerfile(\.[^/]+)?|Containerfile(\.[^/]+)?)$/
const TSCONFIG_RE = /(^|\/)tsconfig[^/]*\.json$/
const ROOT_SKIP_DIRS = new Set(['dist', '.svelte-kit', 'coverage'])
/**
 * String literals the fail-closed `..` net catches that are INPUT DATA, never a
 * path the file reads: path-traversal cases handed to the module's own
 * traversal guards. Per literal, with a reason; unused entries are stale.
 */
export const TRAVERSAL_FIXTURES = Object.freeze([
  { file: 'modules/files/test/webdav-path.test.ts', literal: '../../etc/passwd' },
  { file: 'modules/finance/test/storage.test.ts', literal: '../../etc/passwd' },
  { file: 'modules/finance/test/storage.test.ts', literal: 'finance/../../../etc/x' },
  { file: 'modules/finance/test/webdav-path.test.ts', literal: '../../escape' },
].map((e) => ({ ...e, reason: 'path-traversal input asserted to be REJECTED by the module\'s own path guard; never read' })))

const OWNER_RE = /^TASK-\d+[a-z]?(\/TASK-\d+[a-z]?)*$/
const COUPLED_TEST_RE = /^modules\/[^/]+\/test\/.+\.test\.[cm]?[jt]sx?$/

// ── lexing ───────────────────────────────────────────────────────────────

function lineOf(text, index) {
  let n = 1
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++
  return n
}

const REGEX_PREV = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^', ''])

/**
 * Blank every comment (same length, newlines kept, so indexes and line numbers
 * survive) and collect every string literal. Regex literals are skipped by the
 * usual previous-token heuristic so a quote inside one never opens a string.
 * @returns {{ code: string, strings: {value: string, quote: string, index: number}[] }}
 */
export function lex(text) {
  const out = text.split('')
  const strings = []
  let prev = ''
  let i = 0
  const blank = (a, b) => {
    for (let k = a; k < b; k++) if (out[k] !== '\n') out[k] = ' '
  }
  while (i < text.length) {
    const ch = text[i]
    const nx = text[i + 1]
    if (ch === '/' && nx === '/') {
      const e = text.indexOf('\n', i)
      const end = e === -1 ? text.length : e
      blank(i, end)
      i = end
      continue
    }
    if (ch === '/' && nx === '*') {
      const e = text.indexOf('*/', i + 2)
      const end = e === -1 ? text.length : e + 2
      blank(i, end)
      i = end
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1
      let value = ''
      while (j < text.length && text[j] !== ch) {
        if (text[j] === '\\') {
          value += text[j + 1] ?? ''
          j += 2
          continue
        }
        if (ch !== '`' && text[j] === '\n') break
        value += text[j++]
      }
      strings.push({ value, quote: ch, index: i })
      i = j + 1
      prev = 'str'
      continue
    }
    if (ch === '/' && (REGEX_PREV.has(prev) || prev === 'return')) {
      let j = i + 1
      let cls = false
      while (j < text.length && text[j] !== '\n') {
        if (text[j] === '\\') {
          j += 2
          continue
        }
        if (text[j] === '[') cls = true
        else if (text[j] === ']') cls = false
        else if (text[j] === '/' && !cls) break
        j++
      }
      i = j + 1
      prev = 're'
      continue
    }
    if (!/\s/.test(ch)) {
      if (/[A-Za-z0-9_$]/.test(ch)) {
        let j = i
        while (j < text.length && /[A-Za-z0-9_$]/.test(text[j])) j++
        prev = text.slice(i, j)
        i = j
        continue
      }
      prev = ch
    }
    i++
  }
  return { code: out.join(''), strings }
}

// ── extraction ───────────────────────────────────────────────────────────

const SPEC_RES = [
  // import x from 'y' / import type {..} from 'y' / import 'y' / export * from 'y'
  /\b(?:import|export)\s+(?:type\s+)?(?:[^'"`;]*?\s*\bfrom\s*)?(['"])([^'"\n]+)\1/g,
  // any from-clause, so `export { a as "b" } from 'y'` is not lost to the quote in its clause
  /\bfrom\s*(['"])([^'"\n]+)\1/g,
  /\bimport\s*\(\s*(['"`])([^'"`\n]+)\1/g,
  /\brequire\s*\(\s*(['"`])([^'"`\n]+)\1/g,
  /\b(?:require\s*\.\s*resolve|import\s*\.\s*meta\s*\.\s*resolve)\s*\(\s*(['"`])([^'"`\n]+)\1/g,
  /\bvi\s*\.\s*(?:mock|doMock|unmock|importActual|importMock)\s*(?:<[^>]*>)?\s*\(\s*(['"`])([^'"`\n]+)\1/g,
]

/** @returns [{ spec, line }] — comments are ignored. */
export function extractSpecifiers(text) {
  const { code } = lex(text)
  const res = [...SPEC_RES]
  for (const m of code.matchAll(/\b([A-Za-z_$][\w$]*)\s*=\s*(?:module\s*\.\s*)?createRequire\s*\(/g))
    res.push(new RegExp(`\\b${m[1].replace(/\$/g, '\\$')}\\s*(?:\\.\\s*resolve\\s*)?\\(\\s*(['"\`])([^'"\`\\n]+)\\1`, 'g'))
  const out = []
  const seen = new Set()
  for (const re of res) {
    for (const m of code.matchAll(re)) {
      const at = m.index + m[0].lastIndexOf(m[2])
      if (seen.has(at)) continue
      seen.add(at)
      out.push({ spec: m[2], line: lineOf(code, at), index: at })
    }
  }
  return out.sort((a, b) => a.line - b.line)
}

// A tiny argument splitter: top-level commas of a call, string- and bracket-aware.
function splitCall(text, open) {
  const args = []
  let depth = 0
  let cur = ''
  let quote = null
  for (let i = open + 1; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      cur += ch
      if (ch === '\\') cur += text[++i] ?? ''
      else if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch
    else if ('([{'.includes(ch)) depth++
    else if (')]}'.includes(ch)) {
      if (depth === 0) {
        args.push(cur.trim())
        return { args: args.filter((a, k) => a !== '' || k < args.length - 1), end: i }
      }
      depth--
    } else if (ch === ',' && depth === 0) {
      args.push(cur.trim())
      cur = ''
      continue
    }
    cur += ch
  }
  return null
}

const STRING_LIT_RE = /^(['"`])([^'"`\n$]*)\1$/
// `path.join(`, `posix.resolve(`, or a bare imported `join(` / `resolve(` — never
// `<anything>.join(` (Array.prototype.join) or `<anything>.resolve(` (Promise.resolve).
const CALL_RE = /(?:\b(?:path|posix|win32|nodePath)\s*\.\s*|(?<![\w$.]\s*))(?:join|resolve)\s*\(/g

/** const/let/var NAME = <expr> assignments of the file, NAME -> expr text. */
function assignments(code) {
  const env = new Map()
  const re = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*/g
  for (const m of code.matchAll(re)) {
    let i = m.index + m[0].length
    let depth = 0
    let quote = null
    let expr = ''
    for (; i < code.length; i++) {
      const ch = code[i]
      if (quote) {
        expr += ch
        if (ch === quote) quote = null
        continue
      }
      if (ch === "'" || ch === '"' || ch === '`') quote = ch
      else if ('([{'.includes(ch)) depth++
      else if (')]}'.includes(ch)) depth--
      else if ((ch === ';' || ch === '\n') && depth <= 0) break
      expr += ch
    }
    if (!env.has(m[1])) env.set(m[1], expr.trim())
  }
  return env
}

/** path.resolve semantics over POSIX repo paths: an absolute segment restarts the path. */
function joinSegs(from, segs) {
  let cur = from
  for (const s of segs) cur = s.startsWith('/') ? posix.normalize(s) : posix.join(cur, s)
  cur = posix.normalize(cur)
  if (cur.length > 1) cur = cur.replace(/\/+$/, '')
  return cur === '' || cur === './' ? '.' : cur
}

/**
 * Resolve a base expression to a repo-relative POSIX path, or null when it is
 * not statically known: __dirname, import.meta.dirname,
 * dirname(fileURLToPath(import.meta.url)), fileURLToPath(import.meta.url),
 * fileURLToPath(new URL('<lit>', import.meta.url)), process.cwd() (the module
 * root), a nested join/resolve, a string literal (relative to the module root,
 * where the scripts run), and a same-file const holding any of those.
 */
function resolveBase(expr, ctx, depth = 0) {
  const e = expr.replace(/\s+/g, '')
  if (depth > 8) return null
  const lit = STRING_LIT_RE.exec(e)
  if (lit) return { path: joinSegs(ctx.moduleRoot, [lit[2]]), kind: 'literal' }
  if (e === '__dirname' || e === 'import.meta.dirname') return { path: ctx.fileDir, kind: 'file' }
  if (e === 'process.cwd()') return { path: ctx.moduleRoot, kind: 'module' }
  if (/^(?:path\.)?dirname\((?:url\.)?fileURLToPath\(import\.meta\.url\)\)$/.test(e)) return { path: ctx.fileDir, kind: 'file' }
  if (/^(?:url\.)?fileURLToPath\(import\.meta\.url\)$/.test(e)) return { path: ctx.filePath, kind: 'file' }
  const u = /^(?:url\.)?fileURLToPath\(newURL\((['"`])([^'"`]*)\1,import\.meta\.url\)\)$/.exec(e)
  if (u) return { path: joinSegs(ctx.fileDir, [u[2]]), kind: 'file' }
  const call = /^(?:path\.)?(?:join|resolve)\(/.exec(e)
  if (call) {
    const parsed = splitCall(e, call[0].length - 1)
    if (parsed && parsed.end === e.length - 1) {
      const r = evalCall(parsed.args, ctx, depth + 1)
      if (r && r.complete) return { path: r.resolved, kind: r.base }
    }
    return null
  }
  if (/^[A-Za-z_$][\w$]*$/.test(e) && ctx.env.has(e)) return resolveBase(ctx.env.get(e), ctx, depth + 1)
  return null
}

/** A segment: a string literal, or a same-file const holding one. */
function segValue(arg, ctx) {
  const m = STRING_LIT_RE.exec(arg.trim())
  if (m) return m[2]
  const id = arg.trim()
  if (/^[A-Za-z_$][\w$]*$/.test(id) && ctx.env.has(id)) {
    const v = STRING_LIT_RE.exec(ctx.env.get(id).trim())
    if (v) return v[2]
  }
  return null
}

function evalCall(args, ctx, depth) {
  if (args.length === 0) return null
  // One argument, or a literal first argument: judged from the module root (cwd).
  const firstLit = segValue(args[0], ctx)
  let b
  let rest
  if (firstLit !== null && !/^[A-Za-z_$][\w$]*$/.test(args[0].trim())) {
    b = { path: ctx.moduleRoot, kind: 'literal' }
    rest = args
  } else {
    if (args.length < 2) return null
    b = resolveBase(args[0], ctx, depth)
    rest = args.slice(1)
  }
  const segs = []
  let complete = true
  for (const a of rest) {
    const v = segValue(a, ctx)
    if (v === null) {
      complete = false
      break // a variable segment: judge the literal prefix only
    }
    segs.push(v)
  }
  if (segs.length === 0) return null
  const from = b ? b.path : ctx.moduleRoot
  return { rel: segs.join('/'), base: b ? b.kind : 'unknown', resolved: joinSegs(from, segs), complete: complete && !!b }
}

const URL_RE = /\bnew\s+URL\s*\(\s*(['"`])([^'"`\n]+)\1\s*,\s*import\.meta\.url\s*\)/g
const FS_CALL_RE =
  /\b(?:readFileSync|readFile|existsSync|readdirSync|readdir|statSync|lstatSync|stat|lstat|createReadStream|createWriteStream|writeFileSync|writeFile|accessSync|access|opendir|opendirSync|rmSync|mkdirSync|copyFileSync|cpSync)\s*\(\s*(['"`])([^'"`$\n]+)\1/g

/**
 * Path literals of a source file, resolved against its location.
 * @returns [{ rel, base, resolved, line }]
 */
export function extractPathLiterals(text, fileRel = 'modules/x/src/file.ts', moduleRoot = fileRel.split('/').slice(0, 2).join('/')) {
  const { code } = lex(text)
  const ctx = { filePath: fileRel, fileDir: posix.dirname(fileRel), moduleRoot, env: assignments(code) }
  const out = []
  for (const m of code.matchAll(CALL_RE)) {
    const parsed = splitCall(code, m.index + m[0].length - 1)
    if (!parsed) continue
    const lit = evalCall(parsed.args, ctx, 0)
    if (lit) out.push({ rel: lit.rel, base: lit.base, resolved: lit.resolved, line: lineOf(code, m.index), index: m.index })
  }
  for (const m of code.matchAll(URL_RE))
    out.push({ rel: m[2], base: 'file', resolved: joinSegs(ctx.fileDir, [m[2]]), line: lineOf(code, m.index), index: m.index })
  for (const m of code.matchAll(FS_CALL_RE))
    out.push({ rel: m[2], base: 'module', resolved: joinSegs(moduleRoot, [m[2]]), line: lineOf(code, m.index), index: m.index })
  return out.sort((a, b) => a.line - b.line)
}

const DOTDOT_RE = /(^|\/)\.\.(\/|$)/
const DIR_TEMPLATE_RE = /^\$\{\s*(?:__dirname|import\.meta\.dirname)\s*\}(.*)$/

/**
 * FAIL-CLOSED net: every string literal carrying a `..` segment, judged from
 * the file's directory (a leading '/' — `__dirname + '/../x'` — is dropped).
 * Templates count when they are `${__dirname}...`; other templates only when
 * their static text alone climbs.
 */
export function extractDotDotLiterals(text, fileRel = 'modules/x/src/file.ts') {
  const { strings } = lex(text)
  const out = []
  for (const s of strings) {
    let v = s.value
    if (s.quote === '`') {
      const d = DIR_TEMPLATE_RE.exec(v)
      if (d) v = d[1]
      else if (v.includes('${')) v = v.replace(/\$\{[^}]*\}/g, 'X')
    }
    if (!DOTDOT_RE.test(v)) continue
    out.push({ rel: v, resolved: joinSegs(posix.dirname(fileRel), [v.replace(/^\/+/, '')]), line: lineOf(text, s.index), index: s.index })
  }
  return out
}

/** COPY/ADD sources of a Dockerfile (never --from= stage copies, heredocs or URLs). */
export function extractDockerCopySources(text) {
  const out = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const start = i
    let line = lines[i]
    while (/\\\s*$/.test(line) && i + 1 < lines.length) line = line.replace(/\\\s*$/, ' ') + lines[++i]
    const m = /^\s*(?:COPY|ADD)\s+(.*)$/i.exec(line)
    if (!m) continue
    let rest = m[1].trim()
    const flags = []
    while (/^--\S+/.test(rest)) {
      const f = /^(--\S+)\s*/.exec(rest)
      flags.push(f[1])
      rest = rest.slice(f[0].length)
    }
    if (flags.some((f) => /^--from=/i.test(f))) continue
    let args
    if (rest.startsWith('[')) {
      try {
        args = JSON.parse(rest)
      } catch {
        args = []
      }
    } else args = rest.split(/\s+/).filter(Boolean)
    for (const source of args.slice(0, -1)) {
      if (source.startsWith('<<') || /^[a-z][a-z0-9+.-]*:\/\//i.test(source)) continue
      out.push({ source, line: start + 1 })
    }
  }
  return out
}

/** package.json dependency specs that point at a path. */
export function extractPackagePaths(text) {
  let json
  try {
    json = JSON.parse(text)
  } catch {
    return [{ bad: true }]
  }
  const out = []
  for (const k of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'])
    for (const [name, spec] of Object.entries(json[k] ?? {})) {
      const m = /^(?:file|link|portal):(.+)$/.exec(String(spec))
      if (m) out.push({ what: `${k}.${name} ${spec}`, rel: m[1] })
      if (/^@stura/i.test(name)) out.push({ what: `${k}.${name}`, rel: null, stura: true })
    }
  return out
}

function parseJsonc(text) {
  const { code } = lex(text)
  return JSON.parse(code.replace(/,(\s*[\]}])/g, '$1'))
}

/** tsconfig path fields. */
export function extractTsconfigPaths(text) {
  let json
  try {
    json = parseJsonc(text)
  } catch {
    return [{ bad: true }]
  }
  const out = []
  if (typeof json.extends === 'string' && json.extends.startsWith('.')) out.push({ what: `extends ${json.extends}`, rel: json.extends })
  for (const r of json.references ?? []) if (r?.path) out.push({ what: `references ${r.path}`, rel: r.path })
  for (const [k, vs] of Object.entries(json.compilerOptions?.paths ?? {}))
    for (const v of vs) out.push({ what: `paths.${k} ${v}`, rel: v })
  for (const key of ['include', 'files', 'exclude']) for (const v of json[key] ?? []) if (DOTDOT_RE.test(v)) out.push({ what: `${key} ${v}`, rel: v })
  return out
}

// ── rules ────────────────────────────────────────────────────────────────

const SEGMENT_RULES = [
  [/(^|\/)upstream(\/|$)/, 'carries an upstream/ segment'],
  [/(^|\/)services(\/|$)/, 'carries a services/ segment'],
  [/StuRaOS/i, 'carries a StuRaOS segment'],
]
const ALIAS_RE = /^\$(?:lib|app|env)(\/|$)/

const inside = (p, root) => p === root || p.startsWith(root + '/')

function specifierFinding(spec, fileRel, moduleRoot) {
  const why = []
  let target = spec
  if (/^@stura/i.test(spec)) why.push('names an @stura* package')
  for (const [re, w] of SEGMENT_RULES) if (re.test(spec)) why.push(w)
  if (spec.startsWith('/')) why.push('is an absolute path')
  if (ALIAS_RE.test(spec) && !inside(fileRel, `${moduleRoot}/app`))
    why.push('is a SvelteKit alias outside an app/ half — only modules/<id>/app/** is assembled into the host app')
  if (spec.startsWith('./') || spec.startsWith('../')) {
    target = posix.normalize(posix.join(posix.dirname(fileRel), spec))
    if (!inside(target, moduleRoot)) why.push(`leaves ${moduleRoot}/ (resolves to ${target})`)
  }
  return { why, target }
}

function resolvedFinding(rel, resolved, base, moduleRoot) {
  const why = []
  for (const [re, w] of SEGMENT_RULES) if (re.test(rel)) why.push(w)
  if (!inside(resolved, moduleRoot)) why.push(`leaves ${moduleRoot}/ (resolves to ${resolved}${base ? `, base ${base}` : ''})`)
  return { why, target: resolved }
}

function copyFinding(source) {
  const why = []
  for (const [re, w] of SEGMENT_RULES) if (re.test(source)) why.push(w)
  if (source.startsWith('..') || source.startsWith('/')) why.push('reaches outside the build context root')
  return { why, target: posix.normalize(source.replace(/\/+$/, '')) }
}

// ── the coupled-test list ────────────────────────────────────────────────

export function validateCoupledTests(root, doc) {
  if (!doc || !Array.isArray(doc.entries)) return [`${COUPLED_PATH}: no "entries" array`]
  const problems = []
  const seen = new Set()
  doc.entries.forEach((e, i) => {
    const where = `${COUPLED_PATH} entry ${i}`
    if (!e || typeof e.path !== 'string' || !COUPLED_TEST_RE.test(e.path)) {
      problems.push(`${where}: "path" must be a test file the module's vitest include collects (modules/<id>/test/**/*.test.*) — an exclusion elsewhere excludes nothing`)
      return
    }
    if (typeof e.reason !== 'string' || e.reason.trim() === '') problems.push(`${where} (${e.path}): empty or missing "reason"`)
    if (typeof e.owner !== 'string' || !OWNER_RE.test(e.owner.trim())) problems.push(`${where} (${e.path}): "owner" must name the owning task(s) (TASK-<n>[/TASK-<n>])`)
    if (!Array.isArray(e.allows) || e.allows.length === 0 || e.allows.some((a) => typeof a !== 'string' || a === ''))
      problems.push(`${where} (${e.path}): "allows" must list the exact targets this file may reach — an allowance is per finding, never per file`)
    const abs = join(root, e.path)
    if (!existsSync(abs) || !statSync(abs).isFile()) problems.push(`${where}: ${e.path} does not exist — a coupled-test entry for no file excludes nothing`)
    if (seen.has(e.path)) problems.push(`${where}: duplicate path ${e.path}`)
    seen.add(e.path)
  })
  return problems
}

function readCoupled(root) {
  const abs = join(root, COUPLED_PATH)
  if (!existsSync(abs)) return { doc: null, problems: [`${COUPLED_PATH} is missing — the list is empty or written, never absent`] }
  let doc
  try {
    doc = JSON.parse(readFileSync(abs, 'utf8'))
  } catch (err) {
    return { doc: null, problems: [`${COUPLED_PATH}: not JSON — ${err.message}`] }
  }
  return { doc, problems: validateCoupledTests(root, doc) }
}

// ── walking ──────────────────────────────────────────────────────────────

function moduleDirs(root) {
  const abs = join(root, 'modules')
  if (!existsSync(abs)) return []
  return readdirSync(abs)
    .filter((n) => statSync(join(abs, n)).isDirectory())
    .sort()
}

function walk(root, rel, moduleRoot, out) {
  for (const name of readdirSync(join(root, rel)).sort()) {
    const r = `${rel}/${name}`
    const st = statSync(join(root, r))
    if (st.isDirectory()) {
      if (name === 'node_modules') continue
      if (rel === moduleRoot && ROOT_SKIP_DIRS.has(name)) continue
      walk(root, r, moduleRoot, out)
    } else if (st.isFile()) out.push(r)
  }
  return out
}

// ── the scan ─────────────────────────────────────────────────────────────

const matchesAllow = (target, allow) => target === allow || (allow !== '.' && target.startsWith(allow + '/'))

/**
 * @param root kernel root (or a fixture)
 * @param opts.dockerAllowlist path -> { reason, sources }; defaults to DOCKERFILE_ALLOWLIST
 */
export function scanModules(root, { dockerAllowlist = DOCKERFILE_ALLOWLIST, traversalFixtures = TRAVERSAL_FIXTURES } = {}) {
  const problems = []
  const { doc, problems: coupledProblems } = readCoupled(root)
  problems.push(...coupledProblems)
  const coupled = new Map((doc?.entries ?? []).filter((e) => Array.isArray(e.allows)).map((e) => [e.path, e]))

  for (const [path, a] of Object.entries(dockerAllowlist))
    if (!a || typeof a.reason !== 'string' || a.reason.trim() === '' || !Array.isArray(a.sources) || a.sources.length === 0)
      problems.push(`DOCKERFILE_ALLOWLIST ${path}: needs a reason and the exact sources it allows`)

  const findings = []
  const counts = { filesScanned: 0, specifiers: 0, literals: 0, dockerfiles: 0, manifests: 0, aliases: 0 }
  const ids = moduleDirs(root)
  const add = (file, line, what, f) => {
    if (f.why.length) findings.push({ file, line, what, target: f.target, why: f.why, literal: f.literal })
  }
  for (const id of ids) {
    const moduleRoot = `modules/${id}`
    for (const rel of walk(root, moduleRoot, moduleRoot, [])) {
      const text = () => readFileSync(join(root, rel), 'utf8')
      if (DOCKERFILE_RE.test(rel)) {
        counts.filesScanned++
        counts.dockerfiles++
        for (const c of extractDockerCopySources(text())) add(rel, c.line, `COPY ${c.source}`, copyFinding(c.source))
        continue
      }
      if (/(^|\/)package\.json$/.test(rel)) {
        counts.filesScanned++
        counts.manifests++
        for (const p of extractPackagePaths(text())) {
          if (p.bad) problems.push(`${rel}: not JSON`)
          else if (p.stura) add(rel, 1, p.what, { why: ['names an @stura* package'], target: p.what })
          else add(rel, 1, p.what, resolvedFinding(p.rel, joinSegs(posix.dirname(rel), [p.rel]), null, moduleRoot))
        }
        continue
      }
      if (TSCONFIG_RE.test(rel)) {
        counts.filesScanned++
        counts.manifests++
        for (const p of extractTsconfigPaths(text())) {
          if (p.bad) problems.push(`${rel}: not parseable as JSONC`)
          else add(rel, 1, p.what, resolvedFinding(p.rel, joinSegs(posix.dirname(rel), [p.rel.replace(/\/\*.*$/, '')]), null, moduleRoot))
        }
        continue
      }
      if (!SOURCE_RE.test(rel)) continue
      const src = text()
      counts.filesScanned++
      const seenAt = new Set()
      for (const s of extractSpecifiers(src)) {
        counts.specifiers++
        seenAt.add(s.index)
        if (ALIAS_RE.test(s.spec) && inside(rel, `${moduleRoot}/app`)) counts.aliases++
        add(rel, s.line, `'${s.spec}'`, specifierFinding(s.spec, rel, moduleRoot))
      }
      const lits = extractPathLiterals(src, rel, moduleRoot)
      for (const l of lits) {
        counts.literals++
        add(rel, l.line, `path literal '${l.rel}'`, resolvedFinding(l.rel, l.resolved, l.base, moduleRoot))
      }
      const litLines = new Set(lits.map((l) => l.line))
      for (const d of extractDotDotLiterals(src, rel)) {
        if (seenAt.has(d.index + 1) || litLines.has(d.line)) continue // already judged as a specifier or a path call
        add(rel, d.line, `'..' literal '${d.rel}'`, { ...resolvedFinding(d.rel, d.resolved, 'file', moduleRoot), literal: d.rel })
      }
    }
  }
  if (counts.filesScanned === 0) problems.push('scanned zero files under modules/ — the scan would pass vacuously')

  // Per-finding allowances; each allowance must be used.
  const allowed = []
  const used = new Set()
  for (const f of findings) {
    const c = coupled.get(f.file)
    const d = dockerAllowlist[f.file]
    let ok = false
    const tf = f.literal !== undefined && traversalFixtures.find((t) => t.file === f.file && t.literal === f.literal)
    if (tf) {
      ok = true
      used.add(`traversal\u0000${tf.file}\u0000${tf.literal}`)
      allowed.push({ ...f, reason: tf.reason })
    } else if (c) {
      const a = c.allows.find((x) => matchesAllow(f.target, x))
      if (a !== undefined) {
        ok = true
        used.add(`${f.file}\u0000${a}`)
        allowed.push({ ...f, reason: c.reason })
      }
    } else if (d && f.what.startsWith('COPY ') && d.sources.includes(f.target) && !f.why.includes('reaches outside the build context root')) {
      ok = true
      used.add(`${f.file}\u0000${f.target}`)
      allowed.push({ ...f, reason: d.reason })
    }
    if (!ok) problems.push(`${f.file}:${f.line} ${f.what} ${f.why.join('; ')}`)
  }
  for (const [path, c] of coupled)
    for (const a of c.allows)
      if (!used.has(`${path}\u0000${a}`)) problems.push(`stale allowance: ${COUPLED_PATH} lets ${path} reach ${a}, but the scan finds no such coupling — delete it, or the scan has gone blind`)
  for (const t of traversalFixtures)
    if (!used.has(`traversal\u0000${t.file}\u0000${t.literal}`))
      problems.push(`stale allowance: TRAVERSAL_FIXTURES names '${t.literal}' in ${t.file}, which the scan no longer finds — delete it, or the scan has gone blind`)
  for (const [path] of Object.entries(dockerAllowlist)) {
    if (!existsSync(join(root, path))) {
      problems.push(`DOCKERFILE_ALLOWLIST names ${path}, which does not exist — stale allowance`)
      continue
    }
    if (![...used].some((u) => u.startsWith(`${path}\u0000`))) problems.push(`stale allowance: ${path} is allowlisted but the scan finds no allowed COPY source in it — delete the entry, or the scan has gone blind`)
  }
  return { problems, findings, allowed, ...counts, modules: ids }
}

/**
 * modules/disabled.json — modules that install and typecheck but are excluded
 * from the default build and deploy. Each id must be a module directory whose
 * package.json is "private": true, with a reason; no duplicates.
 */
export function validateDisabled(root, doc) {
  if (!doc || !Array.isArray(doc.disabled)) return [`${DISABLED_PATH}: no "disabled" array`]
  const problems = []
  const seen = new Set()
  doc.disabled.forEach((e, i) => {
    const where = `${DISABLED_PATH} entry ${i}`
    if (!e || typeof e.id !== 'string') {
      problems.push(`${where}: "id" missing`)
      return
    }
    if (seen.has(e.id)) problems.push(`${where}: duplicate id ${e.id}`)
    seen.add(e.id)
    if (typeof e.reason !== 'string' || e.reason.trim() === '') problems.push(`${where} (${e.id}): empty or missing "reason"`)
    const pkg = join(root, 'modules', e.id, 'package.json')
    if (!/^[a-z][a-z0-9-]*$/.test(e.id) || !existsSync(pkg)) {
      problems.push(`${where}: ${e.id} is not a module directory with a package.json`)
      return
    }
    let json
    try {
      json = JSON.parse(readFileSync(pkg, 'utf8'))
    } catch (err) {
      problems.push(`${where}: modules/${e.id}/package.json is not JSON — ${err.message}`)
      return
    }
    if (json.private !== true) problems.push(`${where}: modules/${e.id}/package.json is not "private": true — a disabled module must never publish`)
  })
  return problems
}

function readDisabled(root) {
  const abs = join(root, DISABLED_PATH)
  if (!existsSync(abs)) return [`${DISABLED_PATH} is missing`]
  try {
    return validateDisabled(root, JSON.parse(readFileSync(abs, 'utf8')))
  } catch (err) {
    return [`${DISABLED_PATH}: not JSON — ${err.message}`]
  }
}

/** TDD 4: every modules/<id> is a package the toolchain guard actually discovers. */
export function checkDiscovery(root, workspaceYamlText) {
  const ids = moduleDirs(root)
  const discovered = new Set(resolvePackageDirs(root, workspaceYamlText))
  const problems = []
  for (const id of ids) {
    const dir = `modules/${id}`
    if (!existsSync(join(root, dir, 'package.json'))) {
      problems.push(`${dir} carries no package.json — a module directory that is not a workspace package is invisible to install, build and every toolchain check`)
      continue
    }
    if (!discovered.has(dir))
      problems.push(`${dir} is not discovered by check-toolchain.mjs resolvePackageDirs from pnpm-workspace.yaml — it silently drops out of the lifecycle, strict-TS and suppression checks (the glob must be exactly 'modules/*')`)
  }
  if (ids.length === 0) problems.push('no module directory under modules/ — discovery would pass vacuously')
  return problems
}

/** vitest arguments that exclude modules/<id>'s coupled tests, paths relative to the module root. */
export function coupledExcludes(root, id) {
  const { doc, problems } = readCoupled(root)
  if (problems.length) throw new Error(`${COUPLED_PATH} is invalid: ${problems.join('; ')}`)
  // Only this module's COUPLED entries matter here; Dockerfile allowances are the scan's business.
  const scan = scanModules(root, { dockerAllowlist: {}, traversalFixtures: [] })
  const stale = scan.problems.filter((p) => p.startsWith(`stale allowance: ${COUPLED_PATH} lets modules/${id}/`))
  if (stale.length) throw new Error(`refusing to exclude: ${stale.join('; ')}`)
  const prefix = `modules/${id}/`
  return doc.entries.filter((e) => e.path.startsWith(prefix)).flatMap((e) => ['--exclude', e.path.slice(prefix.length)])
}

// ── CLI ──────────────────────────────────────────────────────────────────

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  let values
  try {
    ;({ values } = parseArgs({ args: process.argv.slice(2), options: { 'coupled-excludes': { type: 'string' } }, strict: true }))
  } catch (err) {
    console.error(`[module-source-scan] bad arguments — ${err.message}`)
    process.exit(2)
  }
  if (values['coupled-excludes'] !== undefined) {
    const id = values['coupled-excludes']
    if (!/^[a-z][a-z0-9-]*$/.test(id) || !existsSync(join(KERNEL_ROOT, 'modules', id))) {
      console.error(`[module-source-scan] no module directory modules/${id}`)
      process.exit(2)
    }
    try {
      for (const a of coupledExcludes(KERNEL_ROOT, id)) console.log(a)
    } catch (err) {
      console.error(`[module-source-scan] ${err.message}`)
      process.exit(1)
    }
    process.exit(0)
  }
  const r = scanModules(KERNEL_ROOT)
  const disc = checkDiscovery(KERNEL_ROOT, readFileSync(join(KERNEL_ROOT, 'pnpm-workspace.yaml'), 'utf8'))
  const problems = [...r.problems, ...disc, ...readDisabled(KERNEL_ROOT)]
  if (problems.length) {
    console.error(`[module-source-scan] ${problems.length} problem(s):`)
    for (const p of problems) console.error(`  x ${p}`)
    process.exit(1)
  }
  console.log(
    `[module-source-scan] OK — ${r.filesScanned} files in ${r.modules.length} modules (${r.specifiers} specifiers, ` +
      `${r.literals} path literals, ${r.dockerfiles} Dockerfiles, ${r.manifests} package/tsconfig manifests; ` +
      `${r.aliases} SvelteKit alias specifiers inside app/ halves, host-resolved, TASK-205); 0 unallowlisted findings; ${r.allowed.length} allowlisted ` +
      `in ${new Set(r.allowed.map((a) => a.file)).size} files; every module discovered by the workspace; ${DISABLED_PATH} valid.`,
  )
  for (const a of r.allowed) console.log(`  allowed ${a.file}:${a.line} ${a.what}`)
}
