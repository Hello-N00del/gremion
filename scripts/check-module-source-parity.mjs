#!/usr/bin/env node
// In-tree module source parity — TASK-200 (L5-27), TDD 1.
//
// The pilot modules' source moves from the StuRa tree into this kernel's
// modules/<id>/ one-to-one. This guard proves the move by git BLOB identity:
// for every file of the StuRa tree at the annotated tag, the blob SHA-1 from
// `git ls-tree -r <tag>` must equal `git hash-object` of the kernel file the id
// map sends it to. Byte-equal or listed — nothing else passes.
//
// Three sets, reported separately because each proves something different:
//   A  every services/** path changed between the frozen extraction source
//      (docs/ops/extraction-source.md) and the tag. Small, and it is the part of
//      the tag the older freeze does not already cover; it must be byte-equal at
//      EVERY commit, listed or not — nothing in it is scrubbed.
//   B  every services/** path at the tag. Byte-equal alone over A would be
//      nearly vacuous (A is one service), so B carries the full copy. At the
//      copy commit (--copy) zero differ; afterwards only the paths
//      modules/EXTRACTION-DELTA.json lists (path, reason, owner) may differ.
//   C  the content UI half (gremion-ui/src/<rest> -> modules/content/app/<rest>),
//      under the same rule as B.
// Plus the reverse direction: a file inside a mapped module directory that no
// tag path maps to is an EXTRA and fails unless the delta lists it — a copy
// that picked up a stray file is not a copy.
//
// Refusals, never skips: a source path that is not a git repository, a tag that
// is missing, lightweight, or peels to a commit other than the one recorded
// below, a base commit the source does not have, and an empty set.
//
// NOT part of `make lint`: it needs a checkout of the StuRa tree, which the
// kernel does not own. Its output is committed under docs/ops/.
//
// Run:  node scripts/check-module-source-parity.mjs <path-to-StuRa-tree> extraction-source-f1 \
//         [--copy] [--write docs/ops/module-source-parity.txt]
// Test: node --test scripts/check-module-source-parity.test.mjs

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { readFrozenExtractionSource } from './lib/extraction-source.mjs'

export const KERNEL_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** The annotated tag's commit, decided by the orchestrator (R24-6 Q1). Moving the tag is a new decision. */
export const EXPECTED_TAG_COMMIT = '0c9d342e9a1f9785b6f976719008134237198d0d'

export const DELTA_PATH = 'modules/EXTRACTION-DELTA.json'

/** services/<svc> -> modules/<id>. Only two ids change (R23-11 D3). */
export const MODULE_ID_MAP = Object.freeze({
  board: 'board',
  calendar: 'calendar',
  content: 'content',
  files: 'files',
  finance: 'finance',
  messages: 'messaging',
  newsletter: 'publishing',
  vault: 'vault',
  votes: 'votes',
})

/**
 * The content UI half (spec D §3 content row: lib/server/content, routes/content,
 * routes/api/content, the manifest and its test, and the news surface folded in
 * by D-04). A trailing slash is a directory prefix, anything else one file.
 */
export const CONTENT_UI_PREFIXES = Object.freeze([
  'gremion-ui/src/lib/server/content/',
  'gremion-ui/src/routes/content/',
  'gremion-ui/src/routes/api/content/',
  'gremion-ui/src/lib/modules/manifests/content.ts',
  'gremion-ui/src/lib/modules/manifests/content.test.ts',
  'gremion-ui/src/lib/server/news/',
  'gremion-ui/src/lib/components/news/',
  'gremion-ui/src/routes/news/',
  'gremion-ui/src/routes/api/news/',
])

const CONTENT_APP_ROOT = 'modules/content/app/'

function inContentUi(p) {
  return CONTENT_UI_PREFIXES.some((pre) => (pre.endsWith('/') ? p.startsWith(pre) : p === pre))
}

/** A StuRa path -> its kernel path, or null when it is not in scope. */
export function mapSourcePath(p) {
  const m = /^services\/([^/]+)\/(.+)$/.exec(p)
  if (m) {
    const id = MODULE_ID_MAP[m[1]]
    return id ? `modules/${id}/${m[2]}` : null
  }
  if (inContentUi(p)) return CONTENT_APP_ROOT + p.slice('gremion-ui/src/'.length)
  return null
}

// ── the delta ────────────────────────────────────────────────────────────

