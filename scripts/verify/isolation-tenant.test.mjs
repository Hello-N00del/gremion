// Pilot wave 2, Task 1: the isolation evidence producer, suites/isolation-tenant.mjs
// and lib/isolation-evidence.mjs.
//
// The producer may write scripts/verify/out/isolation/<sha>.json ONLY when the
// `isolation:tenant` suite part passed on a clean tree at an unmoved HEAD, and
// the module enable gate reads that file as proof. So every way the part can be
// hollow is pinned here as "no file is written": a store that leaks, nothing
// collected, a skipped case, a declared module with no case, a dirty tree and a
// HEAD that moves during the run. The positive control (a clean store DOES
// write the file) sits beside them: a producer that never writes would make
// every "no file" assertion pass for the wrong reason.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { writeIsolationEvidence } from './lib/isolation-evidence.mjs'
import { runVitestJson } from './lib/vitest.mjs'
import {
  discardIsolationEvidence,
  ISOLATION_TENANT_MODULES,
  ISOLATION_TENANT_PART,
  isolationTenantCases,
  runIsolationTenantSuite,
  throwawayServerProblem,
} from './suites/isolation-tenant.mjs'
import { runAll, runVerify } from './verify.mjs'

const REPO_ROOT = path.join(import.meta.dirname, '..', '..')
const SHA = 'a'.repeat(40)
const OTHER_SHA = 'b'.repeat(40)
const PG_ENV = { ISOLATION_TENANT_PG_URL: 'postgres://postgres@127.0.0.1:55432/postgres' }
const NO_PREPARE = () => ({ ok: true, detail: '' })
const ZERO_SKIPS = { entries: [] }

const scratch = []
function tmp(prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  scratch.push(dir)
  return dir
}
process.on('exit', () => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
})

// ---- fakes -----------------------------------------------------------------

function fakeCase(module, extra = {}) {
  return {
    module,
    proofKind: 'fake-upstream-app',
    location: `fake/${module}.test.ts`,
    cwd: '.',
    cmd: 'fake',
    args: [],
    files: [`fake/${module}.test.ts`],
    needsPg: false,
    ...extra,
  }
}

const fakeCases = () => ISOLATION_TENANT_MODULES.map((m) => fakeCase(m))

/** A runVitest stand-in: a green part per module unless `overrides[module]` says otherwise. */
function fakeRunVitest(overrides = {}) {
  return (opts) => {
    const mod = path.basename(opts.keepReportAt, '.vitest.json')
    const o = overrides[mod] ?? {}
    mkdirSync(path.dirname(opts.keepReportAt), { recursive: true })
    writeFileSync(opts.keepReportAt, JSON.stringify({ module: mod, report: 'fake' }))
    return {
      label: opts.label,
      toolMissing: null,
      unparseable: false,
      collected: 3,
      passed: 3,
      failed: 0,
      skipped: 0,
      skipsByFile: {},
      collectedFiles: [`fake/${mod}.test.ts`],
      detail: '',
      reportFile: opts.keepReportAt,
      ...o,
    }
  }
}

function suite({ cases = fakeCases(), declaredModules = ISOLATION_TENANT_MODULES, overrides = {}, env = PG_ENV, runVitest } = {}) {
  return runIsolationTenantSuite({
    root: REPO_ROOT,
    cases,
    declaredModules,
    env,
    runVitest: runVitest ?? fakeRunVitest(overrides),
    prepare: NO_PREPARE,
    tmpRoot: tmp('iso-tenant-suite-'),
  })
}

