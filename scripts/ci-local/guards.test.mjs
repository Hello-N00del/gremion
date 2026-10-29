import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { run } from './lib/run.mjs'
import {
  gitleaksCommand,
  parseGitleaksCommitsScanned,
  runGitleaksArm,
  baseRefResolves,
  runKnownSecretsArm,
  runVerticalNativeKnownSecretsArm,
  runCveFloorArm,
  runOverridesDriftArm,
  runRunnerPolicyArm,
  runAllArms,
  listDockerfiles,
  isSafeRef,
  runSteps,
  guardsResultFileName,
  defaultGuardsOutDir,
  main,
} from './guards.mjs'

function withCleanExitCode(fn) {
  const before = process.exitCode
  process.exitCode = undefined
  fn()
  const result = process.exitCode
  process.exitCode = before
  return result
}

function fakeRun(map) {
  // map: command substring -> {exitCode, output, timedOut, spawnError}.
  // Guard commands are argv arrays (no shell); match on the joined words.
  return (command) => {
    const text = Array.isArray(command) ? command.join(' ') : command
    for (const [needle, result] of Object.entries(map)) {
      if (text.includes(needle)) return result
    }
    throw new Error(`fakeRun: no fixture for command: ${text}`)
  }
}

test('gitleaksCommand always scans "." with a RELATIVE --config: the repo comes from the process cwd the caller runs it in, never from a path embedded in the command string, so an absolute-vs-relative repoPath can never change which .gitleaks.toml allowlist paths match (HIGH fix)', () => {
  const dirCmd = gitleaksCommand(undefined, '/tmp/report.json')
  assert.deepEqual(dirCmd, ['gitleaks', 'dir', '.', '--config', '.gitleaks.toml', '--redact', '--exit-code', '0', '--report-format', 'json', '--report-path', '/tmp/report.json', '--no-color'])
  const gitCmd = gitleaksCommand('main')
  assert.deepEqual(gitCmd, ['gitleaks', 'git', '.', '--log-opts', 'main..HEAD --diff-merges=first-parent', '--config', '.gitleaks.toml', '--redact', '--exit-code', '1', '--no-color'])
})

test('gitleaksCommand passes --no-color in both modes: gitleaks 8.30.1 colours ERR/FTL log lines even when piped, which put "m" (end of the SGR escape) rather than whitespace immediately before "ERR"/"FTL" and made hasFatalLog never match (HIGH fix)', () => {
  for (const cmd of [gitleaksCommand(undefined, '/tmp/r.json'), gitleaksCommand('main')]) {
    assert.ok(cmd.includes('--no-color'), cmd.join(' '))
  }
})

test('runGitleaksArm (diff-scoped) FAILs on a colourised ERR line even though gitleaks exited 0 — real gitleaks 8.30.1 bytes, not a hand-written fixture (HIGH fix, regression guard for the ANSI-color bug)', () => {
  // Byte-for-byte the output `gitleaks git ... ` produces WITHOUT --no-color
  // when `git log` fails mid-scan (a missing blob object) but gitleaks still
  // exits 0 — captured against the real 8.30.1 binary in a scratch repo with
  // a committed EC key and its blob object deleted (see gitleaksCommand's
  // header). \x1b[31m...\x1b[0m wraps "ERR"; the byte before "ERR" is "m".
  const coloured =
    '\x1b[90m10:33AM\x1b[0m \x1b[31mERR\x1b[0m \x1b[1m[git] fatal: unable to read 9526b5fc29df16146f806b6be9c499dbd429ffcd\x1b[0m\n' +
    '\x1b[90m10:33AM\x1b[0m \x1b[31mERR\x1b[0m \x1b[36merror=\x1b[0m\x1b[31m\x1b[1m"stderr is not empty"\x1b[0m\x1b[0m\n' +
    '\x1b[90m10:33AM\x1b[0m \x1b[32mINF\x1b[0m \x1b[1m1 commits scanned.\x1b[0m\n' +
    '\x1b[90m10:33AM\x1b[0m \x1b[32mINF\x1b[0m \x1b[1mno leaks found\x1b[0m\n'
  const r = runGitleaksArm('kernel', '/repo', 'basetag', {
    runFn: () => ({ exitCode: 0, output: coloured, timedOut: false, spawnError: null }),
    verifyBaseRefFn: () => true,
  })
  assert.equal(r.status, 'FAIL')
  assert.match(r.reason, /ERR\/FTL/)
})

test('runGitleaksArm (diff-scoped), real gitleaks 8.30.1 binary: a committed secret in the scanned range whose git blob object is missing (simulating a partial-fetch/promisor failure) must FAIL, never vacuously PASS — the exact scenario gitleaksCommand\'s header documents', { skip: (() => { try { execFileSync('gitleaks', ['version'], { stdio: 'ignore' }); return false } catch { return 'gitleaks binary not on PATH' } })() }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-local-gitleaks-repro-'))
  try {
    const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'ignore'] }).toString()
    git('init', '-q')
    execFileSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c'])
    execFileSync('git', ['-C', dir, 'config', 'user.name', 'tester'])
    writeFileSync(join(dir, 'README.md'), 'hello\n')
    git('add', 'README.md')
    git('commit', '-q', '-m', 'base')
    git('tag', 'basetag')
    // Assembled at runtime, not written as one contiguous literal — same
    // reason as PEM_FIXTURE below: this file is itself scanned by the real
    // whole-tree gitleaks arm (guards.mjs's own gate), and a literal
    // PEM header for an EC private key (five dashes, BEGIN, the key type, five
    // dashes) sitting in THIS source file would trip
    // that scan on every future run of this very test suite. Still fully
    // synthetic (a fake base64 body, never a real key).
    const pemFixture = ['-----BEGIN', ' EC PRIVATE KEY', '-----\n', 'MHcCAQEEIOSynthNotRealNotRealNotRealNotRealNotRealNotReal0123456\n', '-----END', ' EC PRIVATE KEY', '-----\n'].join('')
    writeFileSync(join(dir, 'secret.pem'), pemFixture)
    git('add', 'secret.pem')
    git('commit', '-q', '-m', 'add secret')
    writeFileSync(join(dir, '.gitleaks.toml'), '[extend]\nuseDefault = true\n')
    git('add', '.gitleaks.toml')
    git('commit', '-q', '-m', 'add config')
    const blob = git('rev-parse', 'HEAD~1:secret.pem').trim()
    const objPath = join(dir, '.git', 'objects', blob.slice(0, 2), blob.slice(2))
    rmSync(objPath, { force: true })

    const r = runGitleaksArm('kernel', dir, 'basetag', { runFn: run })
    // RED first: without --no-color this arm returns PASS (gitleaks logs the
    // git failure but still exits 0). The assertion below is what makes it
    // GREEN once gitleaksCommand's --no-color + hasFatalLog's ANSI strip are
    // both in place.
    assert.equal(r.status, 'FAIL', `expected FAIL (git failed to read a blob mid-scan), got ${r.status}: ${JSON.stringify(r.reason)}\n${r.output ?? ''}`)
    assert.match(r.reason, /ERR\/FTL/)
  } finally {
    // TASK-012-FU review (LOW): this fixture's own .git/objects had one blob
    // deleted by hand above — rmSync(..., {recursive:true}) removes the rest
    // of the tree without needing that object back.
    rmSync(dir, { recursive: true, force: true })
  }
})

