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
//      the copy commit (--copy). At the tip only a BLOB-PINNED delta entry (a
//      recorded kernel-ahead edit, TASK-205a) excuses a difference: nothing is
//      scrubbed silently.
//   B  every services/** path at the tag. Byte-equal alone over A would be
//      nearly vacuous (A is one service), so B carries the full copy. At the
//      copy commit (--copy) zero differ; afterwards only the paths
//      modules/EXTRACTION-DELTA.json lists (path, reason, owner) may differ.
//   C  the in-process half of every module that has moved (TASK-205): the per-module
//      prefix table MODULE_APP_PREFIXES maps gremion-ui/src/<rest> to
//      modules/<id>/app/<rest>, under the same rule as B. A path claimed by two
//      modules, a module whose prefixes match nothing, and an unmapped path all fail.
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
// Run:  node scripts/check-module-source-parity.mjs <path-to-StuRa-tree> extraction-source-f2 \
//         [--copy] [--write docs/ops/module-source-parity.txt]
// Test: node --test scripts/check-module-source-parity.test.mjs

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, statSync, lstatSync, readlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { readFrozenExtractionSource } from './lib/extraction-source.mjs'

export const KERNEL_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The annotated tag's commit, decided by the orchestrator (R24-6 Q1). Moving the tag is a new decision:
 * extraction-source-f1 (0c9d342e) was superseded by extraction-source-f2 (StuRa master after R25-4 S-C,
 * verify-r4 finding b), created and pushed by the orchestrator on 2026-09-27.
 */
export const EXPECTED_TAG_COMMIT = 'd0c656d0b266f3a1741f34454e0061bc5078c3f4'

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

const S = 'gremion-ui/src/'

/**
 * The in-process half of every module (TASK-205): which `gremion-ui/src/**` paths of the StuRa tree
 * belong to which module's `modules/<id>/app/**`. The carve manifest's product-module-* rules name
 * the set; the module-id map and the Q3 rulings of the TASK-205 brief decide each directory. One table,
 * one comparator: every prefix below is matched by plain string prefix (a trailing slash = a directory,
 * a trailing dot = every file of that stem, anything else = that file or file stem).
 *
 * Not in the table on purpose: users/** (TASK-131), vaultwarden.* (TASK-157), the shell files, and the
 * modules TASK-205c/d move later (publishing, vault, finance, handover); each joins this table in the
 * commit that moves it.
 */
export const MODULE_APP_PREFIXES = Object.freeze({
  board: [
    S + 'routes/api/board/',
    S + 'routes/tasks/',
    S + 'lib/server/board/',
    S + 'lib/components/board/',
    S + 'lib/modules/manifests/board.',
    S + 'lib/server/seed/seed-board.ts',
    S + 'lib/test/board-tokens-contract.test.ts',
  ],
  calendar: [
    S + 'routes/calendar/',
    S + 'routes/api/calendar/',
    S + 'lib/server/calendar/',
    S + 'lib/components/calendar/',
    S + 'lib/stores/calendar.ts',
    S + 'lib/modules/manifests/calendar.',
    S + 'lib/server/seed/seed-calendar.ts',
    S + 'lib/server/events/calendar-audit-consumer.',
  ],
  content: CONTENT_UI_PREFIXES,
  elections: [
    S + 'routes/elections/',
    S + 'routes/api/elections/',
    S + 'lib/server/elections/',
    S + 'lib/votes/',
    S + 'lib/modules/manifests/elections.',
    S + 'lib/server/seed/seed-elections.ts',
  ],
  files: [
    S + 'routes/files/',
    S + 'routes/api/files/',
    S + 'lib/server/files/',
    S + 'lib/files/',
    S + 'lib/components/files/',
    S + 'lib/modules/manifests/files.',
    // NOT lib/server/storage/nextcloud*: that adapter implements the pre-TASK-117 StorageBackend (./types), which
    // the kernel's tenant-bound @gremion/storage seam replaced; its only consumer is the storage backend switch
    // for finance receipts. It moves with the finance half (TASK-205d), over the new seam, or not at all.
  ],
  messaging: [
    S + 'routes/messages/',
    S + 'routes/element-call/',
    S + 'routes/livekit/',
    S + 'routes/api/messages/',
    S + 'routes/api/video/',
    S + 'routes/api/auth/matrix-',
    S + 'routes/api/internal/push/',
    S + 'lib/server/messages/',
    S + 'lib/stores/matrix.ts',
    S + 'lib/stores/call-store.svelte.ts',
    S + 'lib/components/VideoCallPip.svelte',
    S + 'lib/modules/manifests/messages.',
  ],
  votes: [
    S + 'routes/polls/',
    S + 'routes/votes/',
    S + 'routes/api/polls/',
    S + 'lib/server/polls/',
    S + 'lib/components/ballot/',
    S + 'lib/components/polls/',
    S + 'lib/client/',
  ],
})

