#!/usr/bin/env node
// node --test gremion-ui/scripts/interim-module-overlay.test.mjs
// TASK-205 TDD 2: the interim module overlay. Fixture repositories prove the REDs (collision, zero
// modules, a disabled module in build mode, a stale output, a foreign file); the last cases read the REAL
// tree: every overlay destination is gitignored and tracked nowhere, and the image build copies every
// module's app/ before `pnpm build`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULT_ROOT, MANIFEST_NAME, OverlayError, discoverModules, runOverlay } from './interim-module-overlay.mjs'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'interim-module-overlay.mjs')

function put(root, rel, text = 'x\n') {
  mkdirSync(dirname(join(root, rel)), { recursive: true })
  writeFileSync(join(root, rel), text)
}

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.org', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.org' },
  })
}

/** modules/calendar (enabled), modules/finance (disabled), gremion-ui/src with one kernel file; a git repo. */
function fixture({ withGit = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 't205-overlay-'))
  put(root, 'modules/calendar/app/routes/calendar/+page.svelte', '<p>calendar</p>\n')
  put(root, 'modules/calendar/app/lib/server/calendar/db.ts', 'export const db = 1\n')
  put(root, 'modules/calendar/app/migrations/003_x.sql', 'select 1;\n')
  put(root, 'modules/calendar/app/scripts/proof.sh', '#!/bin/sh\n')
  put(root, 'modules/board/app/routes/tasks/+page.svelte', '<p>tasks</p>\n')
  put(root, 'modules/finance/app/routes/finance/+page.svelte', '<p>finance</p>\n')
  put(root, 'modules/disabled.json', JSON.stringify({ disabled: [{ id: 'finance', reason: 'fixture' }] }))
  put(root, 'gremion-ui/src/lib/kernel.ts', 'export const k = 1\n')
  put(root, 'gremion-ui/svelte.config.js', 'export default { kit: {} }\n') // no kit.files: K4
  if (withGit) {
    git(root, 'init', '-q', '-b', 'main')
    git(root, 'add', '-A')
    git(root, '-c', 'user.name=t', '-c', 'user.email=t@example.org', 'commit', '-qm', 'base')
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('GREEN: enabled modules land on src/, migrations/ and scripts/ stay out, the disabled module does not', () => {
  const f = fixture()
  try {
    const r = runOverlay({ root: f.root })
    assert.deepEqual(r.modules, ['board', 'calendar'])
    assert.ok(existsSync(join(f.root, 'gremion-ui/src/routes/calendar/+page.svelte')))
    assert.ok(existsSync(join(f.root, 'gremion-ui/src/routes/tasks/+page.svelte')))
    assert.ok(existsSync(join(f.root, 'gremion-ui/src/lib/server/calendar/db.ts')))
    assert.ok(!existsSync(join(f.root, 'gremion-ui/src/routes/finance')), 'a disabled module is never overlaid')
    assert.ok(!existsSync(join(f.root, 'gremion-ui/migrations')), 'migrations are overlaid only on request')
    assert.ok(!existsSync(join(f.root, 'gremion-ui/src/proof.sh')))
    assert.equal(readFileSync(join(f.root, 'gremion-ui/src/lib/server/calendar/db.ts'), 'utf8'), 'export const db = 1\n')
    const manifest = JSON.parse(readFileSync(join(f.root, 'gremion-ui', MANIFEST_NAME), 'utf8'))
    assert.deepEqual(manifest.files, ['src/lib/server/calendar/db.ts', 'src/routes/calendar/+page.svelte', 'src/routes/tasks/+page.svelte'])
    // idempotent: a second run rewrites nothing
    assert.equal(runOverlay({ root: f.root }).written, 0)
  } finally {
    f.cleanup()
  }
})

test('K4: the overlay is a plain file copy - a svelte.config.js without kit.files (SvelteKit 3) changes nothing', () => {
  const f = fixture()
  try {
    assert.ok(!/files/.test(readFileSync(join(f.root, 'gremion-ui/svelte.config.js'), 'utf8')))
    assert.equal(runOverlay({ root: f.root }).files.length, 3)
    rmSync(join(f.root, 'gremion-ui/svelte.config.js'))
    assert.equal(runOverlay({ root: f.root }).files.length, 3, 'it does not even read the config')
  } finally {
    f.cleanup()
  }
})

test('RED: a tracked kernel file at an overlay destination is a collision, never overwritten', () => {
  const f = fixture()
  try {
    put(f.root, 'modules/calendar/app/lib/kernel.ts', 'export const k = 2\n') // maps onto the tracked gremion-ui/src/lib/kernel.ts
    git(f.root, 'add', '-A')
    git(f.root, '-c', 'user.name=t', '-c', 'user.email=t@example.org', 'commit', '-qm', 'collide')
    assert.throws(() => runOverlay({ root: f.root }), (e) => e instanceof OverlayError && /gremion-ui\/src\/lib\/kernel\.ts/.test(e.message) && /tracked/.test(e.message))
    assert.equal(readFileSync(join(f.root, 'gremion-ui/src/lib/kernel.ts'), 'utf8'), 'export const k = 1\n')
  } finally {
    f.cleanup()
  }
})

test('RED: an untracked file nobody overlaid is a collision too (the Docker build context has no git)', () => {
  const f = fixture({ withGit: false })
  try {
    put(f.root, 'gremion-ui/src/routes/calendar/+page.svelte', 'hand written\n')
    assert.throws(() => runOverlay({ root: f.root }), /not this overlay's own previous output/)
    assert.equal(readFileSync(join(f.root, 'gremion-ui/src/routes/calendar/+page.svelte'), 'utf8'), 'hand written\n')
  } finally {
    f.cleanup()
  }
})

test('RED: zero modules refuses - none with an app/, or every one disabled', () => {
  const f = fixture()
  try {
    rmSync(join(f.root, 'modules/calendar/app'), { recursive: true })
    rmSync(join(f.root, 'modules/board/app'), { recursive: true })
    assert.throws(() => runOverlay({ root: f.root }), /no module to overlay/)
    put(f.root, 'modules/board/app/routes/tasks/+page.svelte')
    put(f.root, 'modules/disabled.json', JSON.stringify({ disabled: [{ id: 'finance', reason: 'x' }, { id: 'board', reason: 'x' }] }))
    assert.throws(() => runOverlay({ root: f.root }), /no module to overlay/)
  } finally {
    f.cleanup()
  }
})

test('RED: a disabled module is refused in build mode, and --include-disabled never targets gremion-ui itself', () => {
  const f = fixture()
  try {
    assert.throws(() => runOverlay({ root: f.root, modules: ['finance'] }), /module finance is disabled/)
    assert.throws(() => runOverlay({ root: f.root, includeDisabled: true }), /test-only/)
    assert.ok(!existsSync(join(f.root, 'gremion-ui/src/routes/finance')))
    // the test-only lane: a scratch target, disabled modules included
    const scratch = join(f.root, '.scratch', 'finance-lane')
    const r = runOverlay({ root: f.root, includeDisabled: true, target: scratch })
    assert.deepEqual(r.modules, ['board', 'calendar', 'finance'])
    assert.ok(existsSync(join(scratch, 'src/routes/finance/+page.svelte')))
  } finally {
    f.cleanup()
  }
})

test('RED: a module id with no app/ is refused by name', () => {
  const f = fixture()
  try {
    assert.throws(() => runOverlay({ root: f.root, modules: ['nonesuch'] }), /module nonesuch has no modules\/nonesuch\/app\//)
  } finally {
    f.cleanup()
  }
})

test('RED: two modules mapping to one destination refuse', () => {
  const f = fixture()
  try {
    put(f.root, 'modules/board/app/routes/calendar/+page.svelte', 'clash\n')
    assert.throws(() => runOverlay({ root: f.root }), /both modules\/board\/app and modules\/calendar\/app map to it/)
  } finally {
    f.cleanup()
  }
})

test('a module file removed (or a module disabled) is swept on the next run, empty directories with it, foreign files never', () => {
  const f = fixture()
  try {
    runOverlay({ root: f.root })
    put(f.root, 'gremion-ui/src/routes/calendar/foreign.txt', 'mine\n') // not in the manifest
    rmSync(join(f.root, 'modules/board/app'), { recursive: true })
    const r = runOverlay({ root: f.root })
    assert.deepEqual(r.removed, ['src/routes/tasks/+page.svelte'])
    assert.ok(!existsSync(join(f.root, 'gremion-ui/src/routes/tasks')), 'the emptied directory is pruned')
    assert.ok(existsSync(join(f.root, 'gremion-ui/src/routes/calendar/foreign.txt')))
  } finally {
    f.cleanup()
  }
})

test('--migrations copies app/migrations/*.sql into gremion-ui/migrations (prebuild/Docker only) and refuses a collision there', () => {
  const f = fixture()
  try {
    const r = runOverlay({ root: f.root, migrations: true })
    assert.ok(r.files.includes('migrations/003_x.sql'))
    assert.equal(readFileSync(join(f.root, 'gremion-ui/migrations/003_x.sql'), 'utf8'), 'select 1;\n')
    rmSync(join(f.root, 'gremion-ui', MANIFEST_NAME))
    assert.throws(() => runOverlay({ root: f.root, migrations: true }), /gremion-ui\/migrations\/003_x\.sql/)
  } finally {
    f.cleanup()
  }
})

test('the CLI exits 1 on a refusal, 2 on bad arguments, 0 on success, and prints what it did', () => {
  const f = fixture()
  try {
    const ok = spawnSync(process.execPath, [SCRIPT, '--root', f.root], { encoding: 'utf8' })
    assert.equal(ok.status, 0, ok.stderr)
    assert.match(ok.stdout + ok.stderr, /board, calendar: 3 files/)
    const bad = spawnSync(process.execPath, [SCRIPT, '--root', f.root, '--nope'], { encoding: 'utf8' })
    assert.equal(bad.status, 2)
    const refused = spawnSync(process.execPath, [SCRIPT, '--root', f.root, '--modules', 'finance'], { encoding: 'utf8' })
    assert.equal(refused.status, 1)
    assert.match(refused.stderr, /disabled/)
  } finally {
    f.cleanup()
  }
})

// ── the real tree ────────────────────────────────────────────────────────────

test('REAL TREE: every overlay destination of every module is gitignored and tracked nowhere', () => {
  const { withApp: all, disabled } = discoverModules(DEFAULT_ROOT)
  const withApp = all.filter((id) => !disabled.includes(id)) // what a build overlays; a disabled module overlays only into a scratch target
  assert.ok(withApp.length >= 1)
  const dests = []
  for (const id of withApp) {
    const files = execFileSync('git', ['ls-files', '-z', '--', `modules/${id}/app`], { cwd: DEFAULT_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean)
    for (const f of files) {
      const rel = posix.relative(`modules/${id}/app`, f)
      const top = rel.split('/')[0]
      if (top === 'migrations' || top === 'scripts') continue
      dests.push(`gremion-ui/src/${rel}`)
    }
  }
  assert.ok(dests.length > 0)
  const tracked = new Set(execFileSync('git', ['ls-files', '-z', '--', 'gremion-ui/src'], { cwd: DEFAULT_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean))
  const collisions = dests.filter((d) => tracked.has(d))
  assert.deepEqual(collisions, [], 'a module file maps onto a tracked kernel file')
  // `git check-ignore --stdin` echoes the ignored paths; every destination must come back
  const res = spawnSync('git', ['check-ignore', '--stdin', '-z'], { cwd: DEFAULT_ROOT, input: dests.join('\0') + '\0', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const ignored = new Set(res.stdout.split('\0').filter(Boolean))
  const notIgnored = dests.filter((d) => !ignored.has(d))
  assert.deepEqual(notIgnored, [], `not covered by gremion-ui/.gitignore (an overlay output would show up in git status): ${notIgnored.slice(0, 5).join(', ')}`)
})

test('REAL TREE: the image build copies every module app/ and disabled.json before `pnpm build`', () => {
  const dockerfile = readFileSync(join(DEFAULT_ROOT, 'gremion-ui', 'Dockerfile'), 'utf8')
  const buildAt = dockerfile.indexOf('RUN pnpm build')
  assert.ok(buildAt > 0)
  const before = dockerfile.slice(0, buildAt)
  const { withApp: all, disabled } = discoverModules(DEFAULT_ROOT)
  const withApp = all.filter((id) => !disabled.includes(id)) // a disabled module is not overlaid, so the image needs not carry it
  for (const id of withApp) assert.ok(before.includes(`COPY modules/${id}/app ./modules/${id}/app/`), `Dockerfile lacks COPY modules/${id}/app before pnpm build`)
  assert.ok(before.includes('COPY modules/disabled.json ./modules/'), 'Dockerfile lacks COPY modules/disabled.json')
  // the overlay is the first step of prebuild and of the check/test scripts
  const pkg = JSON.parse(readFileSync(join(DEFAULT_ROOT, 'gremion-ui', 'package.json'), 'utf8'))
  for (const s of ['prebuild', 'precheck', 'pretest:unit']) assert.match(pkg.scripts[s] ?? '', /^node scripts\/interim-module-overlay\.mjs/, `${s} must start with the overlay`)
  assert.match(pkg.scripts.prebuild, /interim-module-overlay\.mjs --migrations/)
})
