// src/lib/server/tenant/control-migrations.verify.test.ts
// F1-FIX-02-K (K1#7 / K1#37): the control-plane runner must verify EVERY
// migrations-control file against the SHA-256 manifest BEFORE its applied-skip
// and before any file runs -- the data-plane runner's TASK-029 G5 rule
// (db.ts runMigrations). Checking only the file about to be applied let a file
// swapped AFTER it was applied boot clean, and let a tampered applied file sit
// in front of a pending one that then ran.
//
// No database: getControlDb is a scripted ledger, and `fs.readFileSync` swaps
// the bytes of ONE real migrations-control file while `tamper` is set (the
// committed manifest.json is read untouched). A throw here fails boot: boot()
// awaits runControlMigrations, and hooks.boot.test.ts pins that a control-plane
// failure is a process-wide boot failure.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readdirSync } from 'fs'
import { join } from 'path'

const state = vi.hoisted(() => ({
  tamper: null as string | null,
  applied: [] as string[],
  executed: [] as string[],
}))

vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>()
  const readFileSync = ((p: unknown, ...rest: unknown[]) => {
    const text = (real.readFileSync as (...a: unknown[]) => unknown)(p, ...rest)
    if (state.tamper && typeof p === 'string' && p.endsWith(state.tamper)) {
      return `${String(text)}\n-- swapped after it was applied\nDROP TABLE tenant;\n`
    }
    return text
  }) as typeof real.readFileSync
  return { ...real, default: { ...real, readFileSync }, readFileSync }
})

function ledgerSql() {
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = strings.join('?')
    if (/WHERE filename = \?/.test(q)) {
      return Promise.resolve(state.applied.includes(String(values[0])) ? [{ '?column?': 1 }] : [])
    }
    if (/SELECT filename FROM schema_migrations/.test(q)) {
      return Promise.resolve(state.applied.map((filename) => ({ filename })))
    }
    return Promise.resolve([])
  }
  const sql = tag as unknown as Record<string, unknown>
  sql.begin = async (cb: (tx: unknown) => Promise<unknown>) => {
    const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      if (strings.join('?').includes('INSERT INTO schema_migrations')) state.executed.push(String(values[0]))
      return Promise.resolve([])
    }) as unknown as Record<string, unknown>
    tx.unsafe = async () => []
    return cb(tx)
  }
  return sql
}

vi.mock('./control-db', () => ({ getControlDb: () => ledgerSql() }))

const CONTROL_FILES = readdirSync(join(process.cwd(), 'migrations-control'))
  .filter((f) => f.endsWith('.sql'))
  .sort()

beforeEach(() => {
  state.tamper = null
  state.applied = []
  state.executed = []
})

describe('runControlMigrations verifies every file before the applied-skip (K1#7, K1#37)', () => {
  it('a fully applied, untouched chain runs nothing and passes', async () => {
    const { runControlMigrations } = await import('./control-migrations')
    state.applied = [...CONTROL_FILES]
    await expect(runControlMigrations()).resolves.toBeUndefined()
    expect(state.executed).toEqual([])
  })

  it('an APPLIED file whose bytes changed after it was applied fails the run (and therefore boot)', async () => {
    const { runControlMigrations } = await import('./control-migrations')
    expect(CONTROL_FILES.length).toBeGreaterThanOrEqual(3)
    state.applied = [...CONTROL_FILES]
    state.tamper = CONTROL_FILES[2]!
    await expect(runControlMigrations()).rejects.toThrow(new RegExp(`${CONTROL_FILES[2]!.replace('.', '\\.')} tampered`))
    expect(state.executed).toEqual([])
  })

  it('a tampered applied file in front of a pending one stops the run before the pending file executes', async () => {
    const { runControlMigrations } = await import('./control-migrations')
    state.applied = CONTROL_FILES.slice(0, 2)
    state.tamper = CONTROL_FILES[0]!
    await expect(runControlMigrations()).rejects.toThrow(/tampered/)
    expect(state.executed).toEqual([])
  })

  it('pending files still apply in order once every file verifies', async () => {
    const { runControlMigrations } = await import('./control-migrations')
    state.applied = CONTROL_FILES.slice(0, 2)
    await expect(runControlMigrations()).resolves.toBeUndefined()
    expect(state.executed).toEqual(CONTROL_FILES.slice(2))
  })
})
