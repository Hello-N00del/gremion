#!/usr/bin/env node
// node --test suite: scripts/verify/sbom/check-sbom.mjs — every image carries a
// CycloneDX 1.6 SBOM as a cosign attestation that verifies with the pinned
// key, and `verify` fails on a component below a check-cve-floors floor or an
// unaccepted CRITICAL (TASK-046, TRD-443, brief §1 bullet 6, Q3, Q4, §6 item 5).
//
// Live parts: a digest-pinned registry, the pinned cosign, the pinned syft and
// grype containers, ephemeral keys. The grype VERDICT is also exercised on a
// hand-built grype-shaped fixture (fixtures/grype-minimist-1.2.5.json, see its
// $comment), because the grype DB host is unreachable in the build sandbox —
// the missing-DB path itself is exercised live and must FAIL.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Harness, REPO_ROOT } from '../../release/lib/harness.mjs'
import { assertCosign } from '../../release/lib/tools.mjs'
import {
  validateSbom,
  floorProblems,
  criticalProblems,
  loadAccepted,
  sbomOfImage,
  sourceSbom,
  verifyAttestation,
  runGrype,
  checkSbomDoc,
  firstPartyDigests,
  pinsArgs,
  pinsRefs,
} from './check-sbom.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const GRYPE_FIXTURE = JSON.parse(readFileSync(join(HERE, 'fixtures/grype-minimist-1.2.5.json'), 'utf8'))
const codes = (ps) => ps.map((p) => p.code).sort()

const bom = (components, specVersion = '1.6') => ({ bomFormat: 'CycloneDX', specVersion, components })
const npm = (name, version) => ({
  type: 'library',
  name,
  version,
  purl: `pkg:npm/${name.replace('@', '%40')}@${version}`,
})

let h, key, stranger
const refs = {}
before(async () => {
  assertCosign()
  h = new Harness('sbom')
  await h.startRegistry()
  key = h.keyPair('release')
  stranger = h.keyPair('stranger')
  refs.minimist = h.pushImage('gremion-ui', 'sbom', {
    'app/node_modules/minimist/package.json': '{"name":"minimist","version":"1.2.5"}\n',
  })
  const sbom = sbomOfImage(refs.minimist, { name: h.name('syft') })
  const p = join(h.tmp, 'sbom.cdx.json')
  writeFileSync(p, JSON.stringify(sbom))
  h.attest(refs.minimist, key.key, p)
  refs.strangerAttested = h.pushImage('gremion-public', 'sbom', {
    'app/node_modules/left-pad/package.json': '{"name":"left-pad","version":"1.3.0"}\n',
  })
  h.attest(refs.strangerAttested, stranger.key, p)
  // A component IN the floor table, below its floor, attested with the right
  // key: the floor verdict needs no vulnerability DB, so it runs live here.
  refs.undici = h.pushImage('gremion-migrate', 'sbom-undici', {
    'app/node_modules/undici/package.json': '{"name":"undici","version":"7.0.0"}\n',
  })
  const u = join(h.tmp, 'sbom-undici.cdx.json')
  writeFileSync(u, JSON.stringify(sbomOfImage(refs.undici, { name: h.name('syft-u') })))
  h.attest(refs.undici, key.key, u)
})
after(() => h?.teardown())

// ── document checks ─────────────────────────────────────────────────────────

test('an SBOM whose specVersion is not 1.6 fails', () => {
  assert.deepEqual(codes(validateSbom(bom([npm('a', '1.0.0')], '1.5'))), ['spec-version'])
  assert.deepEqual(codes(validateSbom({ ...bom([npm('a', '1.0.0')]), bomFormat: 'SPDX' })), ['bom-format'])
  assert.deepEqual(validateSbom(bom([npm('a', '1.0.0')])), [])
})

test('an SBOM with no components fails', () => {
  assert.deepEqual(codes(validateSbom(bom([]))), ['no-components'])
  assert.deepEqual(codes(validateSbom({ bomFormat: 'CycloneDX', specVersion: '1.6' })), ['no-components'])
})

test('a component below a check-cve-floors floor fails (the table is imported, not copied)', () => {
  assert.deepEqual(codes(floorProblems(bom([npm('undici', '7.0.0')]))), ['below-floor'])
  assert.deepEqual(codes(floorProblems(bom([npm('@sveltejs/kit', '2.70.1')]))), ['below-floor'])
  assert.deepEqual(floorProblems(bom([npm('undici', '7.29.0'), npm('@sveltejs/kit', '2.70.2')])), [])
  assert.deepEqual(floorProblems(bom([npm('left-pad', '0.0.1')])), [])
})

