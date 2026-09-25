// TDD 6 — the TRD-426 scan: no tenant database connection outside the package.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error — a plain .mjs script, no declarations
import { checkTenantDbAccess, countSites, parseAllowList } from '../../scripts/check-tenant-db-access.mjs'

const SCRIPT = fileURLToPath(new URL('../../scripts/check-tenant-db-access.mjs', import.meta.url))
const FIXTURE = fileURLToPath(new URL('../fixtures/scan/', import.meta.url))
const FIXTURE_ALLOW = join(FIXTURE, 'allow.json')

type Result = { scanned: number; sites: { path: string }[]; problems: string[] }
const check = (o: { root: string; allowList: string }) => checkTenantDbAccess(o) as Result

const tmp: string[] = []
afterEach(() => tmp.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))
function scratchRoot(files: Record<string, string>) {
  const d = mkdtempSync(join(tmpdir(), 't020-scan-'))
  tmp.push(d)
  for (const [p, t] of Object.entries(files)) {
    mkdirSync(join(d, p, '..'), { recursive: true })
    writeFileSync(join(d, p), t)
  }
  return d
}
function allowList(rows: object[]) {
  const d = mkdtempSync(join(tmpdir(), 't020-allow-'))
  tmp.push(d)
  const p = join(d, 'allow.json')
  writeFileSync(p, JSON.stringify({ rows }))
  return p
}
const row = (path: string, calls: number, imports: number) => ({ path, calls, imports, adoptedBy: 'TASK-077', since: '2026-09-25', reason: 'a test row with a reason' })

