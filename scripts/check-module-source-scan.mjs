#!/usr/bin/env node
// In-tree module source scan — TASK-200 (L5-27), TDD 2 + TDD 4.
//
// A module under modules/<id>/ may reach nothing outside its own directory by
// source path. Every import / export-from / import() / require() / vi.mock()
// specifier, every path.join|resolve(<file-dir or cwd>, '..', ...) literal and
// every new URL('..', import.meta.url) in modules/**/*.{ts,mts,cts,js,mjs,cjs,svelte}
// is parsed, and flagged when it
//   - is relative and resolves outside its own modules/<id>/,
//   - carries an upstream/, services/ or StuRaOS path segment, or
//   - names an @stura* package.
// Dockerfile COPY sources get the same segment rule. A finding passes only in a
// file a REASONED allowlist names:
//   - modules/COUPLED-TESTS.json — tests that are coupled to trees the kernel
//     does not hold (path, reason, owning task); the same list is what the
//     per-package test runs pass to vitest as --exclude (coupledExcludes);
//   - DOCKERFILE_ALLOWLIST below — the nine leaf Dockerfiles, whose build
//     context is the frozen StuRa layout.
// An allowlist entry that excuses nothing is STALE and fails: either the file
// stopped being coupled (delete the entry) or the scan went blind (fix it).
// The scan refuses zero files.
//
// Discovery (TDD 4): every directory under modules/ must be a workspace package
// check-toolchain.mjs's resolvePackageDirs actually returns. It resolves only a
// trailing "/*"; a 'modules/*/*' glob is joined literally, finds nothing and
// continues — every module would silently drop out of the lifecycle, strict-TS
// and suppression checks. That is refused here, by module name.
//
// Run:  node scripts/check-module-source-scan.mjs
//       node scripts/check-module-source-scan.mjs --coupled-excludes <id>
//         (prints the vitest --exclude arguments for modules/<id>, one per line)
// Test: node --test scripts/check-module-source-scan.test.mjs

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { resolvePackageDirs } from './check-toolchain.mjs'

export const KERNEL_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const COUPLED_PATH = 'modules/COUPLED-TESTS.json'

const LEAF_DOCKERFILE_REASON =
  'leaf image Dockerfile, copied byte-equal: its COPY sources (upstream/gremion/packages/ports, ' +
  'services/<svc>) are the frozen StuRa build context, not an in-tree coupling. The in-tree image ' +
  'build is owned by TASK-038/TASK-198, which rewrites the build context.'

/** path -> reason. Each must excuse at least one COPY finding, or it is stale. */
export const DOCKERFILE_ALLOWLIST = Object.freeze(
  Object.fromEntries(
    ['board', 'calendar', 'content', 'files', 'finance', 'messaging', 'publishing', 'vault', 'votes'].map((id) => [
      `modules/${id}/Dockerfile`,
      LEAF_DOCKERFILE_REASON,
    ]),
  ),
)

const SOURCE_RE = /\.(ts|mts|cts|js|mjs|cjs|svelte)$/
const DOCKERFILE_RE = /(^|\/)([^/]*\.)?Dockerfile$/
const SKIP_DIRS = new Set(['node_modules', 'dist', '.svelte-kit', 'coverage'])
const OWNER_RE = /^TASK-\d+[a-z]?(\/TASK-\d+[a-z]?)*$/

// ── extraction ───────────────────────────────────────────────────────────

function lineOf(text, index) {
  let n = 1
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++
  return n
}

