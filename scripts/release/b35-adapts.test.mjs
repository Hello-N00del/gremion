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
import { deployPinRegexes, checkPins } from './check-pins.mjs'

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

test('pins: the release fixture passes; the unpinned fixture fails and names the image', () => {
  const services = ['gremion-ui', 'gremion-public', 'migrate']
  const valid = readFileSync(join(REPO_ROOT, 'test/host/fixtures/release/valid/docker-compose.pins.yml'), 'utf8')
  assert.deepEqual(checkPins(valid, { services }), [])
  const unpinned = readFileSync(join(REPO_ROOT, 'test/host/fixtures/release/unpinned/docker-compose.pins.yml'), 'utf8')
  const ps = checkPins(unpinned, { services })
  assert.ok(ps.some((p) => p.code === 'unpinned' && /gremion-ui:dist-v1\.2\.3/.test(p.message)), JSON.stringify(ps))
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
