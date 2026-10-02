// TASK-039 TDD 18: the `observability` suite is required, registered, collects
// more than zero tests on the real tree, and fails closed: the registry line
// removed is a FAIL by name, zero test files is a FAIL, docker missing is
// toolMissing (never a skip).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

import { evaluateSuite } from '../lib/guard.mjs'
import { REPO_ROOT } from '../lib/vitest.mjs'
import { loadRequiredSuites, runAll, SUITE_REGISTRY } from '../verify.mjs'
import { observabilityTestFiles, runObservabilitySuite } from './observability.mjs'

test('observability is a required suite with a registry runner', () => {
  assert.ok(loadRequiredSuites().includes('observability'), 'required-suites.txt dropped "observability"')
  assert.equal(typeof SUITE_REGISTRY.observability, 'function')
})

test('the suite reads every compose/observability/*.test.mjs, five or more', () => {
  const files = observabilityTestFiles()
  assert.ok(files.length >= 5, files.join(', '))
  for (const f of files) assert.match(f.split(path.sep).join('/'), /^compose\/observability\/[a-z0-9-]+\.test\.mjs$/)
})

test('the real suite collects more than zero tests and passes', () => {
  const r = runObservabilitySuite({ root: REPO_ROOT })
  assert.equal(r.toolMissing, null, r.detail)
  assert.equal(r.unparseable, false, r.detail)
  assert.ok(r.collected > 20, `collected ${r.collected}`)
  assert.equal(r.failed, 0, r.detail)
})

test('RED: the registry line removed is a FAIL naming the suite; zero files and no docker fail closed', () => {
  const { observability, ...without } = SUITE_REGISTRY
  assert.equal(typeof observability, 'function')
  const res = runAll(['observability'], { registry: without, skipsData: null })
  assert.equal(res.observability.status, 'fail')
  assert.match(res.observability.detail, /no such suite in the registry/)
  // no test files found: one empty part, judged FAIL by name
  const empty = runObservabilitySuite({ root: path.join(REPO_ROOT, 'test/host/fixtures/observability'), toolAvailableFn: () => true })
  assert.equal(evaluateSuite(empty).status, 'fail')
  const noDocker = runObservabilitySuite({ toolAvailableFn: () => false })
  assert.equal(noDocker.toolMissing, 'docker')
  assert.match(evaluateSuite(noDocker).reason, /missing tool: docker/)
})
