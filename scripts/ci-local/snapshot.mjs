#!/usr/bin/env node
// Dated pass/fail snapshot of every test suite on both repositories' tips
// (TASK-012 acceptance item 1, TRD-340).
//
//   node scripts/ci-local/snapshot.mjs --kernel <path> [--vertical <path>] --out <dir>
//     [--list] [--only <suite-id,suite-id,...>] [--manifest <path>] [--stack-env <file>]
//   node --test scripts/ci-local/snapshot.test.mjs
//
// --vertical is OPTIONAL. Without it (a kernel-only checkout) every vertical
// suite is reported as a SKIPPED row, "skipped: no --vertical" — visible in
// the console, the JSON and the markdown, never counted as PASS — and the
// exit code reflects the kernel suites alone. A --vertical that is given but
// does not exist is a loud error, never a silent fall-back to kernel-only.
// --list is a dry run: it prints which suites WOULD RUN and which are
// SKIPPED, runs nothing, and needs no --out and no clean tree.
//
// --out is MANDATORY (except with --list) (§5 Q3 default: commit nothing to the kernel — the
// maintainer files snapshots in the vault ledger). --only lets a caller
// stay under a 4-minute wall-clock budget by running a named subset instead
// of every suite in suites.json — the FULL run across every suite of both
// repos is the maintainer's whole-tree gate, run once, not this script's
// job on every invocation. --stack-env is a marker file only: this script
// never starts or stops a stack (§5 Q4) — its presence is what lets
// requiresStack suites run at all; its content is not read.
//
// Exit is non-zero whenever ANY row is FAIL, including an intentional "no
// stack" row — an honest FAIL is still a FAIL, and this script's job is to
// record it, never to make it disappear.

import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDirty, headInfo, isGitRepo } from './lib/git.mjs'
import { loadManifest, validateManifest, suitesFor } from './lib/manifest.mjs'
import { discoverTestFiles } from './lib/discover.mjs'
import { run } from './lib/run.mjs'
import { evaluateSuite, findUnclaimed, unclaimedRows, unknownOnlyRows, skippedVerticalRows, NO_VERTICAL_REASON, overallExit, snapshotBaseName, renderMarkdown } from './lib/snapshot-core.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_MANIFEST = join(HERE, 'suites.json')

function argValue(argv, flag) {
  const i = argv.indexOf(flag)
  return i === -1 ? null : argv[i + 1]
}

