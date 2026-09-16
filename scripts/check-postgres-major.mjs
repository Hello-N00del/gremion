#!/usr/bin/env node
// Postgres major pin guard — spec B §8, unit B37-postgres-major-pin.
//
// P3: the Postgres major is the newest EVERY consumer supports. Spike S14
// recorded the per-consumer evidence; docs/ops/postgres-major.md is its home and
// this file is the machine-readable half. Each asserts the other, so prose and
// code cannot drift apart.
//
// Run:  node scripts/check-postgres-major.mjs             (the kernel repo)
//       node scripts/check-postgres-major.mjs --tree DIR  (a module repo or an
//                                                          assembled release tree)
// Test: node --test scripts/check-postgres-major.test.mjs

import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The major S14 settled on. Change this ONLY together with the record. */
export const POSTGRES_MAJOR = 18
export const POSTGRES_IMAGE_TAG = `postgres:${POSTGRES_MAJOR}-alpine`
export const EVIDENCE_PATH = 'docs/ops/postgres-major.md'

// The consumers P3 names. A consumer with no evidence row is a consumer nobody
// checked, so a missing NAME fails — not merely a missing table.
export const S14_CONSUMERS = ['keycloak', 'nextcloud', 'synapse', 'pgbouncer', 'pg_dump']

export function checkEvidence(text) {
  const problems = []
  const m = text.match(/^- \*\*Pinned major\*\*: (\d{1,3})$/m)
  if (!m) return [`${EVIDENCE_PATH} carries no "- **Pinned major**: <n>" line`]
  if (Number(m[1]) !== POSTGRES_MAJOR) {
    problems.push(`${EVIDENCE_PATH} pins ${m[1]}, check-postgres-major.mjs exports ${POSTGRES_MAJOR}`)
  }
  const rows = text.split('\n').filter((l) => l.trim().startsWith('|'))
  for (const c of S14_CONSUMERS) {
    const row = rows.find((l) => l.toLowerCase().includes(c.toLowerCase()))
    if (!row) { problems.push(`the record has no S14 evidence row for ${c}`); continue }
    if (!/https?:\/\//.test(row)) problems.push(`S14 evidence row for ${c} cites no source URL`)
    // The major has to appear as a WHOLE numeric token: splitting on runs of
    // non-digits means "18" is found in `18.x` and in `PostgreSQL 18`, but a row
    // that only says `118` or `1.8` does not count as evidence for 18.
    if (!row.split(/[^0-9]+/).includes(String(POSTGRES_MAJOR))) {
      problems.push(`S14 evidence row for ${c} does not state support for major ${POSTGRES_MAJOR}`)
    }
  }
  if (!/dump\/restore/.test(text) || !/measured RTO/.test(text)) {
    problems.push('the record states no later-bump rule (dump/restore with a measured RTO)')
  }
  return problems
}

// ── the scanner ────────────────────────────────────────────────────────────

// Two NAMED exclusions, and only two. Anything not on this list is scanned.
//
//  1. Frozen copies of the APPROVED specs quote the pre-pin tag verbatim. They
//     are a record of what was decided, not a place a tag is configured;
//     rewriting them would falsify the record. It is also the only tracked path
//     under docs/superpowers — B0 un-ignores exactly
//     docs/superpowers/specs/spec-{b,d}-*.md and nothing else.
//  2. The `tree-stale` fixture EXISTS to carry a stale tag: it is what proves
//     `--tree` goes RED. Excluding the whole `postgres-major` fixture directory
//     would also excuse `tree-clean`, so the rule names `tree-stale` alone and
//     `tree-clean` stays scanned like any other file (and is pinned).
export const EXCLUDED = [
  /^docs\/superpowers\/specs\//,
  /^test\/host\/fixtures\/postgres-major\/tree-stale\//,
]

// `postgresql://user:pw@postgres:5432/db` is a HOST:PORT, not an image tag. The
// lookbehind drops anything glued to a word char, dot, slash, dash or `@`, and
// the trailing lookahead keeps a tag from being matched halfway. 5432 is then
// refused a second time below, because one net is one forgotten char from
// silently excusing a real tag — and the kernel prose writes bare `postgres:5432`
// in a dozen places with nothing in front of it.
const TAG_RE = /(?<![\w./@-])postgres:(latest|alpine|\d{1,4}(?:[.-][A-Za-z0-9.]+)*)(?![\w.-])/g

export function scanText(path, text) {
  const hits = []
  text.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(TAG_RE)) {
      if (m[1] === '5432') continue
      hits.push({ path, line: i + 1, tag: m[1], ref: `postgres:${m[1]}` })
    }
  })
  return hits
}