const SPEC_RES = [
  // import x from 'y' / import type {..} from 'y' / import 'y' / export * from 'y' / export {..} from 'y'
  /\b(?:import|export)\s+(?:type\s+)?(?:[^'"`;]*?\s*\bfrom\s*)?(['"])([^'"\n]+)\1/g,
  /\bimport\s*\(\s*(['"`])([^'"`\n]+)\1\s*[,)]/g,
  /\brequire\s*\(\s*(['"`])([^'"`\n]+)\1\s*\)/g,
  /\bvi\s*\.\s*(?:mock|doMock|unmock|importActual|importMock)\s*(?:<[^>]*>)?\s*\(\s*(['"`])([^'"`\n]+)\1/g,
]

/** @returns [{ spec, line }] */
export function extractSpecifiers(text) {
  const out = []
  const seen = new Set()
  for (const re of SPEC_RES) {
    for (const m of text.matchAll(re)) {
      const at = m.index + m[0].lastIndexOf(m[2])
      const key = `${at}:${m[2]}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ spec: m[2], line: lineOf(text, at) })
    }
  }
  return out.sort((a, b) => a.line - b.line)
}

/**
 * Names that hold the file's own directory: __dirname, import.meta.dirname, and
 * any `const X = dirname(fileURLToPath(import.meta.url))` in the same file.
 */
function fileDirNames(text) {
  const names = new Set(['__dirname', 'import.meta.dirname'])
  const re = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:path\s*\.\s*)?dirname\s*\(\s*(?:url\s*\.\s*)?fileURLToPath\s*\(\s*import\.meta\.url\s*\)\s*\)/g
  for (const m of text.matchAll(re)) names.add(m[1])
  return names
}

const JOIN_RE = /\b(?:path\s*\.\s*)?(?:join|resolve)\s*\(\s*([A-Za-z_$][\w$.]*(?:\(\s*\))?)\s*,\s*((?:(['"`])[^'"`\n]*\3\s*,?\s*)+)\)/g
const URL_RE = /\bnew\s+URL\s*\(\s*(['"`])([^'"`\n]+)\1\s*,\s*import\.meta\.url\s*\)/g

/**
 * path.join/resolve literals and new URL(.., import.meta.url).
 * base: 'file' (the file's directory), 'module' (process.cwd(), which vitest
 * and the package scripts set to the module root), or 'unknown' (any other
 * identifier — treated as the module root, the most sensitive position).
 * @returns [{ rel, base, line }]
 */
export function extractPathLiterals(text) {
  const fileDirs = fileDirNames(text)
  const out = []
  for (const m of text.matchAll(JOIN_RE)) {
    const baseExpr = m[1].replace(/\s+/g, '')
    const segs = [...m[2].matchAll(/(['"`])([^'"`\n]*)\1/g)].map((s) => s[2])
    const base = fileDirs.has(baseExpr) ? 'file' : baseExpr === 'process.cwd()' ? 'module' : 'unknown'
    out.push({ rel: segs.join('/'), base, line: lineOf(text, m.index) })
  }
  for (const m of text.matchAll(URL_RE)) out.push({ rel: m[2], base: 'file', line: lineOf(text, m.index) })
  return out.sort((a, b) => a.line - b.line)
}

/** COPY sources of a Dockerfile (never --from= stage copies). @returns [{ source, line }] */
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
    for (const source of args.slice(0, -1)) out.push({ source, line: start + 1 })
  }
  return out
}

// ── rules ────────────────────────────────────────────────────────────────

const SEGMENT_RULES = [
  [/(^|\/)upstream(\/|$)/, 'carries an upstream/ segment'],
  [/(^|\/)services(\/|$)/, 'carries a services/ segment'],
  [/sturaos/i, 'carries a StuRaOS segment'],
]

function specifierProblems(spec, fileRel, moduleRoot) {
  const why = []
  if (/^@stura/i.test(spec)) why.push('names an @stura* package')
  for (const [re, w] of SEGMENT_RULES) if (re.test(spec)) why.push(w)
  if (spec.startsWith('/')) why.push('is an absolute path')
  if (spec.startsWith('./') || spec.startsWith('../')) {
    const resolved = posix.normalize(posix.join(posix.dirname(fileRel), spec))
    if (!(resolved === moduleRoot || resolved.startsWith(moduleRoot + '/'))) why.push(`leaves ${moduleRoot}/ (resolves to ${resolved})`)
  }
  return why
}

function literalProblems(lit, fileRel, moduleRoot) {
  const why = []
  for (const [re, w] of SEGMENT_RULES) if (re.test(lit.rel)) why.push(w)
  const from = lit.base === 'file' ? posix.dirname(fileRel) : moduleRoot
  const resolved = posix.normalize(posix.join(from, lit.rel))
  if (!(resolved === moduleRoot || resolved.startsWith(moduleRoot + '/'))) why.push(`leaves ${moduleRoot}/ (resolves to ${resolved}, base ${lit.base})`)
  return why
}

function copyProblems(source) {
  const why = []
  for (const [re, w] of SEGMENT_RULES) if (re.test(source)) why.push(w)
  if (source.startsWith('..') || source.startsWith('/')) why.push('reaches outside the build context root')
  return why
}

// ── the coupled-test list ────────────────────────────────────────────────

export function validateCoupledTests(root, doc) {
  if (!doc || !Array.isArray(doc.entries)) return [`${COUPLED_PATH}: no "entries" array`]
  const problems = []
  const seen = new Set()
  doc.entries.forEach((e, i) => {
    const where = `${COUPLED_PATH} entry ${i}`
    if (!e || typeof e.path !== 'string' || !/^modules\/[^/]+\/.+/.test(e.path)) {
      problems.push(`${where}: "path" must be a modules/<id>/... file`)
      return
    }
    if (typeof e.reason !== 'string' || e.reason.trim() === '') problems.push(`${where} (${e.path}): empty or missing "reason"`)
    if (typeof e.owner !== 'string' || !OWNER_RE.test(e.owner.trim())) problems.push(`${where} (${e.path}): "owner" must name the owning task(s) (TASK-<n>[/TASK-<n>])`)
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

function walk(root, rel, out) {
  for (const name of readdirSync(join(root, rel)).sort()) {
    const r = `${rel}/${name}`
    const st = statSync(join(root, r))
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name)) walk(root, r, out)
    } else if (st.isFile()) out.push(r)
  }
  return out
}

// ── the scan ─────────────────────────────────────────────────────────────

/**
 * @param root kernel root (or a fixture)
 * @param opts.dockerAllowlist path -> reason; defaults to DOCKERFILE_ALLOWLIST
 */
export function scanModules(root, { dockerAllowlist = DOCKERFILE_ALLOWLIST } = {}) {
  const problems = []
  const { doc, problems: coupledProblems } = readCoupled(root)
  problems.push(...coupledProblems)
  const coupled = new Map((doc?.entries ?? []).map((e) => [e.path, e]))

  for (const [path, reason] of Object.entries(dockerAllowlist))
    if (typeof reason !== 'string' || reason.trim() === '') problems.push(`DOCKERFILE_ALLOWLIST ${path}: empty reason`)

  const findings = []
  let filesScanned = 0
  let specifiers = 0
  let literals = 0
  let dockerfiles = 0
  const ids = moduleDirs(root)
  for (const id of ids) {
    const moduleRoot = `modules/${id}`
    for (const rel of walk(root, moduleRoot, [])) {
      const isDocker = DOCKERFILE_RE.test(rel)
      if (!isDocker && !SOURCE_RE.test(rel)) continue
      const text = readFileSync(join(root, rel), 'utf8')
      filesScanned++
      if (isDocker) {
        dockerfiles++
        for (const c of extractDockerCopySources(text)) {
          const why = copyProblems(c.source)
          if (why.length) findings.push({ file: rel, line: c.line, what: `COPY ${c.source}`, why })
        }
        continue
      }
      for (const s of extractSpecifiers(text)) {
        specifiers++
        const why = specifierProblems(s.spec, rel, moduleRoot)
        if (why.length) findings.push({ file: rel, line: s.line, what: `'${s.spec}'`, why })
      }
      for (const l of extractPathLiterals(text)) {
        literals++
        const why = literalProblems(l, rel, moduleRoot)
        if (why.length) findings.push({ file: rel, line: l.line, what: `path literal '${l.rel}'`, why })
      }
    }
  }
  if (filesScanned === 0) problems.push('scanned zero files under modules/ — the scan would pass vacuously')

  const allowed = []
  const excusedBy = new Map()
  for (const f of findings) {
    const reason = coupled.get(f.file)?.reason ?? dockerAllowlist[f.file]
    if (typeof reason === 'string' && reason.trim() !== '') {
      allowed.push({ ...f, reason })
      excusedBy.set(f.file, (excusedBy.get(f.file) ?? 0) + 1)
    } else problems.push(`${f.file}:${f.line} ${f.what} ${f.why.join('; ')}`)
  }
  for (const path of [...coupled.keys(), ...Object.keys(dockerAllowlist)]) {
    if (!existsSync(join(root, path))) {
      if (!coupled.has(path)) problems.push(`DOCKERFILE_ALLOWLIST names ${path}, which does not exist — stale allowance`)
      continue
    }
    if (!excusedBy.has(path)) problems.push(`stale allowance: ${path} is allowlisted but the scan finds no coupling in it — delete the entry, or the scan has gone blind`)
  }
  return { problems, findings, allowed, filesScanned, specifiers, literals, dockerfiles, modules: ids }
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
  const scan = scanModules(root, { dockerAllowlist: {} })
  const stale = scan.problems.filter((p) => /stale allowance/.test(p) && p.includes(`modules/${id}/`))
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
  const problems = [...r.problems, ...disc]
  if (problems.length) {
    console.error(`[module-source-scan] ${problems.length} problem(s):`)
    for (const p of problems) console.error(`  x ${p}`)
    process.exit(1)
  }
  console.log(
    `[module-source-scan] OK — ${r.filesScanned} files in ${r.modules.length} modules (${r.specifiers} specifiers, ` +
      `${r.literals} path literals, ${r.dockerfiles} Dockerfiles); 0 unallowlisted findings; ${r.allowed.length} allowlisted ` +
      `in ${new Set(r.allowed.map((a) => a.file)).size} files; every module discovered by the workspace.`,
  )
  for (const a of r.allowed) console.log(`  allowed ${a.file}:${a.line} ${a.what}`)
}
