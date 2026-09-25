import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  gitleaksCommand,
  runGitleaksArm,
  runKnownSecretsArm,
  runCveFloorArm,
  runOverridesDriftArm,
  runRunnerPolicyArm,
  runAllArms,
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

test('gitleaksCommand: whole-tree "dir" mode (JSON report, exit-code 0 so runGitleaksArm can filter it) when no base is given, diff-scoped "git" mode (--exit-code 1) when it is', () => {
  const dirCmd = gitleaksCommand('/repo', undefined, '/tmp/report.json')
  assert.match(dirCmd, /^gitleaks dir "\/repo" --config "[^"]*\.gitleaks\.toml" --redact --exit-code 0 --report-format json --report-path "\/tmp\/report\.json"$/)
  const gitCmd = gitleaksCommand('/repo', 'main')
  assert.match(gitCmd, /^gitleaks git "\/repo" --log-opts "main\.\.HEAD" --config .*--exit-code 1$/)
})

test('runGitleaksArm (diff-scoped, --base given) is PASS on exit 0, FAIL on a non-zero exit (a leak found), via an injected runFn', () => {
  const clean = runGitleaksArm('kernel', '/repo', 'main', {
    runFn: fakeRun({ gitleaks: { exitCode: 0, output: 'no leaks found', timedOut: false, spawnError: null } }),
  })
  assert.equal(clean.status, 'PASS')

  const dirty = runGitleaksArm('kernel', '/repo', 'main', {
    runFn: fakeRun({ gitleaks: { exitCode: 1, output: 'leak found', timedOut: false, spawnError: null } }),
  })
  assert.equal(dirty.status, 'FAIL')
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
  writeFileSync(join(root, '.env'), sentinelEnvLine ?? 'FINE=ok\n')
  run(['add', '.env'])
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
  const r = runOverridesDriftArm('/sturaos', '/my/kernel/worktree', { runFn })
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
  const sturaos = makeWorkflowRepo({ 'deploy.yml': 'env:\n  K: ${{ secrets.DEPLOY_SSH_KEY }}\n' })
  try {
    const r = runRunnerPolicyArm(kernel, sturaos, undefined) // no waivers file
    assert.equal(r.status, 'FAIL')
    assert.match(r.reason, /sturaos\/\.github\/workflows\/deploy\.yml/)
  } finally {
    rmSync(kernel, { recursive: true, force: true })
    rmSync(sturaos, { recursive: true, force: true })
  }
})

test('runRunnerPolicyArm PASSes when both repos are clean', () => {
  const kernel = makeWorkflowRepo({ 'ci.yml': 'runs-on: ubuntu-latest\n' })
  const sturaos = makeWorkflowRepo({ 'ci.yml': 'runs-on: ubuntu-latest\n' })
  try {
    const r = runRunnerPolicyArm(kernel, sturaos, undefined)
    assert.equal(r.status, 'PASS')
  } finally {
    rmSync(kernel, { recursive: true, force: true })
    rmSync(sturaos, { recursive: true, force: true })
  }
})

test('runAllArms: overall exit is non-zero when even one arm fails, and every arm still ran (no short-circuit)', () => {
  const kernel = makeSecretRepo()
  mkdirSync(join(kernel, '.github', 'workflows'), { recursive: true })
  const sturaos = makeSecretRepo()
  try {
    const runFn = fakeRun({
      gitleaks: { exitCode: 0, output: 'no leaks found', timedOut: false, spawnError: null },
      'check-cve-floors': { exitCode: 1, output: 'FLOOR BROKEN', timedOut: false, spawnError: null }, // forced FAIL
      'check-overrides-drift': { exitCode: 0, output: 'ok', timedOut: false, spawnError: null },
    })
    const { arms, overallExit } = runAllArms({ kernelPath: kernel, sturaosPath: sturaos, waiversPath: undefined, runFn })
    assert.equal(overallExit, 1)
    assert.equal(arms.length, 7) // 2 gitleaks + 2 known-secrets + cve-floor + overrides-drift + runner-policy
    const cve = arms.find((a) => a.arm === 'cve-floor')
    assert.equal(cve.status, 'FAIL')
    // every other arm still has a real verdict, not "skipped"
    assert.ok(arms.every((a) => a.status === 'PASS' || a.status === 'FAIL'))
  } finally {
    rmSync(kernel, { recursive: true, force: true })
    rmSync(sturaos, { recursive: true, force: true })
  }
})
