#!/usr/bin/env node
// node --test suite for the build-version stamp (TASK-032, brief sec. 6 test 2).
//
// Two layers:
//   1. kit.config.js's `versionName` / `createKitConfig` / `buildStampGuard`,
//      in-process (env is a parameter, so no child process is needed to vary it).
//   2. The REAL vite.config.ts and `svelte-kit sync`, in child processes with
//      BUILD_SHA removed from the environment. Every Vite-based command other
//      than an actual `vite build` must work on a clean checkout without
//      BUILD_SHA: vitest and `vite dev` resolve the config as `serve`, but
//      `svelte-kit sync` (run by `pnpm check`) resolves it as `build`
//      (@sveltejs/kit src/core/config/index.js load_vite_config), so the hard
//      failure cannot live in config resolution. It lives in a build-only
//      plugin's `buildStart` hook, which runs only when Rollup really builds.
//      This is the round-1 HIGH regression: kit.config.js used to throw at
//      module load, which broke check, vitest and dev too.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { buildStampGuard, createKitConfig, versionName } from '../kit.config.js'

const APP = 'gremion-ui'
const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')

test(`${APP} kit.config.js: BUILD_SHA=abc1234 stamps kit3+civitas.abc1234`, () => {
  assert.match(versionName({ BUILD_SHA: 'abc1234' }), /^kit3\+civitas\.abc1234$/)
  const config = createKitConfig({ env: { BUILD_SHA: 'abc1234' } })
  assert.match(config.version?.name ?? '', /^kit3\+civitas\.abc1234$/)
})

test(`${APP} kit.config.js: no BUILD_SHA -> versionName throws, never falls back to a timestamp`, () => {
  assert.throws(() => versionName({}), /BUILD_SHA is required/)
  assert.throws(() => versionName({ BUILD_SHA: '' }), /BUILD_SHA is required/)
})

test(`${APP} kit.config.js: rejects a BUILD_SHA that is not exactly 7 lowercase hex chars`, () => {
  // Q4: the stamp is public on the anonymous portal, so only a 7-char sha may
  // reach /_app/version.json, never an arbitrary (possibly environment) string.
  for (const bad of ['abc123', 'abc12345', 'ABC1234', 'abc123g', 'abc1234\n', ' abc1234', 'a929f36f7c1b', 'host.example']) {
    assert.throws(() => versionName({ BUILD_SHA: bad }), /BUILD_SHA must be exactly 7 lowercase hex/, `accepted ${JSON.stringify(bad)}`)
    assert.throws(() => createKitConfig({ env: { BUILD_SHA: bad } }), /BUILD_SHA must be exactly 7 lowercase hex/)
  }
})

test(`${APP} kit.config.js: config loads without BUILD_SHA and carries no stamp`, () => {
  const config = createKitConfig({ env: {} })
  assert.equal(config.version?.name, undefined)
})

test(`${APP} kit.config.js: the build guard is build-only and fails buildStart without a valid BUILD_SHA`, () => {
  assert.equal(buildStampGuard({}).apply, 'build')
  assert.throws(() => buildStampGuard({}).buildStart(), /BUILD_SHA is required/)
  assert.throws(() => buildStampGuard({ BUILD_SHA: 'nothex!' }).buildStart(), /BUILD_SHA must be exactly 7 lowercase hex/)
  assert.doesNotThrow(() => buildStampGuard({ BUILD_SHA: 'abc1234' }).buildStart())
})

function childEnv(buildSha) {
  const env = { ...process.env }
  delete env.BUILD_SHA
  if (buildSha !== undefined) env.BUILD_SHA = buildSha
  return env
}

/** Resolve the real vite.config.ts via Vite in a child; print the plugin names. */
function resolveViteConfig(command, buildSha) {
  const viteUrl = pathToFileURL(join(APP_DIR, 'node_modules', 'vite', 'dist', 'node', 'index.js')).href
  const mode = command === 'build' ? 'production' : 'development'
  const code = `import(${JSON.stringify(viteUrl)}).then(v => v.resolveConfig({ configFile: 'vite.config.ts', logLevel: 'silent' }, ${JSON.stringify(command)}, ${JSON.stringify(mode)})).then(c => console.log('PLUGINS ' + c.plugins.map(p => p.name).join(',')), e => { console.error(String(e && e.message || e)); process.exit(1) })`
  return spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: APP_DIR, env: childEnv(buildSha), encoding: 'utf8', timeout: 120000 })
}

test(`${APP} vite.config.ts: serve resolves without BUILD_SHA (vitest, vite dev)`, () => {
  const r = resolveViteConfig('serve', undefined)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /^PLUGINS /m)
  assert.doesNotMatch(r.stdout, /gremion:build-stamp-guard/, 'the guard must not apply to serve')
})

test(`${APP} vite.config.ts: build resolves without BUILD_SHA (svelte-kit sync) and wires the build guard`, () => {
  const r = resolveViteConfig('build', undefined)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /gremion:build-stamp-guard/)
})

test(`${APP} svelte-kit sync (pnpm check's first step) exits 0 without BUILD_SHA`, () => {
  const cli = join(APP_DIR, 'node_modules', '@sveltejs', 'kit', 'svelte-kit.js')
  const r = spawnSync(process.execPath, [cli, 'sync'], { cwd: APP_DIR, env: childEnv(undefined), encoding: 'utf8', timeout: 120000 })
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.doesNotMatch(r.stderr + r.stdout, /BUILD_SHA is required/)
})
