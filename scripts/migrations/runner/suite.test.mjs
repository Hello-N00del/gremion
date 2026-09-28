// TASK-075 TDD 3: the expand-contract suite collects its canaries even with
// nothing to lint, and fails on a canary that stops failing, a
// chain-runners.json gap/extra/unknown class, an edited baseline entry, a
// re-hashed locked file, a missing phase marker and a missing manual-dump
// marker. Plus the wiring: verify registers it and requires it.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { loadRequiredSuites, SUITE_REGISTRY } from '../../verify/verify.mjs'
import { baselineDigest } from './baseline.mjs'
import { loadCanaries, runExpandContractSuite } from './suite.mjs'

const TMP_ROOT = process.env.GREMION_TEST_TMPDIR || tmpdir()
const roots = []
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

const LEGACY = 'CREATE TABLE a (id int);\n'
const sha = (s) => createHash('sha256').update(s).digest('hex')
const HEADERED = "-- gremion:phase expand\nSET LOCAL lock_timeout = '5s';\nCREATE TABLE b (id int);\n"

function fixture({ runners = { alpha: 'tenant-store', beta: 'unadopted' }, baseline = { alpha: { '001_a.sql': 'expand' } }, files = {} } = {}) {
  mkdirSync(TMP_ROOT, { recursive: true })
  const root = mkdtempSync(join(TMP_ROOT, 't075-suite-'))
  roots.push(root)
  const w = (rel, text) => {
    mkdirSync(join(root, rel, '..'), { recursive: true })
    writeFileSync(join(root, rel), text)
  }
  w('scripts/migrations/ranges.json', JSON.stringify({ chains: [{ id: 'alpha', dirs: ['db/alpha'] }, { id: 'beta', dirs: ['db/beta'] }], nonMigration: [] }))
  w('scripts/migrations/applied.lock.json', JSON.stringify({ chains: { alpha: { files: { '001_a.sql': sha(LEGACY) } }, beta: { files: {} } } }))
  w('scripts/migrations/runner/chain-runners.json', JSON.stringify({ chains: runners }))
  const b = { chains: baseline }
  w('scripts/migrations/runner/expand-contract-baseline.json', JSON.stringify(b))
  w('db/alpha/001_a.sql', LEGACY)
  mkdirSync(join(root, 'db', 'beta'), { recursive: true })
  for (const [rel, text] of Object.entries(files)) w(rel, text)
  return { root, pinnedDigest: baselineDigest(b) }
}

const run = (f, extra = {}) => runExpandContractSuite({ root: f.root, pinnedDigest: f.pinnedDigest, ...extra })

