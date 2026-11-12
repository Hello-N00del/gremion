import { describe, it, expect } from 'vitest'
import { configuredPortalDomain } from './portal-domain'

describe('configuredPortalDomain', () => {
  it('returns null when nothing is configured', () => {
    expect(configuredPortalDomain(undefined)).toBeNull()
    expect(configuredPortalDomain(null)).toBeNull()
    expect(configuredPortalDomain('')).toBeNull()
    expect(configuredPortalDomain('   ')).toBeNull()
  })

  it('treats local-only placeholders as not configured', () => {
    expect(configuredPortalDomain('localhost')).toBeNull()
    expect(configuredPortalDomain(' LocalHost ')).toBeNull()
    expect(configuredPortalDomain('127.0.0.1')).toBeNull()
    expect(configuredPortalDomain('portal.localhost')).toBeNull()
  })

  it('returns the trimmed domain when one is set', () => {
    expect(configuredPortalDomain(' stura.example.org ')).toBe('stura.example.org')
  })
})
