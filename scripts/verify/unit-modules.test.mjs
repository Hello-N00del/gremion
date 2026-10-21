// TASK-205a (TASK-200 residual (b)): the verify `unit` suite's `modules` part runs EACH modules/<id> package's
// own `test` script. Before it, no verify suite ran any module's vitest suite at all. A fixture root with
// stand-in reporters proves the three behaviours that matter, each by its report and not by an exit code:
// every module with a test script is run, a module whose suite FAILS turns the suite red, and an empty module
// set is a failing (zero-collected) part, never a pass.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { coupledExcludes } from '../check-module-source-scan.mjs'
import { moduleDirsWithTestScript, runUnitSuite, UNIT_PARTS } from './suites/unit.mjs'

const REPO_ROOT = path.join(import.meta.dirname, '..', '..')
const FAKE_GREEN = path.join(import.meta.dirname, '__fixtures__', 'vitest-script-wiring', 'fake-reporter.mjs')

function put(root, rel, text) {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  writeFileSync(path.join(root, rel), text)
}

/** modules/alpha (green suite), modules/beta (no test script: an app-only id), modules/gamma (a FAILING suite). */
function fixtureRoot({ withFailing, coupled = true }) {
  const root = mkdtempSync(path.join(tmpdir(), 't205-unit-modules-'))
  if (coupled) put(root, 'modules/COUPLED-TESTS.json', JSON.stringify({ comment: 'fixture', entries: [] }))
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

// Brief §6.12 (verifier r1 LOW): each module's run carries `check-module-source-scan.mjs --coupled-excludes <id>`,
// so a test the scan allows to reach outside its module (modules/COUPLED-TESTS.json) is excluded from the
// per-package run instead of failing it, and an invalid or stale list refuses the part instead of running it.
const RECORDER = [
  "import { writeFileSync } from 'node:fs'",
  "const out = process.argv.find((a) => a.startsWith('--outputFile=')).slice('--outputFile='.length)",
  "writeFileSync('argv.json', JSON.stringify(process.argv.slice(2)))",
  "writeFileSync(out, JSON.stringify({ success: true, numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, numFailedTestSuites: 0, testResults: [] }))",
  '',
].join('\n')

test('each module run is handed its coupled-test excludes (--coupled-excludes <id>)', () => {
  const root = mkdtempSync(path.join(tmpdir(), 't205-unit-modules-coupled-'))
  try {
    put(root, 'services/alpha/thing.ts', 'export const thing = 1\n')
    put(root, 'modules/alpha/test/coupled.test.ts', "import { thing } from '../../../services/alpha/thing'\nexport const x = thing\n")
    put(root, 'modules/alpha/test/plain.test.ts', 'export const y = 1\n')
    put(root, 'modules/alpha/recorder.mjs', RECORDER)
    put(root, 'modules/alpha/package.json', JSON.stringify({ name: 'alpha', private: true, scripts: { test: 'node recorder.mjs' } }))
    put(
      root,
      'modules/COUPLED-TESTS.json',
      JSON.stringify({ comment: 'fixture', entries: [{ path: 'modules/alpha/test/coupled.test.ts', reason: 'reads a leaf tree', owner: 'TASK-205', allows: ['services/alpha'] }] }),
    )
    const r = runUnitSuite({ root, only: ['modules'] })
    assert.equal(r.unparseable, false, r.detail)
    assert.equal(r.collected, 1)
    const argv = JSON.parse(readFileSync(path.join(root, 'modules/alpha/argv.json'), 'utf8'))
    const i = argv.indexOf('--exclude')
    assert.ok(i !== -1, `the module run got no --exclude: ${argv.join(' ')}`)
    assert.equal(argv[i + 1], 'test/coupled.test.ts')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('RED: an absent COUPLED-TESTS.json refuses the module parts (never runs them unexcluded)', () => {
  const f = fixtureRoot({ withFailing: false, coupled: false })
  try {
    const r = runUnitSuite({ root: f.root, only: ['modules'] })
    assert.equal(r.unparseable, true)
    assert.match(r.detail, /coupled-excludes/)
  } finally {
    f.cleanup()
  }
})

test('the real tree: every module with a test script resolves its coupled excludes', () => {
  for (const id of moduleDirsWithTestScript(REPO_ROOT)) assert.ok(Array.isArray(coupledExcludes(REPO_ROOT, id)), id)
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

// TASK-205c (TASK-200 residual (a)): the `module-lane` part runs the disabled modules' app halves through
// gremion-ui/scripts/module-lane.mjs. The stand-in lane below takes the same argument shape as the real one
// (`-- <vitest flags>`) and writes its report where vitest would, so these prove the wiring by the report:
// a failing lane turns the part red, a green lane passes with its counts, and a lane that refuses (exit 1,
// no report: an empty selection) is unparseable, never a pass.
function laneRoot(body) {
  const root = mkdtempSync(path.join(tmpdir(), 't205c-unit-lane-'))
  put(root, 'gremion-ui/scripts/module-lane.mjs', body)
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

const LANE_REPORT = (failed) =>
  [
    "import { writeFileSync } from 'node:fs'",
    "const argv = process.argv.slice(2)",
    "if (argv[0] !== '--') process.exit(2) // the part hands the lane `--` first, then vitest's flags",
    "const out = argv.find((a) => a.startsWith('--outputFile=')).slice('--outputFile='.length)",
    `writeFileSync(out, JSON.stringify({ success: ${failed === 0}, numTotalTests: 4, numPassedTests: ${4 - failed}, numFailedTests: ${failed}, numPendingTests: 0, numTodoTests: 0, numFailedTestSuites: ${failed}, testResults: [] }))`,
    `process.exit(${failed === 0 ? 0 : 1})`,
    '',
  ].join('\n')

test('the module-lane part exists and the real lane script it runs is in the tree', () => {
  assert.equal(typeof UNIT_PARTS['module-lane'], 'function')
  assert.ok(readFileSync(path.join(REPO_ROOT, 'gremion-ui/scripts/module-lane.mjs'), 'utf8').includes('--modules'))
})

test('GREEN: a lane whose report is clean passes with its counts', () => {
  const f = laneRoot(LANE_REPORT(0))
  try {
    const r = runUnitSuite({ root: f.root, only: ['module-lane'] })
    assert.equal(r.unparseable, false, r.detail)
    assert.equal(r.collected, 4)
    assert.equal(r.failed, 0)
  } finally {
    f.cleanup()
  }
})

test('RED: a failing lane test turns the part red (counted from the report, not the exit code)', () => {
  const f = laneRoot(LANE_REPORT(2))
  try {
    const r = runUnitSuite({ root: f.root, only: ['module-lane'] })
    assert.equal(r.failed, 2)
    assert.equal(r.collected, 4)
  } finally {
    f.cleanup()
  }
})

test('RED: a lane that refuses (exit 1, no report) is unparseable, never a pass', () => {
  const f = laneRoot("console.error('[module-lane] refused: no disabled module with an app/ unit test')\nprocess.exit(1)\n")
  try {
    const r = runUnitSuite({ root: f.root, only: ['module-lane'] })
    assert.equal(r.unparseable, true)
    assert.match(r.detail, /no parseable JSON report/)
  } finally {
    f.cleanup()
  }
})
