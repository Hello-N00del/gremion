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
