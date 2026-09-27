import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ROUTER_FILE_RE, SLUG_PATTERN, hostPinName, perIpName, routerFileName, routerName, validateSlug } from '../src/names.js'
import { REPO_ROOT } from './helpers.js'

describe('names', () => {
  it('SLUG_PATTERN is textually identical to gremion-ui slug.ts', () => {
    const src = readFileSync(join(REPO_ROOT, 'gremion-ui', 'src', 'lib', 'server', 'tenant', 'slug.ts'), 'utf8')
    const m = /export const SLUG_PATTERN = (\/.*\/)\s*$/m.exec(src)
    expect(m?.[1]).toBe(SLUG_PATTERN.toString())
  })

  it('spells the AM-B-07 names', () => {
    expect(routerFileName('acme')).toBe('tenant-acme.yml')
    expect(routerName('acme', 0)).toBe('tenant-acme')
    expect(routerName('acme', 2)).toBe('tenant-acme-2')
    expect(hostPinName('acme', 0)).toBe('edge-hostpin-acme')
    expect(hostPinName('acme', 1)).toBe('edge-hostpin-acme-1')
    expect(perIpName('acme')).toBe('edge-perip-acme')
  })

  it('refuses a path-bearing or platform-pin slug everywhere a name is built', () => {
    for (const bad of ['..', '../etc', 'a/b', 'a\\b', 'a.b', '', 'www', 'apex', 'sales', 'control']) {
      expect(validateSlug(bad).ok).toBe(false)
      expect(() => routerFileName(bad)).toThrow(/invalid slug/)
      expect(() => hostPinName(bad, 0)).toThrow(/invalid slug/)
    }
    expect(() => routerName('acme', -1)).toThrow(/index/)
    expect(() => routerName('acme', 1.5)).toThrow(/index/)
  })

  it('ROUTER_FILE_RE matches exactly what routerFileName produces', () => {
    expect(ROUTER_FILE_RE.exec(routerFileName('a-1'))?.[1]).toBe('a-1')
    for (const n of ['tenant-a.yml.tmp', '.tenant-a.yml.123.tmp', 'tenant-.yml', 'tenant-a.yaml', 'active.yml', 'tenant-../x.yml']) {
      expect(ROUTER_FILE_RE.test(n)).toBe(false)
    }
  })
})
