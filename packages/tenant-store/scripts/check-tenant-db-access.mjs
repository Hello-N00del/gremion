#!/usr/bin/env node
// packages/tenant-store/scripts/check-tenant-db-access.mjs
//
// TRD-426: no tenant database connection is opened outside @gremion/tenant-store.
// Scans every source file under --root (default: the repository) for
//   calls:   postgres(  createDb(  new Pool(  new Client(
//   imports: a VALUE import of a driver — 'postgres', 'pg', 'pg-pool',
//            'pg-native', or any subpath of them — (import ... from, export ...
//            from, require(), import(), any quote style), and a value import or
//            re-export of createDb (renamed or not) or a namespace/default
//            import of '@gremion/db' — so an alias (import pg from 'postgres';
//            pg(url) / import { createDb as mk } ...; mk(p)) cannot slip past the
//            call patterns. Type-only imports are not counted.
//   also:    createDb referenced by string ('createDb') or through
//            .call / .apply / .bind.
// and fails on any hit outside the package that has no allow-list row, on a
// row whose counts no longer match the file exactly (stale, or a new site in an
// allow-listed file), on a malformed row, and on a scan that saw zero files.
//
// Allowed by rule, not by row: packages/tenant-store/** (the package itself) and
// the @gremion/db factory (packages/db/src/client.ts and its spec).
//
// Not scanned: directories named node_modules, dist, build or coverage, and
// dot-directories (.git, .svelte-kit, .scratch, .github, ...); measured
// 2026-09-25, no tracked source file sits under one. Symlinks are not followed.
//
// Usage: node check-tenant-db-access.mjs [--root <dir>] [--allow-list <file>] [--json]
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const DEFAULT_ROOT = resolve(HERE, '../../..')
export const DEFAULT_ALLOW_LIST = join(HERE, 'tenant-db-access.allow.json')

export const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.svelte']
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage'])

export const RULE_ALLOWED = [
  { prefix: 'packages/tenant-store/', reason: 'the package itself (TRD-426)' },
  { path: 'packages/db/src/client.ts', reason: 'the @gremion/db factory every pool is built with' },
  { path: 'packages/db/src/client.test.ts', reason: 'the factory spec' },
]

