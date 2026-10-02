// TASK-205a (TASK-200 residual (b)): the verify `unit` suite's `modules` part runs EACH modules/<id> package's
// own `test` script. Before it, no verify suite ran any module's vitest suite at all. A fixture root with
// stand-in reporters proves the three behaviours that matter, each by its report and not by an exit code:
// every module with a test script is run, a module whose suite FAILS turns the suite red, and an empty module
// set is a failing (zero-collected) part, never a pass.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { moduleDirsWithTestScript, runUnitSuite, UNIT_PARTS } from './suites/unit.mjs'

const REPO_ROOT = path.join(import.meta.dirname, '..', '..')
const FAKE_GREEN = path.join(import.meta.dirname, '__fixtures__', 'vitest-script-wiring', 'fake-reporter.mjs')

function put(root, rel, text) {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  writeFileSync(path.join(root, rel), text)
}

/** modules/alpha (green suite), modules/beta (no test script: an app-only id), modules/gamma (a FAILING suite). */
function fixtureRoot({ withFailing }) {
  const root = mkdtempSync(path.join(tmpdir(), 't205-unit-modules-'))
  put(root, 'modules/alpha/package.json', JSON.stringify({ name: 'alpha', private: true, scripts: { test: `node "${FAKE_GREEN}"` } }))
  put(root, 'modules/beta/package.json', JSON.stringify({ name: 'beta', private: true }))
  if (withFailing) {
    put(
      root,
      'modules/gamma/failing-reporter.mjs',
      [
        "import { writeFileSync } from 'node:fs'",
        "const out = process.argv.find((a) => a.startsWith('--outputFile=')).slice('--outputFile='.length)",
        "writeFileSync(out, JSON.stringify({ success: false, numTotalTests: 2, numPassedTests: 1, numFailedTests: 1, numPendingTests: 0, numTodoTests: 0, numFailedTestSuites: 1, testResults: [] }))",
        'process.exit(1)',
        '',
      ].join('\n'),
    )
    put(root, 'modules/gamma/package.json', JSON.stringify({ name: 'gamma', private: true, scripts: { test: 'node failing-reporter.mjs' } }))
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('moduleDirsWithTestScript lists every module package with a test script, and not an app-only id', () => {
  const f = fixtureRoot({ withFailing: true })
  try {
    assert.deepEqual(moduleDirsWithTestScript(f.root), ['alpha', 'gamma'])
  } finally {
    f.cleanup()
  }
})

test('the real tree: the modules part exists and names the leaf suites the kernel carries', () => {
  assert.equal(typeof UNIT_PARTS.modules, 'function')
  const ids = moduleDirsWithTestScript(REPO_ROOT)
  for (const id of ['board', 'calendar', 'files', 'messaging', 'votes']) assert.ok(ids.includes(id), `modules/${id} has a test script and must be a verify part`)
})

test('RED: a failing module suite turns the unit suite red (one part per module, judged by its report)', () => {
  const f = fixtureRoot({ withFailing: true })
  try {
    const r = runUnitSuite({ root: f.root, only: ['modules'] })
    assert.equal(r.collected, 3, 'both modules ran: 1 + 2 tests')
    assert.equal(r.passed, 2)
    assert.equal(r.failed, 1, 'the seeded failure is counted, not swallowed')
    assert.equal(r.unparseable, false)
  } finally {
    f.cleanup()
  }
})

test('GREEN: with only passing module suites nothing fails', () => {
  const f = fixtureRoot({ withFailing: false })
  try {
    const r = runUnitSuite({ root: f.root, only: ['modules'] })
    assert.equal(r.failed, 0)
    assert.equal(r.collected, 1)
  } finally {
    f.cleanup()
  }
})

test('RED: a root with no module test script is a zero-collected part, never a pass', () => {
  const root = mkdtempSync(path.join(tmpdir(), 't205-unit-modules-empty-'))
  try {
    put(root, 'modules/only-app/package.json', JSON.stringify({ name: 'only-app', private: true }))
    const r = runUnitSuite({ root, only: ['modules'] })
    assert.equal(r.collected, 0)
    assert.ok(r.emptyParts.length > 0, 'the empty part is named so the suite fails by name')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
