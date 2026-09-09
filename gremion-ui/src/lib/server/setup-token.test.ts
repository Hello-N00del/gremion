import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as realFs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

// #256-5: the setup token used to be minted from env.CONFIG_PATH only — ONE
// process-global secret that authorized the setup wizard (incl. KC admin
// account creation) for EVERY tenant whose setup_complete was still false.
// It now derives from the RESOLVED tenant's configPath directory, so each
// tenant's wizard is gated by a token minted in that tenant's own data dir.
// The default tenant stays byte-identical: env.CONFIG_PATH remains its source
// of truth (ctx.configPath is IGNORED for id === 'default'), mirroring
// config.ts getConfigPath().
//
// Real fs in an os.tmpdir() scratch dir (config-hardening.test.ts pattern) so
// the on-disk token files prove the per-tenant paths end-to-end. Paths are
// normalized to forward slashes — the module derives the directory with a
// '/'-based replace, exactly like the Linux container paths it sees in prod.

const envMock: { CONFIG_PATH?: string } = {}
vi.mock('$env/dynamic/private', () => ({ env: envMock }))

const tenantMock: { current: { id: string; configPath: string } } = {
  current: { id: 'default', configPath: '' },
}
vi.mock('$lib/server/tenant/context', () => ({ requireTenant: () => tenantMock.current }))

let scratch: string // forward-slash form

beforeEach(() => {
  vi.resetModules() // fresh module state (per-tenant token cache) per test
  scratch = realFs.mkdtempSync(path.join(os.tmpdir(), 'gremion-setup-token-')).replace(/\\/g, '/')
  for (const d of ['default-dir', 'alpha', 'beta']) realFs.mkdirSync(`${scratch}/${d}`)
  envMock.CONFIG_PATH = `${scratch}/default-dir/config.json`
  tenantMock.current = { id: 'default', configPath: envMock.CONFIG_PATH }
})

afterEach(() => {
  try {
    realFs.rmSync(scratch, { recursive: true, force: true })
  } catch {
    // best-effort cleanup
  }
})

describe('setup-token — per-tenant authority (#256-5)', () => {
  it('default tenant mints in the env.CONFIG_PATH dir — ctx.configPath is IGNORED (byte-identical pin)', async () => {
    // Point the context at a DIFFERENT (nonexistent) dir: if the module wrongly
    // consulted ctx.configPath for the default tenant, the write would land
    // elsewhere (or throw on the missing dir).
    tenantMock.current = { id: 'default', configPath: `${scratch}/does-not-exist/config.json` }
    const { validateSetupToken } = await import('./setup-token')
    validateSetupToken('probe')
    expect(realFs.existsSync(`${scratch}/default-dir/.setup-token`)).toBe(true)
    expect(realFs.existsSync(`${scratch}/does-not-exist/.setup-token`)).toBe(false)
  })

  it('two tenants derive DISTINCT token paths from their own configPath dirs', async () => {
    const { validateSetupToken } = await import('./setup-token')
    tenantMock.current = { id: 't-alpha', configPath: `${scratch}/alpha/config.json` }
    validateSetupToken('probe')
    tenantMock.current = { id: 't-beta', configPath: `${scratch}/beta/config.json` }
    validateSetupToken('probe')
    const alphaToken = realFs.readFileSync(`${scratch}/alpha/.setup-token`, 'utf-8').trim()
    const betaToken = realFs.readFileSync(`${scratch}/beta/.setup-token`, 'utf-8').trim()
    expect(alphaToken).not.toBe(betaToken)
    // and neither leaked into the default tenant's dir
    expect(realFs.existsSync(`${scratch}/default-dir/.setup-token`)).toBe(false)
  })

  it('a tenant validates its OWN token (round-trip)', async () => {
    const { validateSetupToken } = await import('./setup-token')
    tenantMock.current = { id: 't-alpha', configPath: `${scratch}/alpha/config.json` }
    validateSetupToken('probe') // mint
    const alphaToken = realFs.readFileSync(`${scratch}/alpha/.setup-token`, 'utf-8').trim()
    expect(validateSetupToken(alphaToken)).toBe(true)
  })

  it("tenant A's token does NOT validate for tenant B (no cross-tenant setup authority)", async () => {
    const { validateSetupToken } = await import('./setup-token')
    tenantMock.current = { id: 't-alpha', configPath: `${scratch}/alpha/config.json` }
    validateSetupToken('probe') // mint alpha's token
    const alphaToken = realFs.readFileSync(`${scratch}/alpha/.setup-token`, 'utf-8').trim()
    tenantMock.current = { id: 't-beta', configPath: `${scratch}/beta/config.json` }
    expect(validateSetupToken(alphaToken)).toBe(false)
  })

  it('clearSetupToken removes only the CURRENT tenant token file', async () => {
    const { validateSetupToken, clearSetupToken } = await import('./setup-token')
    tenantMock.current = { id: 't-alpha', configPath: `${scratch}/alpha/config.json` }
    validateSetupToken('probe')
    tenantMock.current = { id: 't-beta', configPath: `${scratch}/beta/config.json` }
    validateSetupToken('probe')
    tenantMock.current = { id: 't-alpha', configPath: `${scratch}/alpha/config.json` }
    clearSetupToken()
    expect(realFs.existsSync(`${scratch}/alpha/.setup-token`)).toBe(false)
    expect(realFs.existsSync(`${scratch}/beta/.setup-token`)).toBe(true)
  })
})
