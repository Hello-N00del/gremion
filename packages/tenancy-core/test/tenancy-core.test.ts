// @gremion/tenancy-core (TASK-077 G6). gremion-ui's own tenant/ suites (host,
// reserved-hosts, host-mismatch-log, resolve, registry.domain) keep running
// against the re-exports, unchanged; this suite pins what the KERNEL API
// relies on directly: the normaliser's fail-closed matrix, the reserved set,
// the emitter's required sink, and that the package source stays portable.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  addTenantDomain,
  controlPanelHosts,
  createHostRejectionLog,
  HOST_REJECTED_EVENT,
  hostFromIssuer,
  isReservedPlatformHost,
  normaliseHost,
  reservedHostCheck,
  reservedPlatformHosts,
} from '../src/index.ts'

const SRC = fileURLToPath(new URL('../src/', import.meta.url))

describe('normaliseHost: the whole host is the key, ambiguity fails closed', () => {
  it.each([
    ['Example.ORG', 'example.org'],
    ['example.org.', 'example.org'],
    ['example.org:443', 'example.org'],
    ['xn--bcher-kva.example', 'xn--bcher-kva.example'],
    ['a.b.c.example.org', 'a.b.c.example.org'],
  ])('%s -> %s', (raw, want) => {
    expect(normaliseHost(raw)).toBe(want)
  })

  it.each([
    [''],
    ['   '],
    ['a.example.org, b.example.org'],
    ['a example.org'],
    ['evil.com:80@x'],
    ['[::1]:443'],
    ['bücher.example'],
    ['tenant..org'],
    ['.t.example.org'],
    ['example.org..'],
    ['example.org:abc'],
    ['a_b.example.org'],
    [`${'a'.repeat(64)}.example.org`],
  ])('%j -> null', (raw) => {
    expect(normaliseHost(raw)).toBeNull()
  })

  it('hostFromIssuer derives the issuer authority through the same normaliser', () => {
    expect(hostFromIssuer('https://Tenant.Example.org/realms/a')).toBe('tenant.example.org')
    expect(hostFromIssuer('https:///auth/realms/x')).toBeNull()
  })
})

describe('reserved platform hosts', () => {
  it('the apex and its eight labels, apex first', () => {
    const r = reservedPlatformHosts('example.org')
    expect(r[0]).toBe('example.org')
    expect(r).toHaveLength(9)
    expect(isReservedPlatformHost('control.example.org:443', 'example.org')).toBe(true)
    expect(isReservedPlatformHost('tenant.example.org', 'example.org')).toBe(false)
  })

  it('refuses an unset apex instead of computing an empty set', () => {
    expect(() => reservedPlatformHosts('  ')).toThrow(/PLATFORM_DOMAIN is unset/)
  })
})

