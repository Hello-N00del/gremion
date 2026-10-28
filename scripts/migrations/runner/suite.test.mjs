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
import { baselineDigest, PINNED_FILE, renderPinned } from './baseline.mjs'
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
  const lock = { chains: { alpha: { files: { '001_a.sql': sha(LEGACY) } }, beta: { files: {} } } }
  w('scripts/migrations/applied.lock.json', JSON.stringify(lock))
  w('scripts/migrations/runner/chain-runners.json', JSON.stringify({ chains: runners }))
  const b = { chains: baseline }
  w('scripts/migrations/runner/expand-contract-baseline.json', JSON.stringify(b))
  w(PINNED_FILE, renderPinned(b, lock))
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
    // chain-runners.json + the baseline + its packaged copy + the waivers + the required-canary set + each canary
    assert.equal(r.collected, 5 + canaries)
    assert.match(r.detail, /^linted 0 file\(s\) outside the baseline/)
  })

  test('a required canary deleted from canaries.json fails the suite (guard drill, R28)', () => {
    const f = fixture()
    const kept = loadCanaries().filter((c) => c.name !== 'expand-drop-column')
    const dir = join(f.root, 'canaries')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'canaries.json'), JSON.stringify({ canaries: kept }))
    const r = run(f, { canariesPath: join(dir, 'canaries.json') })
    assert.equal(r.failed, 1, r.detail)
    assert.match(r.detail, /fixtures\/canaries\.json: required canary expand-drop-column is missing/)
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

  // TASK-075 r2: the tenant-create image phases its files from the copy that
  // ships in packages/tenant-store; it must never drift from the two files.
  test('the packaged baseline copy: drifted or absent fails naming the regeneration command', () => {
    const drifted = fixture()
    writeFileSync(join(drifted.root, PINNED_FILE), renderPinned({ chains: { alpha: { '001_a.sql': 'contract' } } }, { chains: { alpha: { files: { '001_a.sql': sha(LEGACY) } } } }))
    const r = run(drifted)
    assert.equal(r.failed, 1, r.detail)
    assert.match(r.detail, /packages\/tenant-store\/src\/phase-baseline\.ts: differs from its rendering .*--write-pinned/)
    const absent = fixture()
    rmSync(join(absent.root, PINNED_FILE))
    const a = run(absent)
    assert.equal(a.failed, 1, a.detail)
    assert.match(a.detail, /phase-baseline\.ts: is absent/)
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

  // Waivers (lint-waivers.json): sha256-pinned, rule-bounded, stale-checked.
  describe('lint waivers', () => {
    const BAD = '-- gremion:phase expand\nCREATE TABLE c (id int);\nREVOKE ALL ON TABLE c FROM PUBLIC;\n'
    const REASON = 'a reason that is long enough to be a real justification for the waiver'
    function waived({ text = BAD, waiver = {}, locked = true } = {}) {
      const f = fixture({ files: { 'db/alpha/002_c.sql': text } })
      const lockPath = join(f.root, 'scripts', 'migrations', 'applied.lock.json')
      if (locked) writeFileSync(lockPath, JSON.stringify({ chains: { alpha: { files: { '001_a.sql': sha(LEGACY), '002_c.sql': sha(text) } }, beta: { files: {} } } }))
      const w = { chain: 'alpha', file: '002_c.sql', sha256: sha(text), rules: ['no-lock-timeout', 'revoke'], reason: REASON, ...waiver }
      writeFileSync(join(f.root, 'scripts', 'migrations', 'runner', 'lint-waivers.json'), JSON.stringify({ waivers: [w] }))
      return f
    }
    test('without a waiver the file fails; with a matching one it passes', () => {
      const none = run(fixture({ files: { 'db/alpha/002_c.sql': BAD } }))
      assert.match(none.detail, /002_c\.sql: statement \d+: revoke/)
      assert.match(none.detail, /no-lock-timeout/)
      const ok = run(waived())
      assert.equal(ok.failed, 0, ok.detail)
    })
    test('a waiver does not cover other rules in the same file', () => {
      const r = run(waived({ text: BAD + 'DROP TABLE c;\n' }))
      assert.match(r.detail, /statement 3: drop/)
    })
    test('a stale waiver (rule no longer fires) fails', () => {
      const r = run(waived({ waiver: { rules: ['no-lock-timeout', 'revoke', 'or-replace'] } }))
      assert.match(r.detail, /waives or-replace but the file no longer trips it/)
    })
    test('an edited file voids the waiver', () => {
      const f = waived()
      writeFileSync(join(f.root, 'db', 'alpha', '002_c.sql'), BAD + '-- edited\n')
      assert.match(run(f).detail, /no longer hash to the lock/)
    })
    test('an unlocked file, a wrong sha, a short reason and an unwaivable rule are each refused', () => {
      assert.match(run(waived({ locked: false })).detail, /not in applied\.lock\.json: only a locked file/)
      assert.match(run(waived({ waiver: { sha256: 'x' } })).detail, /sha256 is not the one applied\.lock\.json pins/)
      assert.match(run(waived({ waiver: { reason: 'short' } })).detail, /reason of at least 40/)
      assert.match(run(waived({ waiver: { rules: ['phase-header-missing'] } })).detail, /rules must be a non-empty subset/)
    })
  })
})

describe('wiring: verify runs the suite as required', () => {
  test('SUITE_REGISTRY has expand-contract and required-suites.txt names it', () => {
    assert.equal(typeof SUITE_REGISTRY['expand-contract'], 'function')
    assert.ok(loadRequiredSuites().includes('expand-contract'), 'required-suites.txt dropped expand-contract')
  })

  // verify must load from a copy of scripts/verify alone (its space-path CLI
  // tests copy only that directory): the suite runs as its own process
  // (suite-cli.mjs), never through a static import out of scripts/verify.
  test('the registry entry runs the suite through suite-cli.mjs and judges its result line', () => {
    const r = SUITE_REGISTRY['expand-contract']()
    assert.equal(r.unparseable, false, r.detail)
    assert.equal(r.failed, 0, r.detail)
    assert.ok(r.collected >= 2 + loadCanaries().length, `collected ${r.collected}`)
  })

  test('the real tree passes: every chain covered, the baseline intact, canaries behaving', () => {
    const r = runExpandContractSuite()
    assert.equal(r.unparseable, false, r.detail)
    assert.equal(r.failed, 0, r.detail)
    assert.ok(r.collected >= 2 + loadCanaries().length)
  })
})
