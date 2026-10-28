// TRD-144/TRD-145 (purge runner), unit half: the rule table is the machine form of
// docs/compliance/retention-catalogue.md and may not drift from it. No database.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dbWindowDays, parseLogRows } from '@gremion/retention'
import { describe, expect, it } from 'vitest'
import { PURGE_DEADLINE_MS, PURGE_RESIDUAL, PURGE_RULES, deleteBatchSql, purgeCutoff, refusalOf, type PurgeTableShape } from './purge.js'

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
    if (rule.windowFrom) {
      // a window that follows a LOG class row is derived by the registry's one rule (no second copy of the figure)
      const logRow = parseLogRows(CATALOGUE.replace(/\r\n/g, '\n')).find((r) => r.row === rule.windowFrom)
      expect(logRow, `${rule.windowFrom} states regular / cap days`).toBeDefined()
      expect(rule.windowDays, `${rule.id}: min(regular ${logRow!.regularDays}, cap ${logRow!.capDays} - one daily tick)`).toBe(dbWindowDays(logRow!))
    } else {
      expect(windowDaysOf(source!)).toContain(rule.windowDays)
    }
    expect(Number.isInteger(rule.windowDays) && rule.windowDays > 0).toBe(true)
  })

  it('plt.job_run purges at 29 d: the catalogue cap is 30 d and the run is daily, so 30 d would outlive the cap by up to a day', () => {
    const jobRun = PURGE_RULES.find((r) => r.id === 'RC-OPS-RUN/plt.job_run')
    expect(jobRun?.windowDays).toBe(29)
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

describe('the tenant-code refusal (defence in depth under the purger login)', () => {
  const kernelRules = PURGE_RULES.filter((r) => r.scope === 'kernel')
  const on = (table: string) => `(?:public\\.)?"?${table}"?\\b`

  it.each(kernelRules.map((r) => [r.id, r] as const))('%s: kernelTriggers is exactly what the kernel migrations create; no policy, rule, RLS or foreign key into it', (_id, rule) => {
    expect(rule.kernelTriggers, `${rule.id} states its kernel triggers`).toBeDefined()
    const triggers = [...KERNEL_SQL.matchAll(new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:CONSTRAINT\\s+)?TRIGGER\\s+"?(\\w+)"?[^;]*?\\bON\\s+${on(rule.table)}`, 'gi'))].map((m) => m[1])
    const byName = (a: string | undefined, b: string | undefined) => String(a).localeCompare(String(b))
    expect(triggers.sort(byName)).toEqual([...rule.kernelTriggers!].sort(byName))
    expect(KERNEL_SQL).not.toMatch(new RegExp(`CREATE\\s+POLICY[^;]*\\bON\\s+${on(rule.table)}`, 'i'))
    expect(KERNEL_SQL).not.toMatch(new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?RULE[^;]*\\bTO\\s+${on(rule.table)}`, 'i'))
    expect(KERNEL_SQL).not.toMatch(new RegExp(`ALTER\\s+TABLE\\s+(?:ONLY\\s+)?${on(rule.table)}[^;]*ROW\\s+LEVEL\\s+SECURITY`, 'i'))
    expect(KERNEL_SQL).not.toMatch(new RegExp(`REFERENCES\\s+${on(rule.table)}`, 'i'))
  })

  it('the trigger scan finds a trigger the kernel does create (audit_log, 0043), so an empty list is a real finding', () => {
    const m = [...KERNEL_SQL.matchAll(new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:CONSTRAINT\\s+)?TRIGGER\\s+"?(\\w+)"?[^;]*?\\bON\\s+${on('audit_log')}`, 'gi'))].map((x) => x[1])
    expect(m).toContain('audit_log_hash_chain_trg')
  })

  const plain: PurgeTableShape = { kind: 'r', children: 0, rls: false, granted: true, triggers: [], policies: [], rules: [], referencedBy: [] }
  const ec = kernelRules.find((r) => r.table === 'event_consumption')!

  it('a plain, granted table with no tenant code is not refused', () => {
    expect(refusalOf(ec, plain)).toBeNull()
  })
  it.each([
    ['a trigger the kernel does not create', { triggers: ['esc'] }, /trigger esc/],
    ['row-level security', { rls: true }, /row-level security/],
    ['a policy', { policies: ['p'] }, /policy p/],
    ['a rewrite rule', { rules: ['r'] }, /rewrite rule r/],
    ['a foreign key into it (ON DELETE CASCADE runs the referencing table\'s triggers)', { referencedBy: ['fk'] }, /foreign key fk/],
    ['a child table (DELETE without ONLY would reach it)', { children: 1 }, /child table/],
    ['a view in its place', { kind: 'v' }, /not a plain table/],
    ['a missing grant', { granted: false }, /lacks SELECT, DELETE/],
  ] as const)('refuses %s', (_what, patch, msg) => {
    expect(refusalOf(ec, { ...plain, ...patch })).toMatch(msg)
  })

  it('the batch SQL is ONLY (no child table) and schema-qualifies what name resolution could shadow', () => {
    for (const r of PURGE_RULES) {
      const sql = deleteBatchSql(r)
      expect(sql).toMatch(/DELETE FROM ONLY /)
      expect(sql).toMatch(/SELECT ctid FROM ONLY /)
      expect(sql).toContain('pg_catalog.count(*)')
      expect(sql).toContain('$1::pg_catalog.timestamptz')
    }
  })

  it('the deadline leaves room inside the unit\'s TimeoutStartSec (purge.bats checks the sum with the lock wait)', () => {
    expect(PURGE_DEADLINE_MS).toBeGreaterThan(0)
    expect(PURGE_DEADLINE_MS).toBeLessThanOrEqual(120_000)
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

describe('platform migration 0012', () => {
  it('bounds its locks with SET LOCAL lock_timeout: the runner applies each file in its own BEGIN/COMMIT, a session SET would outlive it', () => {
    const sql = readFileSync(join(REPO, 'packages/tenant-store/src/lifecycle/platform-migrations/0012_plt_purge_run.sql'), 'utf8')
    expect(sql).toMatch(/^SET LOCAL lock_timeout = '5s';$/m)
    expect(sql).not.toMatch(/^SET lock_timeout/m)
  })
})