/** Shape of modules/EXTRACTION-DELTA.json: { entries: [{ path, reason, owner }] }. */
export function validateDelta(delta) {
  if (!delta || !Array.isArray(delta.entries)) return [`${DELTA_PATH}: no "entries" array`]
  const problems = []
  const seen = new Set()
  delta.entries.forEach((e, i) => {
    const where = `${DELTA_PATH} entry ${i}`
    if (!e || typeof e.path !== 'string' || !e.path.startsWith('modules/')) {
      problems.push(`${where}: "path" must be a modules/... path`)
      return
    }
    if (typeof e.reason !== 'string' || e.reason.trim() === '') problems.push(`${where} (${e.path}): empty or missing "reason"`)
    if (typeof e.owner !== 'string' || !/^TASK-\d+[a-z]?$/.test(e.owner.trim()))
      problems.push(`${where} (${e.path}): "owner" must name a task (TASK-<n>)`)
    if (seen.has(e.path)) problems.push(`${where}: duplicate path ${e.path}`)
    seen.add(e.path)
  })
  return problems
}

function readDelta(kernelRoot) {
  const abs = join(kernelRoot, DELTA_PATH)
  if (!existsSync(abs)) return { delta: null, problems: [`${DELTA_PATH} is missing — the delta is empty or it is written, never absent`] }
  try {
    const delta = JSON.parse(readFileSync(abs, 'utf8'))
    return { delta, problems: validateDelta(delta) }
  } catch (err) {
    return { delta: null, problems: [`${DELTA_PATH}: not JSON — ${err.message}`] }
  }
}

// ── git plumbing ─────────────────────────────────────────────────────────

function git(cwd, args, input) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 })
}

function assertSource({ sturaPath, tag, base, expectedTagCommit }) {
  if (typeof sturaPath !== 'string' || sturaPath === '' || !existsSync(sturaPath) || !statSync(sturaPath).isDirectory())
    throw new Error(`source path ${JSON.stringify(sturaPath)} is not a git checkout (no such directory)`)
  try {
    git(sturaPath, ['rev-parse', '--git-dir'])
  } catch {
    throw new Error(`source path ${sturaPath} is not a git checkout`)
  }
  let type
  try {
    type = git(sturaPath, ['cat-file', '-t', `refs/tags/${tag}`]).trim()
  } catch {
    throw new Error(`tag ${tag} does not exist in ${sturaPath} (git fetch origin --tags there first)`)
  }
  if (type !== 'tag') throw new Error(`tag ${tag} is ${type === 'commit' ? 'lightweight' : `a ${type}`} — the freeze is an annotated tag`)
  const peeled = git(sturaPath, ['rev-parse', `refs/tags/${tag}^{commit}`]).trim()
  if (peeled !== expectedTagCommit)
    throw new Error(`tag ${tag} peels to ${peeled}, not the recorded ${expectedTagCommit} — the tag moved; that is a new decision, not a re-run`)
  try {
    git(sturaPath, ['cat-file', '-e', `${base}^{commit}`])
  } catch {
    throw new Error(`base ${base} (the frozen extraction source) is not a commit in ${sturaPath}`)
  }
  return peeled
}

/** `git ls-tree -r` at the tag, restricted to pathspecs: Map path -> blob sha. */
function tagBlobs(sturaPath, tag, pathspecs) {
  const out = git(sturaPath, ['ls-tree', '-r', '-z', `refs/tags/${tag}^{commit}`, '--', ...pathspecs])
  const blobs = new Map()
  const problems = []
  for (const rec of out.split('\0').filter(Boolean)) {
    const m = /^(\d+) (\w+) ([0-9a-f]{40})\t(.+)$/.exec(rec)
    if (!m) throw new Error(`unparseable ls-tree record: ${rec}`)
    if (m[2] !== 'blob') problems.push(`${m[4]} is a ${m[2]} at the tag — a gitlink cannot be copied by blob`)
    else blobs.set(m[4], m[3])
  }
  return { blobs, problems }
}

/** Kernel paths -> blob sha of the working-tree file (null when absent). Filters apply by path, as git would. */
function kernelBlobs(kernelRoot, paths) {
  const present = paths.filter((p) => existsSync(join(kernelRoot, p)) && statSync(join(kernelRoot, p)).isFile())
  const shas = present.length ? git(kernelRoot, ['hash-object', '--stdin-paths'], present.join('\n') + '\n').trim().split('\n') : []
  if (shas.length !== present.length) throw new Error(`git hash-object returned ${shas.length} hashes for ${present.length} paths`)
  const map = new Map(paths.map((p) => [p, null]))
  present.forEach((p, i) => map.set(p, shas[i]))
  return map
}

/** Every file (tracked or untracked-not-ignored) under the given kernel directories. */
function kernelFilesUnder(kernelRoot, dirs) {
  if (dirs.length === 0) return []
  const out = git(kernelRoot, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...dirs])
  return [...new Set(out.split('\0').filter(Boolean))].filter((p) => existsSync(join(kernelRoot, p)))
}

// ── the check ────────────────────────────────────────────────────────────

