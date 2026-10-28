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
