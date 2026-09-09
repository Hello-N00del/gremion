import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const tenantMock: { current: { id: string; configPath: string } | null } = { current: null }
vi.mock('$env/dynamic/private', () => ({ env: { CONFIG_PATH: '/tmp/default-config.json' } }))
vi.mock('$lib/server/tenant/context', () => ({
  requireTenant: () => {
    if (!tenantMock.current) throw new Error('no tenant resolved in this context')
    return tenantMock.current
  },
}))
// Keep the real module (parseConfig/gremionConfigSchema are exercised by the
// P2.2-data accent/logo tests below) and only stub readConfig.
vi.mock('./config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config')>()),
  readConfig: () => ({
    org: { name: 'Studierendenrat der Musterhochschule', domain: 'stura.example.org' },
    brand: { product: 'Musterrat', logo_letter: 'S', org_short: 'Muster-HS', term: 'SoSe 26', version: 'v2.4' },
  }),
}))

describe('server brand: brandFromConfig + requireBrand', () => {
  beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); tenantMock.current = null })
  afterEach(() => vi.restoreAllMocks())

  it('brandFromConfig maps a GremionConfig to the canonical Brand (golden)', async () => {
    const { brandFromConfig } = await import('./brand')
    const { readConfig } = await import('./config')
    const brand = brandFromConfig(readConfig({ id: 'default', configPath: '/tmp/default-config.json' }))
    expect(brand).toEqual({
      product: 'Musterrat', logoLetter: 'S', orgShort: 'Muster-HS', term: 'SoSe 26',
      orgName: 'Studierendenrat der Musterhochschule', domain: 'stura.example.org',
      version: 'v2.4',
      // gremion#22: configs without brand.palette/logo_url (StuRa default +
      // every existing config file) map to null — byte-identical default
      // rendering.
      palette: null, logoUrl: null,
    })
  })
  it('requireBrand throws (fail-closed) when no tenant resolves', async () => {
    const { requireBrand } = await import('./brand')
    expect(() => requireBrand()).toThrow(/no tenant resolved/)
  })
  it('requireBrand returns the resolved tenant brand when a tenant is present', async () => {
    tenantMock.current = { id: 'default', configPath: '/tmp/default-config.json' }
    const { requireBrand } = await import('./brand')
    expect(requireBrand().orgShort).toBe('Muster-HS')
  })
})

// gremion#22 (theming parity, supersedes P2.2-data Task 12's freeform accent)
// — per-tenant curated accent PALETTE + logo shipped through the existing
// config→brand→layout SSR path. NULL = today's rendering (byte-identical
// pin); TenantContext.accent/logoUrl (a distinct, still-inert control-plane
// field — see tenant/registry.ts) stay null (Track A/S3 populates them).
describe('gremion#22: per-tenant curated accent palette via config→brand', () => {
  beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); tenantMock.current = null })

  it('brandFromConfig maps cfg.brand.palette (curated id) + logo_url → palette/logoUrl', async () => {
    const { brandFromConfig } = await import('./brand')
    const { parseConfig } = await import('./config')
    const cfg = parseConfig({
      brand: { palette: 'stadt', logo_url: 'https://cdn.example.org/logo.svg' },
    })
    const brand = brandFromConfig(cfg)
    expect(brand.palette).toBe('stadt')
    expect(brand.logoUrl).toBe('https://cdn.example.org/logo.svg')
  })

  it('a config WITHOUT palette/logo_url yields palette: null, logoUrl: null (byte-identical default)', async () => {
    const { brandFromConfig } = await import('./brand')
    const { parseConfig } = await import('./config')
    const brand = brandFromConfig(parseConfig({}))
    expect(brand.palette).toBeNull()
    expect(brand.logoUrl).toBeNull()
  })

  it('config schema accepts brand.palette as a string and preserves it (structural gate only)', async () => {
    const { gremionConfigSchema } = await import('./config')
    const result = gremionConfigSchema.safeParse({ brand: { palette: 'stadt' } })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.brand?.palette).toBe('stadt')
  })

  it('config schema rejects a non-string brand.palette', async () => {
    const { gremionConfigSchema } = await import('./config')
    expect(gremionConfigSchema.safeParse({ brand: { palette: 42 } }).success).toBe(false)
  })

  it('brandFromConfig curates a non-curated stored palette value down to null (id-only contract)', async () => {
    const { brandFromConfig } = await import('./brand')
    const { parseConfig } = await import('./config')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // A raw hex could only ever get into `palette` via a hand-edited config
    // file — the schema is structural-only (any string), so brandFromConfig
    // (resolvePaletteId) is the runtime gate that keeps the client-facing
    // Brand.palette curated-id-only.
    const brand = brandFromConfig(parseConfig({ brand: { palette: '#0ea5e9' } }))
    expect(brand.palette).toBeNull()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('a legacy brand.accent (curated id) is migrated onto palette at config read-time', async () => {
    const { parseConfig } = await import('./config')
    const cfg = parseConfig({ brand: { accent: 'stadt' } })
    expect(cfg.brand.palette).toBe('stadt')
    // The deprecated key is destructured out — never persists past a read.
    expect((cfg.brand as Record<string, unknown>).accent).toBeUndefined()
  })

  it('a legacy brand.accent naming a curated hue migrates onto that palette id', async () => {
    const { parseConfig } = await import('./config')
    // '300' is the stadt (Aubergine) hue under the retired v8 grammar.
    const cfg = parseConfig({ brand: { accent: '300' } })
    expect(cfg.brand.palette).toBe('stadt')
  })

  it('a legacy brand.accent with no curated mapping drops to null with a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { parseConfig } = await import('./config')
    const cfg = parseConfig({ brand: { accent: '#7c3aed' } })
    expect(cfg.brand.palette).toBeNull()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('a stored palette always wins over a stored legacy accent', async () => {
    const { parseConfig } = await import('./config')
    const cfg = parseConfig({ brand: { accent: 'stadt', palette: 'fara' } })
    expect(cfg.brand.palette).toBe('fara')
  })
})
