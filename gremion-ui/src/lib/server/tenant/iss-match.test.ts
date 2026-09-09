import { describe, expect, it } from 'vitest'
import { assertIssMatch, normalizeIssuer } from './iss-match'

describe('normalizeIssuer', () => {
  it('strips a single trailing slash', () => {
    expect(normalizeIssuer('https://id.example.org/realms/a/')).toBe('https://id.example.org/realms/a')
  })
  it('leaves a slash-free issuer unchanged', () => {
    expect(normalizeIssuer('https://id.example.org/realms/a')).toBe('https://id.example.org/realms/a')
  })
  it('returns empty string for undefined', () => {
    expect(normalizeIssuer(undefined)).toBe('')
  })
  it('trims surrounding whitespace (formatting drift -> canonical form)', () => {
    expect(normalizeIssuer('  https://id.example.org/realms/a  ')).toBe('https://id.example.org/realms/a')
  })
  it('collapses any run of trailing slashes', () => {
    expect(normalizeIssuer('https://id.example.org/realms/a///')).toBe('https://id.example.org/realms/a')
  })
  it('does NOT case-fold or alter the scheme/host/path (gate stays byte-strict)', () => {
    expect(normalizeIssuer('https://ID.example.org/Realms/A')).toBe('https://ID.example.org/Realms/A')
  })
})

describe('assertIssMatch', () => {
  it('true when token iss equals tenant issuer', () => {
    expect(assertIssMatch({ tokenIss: 'https://id/realms/stura', tenantIssuer: 'https://id/realms/stura' })).toBe(true)
  })
  it('true ignoring a trailing-slash difference', () => {
    expect(assertIssMatch({ tokenIss: 'https://id/realms/stura/', tenantIssuer: 'https://id/realms/stura' })).toBe(true)
  })
  it('false when token iss belongs to a DIFFERENT realm (the replay case)', () => {
    expect(assertIssMatch({ tokenIss: 'https://id/realms/tenant-a', tenantIssuer: 'https://id/realms/tenant-b' })).toBe(false)
  })
  it('false (fail-closed) when token iss is undefined', () => {
    expect(assertIssMatch({ tokenIss: undefined, tenantIssuer: 'https://id/realms/stura' })).toBe(false)
  })
  it('false (fail-closed) when tenant issuer is empty', () => {
    expect(assertIssMatch({ tokenIss: 'https://id/realms/stura', tenantIssuer: '' })).toBe(false)
  })
  it('tolerates whitespace/double-slash drift on a genuine match (availability)', () => {
    expect(assertIssMatch({ tokenIss: ' https://id/realms/stura// ', tenantIssuer: 'https://id/realms/stura' })).toBe(true)
  })
  it('STILL rejects distinct realms even with formatting drift (gate holds)', () => {
    expect(assertIssMatch({ tokenIss: ' https://id/realms/tenant-a/ ', tenantIssuer: 'https://id/realms/tenant-b' })).toBe(false)
  })
})
