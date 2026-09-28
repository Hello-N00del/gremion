// TASK-029 TDD 11 (TRD-343 meta-test): the register is wired where it must
// run, and every suite here collects what it declares. Fails when the Makefile
// line, the `lint` prerequisite, the verify carve-lint row or migration-hash's
// read of the register is removed.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { CARVE_LINT_TARGETS } from '../verify/suites/carve-lint.mjs'
import { migrationHashDirs, runMigrationHashSuite } from '../verify/suites/migration-hash.mjs'
import { HERE, REPO_ROOT } from './register.mjs'

const MAKEFILE = readFileSync(join(REPO_ROOT, 'Makefile'), 'utf8')
const register = JSON.parse(readFileSync(join(HERE, 'ranges.json'), 'utf8'))

test('Makefile: lint-migration-register exists, is .PHONY, runs every suite with its count asserted, then register.mjs check', () => {
  const m = /^lint-migration-register:\n((?:\t.*\n)+)/m.exec(MAKEFILE.replace(/\r/g, ''))
  assert.ok(m, 'no lint-migration-register target')
  const recipe = m[1]
  assert.match(recipe, /scripts\/migrations\/\*\.test\.mjs/)
  assert.match(recipe, /grep -c '\^test\('/)
  assert.match(recipe, /1\\\.\\\./, 'the recipe must read the TAP plan')
  assert.match(recipe, /node scripts\/migrations\/register\.mjs check/)
  assert.match(MAKEFILE, /^\.PHONY:.*\blint-migration-register\b/m)
})

test('Makefile: lint-migration-register is a prerequisite of `make lint`', () => {
  const m = MAKEFILE.match(/^lint:([^\n]*)$/m)
  assert.ok(m)
  assert.ok(m[1].trim().split(/\s+/).includes('lint-migration-register'))
})

test('verify carve-lint runs lint-migration-register', () => {
  const t = CARVE_LINT_TARGETS.find((x) => x.name === 'lint-migration-register')
  assert.ok(t, 'carve-lint has no lint-migration-register row')
  assert.equal(t.kind, 'make')
  assert.equal(t.target, 'lint-migration-register')
})

test('verify migration-hash reads its directories from the register (every manifestDirs entry)', () => {
  const expected = register.chains.flatMap((c) => c.manifestDirs ?? [])
  assert.ok(expected.length >= 8, `the register declares only ${expected.length} manifest dir(s)`)
  assert.deepEqual(migrationHashDirs(REPO_ROOT), expected.map((d) => join(REPO_ROOT, ...d.split('/'))))
  const r = runMigrationHashSuite({ root: REPO_ROOT })
  assert.equal(r.unparseable, false, r.detail)
  assert.equal(r.failed, 0, r.detail)
  const files = expected.reduce((n, d) => n + readdirSync(join(REPO_ROOT, d)).filter((f) => f.endsWith('.sql')).length, 0)
  assert.equal(r.collected, files)
})

test('verify migration-hash: a registered dir with a tampered file fails; no register is unparseable', () => {
  const root = mkdtempSync(join(tmpdir(), 't029-hash-'))
  try {
    const dir = join(root, 'modules', 'x', 'migrations')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '001_a.sql'), 'select 1;\n')
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ '001_a.sql': createHash('sha256').update('other').digest('hex') }))
    assert.equal(runMigrationHashSuite({ root }).unparseable, true, 'no register yet')
    mkdirSync(join(root, 'scripts', 'migrations'), { recursive: true })
    writeFileSync(join(root, 'scripts', 'migrations', 'ranges.json'), JSON.stringify({ chains: [{ id: 'x', manifestDirs: ['modules/x/migrations'] }] }))
    const r = runMigrationHashSuite({ root })
    assert.equal(r.unparseable, false)
    assert.equal(r.failed, 1)
    assert.match(r.detail, /hash mismatch: 001_a\.sql/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('every other scripts/migrations suite collects exactly its declared top-level test() count', () => {
  const suites = readdirSync(HERE).filter((f) => f.endsWith('.test.mjs') && f !== 'wiring.test.mjs')
  assert.ok(suites.length >= 3, `found ${suites.length} suite(s)`)
  // a child `node --test` under this test runner would report to it over
  // NODE_TEST_CONTEXT instead of printing TAP; run it as a standalone process
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  for (const s of suites) {
    const declared = (readFileSync(join(HERE, s), 'utf8').match(/^test\(/gm) ?? []).length
    const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', join(HERE, s)], { encoding: 'utf8', cwd: REPO_ROOT, env, maxBuffer: 32 * 1024 * 1024 })
    assert.equal(r.status, 0, `${s} failed:\n${r.stdout.slice(-2000)}`)
    const plan = [...r.stdout.replace(/\r/g, '').matchAll(/^1\.\.(\d+)$/gm)].at(-1)?.[1]
    assert.ok(declared > 0, `${s} declares no top-level test()`)
    assert.equal(Number(plan), declared, `${s}: declared ${declared}, node ran ${plan}`)
  }
})
