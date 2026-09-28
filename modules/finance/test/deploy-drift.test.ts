/**
 * Migration manifest drift test — finance leaf service.
 *
 * Asserts every *.sql in services/finance/migrations/ is represented in
 * manifest.json with the correct SHA-256 (kernel-side hash-lock parity, G-012),
 * and pins the two structural slice-2 invariants of 001_finance_init.sql:
 *   1. it recreates the `finance` schema + its core tables, and
 *   2. it OMITS the 3 public.org_units RESTRICT FKs (finance_unit / project /
 *      inventory_item) — the leaf DB does not own org_units — with an inline
 *      slice-3 pointer.
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = path.resolve(__dirname, '../migrations')
const MANIFEST_PATH = path.join(MIGRATIONS_DIR, 'manifest.json')

function sha256hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

/** Strip SQL comments (-- line, /* block *​/) so negative assertions test the
 *  ACTIVE DDL, not the explanatory comments that quote the omitted FK / the
 *  dropped approval_request table. */
function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--.*$/gm, '')
}

describe('finance migrations — manifest drift', () => {
  it('manifest.json exists', () => {
    expect(
      fs.existsSync(MANIFEST_PATH),
      `${MANIFEST_PATH} does not exist — run: pnpm --filter finance-service build:manifest`,
    ).toBe(true)
  })

  it('every *.sql file in migrations/ is listed in manifest.json with the correct sha256', () => {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8')) as Record<string, string>
    const sqlFiles = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
    expect(sqlFiles.length, 'expected at least one *.sql migration').toBeGreaterThan(0)
    for (const file of sqlFiles) {
      const buf = fs.readFileSync(path.join(MIGRATIONS_DIR, file))
      expect(manifest[file], `${file} missing from manifest.json`).toBeDefined()
      expect(sha256hex(buf), `${file} sha256 mismatch — file edited after manifest generated`).toBe(manifest[file])
    }
  })

  it('manifest.json contains no entries for files that no longer exist', () => {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8')) as Record<string, string>
    const sqlFiles = new Set(fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')))
    for (const key of Object.keys(manifest)) {
      expect(sqlFiles.has(key), `manifest references ${key} but the file is gone`).toBe(true)
    }
  })

  it('001_finance_init.sql recreates the finance schema + core tables', () => {
    const initSql = path.join(MIGRATIONS_DIR, '001_finance_init.sql')
    expect(fs.existsSync(initSql), '001_finance_init.sql is missing').toBe(true)
    const sql = fs.readFileSync(initSql, 'utf-8')
    expect(sql).toContain('CREATE SCHEMA IF NOT EXISTS finance')
    for (const t of [
      'finance.finanzordnung_profile', 'finance.finance_unit', 'finance.bank_account',
      'finance.ledger_account', 'finance.bank_transaction', 'finance.fiscal_year',
      'finance.budget_plan', 'finance.budget_titel', 'finance.project', 'finance.expense',
      'finance.receipt', 'finance.booking', 'finance.payment_order', 'finance.approval',
      'finance.approval_stage', 'finance.inventory_item', 'finance.discharge', 'finance.comment',
    ]) {
      expect(sql, `missing table ${t}`).toContain(t)
    }
    // 028 replaced approval_request with approval + approval_stage — the squash
    // must NOT recreate the dropped table (check the ACTIVE DDL, not comments).
    expect(stripSqlComments(sql)).not.toContain('finance.approval_request')
  })

  it('001_finance_init.sql OMITS the 3 org_units RESTRICT FKs (finance_unit/project/inventory_item)', () => {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, '001_finance_init.sql'), 'utf-8')
    // The leaf DB does not own org_units — no FK to it may exist in the DDL.
    expect(stripSqlComments(sql)).not.toMatch(/REFERENCES\s+org_units/i)
    // The three columns remain (as plain UUID), each tagged with a slice-3 pointer.
    const slice3Markers = sql.match(/SLICE-3:/g) ?? []
    expect(slice3Markers.length).toBeGreaterThanOrEqual(3)
    expect(sql).toMatch(/org_unit_id\s+UUID\s+NOT NULL\s+UNIQUE,/) // finance_unit
  })
})
