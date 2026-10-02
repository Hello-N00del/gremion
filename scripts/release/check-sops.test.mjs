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
import { runSopsCheck, isSopsEncrypted, parseSopsConfig, SENTINEL_RE, AGE_RECIPIENT_RE } from './check-sops.mjs'

const h = new Harness('sops')
after(() => h.teardown())

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

// The operator activated the age recipient (bcfcf054, TASK-046 activation step
// 4), so the committed tree has ZERO problems. The sentinel refusal itself is
// still proven by the fixture test below ('the sentinel recipient ... fails').
test('the committed tree has zero problems (age recipient activated by the operator)', () => {
  const res = runSopsCheck(REPO_ROOT)
  assert.ok(res.scanned > 100, `scanned ${res.scanned} files`)
  assert.deepEqual(
    res.problems.map((p) => `${p.code} ${p.path}: ${p.message}`),
    [],
    'unexpected problems in the committed tree',
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
  assert.ok(cfg.rules[0].recipients.length > 0, 'the rule names no recipient')
  for (const rc of cfg.rules[0].recipients) {
    assert.match(rc, AGE_RECIPIENT_RE, 'the rule recipient is not a well-formed age recipient')
    assert.doesNotMatch(rc, SENTINEL_RE, 'the rule still carries the activation sentinel')
  }
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
    repo(clean, { allow: { allow: [{ path: 'gone.md', rule: 'secret-path', reason: 'was here once', blob: '0'.repeat(40) }] } }),
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
  }, { allow: { allow: [{ path: 'secrets/README.md', rule: 'secret-path', reason: 'documentation only, carries no values', blob: sh('git', ['hash-object', '--stdin'], { input: 'what lives here\n' }).stdout.trim() }] } })
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

// ── review round 1 (2026-09-25): holes found by the security and
//    silent-failure reviewers, each seeded here before the fix ─────────────

test('a committed plaintext secret deleted from the work tree still fails (the index is read, not the disk)', () => {
  const r = repo({ ...clean, 'secrets/db.env': 'password=hunter2\n' })
  sh('rm', [join(r, 'secrets/db.env')])
  assert.deepEqual(codes(runSopsCheck(r)), ['plaintext-secret'])
  // …and an uncommitted encrypted twin on disk does not hide the staged plaintext.
  const r2 = repo({ ...clean, 'secrets/db.yaml': 'password: hunter2\n' })
  writeFileSync(join(r2, 'secrets/db.yaml'), encrypt('password: hunter2\n', 'yaml'))
  assert.deepEqual(codes(runSopsCheck(r2)), ['plaintext-secret'])
})

test('key material after a NUL byte or in UTF-16 is still found', () => {
  const after = Buffer.concat([Buffer.from('hdr\0\n'), Buffer.from(ALICE.secret)])
  const utf16 = Buffer.from(`x\n${ALICE.secret}`, 'utf16le')
  const r = join(h.tmp, 'bin-repo')
  mkdirSync(r, { recursive: true })
  writeFileSync(join(r, '.sops.yaml'), sopsYaml(ALICE.recipient))
  writeFileSync(join(r, 'README.md'), 'x\n')
  writeFileSync(join(r, 'nul.dat'), after)
  writeFileSync(join(r, 'utf16.txt'), utf16)
  sh('git', ['-C', r, 'init', '-q'])
  sh('git', ['-C', r, 'add', '-A'])
  const res = runSopsCheck(r)
  assert.deepEqual(codes(res), ['key-material', 'key-material'])
})

test('a secret key pasted as the recipient is refused WITHOUT echoing it', () => {
  const sk = ALICE.secret.trim().split('\n').pop()
  const res = runSopsCheck(repo(clean, { sops: sopsYaml(sk) }))
  assert.ok(codes(res).includes('bad-recipient'), JSON.stringify(codes(res)))
  assert.ok(!JSON.stringify(res).includes(sk.slice(20)), 'the finding echoes the secret key')
})

test('plaintext hidden inside the sops metadata block (yaml, json) fails', () => {
  const enc = encrypt('a: one\n', 'yaml')
  const hidden = enc.replace(/^sops:\n/m, 'sops:\n    password: hunter2\n')
  assert.equal(isSopsEncrypted(hidden, 'x.yaml').ok, false)
  const j = JSON.parse(encrypt('{"a":"one"}', 'json'))
  j.sops.password = 'hunter2'
  assert.equal(isSopsEncrypted(JSON.stringify(j), 'x.json').ok, false)
  const trailing = enc + 'password: hunter2\n'
  assert.equal(isSopsEncrypted(trailing, 'x.yaml').ok, false)
})

test('a dotenv key that merely starts with sops_ is not metadata', () => {
  const enc = encrypt('A=1\n', 'dotenv')
  assert.equal(isSopsEncrypted(enc + 'sops_db_password=hunter2\n', 'x.env').ok, false)
})

test('plaintext dressed as ENC[...] fails: the full SOPS value shape is required', () => {
  const enc = encrypt('a: one\n', 'yaml')
  const fake = enc.replace(/^a: ENC\[.*$/m, 'a: ENC[AES256_GCM,data:hunter2]')
  assert.equal(isSopsEncrypted(fake, 'x.yaml').ok, false)
})

test('a PGP private key block, Secrets/ in any case and *.enc.YAML are covered', () => {
  const pgp = ['-----BEGIN PGP', 'PRIVATE KEY BLOCK-----'].join(' ')
  assert.deepEqual(codes(runSopsCheck(repo({ ...clean, 'k.asc': `${pgp}\nxx\n` }))), ['key-material'])
  assert.deepEqual(codes(runSopsCheck(repo({ ...clean, 'Secrets/prod.env': 'A=1\n' }))), ['plaintext-secret'])
  assert.deepEqual(codes(runSopsCheck(repo({ ...clean, 'c/app.enc.YAML': 'a: 1\n' }))), ['plaintext-secret'])
})

test('a key-material allowance is pinned to the file content: an edited file fails', () => {
  const pem = sh('openssl', ['genpkey', '-algorithm', 'ed25519']).stdout
  const body = `fixture\n${pem}`
  const sha = sh('git', ['hash-object', '--stdin'], { input: body }).stdout.trim()
  const entry = { path: 'f.txt', rule: 'key-material', reason: 'fixture', blob: sha }
  assert.deepEqual(runSopsCheck(repo({ ...clean, 'f.txt': body }, { allow: { allow: [entry] } })).problems, [])
  const edited = runSopsCheck(repo({ ...clean, 'f.txt': body + 'more\n' }, { allow: { allow: [entry] } }))
  assert.deepEqual(codes(edited), ['allow-stale', 'key-material'])
  const unpinned = runSopsCheck(repo({ ...clean, 'f.txt': body }, { allow: { allow: [{ ...entry, blob: undefined }] } }))
  assert.deepEqual(codes(unpinned), ['allow-unpinned', 'key-material'])
})

test('round 2: no finding echoes a secret key — not as a foreign recipient, not as a "sentinel"', () => {
  const sk = ALICE.secret.trim().split('\n').pop()
  const enc = encrypt('k: v\n', 'yaml').replace(/recipient: age1\S+/, `recipient: ${sk}`)
  const a = runSopsCheck(repo({ ...clean, 'secrets/x.yaml': enc }))
  assert.ok(a.problems.length >= 1)
  assert.ok(!JSON.stringify(a).includes(sk.slice(20)), 'foreign-recipient echoed a secret key')
  const b = runSopsCheck(repo(clean, { sops: sopsYaml(`<${sk}>`) }))
  assert.ok(b.problems.length >= 1)
  assert.ok(!JSON.stringify(b).includes(sk.slice(20)), 'sentinel-recipient echoed a secret key')
})