/**
 * @param opts.sturaPath   checkout of the StuRa tree (read-only use)
 * @param opts.tag         annotated tag name
 * @param opts.kernelRoot  this repository (or a fixture)
 * @param opts.base        the frozen extraction source; defaults to the record
 * @param opts.expectedTagCommit defaults to EXPECTED_TAG_COMMIT
 * @param opts.copy        true at the byte-equal copy commit: every difference fails, listed or not
 */
export function runParity(opts) {
  const kernelRoot = opts.kernelRoot ?? KERNEL_ROOT
  const base = opts.base ?? readFrozenExtractionSource(kernelRoot)
  const expectedTagCommit = opts.expectedTagCommit ?? EXPECTED_TAG_COMMIT
  const { sturaPath, tag } = opts
  const copy = opts.copy === true
  const tagCommit = assertSource({ sturaPath, tag, base, expectedTagCommit })
  const problems = []

  const b = tagBlobs(sturaPath, tag, ['services/'])
  const c = tagBlobs(sturaPath, tag, CONTENT_UI_PREFIXES)
  problems.push(...b.problems, ...c.problems)
  for (const p of c.blobs.keys()) if (!inContentUi(p)) c.blobs.delete(p)

  // Set A — name-status so a deletion at the tag is an expected ABSENCE, not a skip.
  const aRaw = git(sturaPath, ['diff', '--no-renames', '--name-status', '-z', base, `refs/tags/${tag}^{commit}`, '--', 'services/'])
  const aTok = aRaw.split('\0').filter(Boolean)
  const setA = []
  for (let i = 0; i + 1 < aTok.length; i += 2) setA.push({ status: aTok[i], path: aTok[i + 1] })

  const unmapped = [...b.blobs.keys(), ...c.blobs.keys()].filter((p) => mapSourcePath(p) === null)
  for (const p of unmapped) problems.push(`${p}: no module id maps it — add the service to MODULE_ID_MAP or record why it is not carried`)

  const { delta, problems: deltaProblems } = readDelta(kernelRoot)
  problems.push(...deltaProblems)
  const listed = new Map((delta?.entries ?? []).map((e) => [e.path, e]))

  const moduleDirs = [...new Set(Object.values(MODULE_ID_MAP))].map((id) => `modules/${id}`)
  const onDisk = kernelFilesUnder(kernelRoot, moduleDirs)
  const mappedTargets = new Set([...b.blobs.keys(), ...c.blobs.keys()].map(mapSourcePath).filter(Boolean))
  const setAPaths = setA.map((a) => mapSourcePath(a.path)).filter(Boolean)
  const hashes = kernelBlobs(kernelRoot, [...new Set([...mappedTargets, ...setAPaths, ...onDisk])])

  // A mapped file that exists on disk but that git would never commit (ignored
  // by a .gitignore) hashes equal here and is missing from every clone. Refuse.
  const committable = new Set(onDisk)
  for (const p of mappedTargets)
    if (hashes.get(p) !== null && !committable.has(p))
      problems.push(`${p} exists on disk but is ignored by git — it would never be committed, so a clone would lack it`)

  const compare = (sourcePath, sourceBlob) => {
    const kernelPath = mapSourcePath(sourcePath)
    const kernelBlob = hashes.get(kernelPath) ?? null
    return { sourcePath, kernelPath, sourceBlob, kernelBlob, listed: listed.has(kernelPath) }
  }

  const sets = {
    A: { label: `services/** changed ${base.slice(0, 8)}..${tag}`, total: setA.length, mismatches: [] },
    B: { label: `services/** at ${tag}`, total: b.blobs.size, mismatches: [] },
    C: { label: 'content UI half (gremion-ui/src -> modules/content/app)', total: c.blobs.size, mismatches: [] },
  }

  for (const { status, path } of setA) {
    const r = status === 'D' ? { ...compare(path, null) } : compare(path, b.blobs.get(path))
    if (r.sourceBlob !== r.kernelBlob) {
      sets.A.mismatches.push(r)
      problems.push(`set A: ${r.kernelPath} differs from ${tag}:${path} (${status}) — set A is never scrubbed, listed or not`)
    }
  }
  for (const [key, blobs] of [['B', b.blobs], ['C', c.blobs]]) {
    for (const [path, blob] of blobs) {
      const r = compare(path, blob)
      if (r.sourceBlob === r.kernelBlob) continue
      sets[key].mismatches.push(r)
      if (copy) problems.push(`set ${key}: ${r.kernelPath} differs from ${tag}:${path} — --copy asserts the byte-equal copy, and a listed delta does not excuse it`)
      else if (!r.listed) problems.push(`set ${key}: ${r.kernelPath} differs from ${tag}:${path} and ${DELTA_PATH} does not list it`)
    }
  }

  // Reverse direction. Other modules' app/ trees are TASK-205's and not a copy of services/**.
  const extras = onDisk
    .filter((p) => !mappedTargets.has(p))
    .filter((p) => p.startsWith(CONTENT_APP_ROOT) || !/^modules\/[^/]+\/app\//.test(p))
    .map((p) => ({ kernelPath: p, listed: listed.has(p) }))
  // An addition is never a modification of a copied byte, so --copy treats it
  // like the tip does: listed (path, reason, owner) or refused.
  for (const e of extras)
    if (!e.listed) problems.push(`extra: ${e.kernelPath} is in a module directory but no ${tag} path maps to it and ${DELTA_PATH} does not list it`)

  // Stale delta entries: listed, but nothing differs there, or nothing is there at all.
  const differing = new Set([
    ...sets.B.mismatches.map((m) => m.kernelPath),
    ...sets.C.mismatches.map((m) => m.kernelPath),
    ...extras.map((e) => e.kernelPath),
  ])
  for (const path of listed.keys()) {
    if (setAPaths.includes(path)) continue // already refused above
    if (!differing.has(path)) problems.push(`stale delta entry: ${path} is listed in ${DELTA_PATH} but does not differ from ${tag} (or is not in any set) — delete the entry`)
  }

  for (const [key, s] of Object.entries(sets)) if (s.total === 0) problems.push(`set ${key} is empty — the parity check would pass vacuously`)

  return { tag, tagCommit, base, copy, sets, extras, delta: delta?.entries ?? [], problems }
}

export function formatReport(r, { kernelHead = null } = {}) {
  const lines = []
  lines.push(`module-source parity (TASK-200) — scripts/check-module-source-parity.mjs`)
  lines.push(`source: annotated tag ${r.tag} -> ${r.tagCommit}; set-A base (frozen extraction source) ${r.base}`)
  if (kernelHead) lines.push(`kernel: ${kernelHead}`)
  lines.push(`mode: ${r.copy ? '--copy (every difference fails, listed or not)' : 'tip (only EXTRACTION-DELTA.json paths may differ; set A never)'}`)
  lines.push('')
  for (const [key, s] of Object.entries(r.sets)) {
    const listedN = s.mismatches.filter((m) => m.listed).length
    lines.push(`set ${key} — ${s.label}: ${s.total} files, ${s.mismatches.length} differ (${listedN} listed, ${s.mismatches.length - listedN} unlisted)`)
    for (const m of s.mismatches)
      lines.push(`  ${m.listed ? 'listed  ' : 'UNLISTED'} ${m.kernelPath}  tag=${m.sourceBlob ?? 'absent'} kernel=${m.kernelBlob ?? 'absent'}`)
  }
  const listedX = r.extras.filter((e) => e.listed).length
  lines.push(`extras — kernel files in a mapped module directory that no tag path maps to: ${r.extras.length} (${listedX} listed)`)
  for (const e of r.extras) lines.push(`  ${e.listed ? 'listed  ' : 'UNLISTED'} ${e.kernelPath}`)
  lines.push(`delta entries: ${r.delta.length}`)
  lines.push('')
  if (r.problems.length) {
    lines.push(`RESULT: FAIL — ${r.problems.length} problem(s)`)
    for (const p of r.problems) lines.push(`  x ${p}`)
  } else lines.push('RESULT: OK')
  return lines.join('\n') + '\n'
}

// ── CLI ──────────────────────────────────────────────────────────────────

const USAGE = 'usage: node scripts/check-module-source-parity.mjs <path-to-StuRa-tree> <tag> [--copy] [--write <file>]'

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  let parsed
  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      options: { copy: { type: 'boolean' }, write: { type: 'string' } },
      strict: true,
      allowPositionals: true,
    })
  } catch (err) {
    console.error(`[module-source-parity] bad arguments — ${err.message}\n${USAGE}`)
    process.exit(2)
  }
  const [sturaPath, tag, ...rest] = parsed.positionals
  if (!sturaPath || !tag || rest.length) {
    console.error(`[module-source-parity] ${USAGE}`)
    process.exit(2)
  }
  let r
  try {
    r = runParity({ sturaPath, tag, copy: parsed.values.copy === true })
  } catch (err) {
    console.error(`[module-source-parity] refused — ${err.message}`)
    process.exit(1)
  }
  const head = git(KERNEL_ROOT, ['rev-parse', 'HEAD']).trim()
  const dirty = git(KERNEL_ROOT, ['status', '--porcelain', '--', 'modules']).trim() !== ''
  const report = formatReport(r, { kernelHead: `${head}${dirty ? ' + uncommitted changes under modules/' : ''}` })
  if (parsed.values.write) writeFileSync(join(KERNEL_ROOT, parsed.values.write), report)
  process.stdout.write(report)
  process.exit(r.problems.length ? 1 : 0)
}
