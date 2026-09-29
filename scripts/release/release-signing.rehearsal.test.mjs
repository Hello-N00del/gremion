#!/usr/bin/env node
// node --test suite: the TRD-114 release-signing procedure of
// docs/ops/release-signing.md, rehearsed end to end on throwaway material
// (TASK-048). This is a REHEARSAL with a STUB RECORD: the check record is a
// stub check-record.mjs that prints `STUB: rehearsal only`; the real verify
// record, the vault key and private GHCR are exercised only by the operator's
// first real signing (Q9, a residual of TASK-048).
//
// Mechanism (brief section 5): the TASK-046 harness (a digest-pinned local
// registry:2 on 127.0.0.1, throwaway cosign key pairs, teardown by name); a
// nested throwaway git repository under the harness scratch dir carries
// sign-release.sh and the stub record, committed clean; the keys stay in the
// harness scratch dir, OUTSIDE the nested repository's toplevel, as the
// procedure requires of the vault path.
//
// Missing docker or cosign is a FAIL, never a skip: lint-release.sh fails on
// any skipped test.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, copyFileSync, chmodSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'

import { Harness, RELEASE_DIR, sh } from './lib/harness.mjs'
import { assertCosign } from './lib/tools.mjs'
import { appServices, parsePinLines, emitPins } from './emit-pins.mjs'
import { checkPins } from './check-pins.mjs'

const SIGN = join(RELEASE_DIR, 'sign-release.sh')
const STUB = 'STUB: rehearsal only'
const BASH = sh('bash', ['-c', 'command -v bash']).stdout.trim()
let h, key, other

before(async () => {
  assertCosign() // throws: missing or unpinned cosign fails the suite
  h = new Harness('t048')
  await h.startRegistry() // throws: no docker fails the suite
  key = h.keyPair('rehearsal')
  other = h.keyPair('other')
})
after(() => h?.teardown())

const git = (cwd, ...a) => sh('git', ['-C', cwd, ...a])
let n = 0
/** A committed throwaway repo carrying sign-release.sh and the STUB check record. */
function nestedRepo() {
  n += 1
  const r = join(h.tmp, `rehearsal-repo-${n}`)
  mkdirSync(join(r, 'scripts/release'), { recursive: true })
  mkdirSync(join(r, 'scripts/verify'), { recursive: true })
  copyFileSync(SIGN, join(r, 'scripts/release/sign-release.sh'))
  chmodSync(join(r, 'scripts/release/sign-release.sh'), 0o755)
  writeFileSync(join(r, 'scripts/verify/check-record.mjs'), `console.log(${JSON.stringify(STUB)})\nprocess.exit(0)\n`)
  writeFileSync(join(r, '.gitignore'), 'keys/\n')
  git(r, 'init', '-q')
  git(r, 'add', '-A')
  sh('git', ['-C', r, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'rehearsal'])
  return r
}

function signRelease(r, args, env = {}) {
  // bash by absolute path: a case may hand the script a PATH without it
  const res = sh(BASH, [join(r, 'scripts/release/sign-release.sh'), ...args], {
    cwd: r,
    env: { ...process.env, COSIGN_PASSWORD: '', ...env },
  })
  return { ...res, out: `${res.stdout}\n${res.stderr}` }
}

const verify = (ref, pub) => sh('cosign', ['verify', '--key', pub, '--insecure-ignore-tlog=true', ref])