const CALL_PATTERNS = [
  /\bpostgres\s*\(/g,
  /\bcreateDb\s*\(/g,
  /\bnew\s+Pool\s*\(/g,
  /\bnew\s+Client\s*\(/g,
  /['"`]createDb['"`]/g,
  /\bcreateDb\s*\.\s*(?:call|apply|bind)\b/g,
]
const Q = `['"\`]`
const DRIVER = String.raw`${Q}(?:postgres|pg|pg-pool|pg-native)(?:/[^'"\`]*)?${Q}`
// the package, or its factory module reached by a relative path
const FACTORY = String.raw`${Q}(?:@gremion/db(?:/[^'"\`]*)?|[^'"\`]*packages/db/src/(?:client|index)(?:\.[jt]s)?)${Q}`
// import X from '…' / import * as X / import { a, b } / export { x } from — type-only excluded below
const STATIC_IMPORT = new RegExp(String.raw`\b(import|export)\s+(type\s+)?([^;'"\`]*?)\s*from\s*${DRIVER}`, 'g')
// import('x').Name is a TypeScript type query, not a load: not counted.
const NOT_TYPE_QUERY = String.raw`(?!\s*\.\s*[A-Z])`
const DYNAMIC_IMPORT = new RegExp(String.raw`\b(?:require|import)\s*\(\s*${DRIVER}\s*\)${NOT_TYPE_QUERY}`, 'g')
const FACTORY_IMPORT = new RegExp(String.raw`\b(import|export)\s+(type\s+)?([^;'"\`]*?)\s*from\s*${FACTORY}`, 'g')
const FACTORY_DYNAMIC = new RegExp(String.raw`\b(?:require|import)\s*\(\s*${FACTORY}\s*\)${NOT_TYPE_QUERY}`, 'g')

/**
 * Blanks comments, keeping line numbers and every other character: a small
 * scanner that knows '…', "…" and `…` strings (with escapes) and regex
 * literals (/…/ with escapes and [...] classes), so a // or /* inside a
 * string or a regex never starts a comment and cannot hide the code after
 * it. Strings and regexes themselves are kept, so their content is still
 * scanned. A / opens a regex where an expression may start: at the start of
 * the text, after one of ( , = : [ ! & | ? { } ; + - * % < > ~ ^, or after
 * the keywords return / typeof / case / do / else / in / of / new / delete /
 * void / throw / yield / await; elsewhere it is division.
 */
const REGEX_AFTER = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^'])
const REGEX_KEYWORDS = /\b(?:return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await)$/

export function stripComments(text) {
  let out = ''
  let i = 0
  // the last significant (non-space, non-comment) source text, for the regex rule
  let prev = ''
  while (i < text.length) {
    const c = text[i]
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1
      while (j < text.length && text[j] !== c && !(c !== '`' && text[j] === '\n')) j += text[j] === '\\' ? 2 : 1
      out += text.slice(i, j + 1)
      i = j + 1
      prev = c
      continue
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      const stop = end < 0 ? text.length : end + 2
      out += text.slice(i, stop).replace(/[^\n]/g, ' ')
      i = stop
      continue
    }
    if (c === '/') {
      const tail = prev.trimEnd()
      const last = tail.at(-1)
      if (last === undefined || REGEX_AFTER.has(last) || REGEX_KEYWORDS.test(tail)) {
        let j = i + 1
        let inClass = false
        while (j < text.length && text[j] !== '\n') {
          if (text[j] === '\\') j += 2
          else if (text[j] === '[') (inClass = true), j++
          else if (text[j] === ']') (inClass = false), j++
          else if (text[j] === '/' && !inClass) break
          else j++
        }
        out += text.slice(i, j + 1)
        i = j + 1
        prev = '/'
        continue
      }
    }
    out += c
    if (!/\s/.test(c)) prev = (prev + c).slice(-16)
    i++
  }
  return out
}

function isTypeOnlyClause(typeKw, clause) {
  if (typeKw) return true
  // import { type A, type B } from 'postgres' — every specifier is a type
  const m = /^\{([\s\S]*)\}$/.exec(clause.trim())
  if (!m) return false
  const specs = m[1].split(',').map((s) => s.trim()).filter(Boolean)
  return specs.length > 0 && specs.every((s) => /^type\s/.test(s))
}

/** Counts the connection sites in one file's text. */
/** Does an import/export clause from '@gremion/db' bring the factory in as a value? */
function importsFactory(typeKw, clause) {
  if (typeKw) return false
  const c = clause.trim()
  if (/^\*/.test(c)) return true // namespace import, or export * from
  const named = /\{([\s\S]*)\}/.exec(c)
  if (/^[A-Za-z_$][\w$]*/.test(c) && !/^\{/.test(c)) return true // a default import
  if (!named) return false
  return named[1].split(',').map((s) => s.trim()).some((s) => /^(?:default|createDb)\b/.test(s))
}

export function countSites(text) {
  const code = stripComments(text)
  let calls = 0
  for (const re of CALL_PATTERNS) calls += (code.match(re) ?? []).length
  let imports = 0
  for (const m of code.matchAll(STATIC_IMPORT)) if (!isTypeOnlyClause(m[2], m[3])) imports++
  imports += (code.match(DYNAMIC_IMPORT) ?? []).length
  for (const m of code.matchAll(FACTORY_IMPORT)) if (importsFactory(m[2], m[3])) imports++
  imports += (code.match(FACTORY_DYNAMIC) ?? []).length
  return { calls, imports }
}

function* walk(dir, root) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) yield* walk(p, root)
    else if (e.isFile() && EXTENSIONS.some((x) => e.name.endsWith(x))) yield relative(root, p).split(sep).join('/')
  }
}

function ruleAllowed(path) {
  return RULE_ALLOWED.some((r) => (r.prefix ? path.startsWith(r.prefix) : path === r.path))
}

const ROW_KEYS = ['path', 'calls', 'imports', 'adoptedBy', 'since', 'reason']

/** Validates the allow-list; returns { rows: Map<path,row>, problems }. */
export function parseAllowList(json) {
  const problems = []
  const rows = new Map()
  if (!json || typeof json !== 'object' || !Array.isArray(json.rows)) {
    return { rows, problems: ['allow-list: expected { "rows": [...] }'] }
  }
  for (const [i, row] of json.rows.entries()) {
    const at = `allow-list row ${i}${row && typeof row.path === 'string' ? ` (${row.path})` : ''}`
    if (!row || typeof row !== 'object') {
      problems.push(`${at}: not an object`)
      continue
    }
    const extra = Object.keys(row).filter((k) => !ROW_KEYS.includes(k))
    if (extra.length) problems.push(`${at}: unknown keys ${extra.join(', ')}`)
    if (typeof row.path !== 'string' || !row.path || row.path.includes('\\') || row.path.split('/').includes('..') || /[*?]/.test(row.path)) {
      problems.push(`${at}: path must be one exact repository-relative file (no glob, no ..)`)
      continue
    }
    for (const k of ['calls', 'imports']) {
      if (!Number.isInteger(row[k]) || row[k] < 0) problems.push(`${at}: ${k} must be a non-negative integer`)
    }
    if (row.calls === 0 && row.imports === 0) problems.push(`${at}: a row allowing nothing is stale by definition`)
    if (typeof row.adoptedBy !== 'string' || !/^TASK-\d{3}$/.test(row.adoptedBy)) problems.push(`${at}: adoptedBy must name the adopting task (TASK-NNN)`)
    if (typeof row.since !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.since) || Number.isNaN(Date.parse(row.since))) problems.push(`${at}: since must be a date (YYYY-MM-DD)`)
    if (typeof row.reason !== 'string' || row.reason.trim().length < 10) problems.push(`${at}: reason must say why`)
    if (ruleAllowed(row.path)) problems.push(`${at}: already allowed by rule; the row is redundant`)
    if (rows.has(row.path)) problems.push(`${at}: duplicate path`)
    rows.set(row.path, row)
  }
  return { rows, problems }
}

export function checkTenantDbAccess({ root = DEFAULT_ROOT, allowList = DEFAULT_ALLOW_LIST } = {}) {
  const problems = []
  let json
  try {
    json = JSON.parse(readFileSync(allowList, 'utf8'))
  } catch (err) {
    return { scanned: 0, sites: [], problems: [`allow-list ${allowList} unreadable: ${err.message}`] }
  }
  const { rows, problems: rowProblems } = parseAllowList(json)
  problems.push(...rowProblems)

  if (!existsSync(root) || !statSync(root).isDirectory()) {
    return { scanned: 0, sites: [], problems: [...problems, `root ${root} is not a directory`] }
  }
  let scanned = 0
  const sites = []
  for (const path of walk(root, root)) {
    scanned++
    if (ruleAllowed(path)) continue
    const found = countSites(readFileSync(join(root, path), 'utf8'))
    if (found.calls === 0 && found.imports === 0) continue
    sites.push({ path, ...found })
    const row = rows.get(path)
    if (!row) {
      problems.push(`${path}: opens a database connection outside @gremion/tenant-store (${found.calls} call(s), ${found.imports} driver import(s)); use openTenantDb, or add a dated allow-list row naming the adopting task`)
    } else if (row.calls !== found.calls || row.imports !== found.imports) {
      problems.push(`${path}: allow-list row says ${row.calls} call(s) / ${row.imports} import(s), the file has ${found.calls} / ${found.imports}${found.calls > row.calls || found.imports > row.imports ? ' — a NEW site in an allow-listed file' : ' — update the row (stale)'}`)
    }
  }
  const hit = new Set(sites.map((s) => s.path))
  for (const path of rows.keys()) {
    if (!hit.has(path)) problems.push(`${path}: stale allow-list row — ${existsSync(join(root, path)) ? 'the file no longer opens a connection' : 'the file is gone'}; delete the row`)
  }
  if (scanned === 0) problems.push(`scanned zero files under ${root}: the scan is vacuous`)
  return { scanned, sites, problems }
}

function main(argv) {
  const opt = (name) => {
    const i = argv.indexOf(name)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const root = resolve(opt('--root') ?? DEFAULT_ROOT)
  const allowList = resolve(opt('--allow-list') ?? DEFAULT_ALLOW_LIST)
  const result = checkTenantDbAccess({ root, allowList })
  if (argv.includes('--json')) console.log(JSON.stringify(result))
  if (result.problems.length) {
    console.error(`[tenant-db-access] FAIL — ${result.problems.length} problem(s), ${result.scanned} file(s) scanned:`)
    for (const p of result.problems) console.error(`  - ${p}`)
    return 1
  }
  console.log(`[tenant-db-access] OK — ${result.scanned} file(s) scanned, ${result.sites.length} allow-listed site file(s), no tenant database connection outside @gremion/tenant-store`)
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
