#!/usr/bin/env node
// node --test suite for the pilot module defaults check (TASK-058-A). Each RED
// case mutates a throwaway tree and asserts on the report text.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { ROOT, REQUEST_PATH, PANEL_FORM, ENV_DIR, runChecks } from './check-pilot-module-defaults.mjs'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 't058-'))
  const put = (rel, text) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), text)
  }
  put(REQUEST_PATH, JSON.stringify({ enable: ['votes'] }))
  for (const id of ['votes', 'elections', 'finance']) put(`modules/${id}/module.json`, JSON.stringify({ id, runtime: { version: '1.0.0' } }))
  put(`${ENV_DIR}/app.env.tmpl`, 'STACK=x\nCOMPOSE_PROFILES=production\n')
  put(`${ENV_DIR}/mail.env.tmpl`, 'COMPOSE_PROFILES=mail\n')
  put(PANEL_FORM, readFileSync(join(ROOT, PANEL_FORM), 'utf8'))
  return { root, put, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}
const failures = (root) => runChecks(root).failures

test('the real tree passes all four checks', () => {
  assert.deepEqual(runChecks(ROOT).failures, [])
})

test('baseline fixture is green', () => {
  const f = fixture()
  try { assert.deepEqual(failures(f.root), []) } finally { f.cleanup() }
})

test('RED (a): elections in the pilot request', () => {
  const f = fixture()
  try {
    f.put(REQUEST_PATH, JSON.stringify({ enable: ['votes', 'elections'] }))
    assert.match(failures(f.root).join('\n'), /\(a\) the pilot request enables "elections"/)
  } finally { f.cleanup() }
})

test('RED (a): votes missing, and an id without a module.json', () => {
  const f = fixture()
  try {
    f.put(REQUEST_PATH, JSON.stringify({ enable: ['polls'] }))
    const r = failures(f.root).join('\n')
    assert.match(r, /does not enable votes/)
    assert.match(r, /"polls" has no modules\/polls\/module.json/)
  } finally { f.cleanup() }
})

test('RED (b): finance on a COMPOSE_PROFILES line; zero lines is also a failure', () => {
  const f = fixture()
  try {
    f.put(`${ENV_DIR}/app.env.tmpl`, 'COMPOSE_PROFILES=production,finance\n')
    assert.match(failures(f.root).join('\n'), /\(b\) app.env.tmpl:1 COMPOSE_PROFILES names "finance"/)
    f.put(`${ENV_DIR}/app.env.tmpl`, 'X=1\n')
    f.put(`${ENV_DIR}/mail.env.tmpl`, 'X=1\n')
    assert.match(failures(f.root).join('\n'), /no COMPOSE_PROFILES line found/)
  } finally { f.cleanup() }
})

test('RED (c): a default-enable key in a module.json, nested too', () => {
  const f = fixture()
  try {
    f.put('modules/elections/module.json', JSON.stringify({ id: 'elections', runtime: { defaultEnabled: true } }))
    assert.match(failures(f.root).join('\n'), /\(c\) modules\/elections\/module.json.runtime.defaultEnabled/)
  } finally { f.cleanup() }
})

test('RED (d): a preselected checkbox, bare or literal', () => {
  const f = fixture()
  try {
    const src = readFileSync(join(ROOT, PANEL_FORM), 'utf8')
    f.put(PANEL_FORM, src.replace('checked={checkedModules.includes(m.id)}', 'checked'))
    assert.match(failures(f.root).join('\n'), /\(d\) a module checkbox is preselected: checked/)
    f.put(PANEL_FORM, src.replace('checked={checkedModules.includes(m.id)}', 'checked={m.id === "calendar"}'))
    assert.match(failures(f.root).join('\n'), /\(d\) a module checkbox is preselected/)
    f.put(PANEL_FORM, src.replace(/: \[\]\)/, ': ["calendar"])'))
    assert.match(failures(f.root).join('\n'), /checkedModules is not/)
  } finally { f.cleanup() }
})

test('the CLI exits 0 on the real tree', async () => {
  const { spawnSync } = await import('node:child_process')
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts/check-pilot-module-defaults.mjs')], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /OK/)
})
