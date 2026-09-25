// TASK-045 round 2: suites/unit.mjs sub-checks against real subprocesses.
import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { combineParts, evaluateSuite } from './lib/guard.mjs'
import { nodeTestParts, vitestSubcheck } from './suites/unit.mjs'

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

test('nodeTestParts with no files at all is one empty part, never nothing', () => {
  const parts = nodeTestParts({ cwd: FIXTURES, files: [] })
  assert.equal(evaluateSuite(combineParts(parts)).status, 'fail')
})
