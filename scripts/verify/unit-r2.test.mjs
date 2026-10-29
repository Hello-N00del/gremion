// TASK-045 round 2: suites/unit.mjs sub-checks against real subprocesses.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { combineParts, evaluateSuite } from './lib/guard.mjs'
import { batsWindowsTags, nodeTestParts, vitestSubcheck } from './suites/unit.mjs'

const WIRING = path.join(import.meta.dirname, '__fixtures__', 'vitest-script-wiring')
const FIXTURES = path.join(import.meta.dirname, '__fixtures__')

test('vitestSubcheck does not trust an all-green report when the test command itself exited non-zero', () => {
  const r = vitestSubcheck({ cwd: WIRING, testScript: 'test:green-exit1' })
  assert.equal(r.unparseable, true, JSON.stringify(r))
  assert.match(r.detail, /exited 1/)
})

test('vitestSubcheck attributes skips to repo-relative files so the per-file allow-list can match them', () => {
  const root = path.join(import.meta.dirname, '..', '..')
  const r = vitestSubcheck({ cwd: WIRING, testScript: 'test:skips', root })
  assert.equal(r.unparseable, false, JSON.stringify(r))
  assert.deepEqual(r.skipsByFile, { 'scripts/verify/__fixtures__/vitest-script-wiring/skipped.fixture.test.ts': 1 })
})

test('nodeTestParts reports a file with zero declared tests as an EMPTY part, which fails the suite by name', () => {
  const parts = nodeTestParts({ cwd: FIXTURES, files: ['node-zero/zero.test.mjs'] })
  const verdict = evaluateSuite(combineParts(parts))
  assert.equal(verdict.status, 'fail')
  assert.match(verdict.reason, /collected 0 tests in: node --test node-zero\/zero\.test\.mjs/)
})

// A skip in a node --test file used to come back unattributed, so lib/skips.mjs
// booked it under a key no allowed-skips.json entry can match: listing a file
// there could never take effect for unit:node. One process runs per file, so the
// skips are that file's own.
test('nodeTestParts attributes the skips of a file to that file, so the per-file allow-list can match them', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'node-skip-'))
  try {
    writeFileSync(
      path.join(dir, 'one-skip.test.mjs'),
      ["import test from 'node:test'", "test('runs', () => {})", "test('does not run here', { skip: 'fixture' }, () => {})", ''].join(String.fromCharCode(10)),
    )
    const parts = nodeTestParts({ cwd: dir, files: ['one-skip.test.mjs'] })
    assert.equal(parts.length, 1)
    assert.deepEqual(
      { collected: parts[0].collected, skipped: parts[0].skipped, skipsByFile: parts[0].skipsByFile },
      { collected: 2, skipped: 1, skipsByFile: { 'one-skip.test.mjs': 1 } },
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('nodeTestParts with no files at all is one empty part, never nothing', () => {
  const parts = nodeTestParts({ cwd: FIXTURES, files: [] })
  assert.equal(evaluateSuite(combineParts(parts)).status, 'fail')
})

// Round 2 LOW: batsPartWindows used to build fixed ":local" tags a second
// worktree, or a second concurrent verify run, could clobber mid-build.
const REPO_ROOT = path.join(import.meta.dirname, '..', '..')

test('batsWindowsTags is unique per run (pid), never the old shared ":local" tag', () => {
  const a = batsWindowsTags(REPO_ROOT, 11111)
  const b = batsWindowsTags(REPO_ROOT, 22222)
  assert.notEqual(a.runnerTag, b.runnerTag)
  assert.notEqual(a.pyTag, b.pyTag)
  assert.doesNotMatch(a.runnerTag, /^gremion-bats:local$/)
  assert.doesNotMatch(a.pyTag, /^gremion-bats-py:local$/)
  assert.match(a.runnerTag, /^gremion-bats:verify-[0-9a-f]{8}-11111$/)
  assert.match(a.pyTag, /^gremion-bats-py:verify-[0-9a-f]{8}-11111$/)
})
