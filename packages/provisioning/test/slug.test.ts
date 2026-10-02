// TDD 1 (TASK-043): the customer slug and its token.
import { describe, expect, it } from 'vitest'
import { assertCustomerSlug, principalFor, ProvisioningError, RESERVED_SLUGS, tokenFor } from '../src/index.ts'

describe('customer slug (SCHEMA customer_slug_check, capped at 30 by the host/DB rule)', () => {
  it.each([
    ['1ab', 'leading digit'],
    ['ab', 'too short'],
    ['a--b', 'double hyphen'],
    ['abc-', 'trailing hyphen'],
    ['platform', 'reserved for the ops realm'],
    ['a'.repeat(31), '31 characters'],
    ['Abc', 'upper case'],
    ['ab_c', 'underscore'],
    ['', 'empty'],
  ])('refuses %j (%s)', (slug) => {
    expect(() => assertCustomerSlug(slug)).toThrow(ProvisioningError)
  })

  it('accepts a 30-character slug and a hyphenated one', () => {
    expect(assertCustomerSlug('a'.repeat(30))).toBe('a'.repeat(30))
    expect(assertCustomerSlug('abc-de')).toBe('abc-de')
  })

  it('reserves every edge-owned and shared-infra label as well as platform', () => {
    for (const s of ['platform', 'gremion', 'keycloak', 'public', 'cloud', 'matrix', 'elections', 'control', 'postgres']) {
      expect(RESERVED_SLUGS.has(s)).toBe(true)
      expect(() => assertCustomerSlug(s)).toThrow(/reserved/)
    }
  })

  it('refuses a non-string', () => {
    expect(() => assertCustomerSlug(undefined as unknown as string)).toThrow(ProvisioningError)
  })
})

describe('tenant token and submission principal', () => {
  it('abc-de -> abc_de, kc-abc_de@<domain>', () => {
    expect(tokenFor('abc-de')).toBe('abc_de')
    expect(principalFor('abc_de', 'platform.example')).toBe('kc-abc_de@platform.example')
  })

  it('the token of every valid slug matches the principal CLI token rule', () => {
    for (const s of ['abc', 'abc-de', 'x1-y2-z3', 'a'.repeat(30)]) {
      expect(tokenFor(s)).toMatch(/^[a-z][a-z0-9_]{2,39}$/)
    }
  })

  it('tokenFor refuses what assertCustomerSlug refuses', () => {
    expect(() => tokenFor('1ab')).toThrow(ProvisioningError)
  })

  it('principalFor refuses a bad token or domain', () => {
    expect(() => principalFor('ab', 'platform.example')).toThrow(ProvisioningError)
    expect(() => principalFor('abc_de', 'not a domain')).toThrow(ProvisioningError)
  })
})
