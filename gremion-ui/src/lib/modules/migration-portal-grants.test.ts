import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'migrations')
const sorted = () => readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
const read = (f: string) => readFileSync(join(MIGRATIONS_DIR, f), 'utf-8')
/** Executable SQL only: drop whole-line `--` comments before asserting. */
const executable = (f: string) =>
  read(f)
    .split('\n')
    .filter((l) => !/^\s*--/.test(l))
    .join('\n')

// The tables the anonymous public portal actually reads (R-E13:
// gremion-public/src/lib/server/public-db.ts:51,82,105 reads only `protocols`
// and `org_units`, nothing else). news_posts is NOT here: kernel
// 008_public_portal.sql:4-6 records that it moved out with the content
// module, so a content-OFF kernel-only install has no such table;
// B4a-news-posts-ownership gives content its own grant.
const KERNEL_PORTAL_TABLES = ['org_units', 'protocols']

// Tables 058 actively REVOKEs rather than merely omitting from portal_tables.
// `protocol_attendance`, `protocol_action_items` and `protocol_resolutions`
// are granted directly to gremion_public_reader by kernel
// 008_public_portal.sql (008:23-29); `resolution_challenges` by
// 055_resolution_challenges.sql (055:69). Both run before 058 on every
// install, so these four REVOKEs are load-bearing on a fresh install too —
// without them gremion_public_reader would still end up holding all four via
// 008/055 alone. `calendar_events` and `event_recurrence` are not granted by
// any kernel migration today; their REVOKE is defensive (R-E13). Editing 058
// in place cannot converge a database that already applied an earlier,
// six-table version of this filename — the migration runner skips a filename
// it has already recorded before re-checking its hash — but no such database
// exists: kernel 058 has never shipped on `main` or `origin/main`.
const REVOKED_TABLES = [
  'protocol_attendance',
  'protocol_action_items',
  'calendar_events',
  'event_recurrence',
  'protocol_resolutions',
  'resolution_challenges',
]

