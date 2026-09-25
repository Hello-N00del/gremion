// TASK-012-FU finding 3 (MEDIUM): runner-policy.mjs needs the `yaml`
// package. In a clone where `pnpm install` has not run, a STATIC import of it
// killed guards.mjs with ERR_MODULE_NOT_FOUND before any dated JSON result
// was written — the entry point's post-condition. These tests run the real
// CLIs in a child node whose module resolver refuses `yaml` (a
// module.registerHooks resolve hook, written to a scratch dir at run time),
// which is exactly what a missing node_modules/yaml looks like to Node.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawnSync, execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

const BLOCK_YAML_HOOK = `import { registerHooks } from 'node:module'
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'yaml' || specifier.startsWith('yaml/')) {
      const err = new Error("Cannot find package 'yaml' imported from " + context.parentURL + ' (blocked by the TASK-012-FU test hook)')
      err.code = 'ERR_MODULE_NOT_FOUND'
      throw err
    }
    return nextResolve(specifier, context)
  },
})
`

function makeRepo(root) {
  mkdirSync(join(root, '.github', 'workflows'), { recursive: true })
  writeFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'jobs:\n  x:\n    runs-on: ubuntu-latest\n')
  writeFileSync(join(root, '.gitleaks.toml'), '[extend]\nuseDefault = true\n')
  const git = (args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' })
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.email', 'ci-local-test@example.invalid'])
  git(['config', 'user.name', 'ci-local-test'])
  git(['add', '.'])
  git(['commit', '-q', '-m', 'seed'])
  return root
}

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'ci-local-yaml-unavailable-'))
  const hook = join(dir, 'block-yaml.mjs')
  writeFileSync(hook, BLOCK_YAML_HOOK)
  return { dir, hookUrl: pathToFileURL(hook).href }
}

function runNode(hookUrl, script, args) {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  delete env.NODE_TEST_WORKER_ID
  return spawnSync(process.execPath, ['--import', hookUrl, join(HERE, script), ...args], { encoding: 'utf8', env, timeout: 180_000 })
}

test('FU-3: the hook really makes `yaml` unimportable (so the tests below prove something)', () => {
  const { dir, hookUrl } = scratch()
  try {
    const r = spawnSync(process.execPath, ['--import', hookUrl, '--input-type=module', '-e', "await import('yaml')"], { encoding: 'utf8', cwd: join(HERE, '..', '..') })
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /ERR_MODULE_NOT_FOUND/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('FU-3: guards.mjs with `yaml` unimportable still writes its dated JSON, exits non-zero, and FAILs the runner-policy arm naming the missing dependency', () => {
  const { dir, hookUrl } = scratch()
  const kernel = makeRepo(join(dir, 'kernel'))
  const vertical = makeRepo(join(dir, 'vertical'))
  const outDir = join(dir, 'out')
  try {
    const r = runNode(hookUrl, 'guards.mjs', ['--kernel', kernel, '--vertical', vertical, '--out', outDir])
    assert.doesNotMatch(r.stderr, /ERR_MODULE_NOT_FOUND[\s\S]*at /, 'the process must not die on the import')
    assert.equal(r.status, 1)
    const files = readdirSync(outDir)
    assert.equal(files.length, 1)
    assert.match(files[0], /^\d{4}-\d{2}-\d{2}T\d{6}Z-[0-9a-f]{7}-[0-9a-f]{7}-guards\.json$/)
    const body = JSON.parse(readFileSync(join(outDir, files[0]), 'utf8'))
    assert.equal(body.overallExit, 1)
    const arm = body.arms.find((a) => a.arm === 'runner-policy')
    assert.equal(arm.status, 'FAIL')
    assert.match(arm.reason, /yaml/)
    assert.match(arm.reason, /pnpm install --frozen-lockfile/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('FU-3: runner-policy.mjs CLI with `yaml` unimportable exits 1 with a reported reason, never an uncaught ERR_MODULE_NOT_FOUND', () => {
  const { dir, hookUrl } = scratch()
  const repo = makeRepo(join(dir, 'repo'))
  try {
    const r = runNode(hookUrl, 'runner-policy.mjs', ['--repo', repo])
    assert.equal(r.status, 1)
    assert.match(r.stderr, /runner-policy: .*yaml.*pnpm install --frozen-lockfile/)
    assert.doesNotMatch(r.stderr, /ERR_MODULE_NOT_FOUND[\s\S]*at /)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
