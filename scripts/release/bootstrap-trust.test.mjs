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
function stageTrust({ keyFile, download = 'pinned', preinstalled = false, arch = 'x86_64' } = {}) {
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
uname() { if [ "$1" = "-m" ]; then echo ${arch}; else command uname "$@"; fi; }
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

// ---- 'signers' stage (H10): <root>/etc/allowed_signers, the release-tag anchor ----

const SIGNER_LINE = 'release@example.test namespaces="git" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeFakeFakeFakeFakeFakeFakeFakeFakeFake'

function stageSigners({ file, content, noEtc = false } = {}) {
  n += 1
  const root = join(h.tmp, `sroot-${n}`)
  mkdirSync(noEtc ? root : join(root, 'etc'), { recursive: true })
  let src = file ?? ''
  if (content !== undefined) {
    src = join(h.tmp, `signers-${n}`)
    writeFileSync(src, content)
  }
  const script = `
set -euo pipefail
source "${BOOTSTRAP}"
require_root() { :; }
chown() { :; }
stage_signers
`
  const r = sh('bash', ['-c', script], {
    env: { ...process.env, GREMION_ROOT: root, ALLOWED_SIGNERS_FILE: src, NO_COLOR: '1' },
  })
  return { ...r, out: `${r.stdout}\n${r.stderr}`, root, src, dst: join(root, 'etc/allowed_signers') }
}

test("'signers' is a documented stage with an --allowed-signers option, and not part of 'all'", () => {
  const r = sh('bash', [BOOTSTRAP, '--help'])
  assert.equal(r.status, 0)
  assert.match(r.stdout, /^ {2}signers {6}/m)
  assert.match(r.stdout, /--allowed-signers PATH/)
  const allLine = readFileSync(BOOTSTRAP, 'utf8').split('\n').find((l) => /^\s+all\)\s/.test(l))
  assert.ok(allLine && !/stage_signers/.test(allLine), "stage_signers must not run from 'all'")
})

test('the signers stage installs the file as etc/allowed_signers (0644), byte for byte', () => {
  const r = stageSigners({ content: `# the release signer\n${SIGNER_LINE}\n` })
  assert.equal(r.status, 0, r.out)
  assert.equal(readFileSync(r.dst, 'utf8'), readFileSync(r.src, 'utf8'))
  // NTFS reports 666 for every file; the stage itself asserts 644 with stat(1)
  if (process.platform !== 'win32') assert.equal((statSync(r.dst).mode & 0o777).toString(8), '644')
  assert.match(r.out, /release-tag signers installed at .*etc\/allowed_signers \(1 signer/)
})

test('the signers stage is the --allowed-signers option end to end (bootstrap.sh run as a program)', () => {
  const src = join(h.tmp, 'signers-cli')
  writeFileSync(src, `${SIGNER_LINE}\n`)
  const r = sh('bash', [BOOTSTRAP, '--allowed-signers', src, 'signers'], {
    env: { ...process.env, GREMION_ROOT: join(h.tmp, 'cli-root'), NO_COLOR: '1' },
  })
  // not root here, so the program stops at require_root: the option parsed and the stage dispatched
  assert.notEqual(r.status, 0)
  assert.doesNotMatch(`${r.stdout}\n${r.stderr}`, /unknown (stage|option)/)
})

test('no --allowed-signers is a usage error (exit 2); a missing file is a precondition failure', () => {
  const r = stageSigners({})
  assert.equal(r.status, 2, r.out)
  assert.match(r.out, /pass --allowed-signers/)
  const m = stageSigners({ file: join(h.tmp, 'does-not-exist') })
  assert.equal(m.status, 2, m.out)
  assert.match(m.out, /not found/)
})

test('a PRIVATE key, an empty file, an unscoped entry and a non-key entry are refused; nothing is installed', () => {
  const cases = [
    // the PEM markers are built at runtime so this fixture is not itself key material to scripts/release/check-sops.mjs
    ['private', `${'-'.repeat(5)}BEGIN OPENSSH ${'PRIVATE'} KEY${'-'.repeat(5)}\nAAAA\n${'-'.repeat(5)}END OPENSSH ${'PRIVATE'} KEY${'-'.repeat(5)}\n`, /PRIVATE key/],
    ['empty', '', /lists no signer/],
    ['comments only', '# nothing\n\n', /lists no signer/],
    ['unscoped', 'release@example.test ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFake\n', /not restricted to namespaces="git"/],
    ['no key', 'release@example.test namespaces="git" not-a-key\n', /holds no ssh public key/],
  ]
  for (const [name, content, re] of cases) {
    const r = stageSigners({ content })
    assert.notEqual(r.status, 0, `${name}: ${r.out}`)
    assert.match(r.out, re, name)
    assert.equal(existsSync(r.dst), false, `${name}: a refused file was installed`)
  }
})

test('the signers stage needs the host layout (the user stage) first', () => {
  const r = stageSigners({ content: `${SIGNER_LINE}\n`, noEtc: true })
  assert.equal(r.status, 2, r.out)
  assert.match(r.out, /run the 'user' stage first/)
})

test('a host that is not x86_64 is refused by name (only the linux-amd64 asset is pinned)', () => {
  const k = h.keyPair('arm')
  const r = stageTrust({ keyFile: k.pub, arch: 'aarch64' })
  assert.notEqual(r.status, 0)
  assert.match(r.out, /only the linux-amd64 cosign is pinned; this host is aarch64/)
  assert.equal(existsSync(r.curlLog), false)
})
