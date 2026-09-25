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
  POSTGRES_IMAGE_REF,
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

test('scanText reads a shell parameter-expansion default — the tag that actually runs', () => {
  // The blind spot that shipped a stale proof image: `${VAR:-postgres:<major>-alpine}`.
  // TAG_RE cannot see it (its lookbehind drops the `-` of `:-`), so the default
  // — which IS the image whenever the variable is unset, i.e. in CI — went
  // unscanned. Every substituting form is exercised, and the tags are BUILT from
  // POSTGRES_MAJOR so this file cannot itself become a finding.
  for (const expansion of [':-', '-', ':=', '=']) {
    const line = `IMAGE="\${SOME_IMAGE${expansion}${STALE_TAG}}"`
    const hits = scanText('x.sh', line)
    assert.equal(hits.length, 1, `${expansion}: expected one hit, got ${JSON.stringify(hits)}`)
    assert.equal(hits[0].ref, STALE_TAG)
    assert.equal(classify(hits[0]), 'mismatched', `${expansion}: a stale default must be mismatched`)
  }
})

test('a shell default on the pinned tag passes, and is counted exactly once', () => {
  const hits = scanText('x.sh', `IMAGE="\${SOME_IMAGE:-${POSTGRES_IMAGE_REF}}"`)
  assert.equal(hits.length, 1, `expected exactly one hit, got ${JSON.stringify(hits)}`)
  assert.deepEqual(checkFiles([{ path: 'x.sh', text: `IMAGE="\${SOME_IMAGE:-${POSTGRES_IMAGE_REF}}"` }]), [])
})

test('a shell default naming the bare port is still not an image reference', () => {
  assert.deepEqual(scanText('x.sh', 'PORT="\${PGHOST:-postgres:5432}"'), [])
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
    { path: 'a.yml', text: `    image: ${POSTGRES_IMAGE_REF}\n` },
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
    { path: 'docker-compose.yml', text: `    image: ${POSTGRES_IMAGE_REF}\n` },
  ])
  assert.deepEqual(problems, [])
})

