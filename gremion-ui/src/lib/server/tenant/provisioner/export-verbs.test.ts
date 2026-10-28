// TRD-149/150/151: the export verbs' argument handling and the completeness
// check's exit code. The database half is packages/tenant-store/test/integration/export.test.ts.
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EXPORT_VERBS, exportVerb, retireReaders, type ExportVerbContext } from '../../../../../scripts/tenant-provision-export'

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

  it('HIGH-1: every connection AS the export reader goes through connectExportReader (search_path pinned, no type fetch); the admin helper is never used for a reader', () => {
    const src = readFileSync(join(process.cwd(), 'scripts', 'tenant-provision-export.ts'), 'utf8')
    expect(src).toContain('p.assign(connectReader(')
    expect(src).toContain('connectExportReader(url)')
    expect(src).not.toContain('p.assign(connect(')
  })

  it('MED: a module database still enabling or disabling fails the export naming the module, before any reader is opened', async () => {
    for (const state of ['enabling', 'disabling']) {
      const base = ctx(['acme'], { '--out': '/x' })
      const rows = [{ module_key: 'finance', state }]
      const c: ExportVerbContext = {
        ...base,
        customerIdForSlug: async () => '11111111-1111-1111-1111-111111111111',
        openPlatform: () => Object.assign(async () => rows, { end: async () => undefined }) as never,
        catalogue: () =>
          [{ id: 'finance', moduleJson: { runtime: { export: { kind: 'pg_dump', retentionProfile: 'rp-fin-module-data' }, database: { postgresService: 'finance-postgres' } } } }] as never,
        kernelUrl: () => {
          throw new Error('a connection was attempted')
        },
        moduleUrl: () => {
          throw new Error('a connection was attempted')
        },
      }
      await expect(exportVerb('export', c)).rejects.toThrow(new RegExp(`finance.*${state}`))
    }
  })

  it('LOW: a reader that could not be retired makes the verb fail (exit 1), the others are still retired', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const seen: unknown[] = []
    const a = { id: 'a' }
    const b = { id: 'b' }
    await retireReaders([a, b] as never, async (admin: unknown) => {
      seen.push(admin)
      if (admin === a) throw new Error('connection refused')
    })
    expect(seen).toEqual([a, b])
    expect(process.exitCode).toBe(1)
    expect(err.mock.calls.flat().join(' ')).toMatch(/not retired.*connection refused/)
    process.exitCode = undefined
    await retireReaders([b] as never, async () => undefined)
    expect(process.exitCode).toBeUndefined()
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
