#!/usr/bin/env node
// node --test suite for the Postgres-major pin guard (spec B §8, B37).
//
// Same idiom as scripts/check-cve-floors.test.mjs: assert POST-CONDITIONS on
// real file content, never an exit code, and exercise every helper against BOTH
// the committed repo (must be clean) and a synthetic broken state (must produce
// a problem). A guard that cannot be shown failing is not a guard.
//
// NOTE ON LITERALS: this file is itself a tracked text file that the real-repo
// scan below reads. A stale tag written out in full here would be a real finding
// for the guard, so every stale/floating tag in this suite is BUILT at runtime
// from POSTGRES_MAJOR instead of spelled out. That is not a dodge — it is what
// keeps the "the committed kernel tree carries the pinned tag everywhere" test
// honest about its own source file.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  POSTGRES_MAJOR,
  POSTGRES_IMAGE_TAG,
  S14_CONSUMERS,
  EVIDENCE_PATH,
  checkEvidence,
} from './check-postgres-major.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const EVIDENCE = readFileSync(join(ROOT, EVIDENCE_PATH), 'utf8')

test('the pin is an integer major and a concrete alpine tag', () => {
  assert.ok(Number.isInteger(POSTGRES_MAJOR), 'POSTGRES_MAJOR must be an integer')
  assert.ok(POSTGRES_MAJOR >= 16, 'the pin may never go below the major release 1 runs on today')
  assert.equal(POSTGRES_IMAGE_TAG, `postgres:${POSTGRES_MAJOR}-alpine`)
})

test('the evidence record is docs/ops/postgres-major.md', () => {
  assert.equal(EVIDENCE_PATH, 'docs/ops/postgres-major.md')
})

test('the record carries one S14 evidence row per consumer, each with a source URL', () => {
  assert.deepEqual(checkEvidence(EVIDENCE), [])
  assert.ok(S14_CONSUMERS.length >= 5, 'an empty consumer list would pass vacuously')
})

test('checkEvidence goes RED when a consumer has no evidence row', () => {
  const rows = EVIDENCE.split('\n').filter((l) => l.toLowerCase().includes('pgbouncer'))
  assert.ok(rows.length > 0, 'fixture precondition: the record mentions pgbouncer')
  const stripped = EVIDENCE.split('\n').filter((l) => !l.toLowerCase().includes('pgbouncer')).join('\n')
  const problems = checkEvidence(stripped)
  assert.ok(problems.length > 0)
  assert.match(problems.join('\n'), /no S14 evidence row for pgbouncer/)
})

test('checkEvidence goes RED when the record pins a different major from the code', () => {
  const drifted = EVIDENCE.replace(
    /^- \*\*Pinned major\*\*: \d+$/m,
    `- **Pinned major**: ${POSTGRES_MAJOR + 1}`,
  )
  assert.notEqual(drifted, EVIDENCE, 'fixture did not apply')
  assert.match(
    checkEvidence(drifted).join('\n'),
    /postgres-major\.md pins \d+, check-postgres-major\.mjs exports/,
  )
})

test('checkEvidence goes RED when the later-bump rule is missing', () => {
  const noRule = EVIDENCE.replace(/measured RTO/g, 'best effort')
  assert.notEqual(noRule, EVIDENCE, 'fixture did not apply')
  assert.match(checkEvidence(noRule).join('\n'), /no later-bump rule/)
})

import {
  scanText,
  classify,
  checkFiles,
  trackedTextFiles,
} from './check-postgres-major.mjs'

// Stale and floating tags are BUILT, never spelled out: this very file is one of
// the tracked files the real-repo test below scans, and a literal stale tag here
// would be an honest finding for the guard.
const STALE_MAJOR = POSTGRES_MAJOR - 1
const STALE_TAG = `postgres:${STALE_MAJOR}-alpine`
const FLOATING_TAG = 'postgres:' + 'alpine'

// ── the scanner ────────────────────────────────────────────────────────────

