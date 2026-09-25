// TASK-045 (brief S6 items 1-3): end-to-end tests of verify.mjs's own
// runAll(), exercised through the real fixture suites in suites/fixtures.mjs
// (never mocked -- __fixture_vitest_allskip__ shells out to gremion-ui's
// actual installed vitest binary). These are reachable only through
// runAll()/`--only`; required-suites.txt never names a fixture, so a bare
// `pnpm verify` can never accidentally judge the real gate on a seeded-bad
// fixture (see verify.mjs's own SUITE_REGISTRY comment).
//
// RED evidence (brief S6 item 1, captured 2026-09-25 before this test file
// existed, in a scratch copy under
// C:/Users/PIXELL~1/AppData/Local/Temp/claude/p1w1-scratch/TASK-045/guard-efficacy/,
// never in this worktree): with lib/guard.mjs's zero-collected AND
// all-skipped checks both commented out, `runFixtureNodeZero()`'s raw output
// ({collected: 0, passed: 0, failed: 0, skipped: 0}) evaluated to
// {status: 'pass', reason: null} -- the exact "a seeded zero-test suite
// passes silently today" defect the acceptance criteria names. Restored
// immediately after capture; the scratch copy was deleted. See the commit
// message for the same transcript, plus the missing-tool and
// unparseable-output analogs.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runAll } from './verify.mjs'

test('the node-zero fixture: a suite with 0 top-level test() fails as "collected 0 tests" (item 1)', () => {
  const results = runAll(['__fixture_node_zero__'])
  assert.equal(results.__fixture_node_zero__.status, 'fail')
  assert.match(results.__fixture_node_zero__.reason, /collected 0 tests/)
})

test('the vitest-allskip fixture: a file whose only test is it.skip fails as all-skipped, despite vitest reporting success (item 1)', () => {
  const results = runAll(['__fixture_vitest_allskip__'])
  assert.equal(results.__fixture_vitest_allskip__.status, 'fail')
  assert.match(results.__fixture_vitest_allskip__.reason, /skipped/)
})

test('a missing tool exits non-zero naming the tool, not a skip (item 2)', () => {
  const results = runAll(['__fixture_missing_tool__'])
  assert.equal(results.__fixture_missing_tool__.status, 'fail')
  assert.match(results.__fixture_missing_tool__.reason, /missing tool: definitely-not-a-real-binary-xyz-task045/)
})

test('a required suite absent from the registry fails as its own line, never silently dropped (item 3)', () => {
  const results = runAll(['this-suite-does-not-exist-in-the-registry'])
  const r = results['this-suite-does-not-exist-in-the-registry']
  assert.equal(r.status, 'fail')
  assert.match(r.reason, /unparseable/)
})

test('verify.mjs carries no skip mechanism of any kind -- no VERIFY_SKIP env var, no --skip flag (item 3)', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('./verify.mjs', import.meta.url), 'utf8')
  // The source's own doc comment names both strings in prose ("no --skip
  // flag"), so this checks there is no CODE reference to either -- no
  // `process.env.VERIFY_SKIP...` read and no `argv[i] === '--skip'`-shaped
  // branch -- not merely that the substring never occurs at all.
  assert.doesNotMatch(src, /process\.env\.VERIFY_SKIP/)
  assert.doesNotMatch(src, /===\s*['"`]--skip/)
  // Behaviorally: parseArgs recognizes only --only; an unknown flag like
  // --skip is silently ignored rather than acted on.
  const { parseArgs } = await import('./verify.mjs')
  assert.deepEqual(parseArgs(['--skip', 'unit']), { only: null })
})

test('--only writes results that runAll can produce for a single suite, and parseArgs supports comma and repeated forms', async () => {
  const { parseArgs } = await import('./verify.mjs')
  assert.deepEqual(parseArgs(['--only', 'unit,integration']), { only: ['unit', 'integration'] })
  assert.deepEqual(parseArgs(['--only=carve-lint']), { only: ['carve-lint'] })
  assert.deepEqual(parseArgs([]), { only: null })
})