test('minimist@1.2.5 (GHSA-xvch-5gv4-984h / CVE-2021-44906, CRITICAL) fails; a HIGH alone does not', () => {
  const ps = criticalProblems(GRYPE_FIXTURE, [])
  assert.deepEqual(codes(ps), ['critical'])
  assert.match(ps[0].message, /minimist@1\.2\.5.*GHSA-xvch-5gv4-984h/)
})

test('an accepted CRITICAL passes only with id, reason and date', () => {
  const ok = [{ id: 'CVE-2021-44906', reason: 'test-only fixture', date: '2026-09-25' }]
  assert.deepEqual(criticalProblems(GRYPE_FIXTURE, loadAccepted({ accepted: ok }).entries), [])
  for (const bad of [
    { id: 'CVE-2021-44906', date: '2026-09-25' },
    { id: 'CVE-2021-44906', reason: 'x' },
    { id: 'CVE-2021-44906', reason: 'x', date: '25.09.2026' },
    { reason: 'x', date: '2026-09-25' },
  ]) {
    const acc = loadAccepted({ accepted: [bad] })
    assert.deepEqual(codes(acc.problems), ['accepted-incomplete'], JSON.stringify(bad))
    assert.deepEqual(codes(criticalProblems(GRYPE_FIXTURE, acc.entries)), ['critical'])
  }
})

test('the committed accepted.json is complete and empty', () => {
  const acc = loadAccepted(JSON.parse(readFileSync(join(HERE, 'accepted.json'), 'utf8')))
  assert.deepEqual(acc.problems, [])
  assert.deepEqual(acc.entries, [])
})

// ── live: syft, cosign, grype ──────────────────────────────────────────────

test('syft (pinned) produces a CycloneDX 1.6 SBOM listing the image component', () => {
  const s = sbomOfImage(refs.minimist, { name: h.name('syft') })
  assert.deepEqual(validateSbom(s), [])
  assert.ok(s.components.some((c) => c.name === 'minimist' && c.version === '1.2.5'))
})

test('the attestation verifies with the pinned key and yields the SBOM predicate', () => {
  const r = verifyAttestation(refs.minimist, key.pub)
  assert.deepEqual(r.problems, [])
  assert.equal(r.predicate.specVersion, '1.6')
  assert.ok(r.predicate.components.some((c) => c.name === 'minimist'))
})

test('an attestation made with another key fails against the pinned key', () => {
  const r = verifyAttestation(refs.strangerAttested, key.pub)
  assert.deepEqual(codes(r.problems), ['attestation'])
  assert.equal(r.predicate, null)
  // …and an image with no attestation at all fails the same way.
  const bare = h.pushImage('gremion-migrate', 'bare', { 'a.txt': 'no sbom\n' })
  assert.deepEqual(codes(verifyAttestation(bare, key.pub).problems), ['attestation'])
})

test('a missing grype vulnerability DB is a FAIL, never a pass', () => {
  const vol = h.name('grypedb')
  h.volumes.push(vol)
  const r = runGrype(bom([npm('minimist', '1.2.5')]), { name: h.name('grype'), volume: vol, update: false })
  assert.deepEqual(codes(r.problems), ['grype-db'])
  assert.equal(r.report, null)
})

test('checkSbomDoc never passes the attested minimist predicate: with no DB it fails on grype-db (the CRITICAL verdict itself is the fixture test above)', () => {
  const vol = h.name('grypedb2')
  h.volumes.push(vol)
  const { predicate } = verifyAttestation(refs.minimist, key.pub)
  const ps = checkSbomDoc(predicate, { grype: { name: h.name('grype2'), volume: vol, update: false }, accepted: [] })
  assert.ok(ps.length >= 1)
  assert.ok(ps.every((p) => ['critical', 'grype-db'].includes(p.code)), JSON.stringify(ps))
})

test('the source SBOM of the committed lockfile is CycloneDX 1.6 and meets every cve floor', () => {
  const s = sourceSbom(REPO_ROOT, { name: h.name('syft-src') })
  assert.deepEqual(validateSbom(s), [])
  assert.ok(s.components.length > 100, `only ${s.components.length} components`)
  assert.ok(s.components.some((c) => c.name === 'undici'), 'undici is absent from the lockfile SBOM')
  assert.deepEqual(floorProblems(s), [])
})

