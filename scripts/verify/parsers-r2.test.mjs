// TASK-045 round 2: parser fail-open paths found in the round-1 review and
// while fixing it. Each test names the concrete shape that used to pass.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  countDeclaredNodeTests,
  parseNodeTapSummary,
  parseVitestJsonFile,
  skipsByFileFromVitestJson,
} from './lib/parsers.mjs'

function withJson(obj, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'verify-parsers-r2-'))
  const file = path.join(dir, 'result.json')
  writeFileSync(file, JSON.stringify(obj))
  try {
    return fn(file)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// Real `node --test --test-reporter=tap` summary (node 26.1, probed
// 2026-09-25) for a file with one passing test, one test.todo, one
// test.skip, one test that hit its {timeout} and one test with a passing
// subtest: the timed-out test is `cancelled`, NOT `fail`.
const NODE_SUMMARY_WITH_CANCELLED = '# tests 6\n# suites 0\n# pass 3\n# fail 0\n# cancelled 1\n# skipped 1\n# todo 1\n# duration_ms 621.9\n'

test('parseNodeTapSummary counts a cancelled (timed-out) test as failed, never as a pass', () => {
  const r = parseNodeTapSummary(NODE_SUMMARY_WITH_CANCELLED)
  assert.ok(r, 'expected a parsed summary')
  assert.equal(r.failed, 1)
  assert.equal(r.collected, 6)
  // todo folds into skipped, the same way vitest's numTodoTests does.
  assert.equal(r.skipped, 2)
  assert.equal(r.passed, 3)
})

test('parseNodeTapSummary returns null when the summary lines do not add up to # tests', () => {
  assert.equal(parseNodeTapSummary('# tests 7\n# pass 3\n# fail 0\n# cancelled 1\n# skipped 1\n# todo 1\n'), null)
})

test('parseNodeTapSummary returns null without the cancelled/todo lines node always prints', () => {
  assert.equal(parseNodeTapSummary('# tests 4\n# pass 3\n# fail 0\n# skipped 1\n'), null)
})

test('countDeclaredNodeTests counts test.skip( / test.only( / test.todo( declarations too', () => {
  const src = "test('a', () => {})\ntest.skip('b', () => {})\n  test.only('c', () => {})\ntest.todo('d')\n"
  assert.equal(countDeclaredNodeTests([src]), 4)
})

test('parseVitestJsonFile adds only files that failed WITHOUT a failing test (a collection error), not every failed file', () => {
  // File a: one failing test (already in numFailedTests). File b: threw at
  // import, no assertions at all. numFailedTestSuites is 2, but only b is
  // missing from the per-test counts.
  const report = {
    success: false,
    numTotalTests: 3,
    numPassedTests: 2,
    numFailedTests: 1,
    numPendingTests: 0,
    numTodoTests: 0,
    numFailedTestSuites: 2,
    testResults: [
      { name: '/r/a.test.ts', status: 'failed', assertionResults: [{ status: 'passed' }, { status: 'passed' }, { status: 'failed' }] },
      { name: '/r/b.test.ts', status: 'failed', assertionResults: [] },
    ],
  }
  const r = withJson(report, parseVitestJsonFile)
  assert.deepEqual(r, { collected: 4, passed: 2, failed: 2, skipped: 0 })
})

test('parseVitestJsonFile does not double-count a file whose only problem is a failing test', () => {
  const report = {
    success: false,
    numTotalTests: 2,
    numPassedTests: 1,
    numFailedTests: 1,
    numPendingTests: 0,
    numTodoTests: 0,
    numFailedTestSuites: 1,
    testResults: [{ name: '/r/a.test.ts', status: 'failed', assertionResults: [{ status: 'passed' }, { status: 'failed' }] }],
  }
  assert.deepEqual(withJson(report, parseVitestJsonFile), { collected: 2, passed: 1, failed: 1, skipped: 0 })
})

test('parseVitestJsonFile fails a run vitest itself called unsuccessful even when every file and test looks green', () => {
  // e.g. an unhandled error / rejection outside any test: vitest reports
  // success:false and exits 1 with nothing failed in the per-file results.
  const report = {
    success: false,
    numTotalTests: 2,
    numPassedTests: 2,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    numFailedTestSuites: 0,
    testResults: [{ name: '/r/a.test.ts', status: 'passed', assertionResults: [{ status: 'passed' }, { status: 'passed' }] }],
  }
  const r = withJson(report, parseVitestJsonFile)
  assert.ok(r.failed > 0, JSON.stringify(r))
})

test('skipsByFileFromVitestJson returns repo-relative posix paths when given the repo root', () => {
  const root = path.resolve('/repo-root-task045')
  const abs = path.join(root, 'packages', 'ports', 'src', 'nats.test.ts')
  const report = {
    testResults: [
      { name: abs.split(path.sep).join('/'), assertionResults: [{ status: 'pending' }, { status: 'todo' }, { status: 'passed' }] },
      { name: path.join(root, 'x.test.ts'), assertionResults: [{ status: 'passed' }] },
    ],
  }
  assert.deepEqual(withJson(report, (f) => skipsByFileFromVitestJson(f, { root })), { 'packages/ports/src/nats.test.ts': 2 })
})