test('the exclusion list is narrow: a stale tag anywhere else is still a finding', () => {
  // Proves the rule above is an exclusion of two NAMED paths and not a hole a
  // stale tag can wander into.
  for (const path of ['docs/deployment.md', 'docs/k8s/postgres.yaml', 'infra/k8s/x.yaml',
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
    { path: 'compose/calendar.yml', text: `              target: ${pinned}\n` },
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

// ── round-2 review: the three blind spots that made the guard pass silently ──
//
// Each of these is a case the guard was written to catch and did not. They are
// written as tests FIRST, watched RED, and only then closed in the scanner.

// The untagged reference is built the same defensive way the stale tags above
// are: it is spelled as a value, never as a line this file's own scan could
// read as a declaration.
const UNTAGGED = '    image: postgres'

test('scanText finds an UNTAGGED postgres image — `:latest` at pull time', () => {
  // An untagged reference resolves to the `latest` tag when Docker pulls it,
  // which is
  // the single most dangerous floating reference there is. It has no tag for a
  // `postgres:<tag>` scanner to match, so it needs its own net.
  const hits = scanText('docker-compose.yml', UNTAGGED)
  assert.equal(hits.length, 1, `expected one hit, got ${JSON.stringify(hits)}`)
  assert.equal(hits[0].line, 1)
  assert.equal(classify(hits[0]), 'unpinned')
})

test('scanText reads every untagged spelling, and never the same line twice', () => {
  const cases = [
    UNTAGGED,
    '    image: "postgres"',
    "    image: 'postgres'",
    '    image: postgres:',
    '    image: docker.io/library/postgres',
    '  - image: postgres',
  ]
  for (const line of cases) {
    const hits = scanText('a.yml', line)
    assert.equal(hits.length, 1, `${line} -> ${JSON.stringify(hits)}`)
    assert.equal(classify(hits[0]), 'unpinned', `${line} must classify as unpinned`)
  }
  // a TAGGED line is matched once, by the tag scanner, not twice
  const tagged = scanText('a.yml', `    image: ${POSTGRES_IMAGE_REF}`)
  assert.equal(tagged.length, 1, JSON.stringify(tagged))
  assert.equal(classify(tagged[0]), 'ok')
})

test('the untagged net does not fire on an image that merely ends in postgres', () => {
  const notPostgres = [
    '    image: mypostgres',
    '    image: ghcr.io/hello-n00del/gremion-calendar@sha256:4444444444444444444444444444444444444444444444444444444444444444',
    '    image: timescale/timescaledb-postgis',
    '# image: postgres is what a fragment must never say',
    '    POSTGRES_DB: postgres',
  ]
  for (const line of notPostgres) {
    assert.deepEqual(scanText('a.yml', line), [], `${line} must not be read as an untagged postgres image`)
  }
})

test('checkFiles goes RED when one fragment of a good set is untagged', () => {
  // The reviewer's exact scenario: a kernel tree full of correctly pinned
  // references plus ONE leaf fragment written `image: postgres`. The vacuity
  // guard cannot see this — the set is far from empty — so without its own net
  // the whole run stays green.
  const problems = checkFiles([
    { path: 'docker-compose.yml', text: `    image: ${POSTGRES_IMAGE_REF}\n` },
    { path: 'compose/calendar.yml', text: `${UNTAGGED}\n` },
  ])
  assert.equal(problems.length, 1, problems.join('\n'))
  assert.ok(problems[0].includes('unpinned: compose/calendar.yml:1 postgres'), problems[0])
  assert.ok(problems[0].includes(`expected ${POSTGRES_IMAGE_TAG}`), problems[0])
})

test('classify calls a missing tag unpinned, never a major-0 mismatch', () => {
  assert.equal(classify({ tag: null }), 'unpinned')
  assert.equal(classify({ tag: '' }), 'unpinned')
})

test('scanDataMounts sees a BIND-mounted data directory, not only a named volume', () => {
  // An operator overlay or a hand-written leaf fragment is as likely to bind a
  // host path as to name a volume, and a bind at the pre-18 path crash-loops
  // exactly the same way.
  for (const src of ['./pgdata', '/srv/pg', '../state/pg', '${PG_DIR}/data', '~/pg']) {
    const line = `      - ${src}:${POSTGRES_DATA_MOUNT}`
    const hits = scanDataMounts('a.yml', line)
    assert.equal(hits.length, 1, `${line} -> ${JSON.stringify(hits)}`)
    assert.equal(hits[0].mount, POSTGRES_DATA_MOUNT)
  }
})

test('checkDataMounts goes RED on a bind mount left at the pre-18 path', () => {
  const problems = checkDataMounts([
    { path: 'compose/calendar.yml', text: `      - ./pgdata:${LEGACY_MOUNT}\n` },
  ])
  assert.equal(problems.length, 1, problems.join('\n'))
  assert.ok(problems[0].includes(`mounts ${LEGACY_MOUNT}`), problems[0])
})

test('trackedTextFiles reads the extensionless host scripts too', () => {
  // infra/host/bin/* carry no extension. A `postgres:<tag>` written into one of
  // them would be pinned by nobody if the file filter never opened it.
  const paths = trackedTextFiles(ROOT).map((f) => f.path)
  assert.ok(paths.includes('infra/host/bin/gremion-backup'),
    'infra/host/bin/gremion-backup must be scanned')
  assert.ok(paths.includes('infra/host/bin/gremion-restore-into'),
    'infra/host/bin/gremion-restore-into must be scanned')
  assert.ok(paths.includes('.env.example'), '.env.example must be scanned')
})

// ── TASK-019: the digest net (TRD-350) ─────────────────────────────────────
//
// A tag is a pointer the registry may move; a digest is the content. Every
// DECLARATION (compose/workflow `image:`, a shell assignment or default, a
// `docker run`, a Dockerfile FROM) must carry the ONE pinned index digest.
// Prose (.md) and comment lines stay major-only. Built at runtime like the
// stale tags above, so this file never spells a declaration of its own.

import {
  POSTGRES_IMAGE_DIGEST,
  checkDigests,
} from './check-postgres-major.mjs'

// A well-formed digest that is NOT the pin: the pin's own hex, rotated.
const OTHER_DIGEST = `sha256:${POSTGRES_IMAGE_DIGEST.slice(7).split('').reverse().join('')}`

test('the pinned reference is <tag>@<one sha256 index digest>', () => {
  assert.match(POSTGRES_IMAGE_DIGEST, /^sha256:[0-9a-f]{64}$/)
  assert.equal(POSTGRES_IMAGE_REF, `${POSTGRES_IMAGE_TAG}@${POSTGRES_IMAGE_DIGEST}`)
  assert.match(OTHER_DIGEST, /^sha256:[0-9a-f]{64}$/)
  assert.notEqual(OTHER_DIGEST, POSTGRES_IMAGE_DIGEST)
})

test('the record carries a "Pinned digest" line equal to the exported constant', () => {
  assert.ok(EVIDENCE.includes(`- **Pinned digest**: ${POSTGRES_IMAGE_DIGEST}\n`),
    'docs/ops/postgres-major.md must carry the pinned digest line')
  const drifted = EVIDENCE.replace(POSTGRES_IMAGE_DIGEST, OTHER_DIGEST)
  assert.notEqual(drifted, EVIDENCE, 'fixture did not apply')
  assert.match(checkEvidence(drifted).join('\n'), /postgres-major\.md pins digest sha256:[0-9a-f]{64}, check-postgres-major\.mjs exports/)
  const missing = EVIDENCE.split('\n').filter((l) => !l.startsWith('- **Pinned digest**')).join('\n')
  assert.match(checkEvidence(missing).join('\n'), /no "- \*\*Pinned digest\*\*: sha256:<64 hex>" line/)
})

test('scanText records the digest a reference carries', () => {
  const hits = scanText('docker-compose.yml', `    image: ${POSTGRES_IMAGE_REF}`)
  assert.equal(hits.length, 1, JSON.stringify(hits))
  assert.equal(hits[0].digest, POSTGRES_IMAGE_DIGEST)
  assert.equal(classify(hits[0]), 'ok')
  assert.equal(scanText('a.yml', `    image: ${POSTGRES_IMAGE_TAG}`)[0].digest, null)
})

test('TDD-1: an undigested declaration is reported (compose, workflow, shell, Dockerfile, docker run)', () => {
  for (const [path, line] of [
    ['docker-compose.yml', `    image: ${POSTGRES_IMAGE_TAG}`],
    ['.github/workflows/gremion-ui.yml', `        image: ${POSTGRES_IMAGE_TAG}`],
    ['gremion-ui/scripts/fresh-init-proof.sh', `DEFAULT_IMAGE="${POSTGRES_IMAGE_TAG}"`],
    ['x.sh', `IMAGE="\${SOME_IMAGE:-${POSTGRES_IMAGE_TAG}}"`],
    ['x.bats', `  run docker run --rm ${POSTGRES_IMAGE_TAG} postgres --version`],
    ['docker/pg/Dockerfile', `FROM ${POSTGRES_IMAGE_TAG}`],
    ['infra/host/bin/gremion-x', `docker run --rm ${POSTGRES_IMAGE_TAG} pg_dump --version`],
    ['compose/x.yaml.tmpl', `    image: ${POSTGRES_IMAGE_TAG}`],
  ]) {
    const problems = checkFiles([{ path, text: `${line}\n` }])
    assert.equal(problems.length, 1, `${path}: ${problems.join('\n')}`)
    assert.ok(problems[0].startsWith(`undigested: ${path}:1 ${POSTGRES_IMAGE_TAG}`), problems[0])
    assert.ok(problems[0].includes(`expected ${POSTGRES_IMAGE_REF}`), problems[0])
  }
})

test('prose and comment lines stay major-only: no digest demanded there', () => {
  const problems = checkFiles([
    { path: 'docs/ops/x.md', text: `runs \`${POSTGRES_IMAGE_TAG}\` today\n` },
    { path: 'docker-compose.prod.yml', text: `  # (${POSTGRES_IMAGE_TAG} also defaults to 100\n` },
    { path: 'x.sh', text: `# Re-measured on ${POSTGRES_IMAGE_TAG}\n` },
    { path: 'gremion-ui/src/lib/x.ts', text: ` * relying on ${POSTGRES_IMAGE_TAG}'s default\n` },
    { path: 'docker-compose.yml', text: `    image: ${POSTGRES_IMAGE_REF}\n` },
  ])
  assert.deepEqual(problems, [])
})

test('TDD-2: a digest that is not the pinned one is drift, in any file kind', () => {
  for (const path of ['docker-compose.yml', 'docs/ops/x.md', 'x.sh']) {
    const problems = checkFiles([{ path, text: `    image: ${POSTGRES_IMAGE_TAG}@${OTHER_DIGEST}\n` }])
    assert.equal(problems.length, 1, `${path}: ${problems.join('\n')}`)
    assert.ok(problems[0].startsWith(`digest-drift: ${path}:1`), problems[0])
  }
})

test('TDD-2: a truncated or malformed digest is drift, never a pass', () => {
  const short = POSTGRES_IMAGE_DIGEST.slice(0, 20)
  const problems = checkFiles([{ path: 'a.yml', text: `    image: ${POSTGRES_IMAGE_TAG}@${short}\n` }])
  assert.equal(problems.length, 1, problems.join('\n'))
  assert.match(problems[0], /^digest-drift: a\.yml:1/)
})

test('TDD-2: two different digests in one tree are reported as a split pin', () => {
  const hits = [
    ...scanText('a.yml', `    image: ${POSTGRES_IMAGE_REF}`),
    ...scanText('b.yml', `    image: ${POSTGRES_IMAGE_TAG}@${OTHER_DIGEST}`),
  ]
  const problems = checkDigests(hits)
  assert.equal(problems.length, 1, problems.join('\n'))
  assert.match(problems[0], /^split pin: 2 distinct postgres digests in one tree/)
  assert.deepEqual(checkDigests(hits.slice(0, 1)), [])
})

// ── TASK-019: k8s/** is frozen (D16) and leaves the scan set ───────────────

import { EXCLUDED } from './check-postgres-major.mjs'

test('TDD-6: EXCLUDED holds exactly three NAMED rules: specs, the stale fixtures, k8s', () => {
  assert.equal(EXCLUDED.length, 3, EXCLUDED.map(String).join(' '))
  const hit = (p) => EXCLUDED.filter((re) => re.test(p)).length
  assert.equal(hit('docs/superpowers/specs/spec-b-x.md'), 1)
  assert.equal(hit('test/host/fixtures/postgres-major/tree-stale/compose/calendar.yml'), 1)
  assert.equal(hit('k8s/base/postgres/statefulset.yaml'), 1)
  // the rule is anchored: a path that merely CONTAINS k8s is still scanned
  for (const p of ['docs/k8s.md', 'infra/k8s/x.yaml', 'k8sx/a.yaml', 'docker-compose.yml']) {
    assert.equal(hit(p), 0, `${p} must not be excluded`)
  }
})

test('TDD-6: a stale tag or an old data mount under k8s/ is not reported', () => {
  const k8s = { path: 'k8s/base/postgres/statefulset.yaml',
                text: `          image: ${STALE_TAG}\n              mountPath: ${LEGACY_MOUNT}\n` }
  const good = { path: 'docker-compose.yml',
                 text: `    image: ${POSTGRES_IMAGE_REF}\n      - pg-data:${POSTGRES_DATA_MOUNT}\n` }
  assert.deepEqual(checkFiles([k8s, good]), [])
  assert.deepEqual(checkDataMounts([k8s, good]), [])
  // ...and k8s alone is an EMPTY scan, which still fails loudly
  assert.match(checkFiles([k8s]).join('\n'), /zero postgres: image references/)
})

// ── TASK-019: the registry-prefix net ──────────────────────────────────────
//
// `image: docker.io/library/postgres:<stale>-alpine` was INVISIBLE: TAG_RE's
// lookbehind drops the `/` in front of `postgres`, and UNTAGGED_IMAGE_RE only
// reads a reference with no tag. Docker resolves that spelling to exactly the
// image the short form names, so it has to be held to exactly the same pin.

const PREFIXED_STALE = `docker.io/library/${STALE_TAG}`

test('TDD-3: a registry-prefixed stale tag is reported as mismatched', () => {
  for (const [path, line] of [
    ['docker-compose.yml', `    image: ${PREFIXED_STALE}`],
    ['compose/calendar.yml', `    image: "${PREFIXED_STALE}@${POSTGRES_IMAGE_DIGEST}"`],
    ['x.sh', `docker run --rm ${PREFIXED_STALE} psql --version`],
    ['x.sh', `IMAGE="\${PG_IMAGE:-${PREFIXED_STALE}}"`],
    ['a.yml', `    image: registry.example:5000/mirror/${STALE_TAG}`],
    ['docs/x.md', `we used to run \`${PREFIXED_STALE}\``],
  ]) {
    const hits = scanText(path, line)
    assert.equal(hits.length, 1, `${line} -> ${JSON.stringify(hits)}`)
    const problems = checkFiles([{ path, text: `${line}\n` }])
    assert.equal(problems.length, 1, `${line}: ${problems.join('\n')}`)
    assert.ok(problems[0].startsWith(`mismatched: ${path}:1`), problems[0])
    assert.ok(problems[0].includes(STALE_TAG), problems[0])
  }
})

test('a registry-prefixed reference is held to the digest pin like the short form', () => {
  const pinned = `    image: docker.io/library/${POSTGRES_IMAGE_REF}`
  assert.equal(scanText('a.yml', pinned).length, 1, 'counted exactly once')
  assert.deepEqual(checkFiles([{ path: 'a.yml', text: `${pinned}\n` }]), [])
  const bare = checkFiles([{ path: 'a.yml', text: `    image: docker.io/library/${POSTGRES_IMAGE_TAG}\n` }])
  assert.equal(bare.length, 1, bare.join('\n'))
  assert.match(bare[0], /^undigested: a\.yml:1/)
})

test('the registry-prefix net does not read URLs, paths or host:ports as images', () => {
  for (const line of [
    'https://hub.docker.com/_/postgres',
    'see https://github.com/docker-library/postgres/pull/1259',
    'wget -qO- http://postgres:5432',
    'DATABASE_URL=postgresql://u:pw@db.internal/postgres:5432',
    '      - ./docker/postgres/init-databases.sh:/docker-entrypoint-initdb.d/init.sh:ro',
    '    image: timescale/timescaledb-postgis:2.19.0-pg17',
  ]) {
    assert.deepEqual(scanText('a.yml', line), [], `${line} must not be read as a postgres image`)
  }
})

// ── TASK-019: the module service set (Q1, D14) ─────────────────────────────
//
// Per-module Postgres: `<id>-postgres` for the six extraction-source leaves,
// each profile-gated under its id and labelled org.gremion.postgres=module:<id>;
// the kernel server is labelled `kernel`. The label is what the RUNNING check
// finds containers by, so a service without it is a server nobody verifies.

import {
  MODULE_POSTGRES_IDS,
  composeServices,
  checkComposeServices,
  checkModuleSet,
} from './check-postgres-major.mjs'

const VAR_IMAGE = '    image: ${CALENDAR_PG_IMAGE}'

test('the module set is the six extraction-source leaves', () => {
  assert.deepEqual([...MODULE_POSTGRES_IDS].sort(),
    ['board', 'calendar', 'content', 'finance', 'newsletter', 'vault'])
})

test('composeServices reads name, image, label, profiles and merge key off a compose file', () => {
  const text = [
    'x-module-postgres: &module-postgres',
    `  image: ${POSTGRES_IMAGE_REF}`,
    'services:',
    '  postgres:',
    `    image: ${POSTGRES_IMAGE_REF}`,
    '    labels:',
    '      org.gremion.postgres: "kernel"',
    '  calendar-postgres:',
    '    <<: *module-postgres',
    '    profiles: [calendar]',
    '    labels:',
    '      - "org.gremion.postgres=module:calendar"',
    '    healthcheck:',
    '      test: ["CMD-SHELL", "pg_isready"]',
    '  web:',
    '    image: nginx:1.29',
    'volumes:',
    '  calendar-pg-data:',
    '    name: gremion_module_calendar_pg_data',
  ].join('\n')
  const s = composeServices(text)
  assert.deepEqual(s.map((x) => x.name), ['postgres', 'calendar-postgres', 'web'])
  assert.equal(s[0].image, POSTGRES_IMAGE_REF)
  assert.equal(s[0].label, 'kernel')
  assert.equal(s[1].image, null)
  assert.equal(s[1].merge, true)
  assert.equal(s[1].label, 'module:calendar')
  assert.deepEqual(s[1].profiles, ['calendar'])
  assert.equal(s[2].label, null)
})

test('TDD-4: a variable-only image on a *-postgres service is a problem', () => {
  const text = `services:\n  calendar-postgres:\n${VAR_IMAGE}\n`
  const problems = checkComposeServices([{ path: 'compose/calendar.yml', text }])
  assert.equal(problems.length, 1, problems.join('\n'))
  assert.match(problems[0], /^variable image: compose\/calendar\.yml:3 service calendar-postgres/)
})

test('TDD-4: a variable image with a pinned default is still a problem on a postgres service', () => {
  const text = `services:\n  calendar-postgres:\n    image: \${CALENDAR_PG_IMAGE:-${POSTGRES_IMAGE_REF}}\n`
  assert.match(checkComposeServices([{ path: 'a.yml', text }]).join('\n'), /^variable image: a\.yml:3/)
})

test('TDD-4: a variable-only image on a LABELLED service of any name is a problem', () => {
  const text = `services:\n  db:\n${VAR_IMAGE}\n    labels:\n      org.gremion.postgres: "module:calendar"\n`
  assert.match(checkComposeServices([{ path: 'a.yml', text }]).join('\n'), /^variable image: a\.yml:3 service db/)
})

test('TDD-4: a postgres service with no image and no merge key is a problem', () => {
  const text = 'services:\n  calendar-postgres:\n    build: ./pg\n'
  assert.match(checkComposeServices([{ path: 'compose/calendar.yml', text }]).join('\n'),
    /^no image: compose\/calendar\.yml:2 service calendar-postgres/)
  // an OVERRIDE file's postgres entry overlays the base and carries no image
  assert.deepEqual(checkComposeServices([{ path: 'docker-compose.override.yml', text }]), [])
})

test('a variable image on a service that is not Postgres is none of this guard\'s business', () => {
  const text = 'services:\n  web:\n    image: ${WEB_IMAGE}\n'
  assert.deepEqual(checkComposeServices([{ path: 'a.yml', text }]), [])
})

/** A docker-compose.yml body carrying the full, correct module set. */
function moduleCompose({ skip = null, override = {} } = {}) {
  const lines = [
    'x-module-postgres: &module-postgres',
    `  image: ${POSTGRES_IMAGE_REF}`,
    'services:',
    '  postgres:',
    `    image: ${POSTGRES_IMAGE_REF}`,
    '    labels:',
    '      org.gremion.postgres: "kernel"',
  ]
  const vols = ['volumes:', '  pg-data:', '    name: gremion_pg_data']
  for (const id of MODULE_POSTGRES_IDS) {
    if (id === skip) continue
    const o = override[id] ?? {}
    lines.push(`  ${o.name ?? `${id}-postgres`}:`, '    <<: *module-postgres',
      `    profiles: [${o.profile ?? id}]`, '    labels:',
      `      org.gremion.postgres: "${o.label ?? `module:${id}`}"`,
      '    volumes:', `      - ${id}-pg-data:${POSTGRES_DATA_MOUNT}`)
    vols.push(`  ${id}-pg-data:`, `    name: ${o.volume ?? `gremion_module_${id}_pg_data`}`)
  }
  return [...lines, ...vols].join('\n') + '\n'
}

test('checkModuleSet passes on the full set', () => {
  assert.deepEqual(checkModuleSet(moduleCompose()), [])
})

test('checkModuleSet goes RED on a missing module server', () => {
  assert.match(checkModuleSet(moduleCompose({ skip: 'vault' })).join('\n'), /no vault-postgres service/)
})

test('checkModuleSet goes RED on a wrong label, a wrong profile and an unlabelled kernel', () => {
  assert.match(checkModuleSet(moduleCompose({ override: { board: { label: 'module:vault' } } })).join('\n'),
    /board-postgres is labelled org\.gremion\.postgres=module:vault, expected module:board/)
  assert.match(checkModuleSet(moduleCompose({ override: { board: { profile: 'content' } } })).join('\n'),
    /board-postgres is not gated under profiles: \[board\]/)
  const noKernel = moduleCompose().replace('      org.gremion.postgres: "kernel"\n', '')
  assert.match(checkModuleSet(noKernel).join('\n'), /the kernel postgres service is not labelled org\.gremion\.postgres=kernel/)
})

test('checkModuleSet goes RED on a stray labelled or *-postgres service outside the set', () => {
  const stray = moduleCompose().replace('\nvolumes:\n', '\n  files-postgres:\n    <<: *module-postgres\nvolumes:\n')
  assert.match(checkModuleSet(stray).join('\n'), /files-postgres is a Postgres service outside the module set/)
})

test('checkModuleSet refuses a module volume that reuses a live extraction-source name', () => {
  // The extraction source's own stack names its PG16 leaf volumes
  // gremion_<id>_pg_data. A PG18 server mounted on one of those is mounted on
  // somebody's live data.
  const problems = checkModuleSet(moduleCompose({ override: { calendar: { volume: 'gremion_calendar_pg_data' } } }))
  assert.match(problems.join('\n'), /calendar-postgres mounts volume gremion_calendar_pg_data/)
  const shared = checkModuleSet(moduleCompose({ override: { calendar: { volume: 'gremion_pg_data' } } }))
  assert.match(shared.join('\n'), /calendar-postgres mounts volume gremion_pg_data/)
})

test('the committed docker-compose.yml carries the full, correct module set', () => {
  const text = readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8')
  assert.deepEqual(checkModuleSet(text), [])
  assert.deepEqual(checkComposeServices([{ path: 'docker-compose.yml', text }]), [])
  const labelled = composeServices(text).filter((s) => s.label)
  assert.equal(labelled.length, 1 + MODULE_POSTGRES_IDS.length)
})

// ── TASK-019: a per-module server left on an older major, digest and all ────

test('TDD-5: --tree goes RED on tree-stale-module, a digested leaf on an older major', () => {
  const files = fragmentFiles(join(FIX, 'tree-stale-module'))
  assert.equal(files.length, 1, 'fixture precondition: one fragment')
  const hits = scanText(files[0].path, files[0].text)
  assert.equal(hits.length, 1, JSON.stringify(hits))
  // read OFF the fixture, so a fixture that rotted to the pin fails here
  assert.match(hits[0].digest ?? '', /^sha256:[0-9a-f]{64}$/, 'fixture precondition: it carries a digest')
  assert.notEqual(hits[0].tag.split('-')[0], String(POSTGRES_MAJOR), 'fixture precondition: it is stale')
  const problems = checkFiles(files)
  assert.ok(problems.some((p) => p.startsWith(`mismatched: compose/calendar.yml:${hits[0].line} ${hits[0].ref}@`)),
    problems.join('\n'))
})

test('TDD-5: tree-clean carries the digest pin and passes every --tree check', () => {
  const files = fragmentFiles(join(FIX, 'tree-clean'))
  const hits = scanText(files[0].path, files[0].text)
  assert.equal(hits[0].digest, POSTGRES_IMAGE_DIGEST)
  assert.deepEqual([...checkFiles(files), ...checkDataMounts(files), ...checkComposeServices(files)], [])
})

test('the stale-fixture rule names exactly the two stale fixtures, not tree-clean', () => {
  const hit = (p) => EXCLUDED.filter((re) => re.test(p)).length
  assert.equal(hit('test/host/fixtures/postgres-major/tree-stale-module/compose/calendar.yml'), 1)
  assert.equal(hit('test/host/fixtures/postgres-major/tree-clean/compose/calendar.yml'), 0)
  assert.equal(hit('test/host/fixtures/postgres-major/tree-stale-other/compose/calendar.yml'), 0)
})

// ── TDD-9: the suites cannot shrink silently ───────────────────────────────
//
// B37 shipped 38 tests here; TASK-019 added 29 (this one included: 30) and a
// 15-test suite for the running check. A test deleted to get a red run green
// would otherwise leave every remaining test passing and nothing to notice.
const B37_TESTS = 38
const TASK019_TESTS = 30
const RUNNING_TESTS = 15

const countTests = (text) => (text.match(/^test\(/gm) ?? []).length

test('TDD-9: the suites hold at least 38 + the TASK-019 tests', () => {
  const own = countTests(readFileSync(fileURLToPath(import.meta.url), 'utf8'))
  assert.ok(own >= B37_TESTS + TASK019_TESTS,
    `check-postgres-major.test.mjs has ${own} tests, expected >= ${B37_TESTS} + ${TASK019_TESTS}`)
  const running = countTests(readFileSync(join(ROOT, 'scripts/check-postgres-major-running.test.mjs'), 'utf8'))
  assert.ok(running >= RUNNING_TESTS,
    `check-postgres-major-running.test.mjs has ${running} tests, expected >= ${RUNNING_TESTS}`)
})
