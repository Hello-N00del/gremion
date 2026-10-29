// Unit: the export's file names (MED-1). The database half is test/integration/export.test.ts.
import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportTenant, ExportError, fileSafeName, fileStem } from './export.js'

describe('a module in a transitional state (MED)', () => {
  const exportable = { kind: 'pg_dump', retentionProfile: 'rp-fin-module-data' }
  it.each(['enabling', 'disabling'])('fails the export naming the module, before anything is read or written (%s)', async (state) => {
    const parent = mkdtempSync(join(tmpdir(), 'trd149-trans-'))
    const out = join(parent, 'out')
    try {
      const modules = [{ id: 'finance', runtimeExport: exportable, enabled: false, transitional: state }]
      const err = await exportTenant({ slug: 'acme', outDir: out, kernel: {} as never, modules }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(ExportError)
      expect((err as Error).message).toMatch(new RegExp(`finance.*${state}`))
      expect(existsSync(out)).toBe(false)
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('does not trouble a module that declares no export', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'trd149-trans-'))
    try {
      // reaches the kernel read (the fake connection throws there), i.e. it got past the transitional check
      const err = await exportTenant({ slug: 'acme', outDir: join(parent, 'out'), kernel: {} as never, modules: [{ id: 'files', runtimeExport: null, enabled: false, transitional: 'disabling' }] }).catch((e: unknown) => e)
      expect(err).not.toBeInstanceOf(ExportError)
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })
})

describe('export file names (MED-1)', () => {
  it('keep [a-z0-9_] and encode every other byte, so no name is a path', () => {
    expect(fileSafeName('org_units')).toBe('org_units')
    expect(fileSafeName('Members')).toBe('-4dembers')
    expect(fileSafeName('../../../escaped')).toBe('-2e-2e-2f-2e-2e-2f-2e-2e-2fescaped')
    expect(fileSafeName('ä')).toBe('-c3-a4')
    for (const n of ['../x', 'a/b', '.', '..', 'A B', 'x\u0000y']) expect(fileSafeName(n)).toMatch(/^[a-z0-9_-]+$/)
  })

  it('public tables are <table>, others <schema>.<table>; distinct names stay distinct; overlong names fall back to a hash', () => {
    expect(fileStem('public', 'invoices')).toBe('invoices')
    expect(fileStem('finance', 'receipt')).toBe('finance.receipt')
    expect(fileStem('public', 'A')).not.toBe(fileStem('public', 'a'))
    const long = fileStem('S'.repeat(63), 'T'.repeat(63))
    expect(long.length).toBeLessThanOrEqual(200)
    expect(long).toMatch(/^[a-z0-9_-]+-h[0-9a-f]{16}$/)
    expect(long).not.toBe(fileStem('S'.repeat(63), 'T'.repeat(62) + 'U'))
  })
})

// Linux customer proof: KERNEL_EXPORT_TABLES still named committee_groups (dropped in 0010) and
// committee_members (renamed to org_unit_members in 0010), so every export of a real customer failed
// "table public.committee_groups does not exist". The list must name only tables the kernel chain
// (gremion-ui/migrations, in file order) leaves in place.
describe('KERNEL_EXPORT_TABLES matches the kernel migration chain', () => {
  it('names only tables that exist after the last kernel migration', async () => {
    const { readdirSync, readFileSync } = await import('node:fs')
    const { KERNEL_EXPORT_TABLES, KERNEL_EXCLUDED_TABLES } = await import('./export.js')
    const dir = join(__dirname, '..', '..', '..', '..', 'gremion-ui', 'migrations')
    const tables = new Set<string>()
    const ident = '"?([a-z_][a-z0-9_]*)"?'
    for (const f of readdirSync(dir).filter((n) => /^\d{4}_.*\.sql$/.test(n)).sort()) {
      const sql = readFileSync(join(dir, f), 'utf-8').replace(/--[^\n]*/g, '')
      const re = new RegExp(
        `CREATE TABLE (?:IF NOT EXISTS )?(?:public\.)?${ident}|ALTER TABLE (?:IF EXISTS )?(?:ONLY )?(?:public\.)?${ident} RENAME TO ${ident}|DROP TABLE (?:IF EXISTS )?((?:(?:public\.)?"?[a-z_][a-z0-9_]*"?\s*,\s*)*(?:public\.)?"?[a-z_][a-z0-9_]*"?)`,
        'gi',
      )
      for (const m of sql.matchAll(re)) {
        if (m[1]) tables.add(m[1].toLowerCase())
        else if (m[2] && m[3]) {
          tables.delete(m[2].toLowerCase())
          tables.add(m[3].toLowerCase())
        } else if (m[4]) for (const t of m[4].split(',')) tables.delete(t.trim().replace(/^public\./i, '').replace(/"/g, '').toLowerCase())
      }
    }
    expect(tables.size, 'the migration scan found the kernel tables').toBeGreaterThan(10)
    const missing = [...KERNEL_EXPORT_TABLES, ...KERNEL_EXCLUDED_TABLES.map((t) => t.table)].filter((t) => !tables.has(t))
    expect(missing).toEqual([])
    expect(KERNEL_EXPORT_TABLES).toContain('org_unit_members')
  })
})
