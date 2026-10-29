// Phase 1.1: combine-records.mjs. The pure combine() takes record text so most
// of these never touch a disk; the CLI cases use a scratch dir and never the
// real scripts/verify/out/.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { checkRecord } from './check-record.mjs'
import { CombineError, COMPOSITES, combine, parseArgs, UsageError } from './combine-records.mjs'
import { INTEGRATION_PARTS } from './suites/integration.mjs'
import { UNIT_PARTS } from './suites/unit.mjs'
import { loadRequiredSuites } from './verify.mjs'

const SHA = 'a'.repeat(40)
const OTHER_SHA = 'b'.repeat(40)
const CLI = path.join(import.meta.dirname, 'combine-records.mjs')

const suite = (status = 'pass', over = {}) => ({
  status,
  reason: status === 'pass' ? null : 'boom',
  collected: 10,
  passed: 10,
  failed: 0,
  skipped: 0,
  detail: '',
  durationMs: 100,
  ...over,
})

function record(suites, over = {}) {
  return {
    schemaVersion: 1,
    sha: SHA,
    only: Object.keys(suites).join(','),
    partial: true,
    startedAt: '2026-01-01T00:00:10.000Z',
    finishedAt: '2026-01-01T00:00:20.000Z',
    deferred: ['note'],
    suites,
    ok: true,
    ...over,
  }
}
const input = (file, rec) => ({ file, raw: typeof rec === 'string' ? rec : JSON.stringify(rec) })
const unitParts = (status = 'pass') => Object.fromEntries(Object.keys(UNIT_PARTS).map((p) => [`unit:${p}`, suite(status)]))
const integrationParts = () => Object.fromEntries(Object.keys(INTEGRATION_PARTS).map((p) => [`integration:${p}`, suite()]))

test('happy path: legs merge into one non-partial record with provenance, min/max times and the deferred union', () => {
  const a = record({ typecheck: suite() }, { only: 'typecheck', startedAt: '2026-01-01T00:00:05.000Z', finishedAt: '2026-01-01T00:00:15.000Z', deferred: ['x'] })
  const b = record({ census: suite() }, { only: 'census', startedAt: '2026-01-01T00:00:10.000Z', finishedAt: '2026-01-01T00:00:40.000Z', deferred: ['x', 'y'] })
  const out = combine([input('record-a/1.json', a), input('record-b/2.json', b)], SHA)
  assert.equal(out.only, null)
  assert.equal(out.partial, false)
  assert.equal(out.sha, SHA)
  assert.equal(out.schemaVersion, 1)
  assert.deepEqual(Object.keys(out.suites), ['typecheck', 'census'])
  assert.equal(out.startedAt, '2026-01-01T00:00:05.000Z')
  assert.equal(out.finishedAt, '2026-01-01T00:00:40.000Z')
  assert.deepEqual(out.deferred, ['x', 'y'])
  assert.deepEqual(out.combinedFrom, [
    { file: 'record-a/1.json', only: 'typecheck' },
    { file: 'record-b/2.json', only: 'census' },
  ])
  assert.equal(out.ok, true)
})

test('ok is recomputed from the suites: a failing suite makes it false, and combine still returns (judging is check-record\'s job)', () => {
  const out = combine([input('a.json', record({ typecheck: suite(), census: suite('fail') }))], SHA)
  assert.equal(out.ok, false)
})

test('a record for another sha is refused, naming the file (stale artifact)', () => {
  assert.throws(
    () => combine([input('ok.json', record({ typecheck: suite() })), input('stale/x.json', record({ census: suite() }, { sha: OTHER_SHA }))], SHA),
    (e) => e instanceof CombineError && /stale\/x\.json/.test(e.message) && /stale artifact/.test(e.message),
  )
})

test('a record whose sha is not 40-hex is refused', () => {
  assert.throws(
    () => combine([input('x.json', record({ typecheck: suite() }, { sha: 'deadbeef' }))], SHA),
    (e) => /x\.json/.test(e.message) && /40-hex/.test(e.message),
  )
})

test('malformed json is refused, naming the file', () => {
  assert.throws(() => combine([input('bad/y.json', '{ not json')], SHA), (e) => e instanceof CombineError && /bad\/y\.json: not valid JSON/.test(e.message))
})

test('wrong schemaVersion, a non-object record and a missing suites object are each refused', () => {
  assert.throws(() => combine([input('v.json', record({ typecheck: suite() }, { schemaVersion: 2 }))], SHA), /v\.json: schemaVersion/)
  assert.throws(() => combine([input('arr.json', '[]')], SHA), /arr\.json: not a record object/)
  assert.throws(() => combine([input('s.json', { schemaVersion: 1, sha: SHA })], SHA), /s\.json: no "suites" object/)
  assert.throws(() => combine([input('s2.json', { schemaVersion: 1, sha: SHA, suites: [] })], SHA), /s2\.json: no "suites" object/)
})

