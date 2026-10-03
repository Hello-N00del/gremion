#!/usr/bin/env node
// node --test gremion-ui/scripts/module-lane.test.mjs
// TASK-205 TDD 11 (TASK-200 residual (a)): the test-only lane for the DISABLED modules' app halves. The
// helpers are proved on a fixture tree; the real tree must name at least one disabled module with unit tests,
// so a lane over nothing (which would let the residual pass vacuously) is refused by name.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULT_ROOT } from './interim-module-overlay.mjs'
import { LANE_DIR, laneModules, laneTestFiles, runLane } from './module-lane.mjs'

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

// verifier r1 MEDIUM: a lane left on disk under gremion-ui/ is a full src copy every tree scanner reads
// (`make lint` lint-tenant-db-access flagged 6 problems in _module-lane/src/lib/server/**) and that rides into
// the Docker build context. runLane must remove it whatever vitest does, including when vitest cannot start.
function laneFixture() {
  const base = mkdtempSync(join(tmpdir(), 't205-lane-run-'))
  const laneDir = join(base, '_module-lane')
  const build = (_root, _ids, dir) => {
    put(dir, 'src/lib/server/db.ts', 'export {}\n')
    return { modules: ['content'], files: ['src/lib/server/db.ts'] }
  }
  return { base, laneDir, build, cleanup: () => rmSync(base, { recursive: true, force: true }) }
}

test('runLane removes the lane after vitest exits and returns vitest\'s status', () => {
  const f = laneFixture()
  try {
    let sawLane = false
    const spawn = (_exe, args, opts) => {
      sawLane = existsSync(join(opts.cwd, 'src/lib/server/db.ts'))
      assert.ok(args.includes('src/a.test.ts'), 'the lane runs exactly the files it was given')
      return { status: 3 }
    }
    const status = runLane({ root: f.base, ids: ['content'], files: ['src/a.test.ts'], laneDir: f.laneDir, build: f.build, spawn, log: () => {} })
    assert.equal(status, 3)
    assert.ok(sawLane, 'vitest ran inside a built lane')
    assert.equal(existsSync(f.laneDir), false, 'the lane is gone after the run')
  } finally {
    f.cleanup()
  }
})

test('runLane removes the lane when vitest cannot be spawned (throws), and a null status is a failure', () => {
  const f = laneFixture()
  try {
    const boom = () => {
      throw new Error('spawn failed')
    }
    assert.throws(() => runLane({ root: f.base, ids: ['content'], files: ['src/a.test.ts'], laneDir: f.laneDir, build: f.build, spawn: boom, log: () => {} }), /spawn failed/)
    assert.equal(existsSync(f.laneDir), false, 'the lane is gone after a failed spawn')
    const status = runLane({ root: f.base, ids: ['content'], files: ['src/a.test.ts'], laneDir: f.laneDir, build: f.build, spawn: () => ({ status: null }), log: () => {} })
    assert.equal(status, 1)
    assert.equal(existsSync(f.laneDir), false)
  } finally {
    f.cleanup()
  }
})

test('the default lane dir is excluded from the Docker build context (a lane a killed run left behind never ships)', () => {
  const ignore = readFileSync(join(DEFAULT_ROOT, '.dockerignore'), 'utf8').split(/\r?\n/).map((l) => l.trim())
  assert.ok(ignore.includes('gremion-ui/_module-lane/'), 'root .dockerignore lists gremion-ui/_module-lane/')
  assert.equal(LANE_DIR.split(/[\\/]/).at(-1), '_module-lane')
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
