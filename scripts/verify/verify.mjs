#!/usr/bin/env node
// TASK-045 (L2-02, TRD-444/341): `pnpm verify` -> `make verify` -> this file.
//
// Runs the required suites (scripts/verify/required-suites.txt), judges each
// one through lib/guard.mjs's fail-closed vacuity rules, prints one PASS/FAIL
// line per suite, and writes a result record (scripts/verify/out/<sha>.json)
// that scripts/verify/check-record.mjs is the only thing meant to read.
//
// Deliberately carries NO skip mechanism of any kind -- no `VERIFY_SKIP_*`
// env var, no `--skip` flag, no dirty-tree override. The only argument is
// `--only <suite[,suite]>`, and any other argument is a usage error (exit 1),
// never silently ignored. A required suite is either run and judged, or its
// absence from the registry is itself a FAIL (see runAll below). If you are
// tempted to add an escape hatch here, add a per-file entry to
// allowed-skips.json instead (Q3), which is scoped to individual tests inside
// a suite, not whole suites.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { evaluateSuite } from './lib/guard.mjs'
import { headSha, isDirty } from './lib/git.mjs'
import { parseSvelteCheckMachine } from './lib/parsers.mjs'
import { writeRecord } from './lib/record.mjs'
import { allowedSkipsForSuite, checkSkipsByFile, loadAllowedSkips } from './lib/skips.mjs'
import { runCensusSuite } from './census/suite.mjs'
import { runCarveLintSuite } from './suites/carve-lint.mjs'
import { runFixtureMissingTool, runFixtureNodeZero, runFixtureVitestAllskip } from './suites/fixtures.mjs'
import { DEFERRED_BATS_NOTE, INTEGRATION_PARTS, runIntegrationSuite } from './suites/integration.mjs'
import { runIsolationSuite } from './suites/isolation.mjs'
import { runMigrationHashSuite } from './suites/migration-hash.mjs'
import { runTypecheckSuite } from './suites/typecheck.mjs'
import { runUnitSuite, UNIT_PARTS } from './suites/unit.mjs'
import { run, tail } from './lib/proc.mjs'

const REPO_ROOT = path.join(import.meta.dirname, '..', '..')
export const REQUIRED_SUITES_PATH = path.join(import.meta.dirname, 'required-suites.txt')

// unit:<part> / integration:<part> -- one registry entry per UNIT_PARTS /
// INTEGRATION_PARTS key, generated from those modules' own key lists so a
// part added there (or removed) is reachable through `--only` (or reported as
// dropped by meta.test.mjs) without anyone having to remember a second,
// hand-kept list here. Each fits a single 4-minute agent tool call even when
// the whole suite (`unit`, `integration`) does not (brief S7: gremion-ui's
// vitest alone runs ~185-340s) -- round 2 MEDIUM: these existed as
// UNIT_PARTS/INTEGRATION_PARTS keys but were reachable from nowhere `--only`
// could name, so brief S7's own promised command failed with "no such suite
// in the registry".
const UNIT_PART_ENTRIES = Object.fromEntries(
  Object.keys(UNIT_PARTS).map((part) => [`unit:${part}`, () => runUnitSuite({ only: [part] })]),
)
const INTEGRATION_PART_ENTRIES = Object.fromEntries(
  Object.keys(INTEGRATION_PARTS).map((part) => [`integration:${part}`, () => runIntegrationSuite({ only: [part] })]),
)

// name -> runner. Fixture suites (S6 item 1's TDD harness) are reachable only
// through `--only`; required-suites.txt never names one, so a bare `verify`
// can never accidentally judge the real gate on a seeded-bad fixture.
export const SUITE_REGISTRY = {
  typecheck: runTypecheckSuite,
  unit: runUnitSuite,
  integration: runIntegrationSuite,
  'migration-hash': () => runMigrationHashSuite({ root: REPO_ROOT }),
  'carve-lint': () => runCarveLintSuite({ cwd: REPO_ROOT }),
  // TASK-117 residual (R24-10): the only proof of cross-tenant storage
  // isolation (TRD-065/067) ran solely as a side effect of gremion-ui's vite
  // include glob; nothing here named or pinned it. See suites/isolation.mjs.
  isolation: () => runIsolationSuite({ root: REPO_ROOT }),
  // TASK-036 (L1-17, TRD-178): declared health census of the production renders.
  census: () => runCensusSuite(),
  // TASK-015 (TRD-251/252/253, L3-11): the vendor mail guards and their tests,
  // run as their own process (ops/vendor-mail/suite-cli.mjs, which calls
  // runVendorMailSuite) and never imported: scripts/verify must load from a
  // copy of itself alone, and a missing ops/ tree is this suite's FAIL.
  'vendor-mail': () => {
    const res = run(process.execPath, [path.join(REPO_ROOT, 'ops', 'vendor-mail', 'suite-cli.mjs')], { cwd: REPO_ROOT })
    const prefix = 'VENDOR-MAIL-SUITE '
    const line = res.stdout.split(/\r?\n/).findLast((l) => l.startsWith(prefix))
    if (res.code === 0 && line) {
      try {
        return JSON.parse(line.slice(prefix.length))
      } catch {
        // an unparseable result line is judged below, like no line at all
      }
    }
    return { toolMissing: null, unparseable: true, collected: 0, passed: 0, failed: 0, skipped: 0, detail: `ops/vendor-mail/suite-cli.mjs: exit ${String(res.code ?? res.signal)} without a result line\n${tail(String(res.stdout) + String(res.stderr))}` }
  },
  ...UNIT_PART_ENTRIES,
  ...INTEGRATION_PART_ENTRIES,
  __fixture_node_zero__: runFixtureNodeZero,
  __fixture_vitest_allskip__: runFixtureVitestAllskip,
  __fixture_missing_tool__: runFixtureMissingTool,
}

