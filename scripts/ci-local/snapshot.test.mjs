import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { countDeclaredTests, evaluateRepo, main } from './snapshot.mjs'
import { discoverTestFiles } from './lib/discover.mjs'
import { findUnclaimed } from './lib/snapshot-core.mjs'
import { loadManifest } from './lib/manifest.mjs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

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
  // --test-reporter=tap: forced so lib/parse-output.mjs's TAP "# tests"
  // regex has something to match — the installed Node's `node --test` with
  // no reporter flag defaults to the human-facing "spec" reporter (no "#
  // tests" line at all) even when stdout is piped, not just on a TTY.
  const perRepo = (prefix) => [
    { ...suite(`${prefix}-unit`, 'unit', 'node --test --test-reporter=tap a.test.mjs', ['a.test.mjs']), repo: prefix },
    { ...suite(`${prefix}-integration`, 'integration', 'node --test --test-reporter=tap a.test.mjs', ['a.test.mjs'], true), repo: prefix },
    { ...suite(`${prefix}-e2e`, 'e2e', 'node --test --test-reporter=tap a.test.mjs', ['a.test.mjs'], true), repo: prefix },
    { ...suite(`${prefix}-shell`, 'shell', 'node --test --test-reporter=tap a.test.mjs', ['a.test.mjs']), repo: prefix },
    { ...suite(`${prefix}-guard`, 'tree-guard', 'node --test --test-reporter=tap a.test.mjs && node -e "process.exit(0)"', ['a.test.mjs']), repo: prefix },
  ]
  const manifest = { kernel: perRepo('kernel'), vertical: perRepo('vertical') }
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

