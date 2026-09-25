import test from 'node:test'
import assert from 'node:assert/strict'
import { validateManifest, suitesFor, CATEGORIES } from './manifest.mjs'

function suite(id, category) {
  return { id, category, repo: 'kernel', cwd: '.', kind: 'guard', command: 'true', testGlobs: ['x.test.mjs'] }
}

function fullManifest() {
  const suites = CATEGORIES.map((c, i) => suite(`k-${i}`, c))
  const suites2 = CATEGORIES.map((c, i) => suite(`s-${i}`, c))
  return { kernel: suites, vertical: suites2 }
}

test('validateManifest is green when both repos cover every category', () => {
  assert.deepEqual(validateManifest(fullManifest()), [])
})

test('validateManifest goes RED when a repo is missing entirely', () => {
  const m = fullManifest()
  delete m.vertical
  const problems = validateManifest(m)
  assert.ok(problems.some((p) => p.includes("repo 'vertical'")))
})

test('validateManifest goes RED when one category has zero suites for a repo (the "empty category exits non-zero" post-condition)', () => {
  const m = fullManifest()
  m.kernel = m.kernel.filter((s) => s.category !== 'shell')
  const problems = validateManifest(m)
  assert.ok(problems.some((p) => p.includes("repo 'kernel'") && p.includes("category 'shell'")))
})

test('validateManifest goes RED on a duplicate suite id within one repo', () => {
  const m = fullManifest()
  m.kernel.push(suite('k-0', 'unit'))
  const problems = validateManifest(m)
  assert.ok(problems.some((p) => p.includes('duplicate suite id')))
})

test('validateManifest goes RED on an unknown category name', () => {
  const m = fullManifest()
  m.kernel[0] = suite('k-bad', 'not-a-real-category')
  const problems = validateManifest(m)
  assert.ok(problems.some((p) => p.includes('unknown category')))
})

test('suitesFor returns every suite for a repo when --only is not given', () => {
  const m = fullManifest()
  assert.equal(suitesFor(m, 'kernel', undefined).length, CATEGORIES.length)
  assert.equal(suitesFor(m, 'kernel', []).length, CATEGORIES.length)
})

test('suitesFor narrows to the given ids, preserving manifest order', () => {
  const m = fullManifest()
  const picked = suitesFor(m, 'kernel', ['k-2', 'k-0'])
  assert.deepEqual(
    picked.map((s) => s.id),
    ['k-0', 'k-2'],
  )
})

test('validateManifest goes RED on a suite with no testGlobs (it could never be reported absent and claims nothing)', () => {
  const m = fullManifest()
  m.kernel[0].testGlobs = []
  delete m.vertical[1].testGlobs
  const problems = validateManifest(m)
  assert.equal(problems.filter((p) => /has no testGlobs/.test(p)).length, 2)
})

test('the committed suites.json is valid', async () => {
  const { loadManifest } = await import('./manifest.mjs')
  const { fileURLToPath } = await import('node:url')
  assert.deepEqual(validateManifest(loadManifest(fileURLToPath(new URL('../suites.json', import.meta.url)))), [])
})
