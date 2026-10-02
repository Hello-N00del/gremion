#!/usr/bin/env node
// node --test gremion-ui/scripts/module-lane.test.mjs
// TASK-205 TDD 11 (TASK-200 residual (a)): the test-only lane for the DISABLED modules' app halves. The
// helpers are proved on a fixture tree; the real tree must name at least one disabled module with unit tests,
// so a lane over nothing (which would let the residual pass vacuously) is refused by name.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULT_ROOT } from './interim-module-overlay.mjs'
import { laneModules, laneTestFiles } from './module-lane.mjs'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'module-lane.mjs')

function put(root, rel, text = 'x\n') {
  mkdirSync(dirname(join(root, rel)), { recursive: true })
  writeFileSync(join(root, rel), text)
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 't205-lane-'))
  put(root, 'modules/disabled.json', JSON.stringify({ disabled: [{ id: 'finance', reason: 'x' }, { id: 'vault', reason: 'x' }] }))
  put(root, 'modules/finance/app/lib/server/finance/a.test.ts')
  put(root, 'modules/finance/app/lib/server/finance/a.integration.test.ts') // needs Postgres: not a lane test
  put(root, 'modules/finance/app/routes/finance/p.browser.test.ts') // needs Chromium: not a lane test
  put(root, 'modules/finance/app/routes/finance/+page.svelte')
  put(root, 'modules/finance/app/migrations/013_x.test.ts') // migrations/ is never overlaid
  put(root, 'modules/vault/app/lib/server/vault/b.test.ts')
  put(root, 'modules/board/app/lib/server/board/c.test.ts') // enabled: the real gremion-ui project runs it
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('laneModules returns exactly the DISABLED modules that have an app/ half, narrowed on request', () => {
  const f = fixture()
  try {
    assert.deepEqual(laneModules(f.root), ['finance', 'vault'])
    assert.deepEqual(laneModules(f.root, ['vault']), ['vault'])
    assert.deepEqual(laneModules(f.root, ['board']), [], 'an enabled module is not the lane\'s')
  } finally {
    f.cleanup()
  }
})

test('laneTestFiles lists unit tests only: no integration, no browser, nothing under migrations/, paths relative to src/', () => {
  const f = fixture()
  try {
    assert.deepEqual(laneTestFiles(f.root, ['finance']), ['src/lib/server/finance/a.test.ts'])
    assert.deepEqual(laneTestFiles(f.root, ['finance', 'vault']), ['src/lib/server/finance/a.test.ts', 'src/lib/server/vault/b.test.ts'])
  } finally {
    f.cleanup()
  }
})

test('the real tree has at least one disabled module with unit tests (content), so the lane collects something', () => {
  const ids = laneModules(DEFAULT_ROOT)
  assert.ok(ids.includes('content'), `disabled modules with an app/ half: ${ids.join(', ')}`)
  const files = laneTestFiles(DEFAULT_ROOT, ['content'])
  assert.ok(files.length > 0, 'content has app/ unit tests that no other lane collects')
  assert.ok(files.every((p) => p.startsWith('src/') && /\.test\.[cm]?[jt]s$/.test(p)))
})

test('the CLI lists the lane without running it, and refuses an empty selection (exit 1) and bad arguments (exit 2)', () => {
  const list = spawnSync(process.execPath, [SCRIPT, '--list'], { encoding: 'utf8' })
  assert.equal(list.status, 0, list.stderr)
  assert.match(list.stdout + list.stderr, /\[module-lane\] .*content.*unit test file/)
  const none = spawnSync(process.execPath, [SCRIPT, '--list', '--modules', 'board'], { encoding: 'utf8' })
  assert.equal(none.status, 1)
  assert.match(none.stderr, /a lane over nothing must not pass/)
  const bad = spawnSync(process.execPath, [SCRIPT, '--nope'], { encoding: 'utf8' })
  assert.equal(bad.status, 2)
})
