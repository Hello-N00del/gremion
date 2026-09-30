#!/usr/bin/env node
// node --test suite: the Release-1 B35 checks TASK-046 adapts (brief §4, §6
// item 7). Each is exercised against the COMMITTED tree and against a RED
// fixture that must fail.
//
//   check-dependabot-dockerfiles  every tracked Dockerfile's directory is in a
//                                 dependabot `docker` ecosystem entry
//   check-lockfile-committed      the root pnpm-lock.yaml is the one lockfile
//                                 (fixtures aside); every Dockerfile that
//                                 installs with pnpm uses --frozen-lockfile
//   check-pins                    every pins `image:` is @sha256:<64 hex>, the
//                                 set is complete, and the assertions are the
//                                 ones gremion-deploy itself makes (its own
//                                 regexes, re-read from its source)

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'

import { Harness, REPO_ROOT, sh } from './lib/harness.mjs'
import { checkDependabotDockerfiles, dockerDirectories } from './check-dependabot-dockerfiles.mjs'
import { checkLockfileCommitted } from './check-lockfile-committed.mjs'
import { deployPinRegexes, checkPins, buildServicesOf, derivedServices, PROJECT_TEMPLATES } from './check-pins.mjs'

const h = new Harness('b35')
after(() => h.teardown())
const codes = (ps) => ps.map((p) => p.code).sort()

let n = 0
function repo(files) {
  n += 1
  const r = join(h.tmp, `repo-${n}`)
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(r, p)), { recursive: true })
    writeFileSync(join(r, p), c)
  }
  sh('git', ['-C', r, 'init', '-q'])
  sh('git', ['-C', r, 'add', '-A'])
  return r
}

// ── check-dependabot-dockerfiles ───────────────────────────────────────────

const DEPENDABOT = (dirs) =>
  `version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n  - package-ecosystem: docker\n    directories:\n${dirs
    .map((d) => `      - ${d}\n`)
    .join('')}  - package-ecosystem: docker\n    directory: /solo\n`

test('dependabot: the committed tree covers every tracked Dockerfile directory', () => {
  assert.deepEqual(checkDependabotDockerfiles(REPO_ROOT), [])
  const dirs = dockerDirectories(readFileSync(join(REPO_ROOT, '.github/dependabot.yml'), 'utf8'))
  for (const d of ['/docker/fallback', '/test/host/runner', '/docker/legal', '/gremion-public']) assert.ok(dirs.has(d), d)
})

test('dependabot: an uncovered Dockerfile directory fails, npm entries do not count', () => {
  const r = repo({
    '.github/dependabot.yml': DEPENDABOT(['/a']),
    'a/Dockerfile': 'FROM scratch\n',
    'solo/Dockerfile': 'FROM scratch\n',
    'b/Dockerfile': 'FROM scratch\n',
    'Dockerfile': 'FROM scratch\n',
  })
  const ps = checkDependabotDockerfiles(r)
  assert.deepEqual(codes(ps), ['uncovered-dockerfile', 'uncovered-dockerfile'])
  assert.deepEqual(ps.map((p) => p.path).sort(), ['Dockerfile', 'b/Dockerfile'])
})

test('dependabot: zero Dockerfiles or zero docker entries fails (no vacuous pass)', () => {
  assert.deepEqual(codes(checkDependabotDockerfiles(repo({ '.github/dependabot.yml': DEPENDABOT(['/a']) }))), ['no-dockerfiles'])
  const r = repo({ '.github/dependabot.yml': 'version: 2\nupdates: []\n', 'a/Dockerfile': 'FROM scratch\n' })
  assert.deepEqual(codes(checkDependabotDockerfiles(r)), ['no-docker-ecosystem', 'uncovered-dockerfile'])
})

// ── check-lockfile-committed ───────────────────────────────────────────────

test('lockfile: the committed tree passes', () => {
  assert.deepEqual(checkLockfileCommitted(REPO_ROOT), [])
})

