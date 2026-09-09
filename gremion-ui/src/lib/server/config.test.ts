import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import type { ModuleManifest } from '$lib/modules/types'
import type { GremionConfig } from './config'

// Mock the $env/dynamic/private module
vi.mock('$env/dynamic/private', () => ({
  env: { CONFIG_PATH: '/tmp/test-config.json' },
}))

// P2.1a: readConfig()/writeConfig() default their tenant arg to requireTenant()
// (fail-closed). These legacy single-tenant suites call them zero-arg, so stub
// the resolver to the `default` tenant mapped at this file's CONFIG_PATH.
vi.mock('$lib/server/tenant/context', () => ({ requireTenant: () => ({ id: 'default', configPath: '/tmp/test-config.json' }) }))

// Mock the fs module. vitest 4 no longer reliably automocks Node built-ins
// (bare `vi.mock('fs')` leaves the real functions in place — see vitest v4
// migration notes on module mocking), so declare the factory explicitly with
// only the named exports config.ts actually imports. `default` must mirror
// the named exports too — Vite's CJS interop for the SSR-external `fs`
// module resolves the namespace via the mock's `default`, same pattern as
// tenant/secrets.test.ts's node:fs mock.
vi.mock('fs', () => {
  const existsSync = vi.fn()
  const readFileSync = vi.fn()
  const writeFileSync = vi.fn()
  const renameSync = vi.fn()
  return { existsSync, readFileSync, writeFileSync, renameSync, default: { existsSync, readFileSync, writeFileSync, renameSync } }
})

const mockFs = vi.mocked(fs)

