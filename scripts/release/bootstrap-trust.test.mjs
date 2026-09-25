#!/usr/bin/env node
// node --test suite: infra/host/bootstrap.sh 'trust' stage installs the
// sha256-pinned cosign and the operator's PUBLIC key as $ROOT/etc/cosign.pub —
// the trust anchor gremion-deploy verifies against (TASK-046, brief §1 bullet 2).
//
// bootstrap.sh is SOURCED (it runs nothing when sourced) and stage_trust is
// called with require_root, curl and chown replaced by shell functions, so no
// test touches /usr/local/bin, the network or a real root filesystem. The
// "download" serves the pinned cosign already on PATH, or a tampered copy.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'

import { Harness, REPO_ROOT, sh } from './lib/harness.mjs'
import { COSIGN, assertCosign } from './lib/tools.mjs'

const BOOTSTRAP = join(REPO_ROOT, 'infra/host/bootstrap.sh')
const h = new Harness('trust')
after(() => h.teardown())

let n = 0
function stageTrust({ keyFile, download = 'pinned', preinstalled = false } = {}) {
  n += 1
  const root = join(h.tmp, `root-${n}`)
  const bin = join(h.tmp, `bin-${n}`)
  mkdirSync(join(root, 'etc'), { recursive: true })
  mkdirSync(bin, { recursive: true })
  const cosign = assertCosign()
  const served = join(h.tmp, `served-${n}`)
  if (download === 'pinned') copyFileSync(cosign, served)
  else writeFileSync(served, 'not the pinned cosign\n')
  if (preinstalled) copyFileSync(cosign, join(bin, 'cosign'))
  const script = `
set -euo pipefail
source "${BOOTSTRAP}"
require_root() { :; }
chown() { :; }
curl() { local out=""; while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2 ;; *) shift ;; esac; done
         printf 'curl %s\\n' "$out" >> "${h.tmp}/curl-${n}.log"; cp "${served}" "$out"; }
stage_trust
`
  const r = sh('bash', ['-c', script], {
    env: {
      ...process.env,
      GREMION_ROOT: root,
      COSIGN_INSTALL_DIR: bin,
      COSIGN_PUBKEY_FILE: keyFile ?? '',
      NO_COLOR: '1',
    },
  })
  return { ...r, out: `${r.stdout}\n${r.stderr}`, root, bin, curlLog: join(h.tmp, `curl-${n}.log`) }
}

test('the bootstrap cosign pin equals the pin in scripts/release/lib/tools.mjs', () => {
  const src = readFileSync(BOOTSTRAP, 'utf8')
  assert.match(src, new RegExp(`^COSIGN_VERSION="${COSIGN.version}"$`, 'm'))
  assert.match(src, new RegExp(`^COSIGN_SHA256="${COSIGN.sha256}"$`, 'm'))
})

test("'trust' is a documented stage with a --cosign-pubkey option, and not part of 'all'", () => {
  const r = sh('bash', [BOOTSTRAP, '--help'])
  assert.equal(r.status, 0)
  assert.match(r.stdout, /^ {2}trust {8}/m)
  assert.match(r.stdout, /--cosign-pubkey PATH/)
  const allLine = readFileSync(BOOTSTRAP, 'utf8').split('\n').find((l) => /^\s+all\)\s/.test(l))
  assert.ok(allLine && !/stage_trust/.test(allLine), "stage_trust must not run from 'all'")
})

test('the trust stage installs the pinned cosign and the public key as etc/cosign.pub (0644)', () => {
  const k = h.keyPair('good')
  const r = stageTrust({ keyFile: k.pub })
  assert.equal(r.status, 0, r.out)
  const dst = join(r.root, 'etc/cosign.pub')
  assert.equal(readFileSync(dst, 'utf8'), readFileSync(k.pub, 'utf8'))
  assert.equal((statSync(dst).mode & 0o777).toString(8), '644')
  assert.equal(sh('sha256sum', [join(r.bin, 'cosign')]).stdout.split(' ')[0], COSIGN.sha256)
  assert.match(r.out, /release trust anchor installed at .*etc\/cosign\.pub/)
})

test('an already-installed pinned cosign is not downloaded again', () => {
  const k = h.keyPair('again')
  const r = stageTrust({ keyFile: k.pub, preinstalled: true })
  assert.equal(r.status, 0, r.out)
  assert.equal(existsSync(r.curlLog), false, 'curl was called although the pinned cosign was present')
})

test('a download that does not match the pinned sha256 is refused and nothing is installed', () => {
  const k = h.keyPair('tamper')
  const r = stageTrust({ keyFile: k.pub, download: 'tampered' })
  assert.notEqual(r.status, 0)
  assert.match(r.out, /does not match the pinned sha256/)
  assert.equal(existsSync(join(r.bin, 'cosign')), false)
  assert.equal(existsSync(join(r.root, 'etc/cosign.pub')), false)
})

test('the PRIVATE half is refused before anything is installed', () => {
  const k = h.keyPair('priv')
  const r = stageTrust({ keyFile: k.key })
  assert.notEqual(r.status, 0)
  assert.match(r.out, /PRIVATE key/)
  assert.equal(existsSync(join(r.root, 'etc/cosign.pub')), false)
  assert.equal(existsSync(r.curlLog), false)
})

test('no --cosign-pubkey is a usage error (exit 2); a non-PEM file is refused', () => {
  const r = stageTrust({})
  assert.equal(r.status, 2, r.out)
  assert.match(r.out, /pass --cosign-pubkey/)
  const junk = join(h.tmp, 'junk.pub')
  writeFileSync(junk, 'ssh-ed25519 AAAA not-a-pem-key\n')
  const j = stageTrust({ keyFile: junk })
  assert.notEqual(j.status, 0)
  assert.match(j.out, /not a PEM public key/)
})
