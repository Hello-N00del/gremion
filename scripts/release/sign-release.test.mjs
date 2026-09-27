#!/usr/bin/env node
// node --test suite: scripts/release/sign-release.sh — the operator's manual
// signing step (TASK-046 brief §1 bullet 4, §6 item 3; run by TASK-048).
//
// It must sign and attest BY DIGEST ONLY, refuse without a green
// scripts/verify/check-record.mjs for HEAD (TASK-045; absent = refuse), refuse
// a key path inside a git checkout, and print no transparency-log line.
//
// Each case runs the script from a throwaway git repository that carries a
// copy of sign-release.sh and, where the case needs one, a FAKE
// check-record.mjs whose verdict the case chooses. Signing is real: a local
// digest-pinned registry, the pinned cosign, the pinned syft container and an
// ephemeral key outside the repository.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, copyFileSync, chmodSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import { Harness, RELEASE_DIR, sh } from './lib/harness.mjs'
import { IMAGES, assertCosign } from './lib/tools.mjs'

const SCRIPT = join(RELEASE_DIR, 'sign-release.sh')
let h, key, stranger

before(async () => {
  assertCosign()
  h = new Harness('sign')
  await h.startRegistry()
  key = h.keyPair('release')
  stranger = h.keyPair('stranger')
})
after(() => h?.teardown())

const git = (cwd, ...a) => sh('git', ['-C', cwd, ...a])

let n = 0
/** A committed throwaway repo carrying sign-release.sh and (optionally) a fake check-record. */
function repo({ record = 'green', withRecord = true } = {}) {
  n += 1
  const r = join(h.tmp, `repo-${n}`)
  mkdirSync(join(r, 'scripts/release'), { recursive: true })
  copyFileSync(SCRIPT, join(r, 'scripts/release/sign-release.sh'))
  chmodSync(join(r, 'scripts/release/sign-release.sh'), 0o755)
  writeFileSync(join(r, '.gitignore'), 'keys/\n')
  if (withRecord) {
    mkdirSync(join(r, 'scripts/verify'), { recursive: true })
    writeFileSync(
      join(r, 'scripts/verify/check-record.mjs'),
      `import { appendFileSync } from 'node:fs'\n` +
        `appendFileSync(${JSON.stringify(join(h.tmp, `record-${n}.log`))}, process.argv.slice(2).join(' ') + '\\n')\n` +
        `process.exit(${record === 'green' ? 0 : 1})\n`,
    )
  }
  git(r, 'init', '-q')
  git(r, 'add', '-A')
  sh('git', ['-C', r, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'fixture'])
  return r
}

function sign(r, args, env = {}) {
  const res = sh('bash', [join(r, 'scripts/release/sign-release.sh'), ...args], {
    cwd: r,
    env: { ...process.env, COSIGN_PASSWORD: '', ...env },
  })
  return { ...res, out: `${res.stdout}\n${res.stderr}` }
}

const verifies = (ref, pub) =>
  sh('cosign', ['verify', '--key', pub, '--insecure-ignore-tlog=true', ref]).status === 0
const attestVerifies = (ref, pub) =>
  sh('cosign', ['verify-attestation', '--key', pub, '--type', 'cyclonedx', '--insecure-ignore-tlog=true', ref])

test('the syft pin in sign-release.sh equals scripts/release/lib/tools.mjs', () => {
  const src = readFileSync(SCRIPT, 'utf8')
  assert.match(src, new RegExp(`^SYFT_IMAGE="${IMAGES.syft.replace(/[.]/g, '\\.')}"$`, 'm'))
})

test('a green record for HEAD: signs and attests by digest, no tlog line, verifiable with the key', () => {
  const r = repo()
  const ref = h.pushImage('gremion-ui', 'sign-ok', {
    'app/node_modules/left-pad/package.json': '{"name":"left-pad","version":"1.3.0"}\n',
  })
  const res = sign(r, ['--key', key.key, ref])
  assert.equal(res.status, 0, res.out)
  assert.doesNotMatch(res.out, /tlog|rekor|transparency/i, 'output mentions a transparency log')
  assert.match(res.out, new RegExp(`^SIGNED ${ref.replace(/[.]/g, '\\.')}$`, 'm'))
  assert.match(res.out, /^ATTESTED .* cyclonedx 1\.6 components=\d+$/m)
  // check-record was asked about HEAD, exactly.
  const head = git(r, 'rev-parse', 'HEAD').stdout.trim()
  assert.equal(readFileSync(join(h.tmp, `record-${n}.log`), 'utf8').trim(), `--commit ${head}`)
  // Post-conditions in the registry, with the key — and not with another key.
  assert.ok(verifies(ref, key.pub), 'signature does not verify with the release key')
  assert.ok(!verifies(ref, stranger.pub), 'signature verifies with a stranger key')
  const att = attestVerifies(ref, key.pub)
  assert.equal(att.status, 0, att.stderr)
  const stmt = JSON.parse(Buffer.from(JSON.parse(att.stdout.trim().split('\n')[0]).payload, 'base64').toString())
  assert.equal(stmt.predicateType, 'https://cyclonedx.org/bom')
  assert.equal(stmt.predicate.specVersion, '1.6')
  assert.ok(stmt.predicate.components.some((c) => c.name === 'left-pad' && c.version === '1.3.0'))
  assert.notEqual(attestVerifies(ref, stranger.pub).status, 0, 'attestation verifies with a stranger key')
})

