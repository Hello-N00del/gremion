#!/usr/bin/env node
// node --test suite for the module documentation guard. Each RED case mutates a
// throwaway tree and asserts on the report text. Top-level test() declarations only
// (scripts/verify/suites/unit.mjs cross-checks the declared count with node's).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { ROOT, MODULES_DOC, DOCS_INDEX, DISABLED_PATH, moduleDirs, runChecks } from './check-module-docs.mjs'

const row = (id, status) => `| \`${id}\` | purpose | ${status} | none | [README](../modules/${id}/README.md) |`

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'moddocs-'))
  const put = (rel, text) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), text)
  }
  for (const id of ['alpha', 'beta']) {
    put(`modules/${id}/module.json`, '{}')
    put(`modules/${id}/README.md`, `# ${id}\n`)
  }
  put(DISABLED_PATH, JSON.stringify({ disabled: [{ id: 'beta', reason: 'x' }] }))
  put(MODULES_DOC, ['# Modules', '', '| Module | Purpose | Status | Needs | README |', '|---|---|---|---|---|', row('alpha', 'supported'), row('beta', 'disabled by default'), ''].join('\n'))
  put(DOCS_INDEX, '| [modules.md](./modules.md) | the module list |\n')
  return { root, put, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}
const failures = (root) => runChecks(root).failures

test('the real tree passes, and the scan is not vacuous', () => {
  const { dirs, failures: bad } = runChecks(ROOT)
  assert.deepEqual(bad, [])
  for (const id of ['board', 'calendar', 'content', 'elections', 'files', 'finance', 'handover', 'messaging', 'publishing', 'vault', 'votes']) {
    assert.ok(dirs.includes(id), `expected modules/${id} to be seen`)
  }
  assert.ok(moduleDirs(ROOT).every((d) => !d.endsWith('.json')), 'files are not modules')
})

test('baseline fixture is green', () => {
  const f = fixture()
  try {
    assert.deepEqual(failures(f.root), [])
  } finally {
    f.cleanup()
  }
})

test('RED (a): a module directory without a README.md, and an empty one', () => {
  const f = fixture()
  try {
    f.put('modules/gamma/module.json', '{}')
    f.put(MODULES_DOC, readFileSync(join(f.root, MODULES_DOC), 'utf8') + row('gamma', 'supported') + '\n')
    assert.match(failures(f.root).join('\n'), /\(a\) modules\/gamma has no README\.md/)
    f.put('modules/gamma/README.md', '  \n')
    assert.match(failures(f.root).join('\n'), /\(a\) modules\/gamma\/README\.md is empty/)
  } finally {
    f.cleanup()
  }
})

test('RED (b): a module directory missing from docs/modules.md', () => {
  const f = fixture()
  try {
    f.put(MODULES_DOC, ['# Modules', '', '| Module | Purpose | Status | Needs | README |', '|---|---|---|---|---|', row('alpha', 'supported'), ''].join('\n'))
    assert.match(failures(f.root).join('\n'), /\(b\) modules\/beta is missing from docs\/modules\.md/)
  } finally {
    f.cleanup()
  }
})

test('RED (b): a row without its README link, a row for a directory that is gone, and no table', () => {
  const f = fixture()
  try {
    f.put(MODULES_DOC, ['| Module | x |', '|---|---|', '| `alpha` | supported |', row('beta', 'disabled by default'), row('ghost', 'supported'), ''].join('\n'))
    const r = failures(f.root).join('\n')
    assert.match(r, /row for "alpha" does not link \.\.\/modules\/alpha\/README\.md/)
    assert.match(r, /lists "ghost" but there is no modules\/ghost/)
    f.put(MODULES_DOC, '# Modules\n\nno table here\n')
    assert.match(failures(f.root).join('\n'), /no module table rows/)
  } finally {
    f.cleanup()
  }
})

test('RED (c): the status disagrees with modules/disabled.json in either direction, and the index link is missing', () => {
  const f = fixture()
  try {
    f.put(MODULES_DOC, ['| Module | x |', '|---|---|', row('alpha', 'disabled by default'), row('beta', 'supported'), ''].join('\n'))
    const r = failures(f.root).join('\n')
    assert.match(r, /"beta" is in modules\/disabled\.json but its docs\/modules\.md row does not say "disabled by default"/)
    assert.match(r, /says "alpha" is disabled by default but modules\/disabled\.json does not list it/)
    f.put(DOCS_INDEX, 'no link\n')
    assert.match(failures(f.root).join('\n'), /docs\/INDEX\.md does not link \.\/modules\.md/)
  } finally {
    f.cleanup()
  }
})
