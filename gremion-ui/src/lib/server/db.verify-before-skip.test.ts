// TASK-029 G5 (TRD-353, brief Q5): runMigrations() verifies EVERY file in
// migrations/ against manifest.json -- applied, seed-skipped and
// module-skipped files included -- BEFORE the applied-skip. Before G5 the
// check ran only for a file about to be applied (db.ts `if (applied.has(file))
// continue` came first), so a tampered manifest entry or a swapped file for an
// ALREADY-APPLIED migration booted clean (RED A).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const state = vi.hoisted(() => ({ applied: [] as string[], ran: [] as string[], env: {} as Record<string, string> }))

vi.mock('$env/dynamic/private', () => ({ env: state.env }))
vi.mock('$lib/server/tenant/context', () => ({ requireTenant: () => ({ slug: 't029' }) }))
vi.mock('$lib/server/config', () => ({ readConfig: () => ({}) }))
vi.mock('$lib/modules/registry', () => ({ MODULE_MANIFESTS: [] }))
vi.mock('$lib/modules/migration-ownership', () => ({ backFillNotice: () => null }))
vi.mock('$lib/server/module-migrations', () => ({
  disabledModuleMigrationFiles: () => new Set<string>(),
  moduleReenableCatchup: () => [],
}))
vi.mock('$lib/server/db/pool-registry', () => {
  const sql = Object.assign(
    async (strings: TemplateStringsArray) => {
      const q = strings.join('?')
      if (q.includes('SELECT filename FROM schema_migrations')) return state.applied.map((filename) => ({ filename }))
      return []
    },
    {
      begin: async (cb: (tx: unknown) => Promise<void>) => {
        const buffered: string[] = []
        const tx = Object.assign(
          async (_s: TemplateStringsArray, ...values: unknown[]) => {
            buffered.push(String(values[0]))
            return []
          },
          { unsafe: async () => [] },
        )
        await cb(tx)
        state.ran.push(...buffered)
      },
    },
  )
  return { getPoolForTenant: () => sql }
})

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
let root: string
let cwd: ReturnType<typeof vi.spyOn>

function chain(files: Record<string, string>, manifestOverride: Record<string, string> = {}) {
  const dir = join(root, 'migrations')
  mkdirSync(dir, { recursive: true })
  const manifest: Record<string, string> = {}
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), body)
    manifest[name] = sha(body)
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ...manifest, ...manifestOverride }))
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 't029-g5-'))
  cwd = vi.spyOn(process, 'cwd').mockReturnValue(root)
  state.applied = []
  state.ran = []
  for (const k of Object.keys(state.env)) delete state.env[k]
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  cwd.mockRestore()
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

describe('runMigrations verifies every file before the applied-skip (G5)', () => {
  it('RED A: a tampered manifest entry for an APPLIED file refuses the run, naming the file, and applies nothing', async () => {
    chain({ '0001_a.sql': 'select 1;\n', '0002_b.sql': 'select 2;\n' }, { '0001_a.sql': sha('tampered') })
    state.applied = ['0001_a.sql']
    const { runMigrations } = await import('./db')
    await expect(runMigrations()).rejects.toThrow(/0001_a\.sql tampered/)
    expect(state.ran).toEqual([])
  })

  it('an applied file whose bytes were swapped (manifest kept) refuses the run', async () => {
    chain({ '0001_a.sql': 'select 1;\n' })
    writeFileSync(join(root, 'migrations', '0001_a.sql'), 'drop table users;\n')
    state.applied = ['0001_a.sql']
    const { runMigrations } = await import('./db')
    await expect(runMigrations()).rejects.toThrow(/0001_a\.sql tampered/)
  })

  it('a seed file skipped under GREMION_DISABLE_SEEDS is verified too', async () => {
    chain({ '0001_a.sql': 'select 1;\n', '0005_dev_seed.sql': 'insert;\n' }, { '0005_dev_seed.sql': sha('x') })
    state.env.GREMION_DISABLE_SEEDS = 'true'
    const { runMigrations } = await import('./db')
    await expect(runMigrations()).rejects.toThrow(/0005_dev_seed\.sql tampered/)
    expect(state.ran).toEqual([])
  })

  it('a clean chain applies only the pending files, in order', async () => {
    chain({ '0001_a.sql': 'select 1;\n', '0002_b.sql': 'select 2;\n', '0003_c.sql': 'select 3;\n' })
    state.applied = ['0001_a.sql']
    const { runMigrations } = await import('./db')
    await runMigrations()
    expect(state.ran).toEqual(['0002_b.sql', '0003_c.sql'])
  })
})
