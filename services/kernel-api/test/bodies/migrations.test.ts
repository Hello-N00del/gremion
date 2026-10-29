// TASK-080-a, file set 1: the two bodies migrations as shipped (guards 1 and 2
// of the plan: a second touch_row is refused by the lint, a plumbing prefix off
// byte 0 is refused by checkPlumbingMigration), the SCHEMA anchors, and the
// register wiring (manifest dirs).
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkPlumbingMigration, checkPlumbingText, plumbingSql, PlumbingDriftError } from '@gremion/events'
import { describe, expect, it } from 'vitest'
import { createdRoutineNames, lintSql } from '../../../../scripts/migrations/runner/lint.mjs'
import { assertShippedMigrations } from '../../src/migrate/boot-check.ts'
import { KERNEL_API_MIGRATION_DIRS } from '../../src/migrate/chain.ts'

const SERVICE_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BODIES = join(SERVICE_ROOT, 'migrations', 'bodies')
const CORE = join(SERVICE_ROOT, 'migrations', 'core')
const F1 = join(BODIES, '0002_idt_plumbing_structure.sql')
const F2 = join(BODIES, '0003_idt_person_membership_tenure.sql')
const text = (f: string) => readFileSync(f, 'utf8')

interface Problem { statement: number; rule: string; message: string }
const lint = (sql: string, prior: Set<string>): { problems: Problem[] } => lintSql(sql, { priorRoutines: prior })

/** The routines created by the files before `upTo` in chain order (core, then bodies). */
function priorRoutines(upTo: string): Set<string> {
  const prior = new Set<string>()
  for (const dir of [CORE, BODIES]) {
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
      const full = join(dir, f)
      if (full === upTo) return prior
      for (const n of createdRoutineNames(text(full)) as Set<string>) prior.add(n)
    }
  }
  return prior
}

describe('migrations/bodies: the shipped files', () => {
  it('exactly two files, numbered 0002 and 0003 after 077 core 0001 (register claim)', () => {
    expect(readdirSync(BODIES).filter((f) => f.endsWith('.sql')).sort()).toEqual(['0002_idt_plumbing_structure.sql', '0003_idt_person_membership_tenure.sql'])
  })

  it("plumbingSql('idt') is the byte-0 prefix of file 1 (checkPlumbingMigration)", () => {
    expect(() => checkPlumbingMigration(F1, 'idt')).not.toThrow()
    expect(text(F1).startsWith(plumbingSql('idt'))).toBe(true)
  })

  it('a prefix off byte 0 is refused: a leading comment, and a one-byte drift (guard 2)', () => {
    expect(() => checkPlumbingText(`-- moved\n${text(F1)}`, 'idt')).toThrow(PlumbingDriftError)
    const drift = text(F1).replace("SET lock_timeout = '5s'", "SET lock_timeout = '6s'")
    expect(drift).not.toBe(text(F1))
    expect(() => checkPlumbingText(drift, 'idt')).toThrow(PlumbingDriftError)
  })

  it('both files lint with zero problems against the chain so far (G3 expand phase, lock_timeout, new routines only)', () => {
    expect(lint(text(F1), priorRoutines(F1)).problems).toEqual([])
    expect(lint(text(F2), priorRoutines(F2)).problems).toEqual([])
  })

  it('a second touch_row anywhere in the chain is refused as function-or-view-not-new (guard 1)', () => {
    const seeded = `${text(F2)}\nCREATE FUNCTION idt.touch_row() RETURNS trigger LANGUAGE plpgsql AS $b$ BEGIN RETURN NEW; END $b$;\n`
    const problems = lint(seeded, priorRoutines(F2)).problems
    expect(problems.map((p) => p.rule)).toContain('function-or-view-not-new')
    // and 0001's own refuse_update cannot be redefined by file 1 either
    const again = `${text(F1)}\nCREATE FUNCTION idt.refuse_update() RETURNS trigger LANGUAGE plpgsql AS $b$ BEGIN RETURN NEW; END $b$;\n`
    expect(lint(again, priorRoutines(F1)).problems.map((p) => p.rule)).toContain('function-or-view-not-new')
  })

  it('the chain defines each routine once: refuse_delete, refuse_truncate, kind guard, acyclic x2, membership_derive (+ the prefix pair)', () => {
    const names: string[] = []
    for (const f of [join(CORE, '0001_idt_setup.sql'), F1, F2]) names.push(...(createdRoutineNames(text(f)) as Set<string>))
    expect(names.sort()).toEqual(['body_acyclic', 'current_customer_id', 'membership_derive', 'org_unit_acyclic', 'org_unit_kind_guard', 'refuse_delete', 'refuse_truncate', 'refuse_update', 'touch_row'].map((n) => `idt.${n}`).sort())
  })

  it('skipped aggregates stay skipped (081, 130, 081, 084, 042): no role, capability, correction, grant, import, idp, branding table', () => {
    const all = `${text(F1)}\n${text(F2)}`
    const tables = [...all.matchAll(/CREATE TABLE (idt\.[a-z_]+)/g)].map((m) => m[1]).sort()
    expect(tables).toEqual([
      'idt.applied_aggregate_version', 'idt.body', 'idt.customer_setting', 'idt.database_binding', 'idt.inbox', 'idt.job', 'idt.membership', 'idt.org_unit',
      'idt.org_unit_kind', 'idt.outbox', 'idt.person', 'idt.preference', 'idt.seat', 'idt.tenure', 'idt.wahlperiode',
    ])
  })

  it('seat.conferred_role_key has NO foreign key (idt.role is TASK-081, Q3); the EXCLUDE constraints and RLS FORCE are in', () => {
    const all = text(F1) + text(F2)
    expect(all).not.toMatch(/REFERENCES idt\.role/)
    expect(all).toMatch(/membership_person_id_body_id_unit_kind_validity_excl EXCLUDE USING gist/)
    expect(all).toMatch(/tenure_seat_id_starts_on_ended_on_excl EXCLUDE USING gist/)
    for (const t of ['org_unit_kind', 'body', 'org_unit', 'seat', 'person', 'wahlperiode', 'membership', 'tenure', 'customer_setting', 'preference']) {
      expect(all).toContain(`ALTER TABLE idt.${t} FORCE ROW LEVEL SECURITY;`)
    }
  })
})

describe('the chain wiring', () => {
  it('KERNEL_API_MIGRATION_DIRS = core + bodies, and every shipped file matches its manifest (TRD-353)', () => {
    expect([...KERNEL_API_MIGRATION_DIRS]).toEqual(['migrations/core', 'migrations/bodies'])
    expect(assertShippedMigrations(KERNEL_API_MIGRATION_DIRS.map((d) => join(SERVICE_ROOT, d)))).toBe(3)
  })

  it('an edited bodies file refuses the boot (manifest hash)', () => {
    const copy = mkdtempSync(join(tmpdir(), 't080-boot-'))
    try {
      cpSync(BODIES, copy, { recursive: true })
      writeFileSync(join(copy, '0003_idt_person_membership_tenure.sql'), `${text(F2)}\n-- tampered\n`)
      expect(() => assertShippedMigrations([copy])).toThrow(/HASH_MISMATCH 0003/)
    } finally {
      rmSync(copy, { recursive: true, force: true })
    }
  })
})