describe('ConfigStore', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('readConfig', () => {
    it('returns default config when file does not exist', async () => {
      mockFs.existsSync.mockReturnValue(false)

      const { readConfig } = await import('./config')
      const config = readConfig()

      expect(config.setup_complete).toBe(false)
      // Governance-only kernel: no always-on feature modules, so the default
      // modules map is empty (pinned by the WP3 default golden below).
      expect(config.modules).toEqual({})
      expect(config.backups.retention_days).toBe(30)
    })

    it('merges stored config with defaults', async () => {
      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue(
        JSON.stringify({ setup_complete: true, org: { name: 'Test Rat', domain: 'example.com', logo_path: null } }),
      )

      const { readConfig } = await import('./config')
      const config = readConfig()

      expect(config.setup_complete).toBe(true)
      expect(config.org.name).toBe('Test Rat')
      // defaults still present
      expect(config.smtp.port).toBe(587)
    })
  })

  describe('writeConfig', () => {
    beforeEach(() => {
      mockFs.existsSync.mockReturnValue(false) // start from defaults
      mockFs.writeFileSync.mockImplementation(() => undefined)
    })

    it('module toggles are honoured (kernel has no force-pinned required modules)', async () => {
      const { writeConfig } = await import('./config')
      // The governance-only kernel ships no REQUIRED_MODULES, so writeConfig's
      // force-pin loop is a no-op: a feature module id (here synthetic) persists
      // exactly as written rather than being re-pinned to true.
      const result = writeConfig({
        modules: { demo_widget: true, demo_other: false },
      })

      expect(result.modules.demo_widget).toBe(true)
      expect(result.modules.demo_other).toBe(false)
    })

    it('clamps retention_days below 7 to 7', async () => {
      const { writeConfig } = await import('./config')
      const result = writeConfig({ backups: { retention_days: 3, last_backup_at: null, encryption_key_path: '/key' } })

      expect(result.backups.retention_days).toBe(7)
    })

    it('setup_complete never transitions true → false', async () => {
      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue(JSON.stringify({ setup_complete: true }))

      const { writeConfig } = await import('./config')
      const result = writeConfig({ setup_complete: false })

      expect(result.setup_complete).toBe(true)
    })

    it('writeConfig returns a new object (immutability)', async () => {
      const { readConfig, writeConfig } = await import('./config')
      const before = readConfig()
      const after = writeConfig({ org: { name: 'Changed', domain: 'x.de', logo_path: null } })

      expect(after).not.toBe(before)
      expect(after.org.name).toBe('Changed')
    })

    it('persists config to disk via atomic tmp-rename', async () => {
      mockFs.renameSync.mockImplementation(() => undefined)

      const { writeConfig } = await import('./config')
      writeConfig({ org: { name: 'Persist Me', domain: 'test.de', logo_path: null } })

      // G-016: write lands on a sibling .tmp first, then renameSync swaps it
      // into place atomically. Readers never see a half-written file.
      expect(mockFs.writeFileSync).toHaveBeenCalledWith(
        '/tmp/test-config.json.tmp',
        expect.stringContaining('Persist Me'),
      )
      expect(mockFs.renameSync).toHaveBeenCalledWith(
        '/tmp/test-config.json.tmp',
        '/tmp/test-config.json',
      )
    })
  })

  describe('portal_sections', () => {
    it('readConfig returns portal_sections defaults when absent in stored config', async () => {
      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue(
        JSON.stringify({ org: { name: 'Test', domain: 'x.de', logo_path: null } }),
      )

      const { readConfig } = await import('./config')
      const config = readConfig()

      expect(config.org.portal_sections).toBeDefined()
      expect(config.org.portal_sections.news).toBe(true)
      expect(config.org.portal_sections.budget).toBe(false)
    })

    it('writeConfig partial portal_sections update preserves other section keys', async () => {
      mockFs.existsSync.mockReturnValue(false) // start from defaults
      mockFs.writeFileSync.mockImplementation(() => undefined)

      const { writeConfig } = await import('./config')
      const result = writeConfig({
        org: { portal_sections: { news: false } },
      })

      // changed
      expect(result.org.portal_sections.news).toBe(false)
      // siblings preserved from defaults
      expect(result.org.portal_sections.board).toBe(true)
      expect(result.org.portal_sections.committees).toBe(true)
      expect(result.org.portal_sections.antrag).toBe(true)
      // and other org fields preserved
      expect(result.org.name).toBe('')
    })

    it('writeConfig org partial update preserves portal_sections', async () => {
      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue(
        JSON.stringify({
          org: {
            name: 'Existing',
            domain: 'a.de',
            logo_path: null,
            portal_sections: { news: false, board: false, committees: true, votes: true, meetings: true, budget: false, antrag: true },
          },
        }),
      )
      mockFs.writeFileSync.mockImplementation(() => undefined)

      const { writeConfig } = await import('./config')
      const result = writeConfig({ org: { name: 'New', domain: 'b.de', logo_path: null } })

      expect(result.org.name).toBe('New')
      expect(result.org.portal_sections.news).toBe(false)
      expect(result.org.portal_sections.votes).toBe(true)
    })
  })

  describe('G-067: gremionConfigSchema validation in readConfig', () => {
    beforeEach(() => {
      vi.resetModules()
      vi.clearAllMocks()
    })

    it('falls back to defaults when stored value has wrong type', async () => {
      mockFs.existsSync.mockReturnValue(true)
      // setup_complete declared as boolean — string "yes" must be rejected
      mockFs.readFileSync.mockReturnValue(
        JSON.stringify({ setup_complete: 'yes', org: { name: 'X', domain: 'x.de', logo_path: null } }),
      )
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const { readConfig } = await import('./config')
      const config = readConfig()

      // Defaults restored (schema reject → empty stored → DEFAULT_CONFIG)
      expect(config.setup_complete).toBe(false)
      expect(config.org.name).toBe('')
      // Warning surfaces in container logs / journalctl
      expect(warnSpy).toHaveBeenCalled()
      const messages = warnSpy.mock.calls.map((c) => c.join(' '))
      expect(messages.some((m) => m.includes('schema validation'))).toBe(true)

      warnSpy.mockRestore()
    })

    it('accepts a well-typed partial config', async () => {
      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue(
        JSON.stringify({ setup_complete: true, org: { name: 'Valid', domain: 'v.de', logo_path: null } }),
      )

      const { readConfig } = await import('./config')
      const config = readConfig()

      expect(config.setup_complete).toBe(true)
      expect(config.org.name).toBe('Valid')
    })
  })

  describe('G-074 + G-098: configUpdateSchema strict validation in writeConfig', () => {
    beforeEach(() => {
      vi.resetModules()
      vi.clearAllMocks()
      mockFs.existsSync.mockReturnValue(false)
      mockFs.writeFileSync.mockImplementation(() => undefined)
      mockFs.renameSync.mockImplementation(() => undefined)
    })

    it('rejects an unknown top-level key', async () => {
      const { writeConfig } = await import('./config')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(() => writeConfig({ orgg: { name: 'typo' } } as any)).toThrow(/invalid update/i)
    })

    it('rejects a typed value of wrong shape', async () => {
      const { writeConfig } = await import('./config')
      // setup_complete must be boolean — string is rejected
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(() => writeConfig({ setup_complete: 'yes' } as any)).toThrow(/invalid update/i)
    })

    it('accepts every shape the setup wizard posts', async () => {
      const { writeConfig } = await import('./config')
      // Step1
      expect(() => writeConfig({ wizard_steps: { health_check: 'complete' } })).not.toThrow()
      // Step2
      expect(() =>
        writeConfig({
          org: { name: 'Test', domain: 'test.de', logo_path: null },
          wizard_steps: { org_info: 'complete' },
        }),
      ).not.toThrow()
      // Step3
      expect(() =>
        writeConfig({
          admin_accounts: { it_admin_created: true, council_admin_created: true },
          wizard_steps: { admin_accounts: 'complete' },
        }),
      ).not.toThrow()
      // Step4
      expect(() =>
        writeConfig({
          smtp: {
            configured: true,
            host: 'smtp.example.de',
            port: 587,
            from_address: 'noreply@example.de',
            from_name: 'Musterrat',
          },
          wizard_steps: { smtp: 'complete' },
        }),
      ).not.toThrow()
      // Step5
      expect(() => writeConfig({ setup_complete: true })).not.toThrow()
    })
  })

  describe('D-WIZARD: deployment single/multi toggle', () => {
    beforeEach(() => {
      vi.resetModules()
      vi.clearAllMocks()
      mockFs.writeFileSync.mockImplementation(() => undefined)
      mockFs.renameSync.mockImplementation(() => undefined)
    })

    it('defaults deployment.mode to single when absent (byte-identical for every existing config)', async () => {
      mockFs.existsSync.mockReturnValue(true)
      // A config persisted before T12 — no `deployment` key at all.
      mockFs.readFileSync.mockReturnValue(
        JSON.stringify({ setup_complete: true, org: { name: 'Legacy', domain: 'x.de', logo_path: null } }),
      )
      const { readConfig } = await import('./config')
      const config = readConfig()
      expect(config.deployment.mode).toBe('single')
      // unrelated fields untouched
      expect(config.org.name).toBe('Legacy')
    })

    it('readConfig returns the default single mode when the file does not exist', async () => {
      mockFs.existsSync.mockReturnValue(false)
      const { readConfig } = await import('./config')
      expect(readConfig().deployment.mode).toBe('single')
    })

    it('parseConfig round-trips an explicit multi mode', async () => {
      const { parseConfig } = await import('./config')
      const cfg = parseConfig({ deployment: { mode: 'multi' } })
      expect(cfg.deployment.mode).toBe('multi')
    })

    it('the setup config endpoint path (writeConfig) persists the toggle', async () => {
      mockFs.existsSync.mockReturnValue(false) // start from defaults
      const { writeConfig } = await import('./config')
      const result = writeConfig({ deployment: { mode: 'multi' } })
      expect(result.deployment.mode).toBe('multi')
      // persisted to disk
      expect(mockFs.writeFileSync).toHaveBeenCalledWith(
        '/tmp/test-config.json.tmp',
        expect.stringContaining('"mode": "multi"'),
      )
    })

    it('the validator rejects an out-of-enum mode (writeConfig)', async () => {
      mockFs.existsSync.mockReturnValue(false)
      const { writeConfig } = await import('./config')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(() => writeConfig({ deployment: { mode: 'cluster' } } as any)).toThrow(/invalid update/i)
    })

    it('readConfig falls back to defaults when the stored mode is out of enum', async () => {
      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue(JSON.stringify({ deployment: { mode: 'cluster' } }))
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const { readConfig } = await import('./config')
      const config = readConfig()
      // schema reject → empty stored → DEFAULT_CONFIG (single)
      expect(config.deployment.mode).toBe('single')
      expect(warnSpy).toHaveBeenCalled()
      warnSpy.mockRestore()
    })
  })

  describe('retention defaults and hard caps', () => {
    beforeEach(() => {
      vi.resetModules()
      vi.clearAllMocks()
      mockFs.existsSync.mockReturnValue(false)
      mockFs.writeFileSync.mockImplementation(() => undefined)
    })

    it('returns GDPR-safe defaults when no retention config stored', async () => {
      const { readConfig } = await import('./config')
      const config = readConfig()
      expect(config.retention.access_logs_days).toBe(14)
      expect(config.retention.app_logs_days).toBe(30)
      expect(config.retention.security_logs_days).toBe(90)
      expect(config.retention.security_nopii_logs_days).toBe(90)
    })

    it('clamps access_logs_days to hard cap of 30', async () => {
      const { writeConfig } = await import('./config')
      const result = writeConfig({ retention: { access_logs_days: 999 } })
      expect(result.retention.access_logs_days).toBe(30)
    })

    it('clamps security_logs_days to hard cap of 180', async () => {
      const { writeConfig } = await import('./config')
      const result = writeConfig({ retention: { security_logs_days: 365 } })
      expect(result.retention.security_logs_days).toBe(180)
    })

    it('clamps security_nopii_logs_days to hard cap of 365', async () => {
      const { writeConfig } = await import('./config')
      const result = writeConfig({ retention: { security_nopii_logs_days: 1000 } })
      expect(result.retention.security_nopii_logs_days).toBe(365)
    })
  })
})