test('isSafeRef accepts branch, remote, tag, SHA and rev-suffix refs, and refuses whitespace, a leading "-", ".." and shell metacharacters (CRITICAL fix)', () => {
  for (const ok of ['main', 'master', 'origin/main', 'release-1/local-integration', 'HEAD~1', 'HEAD^', '66acee6', 'v1.2.3', 'main@{u}']) {
    assert.equal(isSafeRef(ok), true, ok)
  }
  for (const bad of ['$(touch pwned)', 'main' + String.fromCharCode(96) + 'id' + String.fromCharCode(96), 'a b', '--output=/tmp/x', '-x', 'a..b', 'main;id', 'main|id', '', undefined]) {
    assert.equal(isSafeRef(bad), false, String(bad))
  }
})

test('runGitleaksArm (diff-scoped) refuses an unsafe --base before git or gitleaks ever sees it (CRITICAL fix)', () => {
  const never = () => {
    throw new Error('must never run anything for an unsafe base ref')
  }
  const r = runGitleaksArm('kernel', '/repo', '$(touch pwned)', { runFn: never, verifyBaseRefFn: never })
  assert.equal(r.status, 'FAIL')
  assert.match(r.reason, /not a plain ref name/)
})

test('runGitleaksArm (diff-scoped), REAL binary: --base reaches gitleaks as ONE argv element, spawned with no shell', () => {
  const root = makeSecretRepo()
  try {
    let seen
    const spy = (command, cwd, opts) => {
      seen = command
      return run(command, cwd, opts)
    }
    const r = runGitleaksArm('kernel', root, 'HEAD', { runFn: spy })
    assert.ok(Array.isArray(seen))
    assert.equal(seen[seen.indexOf('--log-opts') + 1], 'HEAD..HEAD --diff-merges=first-parent')
    assert.equal(r.status, 'PASS', JSON.stringify(r))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('runGitleaksArm (diff-scoped, --base given) is PASS on exit 0, FAIL on a non-zero exit (a leak found), via an injected runFn', () => {
  const clean = runGitleaksArm('kernel', '/repo', 'main', {
    runFn: fakeRun({ gitleaks: { exitCode: 0, output: 'no leaks found', timedOut: false, spawnError: null } }),
    verifyBaseRefFn: () => true,
  })
  assert.equal(clean.status, 'PASS')

  const dirty = runGitleaksArm('kernel', '/repo', 'main', {
    runFn: fakeRun({ gitleaks: { exitCode: 1, output: 'leak found', timedOut: false, spawnError: null } }),
    verifyBaseRefFn: () => true,
  })
  assert.equal(dirty.status, 'FAIL')
})

test('runGitleaksArm (diff-scoped) FAILs closed when the base ref does not resolve in THIS repo, instead of vacuously scanning an empty range (HIGH fix)', () => {
  const runFn = () => {
    throw new Error('must never run gitleaks over an unresolved base ref')
  }
  const r = runGitleaksArm('vertical', '/repo', 'main', { runFn, verifyBaseRefFn: () => false })
  assert.equal(r.status, 'FAIL')
  assert.match(r.reason, /does not resolve to a commit in vertical/)
})

test("runGitleaksArm (diff-scoped) FAILs when gitleaks logs an ERR/FTL line even if it happened to exit 0", () => {
  const r = runGitleaksArm('kernel', '/repo', 'main', {
    verifyBaseRefFn: () => true,
    runFn: fakeRun({ gitleaks: { exitCode: 0, output: 'FTL unable to load gitleaks config, err: bad toml', timedOut: false, spawnError: null } }),
  })
  assert.equal(r.status, 'FAIL')
  assert.match(r.reason, /ERR\/FTL/)
})

test('baseRefResolves: true for HEAD in a real repo, false for a ref that does not exist', () => {
  const root = makeSecretRepo()
  try {
    assert.equal(baseRefResolves(root, 'HEAD'), true)
    assert.equal(baseRefResolves(root, 'totally-not-a-real-ref'), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// Assembled at runtime, not written as one contiguous literal: this file is
// itself scanned by the real whole-tree gitleaks arm (guards.mjs's own
// gate), and a literal PEM private-key header (five dashes, BEGIN PRIVATE KEY,
// five dashes) sitting in THIS source
// file would trip that scan on every future run of this very test suite.
// The fixture it builds is still fully synthetic (a fake base64 body, never
// a real key) — only the marker text is split so it never appears
// contiguous in the committed source.
const PEM_FIXTURE = ['-----BEGIN', ' PRIVATE KEY', '-----\n', 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDSYN', 'THETIC\n', '-----END', ' PRIVATE KEY', '-----\n'].join('')

test('runGitleaksArm (whole-tree, no --base), REAL binary: a committed synthetic PEM key goes RED end-to-end, and GREEN once removed (TDD item 5)', () => {
  const root = makeSecretRepo()
  try {
    writeFileSync(join(root, 'fixture.pem'), PEM_FIXTURE)
    execFileSync('git', ['-C', root, 'add', 'fixture.pem'])
    execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'seed a synthetic PEM'])
    const red = runGitleaksArm('kernel', root, undefined)
    assert.equal(red.status, 'FAIL', `expected RED with the PEM present; got: ${JSON.stringify(red)}`)

    execFileSync('git', ['-C', root, 'rm', '-q', 'fixture.pem'])
    execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'remove the synthetic PEM'])
    const green = runGitleaksArm('kernel', root, undefined)
    assert.equal(green.status, 'PASS', `expected GREEN once removed; got: ${JSON.stringify(green)}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('runGitleaksArm (whole-tree, no --base), REAL binary: a broken .gitleaks.toml FAILs the arm instead of silently passing (HIGH fix — this is the exact bug the review found)', () => {
  const root = makeSecretRepo()
  try {
    writeFileSync(join(root, '.gitleaks.toml'), 'this is not valid toml {{{\n')
    execFileSync('git', ['-C', root, 'add', '.gitleaks.toml'])
    execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'break the gitleaks config'])
    const r = runGitleaksArm('kernel', root, undefined)
    assert.equal(r.status, 'FAIL', `a broken config must FAIL, never silently PASS; got: ${JSON.stringify(r)}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('runGitleaksArm (whole-tree) FAILs when the report is missing despite a reported exit 0 (a corrupted/incomplete run must never read as "0 findings")', () => {
  const runFn = () => ({ exitCode: 0, output: 'no leaks found', timedOut: false, spawnError: null }) // never writes the report file
  const root = makeSecretRepo()
  try {
    const r = runGitleaksArm('kernel', root, undefined, { runFn })
    assert.equal(r.status, 'FAIL')
    assert.match(r.reason, /could not read gitleaks report/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('runGitleaksArm (whole-tree) FAILs when the report file is not valid JSON (never coerced to "0 findings")', () => {
  const runFn = (command) => {
    writeFileSync(command[command.indexOf('--report-path') + 1], 'not json at all {{{')
    return { exitCode: 0, output: 'no leaks found', timedOut: false, spawnError: null }
  }
  const root = makeSecretRepo()
  try {
    const r = runGitleaksArm('kernel', root, undefined, { runFn })
    assert.equal(r.status, 'FAIL')
    assert.match(r.reason, /could not read gitleaks report/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('runGitleaksArm (whole-tree) FAILs when gitleaks exits non-zero (dir mode uses --exit-code 0, so a non-zero exit is always an error, never "leaks found")', () => {
  const runFn = () => ({ exitCode: 1, output: 'FTL unable to load gitleaks config', timedOut: false, spawnError: null })
  const root = makeSecretRepo()
  try {
    const r = runGitleaksArm('kernel', root, undefined, { runFn })
    assert.equal(r.status, 'FAIL')
    assert.match(r.reason, /exited 1/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('runGitleaksArm (whole-tree, no --base) filters the JSON report down to git-TRACKED files — an untracked/gitignored local file\'s "leak" never fails the guard', () => {
  const root = makeSecretRepo()
  try {
    // an untracked local file that gitleaks' raw filesystem walk would see,
    // but that can never reach a merge.
    writeFileSync(join(root, 'local-only.json'), '{"token":"whatever"}')
    const runFn = (command) => {
      writeFileSync(
        command[command.indexOf('--report-path') + 1],
        JSON.stringify([
          { File: join(root, 'local-only.json'), RuleID: 'generic-api-key' },
          { File: join(root, '.env'), RuleID: 'generic-api-key' }, // this one IS tracked
        ]),
      )
      return { exitCode: 0, output: 'leaks found: 2', timedOut: false, spawnError: null }
    }
    const r = runGitleaksArm('kernel', root, undefined, { runFn })
    assert.equal(r.status, 'FAIL')
    assert.match(r.reason, /1 leak\(s\) in tracked files \(of 2 raw match\(es\)/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('runGitleaksArm (whole-tree, no --base) is PASS when every raw finding is in an untracked file', () => {
  const root = makeSecretRepo()
  try {
    writeFileSync(join(root, 'local-only.json'), '{"token":"whatever"}')
    const runFn = (command) => {
      writeFileSync(command[command.indexOf('--report-path') + 1], JSON.stringify([{ File: join(root, 'local-only.json'), RuleID: 'generic-api-key' }]))
      return { exitCode: 0, output: 'leaks found: 1', timedOut: false, spawnError: null }
    }
    const r = runGitleaksArm('kernel', root, undefined, { runFn })
    assert.equal(r.status, 'PASS')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('runGitleaksArm proves the real binary is on PATH for this test run (missing-binary detection is proved in guards.mjs\'s own header/README, not re-mocked here to avoid hiding a real absence)', () => {
  // If gitleaks really were missing, this would fail closed with a clear reason.
  const result = runGitleaksArm('kernel', process.cwd(), undefined, {
    runFn: () => ({ exitCode: 0, output: 'no leaks found', timedOut: false, spawnError: null }),
  })
  assert.notEqual(result.reason, 'gitleaks binary not found on PATH — a missing scanner is a failure, never a skip')
})

test('runGitleaksArm, missing binary: with gitleaks off PATH the arm FAILs with its own reason, in both modes, and never runs a scan (TDD item 5)', () => {
  const saved = process.env.PATH
  const never = () => {
    throw new Error('must never run a scan when the binary is missing')
  }
  try {
    process.env.PATH = ''
    for (const base of [undefined, 'main']) {
      const r = runGitleaksArm('kernel', process.cwd(), base, { runFn: never, verifyBaseRefFn: () => true })
      assert.equal(r.status, 'FAIL')
      assert.match(r.reason, /gitleaks binary not found on PATH/)
    }
  } finally {
    process.env.PATH = saved
  }
})

test('runGitleaksArm (diff-scoped), REAL binary: a synthetic PEM committed after the base goes RED; with the key removed again the range is GREEN; a base that does not exist in this repo FAILs', () => {
  const root = makeSecretRepo()
  try {
    const base = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    writeFileSync(join(root, 'fixture.pem'), PEM_FIXTURE)
    execFileSync('git', ['-C', root, 'add', 'fixture.pem'])
    execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'seed a synthetic PEM'])
    const red = runGitleaksArm('vertical', root, base)
    assert.equal(red.status, 'FAIL', `expected RED with the PEM in the range; got: ${JSON.stringify(red)}`)
    assert.match(red.reason, /leak in the diff/)

    // Drop the seed commit: the branch no longer adds the key.
    execFileSync('git', ['-C', root, 'reset', '-q', '--hard', base])
    const green = runGitleaksArm('vertical', root, base)
    assert.equal(green.status, 'PASS', `expected GREEN once removed; got: ${JSON.stringify(green)}`)

    const missing = runGitleaksArm('vertical', root, 'release-1/does-not-exist-here')
    assert.equal(missing.status, 'FAIL')
    assert.match(missing.reason, /does not resolve to a commit/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('runGitleaksArm (diff-scoped), REAL binary: a synthetic PEM key added ONLY in a merge commit\'s own conflict resolution (present in neither parent\'s tree) FAILs the range scan (HIGH fix — TASK-012-FU review: plain `git log -p` shows NO diff at all for a merge commit unless told to, so a credential introduced solely by resolving a merge conflict passed unseen; unit branches routinely carry sync merges with conflict resolutions, e.g. this very branch\'s a0280fc)', () => {
  const root = makeSecretRepo()
  try {
    const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' })
    const base = git('rev-parse', 'HEAD').trim()

    writeFileSync(join(root, 'conflict.txt'), 'line1\n')
    git('add', 'conflict.txt')
    git('commit', '-q', '-m', 'seed conflict.txt')

    git('checkout', '-q', '-b', 'side')
    writeFileSync(join(root, 'conflict.txt'), 'line1\nfrom-side\n')
    git('commit', '-q', '-am', 'side change')

    git('checkout', '-q', 'main')
    writeFileSync(join(root, 'conflict.txt'), 'line1\nfrom-main\n')
    git('commit', '-q', '-am', 'main change')

    try {
      git('merge', '--no-ff', '-m', 'merge side', 'side')
    } catch {
      // Expected: conflicting edits to conflict.txt. Resolved by hand below.
    }
    // The PEM exists in NEITHER parent's tree — only here, in the merge
    // commit's own resolved content.
    writeFileSync(join(root, 'conflict.txt'), `line1\nfrom-main\nfrom-side\n${PEM_FIXTURE}`)
    git('add', 'conflict.txt')
    git('commit', '-q', '-m', 'merge: resolve conflict (adds the PEM)')

    const r = runGitleaksArm('kernel', root, base)
    assert.equal(r.status, 'FAIL', `expected FAIL — the PEM was added only in the merge commit's own conflict resolution; got: ${JSON.stringify(r)}`)
    assert.match(r.reason, /leak in the diff/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

function makeSecretRepo(sentinelEnvLine) {
  const root = mkdtempSync(join(tmpdir(), 'ci-local-guards-secrets-'))
  const run = (args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' })
  run(['init', '-q', '-b', 'main'])
  run(['config', 'user.email', 'ci-local-test@example.invalid'])
  run(['config', 'user.name', 'ci-local-test'])
  // gitleaksCommand now always points --config at a CWD-relative
  // ".gitleaks.toml" (the HIGH fix for the absolute-path allowlist bug), so
  // every real-binary fixture repo needs its own, exactly like a real
  // kernel/StuRaOS checkout does.
  writeFileSync(join(root, '.gitleaks.toml'), '[extend]\nuseDefault = true\n')
  writeFileSync(join(root, '.env'), sentinelEnvLine ?? 'FINE=ok\n')
  run(['add', '.env', '.gitleaks.toml'])
  run(['commit', '-q', '-m', 'seed'])
  return root
}

test('runKnownSecretsArm PASSes on a clean scratch repo (KNOWN_COMPROMISED is empty, so this is a real, non-mocked pass)', () => {
  const root = makeSecretRepo()
  try {
    const r = runKnownSecretsArm('kernel', root)
    assert.equal(r.status, 'PASS')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('runKnownSecretsArm: an entry-point-level FAIL on an injected --known-secrets-denylist sentinel, with no code edit (HIGH fix: the kernel denylist starts empty, so without this injection point the arm could never be observed failing except by unit-testing scanRepo directly)', () => {
  const root = makeSecretRepo()
  const SENTINEL = 'sentinel-ci-local-guards-entrypoint-fixture-4e21ab'
  const digest = createHash('sha256').update(SENTINEL).digest('hex')
  const denylistDir = mkdtempSync(join(tmpdir(), 'ci-local-guards-denylist-'))
  try {
    writeFileSync(join(root, 'leaked.env'), `TOKEN=${SENTINEL}\n`)
    execFileSync('git', ['-C', root, 'add', 'leaked.env'])
    execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'seed a denylisted sentinel'])

    const clean = runKnownSecretsArm('kernel', root)
    assert.equal(clean.status, 'PASS', 'no denylist injected yet — must not false-positive')

    const denylistPath = join(denylistDir, 'denylist.json')
    writeFileSync(denylistPath, JSON.stringify({ [digest]: 'injected sentinel' }))
    const red = runKnownSecretsArm('kernel', root, { denylistPath })
    assert.equal(red.status, 'FAIL')
    assert.match(red.reason, /1 known-compromised digest match/)
    // LOW fix: a RED here must say WHERE (file:line), not just a bare count.
    assert.deepEqual(red.findings, [{ file: 'leaked.env', line: 1 }])
    assert.equal(JSON.stringify(red.findings).includes(SENTINEL), false, 'the matched value itself must never appear in the arm result')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(denylistDir, { recursive: true, force: true })
  }
})

test('runKnownSecretsArm is FAIL when scanRepo throws (0 tracked files) — never silently green', () => {
  const root = mkdtempSync(join(tmpdir(), 'ci-local-guards-empty-'))
  try {
    execFileSync('git', ['-C', root, 'init', '-q', '-b', 'main'])
    const r = runKnownSecretsArm('kernel', root)
    assert.equal(r.status, 'FAIL')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('runVerticalNativeKnownSecretsArm runs StuRaOS\'s OWN check-no-known-secrets.mjs (its 2 real incident digests), PASS/FAIL by the injected command\'s exit code (HIGH fix: the kernel-ported known-secrets.mjs arm can never fail on its own empty denylist, so StuRaOS\'s real incidents need its own script run too)', () => {
  const pass = runVerticalNativeKnownSecretsArm('/vertical', {
    runFn: fakeRun({ 'check-no-known-secrets': { exitCode: 0, output: '# tests 2\nok', timedOut: false, spawnError: null } }),
  })
  assert.equal(pass.status, 'PASS')
  assert.equal(pass.arm, 'known-secrets-vertical-native')
  const fail = runVerticalNativeKnownSecretsArm('/vertical', {
    runFn: fakeRun({ 'check-no-known-secrets': { exitCode: 1, output: 'FOUND', timedOut: false, spawnError: null } }),
  })
  assert.equal(fail.status, 'FAIL')
})

test('runCveFloorArm is PASS/FAIL by the injected command\'s exit code', () => {
  const pass = runCveFloorArm('/kernel', { runFn: fakeRun({ 'check-cve-floors': { exitCode: 0, output: '# tests 2\nok', timedOut: false, spawnError: null } }) })
  assert.equal(pass.status, 'PASS')
  const fail = runCveFloorArm('/kernel', { runFn: fakeRun({ 'check-cve-floors': { exitCode: 1, output: 'bad', timedOut: false, spawnError: null } }) })
  assert.equal(fail.status, 'FAIL')
})

test('runOverridesDriftArm points --kernel at the given kernel PATH\'s pnpm-workspace.yaml, not the upstream submodule', () => {
  let seenCommand
  const runFn = (command) => {
    seenCommand = command
    return { exitCode: 0, output: '# tests 2\nok', timedOut: false, spawnError: null }
  }
  const r = runOverridesDriftArm('/vertical', '/my/kernel/worktree', { runFn })
  assert.equal(r.status, 'PASS')
  // argv, no shell: the path is its own element, never spliced into a string.
  assert.ok(Array.isArray(seenCommand))
  const k = seenCommand[seenCommand.indexOf('--kernel') + 1]
  assert.match(k, /[/\\]my[/\\]kernel[/\\]worktree[/\\]pnpm-workspace\.yaml$/)
})

test('runOverridesDriftArm resolves a RELATIVE kernel path against the caller, not against the vertical cwd it runs in', () => {
  let seenCommand
  const runFn = (command) => {
    seenCommand = command
    return { exitCode: 0, output: '# tests 3\n', timedOut: false, spawnError: null }
  }
  runOverridesDriftArm('/vertical', 'rel/kernel', { runFn })
  assert.equal(seenCommand[seenCommand.indexOf('--kernel') + 1], join(process.cwd(), 'rel', 'kernel', 'pnpm-workspace.yaml'))
})

test('runSteps stops at the first failing step (like && with no shell) and FAILs a node --test step that collected 0 tests', () => {
  const calls = []
  const runFn = (argv) => {
    calls.push(argv[1])
    if (argv[1] === 'fail') return { exitCode: 2, output: 'boom', timedOut: false, spawnError: null }
    if (argv[1] === 'vacuous') return { exitCode: 0, output: '1..0\n# tests 0\n# pass 0\n', timedOut: false, spawnError: null }
    return { exitCode: 0, output: '# tests 4\n# pass 4\n', timedOut: false, spawnError: null }
  }
  const failed = runSteps([{ argv: ['node', 'fail'] }, { argv: ['node', 'after'] }], '/x', runFn, { timeoutMs: 1000 })
  assert.equal(failed.exitCode, 2)
  assert.deepEqual(calls, ['fail'])

  const vacuous = runSteps([{ argv: ['node', 'vacuous'], tap: true }, { argv: ['node', 'guard'] }], '/x', runFn, { timeoutMs: 1000 })
  assert.equal(vacuous.exitCode, 1)
  assert.match(vacuous.reason, /collected 0 tests/)

  const ok = runSteps([{ argv: ['node', 'tests'], tap: true }, { argv: ['node', 'guard'] }], '/x', runFn, { timeoutMs: 1000 })
  assert.equal(ok.exitCode, 0)
})

test('runCveFloorArm FAILs when its own node --test step collected 0 tests (node --test exits 0 on an empty file)', () => {
  const r = runCveFloorArm('/kernel', {
    runFn: fakeRun({
      'check-cve-floors.test.mjs': { exitCode: 0, output: '# tests 0\n', timedOut: false, spawnError: null },
      'check-cve-floors.mjs': { exitCode: 0, output: '# tests 2\nok', timedOut: false, spawnError: null },
    }),
  })
  assert.equal(r.status, 'FAIL')
  assert.match(r.reason, /collected 0 tests/)
})

function makeWorkflowRepo(files) {
  const root = mkdtempSync(join(tmpdir(), 'ci-local-guards-workflows-'))
  mkdirSync(join(root, '.github', 'workflows'), { recursive: true })
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, '.github', 'workflows', name), text)
  return root
}

test('runRunnerPolicyArm aggregates both repos and FAILs when either has an unwaived hit', () => {
  const kernel = makeWorkflowRepo({ 'ci.yml': 'runs-on: ubuntu-latest\n' })
  const vertical = makeWorkflowRepo({ 'deploy.yml': 'env:\n  K: ${{ secrets.DEPLOY_SSH_KEY }}\n' })
  try {
    const r = runRunnerPolicyArm(kernel, vertical, undefined) // no waivers file
    assert.equal(r.status, 'FAIL')
    assert.match(r.reason, /vertical\/\.github\/workflows\/deploy\.yml/)
  } finally {
    rmSync(kernel, { recursive: true, force: true })
    rmSync(vertical, { recursive: true, force: true })
  }
})

test('runRunnerPolicyArm returns a FAIL arm (never throws) when --waivers names a file that is valid JSON but not an array (LOW fix: this used to crash uncaught inside waivers.find, before guards.mjs ever wrote its dated JSON result — acceptance item 5)', () => {
  const kernel = makeWorkflowRepo({ 'ci.yml': 'runs-on: ubuntu-latest\n' })
  const vertical = makeWorkflowRepo({ 'ci.yml': 'runs-on: ubuntu-latest\n' })
  const waiversDir = mkdtempSync(join(tmpdir(), 'ci-local-waivers-'))
  const waiversPath = join(waiversDir, 'waivers.json')
  writeFileSync(waiversPath, JSON.stringify({ not: 'an array' }))
  try {
    let r
    assert.doesNotThrow(() => {
      r = runRunnerPolicyArm(kernel, vertical, waiversPath)
    })
    assert.equal(r.status, 'FAIL')
    assert.match(r.reason, /waivers/i)
  } finally {
    rmSync(kernel, { recursive: true, force: true })
    rmSync(vertical, { recursive: true, force: true })
    rmSync(waiversDir, { recursive: true, force: true })
  }
})

test('runRunnerPolicyArm PASSes on the real kernel tree with the committed waivers.json, and nothing is waived: the list is empty', () => {
  const kernelRoot = fileURLToPath(new URL('../../', import.meta.url))
  const waiversPath = fileURLToPath(new URL('./waivers.json', import.meta.url))
  assert.deepEqual(JSON.parse(readFileSync(waiversPath, 'utf8')), [])
  const r = runRunnerPolicyArm(kernelRoot, undefined, waiversPath)
  assert.equal(r.status, 'PASS', r.reason)
  assert.deepEqual(r.waived, [], 'a PASS that leans on a waiver is not the PASS this test is about')
})

test('runRunnerPolicyArm PASSes when both repos are clean', () => {
  const kernel = makeWorkflowRepo({ 'ci.yml': 'runs-on: ubuntu-latest\n' })
  const vertical = makeWorkflowRepo({ 'ci.yml': 'runs-on: ubuntu-latest\n' })
  try {
    const r = runRunnerPolicyArm(kernel, vertical, undefined)
    assert.equal(r.status, 'PASS')
  } finally {
    rmSync(kernel, { recursive: true, force: true })
    rmSync(vertical, { recursive: true, force: true })
  }
})

test('runRunnerPolicyArm: a waiver naming ONLY the kernel repo does not waive the vertical repo\'s same-named file, and the waiver use is reported in the result (HIGH fix)', () => {
  const kernel = makeWorkflowRepo({ 'deploy.yml': 'env:\n  K: ${{ secrets.DEPLOY_SSH_KEY }}\n' })
  const vertical = makeWorkflowRepo({ 'deploy.yml': 'env:\n  K: ${{ secrets.DEPLOY_SSH_KEY }}\n' })
  const waiversDir = mkdtempSync(join(tmpdir(), 'ci-local-waivers-'))
  const waiversPath = join(waiversDir, 'waivers.json')
  writeFileSync(waiversPath, JSON.stringify([{ repo: 'kernel', file: 'deploy.yml', owner: 'TASK-086', expiresOn: '2099-01-01', covers: ['secret:DEPLOY_SSH_KEY'] }]))
  try {
    const r = runRunnerPolicyArm(kernel, vertical, waiversPath)
    // kernel/deploy.yml is waived and must not appear as a failure...
    assert.equal(r.status, 'FAIL')
    assert.match(r.reason, /vertical\/\.github\/workflows\/deploy\.yml/)
    assert.doesNotMatch(r.reason, /^kernel\/|, kernel\//)
    assert.equal(r.findings.some((f) => f.repo === 'kernel'), false)
    // ...but its waiver use IS visible in the arm result, not dropped silently.
    assert.equal(r.waived.length, 1)
    assert.equal(r.waived[0].repo, 'kernel')
    assert.equal(r.waived[0].owner, 'TASK-086')
  } finally {
    rmSync(kernel, { recursive: true, force: true })
    rmSync(vertical, { recursive: true, force: true })
    rmSync(waiversDir, { recursive: true, force: true })
  }
})

test('runAllArms: overall exit is non-zero when even one arm fails, and every arm still ran (no short-circuit)', () => {
  const kernel = makeSecretRepo()
  mkdirSync(join(kernel, '.github', 'workflows'), { recursive: true })
  const vertical = makeSecretRepo()
  try {
    const runFn = fakeRun({
      gitleaks: { exitCode: 0, output: 'no leaks found', timedOut: false, spawnError: null },
      'check-cve-floors': { exitCode: 1, output: 'FLOOR BROKEN', timedOut: false, spawnError: null }, // forced FAIL
      'check-overrides-drift': { exitCode: 0, output: '# tests 2\nok', timedOut: false, spawnError: null },
      'check-no-known-secrets': { exitCode: 0, output: '# tests 2\nok', timedOut: false, spawnError: null },
    })
    const { arms, overallExit } = runAllArms({ kernelPath: kernel, verticalPath: vertical, waiversPath: undefined, runFn })
    assert.equal(overallExit, 1)
    assert.equal(arms.length, 8) // 2 gitleaks + 2 known-secrets + known-secrets-vertical-native + cve-floor + overrides-drift + runner-policy
    const cve = arms.find((a) => a.arm === 'cve-floor')
    assert.equal(cve.status, 'FAIL')
    // every other arm still has a real verdict, not "skipped"
    assert.ok(arms.every((a) => a.status === 'PASS' || a.status === 'FAIL'))
  } finally {
    rmSync(kernel, { recursive: true, force: true })
    rmSync(vertical, { recursive: true, force: true })
  }
})

test('listDockerfiles finds a bare Dockerfile and a Dockerfile.suffix, sorted, and [] when there are none', () => {
  const root = mkdtempSync(join(tmpdir(), 'ci-local-dockerfiles-'))
  try {
    mkdirSync(join(root, 'gremion-ui'), { recursive: true })
    mkdirSync(join(root, 'docker', 'vector'), { recursive: true })
    writeFileSync(join(root, 'gremion-ui', 'Dockerfile'), 'FROM node')
    writeFileSync(join(root, 'docker', 'vector', 'Dockerfile'), 'FROM vector')
    writeFileSync(join(root, 'README.md'), '# not a dockerfile')
    assert.deepEqual(listDockerfiles(root), ['docker/vector/Dockerfile', 'gremion-ui/Dockerfile'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  const empty = mkdtempSync(join(tmpdir(), 'ci-local-dockerfiles-empty-'))
  try {
    assert.deepEqual(listDockerfiles(empty), [])
  } finally {
    rmSync(empty, { recursive: true, force: true })
  }
})

test('guardsResultFileName carries the date, HH:MM:SS (to the second, so two runs in the same minute never collide) and both short SHAs', () => {
  const now = new Date('2026-09-25T14:03:07.123Z')
  assert.equal(guardsResultFileName(now, 'abc1234', 'def5678'), '2026-09-25T140307Z-abc1234-def5678-guards.json')
})

test('main(): --out is no longer required to get a dated JSON result — omitting it still writes one, under the default directory (MEDIUM fix)', () => {
  const kernel = makeSecretRepo()
  const vertical = makeSecretRepo()
  const outDir = mkdtempSync(join(tmpdir(), 'ci-local-guards-default-out-'))
  const before = process.env.CI_LOCAL_GUARDS_OUT
  process.env.CI_LOCAL_GUARDS_OUT = outDir
  try {
    assert.equal(defaultGuardsOutDir(), outDir)
    // NO --out on the command line: the dated record must still be written.
    const code = withCleanExitCode(() => main(['--kernel', kernel, '--vertical', vertical, '--waivers', 'does-not-exist.json']))
    // These scratch repos lack the cve-floor/overrides-drift scripts, so the
    // entry point must be RED here — and still write its record.
    assert.equal(code, 1)
    const files = readdirSync(outDir)
    assert.equal(files.length, 1)
    assert.match(files[0], /^\d{4}-\d{2}-\d{2}T\d{6}Z-[0-9a-f]{7}-[0-9a-f]{7}-guards\.json$/)
    const body = JSON.parse(readFileSync(join(outDir, files[0]), 'utf8'))
    assert.ok(body.timestamp)
    assert.equal(body.kernelSha.length, 7)
    assert.equal(body.verticalSha.length, 7)
    assert.equal(body.overallExit, 1)
  } finally {
    if (before === undefined) delete process.env.CI_LOCAL_GUARDS_OUT
    else process.env.CI_LOCAL_GUARDS_OUT = before
    rmSync(kernel, { recursive: true, force: true })
    rmSync(vertical, { recursive: true, force: true })
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('runGitleaksArm (whole-tree) lists WHERE each tracked leak is (file, rule, line) and never copies the matched value into the result', () => {
  const root = makeSecretRepo()
  try {
    const runFn = (command) => {
      writeFileSync(
        command[command.indexOf('--report-path') + 1],
        JSON.stringify([{ File: '.env', RuleID: 'generic-api-key', StartLine: 1, Secret: 'VALUE-MUST-NOT-LEAK', Match: 'K=VALUE-MUST-NOT-LEAK' }]),
      )
      return { exitCode: 0, output: 'leaks found: 1', timedOut: false, spawnError: null }
    }
    const r = runGitleaksArm('kernel', root, undefined, { runFn })
    assert.equal(r.status, 'FAIL')
    assert.deepEqual(r.findings, [{ file: '.env', rule: 'generic-api-key', line: 1 }])
    assert.doesNotMatch(JSON.stringify(r), /VALUE-MUST-NOT-LEAK/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// --- TASK-012-FU LOW: an empty diff range is recorded, never silent ---------

test('FU-L2: runGitleaksArm (diff-scoped) records commitsScanned, and marks base == HEAD as "empty range, 0 commits" instead of a bare PASS', () => {
  const root = makeSecretRepo()
  try {
    const runFn = fakeRun({ gitleaks: { exitCode: 0, output: 'no leaks found', timedOut: false, spawnError: null } })
    const empty = runGitleaksArm('kernel', root, 'HEAD', { runFn })
    assert.equal(empty.status, 'PASS')
    assert.equal(empty.commitsScanned, 0)
    assert.equal(empty.note, 'empty range, 0 commits')

    execFileSync('git', ['-C', root, 'tag', 'fu-base'])
    writeFileSync(join(root, 'more.txt'), 'x\n')
    execFileSync('git', ['-C', root, 'add', 'more.txt'])
    execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'more'])
    const one = runGitleaksArm('kernel', root, 'fu-base', { runFn })
    assert.equal(one.status, 'PASS')
    assert.equal(one.commitsScanned, 1)
    assert.equal(one.note, undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('parseGitleaksCommitsScanned reads gitleaks\' own "N commits scanned." line (ANSI stripped), and returns null when no such line is present', () => {
  assert.equal(parseGitleaksCommitsScanned('10:33AM INF 3 commits scanned.\n10:33AM INF no leaks found\n'), 3)
  assert.equal(parseGitleaksCommitsScanned('\x1b[90m10:33AM\x1b[0m \x1b[32mINF\x1b[0m \x1b[1m1 commits scanned.\x1b[0m\n'), 1)
  assert.equal(parseGitleaksCommitsScanned('no leaks found'), null)
  assert.equal(parseGitleaksCommitsScanned(undefined), null)
})

test('FU-H1: runGitleaksArm (diff-scoped) FAILs closed on a coverage gap — gitleaks itself reports scanning fewer commits than actually exist in the range, exit 0 (a future regression the --diff-merges fix alone would not catch)', () => {
  const root = makeSecretRepo()
  try {
    execFileSync('git', ['-C', root, 'tag', 'gap-base'])
    writeFileSync(join(root, 'more.txt'), 'x\n')
    execFileSync('git', ['-C', root, 'add', 'more.txt'])
    execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'more'])
    writeFileSync(join(root, 'more2.txt'), 'y\n')
    execFileSync('git', ['-C', root, 'add', 'more2.txt'])
    execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'more2'])
    // Real range holds 2 commits; the (faked) gitleaks output claims only 1.
    const runFn = fakeRun({ gitleaks: { exitCode: 0, output: '1 commits scanned.\nno leaks found', timedOut: false, spawnError: null } })
    const r = runGitleaksArm('kernel', root, 'gap-base', { runFn })
    assert.equal(r.status, 'FAIL', JSON.stringify(r))
    assert.match(r.reason, /coverage gap/)
    assert.equal(r.commitsScanned, 2)
    assert.equal(r.gitleaksScanned, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Kernel-only checkout: --vertical is optional; vertical arms are skipped
// visibly, the kernel arms still run and still gate.
// ---------------------------------------------------------------------------

test('runAllArms with no verticalPath: kernel arms run, every vertical arm is SKIPPED (not PASS), exit 0 when kernel arms pass', () => {
  const kernel = makeSecretRepo()
  mkdirSync(join(kernel, '.github', 'workflows'), { recursive: true })
  try {
    const runFn = fakeRun({
      gitleaks: { exitCode: 0, output: 'no leaks found', timedOut: false, spawnError: null },
      'check-cve-floors': { exitCode: 0, output: '# tests 2\nok', timedOut: false, spawnError: null },
    })
    const { arms, overallExit } = runAllArms({ kernelPath: kernel, verticalPath: undefined, waiversPath: undefined, runFn })
    const scanner = arms.find((a) => a.arm === 'secret-scan' && a.repo === 'kernel')
    assert.equal(overallExit, scanner.status === 'FAIL' ? 1 : 0, JSON.stringify(arms))
    assert.ok(arms.filter((a) => a.status === 'FAIL').every((a) => a === scanner), 'only the environmental scanner arm may fail')
    const skipped = arms.filter((a) => a.status === 'SKIPPED')
    assert.deepEqual(
      skipped.map((a) => a.arm).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
      ['known-secrets', 'known-secrets-vertical-native', 'overrides-drift', 'secret-scan'],
    )
    for (const a of skipped) {
      assert.equal(a.repo, 'vertical')
      assert.match(a.reason, /skipped: no --vertical/)
    }
    const kernelArms = arms.filter((a) => a.status === 'PASS').map((a) => `${a.arm}:${a.repo}`)
    assert.ok(kernelArms.includes('known-secrets:kernel'))
    assert.ok(kernelArms.includes('cve-floor:kernel'))
    assert.ok(kernelArms.includes('runner-policy:kernel'))
  } finally {
    rmSync(kernel, { recursive: true, force: true })
  }
})

test('runAllArms with no verticalPath still exits 1 when a kernel arm fails', () => {
  const kernel = makeSecretRepo()
  mkdirSync(join(kernel, '.github', 'workflows'), { recursive: true })
  try {
    const runFn = fakeRun({
      gitleaks: { exitCode: 0, output: 'no leaks found', timedOut: false, spawnError: null },
      'check-cve-floors': { exitCode: 1, output: 'FLOOR BROKEN', timedOut: false, spawnError: null },
    })
    const { overallExit } = runAllArms({ kernelPath: kernel, verticalPath: undefined, waiversPath: undefined, runFn })
    assert.equal(overallExit, 1)
  } finally {
    rmSync(kernel, { recursive: true, force: true })
  }
})

test('runRunnerPolicyArm with no verticalPath evaluates the kernel only and reports repo "kernel"', () => {
  const kernel = makeWorkflowRepo({ 'ci.yml': 'runs-on: ubuntu-latest\n' })
  try {
    const r = runRunnerPolicyArm(kernel, undefined, undefined)
    assert.equal(r.arm, 'runner-policy')
    assert.equal(r.repo, 'kernel')
    assert.notEqual(r.status, 'SKIPPED')
  } finally {
    rmSync(kernel, { recursive: true, force: true })
  }
})

test('main(): no --vertical -> runs, records SKIPPED vertical arms in the dated JSON (verticalSha null), prints the skip line', () => {
  const kernel = makeSecretRepo()
  const outDir = mkdtempSync(join(tmpdir(), 'ci-local-guards-kernel-only-'))
  const lines = []
  const origLog = console.log
  console.log = (...a) => lines.push(a.join(' '))
  try {
    withCleanExitCode(() => main(['--kernel', kernel, '--out', outDir, '--waivers', 'does-not-exist.json']))
  } finally {
    console.log = origLog
  }
  try {
    assert.match(lines.join('\n'), /\[SKIPPED\] .*\(vertical\).*skipped: no --vertical/)
    const files = readdirSync(outDir)
    assert.equal(files.length, 1)
    const body = JSON.parse(readFileSync(join(outDir, files[0]), 'utf8'))
    assert.equal(body.verticalPath, null)
    assert.ok(body.arms.some((a) => a.status === 'SKIPPED'))
  } finally {
    rmSync(kernel, { recursive: true, force: true })
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('main(): a --vertical path that does not exist is a loud error (exit 1, nothing written)', () => {
  const kernel = makeSecretRepo()
  const outDir = mkdtempSync(join(tmpdir(), 'ci-local-guards-badvertical-'))
  const errs = []
  const origErr = console.error
  console.error = (...a) => errs.push(a.join(' '))
  let code
  try {
    code = withCleanExitCode(() => main(['--kernel', kernel, '--vertical', '/nonexistent/vertical-checkout', '--out', outDir]))
  } finally {
    console.error = origErr
  }
  try {
    assert.equal(code, 1)
    assert.match(errs.join('\n'), /--vertical path '\/nonexistent\/vertical-checkout' does not exist/)
    assert.deepEqual(readdirSync(outDir), [])
  } finally {
    rmSync(kernel, { recursive: true, force: true })
    rmSync(outDir, { recursive: true, force: true })
  }
})
