import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  RESERVED_PLATFORM_LABELS,
  reservedPlatformHosts,
  isReservedPlatformHost,
} from './reserved-hosts'

const APEX = 'gremion.example'

describe('the platform-reserved name set (spec A §C)', () => {
  it('is exactly the nine names, in spec order', () => {
    expect(reservedPlatformHosts(APEX)).toEqual([
      'gremion.example',
      'www.gremion.example',
      'control.gremion.example',
      'rs1.gremion.example',
      'mail.gremion.example',
      'mta-sts.gremion.example',
      'autoconfig.gremion.example',
      'autodiscover.gremion.example',
      '_dmarc.gremion.example',
    ])
    expect(RESERVED_PLATFORM_LABELS).toHaveLength(8) // the apex is the ninth, label-less
  })

  // The code list and the operator template are ONE list. state.env.tmpl:69 is
  // what an operator edits; RESERVED_PLATFORM_LABELS is what addTenantDomain and
  // B18's emitter enforce. Assert they are equal so neither can drift silently.
  it('equals RESERVED_HOSTS in the state env template, plus the apex', () => {
    const tmpl = readFileSync(
      join(process.cwd(), '..', 'infra', 'host', 'templates', 'env', 'state.env.tmpl'), 'utf-8')
    const line = tmpl.split('\n').find((l) => l.startsWith('RESERVED_HOSTS='))
    expect(line).toBeDefined()
    const fromTemplate = line!.slice('RESERVED_HOSTS='.length).trim().split(/\s+/)
    expect([...RESERVED_PLATFORM_LABELS]).toEqual(fromTemplate)
    expect(reservedPlatformHosts(APEX)).toEqual([APEX, ...fromTemplate.map((l) => `${l}.${APEX}`)])
  })

  it('refuses each of the nine however it is spelled', () => {
    for (const h of reservedPlatformHosts(APEX)) {
      expect(isReservedPlatformHost(h, APEX)).toBe(true)
      expect(isReservedPlatformHost(h.toUpperCase(), APEX)).toBe(true)
      expect(isReservedPlatformHost(`  ${h}.  `, APEX)).toBe(true)
      expect(isReservedPlatformHost(`${h}:443`, APEX)).toBe(true)
    }
  })

  it('does not over-reach: a tenant’s own domain and a non-reserved label pass', () => {
    expect(isReservedPlatformHost('rat-musterstadt.de', APEX)).toBe(false)
    expect(isReservedPlatformHost('musterstadt.gremion.example', APEX)).toBe(false)
    expect(isReservedPlatformHost('www.rat-musterstadt.de', APEX)).toBe(false)
    expect(isReservedPlatformHost('mail.sub.gremion.example', APEX)).toBe(false)
  })

  it('refuses everything when PLATFORM_DOMAIN is empty rather than reserving nothing', () => {
    expect(() => reservedPlatformHosts('')).toThrow(
      'reservedPlatformHosts: PLATFORM_DOMAIN is unset — refusing to compute an empty reserved set',
    )
  })
})
