import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as realFs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

// T4.2 / G-016: corruption- and crash-resilience for the on-disk config store.
//
// Unlike the sibling config.test.ts these tests use the **real** filesystem
// via os.tmpdir() so the atomic write / parse fallback semantics can be
// exercised end-to-end. The mutable `env.CONFIG_PATH` mock lets each test
// point the module at its own scratch file; getConfigPath() reads the env
// lazily on every call, so swapping it between tests works without
// resetModules.

const envMock: { CONFIG_PATH: string } = { CONFIG_PATH: '' }

vi.mock('$env/dynamic/private', () => ({
  env: envMock,
}))

// P2.1a: readConfig()/writeConfig() default their tenant arg to requireTenant()
// (fail-closed). This suite swaps envMock.CONFIG_PATH per test (real tmp file),
// so the default-tenant configPath must track the same mutable env value.
vi.mock('$lib/server/tenant/context', () => ({ requireTenant: () => ({ id: 'default', configPath: envMock.CONFIG_PATH }) }))

let scratchDir: string
let configPath: string

beforeEach(() => {
  scratchDir = realFs.mkdtempSync(path.join(os.tmpdir(), 'gremion-config-'))
  configPath = path.join(scratchDir, 'config.json')
  envMock.CONFIG_PATH = configPath
})

afterEach(() => {
  // Best-effort cleanup; recursive+force keeps a stray tmp file from blocking removal.
  try {
    realFs.rmSync(scratchDir, { recursive: true, force: true })
  } catch {
    // ignore
  }
  vi.restoreAllMocks()
})

describe('readConfig: corruption resilience (G-016)', () => {
  it('returns defaults when the config file contains garbage JSON', async () => {
    // Hand-edited or half-written file — used to throw out of JSON.parse and
    // 500 every request that hit hooks.server.ts.
    realFs.writeFileSync(configPath, '{this is not valid json at all,,,')

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const { readConfig } = await import('./config')
    const config = readConfig()

    // Defaults surface — server stays up.
    expect(config.setup_complete).toBe(false)
    // Governance-only kernel: no always-on feature modules → empty default map.
    expect(config.modules).toEqual({})
    expect(config.backups.retention_days).toBe(30)
    expect(config.org.portal_sections.news).toBe(true)

    // Operator gets a breadcrumb in the container log.
    expect(warnSpy).toHaveBeenCalled()
    const firstArg = warnSpy.mock.calls[0][0]
    expect(typeof firstArg).toBe('string')
    expect(firstArg).toContain('config')
  })

  it('returns defaults when the config file is empty', async () => {
    realFs.writeFileSync(configPath, '')
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const { readConfig } = await import('./config')
    const config = readConfig()

    expect(config.setup_complete).toBe(false)
    expect(config.smtp.port).toBe(587)
  })

  it('falls back to defaults if a writer crashed and left only a truncated tmp file', async () => {
    // Simulate a crashed write: a stale `${path}.tmp` sits next to a parseable
    // (or missing) target. The real file is what gets read; readConfig must
    // not be derailed by the leftover tmp.
    realFs.writeFileSync(`${configPath}.tmp`, '{"setup_complete": tru')

    const { readConfig } = await import('./config')
    const config = readConfig()

    // Target file doesn't exist → defaults, .tmp is ignored.
    expect(config.setup_complete).toBe(false)
  })

  it('returns the last good config when a writer crashed mid-rename', async () => {
    // Last successful atomic write left a good config in place.
    realFs.writeFileSync(
      configPath,
      JSON.stringify({ setup_complete: true, org: { name: 'Last Good', domain: 'good.de', logo_path: null } }),
    )
    // A subsequent writer crashed after writing the tmp but before renaming —
    // the tmp is corrupt, but the target file is still the last good one.
    realFs.writeFileSync(`${configPath}.tmp`, '{"setup_complete": fals')

    const { readConfig } = await import('./config')
    const config = readConfig()

    expect(config.setup_complete).toBe(true)
    expect(config.org.name).toBe('Last Good')
  })
})

describe('writeConfig: atomic tmp-rename (G-016)', () => {
  it('produces a fully-parseable file (renameSync is atomic)', async () => {
    const { writeConfig, readConfig } = await import('./config')

    writeConfig({ org: { name: 'Atomic', domain: 'atomic.de', logo_path: null } })

    // The target file exists and is valid JSON immediately after writeConfig
    // returns — there is no observable window where readers could see a
    // partial blob.
    expect(realFs.existsSync(configPath)).toBe(true)
    const onDisk = realFs.readFileSync(configPath, 'utf-8')
    const parsed = JSON.parse(onDisk)
    expect(parsed.org.name).toBe('Atomic')

    // And readConfig agrees.
    expect(readConfig().org.name).toBe('Atomic')
  })

  it('never leaves the original file in a partial state when a new write lands', async () => {
    // Seed a known-good file.
    realFs.writeFileSync(
      configPath,
      JSON.stringify({
        setup_complete: true,
        org: { name: 'Original', domain: 'orig.de', logo_path: null },
      }),
    )
    const before = realFs.readFileSync(configPath, 'utf-8')
    expect(() => JSON.parse(before)).not.toThrow()

    const { writeConfig } = await import('./config')
    writeConfig({ org: { name: 'After', domain: 'after.de', logo_path: null } })

    // Immediately after writeConfig returns, the target is either the old
    // valid file (impossible here — we just wrote) or the new valid file —
    // never a partial. Asserting parseability is the strongest available
    // proxy for "never partial" without racing the syscall.
    const after = realFs.readFileSync(configPath, 'utf-8')
    expect(() => JSON.parse(after)).not.toThrow()
    expect(JSON.parse(after).org.name).toBe('After')
  })

  it('cleans up by leaving no stray .tmp behind after a successful write', async () => {
    const { writeConfig } = await import('./config')
    writeConfig({ org: { name: 'Clean', domain: 'clean.de', logo_path: null } })

    // After a successful rename the .tmp source path no longer exists.
    expect(realFs.existsSync(`${configPath}.tmp`)).toBe(false)
    expect(realFs.existsSync(configPath)).toBe(true)
  })

  it('writes go through the .tmp sibling, not directly to the target', async () => {
    // Indirect proof that the write lands on `.tmp` first: pre-place a
    // sentinel at the .tmp path. After writeConfig the sentinel must be
    // gone (rename consumed the source path) and the new config must be at
    // the target. If writeConfig were to write the target directly the
    // sentinel would survive untouched — defeating the crash-safety
    // guarantee. (Spying on the ESM `fs` namespace isn't possible under
    // vitest's ESM mode, so this behavioural check stands in.)
    realFs.writeFileSync(`${configPath}.tmp`, 'STALE-SENTINEL-MUST-BE-OVERWRITTEN')
    expect(realFs.readFileSync(`${configPath}.tmp`, 'utf-8')).toBe(
      'STALE-SENTINEL-MUST-BE-OVERWRITTEN',
    )

    const { writeConfig } = await import('./config')
    writeConfig({ org: { name: 'Spy', domain: 'spy.de', logo_path: null } })

    // .tmp was renamed onto the target, so the sentinel file is gone.
    expect(realFs.existsSync(`${configPath}.tmp`)).toBe(false)
    // Target holds the renamed config (NOT the sentinel) — proves the write
    // went via .tmp then rename, never directly to the target.
    const onDisk = realFs.readFileSync(configPath, 'utf-8')
    expect(onDisk).not.toContain('STALE-SENTINEL')
    expect(JSON.parse(onDisk).org.name).toBe('Spy')
  })
})
