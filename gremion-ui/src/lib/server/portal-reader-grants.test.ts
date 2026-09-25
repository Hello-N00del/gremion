// B4a-news-posts-ownership — 058_public_reader_grants.sql grants ONLY tables the
// kernel data-plane chain itself produces, and names the content-owned owner of
// news_posts.
//
// SEAM: B4-migrations-portback-nine ports 058 and drops 'news_posts' from
// portal_tables during the port. The kernel's 008_public_portal.sql:4-6 records
// that news_posts moved out with the calendar/news modules during the carve, so
// the kernel creates no such table and the unedited array would abort a
// kernel-only fresh init. news_posts + its grant live in the content module's
// 1200_content_news_posts.sql (spec B §2/§4). This file is the STANDING guard
// that the entry cannot come back and that 058's prose names the new owner.
//
// Pure: filesystem reads only, no Postgres. The DB-backed companion is
// portal-reader-grants.integration.test.ts.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// process.cwd() during `pnpm test:unit` is the gremion-ui package root — the same
// anchor db.ts uses for migrations/ (db.ts:180).
const MIGRATIONS_DIR = join(process.cwd(), 'migrations')
const GRANTS_FILE = '058_public_reader_grants.sql'

/**
 * Every table name the kernel data-plane chain produces.
 * Two shapes, because 010_org_units.sql:6 produces org_units with
 * `ALTER TABLE committees RENAME TO org_units`, not a CREATE TABLE.
 */
function tablesProducedByKernelChain(): Set<string> {
  const produced = new Set<string>()
  for (const f of readdirSync(MIGRATIONS_DIR).filter((n) => n.endsWith('.sql'))) {
    const text = readFileSync(join(MIGRATIONS_DIR, f), 'utf-8')
    for (const m of text.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi)) {
      produced.add(m[1].toLowerCase())
    }
    for (const m of text.matchAll(/ALTER\s+TABLE\s+[a-z_][a-z0-9_]*\s+RENAME\s+TO\s+([a-z_][a-z0-9_]*)/gi)) {
      produced.add(m[1].toLowerCase())
    }
  }
  return produced
}

/** The literal entries of 058's `portal_tables CONSTANT text[] := ARRAY[...]`. */
function portalTables(): string[] {
  const text = readFileSync(join(MIGRATIONS_DIR, GRANTS_FILE), 'utf-8')
  const block = /portal_tables\s+CONSTANT\s+text\[\]\s*:=\s*ARRAY\[([^\]]*)\]/i.exec(text)
  if (!block) throw new Error(`${GRANTS_FILE}: no portal_tables ARRAY[...] literal found`)
  return [...block[1].matchAll(/'([a-z_][a-z0-9_]*)'/g)].map((m) => m[1])
}

/** A migration's body with `--` line comments stripped, i.e. what Postgres executes. */
function executableLines(text: string): string {
  return text
    .split('\n')
    .map((l) => l.replace(/--.*$/, ''))
    .join('\n')
}

describe('058_public_reader_grants.sql — kernel-guaranteed tables only (B4a)', () => {
  it('grants only tables the kernel chain itself produces', () => {
    const produced = tablesProducedByKernelChain()
    const ungranted = portalTables().filter((t) => !produced.has(t))
    expect(ungranted).toEqual([])
  })

  it('does not name news_posts — that table is content-owned (1200_content_news_posts.sql)', () => {
    expect(portalTables()).not.toContain('news_posts')
  })

  it('still names resolution_challenges, the 055→058 ordering anchor', () => {
    expect(portalTables()).toContain('resolution_challenges')
  })

  it('still aborts loudly: one RAISE EXCEPTION for the role, one for missing tables', () => {
    const text = readFileSync(join(MIGRATIONS_DIR, GRANTS_FILE), 'utf-8')
    expect(text.match(/RAISE\s+EXCEPTION/gi) ?? []).toHaveLength(2)
    expect(text).toContain('refuses to grant a partial set and report success')
  })

  it('names the content-owned owner of news_posts in the header and in the abort message', () => {
    const text = readFileSync(join(MIGRATIONS_DIR, GRANTS_FILE), 'utf-8')
    // Both halves: the header block that explains the split, and the runtime
    // message an operator actually sees when the chain aborts.
    expect(text.match(/1200_content_news_posts\.sql/g) ?? []).toHaveLength(3)
    // 008 no longer belongs in the missing-table message: it creates none of the six.
    const abort = /RAISE EXCEPTION\s+'the anonymous public portal reads[\s\S]*?array_to_string/.exec(text)
    expect(abort, 'missing-table RAISE EXCEPTION not found').not.toBeNull()
    expect(abort![0]).not.toContain('008_public_portal.sql')
  })

  it('no executable line in the kernel chain names the retired stura_public_reader role', () => {
    const offenders = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .filter((f) =>
        executableLines(readFileSync(join(MIGRATIONS_DIR, f), 'utf-8')).includes('stura_public_reader'),
      )
    expect(offenders, 'kernel 008:20 creates gremion_public_reader, not stura_public_reader').toEqual([])
  })
})
