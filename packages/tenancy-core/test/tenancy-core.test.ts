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
  createHostRejectionLog,
  HOST_REJECTED_EVENT,
  hostFromIssuer,
  isReservedPlatformHost,
  normaliseHost,
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
