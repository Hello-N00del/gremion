// P2.1c (T10) — D-WIZARD gate unit tests (pure; no IO).
import { describe, it, expect } from 'vitest'
import { assertMultiTenantEnabled, deploymentModeOf } from './wizard-gate'

describe('deploymentModeOf (defensive read; defaults to single)', () => {
  it('reads an explicit multi mode', () => {
    expect(deploymentModeOf({ deployment: { mode: 'multi' } })).toBe('multi')
  })
  it('reads an explicit single mode', () => {
    expect(deploymentModeOf({ deployment: { mode: 'single' } })).toBe('single')
  })
  it('defaults to single when the field is absent (T12 not yet applied / fresh config)', () => {
    expect(deploymentModeOf({})).toBe('single')
    expect(deploymentModeOf({ deployment: {} })).toBe('single')
    expect(deploymentModeOf(null)).toBe('single')
    expect(deploymentModeOf({ deployment: { mode: 'bogus' } })).toBe('single')
  })
})

describe('assertMultiTenantEnabled (D-WIZARD gate)', () => {
  it('passes when the default config says multi', () => {
    expect(() => assertMultiTenantEnabled({ deployment: { mode: 'multi' } })).not.toThrow()
  })
  it('refuses (naming the toggle) when single / absent', () => {
    expect(() => assertMultiTenantEnabled({ deployment: { mode: 'single' } })).toThrow(/deployment\.mode/)
    expect(() => assertMultiTenantEnabled({})).toThrow(/multi/i)
  })
})
