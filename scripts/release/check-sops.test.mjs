#!/usr/bin/env node
// node --test suite: scripts/release/check-sops.mjs — no plaintext secret is
// committed; every secret-class file is SOPS-encrypted to a .sops.yaml age
// recipient (TASK-046, TRD-442, brief §1 bullet 5, §5 Q5, §6 item 4).
//
// Every seeded plaintext secret lives in a THROWAWAY git repository created
// under the gitignored scripts/release/.t046-tmp/ and deleted in teardown —
// never in this repository. Key material is generated at test time (age-keygen,
// openssl) and the private-key marker strings are assembled from fragments, so
// this file itself carries none of them.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'

import { Harness, REPO_ROOT, sh } from './lib/harness.mjs'
import { runSopsCheck, isSopsEncrypted, parseSopsConfig, SENTINEL_RE } from './check-sops.mjs'

const h = new Harness('sops')
after(() => h.teardown())

const AGE_SK = ['AGE', 'SECRET', 'KEY', '1'].join('-')
const COSIGN_PK = ['COSIGN', 'PRIVATE', 'KEY'].join('_')

function ageKey() {
  const r = sh('age-keygen', [])
  if (r.status !== 0) throw new Error(`age-keygen missing (FAIL, not skip): ${r.stderr}`)
  const recipient = /public key: (age1[0-9a-z]+)/.exec(r.stderr + r.stdout)[1]
  return { secret: r.stdout, recipient }
}
const ALICE = ageKey()
const MALLORY = ageKey()

const sopsYaml = (recipient) =>
  `creation_rules:\n  - path_regex: (^|/)secrets/.+|\\.enc\\.(yaml|yml|json|env)$\n    age: >-\n      ${recipient}\n`

/** Encrypt `plain` (of the given sops type) to `recipient`, returning the ciphertext. */
let encN = 0
function encrypt(plain, type, recipient = ALICE.recipient) {
  encN += 1
  const src = join(h.tmp, `plain-${encN}`)
  writeFileSync(src, plain)
  const r = sh('sops', ['--config', '/dev/null', '--encrypt', '--age', recipient, '--input-type', type, '--output-type', type, src])
  if (r.status !== 0) throw new Error(`sops --encrypt: ${r.stderr}`)
  return r.stdout
}

let n = 0
function repo(files, { sops = sopsYaml(ALICE.recipient), allow } = {}) {
  n += 1
  const r = join(h.tmp, `repo-${n}`)
  mkdirSync(r, { recursive: true })
  const all = { ...files }
  if (sops !== null) all['.sops.yaml'] = sops
  if (allow !== undefined) all['scripts/release/sops-allow.json'] = JSON.stringify(allow, null, 2)
  for (const [p, c] of Object.entries(all)) {
    mkdirSync(dirname(join(r, p)), { recursive: true })
    writeFileSync(join(r, p), c)
  }
  sh('git', ['-C', r, 'init', '-q'])
  sh('git', ['-C', r, 'add', '-A'])
  return r
}

const codes = (res) => res.problems.map((p) => p.code).sort()
const clean = { 'README.md': '# fixture\n' }

// ── the committed tree ──────────────────────────────────────────────────────

test('the committed tree fails ONLY on the pending age recipient (operator activation step)', () => {
  const res = runSopsCheck(REPO_ROOT)
  assert.ok(res.scanned > 100, `scanned ${res.scanned} files`)
  assert.deepEqual(
    codes(res),
    ['sentinel-recipient'],
    `unexpected problems in the committed tree:\n${res.problems.map((p) => `${p.code} ${p.path}: ${p.message}`).join('\n')}`,
  )
})

