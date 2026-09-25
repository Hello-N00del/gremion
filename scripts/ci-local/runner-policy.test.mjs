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
