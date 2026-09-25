import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  listWorkflowFiles,
  checkWorkflowText,
  todayIso,
  activeWaiver,
  waiverProblem,
  evaluateRepo,
  loadWaivers,
  repoRootExists,
  main,
} from './runner-policy.mjs'

function makeRepo(files) {
  const root = mkdtempSync(join(tmpdir(), 'ci-local-runner-policy-'))
  mkdirSync(join(root, '.github', 'workflows'), { recursive: true })
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(root, '.github', 'workflows', name), text)
  }
  return root
}

test('listWorkflowFiles lists .yml and .yaml under .github/workflows, sorted, and [] when the dir is absent', () => {
  const root = makeRepo({ 'b.yml': '', 'a.yaml': '' })
  try {
    assert.deepEqual(listWorkflowFiles(root), ['.github/workflows/a.yaml', '.github/workflows/b.yml'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  const empty = mkdtempSync(join(tmpdir(), 'ci-local-runner-policy-empty-'))
  try {
    assert.deepEqual(listWorkflowFiles(empty), [])
  } finally {
    rmSync(empty, { recursive: true, force: true })
  }
})

test('checkWorkflowText is RED on runs-on: self-hosted, and on a matrix-style self-hosted list', () => {
  assert.equal(checkWorkflowText('jobs:\n  x:\n    runs-on: self-hosted\n').length, 1)
  assert.equal(checkWorkflowText('jobs:\n  x:\n    runs-on: [self-hosted, linux, x64]\n').length, 1)
  assert.equal(checkWorkflowText('jobs:\n  x:\n    runs-on: ubuntu-latest\n').length, 0)
})

test('checkWorkflowText is RED on a deploy/signing/age/ssh secret reference, de-duplicated per name', () => {
  const text = 'env:\n  A: ${{ secrets.DEPLOY_SSH_KEY }}\n  B: ${{ secrets.DEPLOY_SSH_KEY }}\n  C: ${{ secrets.NPM_TOKEN }}\n'
  const findings = checkWorkflowText(text)
  assert.equal(findings.length, 1)
  assert.match(findings[0].detail, /DEPLOY_SSH_KEY/)
})

test('checkWorkflowText flags SIGNING_KEY, AGE_KEY and a GPG secret, and does not flag an unrelated secret', () => {
  const flags = (name) => checkWorkflowText(`x: \${{ secrets.${name} }}`).length
  assert.equal(flags('RELEASE_SIGNING_KEY'), 1)
  assert.equal(flags('SOPS_AGE_KEY'), 1)
  assert.equal(flags('GPG_PRIVATE_KEY'), 1)
  assert.equal(flags('NPM_TOKEN'), 0)
})

test('checkWorkflowText is green on an ordinary ubuntu-latest workflow with no sensitive secret', () => {
  assert.deepEqual(checkWorkflowText('jobs:\n  x:\n    runs-on: ubuntu-latest\n    steps: []\n'), [])
})

test('checkWorkflowText is RED on a YAML block-list runs-on (self-hosted as a "- " list item, not inline)', () => {
  const text = 'jobs:\n  x:\n    runs-on:\n      - self-hosted\n      - linux\n'
  assert.equal(checkWorkflowText(text).length, 1)
})

test('checkWorkflowText is RED on a runs-on labels map (self-hosted runner group syntax)', () => {
  const inline = 'jobs:\n  x:\n    runs-on: {labels: self-hosted}\n'
  assert.equal(checkWorkflowText(inline).length, 1)
  const block = 'jobs:\n  x:\n    runs-on:\n      group: my-group\n      labels: self-hosted\n'
  assert.equal(checkWorkflowText(block).length, 1)
})

test('checkWorkflowText is RED when runs-on is matrix-supplied and the matrix strategy lists self-hosted', () => {
  const text =
    'jobs:\n  x:\n    strategy:\n      matrix:\n        os: [self-hosted, ubuntu-latest]\n    runs-on: ${{ matrix.os }}\n'
  assert.equal(checkWorkflowText(text).length, 1)
})

test('checkWorkflowText is RED on bracket-syntax secret access: secrets[\'DEPLOY_SSH_KEY\']', () => {
  const text = "env:\n  K: ${{ secrets['DEPLOY_SSH_KEY'] }}\n"
  assert.equal(checkWorkflowText(text).length, 1)
})

test('checkWorkflowText is RED on toJSON(secrets) and on secrets: inherit (both can carry ANY secret)', () => {
  assert.equal(checkWorkflowText('env:\n  ALL: ${{ toJSON(secrets) }}\n').length, 1)
  assert.equal(checkWorkflowText('jobs:\n  x:\n    secrets: inherit\n').length, 1)
})

test('checkWorkflowText flags the canonical SOPS age var name (AGE_SECRET_KEY, not just *_AGE_KEY), HOST_KEY, COSIGN and KEYSTORE secrets', () => {
  const flags = (name) => checkWorkflowText(`x: \${{ secrets.${name} }}`).length
  assert.equal(flags('AGE_SECRET_KEY'), 1)
  assert.equal(flags('PROD_HOST_PRIVATE_KEY'), 1)
  assert.equal(flags('COSIGN_KEY'), 1)
  assert.equal(flags('ANDROID_KEYSTORE_PASSWORD'), 1)
  assert.equal(flags('STAGE_ENV_NAME'), 0, 'a name that merely CONTAINS "age" as a substring must not false-positive')
})

// --- round-5 HIGH fix: structural runs-on classification, fail closed ------
// The old text-regex denylist failed OPEN on every one of these — proven in
// round 4's verifier probe (.scratch/probe-rp.mjs) against the PRE-fix code.
// checkWorkflowText must now flag every one of them.

test('checkWorkflowText is RED on runs-on: self-hosted with a trailing YAML comment (the round-4 HIGH: the old end-of-line-anchored regex could not see past it)', () => {
  assert.equal(checkWorkflowText('jobs:\n  x:\n    runs-on: self-hosted  # our GPU box\n').length, 1)
})

test('checkWorkflowText is RED on the same trailing-comment shape over CRLF line endings', () => {
  assert.equal(checkWorkflowText('jobs:\r\n  x:\r\n    runs-on: self-hosted  # pi box\r\n').length, 1)
})

test('checkWorkflowText is RED on a quoted \'runs-on\' key (structural: a real parser treats a quoted key identically to a bare one)', () => {
  assert.equal(checkWorkflowText("jobs:\n  x:\n    'runs-on': self-hosted\n").length, 1)
})

test('checkWorkflowText is RED on a custom label with no "self-hosted" string at all (runs-on: my-raspberry-pi) — GitHub lets a self-hosted runner be targeted by a custom label alone', () => {
  assert.equal(checkWorkflowText('jobs:\n  x:\n    runs-on: my-raspberry-pi\n').length, 1)
})

test('checkWorkflowText is RED on a runner-group-only object with no "labels" or "self-hosted" text anywhere', () => {
  assert.equal(checkWorkflowText('jobs:\n  x:\n    runs-on:\n      group: prod-runners\n').length, 1)
})

test('checkWorkflowText is RED on an unresolvable runs-on expression (${{ vars.RUNNER }} / ${{ inputs.runner }}), never having contained "self-hosted"', () => {
  assert.equal(checkWorkflowText('jobs:\n  x:\n    runs-on: ${{ vars.RUNNER }}\n').length, 1)
  assert.equal(checkWorkflowText('jobs:\n  x:\n    runs-on: ${{ inputs.runner }}\n').length, 1)
})

test('checkWorkflowText is RED on a folded/literal block-scalar runs-on value (runs-on: >-\\n  self-hosted)', () => {
  assert.equal(checkWorkflowText('jobs:\n  x:\n    runs-on: >-\n      self-hosted\n').length, 1)
})

test('checkWorkflowText is GREEN when a matrix-supplied runs-on resolves EVERY declared combination to a hosted label (precision improvement over the old "self-hosted anywhere in the file" fallback)', () => {
  const text = 'jobs:\n  x:\n    strategy:\n      matrix:\n        os: [ubuntu-latest, windows-2022]\n    runs-on: ${{ matrix.os }}\n'
  assert.deepEqual(checkWorkflowText(text), [])
})

test('checkWorkflowText is RED when a matrix key referenced by runs-on is not declared in strategy.matrix at all (unresolved, fails closed)', () => {
  const text = 'jobs:\n  x:\n    strategy:\n      matrix:\n        os: [ubuntu-latest]\n    runs-on: ${{ matrix.arch }}\n'
  assert.equal(checkWorkflowText(text).length, 1)
})

// --- TASK-012-FU finding 1 (HIGH): strategy.matrix.include/exclude --------
// GitHub ADDS a combination for every `include` entry, so a runs-on resolved
// through a matrix key must also classify that key in every include entry.

const matrixJob = (matrixYaml) => `jobs:\n  x:\n    strategy:\n      matrix:\n${matrixYaml}    runs-on: \${{ matrix.os }}\n`

test('FU-1: checkWorkflowText is RED when matrix.include adds a self-hosted value for the runs-on key (os: [ubuntu-latest] + include: [{os: self-hosted}])', () => {
  const text = matrixJob('        os: [ubuntu-latest]\n        include:\n          - os: self-hosted\n')
  const findings = checkWorkflowText(text)
  assert.equal(findings.length, 1)
  assert.equal(findings[0].id, 'self-hosted')
})

test('FU-1: checkWorkflowText is RED when the runs-on key exists ONLY in include entries and one of them is a custom label', () => {
  const text = matrixJob('        include:\n          - os: ubuntu-latest\n          - os: my-raspberry-pi\n')
  assert.equal(checkWorkflowText(text).length, 1)
})

test('FU-1: checkWorkflowText is GREEN when the runs-on key exists only in include entries and every one is hosted', () => {
  const text = matrixJob('        include:\n          - os: ubuntu-latest\n            node: 22\n          - os: windows-2022\n')
  assert.deepEqual(checkWorkflowText(text), [])
})

test('FU-1: checkWorkflowText is GREEN when include entries extend hosted combinations without touching the runs-on key', () => {
  const text = matrixJob('        os: [ubuntu-latest, macos-14]\n        include:\n          - node: 24\n')
  assert.deepEqual(checkWorkflowText(text), [])
})

test('FU-1: checkWorkflowText is RED (fail closed) when include or exclude is an expression rather than a list of mappings', () => {
  assert.equal(checkWorkflowText(matrixJob('        os: [ubuntu-latest]\n        include: ${{ fromJSON(inputs.extra) }}\n')).length, 1)
  assert.equal(checkWorkflowText(matrixJob('        os: [ubuntu-latest]\n        exclude: ${{ fromJSON(inputs.drop) }}\n')).length, 1)
  assert.equal(checkWorkflowText(matrixJob('        os: [ubuntu-latest]\n        include:\n          - self-hosted\n')).length, 1)
  assert.equal(checkWorkflowText(matrixJob('        os: [ubuntu-latest]\n        include:\n          os: self-hosted\n')).length, 1)
})

test('FU-1: checkWorkflowText is RED (fail closed) when the whole matrix is an expression', () => {
  const text = 'jobs:\n  x:\n    strategy:\n      matrix: ${{ fromJSON(inputs.m) }}\n    runs-on: ${{ matrix.os }}\n'
  assert.equal(checkWorkflowText(text).length, 1)
})

test('FU-1: matrix keys resolve case-insensitively (GitHub expression property access ignores case), so include {OS: self-hosted} is still caught', () => {
  const text = matrixJob('        os: [ubuntu-latest]\n        include:\n          - OS: self-hosted\n')
  assert.equal(checkWorkflowText(text).length, 1)
})

test('FU-1: a matrix value that itself references the matrix fails closed instead of recursing forever', () => {
  const text = matrixJob("        os: ['${{ matrix.os }}']\n")
  assert.equal(checkWorkflowText(text).length, 1)
})

test('checkWorkflowText does not flag a reusable-workflow call job (uses:, no runs-on) alongside an ordinary hosted job', () => {
  const text = 'jobs:\n  call:\n    uses: ./.github/workflows/other.yml\n  build:\n    runs-on: ubuntu-latest\n'
  assert.deepEqual(checkWorkflowText(text), [])
})

test('checkWorkflowText is RED (rule: unparseable) on a workflow that fails to parse at all, and reports nothing else', () => {
  const text = 'jobs:\n  x:\n    runs-on: [self-hosted, ubuntu-latest\n' // unclosed flow sequence
  const findings = checkWorkflowText(text)
  assert.equal(findings.length, 1)
  assert.equal(findings[0].rule, 'unparseable')
})

test('checkWorkflowText is RED (rule: unparseable) on tab-indented YAML, which real GitHub Actions also refuses to run', () => {
  const findings = checkWorkflowText('jobs:\n  x:\n\trun-on: ubuntu-latest\n')
  assert.equal(findings.length, 1)
  assert.equal(findings[0].rule, 'unparseable')
})

test('checkWorkflowText is RED on a job body that is a plain scalar, not a mapping (malformed, fails closed rather than crashing)', () => {
  assert.equal(checkWorkflowText('jobs:\n  x: "oops"\n').length, 1)
})

test('checkWorkflowText scans SCALAR VALUES, not raw text — a comment that merely mentions a sensitive secret name is never a finding', () => {
  assert.deepEqual(checkWorkflowText('# this workflow used to have a secrets.DEPLOY_SSH_KEY, removed\njobs:\n  x:\n    runs-on: ubuntu-latest\n'), [])
})

test('todayIso returns YYYY-MM-DD from an injected clock', () => {
  assert.equal(todayIso(new Date('2026-09-25T12:00:00Z')), '2026-09-25')
})

test('activeWaiver: live waiver is returned; expired waiver is not (the guard must still fail on an expired waiver)', () => {
  const waivers = [{ repo: 'kernel', file: 'deploy.yml', owner: 'TASK-086', expiresOn: '2026-12-24', covers: ['secret:DEPLOY_SSH_KEY'] }]
  assert.ok(activeWaiver(waivers, 'kernel', 'deploy.yml', '2026-09-25'))
  assert.equal(activeWaiver(waivers, 'kernel', 'deploy.yml', '2026-12-25'), undefined)
  assert.equal(activeWaiver(waivers, 'kernel', 'other.yml', '2026-09-25'), undefined)
})

test('activeWaiver: a waiver scoped to one repo does NOT match the same file in a DIFFERENT repo (HIGH fix: waivers are repo-scoped)', () => {
  const waivers = [{ repo: 'kernel', file: 'deploy.yml', owner: 'TASK-086', expiresOn: '2026-12-24', covers: ['secret:DEPLOY_SSH_KEY'] }]
  assert.ok(activeWaiver(waivers, 'kernel', 'deploy.yml', '2026-09-25'), 'kernel deploy.yml is covered')
  assert.equal(
    activeWaiver(waivers, 'vertical', 'deploy.yml', '2026-09-25'),
    undefined,
    'a kernel waiver must never cover vertical/deploy.yml, even though the basename matches',
  )
})

test('evaluateRepo: an unwaived self-hosted workflow is reported, waived is false', () => {
  const root = makeRepo({ 'x.yml': 'jobs:\n  a:\n    runs-on: self-hosted\n' })
  try {
    const result = evaluateRepo('kernel', root, [], '2026-09-25')
    assert.equal(result.length, 1)
    assert.equal(result[0].waived, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('evaluateRepo: a deploy-secret workflow covered by a live SAME-REPO waiver is reported as waived, not as a failure', () => {
  const root = makeRepo({
    'deploy.yml': 'env:\n  K: ${{ secrets.DEPLOY_SSH_KEY }}\n',
  })
  try {
    const waivers = [{ repo: 'kernel', file: 'deploy.yml', owner: 'TASK-086', expiresOn: '2026-12-24', covers: ['secret:DEPLOY_SSH_KEY'] }]
    const result = evaluateRepo('kernel', root, waivers, '2026-09-25')
    assert.equal(result.length, 1)
    assert.equal(result[0].waived, true)
    assert.equal(result[0].waiver.owner, 'TASK-086')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('evaluateRepo: the SAME deploy.yml finding in a DIFFERENT repo than the waiver names is reported as NOT waived', () => {
  const root = makeRepo({
    'deploy.yml': 'env:\n  K: ${{ secrets.DEPLOY_SSH_KEY }}\n',
  })
  try {
    const waivers = [{ repo: 'kernel', file: 'deploy.yml', owner: 'TASK-086', expiresOn: '2026-12-24', covers: ['secret:DEPLOY_SSH_KEY'] }]
    const result = evaluateRepo('vertical', root, waivers, '2026-09-25')
    assert.equal(result.length, 1)
    assert.equal(result[0].waived, false, 'a kernel-scoped waiver must not silently cover the vertical repo')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('evaluateRepo: the SAME finding on an EXPIRED waiver is reported as NOT waived — the guard fails closed on a stale waiver', () => {
  const root = makeRepo({
    'deploy.yml': 'env:\n  K: ${{ secrets.DEPLOY_SSH_KEY }}\n',
  })
  try {
    const waivers = [{ repo: 'kernel', file: 'deploy.yml', owner: 'TASK-086', expiresOn: '2026-01-01', covers: ['secret:DEPLOY_SSH_KEY'] }]
    const result = evaluateRepo('kernel', root, waivers, '2026-09-25')
    assert.equal(result.length, 1)
    assert.equal(result[0].waived, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('activeWaiver: a waiver with a missing, non-ISO or impossible expiresOn is never live (MEDIUM fix: it used to never expire)', () => {
  for (const expiresOn of [undefined, '', '2026-9-1', '2026-13-45', '2026-02-30', 'someday', 20261224]) {
    const waivers = [{ repo: 'kernel', file: 'deploy.yml', owner: 'TASK-086', expiresOn, covers: ['secret:DEPLOY_SSH_KEY'] }]
    assert.equal(activeWaiver(waivers, 'kernel', 'deploy.yml', '2026-09-25'), undefined, String(expiresOn))
    assert.match(waiverProblem(waivers[0]), /expiresOn/)
  }
})

test('activeWaiver: a waiver that does not name the finding ids it covers is never live', () => {
  for (const covers of [undefined, [], [''], 'secret:DEPLOY_SSH_KEY']) {
    const waivers = [{ repo: 'kernel', file: 'deploy.yml', owner: 'TASK-086', expiresOn: '2099-01-01', covers }]
    assert.equal(activeWaiver(waivers, 'kernel', 'deploy.yml', '2026-09-25'), undefined, JSON.stringify(covers))
  }
})

test('evaluateRepo: a live waiver mutes ONLY the finding ids it covers — a new self-hosted runner or signing secret added to the waived file still FAILs (MEDIUM fix)', () => {
  const root = makeRepo({
    'deploy.yml': 'jobs:\n  a:\n    runs-on: self-hosted\n    env:\n      K: ${{ secrets.DEPLOY_SSH_KEY }}\n      S: ${{ secrets.COSIGN_KEY }}\n',
  })
  try {
    const waivers = [{ repo: 'kernel', file: 'deploy.yml', owner: 'TASK-086', expiresOn: '2099-01-01', covers: ['secret:DEPLOY_SSH_KEY'] }]
    const [entry] = evaluateRepo('kernel', root, waivers, '2026-09-25')
    assert.equal(entry.waived, false)
    assert.deepEqual(entry.findings.map((f) => f.id).sort(), ['secret:COSIGN_KEY', 'self-hosted'])
    assert.deepEqual(entry.waivedFindings.map((f) => f.id), ['secret:DEPLOY_SSH_KEY'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the committed waivers.json covers exactly the findings on the real kernel deploy.yml — no more, no fewer', () => {
  const waivers = loadWaivers(fileURLToPath(new URL('./waivers.json', import.meta.url)))
  const kernelRoot = fileURLToPath(new URL('../../', import.meta.url))
  const entries = evaluateRepo('kernel', kernelRoot, waivers, todayIso()).filter((e) => e.path === '.github/workflows/deploy.yml')
  assert.equal(entries.length, 1)
  assert.equal(entries[0].waived, true, JSON.stringify(entries[0].findings))
  assert.deepEqual(entries[0].waivedFindings.map((f) => f.id).sort(), [...waivers[0].covers].sort())
})

test('MEDIUM fix: repoRootExists is false for a nonexistent path and for a path that is a plain file, true for a real directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-local-repo-exists-'))
  try {
    assert.equal(repoRootExists(dir), true)
    assert.equal(repoRootExists(join(dir, 'does-not-exist')), false)
    const filePath = join(dir, 'a-file.txt')
    writeFileSync(filePath, 'x')
    assert.equal(repoRootExists(filePath), false, 'a plain file is not a valid repo root')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('MEDIUM fix: evaluateRepo reports a nonexistent repo root as its own failure, never a vacuous "no workflows" PASS', () => {
  const missing = join(mkdtempSync(join(tmpdir(), 'ci-local-repo-missing-')), 'does-not-exist')
  const result = evaluateRepo('kernel', missing, [], '2026-09-25')
  assert.equal(result.length, 1)
  assert.equal(result[0].waived, false)
  assert.equal(result[0].findings[0].rule, 'invalid-repo')
})

test('MEDIUM fix: main(), given --repo pointing at a nonexistent path, exits non-zero (regression: it used to print "OK" and exit 0)', () => {
  const before = process.exitCode
  process.exitCode = undefined
  try {
    main(['--repo', join(mkdtempSync(join(tmpdir(), 'ci-local-repo-missing-')), 'does-not-exist')])
    assert.equal(process.exitCode, 1)
  } finally {
    process.exitCode = before
  }
})

test('evaluateRepo: a clean tree reports no entries at all', () => {
  const root = makeRepo({ 'ci.yml': 'jobs:\n  a:\n    runs-on: ubuntu-latest\n' })
  try {
    assert.deepEqual(evaluateRepo('kernel', root, [], '2026-09-25'), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('loadWaivers reads a real waivers.json and [] when the path is missing or absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-local-waivers-'))
  try {
    const p = join(dir, 'waivers.json')
    writeFileSync(p, JSON.stringify([{ file: 'a.yml', owner: 'X', expiresOn: '2099-01-01' }]))
    assert.equal(loadWaivers(p).length, 1)
    assert.deepEqual(loadWaivers(join(dir, 'nope.json')), [])
    assert.deepEqual(loadWaivers(undefined), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadWaivers THROWS (never silently []) when the file is valid JSON but not an array (LOW fix: a malformed-but-parseable waivers.json used to make `waivers.find` crash uncaught downstream, before guards.mjs ever got to write the dated JSON result)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-local-waivers-'))
  try {
    const p = join(dir, 'waivers.json')
    writeFileSync(p, JSON.stringify({ not: 'an array' }))
    assert.throws(() => loadWaivers(p), /must be a JSON array/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadWaivers THROWS on genuinely invalid JSON syntax too, rather than silently treating a corrupted waivers.json as "no waivers" (LOW fix)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-local-waivers-'))
  try {
    const p = join(dir, 'waivers.json')
    writeFileSync(p, '{ not valid json')
    assert.throws(() => loadWaivers(p))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('main(): a malformed (non-array) --waivers file is a clean, reported failure — not an uncaught crash (LOW fix)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-local-runner-policy-'))
  const kernel = makeRepo({})
  try {
    const p = join(dir, 'waivers.json')
    writeFileSync(p, JSON.stringify({ not: 'an array' }))
    const before = process.exitCode
    process.exitCode = undefined
    assert.doesNotThrow(() => main(['--kernel', kernel, '--waivers', p]))
    assert.equal(process.exitCode, 1)
    process.exitCode = before
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(kernel, { recursive: true, force: true })
  }
})

test('HIGH fix: suites.json\'s kernel-runner-policy-guard command labels this repo "kernel" (--kernel), not "--repo ." — a bare --repo labels itself by its own path and can never match the repo-scoped committed waiver', () => {
  const suites = JSON.parse(readFileSync(fileURLToPath(new URL('./suites.json', import.meta.url)), 'utf8'))
  const suite = suites.kernel.find((s) => s.id === 'kernel-runner-policy-guard')
  assert.ok(suite, 'expected a kernel-runner-policy-guard suite in suites.json')
  assert.match(
    suite.command,
    /runner-policy\.mjs --kernel \. --waivers scripts\/ci-local\/waivers\.json/,
    'the committed suite command must pass --kernel (not --repo) so main() labels this repo "kernel"',
  )
})

test('HIGH fix: main(), given suites.json\'s ACTUAL kernel-runner-policy-guard argv shape, exits 0 end-to-end against the real kernel tree — the committed waiver suppresses deploy.yml', () => {
  const kernelRoot = fileURLToPath(new URL('../../', import.meta.url))
  const waiversPath = fileURLToPath(new URL('./waivers.json', import.meta.url))
  const before = process.exitCode
  process.exitCode = undefined
  try {
    main(['--kernel', kernelRoot, '--waivers', waiversPath])
    assert.equal(process.exitCode, undefined, 'expected exit 0 (unset): the committed kernel waiver must suppress deploy.yml\'s known findings end-to-end')
  } finally {
    process.exitCode = before
  }
})

test('regression guard: the OLD "--repo ." shape (this unit\'s prior bug) mislabels the kernel repo and fails even with the committed waiver live', () => {
  const kernelRoot = fileURLToPath(new URL('../../', import.meta.url))
  const waiversPath = fileURLToPath(new URL('./waivers.json', import.meta.url))
  const before = process.exitCode
  process.exitCode = undefined
  try {
    // A bare --repo labels itself by its own path (here, kernelRoot), never
    // "kernel" — so it can never match a waiver scoped to repo: "kernel".
    main(['--repo', kernelRoot, '--waivers', waiversPath])
    assert.equal(process.exitCode, 1, 'a bare --repo must NOT benefit from the kernel-scoped waiver (documents why --kernel is required)')
  } finally {
    process.exitCode = before
  }
})

test('the committed scripts/ci-local/waivers.json waives exactly kernel/deploy.yml, owned by TASK-086, and is still a live (non-expired) waiver today', () => {
  const waivers = loadWaivers(fileURLToPath(new URL('./waivers.json', import.meta.url)))
  assert.equal(waivers.length, 1)
  assert.equal(waivers[0].repo, 'kernel')
  assert.equal(waivers[0].file, 'deploy.yml')
  assert.equal(waivers[0].owner, 'TASK-086')
  assert.ok(activeWaiver(waivers, 'kernel', 'deploy.yml', todayIso()), 'expected the committed waiver to still be live today')
  assert.equal(
    activeWaiver(waivers, 'vertical', 'deploy.yml', todayIso()),
    undefined,
    'the committed kernel waiver must not cover a vertical/deploy.yml',
  )
})
