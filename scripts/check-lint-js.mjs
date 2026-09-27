#!/usr/bin/env node
// R25-2: `make lint-js`, a RATCHET over standalone `oxlint --type-aware`
// (root .oxlintrc.json) until the error baseline reaches zero.
//
// TASK-045's meta-test requires the verify gate to run every lint-* target the
// Makefile defines, so lint-js cannot sit outside verify while the tree still
// carries known errors. A hard zero-error gate would block every merge on the
// existing backlog; a ratchet blocks exactly what matters now: NEW errors. It
// fails when the count rises above scripts/lint-js-baseline.json, passes at or
// below it, and asks for the baseline to be lowered when the count falls, so
// the number only ever goes down. At baseline 0 this is a plain zero-error gate.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const REPO_ROOT = path.join(import.meta.dirname, '..')
const BASELINE_FILE = path.join(REPO_ROOT, 'scripts', 'lint-js-baseline.json')

/** Error-severity diagnostics in an `oxlint -f json` report. */
export function countErrors(report) {
  if (!report || !Array.isArray(report.diagnostics)) {
    throw new Error('lint-js: the oxlint report has no diagnostics array')
  }
  return report.diagnostics.filter((d) => d.severity === 'error').length
}

export function judge({ errors, baseline }) {
  if (!Number.isInteger(baseline) || baseline < 0) {
    throw new Error(`lint-js: invalid baseline ${JSON.stringify(baseline)} in scripts/lint-js-baseline.json`)
  }
  if (errors > baseline) {
    return { ok: false, message: `lint-js: ${errors} errors, above the baseline ${baseline}: fix the new ones (pnpm exec oxlint --type-aware)` }
  }
  if (errors < baseline) {
    return { ok: true, message: `lint-js: ${errors} errors, below the baseline ${baseline}: lower scripts/lint-js-baseline.json to ${errors}` }
  }
  return { ok: true, message: `lint-js: ${errors} errors (baseline ${baseline})` }
}

// gremion-ui's and gremion-public's tsconfig.json each extend their own
// SvelteKit-generated .svelte-kit/tsconfig.json (not committed). Without a
// sync first, --type-aware both misses real type-aware findings in those two
// apps AND adds two spurious typescript(tsconfig-error) diagnostics naming the
// missing file -- neither is a real code lint error. Same fix
// scripts/verify/suites/typecheck.mjs already applies per app.
const SYNC_DIRS = ['gremion-ui', 'gremion-public']

function main() {
  for (const dir of SYNC_DIRS) {
    const sync = spawnSync('pnpm exec svelte-kit sync', {
      cwd: path.join(REPO_ROOT, dir), encoding: 'utf8', shell: true,
    })
    if (sync.status !== 0) {
      console.error(`lint-js: ${dir} svelte-kit sync failed (exit ${sync.status}): ${(sync.stderr || '').slice(-600)}`)
      process.exit(2)
    }
  }
  // One constant command string: pnpm is a .cmd shim on Windows, so a shell is
  // needed there, and a string (not an args array) keeps Node's DEP0190 quiet.
  const res = spawnSync('pnpm exec oxlint --type-aware -f json', {
    cwd: REPO_ROOT, encoding: 'utf8', shell: true, maxBuffer: 256 * 1024 * 1024,
  })
  let report
  try {
    report = JSON.parse(res.stdout)
  } catch {
    console.error(`lint-js: oxlint produced no JSON report (exit ${res.status}): ${(res.stderr || '').slice(-600)}`)
    process.exit(2)
  }
  const { baseline } = JSON.parse(readFileSync(BASELINE_FILE, 'utf8'))
  const verdict = judge({ errors: countErrors(report), baseline })
  console.log(verdict.message)
  if (!verdict.ok) process.exit(1)
  console.log('  oxlint: OK')
}

if (import.meta.filename === path.resolve(process.argv[1] ?? '')) main()
