// Unit: the export's file names (MED-1). The database half is test/integration/export.test.ts.
import { describe, expect, it } from 'vitest'
import { fileSafeName, fileStem } from './export.js'

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
