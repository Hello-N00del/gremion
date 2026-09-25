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
// TRD-350: the tag is a pointer the registry may move; the digest is the
// content. This is the multi-arch INDEX digest (`docker buildx imagetools
// inspect postgres:<major>-alpine`, the top `Digest:`), never a per-platform
// manifest: an index digest resolves to the right image on amd64 and arm64
// alike, a platform digest pins one architecture and breaks the other. ONE
// digest everywhere, recorded as "- **Pinned digest**:" in the evidence file.
export const POSTGRES_IMAGE_DIGEST = 'sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873'
export const POSTGRES_IMAGE_REF = `${POSTGRES_IMAGE_TAG}@${POSTGRES_IMAGE_DIGEST}`
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
  const d = text.match(/^- \*\*Pinned digest\*\*: (sha256:[0-9a-f]{64})$/m)
  if (!d) {
    problems.push(`${EVIDENCE_PATH} carries no "- **Pinned digest**: sha256:<64 hex>" line`)
  } else if (d[1] !== POSTGRES_IMAGE_DIGEST) {
    problems.push(`${EVIDENCE_PATH} pins digest ${d[1]}, check-postgres-major.mjs exports ${POSTGRES_IMAGE_DIGEST}`)
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

// Three NAMED exclusions, and only three. Anything not on this list is scanned.
//
//  1. Frozen copies of the APPROVED specs quote the pre-pin tag verbatim. They
//     are a record of what was decided, not a place a tag is configured;
//     rewriting them would falsify the record. It is also the only tracked path
//     under docs/superpowers — B0 un-ignores exactly
//     docs/superpowers/specs/spec-{b,d}-*.md and nothing else.
//  2. The `tree-stale` and `tree-stale-module` fixtures EXIST to carry a stale
//     tag: they are what prove `--tree` goes RED (the second one digest-pinned
//     on an older major, TASK-019). Excluding the whole `postgres-major` fixture
//     directory would also excuse `tree-clean`, so the rule names the two stale
//     trees alone and `tree-clean` stays scanned like any other file (and is
//     pinned).
//  3. `k8s/**` is FROZEN (decision D16): the Kubernetes manifests are not a
//     release-1 deployment target, nobody edits them, and a pin nobody may
//     write cannot be demanded of them. They keep the major-only tag they
//     carry; TASK-126 owns them. Anchored at the repo root, so `docs/k8s.md` or
//     `infra/k8s/` would still be scanned.
export const EXCLUDED = [
  /^docs\/superpowers\/specs\//,
  /^test\/host\/fixtures\/postgres-major\/tree-stale(-module)?\//,
  /^k8s\//,
]

// `postgresql://user:pw@postgres:5432/db` is a HOST:PORT, not an image tag. The
// lookbehind drops anything glued to a word char, dot, slash, dash or `@`, and
// the trailing lookahead keeps a tag from being matched halfway. 5432 is then
// refused a second time below, because one net is one forgotten char from
// silently excusing a real tag — and the kernel prose writes bare `postgres:5432`
// in a dozen places with nothing in front of it.
//
// A trailing `@<algo>:<hex>` is captured as the reference's digest (group 2).
// It is captured loosely on purpose — `@sha256:abc` is read, not skipped — so a
// truncated or malformed digest is compared against the pin and reported as
// drift instead of disappearing from the scan.
const DIGEST_TAIL = String.raw`(?:@([A-Za-z0-9]+:[A-Za-z0-9]*))?`
const TAG_RE = new RegExp(
  String.raw`(?<![\w./@-])postgres:(latest|alpine|\d{1,4}(?:[.-][A-Za-z0-9.]+)*)(?![\w.-])` + DIGEST_TAIL, 'g')

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
//
// TASK-019: a DIGEST without a tag (`image: postgres@sha256:...`) is read here
// too. It may even be the right content, but no reader and no scanner can tell
// its major from the text, and the pin is written `<tag>@<digest>` everywhere.
const UNTAGGED_IMAGE_RE =
  /^\s*(?:-\s*)?image:\s*(["']?)((?:[A-Za-z0-9][A-Za-z0-9._-]*(?::[0-9]+)?\/)*postgres):?(?:@\S*?)?\1\s*(?:#.*)?$/

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
const SHELL_DEFAULT_RE = new RegExp(
  String.raw`\$\{[A-Za-z_][A-Za-z0-9_]*:?-postgres:(latest|alpine|\d{1,4}(?:[.-][A-Za-z0-9.]+)*)(?![\w.-])` + DIGEST_TAIL, 'g')

// The FOURTH net (TASK-019): a REGISTRY-PREFIXED reference,
// `docker.io/library/postgres:<tag>` or `registry:5000/mirror/postgres:<tag>`.
// Docker resolves the first to exactly the image the short form names, and
// TAG_RE cannot see either: its lookbehind drops the `/` in front of
// `postgres`. The prefix is one or more `<segment>/`, and the FIRST segment
// must not be glued to a word char, `.`, `/`, `@`, `:` or `-` — which keeps
// URLs (`https://hub.docker.com/_/postgres`, `http://db/postgres:5432`) and
// `timescale-postgres` out — EXCEPT the `-` of a shell default `${V:-...}`,
// which is read on purpose for the same reason SHELL_DEFAULT_RE exists.
// Disjoint from TAG_RE (which needs no `/` before `postgres`) and from
// SHELL_DEFAULT_RE (which needs `-` directly before it), so no occurrence is
// counted twice.
const REGISTRY_RE = new RegExp(
  String.raw`(?:(?<![\w./@:-])|(?<=\$\{[A-Za-z_][A-Za-z0-9_]*:?-))` +
  String.raw`((?:[A-Za-z0-9][A-Za-z0-9.-]*(?::[0-9]+)?\/)+)postgres:(latest|alpine|\d{1,4}(?:[.-][A-Za-z0-9.]+)*)(?![\w.-])` +
  DIGEST_TAIL, 'g')

// Q3 (TASK-019): the file kinds in which a reference is a DECLARATION — the
// thing that is pulled and run — and so must carry the digest: compose and
// workflow YAML, shell (.sh/.bats), templates, Dockerfiles, the extensionless
// host CLI and the dotted env files (a shell assignment). Prose (.md) and code
// comments (.mjs/.ts) stay major-only: they NAME the image, they do not pull it.
const DECLARING = /\.(ya?ml|sh|bats|tmpl)$|(^|\/)Dockerfile[^/]*$|^infra\/host\/bin\/[^/]+$|(^|\/)\.env(\.[\w-]+)?$/

// Where the comment part of a line starts in a #-comment file kind, or
// Infinity. `#` only opens a comment at the start or after whitespace, so a
// shell `${VAR#prefix}` or a URL fragment is not taken for one.
function commentStart(line) {
  const m = line.match(/(^|\s)#/)
  return m ? m.index + m[1].length : Infinity
}

export function scanText(path, text) {
  const hits = []
  const declaring = DECLARING.test(path)
  text.split('\n').forEach((line, i) => {
    // A hit is a declaration when its file kind declares images and it sits
    // before any comment on the line.
    const cut = declaring ? commentStart(line) : -1
    const hit = (m, prefix, tag, digest) => ({
      path, line: i + 1, tag, ref: `${prefix}postgres:${tag}`,
      digest: digest ?? null, decl: m.index < cut,
    })
    for (const m of line.matchAll(TAG_RE)) {
      if (m[1] === '5432') continue
      hits.push(hit(m, '', m[1], m[2]))
    }
    for (const m of line.matchAll(REGISTRY_RE)) {
      if (m[2] === '5432') continue
      hits.push(hit(m, m[1], m[2], m[3]))
    }
    // Read on the SAME line pass, after TAG_RE: the two nets cannot both match one
    // occurrence (TAG_RE's lookbehind is precisely what blinds it here), so no
    // line is ever counted twice.
    for (const m of line.matchAll(SHELL_DEFAULT_RE)) {
      if (m[1] === '5432') continue
      hits.push(hit(m, '', m[1], m[2]))
    }
    // A line carrying a real tag has already been read above; this fires only
    // where there is no tag at all, so no line is ever counted twice.
    const u = line.replace(/\r$/, '').match(UNTAGGED_IMAGE_RE)
    if (u) hits.push({ path, line: i + 1, tag: null, ref: u[2], digest: null, decl: true })
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
  if (Number(major) !== POSTGRES_MAJOR) return 'mismatched'
  // The major is right; now the content. A digest that is present and not the
  // pin is drift wherever it is written — prose included, because a record
  // naming another digest is a record of a different image. A missing digest
  // is a finding only on a declaration (Q3).
  if (hit.digest != null && hit.digest !== POSTGRES_IMAGE_DIGEST) return 'digest-drift'
  if (hit.decl && hit.digest == null) return 'undigested'
  return 'ok'
}

/**
 * ONE digest everywhere. Each drifted reference is already a per-line finding;
 * this names the tree-level state as well, so a split pin reads as one problem
 * with every digest listed rather than as a scatter of unrelated lines.
 */
export function checkDigests(hits) {
  const seen = [...new Set(hits.map((h) => h.digest).filter((d) => d != null))]
  if (seen.length <= 1) return []
  return [`split pin: ${seen.length} distinct postgres digests in one tree (${seen.join(', ')}); expected only ${POSTGRES_IMAGE_DIGEST}`]
}

/** @param files [{path, text}] */
export function checkFiles(files) {
  const hits = files
    .filter((f) => !EXCLUDED.some((re) => re.test(f.path)))
    .flatMap((f) => scanText(f.path, f.text))
  if (hits.length === 0) {
    return ['found zero postgres: image references — the guard would pass vacuously']
  }
  return [
    ...hits
      .filter((h) => classify(h) !== 'ok')
      .map((h) => `${classify(h)}: ${h.path}:${h.line} ${h.ref}${h.digest != null ? `@${h.digest}` : ''} (expected ${POSTGRES_IMAGE_REF})`),
    ...checkDigests(hits),
  ]
}

// ── the Postgres service set (TASK-019, Q1, D14) ──────────────────────────
//
// D14: per-module Postgres. The kernel base compose declares, besides its own
// `postgres`, one `<id>-postgres` for each of the six extraction-source leaves,
// profile-gated under `profiles: [<id>]` and labelled
// org.gremion.postgres=module:<id>; the kernel server is labelled `kernel`.
// The label is how the RUNNING check (check-postgres-major-running.mjs) finds
// containers, so an unlabelled Postgres is a server nobody verifies.
export const MODULE_POSTGRES_IDS = ['board', 'calendar', 'content', 'finance', 'newsletter', 'vault']
export const POSTGRES_LABEL = 'org.gremion.postgres'

// Volume names a module server must never mount: the kernel's own cluster and
// the fixed names the extraction source's running stack gives its PG16 leaf
// volumes (`gremion_<id>_pg_data`, measured in its docker-compose.yml on
// 2026-09-25). On a box that still carries that stack, a PG18 server declared
// on one of those names would be mounted on live PG16 data.
export const FORBIDDEN_MODULE_VOLUMES = new Set([
  'gremion_pg_data',
  ...MODULE_POSTGRES_IDS.map((id) => `gremion_${id}_pg_data`),
])

const isPostgresService = (s) => s.name === 'postgres' || /-postgres$/.test(s.name) || s.label != null

const unquote = (v) => v.replace(/\s+#.*$/, '').trim().replace(/^(["'])(.*)\1$/, '$2')

/** The lines under a column-0 `<key>:` — [start, end) indices, or null. */
function topBlock(lines, key) {
  const start = lines.findIndex((l) => new RegExp(`^${key}:\\s*(#.*)?$`).test(l))
  if (start < 0) return null
  let end = start + 1
  while (end < lines.length && !/^[^\s#]/.test(lines[end])) end++
  return [start + 1, end]
}

/**
 * The services of ONE compose file, read line by line (the guard stays
 * dependency-free). Per service: its name and line, its OWN `image:` (null when
 * it has none, e.g. it takes one from a `<<: *anchor` merge), the
 * org.gremion.postgres label in map or list form, its profiles and its volume
 * mounts. Top-level volume names are returned alongside.
 */
export function composeServices(text) {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''))
  const block = topBlock(lines, 'services')
  if (!block) return []
  const out = []
  let svcIndent = null
  let cur = null
  let section = null
  for (let i = block[0]; i < block[1]; i++) {
    const l = lines[i]
    if (/^\s*(#.*)?$/.test(l)) continue
    const ind = l.match(/^ */)[0].length
    if (svcIndent === null) svcIndent = ind
    if (ind <= svcIndent) {
      const m = l.match(/^\s*([A-Za-z0-9._-]+):\s*(#.*)?$/)
      cur = m && ind === svcIndent
        ? { name: m[1], line: i + 1, image: null, imageLine: null, label: null,
            profiles: [], merge: false, mounts: [], propIndent: null }
        : null
      if (cur) out.push(cur)
      section = null
      continue
    }
    if (!cur) continue
    if (cur.propIndent === null) cur.propIndent = ind
    if (ind === cur.propIndent) {
      const kv = l.match(/^\s*([A-Za-z0-9_<.-]+):\s*(.*)$/)
      section = kv ? kv[1] : null
      const val = kv ? kv[2] : ''
      if (section === 'image') { cur.image = unquote(val); cur.imageLine = i + 1 }
      if (section === '<<') cur.merge = true
      if (section === 'profiles' && val.startsWith('[')) {
        cur.profiles = val.replace(/[[\]\s"']/g, '').split(',').filter(Boolean)
      }
      if (section === 'labels' && val) readLabel(cur, val)
      continue
    }
    // a line deeper than the service's own keys belongs to the current section
    if (section === 'profiles') {
      const m = l.match(/^\s*-\s*["']?([^"'\s#]+)/)
      if (m) cur.profiles.push(m[1])
    }
    if (section === 'labels') readLabel(cur, l)
    if (section === 'volumes') {
      const m = l.match(/^\s*-\s*["']?([^:"'\s]+):([^:"'\s]+)/)
      if (m) cur.mounts.push({ source: m[1], target: m[2] })
    }
  }
  return out
}

function readLabel(svc, text) {
  const m = text.match(/org\.gremion\.postgres["']?\s*[:=]\s*["']?([^"'\s,}\]]+)/)
  if (m) svc.label = m[1]
}

/** Top-level `volumes:` of one compose file: key -> fixed `name:` (or null). */
export function composeVolumeNames(text) {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''))
  const block = topBlock(lines, 'volumes')
  const names = new Map()
  if (!block) return names
  let key = null
  for (let i = block[0]; i < block[1]; i++) {
    const k = lines[i].match(/^ {2}([A-Za-z0-9._-]+):\s*(\{.*\})?\s*(#.*)?$/)
    if (k) {
      key = k[1]
      const inline = (k[2] ?? '').match(/name:\s*["']?([^"'\s,}]+)/)
      names.set(key, inline ? inline[1] : null)
      continue
    }
    const n = lines[i].match(/^ {4}name:\s*["']?([^"'\s#]+)/)
    if (n && key) names.set(key, n[1])
  }
  return names
}

// A file whose services DECLARE rather than overlay: the base compose and a
// module fragment. An override file's `postgres:` entry legitimately carries no
// image of its own, so the no-image rule does not apply there.
const BASE_COMPOSE = /(^|\/)docker-compose\.ya?ml$|(^|\/)compose\/[^/]+\.ya?ml$/

/**
 * Every Postgres service (named `postgres` / `*-postgres`, or labelled) pins
 * its image LITERALLY. `image: ${CALENDAR_PG_IMAGE}` runs whatever major the
 * environment says, and no text scan can read it; a pinned DEFAULT does not
 * help, because the variable is exactly how the default gets overridden.
 */
export function checkComposeServices(files) {
  const problems = []
  for (const f of files.filter((f) => /\.ya?ml$/.test(f.path))) {
    for (const s of composeServices(f.text).filter(isPostgresService)) {
      if (s.image != null && s.image.includes('${')) {
        problems.push(`variable image: ${f.path}:${s.imageLine} service ${s.name} image ${s.image} — a Postgres service pins its image literally (${POSTGRES_IMAGE_REF}); a variable runs whatever major the environment names`)
      } else if (s.image == null && !s.merge && BASE_COMPOSE.test(f.path)) {
        problems.push(`no image: ${f.path}:${s.line} service ${s.name} declares no image and merges none from an anchor`)
      }
    }
  }
  return problems
}

/**
 * The kernel base compose declares exactly the Postgres set D14 names: the
 * kernel server labelled `kernel`, one `<id>-postgres` per module labelled
 * `module:<id>` under `profiles: [<id>]`, on a volume that is not a live one,
 * and no Postgres service outside that set.
 */
export function checkModuleSet(text) {
  const problems = []
  const svcs = composeServices(text)
  const byName = new Map(svcs.map((s) => [s.name, s]))
  const volumeNames = composeVolumeNames(text)
  if (byName.get('postgres')?.label !== 'kernel') {
    problems.push(`the kernel postgres service is not labelled ${POSTGRES_LABEL}=kernel`)
  }
  const seenVolumes = new Map()
  for (const id of MODULE_POSTGRES_IDS) {
    const name = `${id}-postgres`
    const s = byName.get(name)
    if (!s) { problems.push(`no ${name} service: the module set (D14) is ${MODULE_POSTGRES_IDS.join(', ')}`); continue }
    if (s.label !== `module:${id}`) {
      problems.push(`${name} is labelled ${POSTGRES_LABEL}=${s.label}, expected module:${id}`)
    }
    if (s.profiles.length !== 1 || s.profiles[0] !== id) {
      problems.push(`${name} is not gated under profiles: [${id}] (has [${s.profiles.join(', ')}])`)
    }
    const data = s.mounts.find((m) => m.target === POSTGRES_DATA_MOUNT)
    if (!data) { problems.push(`${name} mounts no volume at ${POSTGRES_DATA_MOUNT}`); continue }
    const vol = volumeNames.get(data.source) ?? data.source
    if (FORBIDDEN_MODULE_VOLUMES.has(vol)) {
      problems.push(`${name} mounts volume ${vol}, which is the kernel's cluster or a live extraction-source PG16 volume`)
    }
    if (seenVolumes.has(vol)) problems.push(`${name} shares volume ${vol} with ${seenVolumes.get(vol)}`)
    seenVolumes.set(vol, name)
  }
  const known = new Set(['postgres', ...MODULE_POSTGRES_IDS.map((id) => `${id}-postgres`)])
  for (const s of svcs.filter(isPostgresService)) {
    if (!known.has(s.name)) problems.push(`${s.name} is a Postgres service outside the module set (${[...known].join(', ')})`)
  }
  return problems
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
    ? [...checkFiles(files), ...checkDataMounts(files), ...checkComposeServices(files)]
    : [
        ...checkEvidence(readFileSync(join(ROOT, EVIDENCE_PATH), 'utf8')),
        ...checkFiles(files),
        ...checkDataMounts(files),
        ...checkComposeServices(files.filter((f) => !EXCLUDED.some((re) => re.test(f.path)))),
        ...checkModuleSet(readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8')),
      ]
  if (problems.length > 0) {
    console.error(`[postgres-major] ${problems.length} problem(s) in ${tree ?? 'the kernel tree'}:`)
    for (const p of problems) console.error(`  x ${p}`)
    process.exit(1)
  }
  console.log(`[postgres-major] OK — ${files.length} files scanned in ${tree ?? 'the kernel tree'}, every postgres: declaration is ${POSTGRES_IMAGE_REF} and every data mount is ${POSTGRES_DATA_MOUNT}`)
}