test('scanText finds an image tag and ignores a host:port in a connection URL', () => {
  const text = [
    '  postgres:',
    `    image: ${POSTGRES_IMAGE_TAG}`,
    'GREMION_PUBLIC_DB_URL=postgresql://reader:pw@postgres:5432/gremion',
  ].join('\n')
  const hits = scanText('f.yml', text)
  assert.equal(hits.length, 1, `expected exactly one hit, got ${JSON.stringify(hits)}`)
  assert.equal(hits[0].line, 2)
  assert.equal(hits[0].ref, POSTGRES_IMAGE_TAG)
})

test('scanText ignores a bare postgres:5432 host:port even with no user@ prefix', () => {
  // The kernel prose is full of `postgres:5432` written on its own (docs,
  // comments, k8s configmaps). A scanner that read those as image tags would
  // drown the guard in false findings, so this is a first-class case.
  const text = [
    '   postgres:5432   <-  keycloak, gremion-ui',
    'reached directly at `postgres:5432` and never through PgBouncer',
    'wget -qO- http://postgres:5432 2>&1 | head',
  ].join('\n')
  assert.deepEqual(scanText('docs/x.md', text), [])
})

test('classify names the three states', () => {
  assert.equal(classify({ tag: `${POSTGRES_MAJOR}-alpine` }), 'ok')
  assert.equal(classify({ tag: `${POSTGRES_MAJOR}` }), 'ok')
  assert.equal(classify({ tag: `${STALE_MAJOR}-alpine` }), 'mismatched')
  assert.equal(classify({ tag: 'latest' }), 'unpinned')
  assert.equal(classify({ tag: 'alpine' }), 'unpinned')
})

// ── the file-set check ─────────────────────────────────────────────────────

test('checkFiles refuses to pass on an empty match set', () => {
  const problems = checkFiles([{ path: 'a.yml', text: 'services:\n  web:\n    image: nginx:1.29\n' }])
  assert.match(problems.join('\n'), /zero postgres: image references/)
})

test('checkFiles goes RED on a stale major and on a floating tag', () => {
  const problems = checkFiles([
    { path: 'a.yml', text: `    image: ${POSTGRES_IMAGE_TAG}\n` },
    { path: 'b.yml', text: `    image: ${STALE_TAG}\n` },
    { path: 'c.yml', text: `    image: ${FLOATING_TAG}\n` },
  ])
  assert.equal(problems.length, 2, problems.join('\n'))
  assert.ok(problems.join('\n').includes(`mismatched: b.yml:1 ${STALE_TAG}`), problems.join('\n'))
  assert.ok(problems.join('\n').includes(`unpinned: c.yml:1 ${FLOATING_TAG}`), problems.join('\n'))
})

test('checkFiles excludes the frozen spec copies by rule, not by accident', () => {
  const problems = checkFiles([
    {
      // the name B0-spec-docs-and-waiver-ledger lands them under
      path: 'docs/superpowers/specs/spec-b-kernel-portback-relocatability-release-design.md',
      text: `\`${STALE_TAG}\` today\n`,
    },
    { path: 'docker-compose.yml', text: `    image: ${POSTGRES_IMAGE_TAG}\n` },
  ])
  assert.deepEqual(problems, [])
})

test('the exclusion list is narrow: a stale tag anywhere else is still a finding', () => {
  // Proves the rule above is an exclusion of two NAMED paths and not a hole a
  // stale tag can wander into.
  for (const path of ['docs/deployment.md', 'k8s/base/postgres/statefulset.yaml',
                      'test/host/fixtures/postgres-major/tree-clean/compose/calendar.yml']) {
    const problems = checkFiles([{ path, text: `    image: ${STALE_TAG}\n` }])
    assert.ok(problems.join('\n').includes(`mismatched: ${path}:1`), `${path} must not be excluded`)
  }
})

// ── the real repo ──────────────────────────────────────────────────────────

