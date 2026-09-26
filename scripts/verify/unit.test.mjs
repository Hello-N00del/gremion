// TASK-045: suites/unit.mjs tests that need a real subprocess (vitestSubcheck
// shells out to `pnpm run <testScript>`) rather than a mock -- mocking `run`
// would only prove the mock was called with the right args, not that a real
// dead-parameter regression (testScript accepted but never read) is caught.
import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { vitestSubcheck } from './suites/unit.mjs'

const FIXTURE_DIR = path.join(import.meta.dirname, '__fixtures__', 'vitest-script-wiring')

test('vitestSubcheck runs the package\'s OWN testScript, not a hard-coded "test:unit"', () => {
  // The fixture package.json defines "test:custom" -> fake-reporter.mjs
  // (writes a real report) and "test:unit" -> fail-if-called.mjs (exits 17,
  // writes nothing). Passing testScript: 'test:custom' must run the former;
  // if vitestSubcheck ever regresses to a hard-coded 'test:unit' or
  // 'vitest run', this runs fail-if-called.mjs instead and the result comes
  // back unparseable (no report file was ever written).
  const result = vitestSubcheck({ cwd: FIXTURE_DIR, testScript: 'test:custom' })
  assert.equal(result.unparseable, false, `expected the custom script's report to parse: ${JSON.stringify(result)}`)
  assert.equal(result.collected, 1)
  assert.equal(result.passed, 1)
  assert.equal(result.failed, 0)
})
