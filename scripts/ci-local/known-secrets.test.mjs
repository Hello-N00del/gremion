import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { scanText, scanRepo, trackedFiles, KNOWN_COMPROMISED } from './known-secrets.mjs'

// A synthetic value, never a real credential — proves the digest mechanism
// without this repo ever containing a real compromised secret in any
// encoding (base64 included; see this file's own header note).
const SENTINEL = 'sentinel-ci-local-known-secrets-fixture-9f3a7c21'
const SENTINEL_DIGEST = createHash('sha256').update(SENTINEL).digest('hex')

function syntheticDenylist() {
  return new Map([[SENTINEL_DIGEST, 'synthetic test sentinel — never a real credential']])
}

test('KNOWN_COMPROMISED starts empty — the kernel has no digest-denylist incidents to carry, per TASK-012 Q2', () => {
  assert.equal(KNOWN_COMPROMISED.size, 0)
})

test('scanText is RED on the injected sentinel digest, bare in a line', () => {
  const findings = scanText('some/file.env', `TOKEN=${SENTINEL}`, syntheticDenylist())
  assert.equal(findings.length, 1)
  assert.equal(findings[0].rule, 'known-compromised')
  assert.equal(findings[0].file, 'some/file.env')
})

test('scanText finds the sentinel however it is glued to its surroundings (URI, YAML, shell default)', () => {
  const shapes = [
    `postgres://user:${SENTINEL}@host:5432/db`,
    `password: '${SENTINEL}'`,
    `export DB_PASSWORD="${SENTINEL}"`,
  ]
  for (const line of shapes) {
    const findings = scanText('x', line, syntheticDenylist())
    assert.ok(findings.length >= 1, `expected a finding for: ${line}`)
  }
})

test('scanText passes clean on ordinary text and on a value that merely resembles the sentinel', () => {
  assert.deepEqual(scanText('x', 'nothing interesting here', syntheticDenylist()), [])
  assert.deepEqual(scanText('x', SENTINEL.slice(0, -1), syntheticDenylist()), [])
})

test('the digest rule has no allowlist and is never muted by path — it fires identically on a "fixture" path and an ordinary source path', () => {
  const line = `TOKEN=${SENTINEL}`
  const a = scanText('.env.example', line, syntheticDenylist())
  const b = scanText('src/anything.ts', line, syntheticDenylist())
  assert.equal(a.length, 1)
  assert.equal(b.length, 1)
})

test('scanRepo refuses to report green on 0 tracked files (a scan that collected nothing must not pass)', () => {
  const root = mkdtempSync(join(tmpdir(), 'ci-local-known-secrets-'))
  try {
    execFileSync('git', ['-C', root, 'init', '-q', '-b', 'main'])
    assert.throws(() => scanRepo(root), /collected 0 tracked files/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('scanRepo goes RED end-to-end: a committed file carrying the sentinel is found via a real git-tracked scan', () => {
  const root = mkdtempSync(join(tmpdir(), 'ci-local-known-secrets-'))
  try {
    const run = (args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' })
    run(['init', '-q', '-b', 'main'])
    run(['config', 'user.email', 'ci-local-test@example.invalid'])
    run(['config', 'user.name', 'ci-local-test'])
    writeFileSync(join(root, '.env'), `SECRET=${SENTINEL}\n`)
    run(['add', '.env'])
    run(['commit', '-q', '-m', 'seed'])

    const files = trackedFiles(root)
    assert.ok(files.includes('.env'))

    const { findings, scanned } = scanRepo(root, syntheticDenylist())
    assert.ok(scanned >= 1)
    assert.equal(findings.length, 1)
    assert.match(findings[0].detail, /synthetic test sentinel/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('scanRepo passes GREEN once the sentinel is removed from the tree (watch it go RED first, then fixed)', () => {
  const root = mkdtempSync(join(tmpdir(), 'ci-local-known-secrets-'))
  try {
    const run = (args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' })
    run(['init', '-q', '-b', 'main'])
    run(['config', 'user.email', 'ci-local-test@example.invalid'])
    run(['config', 'user.name', 'ci-local-test'])
    writeFileSync(join(root, '.env'), `SECRET=${SENTINEL}\n`)
    run(['add', '.env'])
    run(['commit', '-q', '-m', 'seed'])
    assert.equal(scanRepo(root, syntheticDenylist()).findings.length, 1) // RED

    writeFileSync(join(root, '.env'), 'SECRET=rotated-value-not-the-sentinel\n')
    run(['add', '.env'])
    run(['commit', '-q', '-m', 'rotate'])
    assert.equal(scanRepo(root, syntheticDenylist()).findings.length, 0) // GREEN
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