/** Module ids that have an in-process half but no StuRa service (TASK-021 created their module.json). */
export const APP_ONLY_MODULE_IDS = Object.freeze(['elections', 'handover'])

const APP_ROOT = (id) => `modules/${id}/app/`

function matchesPrefix(p, pre) {
  return p.startsWith(pre)
}

/** Every module whose app table claims the StuRa path `p` (exactly one is the only valid answer). */
export function appOwners(p, table = MODULE_APP_PREFIXES) {
  return Object.entries(table)
    .filter(([, pres]) => pres.some((pre) => matchesPrefix(p, pre)))
    .map(([id]) => id)
}

function inAnyModuleApp(p, table = MODULE_APP_PREFIXES) {
  return appOwners(p, table).length > 0
}

/** A StuRa path -> its kernel path, or null when it is not in scope (or is doubly mapped: the guard reports that). */
export function mapSourcePath(p, table = MODULE_APP_PREFIXES) {
  const m = /^services\/([^/]+)\/(.+)$/.exec(p)
  if (m) {
    const id = MODULE_ID_MAP[m[1]]
    return id ? `modules/${id}/${m[2]}` : null
  }
  const owners = appOwners(p, table)
  if (owners.length === 1 && p.startsWith(S)) return APP_ROOT(owners[0]) + p.slice(S.length)
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
    if (!(e.blob === null || (typeof e.blob === 'string' && /^[0-9a-f]{40}$/.test(e.blob))))
      problems.push(`${where} (${e.path}): "blob" must pin the kernel blob it excuses (40 lowercase hex; null for a removed file)`)
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

/** `git ls-tree -r` output -> Map path -> { mode, blob }. Newline-safe (-z). */
function parseLsTree(out, where) {
  const entries = new Map()
  const problems = []
  for (const rec of out.split('\0').filter(Boolean)) {
    const m = /^(\d+) (\w+) ([0-9a-f]{40})\t([\s\S]+)$/.exec(rec)
    if (!m) throw new Error(`unparseable ls-tree record: ${JSON.stringify(rec)}`)
    if (m[2] !== 'blob') problems.push(`${m[4]} is a ${m[2]} ${where} — a gitlink cannot be copied by blob`)
    else entries.set(m[4], { mode: m[1], blob: m[3] })
  }
  return { entries, problems }
}

function tagBlobs(sturaPath, tag, pathspecs) {
  const { entries, problems } = parseLsTree(
    git(sturaPath, ['ls-tree', '-r', '-z', `refs/tags/${tag}^{commit}`, '--', ...pathspecs]),
    'at the tag',
  )
  return { blobs: entries, problems }
}

/**
 * The kernel side, as { files: Map path -> { mode, blob }, problems }, over everything under modules/.
 *   'head'     — the COMMITTED tree (`git ls-tree -r HEAD`), and a refusal while modules/ has any
 *                uncommitted or untracked change: what a clone gets is what is checked.
 *   'worktree' — the working tree (tests, and a pre-commit look): tracked plus untracked-not-ignored
 *                files, hashed with git's own filters; symlinks and the exec bit are read with lstat.
 *                A mapped file that exists on disk but is ignored by git is refused.
 */
function kernelState(kernelRoot, source) {
  const problems = []
  if (source === 'head') {
    const dirty = git(kernelRoot, ['status', '--porcelain', '-z', '--untracked-files=all', '--', 'modules']).split('\0').filter(Boolean)
    if (dirty.length)
      problems.push(`modules/ has ${dirty.length} uncommitted or untracked change(s) (e.g. ${dirty[0].trim()}) — parity checks the committed tree; commit or stash first`)
    const { entries, problems: p } = parseLsTree(git(kernelRoot, ['ls-tree', '-r', '-z', 'HEAD', '--', 'modules/']), 'in the kernel')
    return { files: entries, problems: [...problems, ...p] }
  }
  const listedPaths = [
    ...new Set(
      git(kernelRoot, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'modules/'])
        .split('\0')
        .filter(Boolean),
    ),
  ]
  const files = new Map()
  const regular = []
  for (const p of listedPaths) {
    let st
    try {
      st = lstatSync(join(kernelRoot, p))
    } catch {
      continue // tracked but deleted on disk: absent
    }
    if (st.isSymbolicLink()) {
      const blob = git(kernelRoot, ['hash-object', '--stdin'], readlinkSync(join(kernelRoot, p))).trim()
      files.set(p, { mode: '120000', blob })
    } else if (st.isFile()) {
      files.set(p, { mode: st.mode & 0o111 ? '100755' : '100644', blob: null })
      regular.push(p)
    }
  }
  const shas = regular.length ? git(kernelRoot, ['hash-object', '--stdin-paths'], regular.join('\n') + '\n').trim().split('\n') : []
  if (shas.length !== regular.length) throw new Error(`git hash-object returned ${shas.length} hashes for ${regular.length} paths`)
  regular.forEach((p, i) => (files.get(p).blob = shas[i]))
  return { files, problems }
}

