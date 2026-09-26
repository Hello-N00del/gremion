// TASK-045 round 2 MEDIUM: suites/unit.mjs's UNIT_PARTS was hard-coded
// (ui/public/ports/node/bats) while suites/typecheck.mjs already discovers
// packages/* dynamically -- @gremion/generated-clients' 114 vitest tests ran
// in no verify suite and no gate on main. This pins that every packages/*
// with its own `test` script is covered one way or the other, so a NEW
// package with tests that nobody wires up fails this test by name instead of
// silently running nowhere.
import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { packageDirsWithTestScript, packagesCoveredByUiInclude, UNIT_PARTS } from './suites/unit.mjs'

const REPO_ROOT = path.join(import.meta.dirname, '..', '..')

test('packagesCoveredByUiInclude reads the real ../packages/<name>/ segments out of gremion-ui/vite.config.ts', () => {
  const covered = packagesCoveredByUiInclude(REPO_ROOT)
  for (const name of ['db', 'ports', 'storage']) {
    assert.ok(covered.has(name), `expected gremion-ui's vite include to cover packages/${name}`)
  }
  assert.ok(!covered.has('generated-clients'), 'generated-clients is not in the include glob -- it needs its own UNIT_PARTS key')
})

test('every packages/* with its own "test" script is covered by a UNIT_PARTS key or gremion-ui\'s vite include', () => {
  const covered = packagesCoveredByUiInclude(REPO_ROOT)
  for (const name of packageDirsWithTestScript(REPO_ROOT)) {
    const ok = Object.hasOwn(UNIT_PARTS, name) || covered.has(name)
    assert.ok(ok, `packages/${name} has a "test" script but is in no verify suite -- add UNIT_PARTS['${name}'] or a gremion-ui include glob entry`)
  }
})

test('generated-clients specifically has its own UNIT_PARTS key (the 114-test regression this finding named)', () => {
  assert.equal(typeof UNIT_PARTS['generated-clients'], 'function')
})
