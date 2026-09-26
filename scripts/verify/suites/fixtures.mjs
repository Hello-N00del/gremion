// TASK-045: seeded-bad fixture "suites". NOT in required-suites.txt, NEVER
// run by a bare `verify` -- reachable only via `verify --only <fixture name>`,
// which is exactly how the TDD tests in scripts/verify/*.test.mjs prove the
// guard actually fires against a real tool run, not a mocked one.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { combineParts } from '../lib/guard.mjs'
import { REPO_ROOT, runVitestJson } from '../lib/vitest.mjs'
import { nodeTestParts } from './unit.mjs'

const FIXTURES_DIR = path.join(import.meta.dirname, '..', '__fixtures__')

/**
 * Brief S6 item 1, node half: a node:test file with zero top-level test(),
 * run through the REAL unit-suite node sub-check (round-1 review: this
 * fixture used to synthesize its own counts and never ran node --test).
 * node --test itself reports the file as one synthetic passing test; the
 * sub-check turns that into an empty part, which the guard fails as
 * "collected 0 tests in: node --test node-zero/zero.test.mjs".
 */
export function runFixtureNodeZero() {
  return combineParts(nodeTestParts({ cwd: FIXTURES_DIR, files: ['node-zero/zero.test.mjs'] }))
}

/** gremion-ui's own installed vitest entry point, read from vitest's
 * package.json `bin` field rather than a hard-coded internal file name. */
export function gremionUiVitestBin(root = REPO_ROOT) {
  const pkgDir = path.join(root, 'gremion-ui', 'node_modules', 'vitest')
  const pkg = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
  const rel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.vitest
  if (!rel) throw new Error(`${pkgDir}/package.json has no bin entry for vitest`)
  return path.join(pkgDir, rel)
}

/**
 * Brief S6 item 1, vitest half: a vitest file whose only test is `it.skip`.
 * Run for REAL through gremion-ui's installed vitest (proved empirically:
 * vitest itself reports `success: true` for this file), so the fixture
 * exercises the actual tool, not a stand-in for it.
 */
export function runFixtureVitestAllskip({ uiVitestBin } = {}) {
  const bin = uiVitestBin ?? gremionUiVitestBin()
  const configPath = path.join(FIXTURES_DIR, 'vitest-allskip', 'vitest.fixtures.config.mjs')
  return combineParts([
    runVitestJson({ label: 'vitest-allskip fixture', cwd: FIXTURES_DIR, cmd: process.execPath, args: [bin, 'run', '--config', configPath] }),
  ])
}

/** Brief S6 item 2: proves the missing-tool path independent of the host's
 * actual toolset -- this binary can never exist, on any machine. Counts are
 * seeded non-zero so lib/guard.mjs rule 1 (toolMissing) is independently
 * load-bearing here, not merely riding along on rule 3 (zero-collected):
 * with rule 1 disabled this fixture genuinely turns green. */
export function runFixtureMissingTool() {
  return { toolMissing: 'definitely-not-a-real-binary-xyz-task045', unparseable: false, collected: 999, passed: 999, failed: 0, skipped: 0 }
}