describe('check-tenant-db-access (TRD-426)', () => {
  it('the real tree is green: every site outside the package is on the dated allow-list', () => {
    const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' })
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/OK — \d{3,} file\(s\) scanned/)
  })

  it('RED fixture: the seeded postgres(url) in services/x.ts fails, naming the file (CLI exit 1)', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--root', FIXTURE, '--allow-list', FIXTURE_ALLOW], { encoding: 'utf8' })
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/services\/x\.ts: opens a database connection outside @gremion\/tenant-store/)
    expect(r.stderr).not.toMatch(/allowed\/y\.ts/)
  })

  it('allow-listed sites pass', () => {
    const root = scratchRoot({ 'allowed/y.ts': 'import postgres from "postgres"\nexport const s = postgres(u)\n' })
    expect(check({ root, allowList: allowList([row('allowed/y.ts', 1, 1)]) }).problems).toEqual([])
  })

  it('a stale row fails: the file is gone, or no longer opens a connection', () => {
    const root = scratchRoot({ 'a.ts': 'export const x = 1\n' })
    const p = check({ root, allowList: allowList([row('a.ts', 1, 0), row('gone.ts', 1, 0)]) }).problems
    expect(p).toEqual([
      expect.stringMatching(/^a\.ts: stale allow-list row — the file no longer opens a connection/),
      expect.stringMatching(/^gone\.ts: stale allow-list row — the file is gone/),
    ])
  })

  it('a NEW site in an allow-listed file fails; a row with too many fails as stale', () => {
    const root = scratchRoot({ 'a.ts': 'postgres(a)\npostgres(b)\n', 'b.ts': 'createDb(p)\n' })
    const p = check({ root, allowList: allowList([row('a.ts', 1, 0), row('b.ts', 2, 0)]) }).problems
    expect(p.join('\n')).toMatch(/a\.ts: .* has 2 \/ 0 — a NEW site/)
    expect(p.join('\n')).toMatch(/b\.ts: .* has 1 \/ 0 — update the row \(stale\)/)
  })

  it('zero files scanned fails (a vacuous scan is not a pass)', () => {
    const root = scratchRoot({ 'README.md': 'postgres(url)\n' })
    expect(check({ root, allowList: allowList([]) }).problems).toEqual([expect.stringMatching(/scanned zero files/)])
  })

  it('does not miss .mjs, .cjs, .js, .svelte, .mts, .cts or .tsx', () => {
    const exts = ['mjs', 'cjs', 'js', 'svelte', 'mts', 'cts', 'tsx']
    const root = scratchRoot(Object.fromEntries(exts.map((e) => [`s/x.${e}`, 'const c = new Pool({})\n'])))
    const r = check({ root, allowList: allowList([]) })
    expect(r.scanned).toBe(exts.length)
    expect(r.sites.map((s) => s.path).sort()).toEqual(exts.map((e) => `s/x.${e}`).sort())
  })

  it('catches an aliased driver (import pg from "postgres"; pg(url)) through the import', () => {
    expect(countSites("import pg from 'postgres'\nconst sql = pg(url)\n")).toEqual({ calls: 0, imports: 1 })
    expect(countSites("const pg = require('pg')\n")).toEqual({ calls: 0, imports: 1 })
    expect(countSites("const m = await import('postgres')\n")).toEqual({ calls: 0, imports: 1 })
    expect(countSites("import * as pg from 'pg'\n")).toEqual({ calls: 0, imports: 1 })
    expect(countSites("import {\n  Client,\n} from 'pg'\nnew Client()\n")).toEqual({ calls: 1, imports: 1 })
    expect(countSites("export { default } from 'postgres'\n")).toEqual({ calls: 0, imports: 1 })
  })

  it('does not count type-only imports or comments, and a comment cannot hide code after it', () => {
    expect(countSites("import type { Sql } from 'postgres'\nimport { type Sql as S } from 'postgres'\n")).toEqual({ calls: 0, imports: 0 })
    expect(countSites("type T = import('@gremion/db').Sql\nlet p: import('postgres').Options<{}>\n")).toEqual({ calls: 0, imports: 0 })
    expect(countSites('// postgres(url)\n/*\n postgres(url)\n*/\n * not a jsdoc: postgres(a)\n')).toEqual({ calls: 1, imports: 0 })
    expect(countSites('/* x */ postgres(url)\nconst a = 1 // postgres(b)\n')).toEqual({ calls: 1, imports: 0 })
  })

  it('a /* or // inside a string starts no comment and hides nothing (security review M2)', () => {
    expect(countSites('const t = `\n/* not a comment\n`\npostgres(url)\nconst e = "*/"\n')).toEqual({ calls: 1, imports: 0 })
    expect(countSites("const u = 'http://x'; postgres(url)\n")).toEqual({ calls: 1, imports: 0 })
    expect(countSites('const s = "a\\"//"; postgres(url)\n')).toEqual({ calls: 1, imports: 0 })
  })

  it('a // or /* inside a regex literal starts no comment and hides nothing (round-2 review HIGH)', () => {
    expect(countSites('const re = /\\/\\//; const s = postgres(url)\n')).toEqual({ calls: 1, imports: 0 })
    expect(countSites("if (/https?:\\/\\//.test(u)) mk(u); import { createDb as mk } from '@gremion/db'\n")).toEqual({ calls: 0, imports: 1 })
    expect(countSites('const re = /[/*]/\npostgres(a)\n/** doc */\n')).toEqual({ calls: 1, imports: 0 })
    // division is not a regex: a comment after it is still a comment
    expect(countSites('const x = a / b // postgres(c)\n')).toEqual({ calls: 0, imports: 0 })
    expect(countSites('return /x/.test(s) && postgres(u)\n')).toEqual({ calls: 1, imports: 0 })
  })

  it('catches the factory module imported by a relative path', () => {
    expect(countSites("import { createDb as mk } from '../../packages/db/src/client.js'\n")).toEqual({ calls: 0, imports: 1 })
  })

  it('catches the factory under another name (security review M1)', () => {
    expect(countSites("import { createDb as mk } from '@gremion/db'\nmk({ url })\n")).toEqual({ calls: 0, imports: 1 })
    expect(countSites("import * as db from '@gremion/db'\ndb['createDb'](p)\n")).toEqual({ calls: 1, imports: 1 })
    expect(countSites("import db from '@gremion/db'\n")).toEqual({ calls: 0, imports: 1 })
    expect(countSites("export { createDb as makeDb } from '@gremion/db'\n")).toEqual({ calls: 0, imports: 1 })
    expect(countSites("export * from '@gremion/db'\n")).toEqual({ calls: 0, imports: 1 })
    expect(countSites('const f = createDb.bind(null)\n')).toEqual({ calls: 1, imports: 0 })
    expect(countSites("const { createDb: mk } = await import('@gremion/db')\n")).toEqual({ calls: 0, imports: 1 })
    // the types and a non-factory value from @gremion/db are not a site
    expect(countSites("import { type DbProfile, type Sql } from '@gremion/db'\nimport { committeeSchema } from '@gremion/db'\n")).toEqual({ calls: 0, imports: 0 })
  })

  it('catches driver subpaths, pg-pool / pg-native, and backtick-quoted requires (security review L1)', () => {
    expect(countSites("import p from 'postgres/cjs/src/index.js'\n")).toEqual({ calls: 0, imports: 1 })
    expect(countSites("import Pool from 'pg-pool'\nconst n = require('pg-native')\n")).toEqual({ calls: 0, imports: 2 })
    expect(countSites('const pg = require(`postgres`)\n')).toEqual({ calls: 0, imports: 1 })
  })

  it('refuses malformed allow-list rows: no task, no date, a glob, a traversal, a rule-allowed path, a duplicate', () => {
    const { problems } = parseAllowList({
      rows: [
        { ...row('a.ts', 1, 0), adoptedBy: 'later' },
        { ...row('b.ts', 1, 0), since: 'soon' },
        row('src/**/*.ts', 1, 0),
        row('../outside.ts', 1, 0),
        row('packages/tenant-store/src/x.ts', 1, 0),
        row('c.ts', 0, 0),
        row('d.ts', 1, 0),
        row('d.ts', 1, 0),
      ],
    }) as { problems: string[] }
    expect(problems.join('\n')).toMatch(/a\.ts.*adoptedBy/)
    expect(problems.join('\n')).toMatch(/b\.ts.*since/)
    expect(problems.join('\n')).toMatch(/\*\*.*one exact/)
    expect(problems.join('\n')).toMatch(/outside\.ts.*one exact/)
    expect(problems.join('\n')).toMatch(/tenant-store.*by rule/)
    expect(problems.join('\n')).toMatch(/c\.ts.*allowing nothing/)
    expect(problems.join('\n')).toMatch(/d\.ts.*duplicate/)
  })

  it('the package itself is allowed by rule, and so is the @gremion/db factory', () => {
    const root = scratchRoot({ 'packages/tenant-store/src/a.ts': 'postgres(u)\n', 'packages/db/src/client.ts': 'postgres(u)\n', 'packages/other/a.ts': 'postgres(u)\n' })
    expect(check({ root, allowList: allowList([]) }).problems).toEqual([expect.stringMatching(/^packages\/other\/a\.ts/)])
  })

  it('dropping one real allow-list row turns the real tree RED', () => {
    const real = JSON.parse(readFileSync(join(SCRIPT, '../tenant-db-access.allow.json'), 'utf8')) as { rows: { path: string }[] }
    expect(real.rows.length).toBeGreaterThan(0)
    const dropped = allowList(real.rows.slice(1))
    const p = check({ root: fileURLToPath(new URL('../../../../', import.meta.url)), allowList: dropped }).problems
    expect(p).toEqual([expect.stringMatching(new RegExp(`^${real.rows[0]!.path.replaceAll('.', '\\.')}: opens a database connection`))])
  })
})

