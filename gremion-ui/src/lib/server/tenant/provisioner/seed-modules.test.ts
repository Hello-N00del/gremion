// D-8 (pilot wave 2, task 3): a vertical seed asks for a Matrix room / a Nextcloud folder per unit only when
// the PLATFORM enabled messaging / files for the customer. The flags come from the platform's enabled module
// keys (catalogue ids), not from cfg.modules: both manifests are toggleable and default on, so cfg.modules
// said true for every tenant whether or not the platform had enabled the module, and the catalogue id
// `messaging` is the manifest id `messages`.
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { seedModulesFor } from './seed-modules'

const readConfig = vi.fn(() => {
  throw new Error('the seed verb must not read cfg.modules')
})
vi.mock('$lib/server/config', () => ({ readConfig: () => readConfig() }))

const seedVertical = vi.fn(async (..._args: unknown[]) => ({
  units: { created: 0, adopted: 0, present: 0 },
  kinds: { upserted: 0 },
  seats: { created: 0 },
  terms_written: false,
}))
vi.mock('$lib/server/tenant/provisioner/member-import-adapters', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./member-import-adapters')>()),
  seedVertical: (...args: unknown[]) => seedVertical(...args),
  sqlOrgStore: () => ({}),
}))
vi.mock('$lib/server/tenant/provisioner/customer-adapters', () => ({
  inActiveContext: async (_c: unknown, fn: () => Promise<unknown>) => fn(),
}))
vi.mock('$lib/server/tenant/registry', () => ({
  getTenantById: async () => ({ slug: 'acme' }),
  configPathForTenant: (slug: string) => `/tmp/${slug}/config.json`,
}))

const { importVerb } = await import('../../../../../scripts/tenant-provision-import')

describe('seedModulesFor: catalogue ids to the planner flags', () => {
  it('messaging and files enabled: both flags true', () => {
    expect(seedModulesFor(['messaging', 'files'])).toEqual({ messaging: true, files: true })
  })

  it('nothing enabled: both false', () => {
    expect(seedModulesFor([])).toEqual({ messaging: false, files: false })
  })

  it('each flag follows its own module only', () => {
    expect(seedModulesFor(['messaging'])).toEqual({ messaging: true, files: false })
    expect(seedModulesFor(['files'])).toEqual({ messaging: false, files: true })
  })

  it('reads the catalogue id messaging, not the manifest id messages', () => {
    expect(seedModulesFor(['messages'])).toEqual({ messaging: false, files: false })
  })

  it('other enabled modules change nothing', () => {
    expect(seedModulesFor(['calendar', 'votes', 'content', 'publishing'])).toEqual({ messaging: false, files: false })
  })
})

const FIXTURE = join(process.cwd(), '..', 'packages', 'member-import', 'test', 'fixtures', 'verticals', 'fixture')
const tmp: string[] = []
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true })
  delete process.env.GREMION_VERTICALS_DIR
  process.exitCode = 0
  vi.clearAllMocks()
})

function runSeed(enabled: string[]) {
  const root = mkdtempSync(join(tmpdir(), 'verticals-'))
  tmp.push(root)
  cpSync(FIXTURE, join(root, 'fixture'), { recursive: true })
  process.env.GREMION_VERTICALS_DIR = root
  const modules = { enabled: vi.fn(async () => enabled) }
  const deps = {
    control: { getBySlug: async () => ({ id: 'c-1', slug: 'acme', status: 'active', realm: 'acme', host: 'acme.example.test' }) },
    modules,
  }
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  const ctx = {
    withLive: async (_opts: unknown, fn: (d: unknown) => Promise<unknown>) => fn(deps),
    provisionerKc: vi.fn(),
    writeConfigFile: vi.fn(),
    readStdin: vi.fn(() => ''),
    flag: () => undefined,
    reqFlag: (n: string) => (n === '--vertical' ? 'fixture' : (() => { throw new Error(`${n} is required`) })()),
    positional: () => 'acme',
    usage: (m: string) => new Error(m),
    log: vi.fn(),
  }
  return importVerb('seed-vertical', ctx as never).finally(() => out.mockRestore()).then(() => modules)
}

describe('seed-vertical: the call site passes the platform-enabled modules', () => {
  it('enabled messaging and files reach the seed as both flags true', async () => {
    const modules = await runSeed(['messaging', 'files', 'calendar'])
    expect(modules.enabled).toHaveBeenCalledTimes(1)
    expect(seedVertical.mock.calls[0]![1]).toMatchObject({ modules: { messaging: true, files: true } })
  })

  it('with neither enabled both flags are false, whatever the manifests default to', async () => {
    await runSeed([])
    expect(seedVertical.mock.calls[0]![1]).toMatchObject({ modules: { messaging: false, files: false } })
  })

  it('only files enabled: a folder per unit is possible, a room is not', async () => {
    await runSeed(['files'])
    expect(seedVertical.mock.calls[0]![1]).toMatchObject({ modules: { messaging: false, files: true } })
  })

  it('config.modules is never read for the flags', async () => {
    await runSeed(['messaging', 'files'])
    expect(readConfig).not.toHaveBeenCalled()
  })
})

describe('source guard: tenant-provision-import.ts no longer derives the flags from cfg.modules', () => {
  const src = readFileSync('scripts/tenant-provision-import.ts', 'utf8')

  it('does not read cfg.modules or import readConfig', () => {
    expect(src).not.toMatch(/cfg\.modules/)
    expect(src).not.toMatch(/\bmodules\.messages\b|\bmodules\.files\b/)
    expect(src).not.toMatch(/import \{ readConfig \}/)
  })

  it('takes the flags from seedModulesFor over deps.modules.enabled', () => {
    expect(src).toMatch(/seedModulesFor\(await deps\.modules\.enabled\(c\)\)/)
    expect(src).toMatch(/from '\.\.\/src\/lib\/server\/tenant\/provisioner\/seed-modules'/)
  })
})