/** Sum of top-level `test(` declarations across the given repo-relative .test.mjs files. */
export function countDeclaredTests(repoPath, files) {
  let n = 0
  for (const f of files) {
    if (!f.endsWith('.test.mjs')) continue
    try {
      const text = readFileSync(join(repoPath, f), 'utf8')
      n += (text.match(/^test\(/gm) || []).length
    } catch {
      /* file vanished mid-run — leave it uncounted, the collected-count check still catches a real regression */
    }
  }
  return n
}

/** Run every (--only filtered) suite for one repo and return its result rows plus unclaimed rows. */
export function evaluateRepo(repoLabel, repoPath, manifest, onlyIds, stackEnvFile) {
  const suites = suitesFor(manifest, repoLabel, onlyIds)
  const discovered = discoverTestFiles(repoPath)
  // LOW fix: presence of --stack-env's FLAG used to be enough; the named
  // file's actual existence was never checked, so a typo'd or missing
  // --stack-env path let a requiresStack suite try to run for real (see
  // snapshot-core.mjs's header on stackEnvExists).
  const stackEnvExists = stackEnvFile !== undefined && existsSync(stackEnvFile)
  const opts = {
    joinRepo: (p) => join(repoPath, p),
    runFn: (command, cwd, runOpts) => run(command, cwd, runOpts),
    stackEnvFile,
    stackEnvExists,
    countDeclared: (files) => countDeclaredTests(repoPath, files),
  }
  const rows = suites.map((s) => evaluateSuite(s, discovered, opts))
  // Unclaimed files are computed against the FULL manifest for this repo,
  // never the --only-narrowed list — --only changes what runs, not what
  // ownership looks like.
  const unclaimed = findUnclaimed(discovered, manifest[repoLabel] ?? [])
  return [...rows, ...unclaimedRows(repoLabel, unclaimed)]
}

export function main(argv = process.argv.slice(2)) {
  const kernelPath = argValue(argv, '--kernel')
  const verticalPath = argValue(argv, '--vertical')
  const outDir = argValue(argv, '--out')
  const manifestPath = argValue(argv, '--manifest') ?? DEFAULT_MANIFEST
  const onlyRaw = argValue(argv, '--only')
  const onlyIds = onlyRaw ? onlyRaw.split(',').map((s) => s.trim()).filter(Boolean) : undefined
  const stackEnvFile = argValue(argv, '--stack-env') ?? undefined

  const listOnly = argv.includes('--list')

  if (!kernelPath || (!outDir && !listOnly)) {
    console.error('snapshot: --kernel <path> and --out <dir> are required (--vertical <path> is optional; --list needs no --out)')
    process.exitCode = 1
    return
  }
  if (verticalPath && !existsSync(verticalPath)) {
    console.error(`snapshot: --vertical path '${verticalPath}' does not exist`)
    process.exitCode = 1
    return
  }

  const manifest = loadManifest(manifestPath)
  const problems = validateManifest(manifest)
  if (problems.length > 0) {
    console.error('snapshot: suites.json manifest is invalid:')
    for (const p of problems) console.error(`  x ${p}`)
    process.exitCode = 1
    return
  }

  if (listOnly) {
    const plan = [
      ...suitesFor(manifest, 'kernel', onlyIds).map((x) => ({ ...x, planned: 'WOULD RUN' })),
      ...(verticalPath
        ? suitesFor(manifest, 'vertical', onlyIds).map((x) => ({ ...x, planned: 'WOULD RUN' }))
        : skippedVerticalRows(manifest, onlyIds).map((x) => ({ ...x, planned: 'SKIPPED' }))),
    ]
    for (const x of plan) {
      const tail = x.planned === 'SKIPPED' ? x.reason : x.unrunnable ? `unrunnable: ${x.unrunnable}` : x.command
      console.log(`${x.planned} [${x.repo}/${x.category}] ${x.id} — ${tail}`)
    }
    console.log(`snapshot --list: ${plan.filter((x) => x.planned === 'WOULD RUN').length} would run, ${plan.filter((x) => x.planned === 'SKIPPED').length} skipped (dry run, nothing executed)`)
    process.exitCode = 0
    return
  }

  for (const [label, path] of [
    ['kernel', kernelPath],
    ...(verticalPath ? [['vertical', verticalPath]] : []),
  ]) {
    if (!isGitRepo(path)) {
      console.error(`snapshot: ${label} path '${path}' is not a git repository`)
      process.exitCode = 1
      return
    }
    if (isDirty(path)) {
      console.error(`snapshot: REFUSED — ${label} working tree at '${path}' is dirty (uncommitted or untracked changes)`)
      process.exitCode = 1
      return
    }
  }

  const startedAt = new Date().toISOString()
  const kernelInfo = headInfo(kernelPath)
  const verticalInfo = verticalPath ? headInfo(verticalPath) : null

  const kernelRows = evaluateRepo('kernel', kernelPath, manifest, onlyIds, stackEnvFile)
  const verticalRows = verticalPath
    ? evaluateRepo('vertical', verticalPath, manifest, onlyIds, stackEnvFile)
    : skippedVerticalRows(manifest, onlyIds)
  const suites = [...kernelRows, ...verticalRows, ...unknownOnlyRows(onlyIds, manifest)]
  const finishedAt = new Date().toISOString()

  const date = startedAt.slice(0, 10)
  const snapshot = {
    date,
    kernel: kernelInfo,
    vertical: verticalInfo,
    os: `${process.platform} ${process.version}`,
    startedAt,
    finishedAt,
    overallExit: overallExit(suites),
    only: onlyIds ?? null,
    suites,
  }

  mkdirSync(outDir, { recursive: true })
  // MEDIUM fix: a --only subset run used to write the exact same
  // <date>-<ksha7>-<ssha7> name a FULL run of the same tips on the same day
  // would, so a passing subset could silently overwrite a full F1/re-init/
  // first-offer reading with a partial one that only its JSON `only` field
  // told apart. The suffix means a partial reading can never collide with,
  // or overwrite, a full one's filename.
  const base = snapshotBaseName(date, kernelInfo.shortSha, verticalInfo?.shortSha ?? 'novertical') + (onlyIds ? '-partial' : '')
  const jsonPath = join(outDir, `${base}.json`)
  const mdPath = join(outDir, `${base}.md`)
  writeFileSync(jsonPath, JSON.stringify(snapshot, null, 2))
  writeFileSync(mdPath, renderMarkdown(snapshot))

  console.log(`snapshot: wrote ${jsonPath}`)
  console.log(`snapshot: wrote ${mdPath}`)
  const failed = suites.filter((s) => s.status === 'FAIL').length
  const skipped = suites.filter((s) => s.status === 'SKIPPED').length
  console.log(`snapshot: ${suites.length} row(s), ${failed} FAIL, ${skipped} SKIPPED — overall exit ${snapshot.overallExit}`)
  for (const row of suites) {
    if (row.status === 'FAIL') console.log(`  FAIL [${row.repo}/${row.category}] ${row.id} — ${row.reason ?? ''}`)
  }
  if (skipped > 0) console.log(`  ${skipped} vertical suite(s) ${NO_VERTICAL_REASON} (kernel-only run; these were NOT run and are NOT counted as passed)`)

  process.exitCode = snapshot.overallExit
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('snapshot.mjs')) {
  main()
}