/** Runs verify's own CLI with the given suite result; returns what it did. */
function verify(raw, { dirty = () => false, head = () => SHA, expectDiscard = true } = {}) {
  const outDir = tmp('iso-tenant-out-')
  const err = []
  const deps = {
    isDirtyFn: dirty,
    headShaFn: head,
    loadSkipsFn: () => ZERO_SKIPS,
    runAllFn: (names, o) => runAll(names, { ...o, registry: { [ISOLATION_TENANT_PART]: () => raw } }),
    writeRecordFn: () => ({ path: 'unused' }),
    writeEvidenceFn: (a) => writeIsolationEvidence({ ...a, outDir }),
    discardEvidenceFn: discardIsolationEvidence,
    log: () => {},
    error: (m) => err.push(m),
  }
  const code = runVerify(['--only', ISOLATION_TENANT_PART], deps)
  // verify removes the suite's temporary reports on every path that ran the suite (pass, fail, tree changed)
  if (expectDiscard) assert.ok(!raw.evidence?.reportsDir || !existsSync(raw.evidence.reportsDir), 'the kept vitest reports were left behind')
  else discardIsolationEvidence(raw.evidence)
  return { code, outDir, err: err.join('\n'), files: existsSync(outDir) ? readdirSync(outDir) : [] }
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

// ---- the positive control and the shape of what is written ------------------

test('a passing run writes <sha>.json stamped by verify, one result per declared module, each ref hashing its kept report', () => {
  const { code, outDir, files } = verify(suite())
  assert.equal(code, 0)
  assert.ok(files.includes(`${SHA}.json`), `no evidence file among ${files.join(', ')}`)
  const ev = JSON.parse(readFileSync(path.join(outDir, `${SHA}.json`), 'utf8'))
  assert.equal(ev.produced_by, 'verify')
  assert.equal(ev.tree_clean, true)
  assert.equal(ev.release_tip_sha, SHA)
  assert.equal(ev.verify_record.suite, ISOLATION_TENANT_PART)
  assert.equal(ev.verify_record.sha, SHA)
  assert.equal(ev.verify_record.failed, 0)
  assert.equal(ev.verify_record.passed, ev.verify_record.collected)
  assert.deepEqual(ev.results.map((r) => r.module).sort(), [...ISOLATION_TENANT_MODULES].sort())
  for (const r of ev.results) {
    assert.equal(r.test_kind, 'cross_customer')
    assert.equal(r.passed, true)
    assert.equal(r.release_tip_sha, SHA)
    assert.match(r.evidence_ref, /^sha256:[0-9a-f]{64} \S.{0,420}$/)
    const report = path.join(outDir, SHA, `${r.module}.vitest.json`)
    assert.ok(existsSync(report), `the kept report of ${r.module} is missing`)
    assert.equal(r.evidence_ref.slice('sha256:'.length, 'sha256:'.length + 64), sha256(report))
    assert.doesNotMatch(r.evidence_ref, /scratch-fixture:/)
  }
})

test('no module outside the pilot set ever gets a result (elections, finance, vault, handover)', () => {
  const { outDir } = verify(suite())
  const ev = JSON.parse(readFileSync(path.join(outDir, `${SHA}.json`), 'utf8'))
  for (const banned of ['elections', 'finance', 'vault', 'handover']) {
    assert.ok(!ev.results.some((r) => r.module === banned), `${banned} must have no result`)
  }
})

test('the board is one of seven proven modules, with a real-Postgres app case whose file exists', () => {
  assert.equal(ISOLATION_TENANT_MODULES.length, 7)
  assert.ok(ISOLATION_TENANT_MODULES.includes('board'))
  const cases = isolationTenantCases()
  assert.deepEqual(cases.map((c) => c.module).sort(), [...ISOLATION_TENANT_MODULES].sort())
  const board = cases.find((c) => c.module === 'board')
  assert.equal(board.proofKind, 'real-pg-app')
  assert.equal(board.needsPg, true)
  assert.equal(board.prepare, true)
  assert.equal(board.cwd, 'gremion-ui')
  assert.deepEqual(board.files, ['gremion-ui/src/lib/server/board/tenant-isolation.integration.test.ts'])
  // the integration config (the unit project excludes *.integration.test.ts), pointed at the file under its overlaid path
  assert.ok(board.args.includes('vitest.integration.config.ts'))
  assert.equal(board.args.at(-1), 'src/lib/server/board/tenant-isolation.integration.test.ts')
  // the overlay copies this source file there
  assert.ok(existsSync(path.join(REPO_ROOT, 'modules', 'board', 'app', 'lib', 'server', 'board', 'tenant-isolation.integration.test.ts')))
})

test('the board case runs with the harness environment derived from the throwaway server, over an ambient production stack', () => {
  const seen = {}
  const runVitest = (opts) => {
    seen[path.basename(opts.keepReportAt, '.vitest.json')] = opts
    return fakeRunVitest()(opts)
  }
  const raw = runIsolationTenantSuite({
    root: REPO_ROOT,
    cases: isolationTenantCases(),
    env: { ...PG_ENV, GREMION_PRODUCTION_STACK: 'a-production-stack' },
    runVitest,
    prepare: NO_PREPARE,
    tmpRoot: tmp('iso-tenant-suite-'),
  })
  discardIsolationEvidence(raw.evidence)
  const env = seen.board.env
  assert.equal(env.GREMION_PRODUCTION_STACK, 'none')
  assert.equal(env.ISOLATION_TENANT_PG_URL, PG_ENV.ISOLATION_TENANT_PG_URL)
  const fixtureDb = new URL(env.DATABASE_URL)
  const controlDb = new URL(env.CONTROL_DATABASE_URL)
  assert.equal(fixtureDb.port, '55432')
  assert.equal(fixtureDb.hostname, '127.0.0.1')
  assert.match(fixtureDb.pathname, /^\/board_iso_test_/)
  assert.match(controlDb.pathname, /^\/board_iso_test_/)
  assert.notEqual(fixtureDb.pathname, controlDb.pathname)
  // a leaf case is NOT given a production-stack statement
  assert.equal(seen.calendar.env.GREMION_PRODUCTION_STACK, 'a-production-stack')
})

test('the board case refuses a server that is not a throwaway one, and never starts vitest for it', () => {
  const started = []
  const run = (url) =>
    runIsolationTenantSuite({
      root: REPO_ROOT,
      cases: isolationTenantCases().filter((c) => c.module === 'board'),
      declaredModules: ['board'],
      env: { ISOLATION_TENANT_PG_URL: url },
      runVitest: (opts) => {
        started.push(opts.label)
        return fakeRunVitest()(opts)
      },
      prepare: NO_PREPARE,
      tmpRoot: tmp('iso-tenant-suite-'),
    })
  const live = run('postgres://postgres@127.0.0.1:5432/postgres')
  const remote = run('postgres://postgres@db.example.org:55432/postgres')
  assert.deepEqual(started, [])
  assert.match(live.detail, /5432/)
  assert.match(remote.detail, /loopback/)
  assert.notEqual(live.status, 'pass')
  assert.notEqual(remote.status, 'pass')
  discardIsolationEvidence(live.evidence)
  discardIsolationEvidence(remote.evidence)
  assert.equal(throwawayServerProblem('postgres://postgres@127.0.0.1:55432/postgres'), null)
  assert.equal(throwawayServerProblem('postgres://postgres@[::1]:55432/postgres'), null)
  assert.match(throwawayServerProblem('postgres://postgres@127.0.0.1/postgres'), /5432/)
  assert.match(throwawayServerProblem('not a url'), /not a URL/)
})

// ---- every hollow run writes no file ---------------------------------------

test('a fixture store that leaks (B readable as A) fails the part for real and writes no file; the clean twin writes one', () => {
  const fixture = (name, module) => ({
    module,
    proofKind: 'fake-upstream-app',
    location: `test/isolation/tenant/fixtures/${name}/cases/two-tenant.case.mjs`,
    cwd: 'modules/calendar',
    cmd: 'pnpm',
    args: ['exec', 'vitest', 'run', '--root', path.join(REPO_ROOT, 'test', 'isolation', 'tenant', 'fixtures', name), '--config', 'vitest.config.mjs'],
    files: [`test/isolation/tenant/fixtures/${name}/cases/two-tenant.case.mjs`],
    needsPg: false,
  })
  const declaredModules = ['calendar', 'content']
  const leaky = runIsolationTenantSuite({
    root: REPO_ROOT,
    cases: [fixture('leaky-store', 'calendar'), fixture('clean-store', 'content')],
    declaredModules,
    env: {},
    prepare: NO_PREPARE,
    tmpRoot: tmp('iso-tenant-suite-'),
  })
  const verdict = runAll([ISOLATION_TENANT_PART], { skipsData: ZERO_SKIPS, registry: { [ISOLATION_TENANT_PART]: () => leaky } })[ISOLATION_TENANT_PART]
  assert.equal(verdict.status, 'fail')
  assert.match(verdict.detail, /not readable as A/)
  const res = verify(leaky)
  assert.equal(res.code, 1)
  assert.deepEqual(res.files, [])

  const clean = runIsolationTenantSuite({
    root: REPO_ROOT,
    cases: [fixture('clean-store', 'calendar'), fixture('clean-store', 'content')],
    declaredModules,
    env: {},
    prepare: NO_PREPARE,
    tmpRoot: tmp('iso-tenant-suite-'),
  })
  const ok = verify(clean)
  assert.equal(ok.code, 0, ok.err)
  assert.ok(ok.files.includes(`${SHA}.json`))
})

test('a module whose cases collected nothing writes no file', () => {
  const res = verify(suite({ overrides: { files: { collected: 0, passed: 0, collectedFiles: ['fake/files.test.ts'] } } }))
  assert.equal(res.code, 1)
  assert.deepEqual(res.files, [])
})

test('one skipped case writes no file', () => {
  const res = verify(suite({ overrides: { votes: { collected: 3, passed: 2, skipped: 1 } } }))
  assert.equal(res.code, 1)
  assert.deepEqual(res.files, [])
})

test('a declared module without a case fails by name and writes no file', () => {
  const cases = fakeCases().filter((c) => c.module !== 'publishing')
  const raw = suite({ cases })
  assert.match(raw.detail, /publishing/)
  const res = verify(raw)
  assert.equal(res.code, 1)
  assert.deepEqual(res.files, [])
})

test('a case whose test file was not among the collected files fails (the pin) and writes no file', () => {
  const res = verify(suite({ overrides: { messaging: { collectedFiles: ['fake/somewhere-else.test.ts'] } } }))
  assert.equal(res.code, 1)
  assert.deepEqual(res.files, [])
})

test('a leaf case with no throwaway Postgres url fails instead of running against nothing', () => {
  const cases = ISOLATION_TENANT_MODULES.map((m) => fakeCase(m, m === 'calendar' ? { needsPg: true, pgEnv: ['CALENDAR_TEST_PG_URL'] } : {}))
  const raw = suite({ cases, env: {} })
  assert.match(raw.detail, /ISOLATION_TENANT_PG_URL/)
  const res = verify(raw)
  assert.equal(res.code, 1)
  assert.deepEqual(res.files, [])
})

test('a failing overlay preparation fails the part and writes no file', () => {
  const raw = runIsolationTenantSuite({
    root: REPO_ROOT,
    cases: fakeCases().map((c) => ({ ...c, prepare: true })),
    declaredModules: ISOLATION_TENANT_MODULES,
    env: PG_ENV,
    runVitest: fakeRunVitest(),
    prepare: () => ({ ok: false, detail: 'overlay exploded' }),
    tmpRoot: tmp('iso-tenant-suite-'),
  })
  assert.match(raw.detail, /overlay exploded/)
  const res = verify(raw)
  assert.equal(res.code, 1)
  assert.deepEqual(res.files, [])
})

test('a dirty tree refuses before anything runs and writes no file', () => {
  // refused before the suite runs: the suite() made here was never run by verify, the test removes its reports itself
  const res = verify(suite(), { dirty: () => true, expectDiscard: false })
  assert.equal(res.code, 1)
  assert.match(res.err, /refusing to run/)
  assert.deepEqual(res.files, [])
})

test('a HEAD that moves during the run writes no file', () => {
  let n = 0
  const res = verify(suite(), { head: () => (n++ === 0 ? SHA : OTHER_SHA) })
  assert.equal(res.code, 1)
  assert.match(res.err, /HEAD moved/)
  assert.deepEqual(res.files, [])
})

test('a tree that turns dirty during the run writes no file', () => {
  let n = 0
  const res = verify(suite(), { dirty: () => n++ > 0 })
  assert.equal(res.code, 1)
  assert.deepEqual(res.files, [])
})

// ---- the writer on its own (the verify wiring is not the only door) --------

function passingResult() {
  return suite()
}
const WRITE = { sha: SHA, startedAt: '2026-11-09T10:00:00.000Z', finishedAt: '2026-11-09T10:05:00.000Z', names: [ISOLATION_TENANT_PART] }

test('the writer refuses a run that is not exactly isolation:tenant alone', () => {
  const outDir = tmp('iso-tenant-out-')
  const result = { ...passingResult(), status: 'pass' }
  assert.throws(() => writeIsolationEvidence({ ...WRITE, names: [ISOLATION_TENANT_PART, 'unit'], result, outDir }), /exactly/)
  assert.throws(() => writeIsolationEvidence({ ...WRITE, names: ['unit'], result, outDir }), /exactly/)
  assert.deepEqual(existsSync(outDir) ? readdirSync(outDir) : [], [])
})

test('the writer refuses a failing verdict, a bad sha and any skipped case', () => {
  const outDir = tmp('iso-tenant-out-')
  const good = { ...passingResult(), status: 'pass' }
  assert.throws(() => writeIsolationEvidence({ ...WRITE, result: { ...good, status: 'fail' }, outDir }), /pass/)
  assert.throws(() => writeIsolationEvidence({ ...WRITE, sha: 'abc', result: good, outDir }), /sha/)
  const skipped = { ...good, evidence: { ...good.evidence, modules: good.evidence.modules.map((m, i) => (i === 0 ? { ...m, skipped: 1 } : m)) } }
  assert.throws(() => writeIsolationEvidence({ ...WRITE, result: skipped, outDir }), /skip/)
  assert.deepEqual(existsSync(outDir) ? readdirSync(outDir) : [], [])
})

test('the writer refuses a module set that is not exactly the declared one', () => {
  const outDir = tmp('iso-tenant-out-')
  const good = { ...passingResult(), status: 'pass' }
  const missing = { ...good, evidence: { ...good.evidence, modules: good.evidence.modules.slice(1) } }
  const extra = { ...good, evidence: { ...good.evidence, modules: [...good.evidence.modules, { ...good.evidence.modules[0], module: 'finance' }] } }
  assert.throws(() => writeIsolationEvidence({ ...WRITE, result: missing, outDir }), /module/)
  assert.throws(() => writeIsolationEvidence({ ...WRITE, result: extra, outDir }), /module/)
  assert.deepEqual(existsSync(outDir) ? readdirSync(outDir) : [], [])
})

test('the writer refuses a kept report that no longer hashes to its reference', () => {
  const outDir = tmp('iso-tenant-out-')
  const good = { ...passingResult(), status: 'pass' }
  writeFileSync(good.evidence.modules[0].reportPath, 'tampered after the run')
  assert.throws(() => writeIsolationEvidence({ ...WRITE, result: good, outDir }), /hash/)
  assert.deepEqual(existsSync(outDir) ? readdirSync(outDir) : [], [])
})

// ---- the host program and the case table name the same modules --------------

test('gremion-isolation records exactly the modules the producer proves', () => {
  const text = readFileSync(path.join(REPO_ROOT, 'infra', 'host', 'bin', 'gremion-isolation'), 'utf8')
  const m = /^PILOT_MODULES="([^"]+)"$/m.exec(text)
  assert.ok(m, 'gremion-isolation no longer declares PILOT_MODULES')
  assert.deepEqual(m[1].split(' ').sort(), [...ISOLATION_TENANT_MODULES].sort())
})

