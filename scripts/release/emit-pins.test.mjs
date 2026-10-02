#!/usr/bin/env node
// node --test suite: scripts/release/emit-pins.mjs (TASK-048, Q3: the app
// layer of docker-compose.pins.yml; TASK-048b adds the state layer).
//
// What emit-pins writes is judged by the UNCHANGED check-pins.mjs, whose
// regexes are read out of gremion-deploy: a mutation of the emitted file
// (missing service, extra service, tag ref, build: without !reset) must be RED
// there, and the emitted file itself GREEN.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { appServices, parsePinLines, emitPins, selectProject } from './emit-pins.mjs'
import { checkPins, deployPinRegexes, derivedServices } from './check-pins.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..')
const APP_COMPOSE = join(REPO_ROOT, 'docker-compose.app.yml')
const TMP = mkdtempSync(join(tmpdir(), 't048-pins-'))
after(() => rmSync(TMP, { recursive: true, force: true }))

const D = (c) => c.repeat(64)
const FP = 'ghcr.io/hello-n00del'
// The app project's service set, EXACTLY: this list also guards against an
// unplanned app service. control-panel is the planned one (TASK-043 Q12, the
// ops shell per colour; its image is gremion-control-panel).
const SERVICES = ['gremion-ui', 'gremion-public', 'control-panel', 'migrate', 'tenant-create']
const LINES = [
  `gremion-ui=${FP}/gremion-ui@sha256:${D('1')}`,
  `gremion-public=${FP}/gremion-public@sha256:${D('2')}`,
  `control-panel=${FP}/gremion-control-panel@sha256:${D('6')}`,
  `migrate=${FP}/gremion-migrate@sha256:${D('3')}`,
  `tenant-create=${FP}/gremion-migrate@sha256:${D('3')}`,
]
const codes = (ps) => ps.map((p) => p.code).sort()

test('the expected set is the services: block of docker-compose.app.yml, nothing else', () => {
  assert.deepEqual(appServices(readFileSync(APP_COMPOSE, 'utf8')), SERVICES)
})

test('emitted from svc=repo@sha256 lines: the unchanged check-pins accepts it, and deployPinRegexes still extracts', () => {
  const re = deployPinRegexes(join(REPO_ROOT, 'infra/host/bin/gremion-deploy'))
  const out = emitPins(parsePinLines(LINES.join('\n')), SERVICES)
  assert.deepEqual(checkPins(out, { services: SERVICES }), [])
  const images = out.split('\n').filter((l) => re.imageLine.test(l))
  assert.equal(images.length, SERVICES.length)
  for (const l of images) assert.ok(re.digest.test(l))
  for (const l of out.split('\n').filter((x) => re.buildLine.test(x))) assert.ok(re.buildReset.test(l), l)
})

test('a missing, an extra, a duplicate or a malformed service line is refused', () => {
  assert.throws(() => emitPins(parsePinLines(LINES.slice(1).join('\n')), SERVICES), /incomplete: service gremion-ui/)
  assert.throws(
    () => emitPins(parsePinLines([...LINES, `extra=${FP}/x@sha256:${D('4')}`].join('\n')), SERVICES),
    /unexpected-service: service extra/,
  )
  assert.throws(() => parsePinLines([...LINES, LINES[0]].join('\n')), /duplicate service gremion-ui/)
  assert.throws(() => parsePinLines('gremion-ui ghcr.io/x@sha256:' + D('1')), /not svc=<repo>@sha256/)
  assert.throws(() => parsePinLines(''), /no pin lines/)
})

test('a tag ref is refused by the emitter; the same ref hand-written into the layer is RED in check-pins', () => {
  assert.throws(() => parsePinLines(`gremion-ui=${FP}/gremion-ui:v1.2.3`), /not svc=<repo>@sha256/)
  assert.throws(() => parsePinLines(`gremion-ui=${FP}/gremion-ui@sha256:${'1'.repeat(63)}`), /not svc=<repo>@sha256/)
  const good = emitPins(parsePinLines(LINES.join('\n')), SERVICES)
  const tagged = good.replace(`${FP}/gremion-ui@sha256:${D('1')}`, `${FP}/gremion-ui:v1.2.3`)
  assert.deepEqual(codes(checkPins(tagged, { services: SERVICES })), ['unpinned'])
})

test('mutations of the emitted layer are RED in check-pins: missing, extra, build: without !reset', () => {
  const good = emitPins(parsePinLines(LINES.join('\n')), SERVICES)
  const missing = good.replace(/ {2}tenant-create:\n(?: {4}.*\n)+/, '')
  assert.deepEqual(codes(checkPins(missing, { services: SERVICES })), ['incomplete'])
  const extra = `${good}  extra:\n    build: !reset null\n    image: ${FP}/x@sha256:${D('5')}\n`
  assert.deepEqual(codes(checkPins(extra, { services: SERVICES })), ['unexpected-service'])
  const built = good.replace('build: !reset null', 'build: ./gremion-ui')
  assert.deepEqual(codes(checkPins(built, { services: SERVICES })), ['real-build'])
})