test('the committed .sops.yaml has a compose-layout rule and no k8s-only rule', () => {
  const cfg = parseSopsConfig(readFileSync(join(REPO_ROOT, '.sops.yaml'), 'utf8'))
  assert.equal(cfg.rules.length, 1)
  const re = new RegExp(cfg.rules[0].pathRegex)
  for (const p of ['secrets/tenants/a.yaml', 'infra/host/secrets/x.env', 'compose/app.enc.env', 'a/b.enc.json']) {
    assert.ok(re.test(p), `rule does not cover ${p}`)
  }
  assert.doesNotMatch(cfg.rules[0].pathRegex, /^k8s\//)
  assert.match(cfg.rules[0].recipients.join(','), SENTINEL_RE)
})

// ── RED cases: each must FAIL ──────────────────────────────────────────────

test('a plaintext *.enc.yaml fails', () => {
  const res = runSopsCheck(repo({ ...clean, 'compose/app.enc.yaml': 'db_password: hunter2\n' }))
  assert.deepEqual(codes(res), ['plaintext-secret'])
  assert.equal(res.problems[0].path, 'compose/app.enc.yaml')
})

test('a plaintext file under secrets/ fails (yaml, json, env, and an unknown type)', () => {
  const res = runSopsCheck(
    repo({
      ...clean,
      'secrets/tenants/t1.yaml': 'token: abc\n',
      'secrets/db.json': '{"password":"abc"}\n',
      'infra/secrets/app.env': 'API_KEY=abc\n',
      'secrets/blob.bin': 'raw\n',
    }),
  )
  assert.deepEqual(codes(res), ['plaintext-secret', 'plaintext-secret', 'plaintext-secret', 'plaintext-secret'])
})

test('a half-encrypted file (one plaintext leaf beside ENC values) fails', () => {
  const enc = encrypt('a: one\nb: two\n', 'yaml')
  const tampered = enc.replace(/^b: ENC\[.*$/m, 'b: two')
  assert.notEqual(tampered, enc)
  const res = runSopsCheck(repo({ ...clean, 'secrets/t.yaml': tampered }))
  assert.deepEqual(codes(res), ['plaintext-secret'])
})

test('an age secret key anywhere fails', () => {
  const res = runSopsCheck(repo({ ...clean, 'docs/notes.txt': `keep this safe\n${ALICE.secret}` }))
  assert.deepEqual(codes(res), ['key-material'])
  assert.ok(!JSON.stringify(res).includes(ALICE.secret.trim().split('\n').pop()), 'the finding echoes the secret')
})

test('a PEM private key anywhere fails', () => {
  const pem = sh('openssl', ['genpkey', '-algorithm', 'ed25519']).stdout
  assert.match(pem, /PRIVATE KEY/)
  const res = runSopsCheck(repo({ ...clean, 'deploy/id.pem': pem }))
  assert.deepEqual(codes(res), ['key-material'])
})

test('a cosign private key variable anywhere fails', () => {
  const res = runSopsCheck(repo({ ...clean, 'scripts/ci.sh': `export ${COSIGN_PK}="$(cat k)"\n` }))
  assert.deepEqual(codes(res), ['key-material'])
})

test('the sentinel recipient in .sops.yaml fails until the operator supplies the real one', () => {
  const res = runSopsCheck(repo(clean, { sops: sopsYaml('<OPERATOR_AGE_PUBLIC_KEY_REPLACE_VIA_BOOTSTRAP_SOPS_SH>') }))
  assert.deepEqual(codes(res), ['sentinel-recipient'])
})

test('a malformed recipient or a missing .sops.yaml fails', () => {
  assert.deepEqual(codes(runSopsCheck(repo(clean, { sops: sopsYaml('age1notreal') }))), ['bad-recipient'])
  assert.deepEqual(codes(runSopsCheck(repo(clean, { sops: null }))), ['no-sops-config'])
})

test('an allowance without a reason fails, and so does a stale one', () => {
  const reasonless = runSopsCheck(
    repo({ ...clean, 'secrets/README.md': 'docs\n' }, { allow: { allow: [{ path: 'secrets/README.md', rule: 'secret-path' }] } }),
  )
  assert.deepEqual(codes(reasonless), ['allow-without-reason', 'plaintext-secret'])
  const stale = runSopsCheck(
    repo(clean, { allow: { allow: [{ path: 'gone.md', rule: 'secret-path', reason: 'was here once' }] } }),
  )
  assert.deepEqual(codes(stale), ['allow-stale'])
})

test('zero tracked files fails: a scan that saw nothing proves nothing', () => {
  const r = join(h.tmp, 'empty')
  mkdirSync(r, { recursive: true })
  writeFileSync(join(r, '.sops.yaml'), sopsYaml(ALICE.recipient)) // present on disk, not tracked
  sh('git', ['-C', r, 'init', '-q'])
  assert.deepEqual(codes(runSopsCheck(r)), ['zero-files'])
})

test('a file encrypted to a recipient that .sops.yaml does not name fails', () => {
  const res = runSopsCheck(repo({ ...clean, 'secrets/m.yaml': encrypt('k: v\n', 'yaml', MALLORY.recipient) }))
  assert.deepEqual(codes(res), ['foreign-recipient'])
})

// ── GREEN twins ─────────────────────────────────────────────────────────────

test('age-encrypted twins pass (yaml, json, dotenv, *.enc.*), and the Q5 exclusions are honoured', () => {
  const r = repo({
    ...clean,
    'secrets/tenants/t1.yaml': encrypt('token: abc\nnested:\n  list:\n    - one\n    - two\n', 'yaml'),
    'secrets/db.json': encrypt('{"password":"abc","n":3,"ok":true}', 'json'),
    'infra/secrets/app.env': encrypt('API_KEY=abc\nOTHER=x\n', 'dotenv'),
    'compose/app.enc.yaml': encrypt('db_password: hunter2\n', 'yaml'),
    'secrets/tenants/.gitkeep': '',
    'secrets/tenant.example.yaml': 'token: CHANGEME\n',
    'secrets/rotate.sh': '#!/bin/sh\necho rotate\n',
    'secrets/README.md': 'what lives here\n',
  }, { allow: { allow: [{ path: 'secrets/README.md', rule: 'secret-path', reason: 'documentation only, carries no values' }] } })
  const res = runSopsCheck(r)
  assert.deepEqual(res.problems, [])
  assert.equal(res.secretFiles, 4)
})

test('isSopsEncrypted is a post-condition on content, not on the file name', () => {
  assert.equal(isSopsEncrypted('a: b\n', 'x.enc.yaml').ok, false)
  assert.equal(isSopsEncrypted(encrypt('a: b\n', 'yaml'), 'x.yaml').ok, true)
  assert.equal(isSopsEncrypted('{"sops":{}}', 'x.json').ok, false)
  assert.equal(isSopsEncrypted('sops_version=3\n', 'x.env').ok, false)
})