test('evaluateRepo: with --stack-env naming a file that EXISTS, a requiresStack suite actually runs (and PASSes, since the fixture command is cheap)', () => {
  const root = makeFixtureRepo()
  const manifestDir = mkdtempSync(join(tmpdir(), 'ci-local-manifest-'))
  try {
    const manifestPath = writeFixtureManifest(manifestDir)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const stackEnvFile = join(manifestDir, 'stack.env')
    writeFileSync(stackEnvFile, '')
    const rows = evaluateRepo('kernel', root, manifest, undefined, stackEnvFile)
    const integration = rows.find((r) => r.id === 'kernel-integration')
    assert.equal(integration.status, 'PASS')
    assert.equal(integration.collected, 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(manifestDir, { recursive: true, force: true })
  }
})

test('evaluateRepo: LOW fix — with --stack-env naming a file that does NOT exist, a requiresStack suite still FAILs "no stack" (does not try to actually run against no stack)', () => {
  const root = makeFixtureRepo()
  const manifestDir = mkdtempSync(join(tmpdir(), 'ci-local-manifest-'))
  try {
    const manifestPath = writeFixtureManifest(manifestDir)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const rows = evaluateRepo('kernel', root, manifest, undefined, join(manifestDir, 'does-not-exist.env'))
    const integration = rows.find((r) => r.id === 'kernel-integration')
    assert.equal(integration.status, 'FAIL')
    assert.match(integration.reason, /does not exist/)
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
  const vertical = makeFixtureRepo()
  const manifestDir = mkdtempSync(join(tmpdir(), 'ci-local-manifest-'))
  const outDir = mkdtempSync(join(tmpdir(), 'ci-local-out-'))
  try {
    writeFileSync(join(vertical, 'untracked.txt'), 'surprise')
    const manifestPath = writeFixtureManifest(manifestDir)
    const code = withCleanExitCode(() =>
      main(['--kernel', kernel, '--vertical', vertical, '--out', outDir, '--manifest', manifestPath]),
    )
    assert.equal(code, 1)
    assert.deepEqual(readdirSync(outDir), [])
  } finally {
    rmSync(kernel, { recursive: true, force: true })
    rmSync(vertical, { recursive: true, force: true })
    rmSync(manifestDir, { recursive: true, force: true })
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('main(): refuses an invalid manifest (missing category coverage) — exits non-zero, writes nothing', () => {
  const kernel = makeFixtureRepo()
  const vertical = makeFixtureRepo()
  const manifestDir = mkdtempSync(join(tmpdir(), 'ci-local-manifest-'))
  const outDir = mkdtempSync(join(tmpdir(), 'ci-local-out-'))
  try {
    const bad = { kernel: [{ id: 'x', category: 'unit', cwd: '.', kind: 'node-test', command: 'true', testGlobs: [] }], vertical: [] }
    const p = join(manifestDir, 'bad.json')
    writeFileSync(p, JSON.stringify(bad))
    const code = withCleanExitCode(() => main(['--kernel', kernel, '--vertical', vertical, '--out', outDir, '--manifest', p]))
    assert.equal(code, 1)
    assert.deepEqual(readdirSync(outDir), [])
  } finally {
    rmSync(kernel, { recursive: true, force: true })
    rmSync(vertical, { recursive: true, force: true })
    rmSync(manifestDir, { recursive: true, force: true })
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('main(): requires --kernel, --vertical and --out', () => {
  const code = withCleanExitCode(() => main([]))
  assert.equal(code, 1)
})

test('main(): happy path writes <date>-<ksha7>-<ssha7>.json and .md, names both SHAs/branches, and exits non-zero on the expected "no stack" FAILs', () => {
  const kernel = makeFixtureRepo()
  const vertical = makeFixtureRepo()
  const manifestDir = mkdtempSync(join(tmpdir(), 'ci-local-manifest-'))
  const outDir = mkdtempSync(join(tmpdir(), 'ci-local-out-'))
  try {
    const manifestPath = writeFixtureManifest(manifestDir)
    const code = withCleanExitCode(() =>
      main(['--kernel', kernel, '--vertical', vertical, '--out', outDir, '--manifest', manifestPath]),
    )
    assert.equal(code, 1) // the fixture's integration/e2e suites FAIL "no stack" by design

    const kernelSha = execFileSync('git', ['-C', kernel, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim().slice(0, 7)
    const verticalSha = execFileSync('git', ['-C', vertical, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim().slice(0, 7)
    const files = readdirSync(outDir)
    const jsonFile = files.find((f) => f.endsWith('.json'))
    const mdFile = files.find((f) => f.endsWith('.md'))
    assert.ok(jsonFile, 'expected a .json snapshot file')
    assert.ok(mdFile, 'expected a .md snapshot file')
    assert.match(jsonFile, new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${kernelSha}-${verticalSha}\\.json$`))

    const snapshot = JSON.parse(readFileSync(join(outDir, jsonFile), 'utf8'))
    assert.equal(snapshot.kernel.shortSha, kernelSha)
    assert.equal(snapshot.vertical.shortSha, verticalSha)
    assert.equal(snapshot.kernel.branch, 'main')
    assert.equal(snapshot.suites.length, 10) // 5 categories x 2 repos, no orphans in this fixture
    assert.equal(snapshot.overallExit, 1)

    const md = readFileSync(join(outDir, mdFile), 'utf8')
    assert.match(md, /overall exit: 1/)
  } finally {
    rmSync(kernel, { recursive: true, force: true })
    rmSync(vertical, { recursive: true, force: true })
    rmSync(manifestDir, { recursive: true, force: true })
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('main(): an --only id that names no suite exits non-zero with an only:<id> FAIL row, even though every suite that did run PASSed (MEDIUM fix)', () => {
  const kernel = makeFixtureRepo()
  const vertical = makeFixtureRepo()
  const manifestDir = mkdtempSync(join(tmpdir(), 'ci-local-manifest-'))
  const outDir = mkdtempSync(join(tmpdir(), 'ci-local-out-'))
  try {
    const manifestPath = writeFixtureManifest(manifestDir)
    const code = withCleanExitCode(() =>
      main(['--kernel', kernel, '--vertical', vertical, '--out', outDir, '--manifest', manifestPath, '--only', 'kernel-unit,kernel-unti']),
    )
    assert.equal(code, 1)
    const snapshot = JSON.parse(readFileSync(join(outDir, readdirSync(outDir).find((f) => f.endsWith('.json'))), 'utf8'))
    assert.equal(snapshot.suites.find((r) => r.id === 'kernel-unit').status, 'PASS')
    const unknown = snapshot.suites.find((r) => r.id === 'only:kernel-unti')
    assert.equal(unknown.status, 'FAIL')
  } finally {
    rmSync(kernel, { recursive: true, force: true })
    rmSync(vertical, { recursive: true, force: true })
    rmSync(manifestDir, { recursive: true, force: true })
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('main(): a --only subset reading never writes the same filename as a full reading of the same tips, and is marked PARTIAL in the .md (MEDIUM fix — a subset that happened to pass used to overwrite a full F1/re-init reading with no way to tell them apart from the filename alone)', () => {
  const kernel = makeFixtureRepo()
  const vertical = makeFixtureRepo()
  const manifestDir = mkdtempSync(join(tmpdir(), 'ci-local-manifest-'))
  const outDir = mkdtempSync(join(tmpdir(), 'ci-local-out-'))
  try {
    const manifestPath = writeFixtureManifest(manifestDir)
    // A full reading first (still non-zero exit — integration/e2e "no
    // stack" by design — but that is irrelevant to this test).
    withCleanExitCode(() => main(['--kernel', kernel, '--vertical', vertical, '--out', outDir, '--manifest', manifestPath]))
    const filesAfterFull = readdirSync(outDir)
    const fullJson = filesAfterFull.find((f) => f.endsWith('.json'))
    assert.ok(fullJson, 'expected the full reading to have written a .json')

    // A partial (--only) reading of the SAME tips, same day, right after.
    withCleanExitCode(() =>
      main(['--kernel', kernel, '--vertical', vertical, '--out', outDir, '--manifest', manifestPath, '--only', 'kernel-unit,vertical-unit']),
    )
    const filesAfterPartial = readdirSync(outDir)

    // The full reading's files must still exist, untouched.
    assert.ok(filesAfterPartial.includes(fullJson), 'the partial run must not have overwritten the full .json')
    assert.ok(filesAfterPartial.includes(fullJson.replace(/\.json$/, '.md')), 'the partial run must not have overwritten the full .md')

    // The partial run wrote its OWN, differently-named files.
    const partialJson = filesAfterPartial.find((f) => f.endsWith('.json') && f !== fullJson)
    assert.ok(partialJson, 'expected the partial reading to have written its own .json, distinct from the full one')
    assert.match(partialJson, /-partial\.json$/)

    const partialMd = readFileSync(join(outDir, partialJson.replace(/\.json$/, '.md')), 'utf8')
    assert.match(partialMd, /PARTIAL/)
    assert.match(partialMd, /kernel-unit/)
    assert.match(partialMd, /vertical-unit/)

    // The full reading's own .md must NOT claim to be partial.
    const fullMd = readFileSync(join(outDir, fullJson.replace(/\.json$/, '.md')), 'utf8')
    assert.doesNotMatch(fullMd, /PARTIAL/)
  } finally {
    rmSync(kernel, { recursive: true, force: true })
    rmSync(vertical, { recursive: true, force: true })
    rmSync(manifestDir, { recursive: true, force: true })
    rmSync(outDir, { recursive: true, force: true })
  }
})

// --- TASK-012-FU review finding 3 (MEDIUM) ----------------------------------
// The main sync (a0280fc) brought in packages/storage (TASK-117),
// packages/generated-clients, ops/scripts's compliance guard (TASK-005) and
// test/f1-defect/guards (TASK-009), none of which any kernel suite in the
// COMMITTED suites.json claimed. Every reading of the merged kernel tip was
// therefore RED on 18 "unclaimed" rows regardless of any suite's own health.
// This runs the real committed manifest against the real tree (no fixture,
// no injected manifest — the exact thing snapshot.mjs's own run does), so a
// future merge that lands a new package/service without a matching suite
// entry is caught here rather than only on the next live snapshot.

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

test('TASK-012-FU review finding 3: every real kernel test file on this tree is claimed by some suite in the committed scripts/ci-local/suites.json', () => {
  const manifest = loadManifest(join(REPO_ROOT, 'scripts', 'ci-local', 'suites.json'))
  const discovered = discoverTestFiles(REPO_ROOT)
  const unclaimed = findUnclaimed(discovered, manifest.kernel)
  assert.deepEqual(unclaimed, [], `unclaimed kernel test file(s) — add or extend a suites.json entry to claim them:\n${unclaimed.join('\n')}`)
})

// ---------------------------------------------------------------------------
// Kernel-only checkout: --vertical is optional.
// ---------------------------------------------------------------------------

/** Runs main() capturing console.log/error lines and the exit code. */
function runMain(argv) {
  const out = []
  const origLog = console.log
  const origErr = console.error
  console.log = (...a) => out.push(a.join(' '))
  console.error = (...a) => out.push(a.join(' '))
  let code
  try {
    code = withCleanExitCode(() => main(argv))
  } finally {
    console.log = origLog
    console.error = origErr
  }
  return { code, out: out.join('\n') }
}

function readSnapshot(outDir) {
  const json = readdirSync(outDir).find((f) => f.endsWith('.json'))
  return JSON.parse(readFileSync(join(outDir, json), 'utf8'))
}

test('main(): no --vertical -> kernel suites run, every vertical suite is reported SKIPPED (visible, never PASS), exit 0', () => {
  const kernel = makeFixtureRepo()
  const manifestDir = mkdtempSync(join(tmpdir(), 'ci-local-manifest-'))
  const outDir = mkdtempSync(join(tmpdir(), 'ci-local-out-'))
  try {
    const manifestPath = writeFixtureManifest(manifestDir)
    const { code, out } = runMain([
      '--kernel', kernel, '--out', outDir, '--manifest', manifestPath,
      '--only', 'kernel-unit,kernel-shell,kernel-guard,vertical-unit,vertical-e2e',
    ])
    assert.equal(code, 0, out)
    const snap = readSnapshot(outDir)
    const byId = Object.fromEntries(snap.suites.map((r) => [r.id, r]))
    assert.equal(byId['kernel-unit'].status, 'PASS')
    for (const id of ['vertical-unit', 'vertical-e2e']) {
      assert.equal(byId[id].status, 'SKIPPED')
      assert.equal(byId[id].repo, 'vertical')
      assert.match(byId[id].reason, /skipped: no --vertical/)
    }
    assert.equal(snap.suites.filter((r) => r.status === 'PASS').length, 3, 'skipped rows must not count as passed')
    assert.equal(snap.vertical, null)
    assert.match(out, /skipped: no --vertical/)
    assert.match(readFileSync(join(outDir, readdirSync(outDir).find((f) => f.endsWith('.md'))), 'utf8'), /SKIPPED/)
  } finally {
    rmSync(kernel, { recursive: true, force: true })
    rmSync(manifestDir, { recursive: true, force: true })
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('main(): no --vertical still exits 1 when a kernel suite fails', () => {
  const kernel = makeFixtureRepo("import test from 'node:test'\ntest('bad', () => { throw new Error('x') })\n")
  const manifestDir = mkdtempSync(join(tmpdir(), 'ci-local-manifest-'))
  const outDir = mkdtempSync(join(tmpdir(), 'ci-local-out-'))
  try {
    const manifestPath = writeFixtureManifest(manifestDir)
    const { code } = runMain(['--kernel', kernel, '--out', outDir, '--manifest', manifestPath, '--only', 'kernel-unit'])
    assert.equal(code, 1)
  } finally {
    rmSync(kernel, { recursive: true, force: true })
    rmSync(manifestDir, { recursive: true, force: true })
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('main(): --vertical given -> vertical suites are evaluated and included (not skipped)', () => {
  const kernel = makeFixtureRepo()
  const vertical = makeFixtureRepo()
  const manifestDir = mkdtempSync(join(tmpdir(), 'ci-local-manifest-'))
  const outDir = mkdtempSync(join(tmpdir(), 'ci-local-out-'))
  try {
    const manifestPath = writeFixtureManifest(manifestDir)
    const { code } = runMain([
      '--kernel', kernel, '--vertical', vertical, '--out', outDir, '--manifest', manifestPath,
      '--only', 'kernel-unit,vertical-unit',
    ])
    assert.equal(code, 0)
    const snap = readSnapshot(outDir)
    const byId = Object.fromEntries(snap.suites.map((r) => [r.id, r]))
    assert.equal(byId['vertical-unit'].status, 'PASS')
    assert.ok(snap.vertical.sha)
  } finally {
    rmSync(kernel, { recursive: true, force: true })
    rmSync(vertical, { recursive: true, force: true })
    rmSync(manifestDir, { recursive: true, force: true })
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('main(): a --vertical path that does not exist is a loud error, not a silent skip', () => {
  const kernel = makeFixtureRepo()
  const manifestDir = mkdtempSync(join(tmpdir(), 'ci-local-manifest-'))
  const outDir = mkdtempSync(join(tmpdir(), 'ci-local-out-'))
  try {
    const manifestPath = writeFixtureManifest(manifestDir)
    const { code, out } = runMain([
      '--kernel', kernel, '--vertical', '/nonexistent/vertical-checkout', '--out', outDir, '--manifest', manifestPath,
    ])
    assert.equal(code, 1)
    assert.match(out, /--vertical path '\/nonexistent\/vertical-checkout' does not exist/)
    assert.deepEqual(readdirSync(outDir), [])
  } finally {
    rmSync(kernel, { recursive: true, force: true })
    rmSync(manifestDir, { recursive: true, force: true })
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('main(): --list is a dry run — prints the plan (kernel suites + skipped vertical suites), runs nothing, needs no --out', () => {
  const kernel = makeFixtureRepo()
  const manifestDir = mkdtempSync(join(tmpdir(), 'ci-local-manifest-'))
  try {
    const manifestPath = writeFixtureManifest(manifestDir)
    const { code, out } = runMain(['--kernel', kernel, '--list', '--manifest', manifestPath])
    assert.equal(code, 0)
    assert.match(out, /WOULD RUN .*kernel-unit/)
    assert.match(out, /SKIPPED .*vertical-unit.*skipped: no --vertical/)
    assert.doesNotMatch(out, /WOULD RUN .*vertical-unit/)
  } finally {
    rmSync(kernel, { recursive: true, force: true })
    rmSync(manifestDir, { recursive: true, force: true })
  }
})

test('main(): --list with --vertical lists vertical suites as WOULD RUN', () => {
  const kernel = makeFixtureRepo()
  const vertical = makeFixtureRepo()
  const manifestDir = mkdtempSync(join(tmpdir(), 'ci-local-manifest-'))
  try {
    const manifestPath = writeFixtureManifest(manifestDir)
    const { code, out } = runMain(['--kernel', kernel, '--vertical', vertical, '--list', '--manifest', manifestPath])
    assert.equal(code, 0)
    assert.match(out, /WOULD RUN .*vertical-unit/)
    assert.doesNotMatch(out, /skipped: no --vertical/)
  } finally {
    rmSync(kernel, { recursive: true, force: true })
    rmSync(vertical, { recursive: true, force: true })
    rmSync(manifestDir, { recursive: true, force: true })
  }
})
