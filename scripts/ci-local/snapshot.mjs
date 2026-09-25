#!/usr/bin/env node
// Dated pass/fail snapshot of every test suite on both repositories' tips
// (TASK-012 acceptance item 1, TRD-340).
//
//   node scripts/ci-local/snapshot.mjs --kernel <path> --vertical <path> --out <dir>
//     [--only <suite-id,suite-id,...>] [--manifest <path>] [--stack-env <file>]
//   node --test scripts/ci-local/snapshot.test.mjs
//
// --out is MANDATORY (§5 Q3 default: commit nothing to the kernel — the
// orchestrator files snapshots in the vault ledger). --only lets a caller
// stay under a 4-minute wall-clock budget by running a named subset instead
// of every suite in suites.json — the FULL run across every suite of both
// repos is the orchestrator's whole-tree gate, run once, not this script's
// job on every invocation. --stack-env is a marker file only: this script
// never starts or stops a stack (§5 Q4) — its presence is what lets
// requiresStack suites run at all; its content is not read.
//
// Exit is non-zero whenever ANY row is FAIL, including an intentional "no
// stack" row — an honest FAIL is still a FAIL, and this script's job is to
// record it, never to make it disappear.

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDirty, headInfo, isGitRepo } from './lib/git.mjs'
import { loadManifest, validateManifest, suitesFor } from './lib/manifest.mjs'
import { discoverTestFiles } from './lib/discover.mjs'
import { run } from './lib/run.mjs'
import { evaluateSuite, findUnclaimed, unclaimedRows, overallExit, snapshotBaseName, renderMarkdown } from './lib/snapshot-core.mjs'

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
  const opts = {
    joinRepo: (p) => join(repoPath, p),
    runFn: (command, cwd, runOpts) => run(command, cwd, runOpts),
    stackEnvFile,
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
  const sturaosPath = argValue(argv, '--vertical')
  const outDir = argValue(argv, '--out')
  const manifestPath = argValue(argv, '--manifest') ?? DEFAULT_MANIFEST
  const onlyRaw = argValue(argv, '--only')
  const onlyIds = onlyRaw ? onlyRaw.split(',').map((s) => s.trim()).filter(Boolean) : undefined
  const stackEnvFile = argValue(argv, '--stack-env') ?? undefined

  if (!kernelPath || !sturaosPath || !outDir) {
    console.error('snapshot: --kernel <path>, --vertical <path> and --out <dir> are all required')
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

  for (const [label, path] of [
    ['kernel', kernelPath],
    ['vertical', sturaosPath],
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
  const sturaosInfo = headInfo(sturaosPath)

  const kernelRows = evaluateRepo('kernel', kernelPath, manifest, onlyIds, stackEnvFile)
  const sturaosRows = evaluateRepo('vertical', sturaosPath, manifest, onlyIds, stackEnvFile)
  const suites = [...kernelRows, ...sturaosRows]
  const finishedAt = new Date().toISOString()

  const date = startedAt.slice(0, 10)
  const snapshot = {
    date,
    kernel: kernelInfo,
    vertical: sturaosInfo,
    os: `${process.platform} ${process.version}`,
    startedAt,
    finishedAt,
    overallExit: overallExit(suites),
    only: onlyIds ?? null,
    suites,
  }

  mkdirSync(outDir, { recursive: true })
  const base = snapshotBaseName(date, kernelInfo.shortSha, sturaosInfo.shortSha)
  const jsonPath = join(outDir, `${base}.json`)
  const mdPath = join(outDir, `${base}.md`)
  writeFileSync(jsonPath, JSON.stringify(snapshot, null, 2))
  writeFileSync(mdPath, renderMarkdown(snapshot))

  console.log(`snapshot: wrote ${jsonPath}`)
  console.log(`snapshot: wrote ${mdPath}`)
  const failed = suites.filter((s) => s.status === 'FAIL').length
  console.log(`snapshot: ${suites.length} row(s), ${failed} FAIL — overall exit ${snapshot.overallExit}`)
  for (const row of suites) {
    if (row.status === 'FAIL') console.log(`  FAIL [${row.repo}/${row.category}] ${row.id} — ${row.reason ?? ''}`)
  }

  process.exitCode = snapshot.overallExit
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('snapshot.mjs')) {
  main()
}