test('no check-record.mjs (TASK-045 absent) is a refusal: fail closed, nothing signed', () => {
  const r = repo({ withRecord: false })
  const ref = h.pushImage('gremion-ui', 'no-record', { 'a.txt': 'no record\n' })
  const res = sign(r, ['--key', key.key, ref])
  assert.notEqual(res.status, 0)
  assert.match(res.out, /check-record\.mjs absent/)
  assert.ok(!verifies(ref, key.pub), 'an image was signed without a check record')
})

test('a red check-record for HEAD is a refusal, nothing signed', () => {
  const r = repo({ record: 'red' })
  const ref = h.pushImage('gremion-ui', 'red-record', { 'a.txt': 'red record\n' })
  const res = sign(r, ['--key', key.key, ref])
  assert.notEqual(res.status, 0)
  assert.match(res.out, /no green check record for HEAD/)
  assert.ok(!verifies(ref, key.pub))
})

test('a tag reference is refused: digests only', () => {
  const r = repo()
  const ref = h.pushImage('gremion-ui', 'tagged', { 'a.txt': 'tagged\n' })
  const tagRef = ref.replace(/@sha256:.*/, ':tagged')
  for (const bad of [tagRef, `${tagRef}@${ref.split('@')[1]}`]) {
    const res = sign(r, ['--key', key.key, bad])
    assert.notEqual(res.status, 0, `accepted ${bad}`)
    assert.match(res.out, /not a digest reference/)
  }
  assert.ok(!verifies(ref, key.pub))
})

test('a key path inside the repository is refused, even gitignored', () => {
  const r = repo()
  mkdirSync(join(r, 'keys'), { recursive: true })
  copyFileSync(key.key, join(r, 'keys/cosign.key')) // gitignored: the tree stays clean
  assert.equal(git(r, 'status', '--porcelain').stdout, '')
  const ref = h.pushImage('gremion-ui', 'inrepo-key', { 'a.txt': 'in-repo key\n' })
  const res = sign(r, ['--key', join(r, 'keys/cosign.key'), ref])
  assert.notEqual(res.status, 0)
  assert.match(res.out, /inside the repository/)
  assert.ok(!verifies(ref, key.pub))
})

test('a dirty tree, no key, or no image is refused', () => {
  const r = repo()
  const ref = h.pushImage('gremion-ui', 'dirty', { 'a.txt': 'dirty\n' })
  writeFileSync(join(r, 'untracked.txt'), 'x\n')
  const dirty = sign(r, ['--key', key.key, ref])
  assert.notEqual(dirty.status, 0)
  assert.match(dirty.out, /working tree is not clean/)
  const r2 = repo()
  const noKey = sign(r2, [ref])
  assert.equal(noKey.status, 2, noKey.out)
  const noImg = sign(r2, ['--key', key.key])
  assert.equal(noImg.status, 2, noImg.out)
  assert.ok(!verifies(ref, key.pub))
  assert.ok(existsSync(join(r, 'untracked.txt')))
})

test('an SBOM failure on a later image leaves NO image signed (all SBOMs before any signature)', () => {
  const r = repo()
  const first = h.pushImage('gremion-ui', 'order-1', { 'app/node_modules/a/package.json': '{"name":"a","version":"1.0.0"}\n' })
  const missing = `${h.registry}/hello-n00del/gremion-ui@sha256:${'e'.repeat(64)}` // no such manifest
  const res = sign(r, ['--key', key.key, first, missing])
  assert.notEqual(res.status, 0)
  assert.match(res.out, /syft could not produce an SBOM .*nothing signed/)
  assert.ok(!verifies(first, key.pub), 'the first image was signed before the second SBOM failed')
})