test('a suite reported by two records is refused, naming both files (no silent overwrite)', () => {
  assert.throws(
    () => combine([input('one.json', record({ census: suite() })), input('two.json', record({ census: suite('fail') }))], SHA),
    (e) => e instanceof CombineError && /"census"/.test(e.message) && /one\.json/.test(e.message) && /two\.json/.test(e.message),
  )
})

test('zero records is a failure, not an empty pass', () => {
  assert.throws(() => combine([], SHA), (e) => e instanceof CombineError && /no record files/.test(e.message))
})

test('unit is synthesised from the parts and passes only when every UNIT_PARTS key is present and green', () => {
  const out = combine([input('u.json', record(unitParts()))], SHA)
  assert.equal(out.suites.unit.status, 'pass')
  assert.equal(out.suites.unit.collected, 10 * Object.keys(UNIT_PARTS).length)
  assert.equal(out.suites.unit.durationMs, 100 * Object.keys(UNIT_PARTS).length)
  // every part key is kept next to the synthesised whole
  for (const p of Object.keys(UNIT_PARTS)) assert.ok(`unit:${p}` in out.suites)
})

test('a missing unit part makes unit fail, and the reason names the missing part', () => {
  const parts = unitParts()
  delete parts['unit:ports']
  delete parts['unit:bats']
  const out = combine([input('u.json', record(parts))], SHA)
  assert.equal(out.suites.unit.status, 'fail')
  assert.match(out.suites.unit.reason, /missing part\(s\): ports, bats/)
  assert.equal(out.ok, false)
})

test('a failing unit part makes unit fail, and the reason names that part and its reason', () => {
  const parts = unitParts()
  parts['unit:tokens'] = suite('fail', { reason: 'collected 0 tests' })
  const out = combine([input('u.json', record(parts))], SHA)
  assert.equal(out.suites.unit.status, 'fail')
  assert.match(out.suites.unit.reason, /failing part\(s\): tokens \(fail: collected 0 tests\)/)
})

test('integration is synthesised the same way, from the real INTEGRATION_PARTS keys', () => {
  const ok = combine([input('i.json', record(integrationParts()))], SHA)
  assert.equal(ok.suites.integration.status, 'pass')
  const parts = integrationParts()
  delete parts['integration:nats-auth']
  const bad = combine([input('i.json', record(parts))], SHA)
  assert.equal(bad.suites.integration.status, 'fail')
  assert.match(bad.suites.integration.reason, /missing part\(s\): nats-auth/)
})

test('parts spread over several records (the real leg layout) still synthesise one unit', () => {
  const entries = Object.entries(unitParts())
  const half = Math.floor(entries.length / 2)
  const out = combine(
    [input('record-a/a.json', record(Object.fromEntries(entries.slice(0, half)))), input('record-b/b.json', record(Object.fromEntries(entries.slice(half))))],
    SHA,
  )
  assert.equal(out.suites.unit.status, 'pass')
})

test('composites come only from the real registries: a made-up part key does not stand in for a real one', () => {
  assert.deepEqual(COMPOSITES.unit, Object.keys(UNIT_PARTS))
  assert.deepEqual(COMPOSITES.integration, Object.keys(INTEGRATION_PARTS))
  const parts = unitParts()
  delete parts['unit:ui']
  parts['unit:not-a-real-part'] = suite()
  const out = combine([input('u.json', record(parts))], SHA)
  assert.equal(out.suites.unit.status, 'fail')
  assert.match(out.suites.unit.reason, /missing part\(s\): ui\b/)
})

test('a whole unit next to unit:* keys is ambiguous: refused, both in one record and across records', () => {
  assert.throws(
    () => combine([input('both.json', record({ unit: suite(), 'unit:ui': suite() }))], SHA),
    (e) => e instanceof CombineError && /ambiguous/.test(e.message),
  )
  assert.throws(() => combine([input('w.json', record({ unit: suite() })), input('p.json', record({ 'unit:ui': suite() }))], SHA), /ambiguous/)
})

test('a whole unit with no unit:* keys passes through untouched', () => {
  const out = combine([input('w.json', record({ unit: suite() }))], SHA)
  assert.equal(out.suites.unit.status, 'pass')
  assert.equal(out.suites.unit.collected, 10)
})

test('parseArgs: the three flags, the = form, and every unknown or incomplete argument is a usage error', () => {
  assert.deepEqual(parseArgs(['--in-dir', 'd', '--sha', SHA, '--out', 'o.json']), { inDir: 'd', sha: SHA, out: 'o.json' })
  assert.deepEqual(parseArgs(['--in-dir=d']), { inDir: 'd', sha: null, out: null })
  assert.throws(() => parseArgs([]), UsageError)
  assert.throws(() => parseArgs(['--in-dir']), UsageError)
  assert.throws(() => parseArgs(['--in-dir', '--sha']), UsageError)
  assert.throws(() => parseArgs(['--in-dir', 'd', '--bogus']), (e) => e instanceof UsageError && /unknown argument: --bogus/.test(e.message))
  assert.throws(() => parseArgs(['--in-dir', 'd', 'positional']), UsageError)
  assert.throws(() => parseArgs(['--in-dir', 'd', '--sha', 'deadbeef']), UsageError)
})