test('live: an attested image with undici@7.0.0 fails on the cve floor, independent of the grype DB', () => {
  const vol = h.name('grypedb3')
  h.volumes.push(vol)
  const { problems, predicate } = verifyAttestation(refs.undici, key.pub)
  assert.deepEqual(problems, [])
  const ps = checkSbomDoc(predicate, { grype: { name: h.name('grype3'), volume: vol, update: false }, accepted: [] })
  assert.ok(ps.some((p) => p.code === 'below-floor' && /undici@7\.0\.0/.test(p.message)), JSON.stringify(ps))
})

test('a pins image line that cannot be parsed is a problem, not a skip', () => {
  const D = 'a'.repeat(64)
  const pins = `services:\n  a:\n    image: ghcr.io/hello-n00del/a@sha256:${D}\n  b:\n    image: ghcr.io/hello-n00del/b@sha256:${D}  # prod\n  c: {image: ghcr.io/hello-n00del/c@sha256:${D}}\n`
  const r = firstPartyDigests(pins, 'ghcr.io/hello-n00del/')
  assert.deepEqual(r.refs, [`ghcr.io/hello-n00del/a@sha256:${D}`])
  assert.equal(r.unparsed.length, 2)
})

test('round 2: YAML features that hide an image from a line reader are problems (alias, merge, escape, extra document, extends)', () => {
  const D = 'a'.repeat(64)
  const ok = `services:\n  a:\n    image: ghcr.io/hello-n00del/a@sha256:${D}\n`
  for (const extra of [
    '  b:\n    image: *img\n',
    '  x: &svc {"image": docker.io/evil/y:latest}\n  b:\n    <<: *svc\n',
    '  b:\n    "\\x69mage": docker.io/evil/x@sha256:' + D + '\n',
    '---\nservices:\n  a:\n    "\\x69mage": docker.io/evil/x\n',
    '  b:\n    extends: {file: other.yml, service: m}\n',
  ]) {
    const r = firstPartyDigests(ok + extra, 'ghcr.io/hello-n00del/')
    assert.ok(r.unparsed.length >= 1, `not flagged: ${JSON.stringify(extra)}`)
  }
  assert.deepEqual(firstPartyDigests(ok, 'ghcr.io/hello-n00del/').unparsed, [])
})

// ── TASK-048b: --pins is repeatable (Q6) ───────────────────────────────────

test('048b: --pins is repeatable; refs are the union of every layer, unparsed-pin and no-first-party judged per file', () => {
  assert.deepEqual(pinsArgs(['--pins', 'a.yml', '--key', 'k.pub', '--pins', 'b.yml']), ['a.yml', 'b.yml'])
  assert.deepEqual(pinsArgs(['--key', 'k.pub']), [])
  assert.throws(() => pinsArgs(['--pins']), /--pins needs a file/)
  const release = join(REPO_ROOT, 'test/host/fixtures/release/valid')
  const files = [join(release, 'docker-compose.pins.yml'), join(release, 'docker-compose.state-pins.yml')]
  const { refs: got, problems } = pinsRefs(files, 'ghcr.io/hello-n00del/')
  assert.deepEqual(problems, [])
  for (const r of ['gremion-ui@sha256:1', 'gremion-legal@sha256:7', 'gremion-fallback@sha256:9']) assert.ok(got.some((x) => x.includes(r)), r)
  assert.equal(new Set(got).size, got.length, 'the union holds each ref once (migrate and tenant-create share one)')
  // a state layer with no first-party ref is named, even though the app layer has some
  const texts = { 'app.yml': readFileSync(files[0], 'utf8'), 'state.yml': 'services: {}\n' }
  const r2 = pinsRefs(['app.yml', 'state.yml'], 'ghcr.io/hello-n00del/', { readText: (f) => texts[f] })
  assert.deepEqual(r2.problems.map((p) => `${p.code} ${p.where}`), ['no-first-party state.yml'])
  // an unreadable layer is a problem, never an empty file
  const r3 = pinsRefs(['app.yml', 'gone.yml'], 'ghcr.io/hello-n00del/', { readText: (f) => { if (!texts[f]) throw new Error('ENOENT'); return texts[f] } })
  assert.deepEqual(r3.problems.map((p) => `${p.code} ${p.where}`), ['unreadable-pins gone.yml'])
})