test('lockfile: a missing root lockfile, a second lockfile, or an unfrozen pnpm install fails', () => {
  const base = { 'package.json': '{}\n', 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n" }
  assert.deepEqual(codes(checkLockfileCommitted(repo({ 'package.json': '{}\n' }))), ['no-root-lockfile'])
  assert.deepEqual(codes(checkLockfileCommitted(repo({ ...base, 'app/package-lock.json': '{}\n' }))), ['extra-lockfile'])
  assert.deepEqual(codes(checkLockfileCommitted(repo({ ...base, 'app/pnpm-lock.yaml': '{}\n' }))), ['extra-lockfile'])
  assert.deepEqual(checkLockfileCommitted(repo({ ...base, 'scripts/fixtures/x/pnpm-lock.yaml': '{}\n' })), [])
  const unfrozen = repo({ ...base, 'app/Dockerfile': 'FROM node\nCOPY pnpm-lock.yaml ./\nRUN pnpm install\n' })
  assert.deepEqual(codes(checkLockfileCommitted(unfrozen)), ['unfrozen-install'])
  const cont = repo({ ...base, 'app/Dockerfile': 'FROM node\nRUN corepack enable \\\n && pnpm install \\\n    --prod\n' })
  assert.deepEqual(codes(checkLockfileCommitted(cont)), ['unfrozen-install'])
  const npmi = repo({ ...base, 'app/Dockerfile': 'FROM node\nRUN npm install\n' })
  assert.deepEqual(codes(checkLockfileCommitted(npmi)), ['unfrozen-install'])
  const ok = repo({ ...base, 'app/Dockerfile': 'FROM node\nRUN pnpm install \\\n  --frozen-lockfile\nRUN npm ci\nRUN npm install -g bats@1.13.0\n' })
  assert.deepEqual(checkLockfileCommitted(ok), [])
})

// ── check-pins ─────────────────────────────────────────────────────────────

const D = (c) => c.repeat(64)
const PINS = (lines) => `services:\n${lines.join('')}`
const svc = (name, image) => `  ${name}:\n    build: !reset null\n    image: ${image}\n`

test("pins: the regexes are read out of gremion-deploy's own source", () => {
  const re = deployPinRegexes(join(REPO_ROOT, 'infra/host/bin/gremion-deploy'))
  assert.ok(re.imageLine.test('    image: ghcr.io/x@sha256:' + D('a')))
  assert.ok(re.digest.test('image: x@sha256:' + D('a')))
  assert.ok(re.thirdPartyNamespace.test('  image: "gremion/ui:1"'))
  assert.ok(re.buildLine.test('    build: ./x'))
  assert.ok(re.buildReset.test('    build: !reset null'))
})

test('pins: a missing regex in gremion-deploy fails loudly (no silent fallback)', () => {
  const src = readFileSync(join(REPO_ROOT, 'infra/host/bin/gremion-deploy'), 'utf8').replace(/grep -v '@sha256:'/g, "grep -v '@XXX'")
  const f = join(h.tmp, 'deploy-mutilated')
  writeFileSync(f, src)
  assert.throws(() => deployPinRegexes(f), /digest/)
})

test('pins: the release fixture passes by the DERIVED app set; the unpinned fixture fails and names the image', () => {
  const services = derivedServices('app')
  const valid = readFileSync(join(REPO_ROOT, 'test/host/fixtures/release/valid/docker-compose.pins.yml'), 'utf8')
  assert.deepEqual(checkPins(valid, { services }), [])
  const unpinned = readFileSync(join(REPO_ROOT, 'test/host/fixtures/release/unpinned/docker-compose.pins.yml'), 'utf8')
  const ps = checkPins(unpinned, { services })
  assert.ok(ps.some((p) => p.code === 'unpinned' && /gremion-ui:dist-v1\.2\.3/.test(p.message)), JSON.stringify(ps))
})

test('pins: the app layer in the state slot is unexpected AND incomplete; tenant-create absent is incomplete', () => {
  const app = readFileSync(join(REPO_ROOT, 'test/host/fixtures/release/valid/docker-compose.pins.yml'), 'utf8')
  const ps = checkPins(app, { services: derivedServices('state') })
  assert.deepEqual([...new Set(codes(ps))], ['incomplete', 'unexpected-service'])
  for (const s of ['legal', 'vector', 'fallback']) assert.ok(ps.some((p) => p.code === 'incomplete' && p.message.includes(`service ${s} `)), s)
  const noTenant = app.replace(/ {2}tenant-create:\n(?: {4}.*\n)+/, '')
  assert.notEqual(noTenant, app)
  assert.deepEqual(codes(checkPins(noTenant, { services: derivedServices('app') })), ['incomplete'])
})

test('pins: cli --project derives the set; --project with an unknown name fails', () => {
  const cli = join(REPO_ROOT, 'scripts/release/check-pins.mjs')
  const valid = join(REPO_ROOT, 'test/host/fixtures/release/valid/docker-compose.pins.yml')
  const ok = sh(process.execPath, [cli, valid, '--project', 'app'])
  assert.equal(ok.status, 0, ok.stdout + ok.stderr)
  const wrong = sh(process.execPath, [cli, valid, '--project', 'state'])
  assert.equal(wrong.status, 1, wrong.stdout + wrong.stderr)
  assert.match(wrong.stderr, /unexpected-service: service gremion-ui/)
  const bad = sh(process.execPath, [cli, valid, '--project', 'ops'])
  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /unknown project ops/)
})