/**
 * required-suites.txt: one suite name per line; blank lines and `#` comment
 * lines are ignored. See that file's header for the format contract other
 * tasks (TASK-046 supply-chain, isolation, i18n, a11y) rely on.
 */
export function loadRequiredSuites(text = readFileSync(REQUIRED_SUITES_PATH, 'utf8')) {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'))
}

function isFixtureName(name) {
  return name.startsWith('__fixture')
}

export class UsageError extends Error {}

function splitNames(value) {
  const names = (value ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  if (value === undefined || value.startsWith('--') || names.length === 0) {
    throw new UsageError('--only needs a suite name (--only <suite[,suite]>)')
  }
  return names
}

/** The only argument verify accepts is `--only`; anything else is a usage
 * error, so a typo'd or invented flag (`--skip unit`) can never look like it
 * did something. */
export function parseArgs(argv) {
  const only = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--only') {
      only.push(...splitNames(argv[++i]))
    } else if (arg.startsWith('--only=')) {
      only.push(...splitNames(arg.slice('--only='.length)))
    } else {
      throw new UsageError(`unknown argument: ${arg} -- verify accepts only --only <suite[,suite]> (there is no skip flag)`)
    }
  }
  return { only: only.length ? [...new Set(only)] : null }
}

const UNATTRIBUTED_SUITE_SKIP = '(suite: skip not attributable to a file)'

/**
 * Q3 per file: every skip a suite reports must be attributed to a file with
 * its own allow-list budget. Skips the suite reported in `skipped` but did
 * not attribute (bats, node --test, a lost report) are booked under a key no
 * entry matches, so they are judged with a zero budget. Without allow-list
 * data at all, any skip is a violation.
 */
function skipViolations(name, raw, skipsData) {
  const byFile = { ...(raw.skipsByFile ?? {}) }
  const attributed = Object.values(byFile).reduce((a, n) => a + (n > 0 ? n : 0), 0)
  const skipped = Number.isFinite(raw.skipped) ? raw.skipped : 0
  if (skipped > attributed) byFile[UNATTRIBUTED_SUITE_SKIP] = skipped - attributed
  if (!skipsData) {
    return Object.entries(byFile)
      .filter(([, n]) => n > 0)
      .map(([file, n]) => `${file}: ${n} skip(s), and allowed-skips.json could not be loaded`)
  }
  return checkSkipsByFile(name, byFile, skipsData)
}

/**
 * Runs `names`, judges each through lib/guard.mjs, and returns the per-suite
 * result map. A name with no registry entry is reported as its own FAIL
 * ("suite not implemented / dropped from the registry") rather than being
 * silently skipped -- this is what makes a dropped required suite (brief S6
 * item 3 / the meta-test) visible as a failing suite, not an absent line.
 */
export function runAll(names, { skipsData = loadAllowedSkips(), registry = SUITE_REGISTRY } = {}) {
  const results = {}
  for (const name of names) {
    const startedAt = Date.now()
    const runner = registry[name]
    let raw
    if (!runner) {
      raw = { toolMissing: null, unparseable: true, collected: 0, passed: 0, failed: 0, skipped: 0, detail: `no such suite in the registry (dropped?)` }
    } else {
      try {
        raw = runner() ?? { unparseable: true, detail: 'runner returned nothing' }
      } catch (err) {
        raw = { toolMissing: null, unparseable: true, collected: 0, passed: 0, failed: 0, skipped: 0, detail: `threw: ${err.stack || err.message}` }
      }
    }
    const allowedSkips = skipsData ? allowedSkipsForSuite(name, skipsData) : 0
    const skipFileViolations = skipViolations(name, raw, skipsData)
    const verdict = evaluateSuite({ ...raw, allowedSkips, skipFileViolations })
    results[name] = {
      status: verdict.status,
      reason: verdict.reason,
      collected: raw.collected ?? 0,
      passed: raw.passed ?? 0,
      failed: raw.failed ?? 0,
      skipped: raw.skipped ?? 0,
      detail: raw.detail ?? '',
      durationMs: Date.now() - startedAt,
    }
  }
  return results
}

function formatLine(name, r) {
  const label = r.status === 'pass' ? 'PASS' : 'FAIL'
  const secs = (r.durationMs / 1000).toFixed(1)
  const counts = `collected=${r.collected} passed=${r.passed} failed=${r.failed} skipped=${r.skipped}`
  const suffix = r.status === 'fail' ? ` -- ${r.reason}` : ''
  const line = `[verify] ${label} ${name} (${secs}s) ${counts}${suffix}`
  return r.status === 'fail' && r.detail ? `${line}\n${indent(r.detail)}` : line
}

