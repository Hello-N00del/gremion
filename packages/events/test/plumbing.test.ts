// TDD 2 (unit half): the plumbing renders lint-clean for every context and a
// byte of drift is caught. The DB half (migrate through the runner, the prose
// CHECK, RLS) runs in test/live/events.live.test.ts against a real Postgres.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, expect, test } from 'vitest'
import { checkPlumbingMigration, checkPlumbingText, PlumbingDriftError, plumbingSql } from '../src/plumbing.ts'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const lint = (await import(pathToFileURL(path.join(ROOT, 'scripts/migrations/runner/lint.mjs')).href)) as {
  lintSql: (text: string) => { phase: string | null; problems: { statement: number; rule: string; message: string }[] }
}
const rules = (text: string) => lint.lintSql(text).problems.map((p) => p.rule)

describe('plumbingSql renders lint-clean (TRD-361 expand lint, TASK-075)', () => {
  for (const ctx of ['idt', 'gov', 'fin', 'mail']) {
    test(`${ctx}: zero lint problems, phase expand`, () => {
      const res = lint.lintSql(plumbingSql(ctx))
      expect(res.phase).toBe('expand')
      expect(res.problems).toEqual([])
    })
  }

  test('the SCHEMA §0.6 statements the lint refuses are RED (DO block, REVOKE)', () => {
    const verbatim = readFileSync(path.join(import.meta.dirname, 'fixtures/schema-verbatim.sql'), 'utf8')
    const got = rules(verbatim)
    expect(got).toContain('do-block')
    expect(got).toContain('revoke')
  })

  test('the template carries no ledger table, no database-level setting and no REVOKE', () => {
    const t = readFileSync(path.join(import.meta.dirname, '../sql/plumbing.sql'), 'utf8')
    expect(t).not.toMatch(/schema_migration/i)
    expect(t).not.toMatch(/ALTER\s+DATABASE/i)
    expect(t).not.toMatch(/\bREVOKE\b/i)
    expect(t).not.toMatch(/\bDO\s+\$\$/i)
  })

  test('outbox.event_id and job.job_id keep DEFAULT uuidv7() (the lint admits it inside CREATE TABLE)', () => {
    const t = plumbingSql('gov')
    expect(t).toMatch(/event_id\s+uuid\s+NOT NULL DEFAULT uuidv7\(\)/)
    expect(t).toMatch(/job_id\s+uuid\s+NOT NULL DEFAULT uuidv7\(\)/)
    expect(t).toContain('CHECK (uuid_extract_version(event_id) = 7)')
  })

  test('RLS is explicit for all four tables: 12 statements, tenant policy names kept', () => {
    const t = plumbingSql('idt')
    for (const tbl of ['outbox', 'inbox', 'applied_aggregate_version', 'job']) {
      expect(t).toContain(`ALTER TABLE idt.${tbl} ENABLE ROW LEVEL SECURITY;`)
      expect(t).toContain(`ALTER TABLE idt.${tbl} FORCE ROW LEVEL SECURITY;`)
      expect(t).toContain(`CREATE POLICY ${tbl}_tenant_pol ON idt.${tbl}`)
    }
  })
})

describe('template variables are exact', () => {
  test('the idt render has no gov. qualifier and no GOV id left; the literal context list keeps gov', () => {
    const t = plumbingSql('idt')
    expect(t).not.toMatch(/\bgov\./)
    expect(t).not.toMatch(/GOV/)
    expect(t).not.toMatch(/\{\{/)
    // A naive global replace of the shipped context would damage the CHECK list.
    expect(t).toContain("context_code IN ('idt', 'gov', 'brd', 'cal',")
    expect(t).toContain("'DB-IDT-OUTBOX | K1 | rp-idt-plumbing |")
    expect(t).toContain('CREATE TABLE idt.outbox (')
  })

  test('the gov render uses its own schema, ids and profile', () => {
    const t = plumbingSql('gov')
    expect(t).toContain('CREATE SCHEMA IF NOT EXISTS gov;')
    expect(t).toContain("'DB-GOV-INBOX | K1 | rp-gov-plumbing |")
    expect(t).toContain('FUNCTION gov.current_customer_id()')
  })

  test.each(['', 'x', 'GOV', 'gov1', 'idt; DROP', 'toolong'])('refuses the context code %j', (bad) => {
    expect(() => plumbingSql(bad)).toThrow(/context code/)
  })
})

describe('checkPlumbingMigration (the byte-0 prefix rule)', () => {
  // Scratch under the package (git-ignored .scratch/), never the system temp directory.
  const dir = path.join(import.meta.dirname, '../.scratch', `plumbing-${process.pid}`)
  mkdirSync(dir, { recursive: true })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const write = (name: string, text: string) => {
    const f = path.join(dir, name)
    writeFileSync(f, text)
    return f
  }

  test('the block plus the service own statements passes', () => {
    const f = write('ok.sql', `${plumbingSql('idt')}\nCREATE TABLE idt.person (person_id uuid PRIMARY KEY);\n`)
    expect(() => checkPlumbingMigration(f, 'idt')).not.toThrow()
  })

  test('a one-byte drift is RED, naming the offset', () => {
    const drifted = plumbingSql('idt').replace('lock_timeout = \'5s\'', 'lock_timeout = \'6s\'')
    const f = write('drift.sql', drifted)
    expect(() => checkPlumbingMigration(f, 'idt')).toThrow(PlumbingDriftError)
    try {
      checkPlumbingText(drifted, 'idt')
    } catch (e) {
      expect((e as PlumbingDriftError).offset).toBe(plumbingSql('idt').indexOf("'5s'") + 1)
    }
  })

  test('anything before the block is RED (not the byte-0 prefix)', () => {
    expect(() => checkPlumbingText(`-- a note\n${plumbingSql('idt')}`, 'idt')).toThrow(PlumbingDriftError)
  })

  test('a block rendered for another context is RED', () => {
    expect(() => checkPlumbingText(plumbingSql('gov'), 'idt')).toThrow(PlumbingDriftError)
  })

  test('a truncated block is RED', () => {
    expect(() => checkPlumbingText(plumbingSql('idt').slice(0, -10), 'idt')).toThrow(/inside the idt plumbing block/)
  })
})