test('cli: writes the layer only when check-pins passes; the file passes check-pins.mjs --services', () => {
  const cli = join(HERE, 'emit-pins.mjs')
  const input = join(TMP, 'pins.txt')
  const out = join(TMP, 'docker-compose.pins.yml')
  writeFileSync(input, `# pushed digests\n${LINES.join('\n')}\n`)
  const ok = spawnSync(process.execPath, [cli, '--app-compose', APP_COMPOSE, '--in', input, '--out', out], { encoding: 'utf8' })
  assert.equal(ok.status, 0, ok.stderr)
  const check = spawnSync(process.execPath, [join(HERE, 'check-pins.mjs'), out, '--services', SERVICES.join(',')], { encoding: 'utf8' })
  assert.equal(check.status, 0, check.stdout + check.stderr)
  assert.match(check.stdout, /check-pins: 0 problem\(s\)/)

  const bad = join(TMP, 'bad.txt')
  const out2 = join(TMP, 'refused.pins.yml')
  writeFileSync(bad, LINES.slice(0, 2).join('\n'))
  const refused = spawnSync(process.execPath, [cli, '--app-compose', APP_COMPOSE, '--in', bad, '--out', out2], { encoding: 'utf8' })
  assert.equal(refused.status, 1, refused.stdout + refused.stderr)
  assert.match(refused.stderr, /incomplete: service migrate/)
  assert.ok(!existsSync(out2), 'a refused layer was written')

  const stdin = spawnSync(process.execPath, [cli, '--app-compose', APP_COMPOSE], { encoding: 'utf8', input: LINES.join('\n') })
  assert.equal(stdin.status, 0, stdin.stderr)
  assert.deepEqual(checkPins(stdin.stdout, { services: SERVICES }), [])
  const usage = spawnSync(process.execPath, [cli], { encoding: 'utf8', input: '' })
  assert.equal(usage.status, 2)
})

// review round 1: a service line in any other spelling must not shrink the
// expected set; the app layer names first-party images only.
test('r1: an anchored, quoted or flow service line under services: is refused, not skipped', () => {
  for (const c of ['services:\n  a: &a\n    image: x\n  b:\n    image: y\n', 'services:\n  "a":\n    image: x\n  b:\n    image: y\n', 'services:\n  a: {image: x}\n  b:\n    image: y\n']) {
    assert.throws(() => appServices(c), /not a plain service line/, c)
  }
})

test('r1: a pin outside the first-party prefix is refused (the host would treat it as third-party)', () => {
  assert.throws(() => emitPins(parsePinLines(`gremion-ui=docker.io/library/nginx@sha256:${D('1')}`), ['gremion-ui']), /not first-party/)
  assert.throws(() => emitPins(parsePinLines(`gremion-ui=ghcr.io.evil/hello-n00del/gremion-ui@sha256:${D('1')}`), ['gremion-ui']), /not first-party/)
  // an explicit prefix (the rehearsal's local registry) is honoured
  const out = emitPins(parsePinLines(`gremion-ui=127.0.0.1:5000/hello-n00del/gremion-ui@sha256:${D('1')}`), ['gremion-ui'], { firstPartyPrefix: '127.0.0.1:5000/hello-n00del/' })
  assert.deepEqual(checkPins(out, { services: ['gremion-ui'] }), [])
})

// ── TASK-048b: the state layer, --project, and the release fixtures ───────

const STATE_LINES = [
  `legal=${FP}/gremion-legal@sha256:${D('7')}`,
  `vector=${FP}/gremion-vector@sha256:${D('8')}`,
  // TASK-198: matrix (Synapse) is a state build: service (brief Q1).
  `matrix=${FP}/gremion-synapse@sha256:${D('d')}`,
  `fallback=${FP}/gremion-fallback@sha256:${D('9')}`,
]
const RELEASE_VALID = join(REPO_ROOT, 'test/host/fixtures/release/valid')