test('the committed kernel tree carries the pinned tag everywhere, in >= 8 places', () => {
  const files = trackedTextFiles(ROOT)
  const hits = files
    .filter((f) => !/^docs\/superpowers\/specs\//.test(f.path))
    .flatMap((f) => scanText(f.path, f.text))
  assert.ok(hits.length >= 8, `expected >= 8 postgres: references, found ${hits.length}`)
  assert.deepEqual(checkFiles(files), [])
})

import { fragmentFiles } from './check-postgres-major.mjs'

const FIX = join(ROOT, 'test/host/fixtures/postgres-major')

test('fragmentFiles finds a module repo compose fragment', () => {
  const files = fragmentFiles(join(FIX, 'tree-clean'))
  assert.equal(files.length, 1)
  assert.equal(files[0].path, 'compose/calendar.yml')
})

test('--tree passes on a fragment carrying the pinned tag', () => {
  assert.deepEqual(checkFiles(fragmentFiles(join(FIX, 'tree-clean'))), [])
})

test('--tree goes RED on a leaf Postgres left on the old major', () => {
  const files = fragmentFiles(join(FIX, 'tree-stale'))
  assert.equal(files.length, 1)
  // The stale tag and its line are READ OFF the fixture rather than restated
  // here, so a fixture that silently rotted to the pinned major fails the
  // precondition instead of quietly making this test meaningless.
  const stale = scanText(files[0].path, files[0].text)[0]
  assert.ok(stale, 'fixture precondition: tree-stale declares a postgres image')
  assert.equal(classify(stale), 'mismatched', 'fixture precondition: it must be stale')
  const problems = checkFiles(files)
  assert.ok(
    problems.join('\n').includes(`mismatched: compose/calendar.yml:${stale.line} ${stale.ref}`),
    problems.join('\n'),
  )
})

test('--tree FAILS LOUDLY on a tree with no fragments, instead of passing vacuously', () => {
  const files = fragmentFiles(join(FIX, 'tree-empty'))
  assert.equal(files.length, 0)
  assert.match(checkFiles(files).join('\n'), /zero postgres: image references/)
})

test('fragmentFiles throws on a directory that does not exist', () => {
  assert.throws(() => fragmentFiles(join(FIX, 'no-such-tree')), /no such tree/)
})

// ── the data-directory contract (docker-library/postgres PR 1259) ──────────
//
// The tag half above proves what is WRITTEN. This half proves the tag can
// actually run: at major 18 the official image moved PGDATA to
// /var/lib/postgresql/<major>/docker, moved its declared VOLUME to
// /var/lib/postgresql, and made its entrypoint refuse ANY mount at
// /var/lib/postgresql/data — an empty one included. A tree that bumps the tag
// and leaves the 16-era mount behind crash-loops with every tag guard green.

import {
  POSTGRES_DATA_MOUNT,
  scanDataMounts,
  checkDataMounts,
} from './check-postgres-major.mjs'

// The mount a pre-18 tree declares. Spelling it out here is deliberate and safe:
// checkDataMounts scans only .yml/.yaml/.sh/.bats/.tmpl and never a .mjs,
// because a mount declaration cannot live in one — and the real-repo test below
// scans the committed tree, this file included, which is what proves that claim
// rather than asserting it.
const LEGACY_MOUNT = '/var/lib/postgresql/data'

test('the expected data mount is derived from the pinned major, not hardcoded', () => {
  assert.equal(
    POSTGRES_DATA_MOUNT,
    POSTGRES_MAJOR >= 18 ? '/var/lib/postgresql' : LEGACY_MOUNT,
  )
})

test('scanDataMounts reads compose short syntax and k8s mountPath, and nothing else', () => {
  const text = [
    '    volumes:',
    `      - pg-data:${POSTGRES_DATA_MOUNT}`,
    // a bind of the init script is not a data mount and must not be read as one
    '      - ./docker/postgres/init-databases.sh:/docker-entrypoint-initdb.d/init-databases.sh:ro',
    '          volumeMounts:',
    '            - name: data',
    `              mountPath: ${POSTGRES_DATA_MOUNT}`,
    // prose that merely names the path is not a declaration
    `# the 18+ entrypoint refuses a mount at ${LEGACY_MOUNT}`,
  ].join('\n')
  const hits = scanDataMounts('f.yml', text)
  assert.equal(hits.length, 2, JSON.stringify(hits))
  assert.deepEqual(hits.map((h) => h.line), [2, 6])
  assert.deepEqual(hits.map((h) => h.mount), [POSTGRES_DATA_MOUNT, POSTGRES_DATA_MOUNT])
})

test('checkDataMounts goes RED on the pre-18 mount, naming the contract that forbids it', () => {
  const problems = checkDataMounts([
    { path: 'docker-compose.yml', text: `      - pg-data:${LEGACY_MOUNT}\n` },
  ])
  assert.equal(problems.length, 1, problems.join('\n'))
  assert.ok(problems[0].includes(`data mount: docker-compose.yml:1 mounts ${LEGACY_MOUNT}`), problems[0])
  assert.ok(problems[0].includes(`expected ${POSTGRES_DATA_MOUNT}`), problems[0])
  assert.ok(problems[0].includes('PR 1259'), problems[0])
})

test('checkDataMounts goes RED on a mount that hardcodes the current major', () => {
  // /var/lib/postgresql/18/docker is where PGDATA points today, so mounting it
  // WORKS — and silently stops working at the next bump. The expected mount is
  // the parent, which is why an "it runs, so it is fine" mount is still a
  // finding.
  const pinned = `/var/lib/postgresql/${POSTGRES_MAJOR}/docker`
  const problems = checkDataMounts([
    { path: 'k8s/base/postgres/statefulset.yaml', text: `              mountPath: ${pinned}\n` },
  ])
  assert.equal(problems.length, 1, problems.join('\n'))
  assert.ok(problems[0].includes(`mounts ${pinned}`), problems[0])
})

test('checkDataMounts refuses to pass on an empty match set', () => {
  const problems = checkDataMounts([
    { path: 'a.yml', text: 'services:\n  web:\n    image: nginx:1.29\n' },
  ])
  assert.match(problems.join('\n'), /zero Postgres data mounts/)
})

test('checkDataMounts leaves prose alone: the record must be free to name the old path', () => {
  // docs/ops/postgres-major.md has to spell out /var/lib/postgresql/data in
  // order to explain the boundary. A .md is not a place a mount is configured.
  const problems = checkDataMounts([
    { path: 'docs/ops/postgres-major.md', text: `a volume at \`${LEGACY_MOUNT}\` is refused\n` },
    { path: 'docker-compose.yml', text: `      - pg-data:${POSTGRES_DATA_MOUNT}\n` },
  ])
  assert.deepEqual(problems, [])
})

test('the committed kernel tree mounts Postgres data where the pinned major puts it', () => {
  const files = trackedTextFiles(ROOT)
  const hits = files.flatMap((f) => scanDataMounts(f.path, f.text))
  assert.ok(hits.length >= 5, `expected >= 5 Postgres data mounts, found ${hits.length}`)
  assert.deepEqual(checkDataMounts(files), [])
})

test('--tree checks the data mount of a leaf fragment too', () => {
  assert.deepEqual(checkDataMounts(fragmentFiles(join(FIX, 'tree-clean'))), [])

  const stale = fragmentFiles(join(FIX, 'tree-stale'))
  const mounts = scanDataMounts(stale[0].path, stale[0].text)
  assert.equal(mounts.length, 1, 'fixture precondition: tree-stale declares one data mount')
  assert.notEqual(mounts[0].mount, POSTGRES_DATA_MOUNT, 'fixture precondition: it must be the old mount')
  const problems = checkDataMounts(stale)
  assert.ok(
    problems.join('\n').includes(`data mount: compose/calendar.yml:${mounts[0].line}`),
    problems.join('\n'),
  )
})
