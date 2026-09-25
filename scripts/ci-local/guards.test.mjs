import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  gitleaksCommand,
  runGitleaksArm,
  baseRefResolves,
  runKnownSecretsArm,
  runCveFloorArm,
  runOverridesDriftArm,
  runRunnerPolicyArm,
  runAllArms,
  listDockerfiles,
} from './guards.mjs'

function fakeRun(map) {
  // map: command substring -> {exitCode, output, timedOut, spawnError}
  return (command) => {
    for (const [needle, result] of Object.entries(map)) {
      if (command.includes(needle)) return result
    }
    throw new Error(`fakeRun: no fixture for command: ${command}`)
  }
}

test('gitleaksCommand always scans "." with a RELATIVE --config: the repo comes from the process cwd the caller runs it in, never from a path embedded in the command string, so an absolute-vs-relative repoPath can never change which .gitleaks.toml allowlist paths match (HIGH fix)', () => {
  const dirCmd = gitleaksCommand(undefined, '/tmp/report.json')
  assert.equal(dirCmd, 'gitleaks dir "." --config ".gitleaks.toml" --redact --exit-code 0 --report-format json --report-path "/tmp/report.json"')
  const gitCmd = gitleaksCommand('main')
  assert.equal(gitCmd, 'gitleaks git "." --log-opts "main..HEAD" --config ".gitleaks.toml" --redact --exit-code 1')
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
// gate), and a literal "-----BEGIN PRIVATE KEY-----" sitting in THIS source
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
    const m = command.match(/--report-path "([^"]+)"/)
    writeFileSync(m[1], 'not json at all {{{')
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
      const m = command.match(/--report-path "([^"]+)"/)
      writeFileSync(
        m[1],
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
      const m = command.match(/--report-path "([^"]+)"/)
      writeFileSync(m[1], JSON.stringify([{ File: join(root, 'local-only.json'), RuleID: 'generic-api-key' }]))
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

test('runCveFloorArm is PASS/FAIL by the injected command\'s exit code', () => {
  const pass = runCveFloorArm('/kernel', { runFn: fakeRun({ 'check-cve-floors': { exitCode: 0, output: 'ok', timedOut: false, spawnError: null } }) })
  assert.equal(pass.status, 'PASS')
  const fail = runCveFloorArm('/kernel', { runFn: fakeRun({ 'check-cve-floors': { exitCode: 1, output: 'bad', timedOut: false, spawnError: null } }) })
  assert.equal(fail.status, 'FAIL')
})

test('runOverridesDriftArm points --kernel at the given kernel PATH\'s pnpm-workspace.yaml, not the upstream submodule', () => {
  let seenCommand
  const runFn = (command) => {
    seenCommand = command
    return { exitCode: 0, output: 'ok', timedOut: false, spawnError: null }
  }
  const r = runOverridesDriftArm('/vertical', '/my/kernel/worktree', { runFn })
  assert.equal(r.status, 'PASS')
  assert.match(seenCommand, /--kernel "[/\\]my[/\\]kernel[/\\]worktree[/\\]pnpm-workspace\.yaml"/)
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
  const waiversPath = join(mkdtempSync(join(tmpdir(), 'ci-local-waivers-')), 'waivers.json')
  writeFileSync(waiversPath, JSON.stringify([{ repo: 'kernel', file: 'deploy.yml', owner: 'TASK-086', expiresOn: '2099-01-01' }]))
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
      'check-overrides-drift': { exitCode: 0, output: 'ok', timedOut: false, spawnError: null },
    })
    const { arms, overallExit } = runAllArms({ kernelPath: kernel, sturaosPath: vertical, waiversPath: undefined, runFn })
    assert.equal(overallExit, 1)
    assert.equal(arms.length, 7) // 2 gitleaks + 2 known-secrets + cve-floor + overrides-drift + runner-policy
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
