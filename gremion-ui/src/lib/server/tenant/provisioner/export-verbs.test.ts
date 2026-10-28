// TRD-149/150/151: the export verbs' argument handling and the completeness
// check's exit code. The database half is packages/tenant-store/test/integration/export.test.ts.
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EXPORT_VERBS, exportVerb, type ExportVerbContext } from '../../../../../scripts/tenant-provision-export'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  process.exitCode = undefined
  vi.restoreAllMocks()
})

function ctx(positional: (string | undefined)[], flags: Record<string, string> = {}): ExportVerbContext {
  return {
    catalogue: () => [],
    customerIdForSlug: async () => null,
    openPlatform: () => {
      throw new Error('no database in this test')
    },
    kernelUrl: () => 'postgres://x',
    moduleUrl: () => 'postgres://x',
    reqFlag: (n) => {
      const v = flags[n]
      if (!v) throw new Error(`${n} is required`)
      return v
    },
    positional: (i = 0) => positional[i],
    usage: (m) => new Error(`USAGE ${m}`),
    log: () => {},
  }
}

function exportDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'trd149-'))
  dirs.push(dir)
  mkdirSync(join(dir, 'kernel'))
  const body = 'id\r\n1\r\n'
  writeFileSync(join(dir, 'kernel', 'org_units.csv'), body)
  const files = [{ path: 'kernel/org_units.csv', scope: 'kernel', table: 'org_units', format: 'csv', rows: 1, bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') }]
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ schema_version: 1, tenant: { slug: 'acme' }, generated_at: 'x', files, modules: [], excluded_systems: [], excluded_tables: [] }))
  return dir
}

describe('export verbs', () => {
  it('are the two dispatcher verbs', () => {
    expect([...EXPORT_VERBS].sort()).toEqual(['export', 'export-verify'])
  })

  it('export refuses a missing or malformed slug and a missing --out, before any connection', async () => {
    await expect(exportVerb('export', ctx([undefined], { '--out': '/x' }))).rejects.toThrow(/USAGE export requires a valid <slug>/)
    await expect(exportVerb('export', ctx(['Bad Slug'], { '--out': '/x' }))).rejects.toThrow(/USAGE/)
    await expect(exportVerb('export', ctx(['acme']))).rejects.toThrow(/--out is required/)
    await expect(exportVerb('export', ctx(['nobody'], { '--out': '/x' }))).rejects.toThrow(/no customer with slug nobody/)
  })

  it('export-verify needs a directory, passes a complete export, and fails naming the deleted file', async () => {
    await expect(exportVerb('export-verify', ctx([undefined]))).rejects.toThrow(/requires <dir>/)
    const dir = exportDir()
    await exportVerb('export-verify', ctx([dir]))
    expect(process.exitCode).toBeUndefined()
    rmSync(join(dir, 'kernel', 'org_units.csv'))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    await exportVerb('export-verify', ctx([dir]))
    expect(process.exitCode).toBe(1)
    expect(err.mock.calls.flat().join('\n')).toContain('MISSING kernel/org_units.csv')
  })
})