describe('expand-contract suite (TDD 3)', () => {
  test('zero linted files still collects every canary, and passes', () => {
    const r = run(fixture())
    const canaries = loadCanaries().length
    assert.equal(r.unparseable, false)
    assert.equal(r.failed, 0, r.detail)
    assert.equal(r.collected, 2 + canaries)
    assert.match(r.detail, /^linted 0 file\(s\) outside the baseline/)
  })

  test('a canary that stops failing fails the suite', () => {
    const r = run(fixture(), { canaries: [{ name: 'drop-that-passes', expect: 'drop', sql: HEADERED }] })
    assert.equal(r.failed, 1)
    assert.match(r.detail, /canary drop-that-passes stopped failing with drop \(got no problem at all\)/)
  })

  test('a pass canary that starts failing fails the suite', () => {
    const r = run(fixture(), { canaries: [{ name: 'ok', expect: null, sql: '-- gremion:phase expand\nDROP TABLE x;\n' }] })
    assert.equal(r.failed, 1)
    assert.match(r.detail, /canary ok should pass but fails with no-lock-timeout, drop/)
  })

  test('chain-runners.json: a gap, an extra chain and an unknown class each fail', () => {
    const gap = run(fixture({ runners: { alpha: 'tenant-store' } }))
    assert.match(gap.detail, /chain beta has no runner class \(gap\)/)
    const extra = run(fixture({ runners: { alpha: 'tenant-store', beta: 'unadopted', gamma: 'unadopted' } }))
    assert.match(extra.detail, /chain gamma is not in ranges\.json \(extra\)/)
    const unknown = run(fixture({ runners: { alpha: 'tenant-store', beta: 'boot' } }))
    assert.match(unknown.detail, /chain beta has unknown class "boot"/)
    for (const r of [gap, extra, unknown]) assert.equal(r.failed, 1)
  })

  test('an edited baseline entry fails against the pinned digest', () => {
    const f = fixture()
    const r = runExpandContractSuite({ root: f.root, pinnedDigest: baselineDigest({ chains: { alpha: { '001_a.sql': 'contract' } } }) })
    assert.equal(r.failed, 1)
    assert.match(r.detail, /is not the pinned .*written once and never edited/)
  })

  test('a locked baseline file that was re-hashed (e.g. a header added) is LOCKED_FILE_CHANGED', () => {
    const f = fixture({ files: { 'db/alpha/001_a.sql': `-- gremion:phase expand\n${LEGACY}` } })
    const r = run(f)
    assert.equal(r.failed, 1)
    assert.match(r.detail, /LOCKED_FILE_CHANGED db\/alpha\/001_a\.sql/)
  })

  test('an absent baseline is unparseable, never an empty map', () => {
    const f = fixture()
    rmSync(join(f.root, 'scripts', 'migrations', 'runner', 'expand-contract-baseline.json'))
    const r = run(f)
    assert.equal(r.unparseable, true)
    assert.match(r.detail, /cannot read its inputs/)
  })

  test('a new file without the phase marker fails naming file, statement and rule; with it, it passes', () => {
    const bad = run(fixture({ files: { 'db/alpha/002_b.sql': "SET LOCAL lock_timeout = '5s';\nCREATE TABLE b (id int);\n" } }))
    assert.equal(bad.failed, 1)
    assert.match(bad.detail, /db\/alpha\/002_b\.sql: statement 0: phase-header-missing/)
    const good = run(fixture({ files: { 'db/alpha/002_b.sql': HEADERED } }))
    assert.equal(good.failed, 0, good.detail)
    assert.match(good.detail, /^linted 1 file/)
  })

  test('a non-additive new file fails with file, statement number and rule', () => {
    const r = run(fixture({ files: { 'db/alpha/002_drop.sql': "-- gremion:phase expand\nSET LOCAL lock_timeout = '5s';\nALTER TABLE a DROP COLUMN id;\n" } }))
    assert.equal(r.failed, 1)
    assert.match(r.detail, /db\/alpha\/002_drop\.sql: statement 2: drop: ALTER TABLE a DROP COLUMN id/)
  })

  test('an unadopted chain needs the manual-dump marker on a new file', () => {
    const bad = run(fixture({ files: { 'db/beta/001_b.sql': HEADERED } }))
    assert.match(bad.detail, /db\/beta\/001_b\.sql: statement 0: manual-dump-marker-missing/)
    const good = run(fixture({ files: { 'db/beta/001_b.sql': HEADERED.replace('\n', '\n-- gremion:manual-dump runbook upgrade.md step 3\n') } }))
    assert.equal(good.failed, 0, good.detail)
  })
})

describe('wiring: verify runs the suite as required', () => {
  test('SUITE_REGISTRY has expand-contract and required-suites.txt names it', () => {
    assert.equal(typeof SUITE_REGISTRY['expand-contract'], 'function')
    assert.ok(loadRequiredSuites().includes('expand-contract'), 'required-suites.txt dropped expand-contract')
  })

  test('the real tree passes: every chain covered, the baseline intact, canaries behaving', () => {
    const r = runExpandContractSuite()
    assert.equal(r.unparseable, false, r.detail)
    assert.equal(r.failed, 0, r.detail)
    assert.ok(r.collected >= 2 + loadCanaries().length)
  })
})