// ── audit #428 ──────────────────────────────────────────────────────────
//
// mergeStoredBrand (config.ts, ~line 441) back-fills brand defaults and
// migrates the DEPRECATED freeform `brand.accent` onto the curated
// `brand.palette` field on read (gremion#22). legacyAccentToPalette itself is
// exhaustively covered in instance-theme.test.ts; mergeStoredBrand's own
// precedence/back-fill logic (palette-wins-over-accent, the accent key being
// stripped from the returned config, logo_url normalization) had zero direct
// coverage. Driven via `parseConfig()`, the same composition readConfig() uses.
describe('audit #428: mergeStoredBrand — legacy accent → palette precedence/migration', () => {
  it('a stored palette wins over a stored legacy accent', async () => {
    const { parseConfig } = await import('./config')
    const cfg = parseConfig({ brand: { palette: 'club', accent: 'stadt' } })
    expect(cfg.brand.palette).toBe('club')
  })

  it('a legacy accent naming a curated palette id migrates onto palette when palette is absent', async () => {
    const { parseConfig } = await import('./config')
    const cfg = parseConfig({ brand: { accent: 'stadt' } })
    expect(cfg.brand.palette).toBe('stadt')
  })

  it('a legacy accent given as a bare hue migrates onto the palette that owns that hue', async () => {
    const { parseConfig } = await import('./config')
    const cfg = parseConfig({ brand: { accent: '300' } })
    expect(cfg.brand.palette).toBe('stadt')
  })

  it('an unmapped legacy accent drops to null (no curated representation) and warns', async () => {
    const { parseConfig } = await import('./config')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const cfg = parseConfig({ brand: { accent: '#7c3aed' } })
    expect(cfg.brand.palette).toBeNull()
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('neither palette nor accent stored leaves palette null (default rendering)', async () => {
    const { parseConfig } = await import('./config')
    const cfg = parseConfig({})
    expect(cfg.brand.palette).toBeNull()
  })

  it('the deprecated accent key is stripped from the returned brand config', async () => {
    const { parseConfig } = await import('./config')
    const cfg = parseConfig({ brand: { accent: 'stadt' } })
    expect('accent' in cfg.brand).toBe(false)
  })

  it('logo_url defaults to null when absent', async () => {
    const { parseConfig } = await import('./config')
    const cfg = parseConfig({ brand: { palette: 'stadt' } })
    expect(cfg.brand.logo_url).toBeNull()
  })

  it('logo_url is preserved when present', async () => {
    const { parseConfig } = await import('./config')
    const cfg = parseConfig({ brand: { logo_url: 'https://example.org/logo.png' } })
    expect(cfg.brand.logo_url).toBe('https://example.org/logo.png')
  })

  it('other brand fields deep-merge onto DEFAULT_CONFIG.brand siblings', async () => {
    const { parseConfig } = await import('./config')
    const cfg = parseConfig({ brand: { product: 'Musterstadt' } })
    expect(cfg.brand.product).toBe('Musterstadt')
    // sibling default preserved, not shallow-replaced away
    expect(cfg.brand.logo_letter).toBe('P')
  })
})

// ── WP3-modules-dynamic ───────────────────────────────────────────────────
//
// config.modules must be a DYNAMIC open record (Record<string, boolean>) so a
// net-new toggleable module needs ZERO edits to config.ts. These suites exercise
// that contract WITHOUT editing config.ts:
//
//  (a) gremionConfigSchema / modulesSchema accept a net-new toggleable id
//      ({ modules: { demo_widget: true } } and { demo_widget: false }).
//  (b) the derived defaultModulesConfig() (exported from config.ts) returns
//      true for every MODULE_MANIFESTS toggleable id AND deep-equals exactly
//      {files,messages,calendar,users,finance,elections}:true TODAY (the
//      byte-identical default pin — proves no behaviour drift).
//  (c) route-gating: a config whose modules['demo_widget'] === false makes
//      disabledModuleForPath('/api/demo-widget/...', cfg) return 'demo_widget'
//      (the mock prefix injected via the moduleRoutePrefixes seam).
//
// A MOCK net-new toggleable manifest, NOT registered in the real manifests
// barrel — it only proves the dynamic seam without touching the live module set.
const demoWidgetManifest: ModuleManifest = {
  id: 'demo_widget',
  toggleable: true,
  pages: [],
  routePrefixes: ['/api/demo-widget'],
}

describe('WP3 config.modules dynamic open record — (a) schema accepts a net-new toggleable id', () => {
  it('gremionConfigSchema accepts { modules: { demo_widget: true } }', async () => {
    const { gremionConfigSchema } = await import('./config')
    const r = gremionConfigSchema.safeParse({ modules: { [demoWidgetManifest.id]: true } })
    expect(r.success).toBe(true)
  })

  it('gremionConfigSchema accepts { modules: { demo_widget: false } }', async () => {
    const { gremionConfigSchema } = await import('./config')
    const r = gremionConfigSchema.safeParse({ modules: { [demoWidgetManifest.id]: false } })
    expect(r.success).toBe(true)
  })
})

describe('WP3 config.modules dynamic open record — (b) defaultModulesConfig()', () => {
  it('returns true for every toggleable manifest id', async () => {
    const { defaultModulesConfig } = await import('./config')
    const { MODULE_MANIFESTS } = await import('$lib/modules/registry')
    const defaults = defaultModulesConfig()
    for (const m of MODULE_MANIFESTS.filter((x) => x.toggleable)) {
      expect(defaults[m.id]).toBe(true)
    }
  })

  it('deep-equals exactly the byte-identical default pin TODAY', async () => {
    const { defaultModulesConfig } = await import('./config')
    // Byte-identical pin — if this changes, a module was added/removed/renamed
    // and the change is intentional; update this literal in the SAME commit.
    // Governance-only kernel: no always-on (REQUIRED_MODULES) ids and the kept
    // manifests (core, governance) are non-toggleable, so this is empty.
    expect(defaultModulesConfig()).toEqual({})
  })
})

describe('WP3 config.modules dynamic open record — (c) route-gating of a net-new toggleable id', () => {
  it("disabledModuleForPath returns 'demo_widget' for its prefix when disabled", async () => {
    // Inject the mock manifest's prefix via the existing moduleRoutePrefixes
    // seam — module-gate.ts iterates moduleRoutePrefixes() to map a path to its
    // owning module id. We do NOT register demo_widget in the real barrel.
    // importOriginal preserves MODULE_MANIFESTS (config.ts → registry now reads
    // it for defaultModulesConfig) and only overrides moduleRoutePrefixes.
    vi.resetModules()
    vi.doMock('$lib/modules/registry', async (importOriginal) => {
      const actual = await importOriginal<typeof import('$lib/modules/registry')>()
      return {
        ...actual,
        moduleRoutePrefixes: () => [
          { prefix: demoWidgetManifest.routePrefixes[0], moduleId: demoWidgetManifest.id },
        ],
      }
    })
    const { disabledModuleForPath } = await import('./module-gate')
    const cfg = {
      modules: {
        files: true,
        messages: true,
        calendar: true,
        users: true,
        finance: true,
        elections: true,
        demo_widget: false,
      },
    } as unknown as GremionConfig
    expect(disabledModuleForPath('/api/demo-widget/things', cfg)).toBe('demo_widget')
    vi.doUnmock('$lib/modules/registry')
  })
})

describe('#248: deep-merge all nested config blocks (no shallow-replace / NaN poisoning)', () => {
  it('parseConfig deep-merges a partial backups block, preserving sibling defaults', async () => {
    const { parseConfig } = await import('./config')
    const cfg = parseConfig({ backups: { last_backup_at: '2026-01-01T00:00:00Z' } })
    expect(cfg.backups.last_backup_at).toBe('2026-01-01T00:00:00Z')
    // retention_days + encryption_key_path must survive from DEFAULT_CONFIG, not be dropped
    expect(cfg.backups.retention_days).toBe(30)
    expect(typeof cfg.backups.encryption_key_path).toBe('string')
    expect(cfg.backups.encryption_key_path.length).toBeGreaterThan(0)
  })

  it('parseConfig deep-merges a partial retention block, preserving GDPR-safe sibling defaults', async () => {
    const { parseConfig } = await import('./config')
    const cfg = parseConfig({ retention: { access_logs_days: 7 } })
    expect(cfg.retention.access_logs_days).toBe(7)
    expect(cfg.retention.app_logs_days).toBe(30)
    expect(cfg.retention.security_logs_days).toBe(90)
    expect(cfg.retention.security_nopii_logs_days).toBe(90)
  })

  it('writeConfig over a partial stored backups/retention never produces NaN/null clamps', async () => {
    mockFs.existsSync.mockReturnValue(true)
    // a config persisted before a schema extension: backups/retention present but partial
    mockFs.readFileSync.mockReturnValue(
      JSON.stringify({ backups: { last_backup_at: '2026-01-01T00:00:00Z' }, retention: { access_logs_days: 7 } }),
    )
    let written = ''
    mockFs.writeFileSync.mockImplementation((_p, data) => {
      written = String(data)
    })

    const { writeConfig } = await import('./config')
    const result = writeConfig({})

    // The clamps must operate on real numbers, never undefined → NaN → null.
    expect(Number.isNaN(result.backups.retention_days)).toBe(false)
    expect(result.backups.retention_days).toBe(30)
    expect(Number.isNaN(result.retention.app_logs_days)).toBe(false)
    expect(result.retention.app_logs_days).toBe(30)
    expect(result.retention.access_logs_days).toBe(7)
    expect(written).not.toMatch(/"retention_days":\s*null/)
    expect(written).not.toMatch(/"app_logs_days":\s*null/)
  })
})
