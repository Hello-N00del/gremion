import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { countDeclaredTests, evaluateRepo, main } from './snapshot.mjs'

/** Calls fn(), then reports and restores process.exitCode (main() sets it as a side effect; never let a test leak it into this test file's own exit status). */
function withCleanExitCode(fn) {
  const before = process.exitCode
  process.exitCode = undefined
  fn()
  const result = process.exitCode
  process.exitCode = before
  return result
}

function gitRepo(root) {
  const run = (args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' })
  run(['init', '-q', '-b', 'main'])
  run(['config', 'user.email', 'ci-local-test@example.invalid'])
  run(['config', 'user.name', 'ci-local-test'])
  return run
}

function commitAll(run, message) {
  run(['add', '-A'])
  run(['commit', '-q', '-m', message])
}

// A tiny manifest covering all 5 categories for both repos with cheap,
// deterministic commands, so the full snapshot pipeline can run in well
// under a second per repo.
function writeFixtureManifest(dir) {
  const suite = (id, category, command, testGlobs, requiresStack = false) => ({
    id,
    repo: undefined, // filled per-repo below
    category,
    cwd: '.',
    kind: category === 'tree-guard' ? 'guard' : 'node-test',
    command,
    requiresStack,
    testGlobs,
  })
  const perRepo = (prefix) => [
    { ...suite(`${prefix}-unit`, 'unit', 'node --test a.test.mjs', ['a.test.mjs']), repo: prefix },
    { ...suite(`${prefix}-integration`, 'integration', 'node --test a.test.mjs', ['a.test.mjs'], true), repo: prefix },
    { ...suite(`${prefix}-e2e`, 'e2e', 'node --test a.test.mjs', ['a.test.mjs'], true), repo: prefix },
    { ...suite(`${prefix}-shell`, 'shell', 'node --test a.test.mjs', ['a.test.mjs']), repo: prefix },
    { ...suite(`${prefix}-guard`, 'tree-guard', 'node --test a.test.mjs && node -e "process.exit(0)"', ['a.test.mjs']), repo: prefix },
  ]
  const manifest = { kernel: perRepo('kernel'), sturaos: perRepo('sturaos') }
  const p = join(dir, 'fixture-suites.json')
  writeFileSync(p, JSON.stringify(manifest, null, 2))
  return p
}

const PASSING_TEST_MJS = `
import test from 'node:test'
test('one', () => {})
test('two', () => {})
`

function makeFixtureRepo(testFileContent = PASSING_TEST_MJS) {
  const root = mkdtempSync(join(tmpdir(), 'ci-local-snapshot-'))
  const run = gitRepo(root)
  writeFileSync(join(root, 'a.test.mjs'), testFileContent)
  commitAll(run, 'seed')
  return root
}

test('countDeclaredTests sums top-level test( declarations across the given files, ignoring a non-.test.mjs file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-local-declared-'))
  try {
    writeFileSync(join(dir, 'a.test.mjs'), "test('x', () => {})\ntest('y', () => {})\n")
    writeFileSync(join(dir, 'b.test.mjs'), "test('z', () => {})\n")
    writeFileSync(join(dir, 'c.txt'), "test('should not count', () => {})\n")
    assert.equal(countDeclaredTests(dir, ['a.test.mjs', 'b.test.mjs', 'c.txt']), 3)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('countDeclaredTests is 0 (not a throw) for a file that does not exist', () => {
  assert.equal(countDeclaredTests('/nowhere', ['ghost.test.mjs']), 0)
})

test('evaluateRepo: unit/shell/tree-guard suites run for real and PASS; integration/e2e FAIL "no stack" without --stack-env; unclaimed files are reported', () => {
  const root = makeFixtureRepo()
  const manifestDir = mkdtempSync(join(tmpdir(), 'ci-local-manifest-'))
  try {
    writeFileSync(join(root, 'orphan.test.mjs'), "test('o', () => {})\n")
    const manifestPath = writeFixtureManifest(manifestDir)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const rows = evaluateRepo('kernel', root, manifest, undefined, undefined)

    const byId = Object.fromEntries(rows.map((r) => [r.id, r]))
    assert.equal(byId['kernel-unit'].status, 'PASS')
    assert.equal(byId['kernel-shell'].status, 'PASS')
    assert.equal(byId['kernel-guard'].status, 'PASS')
    assert.equal(byId['kernel-integration'].status, 'FAIL')
    assert.match(byId['kernel-integration'].reason, /no stack/)
    assert.equal(byId['kernel-e2e'].status, 'FAIL')

    const orphanRow = rows.find((r) => r.id === 'unclaimed:orphan.test.mjs')
    assert.ok(orphanRow, 'expected orphan.test.mjs to be reported as unclaimed')
    assert.equal(orphanRow.status, 'FAIL')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(manifestDir, { recursive: true, force: true })
  }
})

test('evaluateRepo: with --stack-env, a requiresStack suite actually runs (and PASSes, since the fixture command is cheap)', () => {
  const root = makeFixtureRepo()
  const manifestDir = mkdtempSync(join(tmpdir(), 'ci-local-manifest-'))
  try {
    const manifestPath = writeFixtureManifest(manifestDir)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const rows = evaluateRepo('kernel', root, manifest, undefined, '/some/stack.env')
    const integration = rows.find((r) => r.id === 'kernel-integration')
    assert.equal(integration.status, 'PASS')
    assert.equal(integration.collected, 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(manifestDir, { recursive: true, force: true })
  }
})

test('evaluateRepo: --only narrows which suites RUN, but unclaimed-file detection still uses the FULL manifest', () => {
  const root = makeFixtureRepo()
  const manifestDir = mkdtempSync(join(tmpdir(), 'ci-local-manifest-'))
  try {
    const manifestPath = writeFixtureManifest(manifestDir)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const rows = evaluateRepo('kernel', root, manifest, ['kernel-unit'], undefined)
    const suiteRows = rows.filter((r) => !r.id.startsWith('unclaimed:'))
    assert.deepEqual(suiteRows.map((r) => r.id), ['kernel-unit'])
    // a.test.mjs is claimed by every fixture suite's glob, so still no orphan here
    assert.equal(rows.some((r) => r.id.startsWith('unclaimed:')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(manifestDir, { recursive: true, force: true })
  }
})

test('evaluateRepo: declared-vs-collected catches a test file whose tests silently stopped registering, end-to-end through node --test', () => {
  // Throws before either test() call registers - node --test still exits 0
  // and reports "1..1" (one file, treated as one passing unit), not 0
  // collected. countDeclaredTests still finds 2 declared test(s).
  const root = makeFixtureRepo(`
import test from 'node:test'
if (true) { /* pretend a refactor broke registration */ }
`)
  writeFileSync(join(root, 'a.test.mjs'), "throw new Error('boom before any test() call')\ntest('x', () => {})\ntest('y', () => {})\n")
  execFileSync('git', ['-C', root, 'add', '-A'])
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'break registration'])
  const manifestDir = mkdtempSync(join(tmpdir(), 'ci-local-manifest-'))
  try {
    const manifestPath = writeFixtureManifest(manifestDir)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const rows = evaluateRepo('kernel', root, manifest, ['kernel-unit'], undefined)
    const row = rows.find((r) => r.id === 'kernel-unit')
    assert.equal(row.status, 'FAIL')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(manifestDir, { recursive: true, force: true })
  }
})

test('main(): refuses a dirty tree — no snapshot files are written', () => {
  const kernel = makeFixtureRepo()
  const sturaos = makeFixtureRepo()
  const manifestDir = mkdtempSync(join(tmpdir(), 'ci-local-manifest-'))
  const outDir = mkdtempSync(join(tmpdir(), 'ci-local-out-'))
  try {
    writeFileSync(join(sturaos, 'untracked.txt'), 'surprise')
    const manifestPath = writeFixtureManifest(manifestDir)
    const code = withCleanExitCode(() =>
      main(['--kernel', kernel, '--sturaos', sturaos, '--out', outDir, '--manifest', manifestPath]),
    )
    assert.equal(code, 1)
    assert.deepEqual(readdirSync(outDir), [])
  } finally {
    rmSync(kernel, { recursive: true, force: true })
    rmSync(sturaos, { recursive: true, force: true })
    rmSync(manifestDir, { recursive: true, force: true })
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('main(): refuses an invalid manifest (missing category coverage) — exits non-zero, writes nothing', () => {
  const kernel = makeFixtureRepo()
  const sturaos = makeFixtureRepo()
  const manifestDir = mkdtempSync(join(tmpdir(), 'ci-local-manifest-'))
  const outDir = mkdtempSync(join(tmpdir(), 'ci-local-out-'))
  try {
    const bad = { kernel: [{ id: 'x', category: 'unit', cwd: '.', kind: 'node-test', command: 'true', testGlobs: [] }], sturaos: [] }
    const p = join(manifestDir, 'bad.json')
    writeFileSync(p, JSON.stringify(bad))
    const code = withCleanExitCode(() => main(['--kernel', kernel, '--sturaos', sturaos, '--out', outDir, '--manifest', p]))
    assert.equal(code, 1)
    assert.deepEqual(readdirSync(outDir), [])
  } finally {
    rmSync(kernel, { recursive: true, force: true })
    rmSync(sturaos, { recursive: true, force: true })
    rmSync(manifestDir, { recursive: true, force: true })
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('main(): requires --kernel, --sturaos and --out', () => {
  const code = withCleanExitCode(() => main([]))
  assert.equal(code, 1)
})

test('main(): happy path writes <date>-<ksha7>-<ssha7>.json and .md, names both SHAs/branches, and exits non-zero on the expected "no stack" FAILs', () => {
  const kernel = makeFixtureRepo()
  const sturaos = makeFixtureRepo()
  const manifestDir = mkdtempSync(join(tmpdir(), 'ci-local-manifest-'))
  const outDir = mkdtempSync(join(tmpdir(), 'ci-local-out-'))
  try {
    const manifestPath = writeFixtureManifest(manifestDir)
    const code = withCleanExitCode(() =>
      main(['--kernel', kernel, '--sturaos', sturaos, '--out', outDir, '--manifest', manifestPath]),
    )
    assert.equal(code, 1) // the fixture's integration/e2e suites FAIL "no stack" by design

    const kernelSha = execFileSync('git', ['-C', kernel, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim().slice(0, 7)
    const sturaosSha = execFileSync('git', ['-C', sturaos, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim().slice(0, 7)
    const files = readdirSync(outDir)
    const jsonFile = files.find((f) => f.endsWith('.json'))
    const mdFile = files.find((f) => f.endsWith('.md'))
    assert.ok(jsonFile, 'expected a .json snapshot file')
    assert.ok(mdFile, 'expected a .md snapshot file')
    assert.match(jsonFile, new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${kernelSha}-${sturaosSha}\\.json$`))

    const snapshot = JSON.parse(readFileSync(join(outDir, jsonFile), 'utf8'))
    assert.equal(snapshot.kernel.shortSha, kernelSha)
    assert.equal(snapshot.sturaos.shortSha, sturaosSha)
    assert.equal(snapshot.kernel.branch, 'main')
    assert.equal(snapshot.suites.length, 10) // 5 categories x 2 repos, no orphans in this fixture
    assert.equal(snapshot.overallExit, 1)

    const md = readFileSync(join(outDir, mdFile), 'utf8')
    assert.match(md, /overall exit: 1/)
  } finally {
    rmSync(kernel, { recursive: true, force: true })
    rmSync(sturaos, { recursive: true, force: true })
    rmSync(manifestDir, { recursive: true, force: true })
    rmSync(outDir, { recursive: true, force: true })
  }
})
