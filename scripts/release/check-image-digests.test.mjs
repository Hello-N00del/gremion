#!/usr/bin/env node
// node --test suite: scripts/release/check-image-digests.mjs (TASK-048,
// TRD-350 raw arm; TRD-066/354 object-storage arm).
//
// Every case scans a SCRATCH git repository: the committed fixture tree
// scripts/release/fixtures/image-digests/good/ is copied, its decoys/ moved to
// the out-of-scope paths they mirror, one file edited, `git init && git add`.
// Discovery is `git ls-files`, so the scratch repo is what the guard sees.
// The last cases scan the real tree.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, renameSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { checkTree, thirdPartyList, SCAN_PATTERNS } from './check-image-digests.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..')
const GOOD = join(HERE, 'fixtures/image-digests/good')
const SCRATCH = mkdtempSync(join(tmpdir(), 't048-digests-'))
after(() => rmSync(SCRATCH, { recursive: true, force: true }))

const D = (c) => c.repeat(64)
const git = (cwd, ...a) => {
  const r = spawnSync('git', ['-C', cwd, ...a], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`)
  return r.stdout
}

function moveTree(src, dst) {
  for (const e of readdirSync(src)) {
    const s = join(src, e)
    const d = join(dst, e)
    if (statSync(s).isDirectory()) {
      mkdirSync(d, { recursive: true })
      moveTree(s, d)
    } else {
      mkdirSync(dirname(d), { recursive: true })
      renameSync(s, d)
    }
  }
}

let n = 0
/** A scratch repo from the good fixture; `edits` maps path -> content (null deletes). */
function tree(edits = {}, { empty = false } = {}) {
  n += 1
  const r = join(SCRATCH, `t${n}`)
  mkdirSync(r, { recursive: true })
  if (!empty) {
    cpSync(GOOD, r, { recursive: true })
    moveTree(join(r, 'decoys'), r)
    rmSync(join(r, 'decoys'), { recursive: true, force: true })
    renameSync(join(r, 'env.example'), join(r, '.env.example'))
  }
  for (const [p, c] of Object.entries(edits)) {
    if (c === null) rmSync(join(r, p), { force: true })
    else {
      mkdirSync(dirname(join(r, p)), { recursive: true })
      writeFileSync(join(r, p), c)
    }
  }
  git(r, 'init', '-q')
  git(r, 'add', '-A', '-f')
  return r
}

const codes = (res) => [...new Set(res.problems.map((p) => p.code))].sort()
const withCode = (res, code) => res.problems.filter((p) => p.code === code)
const compose = (svc) => `services:\n${svc}`
const fpBuild = (image) => compose(`  x:\n    build: ./x\n    image: ${image}\n`)
const plain = (image) => compose(`  x:\n    image: ${image}\n`)

// ── 1. raw arm ───────────────────────────────────────────────────────────

test('raw: the good fixture passes (tag@digest, ${STALWART_IMAGE:?} resolved from its template, :-dev and :? on build:)', () => {
  const res = checkTree(tree())
  assert.deepEqual(res.problems, [], JSON.stringify(res.problems, null, 1))
  assert.ok(res.files.includes('infra/host/mail/docker-compose.yml'))
  assert.ok(res.refs >= 5, `expected the fixture refs to be read, got ${res.refs}`)
})

test('raw: a tag-only third-party image fails and names file, line and ref', () => {
  const res = checkTree(tree({ 'docker-compose.yml': plain('traefik:v3.7.1') }))
  assert.deepEqual(codes(res), ['unpinned'])
  assert.match(res.problems[0].where, /^docker-compose\.yml:3$/)
  assert.match(res.problems[0].message, /traefik:v3\.7\.1/)
})

test('raw: an image with no tag and no digest fails', () => {
  assert.deepEqual(codes(checkTree(tree({ 'docker-compose.yml': plain('traefik') }))), ['unpinned'])
})

test('raw: a first-party :latest fails even on a build: service', () => {
  const res = checkTree(tree({ 'docker-compose.yml': fpBuild('ghcr.io/hello-n00del/x:latest') }))
  assert.ok(codes(res).includes('latest'), JSON.stringify(res.problems))
})

test('raw: ghcr.io/hello-n00del/x:${IMAGE_TAG:-latest} with build: fails on the literal default', () => {
  const res = checkTree(tree({ 'docker-compose.yml': fpBuild('ghcr.io/hello-n00del/x:${IMAGE_TAG:-latest}') }))
  assert.deepEqual(codes(res), ['latest'])
  // the unhyphenated ${VAR-latest} form too
  const res2 = checkTree(tree({ 'docker-compose.yml': fpBuild('ghcr.io/hello-n00del/x:${IMAGE_TAG-latest}') }))
  assert.ok(codes(res2).includes('latest'), JSON.stringify(res2.problems))
})

test('raw: a first-party ${IMAGE_TAG:-dev} ref WITHOUT build: fails', () => {
  const res = checkTree(tree({ 'docker-compose.yml': plain('ghcr.io/hello-n00del/x:${IMAGE_TAG:-dev}') }))
  assert.deepEqual(codes(res), ['first-party-no-build'])
})

test('raw: a first-party literal tag on a build: service fails (only ${IMAGE_TAG:-dev} / ${IMAGE_TAG:?} are exempt)', () => {
  assert.deepEqual(codes(checkTree(tree({ 'docker-compose.yml': fpBuild('ghcr.io/hello-n00del/x:1.2.3') }))), ['unpinned'])
  assert.deepEqual(codes(checkTree(tree({ 'docker-compose.yml': fpBuild('ghcr.io/hello-n00del/x:${OTHER_TAG:-dev}') }))), ['unpinned'])
})

test('raw: a lookalike prefix is third-party (canonical-prefix compare)', () => {
  for (const img of [
    'ghcr.io.evil/hello-n00del/x:1',
    'ghcr.io.evil/hello-n00del/x:${IMAGE_TAG:-dev}',
    'ghcr.io/hello-n00del-evil/x:${IMAGE_TAG:-dev}',
    'ghcr.io:443/hello-n00del/x:${IMAGE_TAG:-dev}',
  ]) {
    const res = checkTree(tree({ 'docker-compose.yml': fpBuild(img) }))
    assert.deepEqual(codes(res), ['unpinned'], `${img}: ${JSON.stringify(res.problems)}`)
  }
})

test('raw: a 63-hex digest fails', () => {
  assert.deepEqual(codes(checkTree(tree({ 'docker-compose.yml': plain(`traefik:v3.7.1@sha256:${'a'.repeat(63)}`) }))), ['unpinned'])
})

test('raw: a non-canonical image declaration fails ({image: x}, quoted key, trailing garbage)', () => {
  for (const body of [
    `  x: {image: traefik@sha256:${D('a')}}\n`,
    `  x:\n    "image": traefik@sha256:${D('a')}\n`,
    `  x:\n    image: traefik@sha256:${D('a')} extra\n`,
  ]) {
    const res = checkTree(tree({ 'docker-compose.yml': compose(body) }))
    assert.ok(codes(res).includes('non-canonical'), `${body}: ${JSON.stringify(res.problems)}`)
  }
})

test('raw: an unresolvable ${X} fails; a template value that is not a digest fails', () => {
  assert.deepEqual(codes(checkTree(tree({ 'docker-compose.yml': plain('${NOPE_IMAGE}') }))), ['unresolvable'])
  assert.deepEqual(codes(checkTree(tree({ 'docker-compose.yml': plain('traefik:${NOPE_TAG:?x}') }))), ['unresolvable'])
  // IMAGE_TAG resolves from state.env.tmpl to CHANGE_ME_...: a third-party ref is then tag-only.
  assert.deepEqual(codes(checkTree(tree({ 'docker-compose.yml': plain('traefik:${IMAGE_TAG:?x}') }))), ['unpinned'])
  // a mail template value that is a tag
  const res = checkTree(tree({ 'infra/host/templates/env/mail.env.tmpl': 'STALWART_IMAGE=docker.io/stalwartlabs/stalwart:v0.15\n' }))
  assert.ok(codes(res).includes('unpinned'), JSON.stringify(res.problems))
})

test('raw: *_IMAGE= assignments and ${*_IMAGE:-default} defaults must be tag@digest (Q4); IMAGE_TAG=latest fails', () => {
  const bin = (l) => ({ 'infra/host/bin/gremion-helper': `#!/usr/bin/env bash\n${l}\n` })
  assert.deepEqual(codes(checkTree(tree(bin('HELPER_IMAGE="${HELPER_IMAGE:-alpine:3.22}"')))), ['unpinned'])
  assert.deepEqual(codes(checkTree(tree(bin('img="${ARCHIVE_IMAGE:-alpine:3.22}"')))), ['unpinned'])
  assert.deepEqual(codes(checkTree(tree(bin('MC_IMAGE="${MC_IMAGE:-}"')))), ['unpinned'])
  assert.deepEqual(codes(checkTree(tree(bin('export PROBE_IMAGE=curlimages/curl:8')))), ['unpinned'])
  assert.deepEqual(codes(checkTree(tree({ '.env.example': 'IMAGE_TAG=latest\n' }))), ['latest'])
  assert.deepEqual(codes(checkTree(tree({ 'infra/host/templates/env/state.env.tmpl': 'X_IMAGE=nginx:1.29\n' }))), ['unpinned'])
})

