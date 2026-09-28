// TASK-053: the boundary-lint verify suite judges the scanned count, not the
// exit code. Every case injects the process result; the real CLI runs only in
// suite.mjs itself (and in gremion-ui's boundary-lint-vacuity.test.ts).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { evaluateSuite } from '../lib/guard.mjs'
import { BOUNDARY_LINT_ARGS, judgeBoundaryLint, MIN_FILES, runBoundaryLintSuite } from './suite.mjs'

const res = (code, stdout = '', stderr = '') => ({ code, stdout, stderr, error: null })
const always = () => true

function suiteWith(result, extra = {}) {
  const calls = []
  const out = runBoundaryLintSuite({
    root: '/repo',
    toolAvailableFn: always,
    tsxInstalledFn: always,
    runFn: (cmd, args, opts) => {
      calls.push({ cmd, args, opts })
      return result
    },
    ...extra,
  })
  return { out, calls }
}

test('a real-tree OK line is collected as its file count and passes', () => {
  const { out, calls } = suiteWith(res(0, '[boundary-lint] OK (510 file(s) checked, mode --all)\n'))
  assert.equal(out.collected, 510)
  assert.equal(out.failed, 0)
  assert.equal(evaluateSuite(out).status, 'pass')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].cmd, 'pnpm', 'never a bare tsx')
  assert.deepEqual(calls[0].args, ['exec', 'tsx', 'scripts/boundary-lint.ts', '--all', '--min-files', '300'])
  assert.match(calls[0].opts.cwd.split('\\').join('/'), /\/gremion-ui$/)
})

test('the suite passes the 300-file floor to the CLI', () => {
  assert.equal(MIN_FILES, 300)
  assert.deepEqual(BOUNDARY_LINT_ARGS.slice(-2), ['--min-files', '300'])
})

test('OK (0 file(s) checked) with exit 0 fails: collected 0 (the pre-TASK-053 CLI)', () => {
  const { out } = suiteWith(res(0, '[boundary-lint] OK (0 file(s) checked, mode --all)\n'))
  const v = evaluateSuite(out)
  assert.equal(v.status, 'fail')
  assert.match(v.reason, /collected 0/)
})

test('an OK line below the floor fails even with exit 0 (the CLI refusal could regress)', () => {
  const { out } = suiteWith(res(0, '[boundary-lint] OK (12 file(s) checked, mode --all)\n'))
  assert.equal(out.failed, 1)
  assert.equal(evaluateSuite(out).status, 'fail')
  assert.match(out.detail, /below the floor of 300/)
})

test('the CLI refusal (scanned 0 file(s), exit 1) fails', () => {
  const { out } = suiteWith(res(1, '', '[boundary-lint] scanned 0 file(s) under /x -- below the floor of 300; refusing\n'))
  assert.equal(evaluateSuite(out).status, 'fail')
  const { out: below } = suiteWith(res(1, '', '[boundary-lint] scanned 120 file(s) under /x -- below the floor of 300\n'))
  assert.equal(below.failed, 1)
  assert.equal(evaluateSuite(below).status, 'fail')
})

test('boundary violations fail with their count', () => {
  const { out } = suiteWith(res(1, '', '[boundary-lint] 2 problem(s):\n  a.ts:1  x\n  b.ts:2  y\n'))
  assert.equal(out.failed, 2)
  assert.equal(evaluateSuite(out).status, 'fail')
})

test('output with no count line is unparseable, never a pass (exit 0 or not)', () => {
  for (const r of [res(0, 'something else\n'), res(2, '', 'usage: ...\n'), res(0, '')]) {
    const { out } = suiteWith(r)
    assert.equal(out.unparseable, true)
    assert.equal(evaluateSuite(out).status, 'fail')
  }
})

test('missing pnpm is toolMissing, never a skip', () => {
  const { out, calls } = suiteWith(res(0), { toolAvailableFn: (n) => n !== 'pnpm' })
  assert.equal(out.toolMissing, 'pnpm')
  assert.equal(calls.length, 0)
  assert.equal(evaluateSuite(out).reason, 'missing tool: pnpm')
  const spawnFail = judgeBoundaryLint({ code: null, stdout: '', stderr: '', error: Object.assign(new Error('x'), { code: 'ENOENT' }) })
  assert.equal(spawnFail.toolMissing, 'pnpm')
})

test('a missing gremion-ui tsx is toolMissing "tsx (run pnpm install)"', () => {
  const { out, calls } = suiteWith(res(0), { tsxInstalledFn: () => false })
  assert.equal(out.toolMissing, 'tsx (run pnpm install)')
  assert.equal(calls.length, 0)
})

test('the runner is synchronous (runAll does not await)', () => {
  assert.notEqual(runBoundaryLintSuite.constructor.name, 'AsyncFunction')
  const { out } = suiteWith(res(0, '[boundary-lint] OK (510 file(s) checked, mode --all)\n'))
  assert.equal(typeof out.then, 'undefined')
})