// ---- runVitestJson keeps the report only when asked ------------------------

const FAKE_VITEST = [
  "const fs = require('node:fs')",
  "const arg = process.argv.find((a) => a.startsWith('--outputFile='))",
  "fs.writeFileSync(arg.slice('--outputFile='.length), JSON.stringify({ numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, numFailedTestSuites: 0, testResults: [] }))",
].join('\n')

test('runVitestJson copies the report to keepReportAt when given, and leaves nothing behind when not', () => {
  const dir = tmp('iso-tenant-vitest-')
  const script = path.join(dir, 'fake-vitest.cjs')
  writeFileSync(script, FAKE_VITEST)
  const kept = path.join(dir, 'kept', 'report.json')
  const withKeep = runVitestJson({ label: 'k', cwd: dir, cmd: process.execPath, args: [script], root: dir, keepReportAt: kept })
  assert.equal(withKeep.collected, 1)
  assert.equal(withKeep.reportFile, kept)
  assert.equal(JSON.parse(readFileSync(kept, 'utf8')).numTotalTests, 1)
  const without = runVitestJson({ label: 'n', cwd: dir, cmd: process.execPath, args: [script], root: dir })
  assert.equal(without.collected, 1)
  assert.equal(without.reportFile, undefined)
  assert.deepEqual(readdirSync(dir).sort(), ['fake-vitest.cjs', 'kept'])
})
