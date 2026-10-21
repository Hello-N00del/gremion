// TASK-045 round 2: suites/typecheck.mjs judges and package discovery.
import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { combineParts, evaluateSuite } from './lib/guard.mjs'
import { judgeSvelteCheck, judgeTsc, typecheckPackageDirs } from './suites/typecheck.mjs'

const REPO_ROOT = path.join(import.meta.dirname, '..', '..')

test('svelte-check: a COMPLETED line over 0 files is an EMPTY part, not a pass', () => {
  const p = judgeSvelteCheck('gremion-ui svelte-check', { code: 0, stdout: '1 COMPLETED 0 FILES 0 ERRORS 0 WARNINGS 0 FILES_WITH_PROBLEMS\n', stderr: '' })
  const v = evaluateSuite(combineParts([{ label: 'other', collected: 5, passed: 5, failed: 0, skipped: 0 }, p]))
  assert.equal(v.status, 'fail')
  assert.match(v.reason, /collected 0 tests in: gremion-ui svelte-check/)
})

test('svelte-check: a non-zero exit with 0 ERRORS in its COMPLETED line is untrusted', () => {
  const p = judgeSvelteCheck('x', { code: 1, stdout: '1 COMPLETED 10 FILES 0 ERRORS 0 WARNINGS 0 FILES_WITH_PROBLEMS\n', stderr: '' })
  assert.equal(p.unparseable, true)
})

test('svelte-check: no COMPLETED line is unparseable (the gate-ceba66c errors=? defect)', () => {
  assert.equal(judgeSvelteCheck('x', { code: 0, stdout: 'Loading svelte-check\n', stderr: '' }).unparseable, true)
})

test('tsc: a missing pnpm is a missing tool, not a failed or passed typecheck', () => {
  const p = judgeTsc('x', { code: null, stdout: '', stderr: '', error: Object.assign(new Error('spawn pnpm ENOENT'), { code: 'ENOENT' }) })
  assert.equal(p.toolMissing, 'pnpm')
})

test('typecheck discovers every workspace package with a typecheck script, generated-clients included', () => {
  const dirs = typecheckPackageDirs(REPO_ROOT).map((d) => path.relative(REPO_ROOT, d).split(path.sep).join('/'))
  for (const expected of ['packages/db', 'packages/generated-clients', 'packages/ports']) {
    assert.ok(dirs.includes(expected), `typecheck no longer covers ${expected}: ${dirs.join(', ')}`)
  }
})

test('typecheck discovers the services/* trees too (TASK-077: the kernel API is not under packages/)', () => {
  const dirs = typecheckPackageDirs(REPO_ROOT).map((d) => path.relative(REPO_ROOT, d).split(path.sep).join('/'))
  assert.ok(dirs.includes('services/kernel-api'), `typecheck does not cover services/kernel-api: ${dirs.join(', ')}`)
})