test('raw: zero discovered files fails', () => {
  const res = checkTree(tree({}, { empty: true }))
  assert.ok(codes(res).includes('no-files'), JSON.stringify(res.problems))
})

test('raw: an exclusion without a reason, a stale exclusion, and an unreadable exclusions file fail', () => {
  const ex = (e) => ({ 'scripts/release/image-scan-exclusions.json': JSON.stringify({ exclusions: e }) })
  const noReason = checkTree(tree(ex([{ glob: 'infra/host/bin/gremion-legacy', reason: ' ' }])))
  assert.ok(codes(noReason).includes('exclusion-no-reason'), JSON.stringify(noReason.problems))
  const stale = checkTree(tree(ex([
    { glob: 'infra/host/bin/gremion-legacy', reason: 'r' },
    { glob: 'test/host/fixtures/**', reason: 'outside the scan set, so it matches nothing discovered' },
  ])))
  assert.deepEqual(codes(stale), ['exclusion-stale'])
  // unreadable exclusions: named, and nothing is excluded (fail closed)
  assert.deepEqual(codes(checkTree(tree({ 'scripts/release/image-scan-exclusions.json': '{not json' }))), ['exclusions-unreadable', 'unpinned'])
  assert.deepEqual(codes(checkTree(tree({ 'scripts/release/image-scan-exclusions.json': null }))), ['exclusions-unreadable', 'unpinned'])
  assert.deepEqual(codes(checkTree(tree({ 'scripts/release/image-scan-exclusions.json': '{"exclusions": {}}' }))), ['exclusions-unreadable', 'unpinned'])
  // without the exclusion the legacy file is scanned and fails
  assert.deepEqual(codes(checkTree(tree(ex([])))), ['unpinned'])
})

