#!/usr/bin/env node
// node --test suite for the build-version stamp (TASK-032, brief §6 test 2).
//
// `kit.config.js`'s `version.name` is computed at MODULE-EVALUATION time
// (not lazily), so proving both the success and failure shape needs two
// independent process loads, not two `import()`s in this process — Node
// caches an ES module by specifier, so a second `import()` of the same file
// would return the cached (already-thrown-or-not) result instead of
// re-running the top-level code. Each case is spawned as its own `node`
// process with a controlled environment, same idiom as
// scripts/check-domain-regex.mjs's spawnSync use.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url))
const APP_DIR = join(SCRIPTS_DIR, '..')

/**
 * Import ./kit.config.js in a fresh child process. `buildSha` of
 * `undefined` runs the child with BUILD_SHA deleted from its environment
 * (never merely unset-in-the-parent, since the parent might have one).
 */
function loadConfigWithEnv(buildSha) {
  const code = "import('./kit.config.js').then(m => console.log(JSON.stringify(m.default.version)), e => { console.error(e.message); process.exit(1) })"
  const env = { ...process.env }
  if (buildSha === undefined) {
    delete env.BUILD_SHA
  } else {
    env.BUILD_SHA = buildSha
  }
  return spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: APP_DIR,
    env,
    encoding: 'utf8',
  })
}

test('gremion-ui kit.config.js: BUILD_SHA=abc1234 produces the kit3+civitas.<sha> stamp', () => {
  const result = loadConfigWithEnv('abc1234')
  assert.equal(result.status, 0, result.stderr)
  const version = JSON.parse(result.stdout)
  assert.match(version.name, /^kit3\+civitas\.abc1234$/)
})

test('gremion-ui kit.config.js: no BUILD_SHA throws rather than falling back to a timestamp', () => {
  const result = loadConfigWithEnv(undefined)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /BUILD_SHA is required/)
})
