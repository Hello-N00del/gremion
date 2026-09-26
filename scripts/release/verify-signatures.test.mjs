#!/usr/bin/env node
// node --test suite: gremion-deploy refuses a first-party image whose cosign
// signature does not verify against the HOST-pinned public key (TASK-046,
// TRD-441, brief §1 bullets 1-3).
//
// This drives the REAL infra/host/bin/gremion-deploy against a REAL local
// registry (digest-pinned registry:2 on 127.0.0.1:<free port>) with the REAL
// pinned cosign. Only docker (login/logout) and git (the clone) are shimmed, so
// the program reaches step 2 with a release tree whose pins name images in the
// local registry. Step 3 then stops on the missing last-backup.json with exit 2,
// which is the observable marker that step 2 — where the verification lives —
// passed. A refusal is observed as the step-2 failure line in deploy.log plus
// the named reason, and as the ABSENCE of the step-3 marker.
//
// Keys are ephemeral (lib/harness.mjs); nothing here is signed with a real key.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync, chmodSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { Harness, REPO_ROOT, sh } from './lib/harness.mjs'
import { assertCosign } from './lib/tools.mjs'

const DEPLOY = join(REPO_ROOT, 'infra/host/bin/gremion-deploy')
const VALID = join(REPO_ROOT, 'test/host/fixtures/release/valid')

let h
let hostKey, otherKey
const refs = {}

before(async () => {
  assertCosign()
  h = new Harness('sig')
  await h.startRegistry()
  hostKey = h.keyPair('host')
  otherKey = h.keyPair('other')

  refs.signedUi = h.pushImage('gremion-ui', 'dist-v1.2.3', { 'app/ui.txt': 'ui v1.2.3\n' })
  refs.signedPublic = h.pushImage('gremion-public', 'dist-v1.2.3', { 'app/pub.txt': 'public v1.2.3\n' })
  refs.signedMigrate = h.pushImage('gremion-migrate', 'dist-v1.2.3', { 'app/mig.txt': 'migrate v1.2.3\n' })
  for (const r of [refs.signedUi, refs.signedPublic, refs.signedMigrate]) h.sign(r, hostKey.key)

  refs.unsigned = h.pushImage('gremion-ui', 'unsigned', { 'app/ui.txt': 'never signed\n' })

  refs.otherKey = h.pushImage('gremion-ui', 'otherkey', { 'app/ui.txt': 'signed by a stranger\n' })
  h.sign(refs.otherKey, otherKey.key)

  // Tag re-pushed after signing: the signed digest and the re-pushed digest
  // differ, and the release pins the NEW digest.
  const before = h.pushImage('gremion-ui', 'repushed', { 'app/ui.txt': 'the signed build\n' })
  h.sign(before, hostKey.key)
  refs.repushed = h.pushImage('gremion-ui', 'repushed', { 'app/ui.txt': 'swapped in after signing\n' })
  assert.notEqual(before, refs.repushed, 'the re-push must produce a new digest')
})

after(() => {
  h?.teardown()
})

// ── the deploy fixture ─────────────────────────────────────────────────────

function pinsFile(images) {
  const svc = ['gremion-ui', 'gremion-public', 'migrate', 'postgres', 'extra']
  let out = 'services:\n'
  images.forEach((ref, i) => {
    out += `  ${svc[i]}:\n    build: !reset null\n    image: ${ref}\n`
  })
  return out
}

let caseNo = 0
/**
 * Runs gremion-deploy with pins naming `images`. Options:
 *   hostPub   — the file installed as $ROOT/etc/cosign.pub (null = none)
 *   treePub   — a cosign.pub planted inside the RELEASE TREE (the attacker's)
 *   noCosign  — PATH carries no cosign at all
 *   registry  — REGISTRY_HOST override
 *   thirdParty — repositories written to the host's etc/third-party-images
 *   extraResolved — an image compose resolves that no canonical pins line names
 *   profiledResolved — an image compose resolves only with every profile on
 *                      (COMPOSE_PROFILES=*), like a service under profiles: [migrate]
 */