test('048b: the state layer emitted from state lines passes check-pins by the derived state set and names its file', () => {
  const services = derivedServices('state')
  const out = emitPins(parsePinLines(STATE_LINES.join('\n')), services, { project: 'state' })
  assert.deepEqual(checkPins(out, { services }), [])
  assert.match(out.split('\n')[0], /^# docker-compose\.state-pins\.yml: the release pins layer \(state services\)/)
})

test('048b: an app service in the state layer is refused, and a state service in the app layer', () => {
  assert.throws(
    () => emitPins(parsePinLines([...STATE_LINES, LINES[0]].join('\n')), derivedServices('state'), { project: 'state' }),
    /unexpected-service: service gremion-ui/,
  )
  assert.throws(
    () => emitPins(parsePinLines([...LINES, STATE_LINES[0]].join('\n')), derivedServices('app'), { project: 'app' }),
    /unexpected-service: service legal/,
  )
})

test('048b: selectProject partitions one record by the derived sets; a service in neither project is refused', () => {
  const all = parsePinLines([...LINES, ...STATE_LINES].join('\n'))
  assert.deepEqual([...selectProject(all, 'state').keys()], ['legal', 'vector', 'matrix', 'fallback'])
  assert.deepEqual([...selectProject(all, 'app').keys()], SERVICES)
  const stray = parsePinLines([...LINES, ...STATE_LINES, `postgres=${FP}/postgres@sha256:${D('a')}`].join('\n'))
  assert.throws(() => selectProject(stray, 'state'), /postgres is in no release project/)
})

test('048b: valid/pins.txt reproduces both committed layers byte-equal (cli --project); missing-overlap carries the same state layer', () => {
  const cli = join(HERE, 'emit-pins.mjs')
  for (const [project, file] of [['state', 'docker-compose.state-pins.yml'], ['app', 'docker-compose.pins.yml']]) {
    const res = spawnSync(process.execPath, [cli, '--project', project, '--in', join(RELEASE_VALID, 'pins.txt')], { encoding: 'utf8' })
    assert.equal(res.status, 0, res.stderr)
    assert.equal(res.stdout, readFileSync(join(RELEASE_VALID, file), 'utf8'), `${file} is not the emitter's output`)
  }
  const missingOverlap = join(REPO_ROOT, 'test/host/fixtures/release/missing-overlap/docker-compose.state-pins.yml')
  assert.equal(readFileSync(missingOverlap, 'utf8'), readFileSync(join(RELEASE_VALID, 'docker-compose.state-pins.yml'), 'utf8'))
  const bad = spawnSync(process.execPath, [cli, '--project', 'ops', '--in', join(RELEASE_VALID, 'pins.txt')], { encoding: 'utf8' })
  assert.equal(bad.status, 1, bad.stdout + bad.stderr)
  assert.match(bad.stderr, /unknown project ops/)
  const both = spawnSync(process.execPath, [cli, '--project', 'app', '--app-compose', APP_COMPOSE], { encoding: 'utf8', input: '' })
  assert.equal(both.status, 2, 'mixing --project and --app-compose is a usage error')
})

test('048b: the unpinned fixture state layer carries a tag-only state image that check-pins refuses', () => {
  const text = readFileSync(join(REPO_ROOT, 'test/host/fixtures/release/unpinned/docker-compose.state-pins.yml'), 'utf8')
  const ps = checkPins(text, { services: derivedServices('state') })
  assert.ok(ps.some((p) => p.code === 'unpinned' && /gremion-legal:dist-v1\.2\.3/.test(p.message)), JSON.stringify(ps))
})

// ── R28 review LOWs (fix round 2) ─────────────────────────────────────────

test('r2: a prototype-key project is an unknown project in selectProject and emitPins, not a TypeError', () => {
  const all = parsePinLines([...LINES, ...STATE_LINES].join('\n'))
  for (const p of ['constructor', 'toString', '__proto__']) {
    assert.throws(() => selectProject(all, p), /unknown project/, p)
    assert.throws(() => emitPins(parsePinLines(STATE_LINES.join('\n')), derivedServices('state'), { project: p }), /unknown project/, p)
  }
})

test('r2: the release-signing procedure emits, checks and sbom-checks BOTH layers by --project (R28 review MEDIUM)', () => {
  const doc = readFileSync(join(REPO_ROOT, 'docs/ops/release-signing.md'), 'utf8')
  const oneLine = doc.replace(/\\\r?\n\s*/g, '')
  for (const [project, file] of [['state', 'docker-compose.state-pins.yml'], ['app', 'docker-compose.pins.yml']]) {
    assert.match(oneLine, new RegExp(`emit-pins\\.mjs --project ${project} --in pins\\.txt --out ${file.replace(/\./g, '\\.')}`), `emit ${project}`)
    assert.match(oneLine, new RegExp(`check-pins\\.mjs ${file.replace(/\./g, '\\.')} --project ${project}`), `check ${project}`)
  }
  assert.match(oneLine, /check-sbom\.mjs --pins docker-compose\.state-pins\.yml --pins docker-compose\.pins\.yml/)
  // check-pins has no --app-compose; the hand list is gone from the procedure
  assert.doesNotMatch(doc, /check-pins\.mjs[^\n]*--app-compose|--services gremion-ui/)
})

test('r2: emitPins without a project never names the app layer in its header (no silent app default)', () => {
  const out = emitPins(parsePinLines(STATE_LINES.join('\n')), derivedServices('state'))
  assert.doesNotMatch(out.split('\n')[0], /docker-compose\.pins\.yml|app services/)
  assert.deepEqual(checkPins(out, { services: derivedServices('state') }), [])
  // with a project, the header names that project's file
  assert.match(emitPins(parsePinLines(LINES.join('\n')), SERVICES, { project: 'app' }).split('\n')[0], /^# docker-compose\.pins\.yml: .*\(app services\)/)
})
