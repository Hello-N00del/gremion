import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  walkFiles,
  discoverTestFiles,
  globToRegExp,
  matchesAny,
  filterMatching,
  TEST_FILE_RE,
} from './discover.mjs'

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'ci-local-discover-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, 'node_modules', 'x'), { recursive: true })
  mkdirSync(join(root, 'upstream', 'gremion'), { recursive: true })
  mkdirSync(join(root, 'test'), { recursive: true })
  writeFileSync(join(root, 'src', 'a.test.ts'), '')
  writeFileSync(join(root, 'src', 'b.ts'), '')
  writeFileSync(join(root, 'node_modules', 'x', 'x.test.ts'), '')
  writeFileSync(join(root, 'upstream', 'gremion', 'z.test.ts'), '')
  writeFileSync(join(root, 'test', 'unit.bats'), '')
  writeFileSync(join(root, '.env.example'), '')
  return root
}

test('walkFiles excludes node_modules and upstream, and reports POSIX-style relative paths', () => {
  const root = makeFixture()
  try {
    const files = walkFiles(root)
    assert.ok(files.includes('src/a.test.ts'))
    assert.ok(files.includes('src/b.ts'))
    assert.ok(files.includes('test/unit.bats'))
    assert.ok(!files.some((f) => f.includes('node_modules')))
    assert.ok(!files.some((f) => f.includes('upstream')))
    assert.ok(!files.some((f) => f.includes('\\')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('walkFiles keeps dotFILES but skips dot-DIRECTORIES', () => {
  const root = makeFixture()
  try {
    const files = walkFiles(root)
    assert.ok(files.includes('.env.example'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('discoverTestFiles finds only the five named test-file shapes, honouring the excludes', () => {
  const root = makeFixture()
  try {
    const found = discoverTestFiles(root)
    assert.deepEqual(found.sort(), ['src/a.test.ts', 'test/unit.bats'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('TEST_FILE_RE matches every named shape and rejects a plain .ts file', () => {
  for (const f of ['a.test.ts', 'a.spec.ts', 'a.test.mjs', 'a.bats', 'a_test.dart']) {
    assert.ok(TEST_FILE_RE.test(f), `expected ${f} to match`)
  }
  assert.ok(!TEST_FILE_RE.test('a.ts'))
})

test('globToRegExp: "dir/**/*.test.ts" matches nested files but not a sibling extension', () => {
  const re = globToRegExp('gremion-ui/src/**/*.test.ts')
  assert.ok(re.test('gremion-ui/src/lib/foo.test.ts'))
  assert.ok(re.test('gremion-ui/src/foo.test.ts'))
  assert.ok(!re.test('gremion-ui/src/foo.ts'))
  assert.ok(!re.test('gremion-public/src/foo.test.ts'))
})

test('globToRegExp: a literal path with no wildcard matches only itself', () => {
  const re = globToRegExp('scripts/check-cve-floors.test.mjs')
  assert.ok(re.test('scripts/check-cve-floors.test.mjs'))
  assert.ok(!re.test('scripts/check-cve-floors.mjs'))
})

test('matchesAny / filterMatching', () => {
  const globs = ['a/**/*.test.ts', 'b/x.bats']
  assert.ok(matchesAny(globs, 'a/y/z.test.ts'))
  assert.ok(matchesAny(globs, 'b/x.bats'))
  assert.ok(!matchesAny(globs, 'c/x.bats'))
  assert.deepEqual(filterMatching(globs, ['a/y/z.test.ts', 'c/x.bats', 'b/x.bats']), [
    'a/y/z.test.ts',
    'b/x.bats',
  ])
})