function scratch() {
  return mkdtempSync(path.join(tmpdir(), 'combine-records-test-'))
}
const writeJson = (file, value) => {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), 'utf8')
}
const cli = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' })

test('CLI: reads nested artifact subdirectories, writes writeRecord\'s format, prints one line per suite, exits 0 even with a failing suite', () => {
  const dir = scratch()
  try {
    writeJson(path.join(dir, 'in', 'record-static', 'x.json'), record({ typecheck: suite() }, { only: 'typecheck' }))
    writeJson(path.join(dir, 'in', 'record-deep', 'a', 'b', 'y.json'), record({ census: suite('fail') }, { only: 'census' }))
    writeJson(path.join(dir, 'in', 'record-deep', 'notes.txt'), 'ignored')
    const out = path.join(dir, 'out', 'combined.json')
    const res = cli(['--in-dir', path.join(dir, 'in'), '--sha', SHA, '--out', out])
    assert.equal(res.status, 0, res.stderr)
    assert.match(res.stdout, /PASS typecheck/)
    assert.match(res.stdout, /FAIL census -- boom/)
    const text = readFileSync(out, 'utf8')
    assert.ok(text.endsWith('}\n'), 'trailing newline like writeRecord')
    assert.equal(text, `${JSON.stringify(JSON.parse(text), null, 2)}\n`)
    const parsed = JSON.parse(text)
    assert.equal(parsed.partial, false)
    assert.deepEqual(parsed.combinedFrom.map((c) => c.file).sort(), ['record-deep/a/b/y.json', 'record-static/x.json'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CLI: a previous combined output inside --in-dir is not read back in as an input', () => {
  const dir = scratch()
  try {
    writeJson(path.join(dir, 'x.json'), record({ typecheck: suite() }))
    const out = path.join(dir, 'combined.json')
    assert.equal(cli(['--in-dir', dir, '--sha', SHA, '--out', out]).status, 0)
    assert.equal(cli(['--in-dir', dir, '--sha', SHA, '--out', out]).status, 0, 'a second run must not see its own output as a duplicate')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CLI: zero files, a sha mismatch, malformed json and a duplicate suite each exit 1 and write nothing', () => {
  const cases = {
    'zero files': () => {},
    'sha mismatch': (d) => writeJson(path.join(d, 'a.json'), record({ typecheck: suite() }, { sha: OTHER_SHA })),
    'malformed json': (d) => writeJson(path.join(d, 'a.json'), '{ nope'),
    'duplicate suite': (d) => {
      writeJson(path.join(d, 'a.json'), record({ typecheck: suite() }))
      writeJson(path.join(d, 'sub', 'b.json'), record({ typecheck: suite() }))
    },
  }
  for (const [label, setup] of Object.entries(cases)) {
    const dir = scratch()
    try {
      const inDir = path.join(dir, 'in')
      mkdirSync(inDir)
      setup(inDir)
      const out = path.join(dir, 'combined.json')
      const res = cli(['--in-dir', inDir, '--sha', SHA, '--out', out])
      assert.equal(res.status, 1, `${label}: ${res.stdout}${res.stderr}`)
      assert.match(res.stderr, /\[combine-records\] FAIL/, label)
      assert.throws(() => readFileSync(out), /ENOENT/, `${label}: no output may be written`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

test('CLI: an unknown flag and a missing --in-dir are usage errors (exit 1)', () => {
  const unknown = cli(['--in-dir', tmpdir(), '--skip', 'unit'])
  assert.equal(unknown.status, 1)
  assert.match(unknown.stderr, /usage error: unknown argument: --skip/)
  const missing = cli([])
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /--in-dir/)
})

test('end to end: a combined record of every required suite passes checkRecord, and dropping one leg fails it by name', () => {
  const required = loadRequiredSuites()
  const legs = { ...unitParts(), ...integrationParts() }
  for (const name of required) if (name !== 'unit' && name !== 'integration') legs[name] = suite()
  const full = combine([input('a.json', record(legs))], SHA)
  const ok = checkRecord(SHA, { readRecordFn: () => full, requiredSuites: required })
  assert.equal(ok.ok, true, ok.reason)

  const noCensus = { ...legs }
  delete noCensus.census
  const partialRun = combine([input('a.json', record(noCensus))], SHA)
  const strict = checkRecord(SHA, { readRecordFn: () => partialRun, requiredSuites: required })
  assert.equal(strict.ok, false)
  assert.match(strict.reason, /missing required suite\(s\): census/)
  const lenient = checkRecord(SHA, { readRecordFn: () => partialRun, requiredSuites: required, allowMissing: ['census'] })
  assert.equal(lenient.ok, true, lenient.reason)
})
