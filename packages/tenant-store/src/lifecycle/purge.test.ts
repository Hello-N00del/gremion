// TRD-144/TRD-145 (purge runner), unit half: the rule table is the machine form of
// docs/compliance/retention-catalogue.md and may not drift from it. No database.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PURGE_RESIDUAL, PURGE_RULES, deleteBatchSql, purgeCutoff } from './purge.js'

const REPO = fileURLToPath(new URL('../../../../', import.meta.url))
const CATALOGUE = readFileSync(join(REPO, 'docs/compliance/retention-catalogue.md'), 'utf8')
const rowLine = (id: string) => CATALOGUE.split('\n').find((l) => l.startsWith(`| ${id} `))

function migrationsText(dir: string): string {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => readFileSync(join(dir, f), 'utf8'))
    .join('\n')
}
const KERNEL_SQL = migrationsText(join(REPO, 'gremion-ui/migrations'))
const PLATFORM_SQL = migrationsText(join(REPO, 'packages/tenant-store/src/lifecycle/platform-migrations'))

/** The `**N days**` / `**N d / ...**` figures a catalogue row states, in days. */
function windowDaysOf(line: string): number[] {
  return [...line.matchAll(/\*\*(\d+) (?:days|d)\b/g)].map((m) => Number(m[1]))
}

describe('PURGE_RULES against the retention catalogue', () => {
  it('covers two kernel tables and the platform job log (the categories with a window AND a table)', () => {
    expect(PURGE_RULES.map((r) => `${r.scope}:${r.table}`).sort()).toEqual([
      'kernel:event_consumption',
      'kernel:scheduled_notifications',
      'platform:plt.job_run',
    ])
  })

  it.each(PURGE_RULES.map((r) => [r.id, r] as const))('%s: its window is the one the catalogue row states', (_id, rule) => {
    const line = rowLine(rule.catalogueRow)
    expect(line, `${rule.catalogueRow} is a row of the catalogue`).toBeDefined()
    // RC-OPS-RUN says "with RC-LOG-APP": the window is that row's regular window
    const source = rule.windowFrom ? rowLine(rule.windowFrom) : line
    expect(source, `${rule.windowFrom ?? rule.catalogueRow} is a row of the catalogue`).toBeDefined()
    expect(windowDaysOf(source!)).toContain(rule.windowDays)
    expect(Number.isInteger(rule.windowDays) && rule.windowDays > 0).toBe(true)
  })

  it.each(PURGE_RULES.map((r) => [r.id, r] as const))('%s: its table and columns exist in the migrations of its scope', (_id, rule) => {
    const sql = rule.scope === 'kernel' ? KERNEL_SQL : PLATFORM_SQL
    const create = new RegExp(`CREATE TABLE (?:IF NOT EXISTS )?${rule.table.replace('.', '\\.')}\\s*\\(([\\s\\S]*?)\\n\\);`).exec(sql)
    expect(create, `CREATE TABLE ${rule.table}`).not.toBeNull()
    for (const col of rule.columns) expect(create![1], `${rule.table}.${col}`).toMatch(new RegExp(`^\\s*${col}\\s`, 'm'))
  })

  it('rule ids are unique, identifiers are plain, and the SQL never embeds the window or a date', () => {
    expect(new Set(PURGE_RULES.map((r) => r.id)).size).toBe(PURGE_RULES.length)
    for (const r of PURGE_RULES) {
      expect(r.table).toMatch(/^(plt\.)?[a-z_]+$/)
      for (const c of r.columns) expect(c).toMatch(/^[a-z_]+$/)
      const sql = deleteBatchSql(r)
      expect(sql).toContain(r.table)
      expect(sql).toContain('$1')
      expect(sql).not.toMatch(new RegExp(`\\b${r.windowDays}\\b`))
    }
  })

  it('every residual names a catalogue row, and none of them is also a rule', () => {
    expect(PURGE_RESIDUAL.length).toBeGreaterThan(5)
    const ruleRows = new Set(PURGE_RULES.map((r) => r.catalogueRow))
    for (const res of PURGE_RESIDUAL) {
      expect(rowLine(res.catalogueRow), res.catalogueRow).toBeDefined()
      expect(res.reason.length).toBeGreaterThan(10)
      expect(ruleRows.has(res.catalogueRow) && !res.partOf, `${res.catalogueRow} is a rule and a whole-row residual`).toBe(false)
    }
  })
})

describe('purgeCutoff', () => {
  it('is exactly windowDays x 24 h before now, in UTC', () => {
    const now = new Date('2026-10-27T12:00:00.000Z')
    expect(purgeCutoff(now, 7).toISOString()).toBe('2026-10-20T12:00:00.000Z')
    expect(purgeCutoff(now, 30).toISOString()).toBe('2026-09-27T12:00:00.000Z')
  })
  it('refuses a window that is not a positive whole number of days (a window with no derivation is not applied)', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => purgeCutoff(new Date(), bad)).toThrow(/window/)
  })
})
