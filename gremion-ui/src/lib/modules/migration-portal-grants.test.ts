import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
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

// The kernel-guaranteed least-privilege set the ported 058 grants. news_posts is
// NOT here: kernel 008_public_portal.sql:4-6 records that it moved out with the
// content module, so a content-OFF kernel-only install has no such table.
// B4a-news-posts-ownership gives content its own grant.
const KERNEL_PORTAL_TABLES = [
  'calendar_events',
  'event_recurrence',
  'org_units',
  'protocols',
  'protocol_resolutions',
  'resolution_challenges',
]

describe('058 public-reader grants', () => {
  it('055 sorts strictly before 058 — 058 requires resolution_challenges', () => {
    const list = sorted()
    expect(list.indexOf('055_resolution_challenges.sql')).toBeGreaterThanOrEqual(0)
    expect(list.indexOf('055_resolution_challenges.sql')).toBeLessThan(
      list.indexOf('058_public_reader_grants.sql'),
    )
  })

  it('portal_tables is exactly the kernel-guaranteed set', () => {
    const body = executable('058_public_reader_grants.sql')
    const block = body.match(/portal_tables CONSTANT text\[\] := ARRAY\[([^\]]*)\]/)
    expect(block, 'portal_tables ARRAY literal not found').not.toBeNull()
    const names = [...block![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort()
    expect(names).toEqual([...KERNEL_PORTAL_TABLES].sort())
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