function deploy(images, opts = {}) {
  caseNo += 1
  const root = join(h.tmp, `root-${caseNo}`)
  const shims = join(h.tmp, `shims-${caseNo}`)
  const tree = join(h.tmp, `tree-${caseNo}`)
  for (const d of ['etc/env', 'runtime', 'releases', 'bin']) mkdirSync(join(root, d), { recursive: true })
  mkdirSync(shims, { recursive: true })
  h.copyTree(VALID, `tree-${caseNo}`)
  writeFileSync(join(tree, 'docker-compose.pins.yml'), pinsFile(images))
  if (opts.treePub) {
    copyFileSync(opts.treePub, join(tree, 'cosign.pub'))
    mkdirSync(join(tree, 'etc'), { recursive: true })
    copyFileSync(opts.treePub, join(tree, 'etc', 'cosign.pub'))
  }
  if (opts.hostPub !== null) copyFileSync(opts.hostPub ?? hostKey.pub, join(root, 'etc', 'cosign.pub'))
  if (opts.thirdParty) writeFileSync(join(root, 'etc', 'third-party-images'), opts.thirdParty.join('\n') + '\n')
  writeFileSync(
    join(root, 'etc/env/state.env'),
    'STACK=teststack\nCOMPOSE_PROJECT_NAME=teststack-state\nSOAK_MINUTES=0\nINTERNAL_PUSH_SECRET=test-push-secret\n',
  )
  for (const c of ['blue', 'green']) writeFileSync(join(root, `etc/env/app-${c}.env`), `STACK=teststack\nCOLOUR=${c}\n`)
  const shim = (name, body) => {
    const p = join(shims, name)
    writeFileSync(p, `#!/usr/bin/env bash\nprintf '%s %s\\n' ${name} "$*" >> "${shims}/calls.log"\n${body}\n`)
    chmodSync(p, 0o755)
  }
  shim('git', `while [ "$1" = "-C" ]; do shift 2; done
case "$1" in
  clone) dest="\${*: -1}"; mkdir -p "$dest"; cp -R "${tree}"/. "$dest"/; mkdir -p "$dest/.git"; exit 0 ;;
  rev-parse|rev-list) printf "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\n"; exit 0 ;;
esac
exit 0`)
  // `docker compose … config --images` answers what compose would resolve:
  // the tree's canonical pins plus opts.extraResolved.
  shim('docker', `case "$1" in login) cat >/dev/null; exit 0 ;; esac
case "$*" in *"config --images"*)
  grep -E '^[[:space:]]*image:' "${tree}/docker-compose.pins.yml" | sed -E 's/^[[:space:]]*image:[[:space:]]*//'
  ${opts.extraResolved ? `printf '%s\\n' '${opts.extraResolved}'` : ':'}
  ${opts.profiledResolved ? `[ "\${COMPOSE_PROFILES:-}" = '*' ] && printf '%s\\n' '${opts.profiledResolved}'` : ':'}
  exit 0 ;;
esac
exit 0`)

  let path = `${shims}:${process.env.PATH}`
  if (opts.noCosign) {
    // A PATH that still has bash/jq/git-shim/docker-shim but no cosign.
    const bin = join(h.tmp, `nocosign-${caseNo}`)
    mkdirSync(bin, { recursive: true })
    for (const tool of ['jq', 'df', 'awk', 'sed', 'grep', 'tr', 'wc', 'date', 'mkdir', 'cat', 'cp', 'rm', 'dirname', 'mktemp', 'sort', 'uniq', 'head', 'cut', 'env', 'bash', 'mv', 'chmod', 'ln', 'readlink', 'basename', 'tail', 'printf']) {
      const w = sh('bash', ['-c', `command -v ${tool}`]).stdout.trim()
      if (w) sh('ln', ['-s', w, join(bin, tool)])
    }
    path = `${shims}:${bin}`
  }
  const env = {
    PATH: path,
    HOME: root,
    GREMION_ROOT: root,
    DOCKER_CONFIG: join(root, 'dockercfg'),
    REGISTRY_HOST: opts.registry ?? h.registry,
    NO_COLOR: '1',
  }
  const r = sh('bash', [DEPLOY, 'dist-v1.2.3'], { input: 'TOKEN t\n', env })
  const logPath = join(root, 'runtime/deploy.log')
  const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''
  const out = `${r.stdout}\n${r.stderr}`
  return { status: r.status, out, log, root }
}

const passedStep2 = (res) => / STEP 2 checkout ok$/m.test(res.log) && /last-backup\.json absent/.test(res.out)
const refusedAtStep2 = (res) =>
  res.status !== 0 && / STEP 2 checkout fail$/m.test(res.log) && !/ STEP 2 checkout ok$/m.test(res.log) && !/last-backup\.json absent/.test(res.out)

// ── the cases ───────────────────────────────────────────────────────────────

test('an image set signed with the host-pinned key passes step 2', () => {
  const res = deploy([refs.signedUi, refs.signedPublic, refs.signedMigrate])
  assert.ok(passedStep2(res), `expected step 2 ok then the step-3 precondition stop:\n${res.out}\n${res.log}`)
  assert.match(res.out, /3 first-party image\(s\) verified against .*etc\/cosign\.pub/)
})

test('an UNSIGNED first-party image is refused at step 2, before any pull', () => {
  const res = deploy([refs.signedUi, refs.unsigned, refs.signedMigrate])
  assert.ok(refusedAtStep2(res), `unsigned image was not refused:\n${res.out}\n${res.log}`)
  assert.match(res.out, /signature verification failed for .*gremion-ui@sha256:/)
})

test('an image signed with ANOTHER key is refused', () => {
  const res = deploy([refs.signedUi, refs.otherKey])
  assert.ok(refusedAtStep2(res), `other-key image was not refused:\n${res.out}\n${res.log}`)
  assert.match(res.out, /signature verification failed/)
})

