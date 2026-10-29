// Unit: the completeness check reads the CSV row count back too (LOW).
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { csvRecordCount, verifyExport } from './verify.js'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function exportWith(csv: string, rows: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'trd151-'))
  dirs.push(dir)
  mkdirSync(join(dir, 'kernel'))
  writeFileSync(join(dir, 'kernel', 't.csv'), csv)
  const files = [{ path: 'kernel/t.csv', scope: 'kernel', table: 't', format: 'csv', rows, bytes: Buffer.byteLength(csv), sha256: createHash('sha256').update(csv).digest('hex') }]
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ schema_version: 1, tenant: { slug: 'acme' }, generated_at: 'x', files, modules: [], excluded_systems: [], excluded_tables: [] }))
  return dir
}

describe('verifyExport CSV rows', () => {
  it('counts RFC 4180 records (quoted CRLF and quotes inside a field are one record)', () => {
    expect(csvRecordCount('id\r\n')).toBe(1)
    expect(csvRecordCount('id,n\r\n1,"a\r\nb"\r\n2,"say ""x"""\r\n')).toBe(3)
  })

  it('passes a CSV whose data rows match the manifest, and fails one that does not', () => {
    expect(verifyExport(exportWith('id,n\r\n1,"a\r\nb"\r\n2,x\r\n', 2)).ok).toBe(true)
    const r = verifyExport(exportWith('id,n\r\n1,x\r\n', 2))
    expect(r.problems).toEqual([{ path: 'kernel/t.csv', code: 'ROWCOUNT_MISMATCH', detail: '1 rows in the file, 2 in the manifest' }])
  })
})
