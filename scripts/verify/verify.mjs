#!/usr/bin/env node
// TASK-045 (L2-02, TRD-444/341): `pnpm verify` -> `make verify` -> this file.
//
// Runs the required suites (scripts/verify/required-suites.txt), judges each
// one through lib/guard.mjs's fail-closed vacuity rules, prints one PASS/FAIL
// line per suite, and writes a result record (scripts/verify/out/<sha>.json)
// that scripts/verify/check-record.mjs is the only thing meant to read.
//
// Deliberately carries NO skip mechanism of any kind -- no `VERIFY_SKIP_*`
// env var, no `--skip` flag. A required suite is either run and judged, or
// its absence from the registry is itself a FAIL (see runAll below). Adding
// one is exactly the defect brief S6 item 3 exists to keep out; if you are
// tempted to add an escape hatch here, add it to allowed-skips.json instead
// (Q3), which is scoped to individual tests inside a suite, not whole suites.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { evaluateSuite } from './lib/guard.mjs'
import { headSha, isDirty } from './lib/git.mjs'
import { parseSvelteCheckMachine } from './lib/parsers.mjs'
import { writeRecord } from './lib/record.mjs'
import { allowedSkipsForSuite, loadAllowedSkips } from './lib/skips.mjs'
import { runCarveLintSuite } from './suites/carve-lint.mjs'
import { runFixtureMissingTool, runFixtureNodeZero, runFixtureVitestAllskip } from './suites/fixtures.mjs'
import { runIntegrationSuite } from './suites/integration.mjs'
import { runMigrationHashSuite } from './suites/migration-hash.mjs'
import { runTypecheckSuite } from './suites/typecheck.mjs'
import { runUnitSuite } from './suites/unit.mjs'

const REPO_ROOT = path.join(import.meta.dirname, '..', '..')
export const REQUIRED_SUITES_PATH = path.join(import.meta.dirname, 'required-suites.txt')

// name -> runner. Fixture suites (S6 item 1's TDD harness) are reachable only
// through `--only`; required-suites.txt never names one, so a bare `verify`
// can never accidentally judge the real gate on a seeded-bad fixture.
export const SUITE_REGISTRY = {
  typecheck: runTypecheckSuite,
  unit: runUnitSuite,
  integration: runIntegrationSuite,
  'migration-hash': () => runMigrationHashSuite({ root: REPO_ROOT }),
  'carve-lint': () => runCarveLintSuite({ cwd: REPO_ROOT }),
  __fixture_node_zero__: runFixtureNodeZero,
  __fixture_vitest_allskip__: runFixtureVitestAllskip,
  __fixture_missing_tool__: runFixtureMissingTool,
}

export function loadRequiredSuites(text = readFileSync(REQUIRED_SUITES_PATH, 'utf8')) {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'))
}

function isFixtureName(name) {
  return name.startsWith('__fixture')
}

export function parseArgs(argv) {
  const only = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--only') {
      only.push(...argv[++i].split(',').map((s) => s.trim()).filter(Boolean))
    } else if (argv[i].startsWith('--only=')) {
      only.push(...argv[i].slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean))
    }
  }
  return { only: only.length ? only : null }
}

/**
 * Runs `names`, judges each through lib/guard.mjs, and returns the per-suite
 * result map. A name with no registry entry is reported as its own FAIL
 * ("suite not implemented / dropped from the registry") rather than being
 * silently skipped -- this is what makes a dropped required suite (brief S6
 * item 3 / the meta-test) visible as a failing suite, not an absent line.
 */
export function runAll(names, { skipsData = safeLoadAllowedSkips() } = {}) {
  const results = {}
  for (const name of names) {
    const startedAt = Date.now()
    const runner = SUITE_REGISTRY[name]
    let raw
    if (!runner) {
      raw = { toolMissing: null, unparseable: true, collected: 0, passed: 0, failed: 0, skipped: 0, detail: `no such suite in the registry (dropped?)` }
    } else {
      try {
        raw = runner()
      } catch (err) {
        raw = { toolMissing: null, unparseable: true, collected: 0, passed: 0, failed: 0, skipped: 0, detail: `threw: ${err.stack || err.message}` }
      }
    }
    const allowedSkips = skipsData ? allowedSkipsForSuite(name, skipsData) : 0
    const verdict = evaluateSuite({ ...raw, allowedSkips })
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

function safeLoadAllowedSkips() {
  try {
    return loadAllowedSkips()
  } catch {
    return null
  }
}

function printLine(name, r) {
  const label = r.status === 'pass' ? 'PASS' : 'FAIL'
  const secs = (r.durationMs / 1000).toFixed(1)
  const counts = `collected=${r.collected} passed=${r.passed} failed=${r.failed} skipped=${r.skipped}`
  const suffix = r.status === 'fail' ? ` -- ${r.reason}` : ''
  console.log(`[verify] ${label} ${name} (${secs}s) ${counts}${suffix}`)
  if (r.status === 'fail' && r.detail) {
    console.log(indent(r.detail))
  }
}

function indent(text) {
  return text
    .split('\n')
    .map((l) => `    ${l}`)
    .join('\n')
}

async function main() {
  const { only } = parseArgs(process.argv.slice(2))
  const required = loadRequiredSuites()
  const names = only ?? required

  // Q5, no escape hatch: a record is keyed by HEAD sha (TRD-341) and must
  // describe the exact tree that was tested, so this refusal is unconditional
  // for every real suite. An earlier VERIFY_ALLOW_DIRTY=1 env var bypassed it
  // -- undocumented, untested, and reachable on every real merge decision, not
  // just local iteration (house review + verifier finding, both HIGH:
  // reproduced writing a green migration-hash record for a tampered-then-
  // restored HEAD). Removed rather than flagged in the record, because this
  // file's own header already promises "NO skip mechanism of any kind" and a
  // flagged-dirty record is still one more field a merge step must remember
  // to check.
  const touchesRealSuite = names.some((n) => !isFixtureName(n))
  if (touchesRealSuite && isDirty(REPO_ROOT)) {
    console.error(
      '[verify] refusing to run: the tracked tree has uncommitted changes. ' +
        'A result record is keyed by HEAD sha (TRD-341) and must describe the exact tree that was ' +
        'tested (Q5) -- commit or stash first.',
    )
    process.exitCode = 1
    return
  }

  const startedAt = new Date().toISOString()
  const results = runAll(names)
  const finishedAt = new Date().toISOString()

  for (const name of names) printLine(name, results[name])

  const allPass = Object.values(results).every((r) => r.status === 'pass')
  const partial = only !== null

  if (touchesRealSuite) {
    const sha = headSha(REPO_ROOT)
    const { path: recordFile } = writeRecord({ sha, suites: results, only: partial ? names.join(',') : null, startedAt, finishedAt })
    console.log(`[verify] record: ${recordFile}${partial ? ' (partial -- never satisfies check-record.mjs)' : ''}`)
  }

  if (!allPass) {
    console.error('[verify] FAILED')
    process.exitCode = 1
    return
  }
  if (partial) {
    console.log('[verify] partial run OK (--only) -- this does NOT satisfy check-record.mjs')
    return
  }
  console.log('[verify] all suites PASS')
}

// Re-exported for lib/parsers.mjs consumers that want the machine-check
// parser without importing the whole suite module.
export { parseSvelteCheckMachine }

if (import.meta.url === `file://${process.argv[1]}` || import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  main()
}