/**
 * Kernel-authored metadata inside a module directory: every module's `module.json` (TASK-021) and, for the
 * ids that have no StuRa service, the placeholder `package.json`. Neither exists at the tag, so neither is
 * an "extra".
 */
function isModuleMetadata(id, rest) {
  return rest === 'module.json' || (APP_ONLY_MODULE_IDS.includes(id) && rest === 'package.json')
}

/** Files that may sit directly under modules/ (not in a module directory). */
export const MODULES_ROOT_FILES = Object.freeze(['modules/EXTRACTION-DELTA.json', 'modules/COUPLED-TESTS.json', 'modules/disabled.json'])

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
  const table = opts.appPrefixes ?? MODULE_APP_PREFIXES // injectable so the partition guard's own REDs can be seeded
  const mapPath = (p) => mapSourcePath(p, table)

  const b = tagBlobs(sturaPath, tag, ['services/'])
  const c = tagBlobs(sturaPath, tag, [S])
  problems.push(...b.problems, ...c.problems)
  for (const p of [...c.blobs.keys()]) if (!inAnyModuleApp(p, table)) c.blobs.delete(p)
  // Set C is partitioned by the per-module prefix table: every path is claimed by exactly one module,
  // and every module in the table must claim at least one path (a typo'd prefix would otherwise copy nothing).
  for (const p of c.blobs.keys()) {
    const owners = appOwners(p, table)
    if (owners.length > 1) problems.push(`${p}: doubly mapped (${owners.join(', ')}) — a path belongs to exactly one module's app/`)
  }
  for (const id of Object.keys(table))
    if (![...c.blobs.keys()].some((p) => appOwners(p, table).includes(id)))
      problems.push(`module ${id}: its app prefixes match no path at ${tag} — the module's in-process half would be copied vacuously`)

  // Set A — name-status so a deletion at the tag is an expected ABSENCE, not a skip.
  const aRaw = git(sturaPath, ['diff', '--no-renames', '--name-status', '-z', base, `refs/tags/${tag}^{commit}`, '--', 'services/'])
  const aTok = aRaw.split('\0').filter(Boolean)
  const setA = []
  for (let i = 0; i + 1 < aTok.length; i += 2) setA.push({ status: aTok[i], path: aTok[i + 1] })

  const unmapped = [...b.blobs.keys(), ...c.blobs.keys()].filter((p) => mapPath(p) === null)
  for (const p of unmapped) problems.push(`${p}: no module id maps it — add the service to MODULE_ID_MAP or record why it is not carried`)

  const { delta, problems: deltaProblems } = readDelta(kernelRoot)
  problems.push(...deltaProblems)
  const listed = new Map((delta?.entries ?? []).map((e) => [e.path, e]))

  const knownIds = new Set([...Object.values(MODULE_ID_MAP), ...APP_ONLY_MODULE_IDS])
  const state = kernelState(kernelRoot, opts.source ?? 'worktree')
  problems.push(...state.problems)
  const mappedTargets = new Set([...b.blobs.keys(), ...c.blobs.keys()].map(mapPath).filter(Boolean))
  const setAPaths = setA.map((a) => mapPath(a.path)).filter(Boolean)

  if ((opts.source ?? 'worktree') === 'worktree')
    for (const p of mappedTargets)
      if (!state.files.has(p) && existsSync(join(kernelRoot, p)))
        problems.push(`${p} exists on disk but is ignored by git — it would never be committed, so a clone would lack it`)

  const compare = (sourcePath, source) => {
    const kernelPath = mapPath(sourcePath)
    const k = state.files.get(kernelPath) ?? null
    return {
      sourcePath,
      kernelPath,
      sourceBlob: source?.blob ?? null,
      kernelBlob: k?.blob ?? null,
      sourceMode: source?.mode ?? null,
      kernelMode: k?.mode ?? null,
      listed: listed.has(kernelPath),
    }
  }
  const differs = (r) => r.sourceBlob !== r.kernelBlob || r.sourceMode !== r.kernelMode
  const why = (r) =>
    r.kernelMode === '120000' && r.sourceMode !== '120000'
      ? 'is a symlink in the kernel'
      : r.sourceBlob !== r.kernelBlob
        ? 'differs'
        : `differs in mode (tag ${r.sourceMode}, kernel ${r.kernelMode})`

  const sets = {
    A: { label: `services/** changed ${base.slice(0, 8)}..${tag}`, total: setA.length, mismatches: [] },
    B: { label: `services/** at ${tag}`, total: b.blobs.size, mismatches: [] },
    C: { label: `module in-process halves (gremion-ui/src -> modules/<id>/app; ${Object.keys(table).join(', ')})`, total: c.blobs.size, mismatches: [] },
  }

  // Set A is byte-equal at the copy commit (--copy: nothing excuses it). At the tip the kernel has moved on
  // (R29 fixes landed in the kernel-side module trees), so a set-A difference is excused ONLY by a
  // blob-pinned delta entry: the pin is what makes it a recorded kernel-ahead edit and not a silent scrub.
  for (const { status, path } of setA) {
    const r = compare(path, status === 'D' ? null : b.blobs.get(path))
    if (differs(r)) {
      sets.A.mismatches.push(r)
      const pinned = typeof listed.get(r.kernelPath)?.blob === 'string' || listed.get(r.kernelPath)?.blob === null
      if (copy) problems.push(`set A: ${r.kernelPath} ${why(r)} from ${tag}:${path} (${status}) — --copy asserts the byte-equal copy, and a listed delta does not excuse it`)
      else if (!pinned) problems.push(`set A: ${r.kernelPath} ${why(r)} from ${tag}:${path} (${status}) — set A is never scrubbed silently: only a blob-pinned ${DELTA_PATH} entry (kernel-ahead) excuses it`)
    }
  }
  for (const { key, blobs } of [{ key: 'B', blobs: b.blobs }, { key: 'C', blobs: c.blobs }]) {
    for (const [path, entry] of blobs) {
      const r = compare(path, entry)
      if (!differs(r)) continue
      sets[key].mismatches.push(r)
      if (copy) problems.push(`set ${key}: ${r.kernelPath} ${why(r)} from ${tag}:${path} — --copy asserts the byte-equal copy, and a listed delta does not excuse it`)
      else if (!r.listed) problems.push(`set ${key}: ${r.kernelPath} ${why(r)} from ${tag}:${path} and ${DELTA_PATH} does not list it`)
    }
  }

  // Reverse direction, over ALL of modules/: a file no tag path maps to is an
  // extra (listed or refused) — other modules' app/ trees included, until
  // TASK-205 gives them their own rule. Only the three metadata files may sit
  // directly under modules/, and only mapped module ids may exist.
  const extras = []
  for (const p of state.files.keys()) {
    if (mappedTargets.has(p) || MODULES_ROOT_FILES.includes(p)) continue
    const m = /^modules\/([^/]+)\/([\s\S]+)$/.exec(p)
    if (!m) problems.push(`${p} sits directly under modules/ — only ${MODULES_ROOT_FILES.join(', ')} may`)
    else if (!knownIds.has(m[1])) problems.push(`${p} is in modules/${m[1]}/, which no StuRa service maps to — an unknown module directory`)
    else if (isModuleMetadata(m[1], m[2])) continue // TASK-021's module.json (and the app-only ids' package.json): kernel metadata, not source
    else extras.push({ kernelPath: p, listed: listed.has(p), kernelBlob: state.files.get(p).blob })
  }
  for (const e of extras)
    if (!e.listed) problems.push(`extra: ${e.kernelPath} is in a module directory but no ${tag} path maps to it and ${DELTA_PATH} does not list it`)

  // Listed entries: never a set-A path; must differ (else stale); must pin the blob they excuse.
  const differing = new Map(
    [...sets.B.mismatches, ...sets.C.mismatches, ...extras].map((m) => [m.kernelPath, m.kernelBlob ?? null]),
  )
  for (const [path, e] of listed) {
    if (setAPaths.includes(path) && !differing.has(path)) {
      problems.push(`set-A path ${path} is listed in ${DELTA_PATH} but is byte-equal to the tag — set A is only ever excused while it differs; delete the entry (stale)`)
      continue
    }
    if (!differing.has(path)) {
      problems.push(`stale delta entry: ${path} is listed in ${DELTA_PATH} but does not differ from ${tag} (or is not in any set) — delete the entry`)
      continue
    }
    if (e.blob !== undefined && e.blob !== differing.get(path))
      problems.push(`${DELTA_PATH} entry ${path} pins blob ${e.blob} but the kernel file is ${differing.get(path) ?? 'absent'} — a further edit to a listed file must update its entry`)
  }

  for (const [key, s] of Object.entries(sets)) if (s.total === 0) problems.push(`set ${key} is empty — the parity check would pass vacuously`)

  return { tag, tagCommit, base, copy, sets, extras, delta: delta?.entries ?? [], problems }
}

export function formatReport(r, { kernelHead = null } = {}) {
  const lines = []
  lines.push(`module-source parity (TASK-200) — scripts/check-module-source-parity.mjs`)
  lines.push(`source: annotated tag ${r.tag} -> ${r.tagCommit}; set-A base (frozen extraction source) ${r.base}`)
  if (kernelHead) lines.push(`kernel: ${String(kernelHead)}`)
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
      options: { copy: { type: 'boolean' }, write: { type: 'string' }, worktree: { type: 'boolean' } },
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
    r = runParity({ sturaPath, tag, copy: parsed.values.copy === true, source: parsed.values.worktree ? 'worktree' : 'head' })
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