export function classify(hit) {
  if (hit.tag === 'latest' || hit.tag === 'alpine') return 'unpinned'
  const major = Number(hit.tag.split(/[.-]/)[0])
  if (!Number.isInteger(major)) return 'unpinned'
  return major === POSTGRES_MAJOR ? 'ok' : 'mismatched'
}

/** @param files [{path, text}] */
export function checkFiles(files) {
  const hits = files
    .filter((f) => !EXCLUDED.some((re) => re.test(f.path)))
    .flatMap((f) => scanText(f.path, f.text))
  if (hits.length === 0) {
    return ['found zero postgres: image references — the guard would pass vacuously']
  }
  return hits
    .filter((h) => classify(h) !== 'ok')
    .map((h) => `${classify(h)}: ${h.path}:${h.line} ${h.ref} (expected ${POSTGRES_IMAGE_TAG})`)
}

const TEXTUAL = /\.(ya?ml|md|ts|mjs|js|sh|bats|json|tmpl)$|(^|\/)(Dockerfile|Makefile)/

export function trackedTextFiles(root) {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  return out
    .split('\0')
    .filter((p) => p && TEXTUAL.test(p))
    .map((p) => ({ path: p, text: readFileSync(join(root, p), 'utf8') }))
}

// ── module repos and assembled release trees ───────────────────────────────

/**
 * A module repo or an assembled release tree: every `compose/<id>.yml` fragment
 * plus the composed files D13 inlines them into. Nothing is walked recursively,
 * so an accidental `--tree /` reports zero rather than grinding — and zero is a
 * FAILURE, not a pass (checkFiles refuses an empty match set). A tree that is
 * not there at all throws rather than reporting an empty, reassuring scan.
 */
export function fragmentFiles(root) {
  if (!existsSync(root)) throw new Error(`no such tree: ${root}`)
  const out = []
  const push = (abs) => out.push({
    path: relative(root, abs).split(sep).join('/'),
    text: readFileSync(abs, 'utf8'),
  })
  const composeDir = join(root, 'compose')
  if (existsSync(composeDir)) {
    for (const n of readdirSync(composeDir)) {
      if (/\.ya?ml$/.test(n) && statSync(join(composeDir, n)).isFile()) push(join(composeDir, n))
    }
  }
  for (const n of readdirSync(root)) {
    if (/^docker-compose.*\.ya?ml$/.test(n) && statSync(join(root, n)).isFile()) push(join(root, n))
  }
  return out
}

// ── CLI ────────────────────────────────────────────────────────────────────

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
  const i = process.argv.indexOf('--tree')
  const tree = i >= 0 ? process.argv[i + 1] : null
  if (i >= 0 && !tree) { console.error('[postgres-major] --tree needs a directory'); process.exit(2) }
  const files = tree ? fragmentFiles(tree) : trackedTextFiles(ROOT)
  const problems = tree
    ? checkFiles(files)
    : [...checkEvidence(readFileSync(join(ROOT, EVIDENCE_PATH), 'utf8')), ...checkFiles(files)]
  if (problems.length > 0) {
    console.error(`[postgres-major] ${problems.length} problem(s) in ${tree ?? 'the kernel tree'}:`)
    for (const p of problems) console.error(`  x ${p}`)
    process.exit(1)
  }
  console.log(`[postgres-major] OK — ${files.length} files scanned in ${tree ?? 'the kernel tree'}, every postgres: reference is ${POSTGRES_IMAGE_TAG}`)
}