describe('058 public-reader grants', () => {
  it('055 sorts strictly before 058 — the REVOKE must run after 055 GRANTs resolution_challenges', () => {
    const list = sorted()
    expect(list.indexOf('055_resolution_challenges.sql')).toBeGreaterThanOrEqual(0)
    expect(list.indexOf('055_resolution_challenges.sql')).toBeLessThan(
      list.indexOf('058_public_reader_grants.sql'),
    )
  })

  it('portal_tables is exactly the two tables the anonymous portal reads', () => {
    const body = executable('058_public_reader_grants.sql')
    const block = body.match(/portal_tables CONSTANT text\[\] := ARRAY\[([^\]]*)\]/)
    expect(block, 'portal_tables ARRAY literal not found').not.toBeNull()
    const names = [...block![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort()
    expect(names).toEqual([...KERNEL_PORTAL_TABLES].sort())
  })

  it('revoked_tables is a superset of the four tables narrowed out of portal_tables (R-E13)', () => {
    const body = executable('058_public_reader_grants.sql')
    const block = body.match(/revoked_tables CONSTANT text\[\] := ARRAY\[([^\]]*)\]/)
    expect(block, 'revoked_tables ARRAY literal not found').not.toBeNull()
    const names = [...block![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
    for (const t of ['calendar_events', 'event_recurrence', 'protocol_resolutions', 'resolution_challenges']) {
      expect(names, `revoked_tables is missing ${t}`).toContain(t)
    }
    // Full-set pin, not just superset: a stray extra revoke is as much a
    // least-privilege regression as a missing one.
    expect([...names].sort()).toEqual([...REVOKED_TABLES].sort())
  })

  it('does not grant news_posts — that table is content-owned (1200_content_news_posts.sql)', () => {
    const body = executable('058_public_reader_grants.sql')
    expect(body).not.toMatch(/'news_posts'/)
  })

  it('058 still aborts on a missing table rather than granting a partial set', () => {
    const body = executable('058_public_reader_grants.sql')
    expect(body).toMatch(/RAISE EXCEPTION/)
    expect(body).toMatch(/array_length\(missing, 1\) IS NOT NULL/)
  })

  it('no executable line in the kernel chain names the retired reader role', () => {
    const offenders = sorted().filter((f) => /stura_public_reader/.test(executable(f)))
    expect(offenders).toEqual([])
  })

  // Same failure mode one level up: 058's abort message tells the operator which
  // password to reuse, and the extraction source named the StuRa tree's own
  // connection variable. The kernel's is GREMION_PUBLIC_DB_URL (.env.example:197,
  // gremion-public/src/lib/server/public-db.ts:14) — no STURA_-prefixed variable
  // exists here, so the ported wording sent an operator looking for something the
  // kernel never defines. Asserted over the whole chain, not just 058.
  it('no executable line in the kernel chain names a STURA_-prefixed env var', () => {
    const offenders = sorted().filter((f) => /\bSTURA_[A-Z0-9_]+/.test(executable(f)))
    expect(offenders).toEqual([])
  })

  it('058 points the operator at the env var the kernel actually defines', () => {
    expect(executable('058_public_reader_grants.sql')).toMatch(/GREMION_PUBLIC_DB_URL/)
  })

  it('every portal table is created by a migration that sorts before 058', () => {
    const list = sorted()
    const i058 = list.indexOf('058_public_reader_grants.sql')
    for (const table of KERNEL_PORTAL_TABLES) {
      // org_units is never CREATEd: 001_governance_schema.sql creates `committees`
      // and 010_org_units.sql:6 RENAMEs it. A "creator" is therefore a CREATE
      // TABLE **or** the ALTER ... RENAME TO that produces the name — asserted
      // against the EXECUTABLE body, so a prose mention in a comment cannot stand
      // in for DDL.
      const pattern = new RegExp(
        [
          String.raw`CREATE TABLE (IF NOT EXISTS )?${table}\b`,
          String.raw`ALTER TABLE \w+ RENAME TO ${table}\b`,
        ].join('|'),
      )
      const creator = list.findIndex((f) => pattern.test(executable(f)))
      expect(creator, `no migration creates ${table}`).toBeGreaterThanOrEqual(0)
      expect(creator, `${table} is created after 058`).toBeLessThan(i058)
    }
  })
})

// ---------------------------------------------------------------------------
// 058 turned a silent skip into a hard prerequisite. A prerequisite is only as
// good as the provisioning that satisfies it: before this guard, ONLY
// docker/postgres/init-databases.sh created gremion_public_reader, and only when
// PUBLIC_DB_PASSWORD happened to be set. The K8s ConfigMap -- which
// init-databases.sh:7-11 declares its mandatory mirror, and which 058's own
// abort message sends the operator to -- created keycloak, gremion and control
// and nothing else, so every K8s-provisioned kernel aborted the WHOLE data-plane
// chain at boot with a remediation pointing at a file that did not implement it.
// ---------------------------------------------------------------------------
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const readRepo = (f: string) => readFileSync(join(REPO_ROOT, f), 'utf-8')

const PROVISIONING_PATHS = [
  'docker/postgres/init-databases.sh',
  'k8s/base/postgres/configmap.yaml',
]

describe('058 prerequisite: every shipped path provisions gremion_public_reader', () => {
  it.each(PROVISIONING_PATHS)('%s creates the role', (path) => {
    expect(readRepo(path)).toMatch(/CREATE ROLE gremion_public_reader/)
  })

  it.each(PROVISIONING_PATHS)('%s aborts when PUBLIC_DB_PASSWORD is unset', (path) => {
    const text = readRepo(path)
    // The `${VAR:?message}` form, because it is fatal under both bash and the
    // busybox sh the K8s init container runs (statefulset.yaml:34), and because
    // it is one greppable shape rather than two hand-rolled if/exit branches.
    expect(text, `${path} must refuse to continue without PUBLIC_DB_PASSWORD`).toMatch(
      /\$\{PUBLIC_DB_PASSWORD:\?/,
    )
    // The precise shape 058 exists to delete, one layer down: provision nothing,
    // say so in a log line nobody reads, exit 0. A skip here does not degrade the
    // portal -- it stops the tenant migrating at all, one layer from the cause.
    const skips = text
      .split('\n')
      .filter((l) => /skip/i.test(l) && /gremion_public_reader|PUBLIC_DB_PASSWORD/.test(l))
    expect(skips, `${path} still has a skip-and-continue branch`).toEqual([])
  })

  // A fix is only a fix in the process that actually runs. The ConfigMap's
  // inline script opens with `set -euo pipefail`, but statefulset.yaml starts it
  // with `/bin/sh` -- busybox ash in postgres:*-alpine -- which rejects
  // `-o pipefail` outright. Measured 2026-09-17 inside postgres:18-alpine:
  //   /tmp/k8s-init.sh: set: line 5: illegal option -o pipefail
  // i.e. the K8s init container has never created ANY database or role. Adding
  // the role block above it would have been provisioning nobody executes.
  it('the K8s init script survives the interpreter the StatefulSet hands it', () => {
    const sts = readRepo('k8s/base/postgres/statefulset.yaml')
    const cm = readRepo('k8s/base/postgres/configmap.yaml')
    const runsUnderSh = /command:\s*\[\s*"\/bin\/sh"/.test(sts)
    expect(runsUnderSh, 'precondition: the init container is started with /bin/sh').toBe(true)
    // The bashisms busybox ash refuses. `pipefail` is the one that shipped.
    for (const bashism of [/set\s+-[a-z]*o\s+pipefail/, /pipefail/, /\[\[/]) {
      expect(cm, `the inline init script uses ${bashism} but runs under /bin/sh`).not.toMatch(bashism)
    }
  })

  it('every repo path 058 names is a path this repo actually has', () => {
    // The same defect class as the STURA_PUBLIC_DB_URL wording above: a
    // remediation that names a file the kernel does not ship sends the operator
    // nowhere. Only `dir/name.ext` tokens are read -- bare basenames like `db.ts`
    // are prose cross-references, not instructions.
    const text = read('058_public_reader_grants.sql')
    const paths = [
      ...new Set(text.match(/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_./-]+\.(?:sh|ya?ml|ts|sql|json)/g) ?? []),
    ]
    expect(paths.length, 'precondition: 058 names at least one repo path').toBeGreaterThan(0)
    const missing = paths.filter(
      (rel) => !existsSync(join(REPO_ROOT, rel)) && !existsSync(join(REPO_ROOT, 'gremion-ui', rel)),
    )
    expect(missing, '058 names paths that do not exist in this repo').toEqual([])
  })
})
