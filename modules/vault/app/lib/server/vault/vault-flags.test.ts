// src/lib/server/vault/vault-flags.test.ts
// Mirrors finance-flags.test.ts: both helpers read env at call-time, so a single
// mutable mock object covers all scenarios without vi.resetModules().
import { describe, it, expect, vi } from 'vitest'

const { mockEnv } = vi.hoisted(() => ({
  mockEnv: {} as Record<string, string | undefined>,
}))
vi.mock('$env/dynamic/private', () => ({ env: mockEnv }))

import { vaultStepUpEnforced, stepUpFreshnessSeconds } from './vault-flags'

describe('vaultStepUpEnforced (#405)', () => {
  it('defaults to TRUE when env var is unset (design contract: reveal needs fresh 2FA)', () => {
    delete mockEnv.VAULT_REVEAL_REQUIRE_STEPUP
    expect(vaultStepUpEnforced()).toBe(true)
  })

  it('is false ONLY for an explicit "false" (case-insensitive)', () => {
    for (const v of ['false', 'FALSE', 'False']) {
      mockEnv.VAULT_REVEAL_REQUIRE_STEPUP = v
      expect(vaultStepUpEnforced()).toBe(false)
    }
  })

  it('stays enforcing for any other value (fail-closed)', () => {
    for (const v of ['true', '1', '0', 'off', 'no', '']) {
      mockEnv.VAULT_REVEAL_REQUIRE_STEPUP = v
      expect(vaultStepUpEnforced()).toBe(true)
    }
  })
})

describe('stepUpFreshnessSeconds (vault mirror of #164)', () => {
  it('defaults to 300 when env var is unset', () => {
    delete mockEnv.STEPUP_FRESHNESS_SECONDS
    expect(stepUpFreshnessSeconds()).toBe(300)
  })

  it('returns the parsed positive integer', () => {
    mockEnv.STEPUP_FRESHNESS_SECONDS = '600'
    expect(stepUpFreshnessSeconds()).toBe(600)
  })

  it('falls back to 300 for non-numeric, zero, or negative values', () => {
    for (const v of ['abc', '', '0', '-1', 'Infinity']) {
      mockEnv.STEPUP_FRESHNESS_SECONDS = v
      expect(stepUpFreshnessSeconds()).toBe(300)
    }
  })
})