function indent(text) {
  return text
    .split('\n')
    .map((l) => `    ${l}`)
    .join('\n')
}

/**
 * The whole CLI, with every side effect injectable so the tree/HEAD/record
 * paths are testable (verify-r2.test.mjs). Returns the process exit code.
 */
export function runVerify(argv, deps = {}) {
  const {
    repoRoot = REPO_ROOT,
    isDirtyFn = isDirty,
    headShaFn = headSha,
    runAllFn = runAll,
    writeRecordFn = writeRecord,
    loadRequiredFn = loadRequiredSuites,
    loadSkipsFn = loadAllowedSkips,
    log = console.log,
    error = console.error,
  } = deps

  let only
  try {
    ;({ only } = parseArgs(argv))
  } catch (err) {
    if (err instanceof UsageError) {
      error(`[verify] usage error: ${err.message}`)
      return 1
    }
    throw err
  }
  const names = only ?? loadRequiredFn()

  // Q3: judging with an empty allow-list would fail every allowed skip with a
  // misleading reason; judging without the file's per-file budgets is not an
  // option either. A broken allow-list is its own, named refusal.
  let skipsData
  try {
    skipsData = loadSkipsFn()
  } catch (err) {
    error(`[verify] refusing to run: scripts/verify/allowed-skips.json could not be loaded: ${err.message}`)
    return 1
  }

  // Q5, no escape hatch: a record is keyed by HEAD sha (TRD-341) and must
  // describe the exact tree that was tested, so this refusal is unconditional
  // for every real suite. An earlier VERIFY_ALLOW_DIRTY=1 env var bypassed it
  // (round-1 HIGH, reproduced writing a green migration-hash record for a
  // tampered-then-restored HEAD); it is gone, not flagged.
  const touchesRealSuite = names.some((n) => !isFixtureName(n))
  let sha = null
  if (touchesRealSuite) {
    if (isDirtyFn(repoRoot)) {
      error(
        '[verify] refusing to run: the tree has uncommitted changes or untracked, non-ignored files. ' +
          'A result record is keyed by HEAD sha (TRD-341) and must describe the exact tree that was ' +
          'tested (Q5) -- commit, stash or remove them first.',
      )
      return 1
    }
    // Taken BEFORE the run: the record describes the commit that was
    // actually tested, not whatever HEAD is when the run ends.
    sha = headShaFn(repoRoot)
  }

  const startedAt = new Date().toISOString()
  const results = runAllFn(names, { skipsData })
  const finishedAt = new Date().toISOString()

  for (const name of names) log(formatLine(name, results[name]))

  if (touchesRealSuite) {
    // A suite (or anything else) that edits tracked files, or a commit made
    // in this checkout mid-run, means the results describe no single commit.
    // No record is written: a green record here would authorize bytes that
    // were never tested as a whole.
    const shaAfter = headShaFn(repoRoot)
    if (shaAfter !== sha) {
      error(`[verify] FAILED -- HEAD moved during the run (${sha} -> ${shaAfter}); no record written, re-run on a quiet checkout`)
      return 1
    }
    if (isDirtyFn(repoRoot)) {
      error('[verify] FAILED -- the tree changed during the run (tracked edits or new untracked files); no record written')
      return 1
    }
  }

  const allPass = names.every((n) => results[n]?.status === 'pass')
  const partial = only !== null

  if (touchesRealSuite) {
    const { path: recordFile } = writeRecordFn({
      sha,
      suites: results,
      only: partial ? names.join(',') : null,
      startedAt,
      finishedAt,
      deferred: [DEFERRED_BATS_NOTE],
    })
    log(`[verify] record: ${recordFile}${partial ? ' (partial -- never satisfies check-record.mjs)' : ''}`)
  }

  if (!allPass) {
    error('[verify] FAILED')
    return 1
  }
  if (partial) {
    log('[verify] partial run OK (--only) -- this does NOT satisfy check-record.mjs')
    return 0
  }
  log('[verify] all suites PASS')
  return 0
}

// Re-exported for lib/parsers.mjs consumers that want the machine-check
// parser without importing the whole suite module.
export { parseSvelteCheckMachine }

// Synchronous on purpose: nothing here awaits, and an `async main()` that
// nobody awaited turned any throw into an unhandled rejection with Node's
// default crash output instead of this file's own FAILED line (round-1
// MEDIUM). Every unexpected error is a formatted failure with exit 1.
function main() {
  try {
    process.exitCode = runVerify(process.argv.slice(2))
  } catch (err) {
    console.error(`[verify] FAILED -- internal error: ${err?.stack || err}`)
    process.exitCode = 1
  }
}

// `pathToFileURL(...).href` is exactly how Node derives `import.meta.url`
// for a local file, so this compares like with like on every platform,
// including a checkout path containing a space (a hand-built `file://`
// string did not, and main() silently never ran -- round-1 HIGH).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