test('pins: short digest, missing service, extra service, real build, gremion/ namespace, zero images -> FAIL', () => {
  const services = ['gremion-ui', 'migrate']
  const good = [svc('gremion-ui', `ghcr.io/hello-n00del/gremion-ui@sha256:${D('1')}`), svc('migrate', `ghcr.io/hello-n00del/gremion-migrate@sha256:${D('3')}`)]
  assert.deepEqual(checkPins(PINS(good), { services }), [])
  assert.deepEqual(codes(checkPins(PINS([svc('gremion-ui', 'ghcr.io/x@sha256:abc'), good[1]]), { services })), ['unpinned'])
  assert.deepEqual(codes(checkPins(PINS([good[0]]), { services })), ['incomplete'])
  assert.deepEqual(codes(checkPins(PINS([...good, svc('extra', `ghcr.io/x@sha256:${D('4')}`)]), { services })), ['unexpected-service'])
  const built = PINS([good[0], `  migrate:\n    build: ./m\n    image: ghcr.io/hello-n00del/gremion-migrate@sha256:${D('3')}\n`])
  assert.deepEqual(codes(checkPins(built, { services })), ['real-build'])
  assert.deepEqual(codes(checkPins(PINS([good[0], svc('migrate', `gremion/migrate@sha256:${D('3')}`)]), { services })), ['third-party-namespace'])
  assert.deepEqual(codes(checkPins('services: {}\n', { services })), ['incomplete', 'incomplete', 'no-images'])
})

// ── derivation (TASK-048b, Q1): the expected set comes from `build:` ─────────

const STATE_TMPL = (files) => `# fixture\nCOMPOSE_PROJECT_NAME=x-state\nCOMPOSE_FILE=${files}\nCOMPOSE_PROFILES=production\n`
function tree(files) {
  n += 1
  const r = join(h.tmp, `derive-${n}`)
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(r, p)), { recursive: true })
    writeFileSync(join(r, p), c)
  }
  return r
}

test('derive: the state set is the union of build: services over the template files, pins slot excluded', () => {
  const r = tree({
    [PROJECT_TEMPLATES.state]: STATE_TMPL('a.yml:b.yml:docker-compose.state-pins.yml'),
    'a.yml': 'x-y: &y\n  image: z\nservices:\n  legal:\n    build:\n      context: ./legal\n    image: i\n  db:\n    image: postgres\n  mod:\n    profiles: [module]\n    build: ./m\nvolumes:\n  legal:\n',
    'b.yml': 'services:\n  fallback:\n    build: ./fb\n  db:\n    restart: always\n',
    // the pins slot is never read: a build: here would be a pins error, not a derived service
    'docker-compose.state-pins.yml': 'services:\n  phantom:\n    build: ./p\n',
  })
  assert.deepEqual(derivedServices('state', { root: r }), ['legal', 'mod', 'fallback'])
})

test('derive: a later file that resets build: (!reset null) removes the service', () => {
  const r = tree({
    [PROJECT_TEMPLATES.state]: STATE_TMPL('a.yml:b.yml'),
    'a.yml': 'services:\n  legal:\n    build: ./l\n  vector:\n    build: ./v\n',
    'b.yml': 'services:\n  vector:\n    build: !reset null\n    image: timberio/vector\n',
  })
  assert.deepEqual(derivedServices('state', { root: r }), ['legal'])
})

test('derive: an anchored, quoted or flow service line, or a quoted build key, is refused', () => {
  for (const c of [
    'services:\n  a: &a\n    build: ./a\n',
    'services:\n  "a":\n    build: ./a\n',
    'services:\n  a: {build: ./a}\n',
    'services:\n  a:\n    "build": ./a\n',
  ]) {
    assert.throws(() => buildServicesOf(c, 'f.yml'), /not a plain|quoted/, c)
  }
})

test('derive: a merge key pulls build: from its anchor; an unknown anchor is refused', () => {
  const withBuild = 'x-b: &b\n  build: ./b\nservices:\n  a:\n    <<: *b\n  c:\n    image: y\n'
  assert.deepEqual([...buildServicesOf(withBuild, 'f.yml')].filter(([, v]) => v).map(([k]) => k), ['a'])
  assert.throws(() => buildServicesOf('services:\n  a:\n    <<: *nope\n', 'f.yml'), /unknown anchor/)
})