// The control panel's host (CONTROL_PANEL_HOST) may lie OUTSIDE the platform domain, where the labels
// above never reach it: it must be refused as a customer host all the same.
describe('the control panel host is reserved like the nine', () => {
  const APEX = 'platform.example.org'
  const PANEL = 'panel.example.org' // beside the platform domain, not under it

  it('controlPanelHosts reads CONTROL_PANEL_HOST and the host of the origin, spelling-normalised', () => {
    expect(controlPanelHosts({})).toEqual([])
    expect(controlPanelHosts({ CONTROL_PANEL_HOST: '' })).toEqual([])
    expect(controlPanelHosts({ CONTROL_PANEL_HOST: ' Panel.Example.ORG. ' })).toEqual([PANEL])
    expect(controlPanelHosts({ CONTROL_PANEL_ORIGIN: `https://${PANEL}` })).toEqual([PANEL])
    expect(controlPanelHosts({ CONTROL_PANEL_HOST: PANEL, CONTROL_PANEL_ORIGIN: `https://${PANEL}` })).toEqual([PANEL])
    expect(controlPanelHosts({ CONTROL_PANEL_ORIGIN: 'not an origin' })).toEqual([])
  })

  it('a host outside the platform domain is reserved once passed, and not before', () => {
    expect(isReservedPlatformHost(PANEL, APEX)).toBe(false)
    expect(isReservedPlatformHost(PANEL, APEX, [PANEL])).toBe(true)
    expect(isReservedPlatformHost(`${PANEL.toUpperCase()}.`, APEX, [PANEL])).toBe(true)
    expect(isReservedPlatformHost(`${PANEL}:443`, APEX, [PANEL])).toBe(true)
    expect(reservedPlatformHosts(APEX, [PANEL])).toHaveLength(10)
    expect(reservedPlatformHosts(APEX, ['control.' + APEX])).toHaveLength(9) // already one of the nine
  })

  it('reservedHostCheck: the configured host and the default control.<platform> are refused, another host is not', () => {
    const refuse = reservedHostCheck({ PLATFORM_DOMAIN: APEX, CONTROL_PANEL_HOST: PANEL })
    expect(refuse(PANEL)).toBe(true)
    expect(refuse(`control.${APEX}`)).toBe(true)
    expect(refuse('rat.musterstadt.example')).toBe(false)
    const dflt = reservedHostCheck({ PLATFORM_DOMAIN: APEX })
    expect(dflt(`control.${APEX}`)).toBe(true)
    expect(dflt(PANEL)).toBe(false)
    expect(reservedHostCheck({ PLATFORM_DOMAIN: APEX, CONTROL_PANEL_ORIGIN: `https://${PANEL}` })(PANEL)).toBe(true)
  })

  it('reservedHostCheck fails closed on an unset platform domain', () => {
    expect(() => reservedHostCheck({ CONTROL_PANEL_HOST: PANEL })).toThrow(/PLATFORM_DOMAIN is unset/)
  })

  // The refusal comes BEFORE the first query: no database is needed to see it.
  it('addTenantDomain refuses the configured panel host, the default control.<platform>, and still takes another', async () => {
    const noDb = new Proxy({}, { get: () => { throw new Error('the database was reached') } }) as never
    const deps = { platformDomain: APEX, controlPanelHosts: [PANEL], onEvict: () => {} }
    const tenant = '8d6b9c7e-1f2a-4b3c-9d4e-5f6a7b8c9d0e'
    await expect(addTenantDomain(noDb, tenant, PANEL, {}, deps)).rejects.toThrow(/reserved platform host: panel\.example\.org/)
    await expect(addTenantDomain(noDb, tenant, `Panel.Example.ORG.`, {}, deps)).rejects.toThrow(/reserved platform host/)
    await expect(addTenantDomain(noDb, tenant, `control.${APEX}`, {}, deps)).rejects.toThrow(/reserved platform host/)
    // another host passes the reserved check and reaches the database
    await expect(addTenantDomain(noDb, tenant, 'rat.musterstadt.example', {}, deps)).rejects.toThrow(/the database was reached/)
    // without the panel host passed the same name is not refused (what the bug was)
    await expect(addTenantDomain(noDb, tenant, PANEL, {}, { platformDomain: APEX, onEvict: () => {} })).rejects.toThrow(/the database was reached/)
  })
})

describe('createHostRejectionLog: the sink is required here', () => {
  it('throws without an emit sink (no silent default in the package)', () => {
    expect(() => createHostRejectionLog({} as never)).toThrow(/emit sink/)
  })

  it('emits through the injected sink and dedupes within the window', () => {
    const lines: Array<[string, Record<string, unknown>]> = []
    let t = 1_000
    const log = createHostRejectionLog({ now: () => t, emit: (m, f) => lines.push([m, f]), schedule: () => {} })
    log('unbound', 'a.example.org')
    log('unbound', 'a.example.org')
    expect(lines).toHaveLength(1)
    expect(lines[0]![0]).toBe(HOST_REJECTED_EVENT)
    expect(lines[0]![1]).toMatchObject({ host: 'a.example.org', reason: 'unbound' })
    t += 60_000
    log('unbound', 'a.example.org')
    expect(lines[1]![1]).toMatchObject({ suppressed: 1 })
  })

  it('never throws, even when the sink does', () => {
    const log = createHostRejectionLog({
      emit: () => {
        throw new Error('sink down')
      },
    })
    expect(() => log('forged', 'x.example.org')).not.toThrow()
  })
})

describe('portability: the package source imports no SvelteKit module', () => {
  it('every src file imports only relative .ts files, node: builtins or @gremion/db (type-only)', () => {
    const files = readdirSync(SRC).filter((f) => f.endsWith('.ts'))
    expect(files.length).toBeGreaterThanOrEqual(5)
    const bad: string[] = []
    for (const f of files) {
      const src = readFileSync(join(SRC, f), 'utf8')
      for (const m of src.matchAll(/\b(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\bfrom\s+)?['"]([^'"]+)['"]/g)) {
        const spec = m[1]!
        if (spec.startsWith('./') && spec.endsWith('.ts')) continue
        if (spec.startsWith('node:') || spec === '@gremion/db') continue
        bad.push(`${f}: ${spec}`)
      }
      if (/\bimport\s*\(|\brequire\s*\(/.test(src)) bad.push(`${f}: dynamic import`)
    }
    expect(bad).toEqual([])
  })
})