// ── 2. discovery ─────────────────────────────────────────────────────────

test('discovery: a new compose/extra/docker-compose.yml is scanned with no list edit', () => {
  const res = checkTree(tree({ 'compose/extra/docker-compose.yml': plain('nginx:1.29') }))
  assert.deepEqual(codes(res), ['unpinned'])
  assert.match(res.problems[0].where, /^compose\/extra\/docker-compose\.yml:/)
  // the other anchored families too
  for (const p of ['infra/host/extra/docker-compose.yml', 'infra/other/values.yaml', 'docker-compose.extra.yml']) {
    const r = checkTree(tree({ [p]: plain('nginx:1.29') }))
    assert.deepEqual(codes(r), ['unpinned'], p)
  }
})

test('discovery: out-of-scope trees are NOT discovered (anchored pathspecs, never recursive)', () => {
  const res = checkTree(tree())
  for (const f of res.files) {
    assert.doesNotMatch(f, /^(packages|scripts|test|k8s|\.github)\//, `discovered an out-of-scope file: ${f}`)
    assert.doesNotMatch(f, /decoy/)
  }
  // every pattern is anchored at the repository top
  for (const p of SCAN_PATTERNS) assert.match(p, /^:\(top[,)]/, p)
})

// ── 5. object-storage arm ────────────────────────────────────────────────

test('object storage: a minio service or image, an mc image by digest, and a profile fail', () => {
  const svc = checkTree(tree({ 'docker-compose.yml': compose(`  minio:\n    image: minio/minio:RELEASE.2025@sha256:${D('d')}\n`) }))
  assert.deepEqual(codes(svc), ['object-storage-image', 'object-storage-service'])
  const mc = checkTree(tree({ 'infra/host/bin/gremion-helper': `#!/usr/bin/env bash\nMC_IMAGE=quay.io/minio/mc@sha256:${D('e')}\n` }))
  assert.deepEqual(codes(mc), ['object-storage-image'])
  const prof = checkTree(tree({ 'docker-compose.yml': compose(`  store:\n    image: nginx@sha256:${D('f')}\n    profiles: [object-storage]\n`) }))
  assert.deepEqual(codes(prof), ['object-storage-profile'])
  const prof2 = checkTree(tree({ 'docker-compose.yml': compose(`  store:\n    image: nginx@sha256:${D('f')}\n    profiles:\n      - "object-storage"\n`) }))
  assert.deepEqual(codes(prof2), ['object-storage-profile'])
})

test('object storage: a *_S3_* key in a template and a real ${MINIO_...} in a bin script fail', () => {
  const s3 = checkTree(tree({ 'infra/host/templates/env/state.env.tmpl': 'SYNAPSE_MEDIA_S3_ENDPOINT=\n' }))
  assert.deepEqual(codes(s3), ['object-storage-key'])
  const minio = checkTree(tree({ 'infra/host/bin/gremion-helper': '#!/usr/bin/env bash\necho "${MINIO_ENDPOINT}"\n' }))
  assert.deepEqual(codes(minio), ['object-storage-key'])
  const bare = checkTree(tree({ 'infra/host/bin/gremion-helper': '#!/usr/bin/env bash\necho "$MINIO_ENDPOINT"\n' }))
  assert.deepEqual(codes(bare), ['object-storage-key'])
  const exp = checkTree(tree({ '.env.example': 'IMAGE_TAG=dev\nexport MINIO_ROOT_USER=x\n' }))
  assert.deepEqual(codes(exp), ['object-storage-key'])
})

test('object storage: the arm ignores exclusions (no file-level escape for a key)', () => {
  const res = checkTree(tree({ 'infra/host/bin/gremion-legacy': '#!/usr/bin/env bash\necho "${MINIO_ENDPOINT}"\n' }))
  assert.deepEqual(codes(res), ['object-storage-key'])
})

test('object storage: minio or @aws-sdk/client-s3 in pnpm-lock.yaml fails; a missing lockfile fails', () => {
  const lock = (pkg) => ({ 'pnpm-lock.yaml': `lockfileVersion: '9.0'\n\npackages:\n\n  ${pkg}:\n    resolution: {integrity: sha512-x}\n` })
  assert.deepEqual(codes(checkTree(tree(lock('minio@8.0.1')))), ['object-storage-lockfile'])
  assert.deepEqual(codes(checkTree(tree(lock("'@aws-sdk/client-s3@3.700.0'")))), ['object-storage-lockfile'])
  assert.deepEqual(codes(checkTree(tree({ 'pnpm-lock.yaml': null }))), ['lockfile-unreadable'])
})

test('object storage: the Q8 refusal regex line passes (the good fixture carries it)', () => {
  const res = checkTree(tree())
  assert.deepEqual(withCode(res, 'object-storage-key'), [])
})

// ── 8. third-party list ──────────────────────────────────────────────────

test('third-party list: the canonical non-first-party repositories of the fixture tree', () => {
  assert.deepEqual(thirdPartyList(tree()), [
    'docker.io/library/alpine',
    'docker.io/library/redis',
    'docker.io/stalwartlabs/stalwart',
  ])
  assert.throws(() => thirdPartyList(tree({ 'docker-compose.yml': plain('nginx:1.29') })), /unpinned/)
})

// ── review round 1 (TASK-048 self-review: security, silent-failure, quality) ──

test('r1: a first-party lookalike is refused, never listed as third-party (host allow-list would skip its signature)', () => {
  for (const img of [
    `ghcr.io:443/hello-n00del/app@sha256:${D('a')}`,
    `GHCR.IO/hello-n00del/app@sha256:${D('a')}`,
    `ghcr.io.evil/hello-n00del/app@sha256:${D('a')}`,
    `docker.io/hello-n00del/app@sha256:${D('a')}`,
    `ghcr.io/Hello-N00del/app@sha256:${D('a')}`,
  ]) {
    const r = tree({ 'docker-compose.yml': plain(img) })
    assert.ok(codes(checkTree(r)).includes('first-party-lookalike'), img)
    assert.throws(() => thirdPartyList(r), /first-party-lookalike/, img)
  }
})

test('r1: a minio image anywhere in a scanned file fails, not only on image:/ *_IMAGE= lines', () => {
  const bin = (l) => ({ 'infra/host/bin/gremion-helper': `#!/usr/bin/env bash\n${l}\n` })
  for (const l of [
    'docker run --rm --network host quay.io/minio/mc:RELEASE.2025 ls gremion',
    `docker run --rm minio/mc@sha256:${D('a')} ls`,
    'MC="${MC:-minio/mc:RELEASE.2025}"',
  ]) assert.ok(codes(checkTree(tree(bin(l)))).includes('object-storage-image'), l)
})

test('r1: YAML the line scan cannot see is refused: lone CR/NEL/LS/PS breaks, escaped, explicit and alias keys', () => {
  for (const body of [
    '  x:\n    # c\r    image: nginx:1.29\n',
    '  x:\n    # c\u0085    image: nginx:1.29\n',
    '  x:\n    # c\u2028    image: nginx:1.29\n',
    '  x:\n    "\\x69mage": nginx:1.29\n',
    '  x:\n    ? image\n    : nginx:1.29\n',
    'x-k: [&k image]\nservices:\n  x:\n    *k : nginx:1.29\n',
  ]) {
    const text = body.startsWith('x-k') ? body : compose(body)
    const res = checkTree(tree({ 'docker-compose.yml': text }))
    assert.ok(res.problems.length > 0 && codes(res).some((c) => ['yaml-line-break', 'non-canonical'].includes(c)), JSON.stringify(body))
  }
})

test('r1: compose extends/include and a COMPOSE_FILE component outside the scan set fail', () => {
  assert.deepEqual(codes(checkTree(tree({ 'docker-compose.yml': compose(`  x:\n    extends: {file: test/x.yml, service: y}\n`) }))), ['compose-include'])
  assert.deepEqual(codes(checkTree(tree({ 'docker-compose.yml': compose(`  x:\n    extends:\n      file: test/x.yml\n      service: y\n`) }))), ['compose-include'])
  assert.deepEqual(codes(checkTree(tree({ 'docker-compose.yml': `include:\n  - k8s/evil/compose.yml\n${compose(`  x:\n    image: redis@sha256:${D('a')}\n`)}` }))), ['compose-include'])
  const mail = { 'infra/host/templates/env/mail.env.tmpl': `COMPOSE_FILE=docker-compose.yml:extra.yaml\nSTALWART_IMAGE=docker.io/stalwartlabs/stalwart@sha256:${D('b')}\n` }
  assert.deepEqual(codes(checkTree(tree(mail))), ['compose-file-unscanned'])
  // the release pins layer is judged by check-pins/gremion-deploy, never committed
  const pins = { 'infra/host/templates/env/state.env.tmpl': 'IMAGE_TAG=CHANGE_ME_OPERATOR_image_tag\nCOMPOSE_FILE=docker-compose.yml:docker-compose.pins.yml\n' }
  assert.deepEqual(checkTree(tree(pins)).problems, [])
})

test('r1: .yaml compose variants are discovered', () => {
  for (const p of ['docker-compose.extra.yaml', 'compose.yaml', 'compose/extra/x.yaml', 'infra/host/extra/docker-compose.yaml']) {
    assert.deepEqual(codes(checkTree(tree({ [p]: plain('nginx:1.29') }))), ['unpinned'], p)
  }
})

test('r1: YAML environment keys MINIO_*/ *_S3_* (list or map form) are object-storage keys', () => {
  for (const env of ['      - MINIO_ROOT_USER=x\n', '      MINIO_ROOT_USER: x\n', '      AWS_S3_BUCKET: y\n']) {
    const res = checkTree(tree({ 'docker-compose.yml': compose(`  x:\n    image: redis@sha256:${D('a')}\n    environment:\n${env}`) }))
    assert.deepEqual(codes(res), ['object-storage-key'], env)
  }
})

test('r1: every latest default fails (any variable, nested, := form, inline comment)', () => {
  const bin = (l) => ({ 'infra/host/bin/gremion-helper': `#!/usr/bin/env bash\n${l}\n` })
  for (const l of ['IMG="${HELPER_IMG:-redis:latest}"', 'TAG=${T:-${U:-latest}}', ': "${X_IMAGE:=redis:latest}"']) {
    assert.ok(codes(checkTree(tree(bin(l)))).includes('latest'), l)
  }
  assert.deepEqual(codes(checkTree(tree({ '.env.example': 'IMAGE_TAG=latest  # default\n' }))), ['latest'])
  assert.deepEqual(codes(checkTree(tree({ '.env.example': 'IMAGE_TAG="latest" # x\n' }))), ['latest'])
})

test('r1: more *_IMAGE shapes are judged (:= default, IMAGE=, typeset, several per line, a compose environment item)', () => {
  const bin = (l) => ({ 'infra/host/bin/gremion-helper': `#!/usr/bin/env bash\n${l}\n` })
  for (const l of [': "${X_IMAGE:=alpine:3}"', 'IMAGE=alpine:3', 'X="${IMAGE:-busybox:1}"', 'typeset X_IMAGE=alpine:3', 'export A=1 X_IMAGE=alpine:3']) {
    assert.deepEqual(codes(checkTree(tree(bin(l)))), ['unpinned'], l)
  }
  const envItem = compose(`  x:\n    image: redis@sha256:${D('a')}\n    environment:\n      - MC_IMAGE=foo:1\n`)
  assert.deepEqual(codes(checkTree(tree({ 'docker-compose.yml': envItem }))), ['unpinned'])
})

test('r1: build: !reset null, null, ~ or empty is not a build (first-party tag ref fails)', () => {
  for (const b of ['!reset null', 'null', '~', '""']) {
    const res = checkTree(tree({ 'docker-compose.yml': compose(`  x:\n    build: ${b}\n    image: ghcr.io/hello-n00del/x:\${IMAGE_TAG:-dev}\n`) }))
    assert.deepEqual(codes(res), ['first-party-no-build'], b)
  }
})

test('r1: an exclusion glob may name one file only; a list-item image: is not canonical', () => {
  const ex = { 'scripts/release/image-scan-exclusions.json': JSON.stringify({ exclusions: [{ glob: '**', reason: 'x' }] }) }
  assert.ok(codes(checkTree(tree(ex))).includes('exclusion-broad'))
  assert.ok(codes(checkTree(tree({ 'docker-compose.yml': compose(`  x:\n    - image: redis@sha256:${D('a')}\n`) }))).includes('non-canonical'))
})

test('r1: the decoys really are tracked in the scratch repo (the anchoring test is not vacuous)', () => {
  const r = tree()
  const tracked = git(r, 'ls-files').split('\n')
  for (const p of ['packages/module-catalogue/test/fixtures/compose/base.yml', 'scripts/verify/census/__fixtures__/state/state.env.tmpl',
    'test/host/fixtures/x/docker-compose.yml', 'scripts/release/fixtures/y/docker-compose.yml', 'k8s/base/x/docker-compose.yml',
    '.github/workflows/docker-compose.yml']) assert.ok(tracked.includes(p), p)
})

// ── pin-images.sh (G2): the resolver that turns a tag into tag@digest ──────

test('pin-images.sh pins third-party tags, leaves first-party ${IMAGE_TAG} refs and ${...} alone, still pins a lookalike', () => {
  const dir = join(SCRATCH, `pin-${++n}`)
  mkdirSync(join(dir, 'bin'), { recursive: true })
  const log = join(dir, 'docker.log')
  writeFileSync(join(dir, 'bin/docker'), `#!/usr/bin/env bash\nprintf '%s\\n' "\${@: -1}" >> '${log}'\necho sha256:${D('9')}\n`, { mode: 0o755 })
  const file = join(dir, 'docker-compose.yml')
  writeFileSync(file, [
    'services:',
    '  a:',
    '    image: traefik:v3.7.1',
    '  b:',
    '    build: ./b',
    '    image: ghcr.io/hello-n00del/gremion-b:${IMAGE_TAG:-dev}',
    '  c:',
    '    image: ${STALWART_IMAGE:?x}',
    '  d:',
    '    image: ghcr.io.evil/hello-n00del/x:1',
    '  e:',
    `    image: redis:7-alpine@sha256:${D('a')}`,
    '  f:',
    '    image: ghcr.io/hello-n00del/gremion-f:1.0',
    '',
  ].join('\n'))
  const r = spawnSync('bash', [join(REPO_ROOT, 'infra/host/ops/pin-images.sh'), file], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}` },
  })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  const out = readFileSync(file, 'utf8')
  assert.match(out, new RegExp(`image: traefik:v3\\.7\\.1@sha256:${D('9')}$`, 'm'))
  assert.match(out, /image: ghcr\.io\/hello-n00del\/gremion-b:\$\{IMAGE_TAG:-dev\}$/m)
  assert.match(out, /image: \$\{STALWART_IMAGE:\?x\}$/m)
  assert.match(out, new RegExp(`image: ghcr\\.io\\.evil/hello-n00del/x:1@sha256:${D('9')}$`, 'm'))
  assert.match(out, new RegExp(`image: ghcr\\.io/hello-n00del/gremion-f:1\\.0@sha256:${D('9')}$`, 'm'))
  assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n').sort(), ['ghcr.io.evil/hello-n00del/x:1', 'ghcr.io/hello-n00del/gremion-f:1.0', 'traefik:v3.7.1'])
})

// ── CLI ──────────────────────────────────────────────────────────────────

test('cli: exit 1 with the finding on a RED tree, exit 0 with a count on a GREEN one', () => {
  const cli = join(HERE, 'check-image-digests.mjs')
  const red = spawnSync(process.execPath, [cli, '--root', tree({ 'docker-compose.yml': plain('nginx:1.29') })], { encoding: 'utf8' })
  assert.equal(red.status, 1, red.stdout + red.stderr)
  assert.match(red.stderr, /FAIL unpinned: docker-compose\.yml:3/)
  const green = spawnSync(process.execPath, [cli, '--root', tree()], { encoding: 'utf8' })
  assert.equal(green.status, 0, green.stdout + green.stderr)
  assert.match(green.stdout, /check-image-digests: \d+ file\(s\), \d+ image reference\(s\), 0 problem\(s\)/)
  const list = spawnSync(process.execPath, [cli, '--root', tree(), '--third-party-list'], { encoding: 'utf8' })
  assert.equal(list.status, 0, list.stderr)
  assert.equal(list.stdout, 'docker.io/library/alpine\ndocker.io/library/redis\ndocker.io/stalwartlabs/stalwart\n')
})

// ── 3. the real tree ─────────────────────────────────────────────────────

test('real tree: every deployed image reference is digest-pinned and no object storage remains', () => {
  const res = checkTree(REPO_ROOT)
  assert.deepEqual(res.problems.map((p) => `${p.code} ${p.where} ${p.message}`), [])
  assert.ok(res.files.includes('docker-compose.yml') && res.files.includes('infra/host/templates/env/mail.env.tmpl'))
  assert.ok(res.refs >= 15, `expected the real tree's refs to be read, got ${res.refs}`)
})