test('rehearsal (stub record): push -> emit-pins -> check-pins -> sign-release.sh -> cosign verify with the rehearsal key; no tlog; another key fails', () => {
  // push: a first-party image into the rehearsal registry (never GHCR)
  const ref = h.pushImage('gremion-legal', 'rehearsal', {
    'app/node_modules/left-pad/package.json': '{"name":"left-pad","version":"1.3.0"}\n',
  })
  // emit-pins + check-pins over a one-service app compose
  const compose = 'services:\n  legal:\n    build: ./legal\n    image: x\n'
  const services = appServices(compose)
  const pins = emitPins(parsePinLines(`legal=${ref}\n`), services, { firstPartyPrefix: `${h.registry}/hello-n00del/` })
  assert.deepEqual(checkPins(pins, { services }), [])
  // sign-release.sh: clean nested tree, stub record, key outside the toplevel
  const r = nestedRepo()
  const res = signRelease(r, ['--key', key.key, ref])
  assert.equal(res.status, 0, res.out)
  assert.ok(res.out.includes(STUB), 'the stub record did not run: the rehearsal must say it is a stub')
  assert.match(res.out, new RegExp(`^SIGNED ${ref.replace(/[.]/g, '\\.')}$`, 'm'))
  assert.doesNotMatch(res.out, /tlog|rekor|transparency/i, 'sign-release output mentions a transparency log')
  // cosign verify: the rehearsal public key verifies; no tlog claim was checked
  const ok = verify(ref, key.pub)
  assert.equal(ok.status, 0, ok.stderr)
  assert.match(ok.stderr, /The signatures were verified against the specified public key/)
  // No tlog: the signature in the registry carries no Rekor bundle. (A verify
  // run with --insecure-ignore-tlog never checks the log, so its output cannot
  // prove this; the stored signature can.)
  const dl = sh('cosign', ['download', 'signature', ref])
  assert.equal(dl.status, 0, dl.stderr)
  const sigs = dl.stdout.trim().split('\n').map((l) => JSON.parse(l))
  assert.ok(sigs.length >= 1, 'no signature stored for the image')
  for (const sig of sigs) assert.ok('Base64Signature' in sig && 'Bundle' in sig, `unexpected download shape: ${Object.keys(sig).join(',')}`)
  for (const sig of sigs) assert.ok(sig.Bundle === null, `a Rekor bundle is attached: ${JSON.stringify(sig.Bundle).slice(0, 120)}`)
  const claims = JSON.parse(ok.stdout.trim().split('\n')[0])
  assert.equal(claims[0].critical.image['docker-manifest-digest'], ref.split('@')[1])
  // another key does not verify
  assert.notEqual(verify(ref, other.pub).status, 0, 'the signature verifies with another key')
})

test('rehearsal (stub record): a key inside the nested repository is refused and nothing is signed', () => {
  const r = nestedRepo()
  mkdirSync(join(r, 'keys'), { recursive: true })
  copyFileSync(key.key, join(r, 'keys/cosign.key')) // gitignored: the tree stays clean
  assert.equal(git(r, 'status', '--porcelain').stdout, '')
  const ref = h.pushImage('gremion-legal', 'rehearsal-inrepo', { 'a.txt': 'in-repo key\n' })
  const res = signRelease(r, ['--key', join(r, 'keys/cosign.key'), ref])
  assert.notEqual(res.status, 0, res.out)
  assert.match(res.out, /inside the repository/)
  assert.notEqual(verify(ref, key.pub).status, 0, 'an image was signed with a key from inside the repository')
})

test('rehearsal (stub record): a missing tool is a FAIL, not a skip', () => {
  assert.throws(() => assertCosign({ ...process.env, PATH: '/nonexistent' }), /cosign not on PATH/)
  const r = nestedRepo()
  const bin = join(h.tmp, 'bin-no-cosign')
  mkdirSync(bin, { recursive: true })
  const dirname = sh('bash', ['-c', 'command -v dirname']).stdout.trim()
  symlinkSync(dirname, join(bin, 'dirname'))
  const ref = `${h.registry}/hello-n00del/gremion-legal@sha256:${'e'.repeat(64)}`
  const res = signRelease(r, ['--key', key.key, ref], { PATH: bin })
  assert.notEqual(res.status, 0, res.out)
  assert.match(res.out, /cosign not on PATH/)
})

test('the procedure doc names every step in order and keeps the key in the vault', () => {
  const doc = readFileSync(join(RELEASE_DIR, '../../docs/ops/release-signing.md'), 'utf8')
  const steps = ['make verify', 'docker buildx build', 'emit-pins.mjs', 'check-pins.mjs', 'sign-release.sh', 'cosign verify --key']
  let at = -1
  for (const s of steps) {
    const i = doc.indexOf(s, at + 1)
    assert.ok(i > at, `docs/ops/release-signing.md does not name "${s}" after the previous step`)
    at = i
  }
  assert.match(doc, /outside any checkout/)
  assert.match(doc, /stub record/i)
  assert.doesNotMatch(doc, /-----BEGIN [A-Z ]*KEY-----/)
})
