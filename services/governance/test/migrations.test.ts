// TASK-084-a Task 4: the governance chain's first migration as shipped (no
// database): the plumbing prefix is byte-0, the lint finds exactly the one
// waived REVOKE, the chain class is fresh-only. The database half is
// packages/tenant-store test/t084/gov-migration.test.ts.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkPlumbingMigration, checkPlumbingText, plumbingSql, PlumbingDriftError } from '@gremion/events'
import { describe, expect, it } from 'vitest'
import { lintSql } from '../../../scripts/migrations/runner/lint.mjs'

const SERVICE_ROOT = fileURLToPath(new URL('../', import.meta.url))
const REPO = join(SERVICE_ROOT, '..', '..')
const DIR = join(SERVICE_ROOT, 'migrations')
const FILE = join(DIR, '0001_gov_setup.sql')
const text = () => readFileSync(FILE, 'utf8')

describe('governance migrations: the shipped chain', () => {
  it('exactly one file, 0001_gov_setup.sql', () => {
    expect(readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort()).toEqual(['0001_gov_setup.sql'])
  })

  it("plumbingSql('gov') is the byte-0 prefix; a prefix off byte 0 is refused", () => {
    expect(() => checkPlumbingMigration(FILE, 'gov')).not.toThrow()
    expect(text().startsWith(plumbingSql('gov'))).toBe(true)
    expect(text().split('\n')[0]).toBe('-- gremion:phase expand')
    expect(() => checkPlumbingText(`-- moved\n${text()}`, 'gov')).toThrow(PlumbingDriftError)
  })

  it('everything after the plumbing prefix is ASCII', () => {
    const t = text()
    expect(t.slice(plumbingSql('gov').length).split('').filter((c) => c.charCodeAt(0) > 127)).toEqual([])
  })

  // Recorded waiver of the plan's "ASCII only in SQL" rule: the prefix is plumbingSql('gov') byte for byte
  // (TASK-079 owns it; editing it here is STOP gate 2), and its comments carry the section sign three times.
  // Pinned exactly: a fourth non-ASCII character, or one outside the prefix, fails.
  it("waiver: the only non-ASCII characters are the three section signs inside the byte-exact plumbingSql('gov') prefix", () => {
    const prefix = plumbingSql('gov')
    const nonAscii = (s: string) => s.split('').filter((c) => c.charCodeAt(0) > 127)
    expect(nonAscii(prefix)).toEqual(['§', '§', '§'])
    expect(nonAscii(text())).toEqual(nonAscii(prefix))
  })

  it('the lint finds exactly one problem, rule revoke (the REVOKE EXECUTE ... FROM PUBLIC of remove_test_run)', () => {
    const r = lintSql(text()) as { problems: { rule: string; message: string }[] }
    expect(r.problems.map((p) => p.rule)).toEqual(['revoke'])
    expect(r.problems[0]?.message).toContain('remove_test_run')
  })

  it('the manifest names the file with its sha256', async () => {
    const { createHash } = await import('node:crypto')
    const m = JSON.parse(readFileSync(join(DIR, 'manifest.json'), 'utf8')) as Record<string, string>
    expect(m).toEqual({ '0001_gov_setup.sql': createHash('sha256').update(readFileSync(FILE)).digest('hex') })
  })

  it('the chain class is fresh-only (no manual-dump marker, no dump)', () => {
    const c = JSON.parse(readFileSync(join(REPO, 'scripts', 'migrations', 'runner', 'chain-runners.json'), 'utf8')) as { chains: Record<string, string> }
    expect(c.chains.governance).toBe('fresh-only')
  })
})
