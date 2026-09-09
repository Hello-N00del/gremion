import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'

const tenantMock: { current: { id: string; configPath: string } | null } = { current: null }
vi.mock('$env/dynamic/private', () => ({ env: { CONFIG_PATH: '/tmp/default-config.json' } }))
vi.mock('$lib/server/tenant/context', () => ({
  requireTenant: () => {
    if (!tenantMock.current) throw new Error('no tenant resolved in this context')
    return tenantMock.current
  },
}))
// vitest 4 no longer reliably automocks Node built-ins (bare `vi.mock('fs')`
// leaves the real functions in place), so declare the factory explicitly with
// only the named exports config.ts actually imports. `default` must mirror
// the named exports too — see config.test.ts for why.
vi.mock('fs', () => {
  const existsSync = vi.fn()
  const readFileSync = vi.fn()
  const writeFileSync = vi.fn()
  const renameSync = vi.fn()
  return { existsSync, readFileSync, writeFileSync, renameSync, default: { existsSync, readFileSync, writeFileSync, renameSync } }
})
const mockFs = vi.mocked(fs)

describe('readConfig(tenant): per-tenant config path', () => {
  beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); tenantMock.current = null })
  afterEach(() => vi.restoreAllMocks())

  it('default tenant reads env.CONFIG_PATH byte-identical to the zero-tenant baseline', async () => {
    const stored = JSON.stringify({
      setup_complete: true,
      org: { name: 'Studierendenrat der Musterhochschule', domain: 'stura.example.org', logo_path: null },
    })
    mockFs.existsSync.mockReturnValue(true)
    mockFs.readFileSync.mockReturnValue(stored)
    tenantMock.current = { id: 'default', configPath: '/tmp/default-config.json' }
    const { readConfig } = await import('./config')
    const explicit = readConfig({ id: 'default', configPath: '/tmp/default-config.json' })
    const viaAls = readConfig()
    expect(viaAls).toEqual(explicit)
    expect(explicit.setup_complete).toBe(true)
    expect(explicit.org.name).toBe('Studierendenrat der Musterhochschule')
    // T15 / §6-P2.2: DEFAULT_CONFIG.brand.org_short is now institution-NEUTRAL ('').
    // The stored config supplies NO brand block, so the neutral default applies.
    expect(explicit.brand.org_short).toBe('')
    expect(mockFs.readFileSync).toHaveBeenCalledWith('/tmp/default-config.json', 'utf-8')
  })

  it('a second tenant reads its own configPath, not the default file', async () => {
    mockFs.existsSync.mockReturnValue(true)
    mockFs.readFileSync.mockReturnValue(JSON.stringify({ org: { name: 'Stadt Wernigerode', domain: 'wr.example.org', logo_path: null } }))
    const { readConfig } = await import('./config')
    const cfg = readConfig({ id: 't_wr', configPath: '/data/wr/config.json' })
    expect(cfg.org.name).toBe('Stadt Wernigerode')
    expect(mockFs.readFileSync).toHaveBeenCalledWith('/data/wr/config.json', 'utf-8')
  })

  // §8.1 / D-CONFIGPATH: the default tenant rides the SAME path as tenant #2 —
  // readConfig trusts tenant.configPath unconditionally, with NO env.CONFIG_PATH
  // fallback inside config.ts. The supplied configPath here deliberately differs
  // from the mocked env.CONFIG_PATH ('/tmp/default-config.json'); the special-case
  // that this task removes would have read the env path instead. Fails first.
  it('default tenant reads its supplied configPath, NOT env.CONFIG_PATH (no special-case)', async () => {
    mockFs.existsSync.mockReturnValue(true)
    mockFs.readFileSync.mockReturnValue(JSON.stringify({ org: { name: 'Default via real path', domain: 'd.example.org', logo_path: null } }))
    const { readConfig } = await import('./config')
    // env.CONFIG_PATH is '/tmp/default-config.json' (top-of-file mock); the row's
    // own configPath points elsewhere — readConfig must follow the row.
    const cfg = readConfig({ id: 'default', configPath: '/data/default/config.json' })
    expect(cfg.org.name).toBe('Default via real path')
    expect(mockFs.readFileSync).toHaveBeenCalledWith('/data/default/config.json', 'utf-8')
    expect(mockFs.readFileSync).not.toHaveBeenCalledWith('/tmp/default-config.json', 'utf-8')
  })

  it('throws (fail-closed) when no tenant is resolved and no arg is given', async () => {
    const { readConfig } = await import('./config')
    expect(() => readConfig()).toThrow(/no tenant resolved/)
  })
})