test('a tag re-pushed after signing (new digest pinned) is refused', () => {
  const res = deploy([refs.repushed, refs.signedPublic])
  assert.ok(refusedAtStep2(res), `re-pushed tag was not refused:\n${res.out}\n${res.log}`)
  assert.match(res.out, /signature verification failed for .*gremion-ui@sha256:/)
})

test('a cosign.pub swapped into the release tree changes nothing: the host key is the anchor', () => {
  // The attacker signs with their own key and ships its public half in the
  // tree. The host still verifies against $ROOT/etc/cosign.pub and refuses.
  const res = deploy([refs.otherKey], { treePub: otherKey.pub })
  assert.ok(refusedAtStep2(res), `tree-shipped key was honoured:\n${res.out}\n${res.log}`)
  // …and the same tree with the image signed by the HOST key passes, so the
  // tree's key is not consulted in either direction.
  const ok = deploy([refs.signedUi], { treePub: otherKey.pub })
  assert.ok(passedStep2(ok), `host-signed image refused when a tree key was present:\n${ok.out}`)
})

test('a missing host key ($ROOT/etc/cosign.pub) is a refusal, never a skip', () => {
  const res = deploy([refs.signedUi], { hostPub: null })
  assert.ok(refusedAtStep2(res), `deploy proceeded with no host key:\n${res.out}\n${res.log}`)
  assert.match(res.out, /cosign\.pub/)
})

test('cosign absent from PATH is a refusal, never a skip', () => {
  const res = deploy([refs.signedUi], { noCosign: true })
  assert.ok(refusedAtStep2(res), `deploy proceeded without cosign:\n${res.out}\n${res.log}`)
  assert.match(res.out, /cosign not on PATH/)
})

test('an unreachable registry is a refusal, never a skip', async () => {
  // A port nothing listens on, carrying signed-looking refs.
  const dead = '127.0.0.1:9'
  const img = refs.signedUi.replace(h.registry, dead)
  const res = deploy([img], { registry: dead })
  assert.ok(refusedAtStep2(res), `deploy proceeded with the registry down:\n${res.out}\n${res.log}`)
  assert.match(res.out, /signature verification failed for 127\.0\.0\.1:9\//)
})

test('an empty first-party set is a refusal, never a vacuous pass', () => {
  // Only third-party pins: nothing under <REGISTRY_HOST>/hello-n00del/.
  const third = 'mirror.gcr.io/library/registry@sha256:' + 'a'.repeat(64)
  const res = deploy([third], { thirdParty: ['mirror.gcr.io/library/registry'] })
  assert.ok(refusedAtStep2(res), `deploy proceeded with no first-party image:\n${res.out}\n${res.log}`)
  assert.match(res.out, /no first-party image/)
})

test('an unsigned image renamed OUT of the first-party prefix is refused, even beside a signed one', () => {
  // Same registry, same repository, spelled with an explicit port: it escapes
  // a prefix match, so only the host's third-party list may admit it.
  const renamed = refs.unsigned.replace(`${h.registry}/`, `${h.registry.replace(/:\d+$/, '')}:${h.port}/`).replace('127.0.0.1', 'localhost')
  const res = deploy([refs.signedUi, renamed])
  assert.ok(refusedAtStep2(res), `renamed unsigned image got through:\n${res.out}\n${res.log}`)
  assert.match(res.out, /is neither first-party .* nor on the host third-party list/)
  // Listed by the host it is admitted as third-party — the host decides, not the tree.
  const listed = deploy([refs.signedUi, renamed], { thirdParty: [renamed.split('@')[0]] })
  assert.ok(passedStep2(listed), listed.out)
  assert.match(listed.out, /1 first-party image\(s\) verified .* 1 third-party image\(s\) on the host list/)
})

test('an unsigned first-party image that only compose resolves (not a canonical pin) is refused live', () => {
  const res = deploy([refs.signedUi], { extraResolved: refs.unsigned })
  assert.ok(refusedAtStep2(res), `compose-only unsigned image got through:\n${res.out}\n${res.log}`)
  assert.match(res.out, /signature verification failed for .*gremion-ui@sha256:/)
})

test('a first-party tag@digest pin (the pin-images.sh form) verifies live against cosign\'s tagless docker-reference', () => {
  // cosign records the repository without a tag; the gate must compare the
  // tagless repository, or every release in the repo's own pin form is refused.
  const tagged = refs.signedUi.replace('@sha256:', ':dist-v1.2.3@sha256:')
  assert.notEqual(tagged, refs.signedUi)
  const res = deploy([tagged, refs.signedPublic])
  assert.ok(passedStep2(res), `tag@digest first-party pin was refused:\n${res.out}\n${res.log}`)
  assert.match(res.out, /2 first-party image\(s\) verified/)
})

test('an unsigned image under an inactive compose profile (step 7 migrate) is refused live', () => {
  const res = deploy([refs.signedUi], { profiledResolved: refs.unsigned })
  assert.ok(refusedAtStep2(res), `profiled unsigned image got through:\n${res.out}\n${res.log}`)
  assert.match(res.out, /signature verification failed for .*gremion-ui@sha256:/)
})
