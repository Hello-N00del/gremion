#!/usr/bin/env node
// Postgres major pin guard — spec B §8, unit B37-postgres-major-pin.
//
// P3: the Postgres major is the newest EVERY consumer supports. Spike S14
// recorded the per-consumer evidence; docs/ops/postgres-major.md is its home and
// this file is the machine-readable half. Each asserts the other, so prose and
// code cannot drift apart.
//
// Run:  node scripts/check-postgres-major.mjs             (the kernel repo)
//       node scripts/check-postgres-major.mjs --tree DIR  (a module repo or an
//                                                          assembled release tree)
// Test: node --test scripts/check-postgres-major.test.mjs

import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The major S14 settled on. Change this ONLY together with the record. */
export const POSTGRES_MAJOR = 18
export const POSTGRES_IMAGE_TAG = `postgres:${POSTGRES_MAJOR}-alpine`
export const EVIDENCE_PATH = 'docs/ops/postgres-major.md'

// The consumers P3 names. A consumer with no evidence row is a consumer nobody
// checked, so a missing NAME fails — not merely a missing table.
export const S14_CONSUMERS = ['keycloak', 'nextcloud', 'synapse', 'pgbouncer', 'pg_dump']

export function checkEvidence(text) {
  const problems = []
  const m = text.match(/^- \*\*Pinned major\*\*: (\d{1,3})$/m)
  if (!m) return [`${EVIDENCE_PATH} carries no "- **Pinned major**: <n>" line`]
  if (Number(m[1]) !== POSTGRES_MAJOR) {
    problems.push(`${EVIDENCE_PATH} pins ${m[1]}, check-postgres-major.mjs exports ${POSTGRES_MAJOR}`)
  }
  const rows = text.split('\n').filter((l) => l.trim().startsWith('|'))
  for (const c of S14_CONSUMERS) {
    const row = rows.find((l) => l.toLowerCase().includes(c.toLowerCase()))
    if (!row) { problems.push(`the record has no S14 evidence row for ${c}`); continue }
    if (!/https?:\/\//.test(row)) problems.push(`S14 evidence row for ${c} cites no source URL`)
    // The major has to appear as a WHOLE numeric token: splitting on runs of
    // non-digits means "18" is found in `18.x` and in `PostgreSQL 18`, but a row
    // that only says `118` or `1.8` does not count as evidence for 18.
    if (!row.split(/[^0-9]+/).includes(String(POSTGRES_MAJOR))) {
      problems.push(`S14 evidence row for ${c} does not state support for major ${POSTGRES_MAJOR}`)
    }
  }
  if (!/dump\/restore/.test(text) || !/measured RTO/.test(text)) {
    problems.push('the record states no later-bump rule (dump/restore with a measured RTO)')
  }
  return problems
}

// ── the scanner ────────────────────────────────────────────────────────────

// Two NAMED exclusions, and only two. Anything not on this list is scanned.
//
//  1. Frozen copies of the APPROVED specs quote the pre-pin tag verbatim. They
//     are a record of what was decided, not a place a tag is configured;
//     rewriting them would falsify the record. It is also the only tracked path
//     under docs/superpowers — B0 un-ignores exactly
//     docs/superpowers/specs/spec-{b,d}-*.md and nothing else.
//  2. The `tree-stale` fixture EXISTS to carry a stale tag: it is what proves
//     `--tree` goes RED. Excluding the whole `postgres-major` fixture directory
//     would also excuse `tree-clean`, so the rule names `tree-stale` alone and
//     `tree-clean` stays scanned like any other file (and is pinned).
export const EXCLUDED = [
  /^docs\/superpowers\/specs\//,
  /^test\/host\/fixtures\/postgres-major\/tree-stale\//,
]

// Q6 (TASK-200): a named per-PATH exemption, scoped to one REF. These two
// in-tree finance tests are "set A" of the module source move — the files the
// extraction tag changed after the frozen source — and set A stays byte-equal
// to the tag at every commit (scripts/check-module-source-parity.mjs), so their
// pre-pin tag cannot be rewritten here. It sits only in the docker-run guidance
// string of each file's fail-closed test-DB guard; nothing is started from it.
// Pinned to PATH, LINE and REF: any other ref, a second occurrence on another
// line, and this ref anywhere else are all still findings;
// an exemption that no longer matches a hit is stale and fails the CLI run.
// Spelled by join, for the same reason the data-directory note below omits the
// prefix: this file is scanned too, and a literal stale tag here is a finding.
const PRE_PIN_16 = ['postgres', '16-alpine'].join(':')
export const PATH_EXEMPTIONS = [
  { path: 'modules/finance/test/backfill.integration.test.ts', line: 38, ref: PRE_PIN_16, reason: 'TASK-200 Q6: set-A file kept byte-equal to extraction-source-f1; guidance string in the fail-closed test-DB guard' },
  { path: 'modules/finance/test/bank-money.integration.test.ts', line: 38, ref: PRE_PIN_16, reason: 'TASK-200 Q6: set-A file kept byte-equal to extraction-source-f1; guidance string in the fail-closed test-DB guard' },
]

const isExempt = (h) => PATH_EXEMPTIONS.some((e) => e.path === h.path && e.line === h.line && e.ref === h.ref)

/** Exemptions that excuse nothing in `files` — stale, and a finding. */
export function staleExemptions(files) {
  const hits = files.filter((f) => PATH_EXEMPTIONS.some((e) => e.path === f.path)).flatMap((f) => scanText(f.path, f.text))
  return PATH_EXEMPTIONS.filter((e) => !hits.some((h) => h.path === e.path && h.line === e.line && h.ref === e.ref)).map(
    (e) => `stale exemption: ${e.path}:${e.line} no longer carries ${e.ref} — delete or move the PATH_EXEMPTIONS entry`,
  )
}

// `postgresql://user:pw@postgres:5432/db` is a HOST:PORT, not an image tag. The
// lookbehind drops anything glued to a word char, dot, slash, dash or `@`, and
// the trailing lookahead keeps a tag from being matched halfway. 5432 is then
// refused a second time below, because one net is one forgotten char from
// silently excusing a real tag — and the kernel prose writes bare `postgres:5432`
// in a dozen places with nothing in front of it.
const TAG_RE = /(?<![\w./@-])postgres:(latest|alpine|\d{1,4}(?:[.-][A-Za-z0-9.]+)*)(?![\w.-])/g

// The SECOND net, for the reference that has no tag at all for TAG_RE to match:
// `image: postgres`, `image: "postgres"`, `image: postgres:` with nothing after
// the colon. Docker resolves every one of those to the `latest` tag at pull
// time, which makes them the most dangerous floating reference in the set — and
// the vacuity guard cannot save a tree that carries eighteen correct references
// plus one of these, because the match set is far from empty.
//
// It is anchored on the compose / k8s `image:` KEY: a bare `postgres` word is
// far too common in prose, in service names and in environment values
// (`POSTGRES_DB: postgres`) to be read as an image reference anywhere else.
//
// The optional registry/namespace prefix accepts `docker.io/library/postgres`
// while refusing `mypostgres` and `timescale/timescaledb-postgis`: the reference
// must END at `postgres`, and any prefix must end in a slash.
const UNTAGGED_IMAGE_RE =
  /^\s*(?:-\s*)?image:\s*(["']?)((?:[A-Za-z0-9][A-Za-z0-9._-]*(?::[0-9]+)?\/)*postgres):?\1\s*(?:#.*)?$/

// The THIRD net: a shell parameter-expansion DEFAULT, `${VAR:-postgres:18-alpine}`.
// TAG_RE structurally CANNOT see one. The lookbehind that keeps
// `timescale-postgres:2` and `reader@postgres:5432` out drops anything glued to a
// `-`, and the `-` of `:-` is exactly that. Measured 2026-09-17:
// gremion-ui/scripts/fresh-init-proof.sh:28 carried a stale default for
// FRESH_INIT_PROOF_IMAGE through a whole unit while this guard reported
// "OK - 780 files scanned in the kernel tree". A default IS the tag that runs
// whenever the variable is unset, which is every CI run of `make fresh-init-proof`.
// Only the HYPHEN forms (`${V:-tag}` and `${V-tag}`) are matched here, because
// only they are invisible above: in `${V:=tag}` and `${V=tag}` the character
// before the reference is `=`, which the lookbehind does not drop, so TAG_RE
// already reads those. Matching them twice would report one stale default as two
// findings — the narrower net is what keeps each occurrence counted exactly once.
const SHELL_DEFAULT_RE =
  /\$\{[A-Za-z_][A-Za-z0-9_]*:?-postgres:(latest|alpine|\d{1,4}(?:[.-][A-Za-z0-9.]+)*)(?![\w.-])/g

export function scanText(path, text) {
  const hits = []
  text.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(TAG_RE)) {
      if (m[1] === '5432') continue
      hits.push({ path, line: i + 1, tag: m[1], ref: `postgres:${m[1]}` })
    }
    // Read on the SAME line pass, after TAG_RE: the two nets cannot both match one
    // occurrence (TAG_RE's lookbehind is precisely what blinds it here), so no
    // line is ever counted twice.
    for (const m of line.matchAll(SHELL_DEFAULT_RE)) {
      if (m[1] === '5432') continue
      hits.push({ path, line: i + 1, tag: m[1], ref: `postgres:${m[1]}` })
    }
    // A line carrying a real tag has already been read above; this fires only
    // where there is no tag at all, so no line is ever counted twice.
    const u = line.replace(/\r$/, '').match(UNTAGGED_IMAGE_RE)
    if (u) hits.push({ path, line: i + 1, tag: null, ref: u[2] })
  })
  return hits
}

export function classify(hit) {
  // No tag at all IS `latest`, and there is nothing to parse — so it is decided
  // here, before the numeric path, rather than by falling through it: Number('')
  // is 0, which IS an integer, and would otherwise be reported as a mismatched
  // major 0 instead of as the floating reference it is.
  if (!hit.tag || hit.tag === 'latest' || hit.tag === 'alpine') return 'unpinned'
  const major = hit.tag.split(/[.-]/)[0]
  if (!/^\d+$/.test(major)) return 'unpinned'
  return Number(major) === POSTGRES_MAJOR ? 'ok' : 'mismatched'
}

/** @param files [{path, text}] */
export function checkFiles(files) {
  const hits = files
    .filter((f) => !EXCLUDED.some((re) => re.test(f.path)))
    .flatMap((f) => scanText(f.path, f.text))
  if (hits.length === 0) {
    return ['found zero postgres: image references — the guard would pass vacuously']
  }
  return hits
    .filter((h) => classify(h) !== 'ok')
    .filter((h) => !isExempt(h))
    .map((h) => `${classify(h)}: ${h.path}:${h.line} ${h.ref} (expected ${POSTGRES_IMAGE_TAG})`)
}

// ── the data-directory contract ────────────────────────────────────────────
//
// A second, SEPARATE post-condition, because the tag guard above cannot see it.
// docker-library/postgres PR 1259 changed the layout at major 18: PGDATA moved
// from /var/lib/postgresql/data to /var/lib/postgresql/<major>/docker, the
// image's declared VOLUME moved up to /var/lib/postgresql, and the 18+
// entrypoint REFUSES to start when anything is mounted at
// /var/lib/postgresql/data — a brand-new EMPTY volume included. Measured on this
// box against the real images:
//
//   the 16-alpine image  PGDATA=/var/lib/postgresql/data       VOLUME /var/lib/postgresql/data
//   the 18-alpine image  PGDATA=/var/lib/postgresql/18/docker  VOLUME /var/lib/postgresql
//
// (written without the `postgres:` prefix on purpose — this file is one of the
// tracked files the tag scan above reads, and a stale tag spelled out here would
// be an honest finding against the guard's own source.)
//
// So a tree that bumps the TAG to 18 and leaves its mount where 16 wanted it
// crash-loops on a wiped box, with every tag guard green. That is the failure
// this check exists to make impossible.
export const POSTGRES_DATA_MOUNT =
  POSTGRES_MAJOR >= 18 ? '/var/lib/postgresql' : '/var/lib/postgresql/data'

// Only real mount DECLARATIONS are scanned, and only in the file kinds that can
// carry one. Prose in a .md is prose: docs/ops/postgres-major.md has to be free
// to NAME the old path in order to explain the boundary, and a .mjs carries no
// mounts. A path that is neither POSTGRES_DATA_MOUNT nor a subdirectory-free
// match is reported, so `/var/lib/postgresql/18/docker` — which works today and
// breaks at the next bump — is a finding too.
const MOUNTABLE = /\.(ya?ml|sh|bats|tmpl)$/
const MOUNT_RES = [
  // compose short syntax, NAMED volume or BIND mount:
  //   - pg-data:/var/lib/postgresql[:ro]      - ./pgdata:/var/lib/postgresql
  //   - /srv/pg:/var/lib/postgresql           - ${PG_DIR}/data:/var/lib/postgresql
  // The source class carries `/`, `\`, `~` and `..` on purpose: a bind mount at
  // the pre-18 path crash-loops exactly like a named volume there, and a leaf
  // fragment or an operator overlay is as likely to write one as the other. A
  // single-letter Windows drive prefix is allowed explicitly so that a `C:/pg`
  // source cannot swallow the separating colon.
  /^\s*-\s*["']?(?:[A-Za-z]:)?[A-Za-z0-9_.${}~/\\+-]+:(\/var\/lib\/postgresql[^\s:"']*)/,
  // compose long syntax and kubernetes:  target: / mountPath: /var/lib/postgresql
  /^\s*(?:target|mountPath):\s*["']?(\/var\/lib\/postgresql[^\s"']*)/,
]

export function scanDataMounts(path, text) {
  const hits = []
  text.split('\n').forEach((line, i) => {
    for (const re of MOUNT_RES) {
      const m = line.match(re)
      if (m) { hits.push({ path, line: i + 1, mount: m[1] }); break }
    }
  })
  return hits
}

/**
 * Every persistent Postgres data mount in the tree sits at the path the PINNED
 * major's image actually uses. An empty match set is a FAILURE for the same
 * reason checkFiles refuses one: a scan that found nothing proves nothing.
 *
 * @param files [{path, text}]
 */
export function checkDataMounts(files) {
  const hits = files
    .filter((f) => !EXCLUDED.some((re) => re.test(f.path)))
    .filter((f) => MOUNTABLE.test(f.path))
    .flatMap((f) => scanDataMounts(f.path, f.text))
  if (hits.length === 0) {
    return ['found zero Postgres data mounts — the data-directory check would pass vacuously']
  }
  return hits
    .filter((h) => h.mount !== POSTGRES_DATA_MOUNT)
    .map((h) =>
      `data mount: ${h.path}:${h.line} mounts ${h.mount} (expected ${POSTGRES_DATA_MOUNT}` +
      ` — postgres:${POSTGRES_MAJOR} stores its data in /var/lib/postgresql/${POSTGRES_MAJOR}/docker` +
      ` and its entrypoint refuses ANY mount at /var/lib/postgresql/data, empty or not:` +
      ` docker-library/postgres PR 1259)`)
}

// Extension-bearing text files, PLUS the tracked files that carry no extension
// at all and would otherwise never be opened: the host CLI under
// `infra/host/bin/` (gremion-backup, gremion-restore-into, gremion-render, ...)
// and the dotted env templates (`.env.example`). A `postgres:<tag>` written into
// one of those would be pinned by nobody.
const TEXTUAL =
  /\.(ya?ml|md|ts|mjs|js|sh|bats|json|tmpl)$|(^|\/)(Dockerfile|Makefile)|^infra\/host\/bin\/[^/]+$|(^|\/)\.env(\.[\w-]+)?$/

export function trackedTextFiles(root) {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  return out
    .split('\0')
    .filter((p) => p && TEXTUAL.test(p))
    .map((p) => ({ path: p, text: readFileSync(join(root, p), 'utf8') }))
}

// ── module repos and assembled release trees ───────────────────────────────

/**
 * A module repo or an assembled release tree: every `compose/<id>.yml` fragment
 * plus the composed files D13 inlines them into. Nothing is walked recursively,
 * so an accidental `--tree /` reports zero rather than grinding — and zero is a
 * FAILURE, not a pass (checkFiles refuses an empty match set). A tree that is
 * not there at all throws rather than reporting an empty, reassuring scan.
 */
export function fragmentFiles(root) {
  if (!existsSync(root)) throw new Error(`no such tree: ${root}`)
  const out = []
  const push = (abs) => out.push({
    path: relative(root, abs).split(sep).join('/'),
    text: readFileSync(abs, 'utf8'),
  })
  const composeDir = join(root, 'compose')
  if (existsSync(composeDir)) {
    for (const n of readdirSync(composeDir)) {
      if (/\.ya?ml$/.test(n) && statSync(join(composeDir, n)).isFile()) push(join(composeDir, n))
    }
  }
  for (const n of readdirSync(root)) {
    if (/^docker-compose.*\.ya?ml$/.test(n) && statSync(join(root, n)).isFile()) push(join(root, n))
  }
  return out
}

// ── CLI ────────────────────────────────────────────────────────────────────

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
  const i = process.argv.indexOf('--tree')
  const tree = i >= 0 ? process.argv[i + 1] : null
  if (i >= 0 && !tree) { console.error('[postgres-major] --tree needs a directory'); process.exit(2) }
  const files = tree ? fragmentFiles(tree) : trackedTextFiles(ROOT)
  const problems = tree
    ? [...checkFiles(files), ...checkDataMounts(files)]
    : [
        ...checkEvidence(readFileSync(join(ROOT, EVIDENCE_PATH), 'utf8')),
        ...checkFiles(files),
        ...staleExemptions(files),
        ...checkDataMounts(files),
      ]
  if (problems.length > 0) {
    console.error(`[postgres-major] ${problems.length} problem(s) in ${tree ?? 'the kernel tree'}:`)
    for (const p of problems) console.error(`  x ${p}`)
    process.exit(1)
  }
  console.log(`[postgres-major] OK — ${files.length} files scanned in ${tree ?? 'the kernel tree'}, every postgres: reference is ${POSTGRES_IMAGE_TAG}${tree ? '' : ` except ${PATH_EXEMPTIONS.length} named per-path exemption(s)`} and every data mount is ${POSTGRES_DATA_MOUNT}`)
}
