// TASK-053 (G-053-wiring): the render guards must actually run. meta.test.mjs
// pins only TASK-045's own suites (and isolation); per the census precedent,
// this file pins `render-guards` -- both halves, because dropping either the
// required-suites.txt line or the SUITE_REGISTRY entry is exactly the shape
// that silently removes a guard (a dropped registry entry fails runAll by
// name, but a dropped required-suites.txt line is just a shorter run).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadRequiredSuites, SUITE_REGISTRY } from '../verify.mjs'
import { runRenderGuardsSuite } from './suite.mjs'

test('required-suites.txt names render-guards', () => {
  assert.ok(loadRequiredSuites().includes('render-guards'), 'required-suites.txt dropped "render-guards"')
})

test('SUITE_REGISTRY["render-guards"] is a synchronous runner', () => {
  const runner = SUITE_REGISTRY['render-guards']
  assert.equal(typeof runner, 'function', 'SUITE_REGISTRY has no runner for "render-guards"')
  assert.notEqual(runner.constructor.name, 'AsyncFunction', 'runAll() does not await its runners')
})

test('the render-guards runner is runRenderGuardsSuite, not a stand-in', () => {
  const runner = SUITE_REGISTRY['render-guards']
  assert.ok(runner === runRenderGuardsSuite || /runRenderGuardsSuite\(/.test(String(runner)))
})
