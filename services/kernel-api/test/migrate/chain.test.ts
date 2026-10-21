// The kernel-api chain as this image ships it: the dirs it applies and gates
// on equal the register's manifestDirs (TASK-029 ranges.json, G9), 0001 is
// what the TASK-080 Q2 amendment says (C8), the boot refuses an altered
// shipped file and boots once it is restored (TDD 18 first half, TRD-353), and
// the migrate CLI's usage / environment refusals (Q10).
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { assertShippedMigrations, ShippedMigrationsError } from '../../src/migrate/boot-check.ts'
import { KERNEL_API_CHAIN, KERNEL_API_LEDGER, KERNEL_API_MIGRATION_DIRS } from '../../src/migrate/chain.ts'
import { runMigrateCli } from '../../src/migrate/cli.ts'
import { MigrateError, migrateKernelDb, setRoleHook } from '../../src/migrate/migrate.ts'

const SERVICE_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const KERNEL_ROOT = join(SERVICE_ROOT, '..', '..')
const DIRS = KERNEL_API_MIGRATION_DIRS.map((d) => join(SERVICE_ROOT, d))
const register = JSON.parse(readFileSync(join(KERNEL_ROOT, 'scripts', 'migrations', 'ranges.json'), 'utf8')) as { chains: Array<{ id: string; database: string; dirs: string[]; manifestDirs?: string[] }> }
const runners = JSON.parse(readFileSync(join(KERNEL_ROOT, 'scripts', 'migrations', 'runner', 'chain-runners.json'), 'utf8')) as { chains: Record<string, string> }

describe('the kernel-api chain (G9, G10)', () => {
  const chain = register.chains.find((c) => c.id === KERNEL_API_CHAIN)!

  it("KERNEL_API_MIGRATION_DIRS equal the register's manifestDirs (both grow together, TASK-080/081)", () => {
    expect(chain.manifestDirs?.map((d) => d.replace(/^services\/kernel-api\//, ''))).toEqual([...KERNEL_API_MIGRATION_DIRS])
    for (const d of chain.manifestDirs ?? []) expect(chain.dirs).toContain(d)
  })

  it('the chain database stays service:kernel-api (Q2 "kernel" rejected, C9) and its class is tenant-store (G10)', () => {
    expect(chain.database).toBe('service:kernel-api')
    expect(runners.chains[KERNEL_API_CHAIN]).toBe('tenant-store')
    expect(KERNEL_API_LEDGER).toBe('idt.schema_migration')
  })

  it('0001_idt_setup: expand, lock_timeout, schema idt, idt.refuse_update -- and NO touch_row, REVOKE, DO or ALTER DATABASE (C8)', () => {
    const sql = readFileSync(join(SERVICE_ROOT, 'migrations', 'core', '0001_idt_setup.sql'), 'utf8')
    const body = sql.split('\n').filter((l) => !l.startsWith('--')).join('\n')
    expect(sql.split('\n')[0]).toBe('-- gremion:phase expand')
    expect(body).toMatch(/SET lock_timeout/)
    expect(body).toMatch(/CREATE SCHEMA IF NOT EXISTS idt;/)
    expect(body).toMatch(/CREATE FUNCTION idt\.refuse_update\(\)/)
    expect(body).not.toMatch(/touch_row|REVOKE|\bDO\b|ALTER DATABASE|OR REPLACE/i)
  })
})

describe('TRD-353 boot check (TDD 18, Q18)', () => {
  it('the shipped files match their manifest: boots', () => {
    expect(assertShippedMigrations(DIRS)).toBeGreaterThanOrEqual(1)
  })

  it('an altered shipped file refuses the boot; restored, it boots', () => {
    const copy = mkdtempSync(join(tmpdir(), 't077-boot-'))
    try {
      cpSync(DIRS[0]!, copy, { recursive: true })
      const file = join(copy, '0001_idt_setup.sql')
      const original = readFileSync(file)
      writeFileSync(file, Buffer.concat([original, Buffer.from('\n-- tampered\n')]))
      expect(() => assertShippedMigrations([copy])).toThrow(ShippedMigrationsError)
      expect(() => assertShippedMigrations([copy])).toThrow(/HASH_MISMATCH 0001_idt_setup\.sql/)
      writeFileSync(file, original)
      expect(assertShippedMigrations([copy])).toBe(1)
    } finally {
      rmSync(copy, { recursive: true, force: true })
    }
  })
})

describe('kernel-api migrate: refusals before any database (Q10)', () => {
  const io = () => ({ lines: [] as string[], out(l: string) { this.lines.push(l) }, err(l: string) { this.lines.push(l) } })
  const roots = { dirs: DIRS, kernelRoot: KERNEL_ROOT }

  it('usage errors are exit 2', async () => {
    for (const argv of [['migrate', '--customer'], ['migrate', '--all'], ['migrate', 'x', 'y']]) {
      const o = io()
      expect(await runMigrateCli(argv, {}, o, roots)).toBe(2)
      expect(o.lines.join()).toMatch(/usage: kernel-api migrate/)
    }
  })

  it('a missing environment is exit 1, naming every variable, nothing opened', async () => {
    const o = io()
    let opened = 0
    expect(await runMigrateCli(['migrate'], {}, o, roots, { openControl: () => (opened++, {} as never) })).toBe(1)
    expect(o.lines.join()).toMatch(/KERNEL_API_CONTROL_DB_URL, GREMION_KERNEL_PG_DIRECT_URL, GREMION_RELEASE_REF not set/)
    expect(opened).toBe(0)
  })

  it('a malformed customer id is refused before the control registry is read', async () => {
    let read = 0
    const control = (() => (read++, Promise.resolve([]))) as never
    await expect(migrateKernelDb('nope', { control, resolveSecret: () => '', directBase: '', dirs: DIRS, kernelRoot: KERNEL_ROOT, releaseRef: 'dist-v1.0.0', dumpDir: undefined, log: () => {}, audit: () => {} })).rejects.toBeInstanceOf(MigrateError)
    expect(read).toBe(0)
  })

  it('setRoleHook refuses anything but a k_<hex32>_owner role name', () => {
    expect(() => setRoleHook('postgres')).toThrow(/refusing owner role/)
    expect(() => setRoleHook('k_0192f0c12b3c7d4e8f001122334455aa_owner"; DROP')).toThrow()
    expect(typeof setRoleHook('k_0192f0c12b3c7d4e8f001122334455aa_owner')).toBe('function')
  })
})