test('derive: zero derived services, a missing file or a template without COMPOSE_FILE fails', () => {
  const none = tree({ [PROJECT_TEMPLATES.state]: STATE_TMPL('a.yml'), 'a.yml': 'services:\n  db:\n    image: postgres\n' })
  assert.throws(() => derivedServices('state', { root: none }), /derives no build: service/)
  const missing = tree({ [PROJECT_TEMPLATES.state]: STATE_TMPL('a.yml:gone.yml'), 'a.yml': 'services:\n  l:\n    build: .\n' })
  assert.throws(() => derivedServices('state', { root: missing }), /gone\.yml/)
  const nokey = tree({ [PROJECT_TEMPLATES.state]: 'X=1\n' })
  assert.throws(() => derivedServices('state', { root: nokey }), /no COMPOSE_FILE/)
  assert.throws(() => derivedServices('ops', { root: nokey }), /unknown project/)
})

test('derive: the committed tree gives state {legal, vector, fallback} and app {gremion-ui, gremion-public, migrate, tenant-create}', () => {
  assert.deepEqual(derivedServices('state'), ['legal', 'vector', 'fallback'])
  assert.deepEqual(derivedServices('app'), ['gremion-ui', 'gremion-public', 'migrate', 'tenant-create'])
})

// ── one grep set for both layers (TASK-048b TDD 4) ─────────────────────────

test('pins: each pin assertion occurs exactly once in validate_release_tree; a duplicated grep fails loudly', () => {
  const deploy = join(REPO_ROOT, 'infra/host/bin/gremion-deploy')
  const re = deployPinRegexes(deploy)
  assert.equal(Object.keys(re).length, 5)
  // Unrolling the loop (the state layer judged by its own copy of a grep)
  // is exactly how the two files drift apart: refused.
  const src = readFileSync(deploy, 'utf8')
  const grep = "grep -E '^[[:space:]]*build:' \"$pins\""
  assert.ok(src.includes(grep), 'the build-line grep moved; update this test')
  const f = join(h.tmp, 'deploy-duplicated')
  writeFileSync(f, src.replace(grep, `${grep} | cat; ${grep}`))
  assert.throws(() => deployPinRegexes(f), /build-line pattern occurs 2 times/)
})

test('derive r1: compose shapes the line parser cannot read are refused, never read as zero services', () => {
  for (const c of [
    'services:\n    legal:\n        build: .\n', // 4-space service indent
    'services:\n   legal:\n     build: .\n', // 3-space
    'services:\n\tlegal:\n\t\tbuild: .\n', // tab
    'services:\n  legal:\n    extends: {file: b.yml, service: legal}\n', // extends
    'services: {legal: {build: .}}\n', // flow services
    '"services":\n  legal:\n    build: .\n', // quoted key
    'services:\n  a:\n    image: x\n---\nservices:\n  legal:\n    build: .\n', // second document
    'x-a: &a\n  build: .\nx-b: &b\n  <<: *a\nservices:\n  legal:\n    <<: *b\n', // chained merge in an anchor
  ]) {
    assert.throws(() => buildServicesOf(c, 'f.yml'), /f\.yml/, JSON.stringify(c))
  }
})

test('derive r1: a COMPOSE_FILE entry shaped like a pins slot but not one of the two layers is refused', () => {
  const r = tree({ [PROJECT_TEMPLATES.state]: STATE_TMPL('a.yml:docker-compose.extra-pins.yml'), 'a.yml': 'services:\n  legal:\n    build: .\n' })
  assert.throws(() => derivedServices('state', { root: r }), /docker-compose\.extra-pins\.yml is not a release pins layer/)
})

// ── R28 review LOWs (fix round 2) ─────────────────────────────────────────

test('r2: a project name that is an Object.prototype key is an unknown project, not a TypeError', () => {
  for (const p of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    assert.throws(() => derivedServices(p), /unknown project/, p)
  }
})

test('r2: check-pins CLI refuses --project together with --services (usage, exit 2), as emit-pins refuses its mix', () => {
  const cli = join(REPO_ROOT, 'scripts/release/check-pins.mjs')
  const layer = join(REPO_ROOT, 'test/host/fixtures/release/valid/docker-compose.state-pins.yml')
  const both = sh(process.execPath, [cli, layer, '--project', 'state', '--services', 'legal'])
  assert.equal(both.status, 2, both.stdout + both.stderr)
  assert.match(both.stderr, /usage/)
  const ok = sh(process.execPath, [cli, layer, '--project', 'state'])
  assert.equal(ok.status, 0, ok.stdout + ok.stderr)
  const unknown = sh(process.execPath, [cli, layer, '--project', 'constructor'])
  assert.equal(unknown.status, 1, unknown.stdout + unknown.stderr)
  assert.match(unknown.stderr, /unknown project constructor/)
})
