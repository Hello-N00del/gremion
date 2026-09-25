// TASK-045: seeded-bad fixture "suites". NOT in required-suites.txt, NEVER
// run by a bare `verify` -- reachable only via `verify --only <fixture name>`,
// which is exactly how the TDD tests in scripts/verify/*.test.mjs prove the
// guard actually fires against a real tool run, not a mocked one.
import { readFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { countDeclaredNodeTests, parseVitestJsonFile } from '../lib/parsers.mjs'
import { run } from '../lib/proc.mjs'

const FIXTURES_DIR = path.join(import.meta.dirname, '..', '__fixtures__')

/**
 * Brief S6 item 1, node half: a node:test file with zero top-level test().
 * Reports `collected` as the DECLARED count (not the tool's own inflated
 * count -- node --test reports this file as one synthetic passing test), so
 * lib/guard.mjs's zero-collected rule fires with exactly "collected 0 tests".
 */
export function runFixtureNodeZero() {
  const file = path.join(FIXTURES_DIR, 'node-zero', 'zero.test.mjs')
  const declared = countDeclaredNodeTests([readFileSync(file, 'utf8')])
  return { toolMissing: null, unparseable: false, collected: declared, passed: declared, failed: 0, skipped: 0, detail: 'node-zero fixture: 0 top-level test() declared' }
}

/**
 * Brief S6 item 1, vitest half: a vitest file whose only test is `it.skip`.
 * Run for REAL through gremion-ui's installed vitest (proved empirically:
 * vitest itself reports `success: true` for this file), so the fixture
 * exercises the actual tool, not a stand-in for it.
 */
export function runFixtureVitestAllskip({ uiVitestBin } = {}) {
  const bin = uiVitestBin ?? path.join(FIXTURES_DIR, '..', '..', '..', 'gremion-ui', 'node_modules', 'vitest', 'vitest.mjs')
  const configPath = path.join(FIXTURES_DIR, 'vitest-allskip', 'vitest.fixtures.config.mjs')
  const outDir = mkdtempSync(path.join(tmpdir(), 'verify-fixture-vitest-'))
  const outFile = path.join(outDir, 'result.json')
  const res = run('node', [bin, 'run', '--config', configPath, '--reporter=json', `--outputFile=${outFile}`])
  const parsed = parseVitestJsonFile(outFile)
  rmSync(outDir, { recursive: true, force: true })
  if (!parsed) {
    return { toolMissing: null, unparseable: true, collected: 0, passed: 0, failed: 0, skipped: 0, detail: `vitest-allskip fixture produced no parseable report (exit ${res.code})` }
  }
  return { toolMissing: null, unparseable: false, ...parsed, detail: 'vitest-allskip fixture: 1 collected, 1 skipped (it.skip)' }
}

/** Brief S6 item 2: proves the missing-tool path independent of the host's
 * actual toolset -- this binary can never exist, on any machine. Counts are
 * seeded non-zero (matching guard.test.mjs's own "missing tool fails before
 * any count is consulted" proof) so lib/guard.mjs rule 1 (toolMissing) is
 * independently load-bearing here, not merely riding along on rule 3
 * (zero-collected) -- an earlier ledger entry claimed disabling rule 1 alone
 * against this fixture produced a silent {status:'pass'}, which is not
 * reproducible with collected:0 (rule 3 still catches it); with non-zero
 * counts, disabling rule 1 alone genuinely does turn this fixture green,
 * which is what "rule 1 is load-bearing" is supposed to mean. */
export function runFixtureMissingTool() {
  return { toolMissing: 'definitely-not-a-real-binary-xyz-task045', unparseable: false, collected: 999, passed: 999, failed: 0, skipped: 0 }
}
