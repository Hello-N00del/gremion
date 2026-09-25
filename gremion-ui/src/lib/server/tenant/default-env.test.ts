import { describe, it, expect, beforeEach } from 'vitest'
// TASK-032 (TRD-410 [D R20-D5]): default-env.ts now reads process.env
// directly (kit 3 dropped $env/dynamic/private's free-form var access) — see
// process-env-mock.ts's header comment.
import { envMock, resetEnvMock } from '../../../../tests/unit/process-env-mock'

// P2.1c (T14, §7.7): defaultTenantEnv is the ONE allowlisted seam (it lives under
// lib/server/tenant/, exempt from the env-guard) through which the default tenant's
// per-tenant env reads — and genuinely deployment-global service URLs/creds — flow.
// Every former inline `env.<PER_TENANT_VAR>` read outside the resolver path now routes
// through here so the build-failing guard (--enforce) has exactly one place to point at.
describe('defaultTenantEnv (T14 §7.7 allowlisted seam)', () => {
  beforeEach(() => {
    resetEnvMock()
  })

  it('reads a value from process.env by name', async () => {
    envMock.MATRIX_URL = 'http://matrix:8008'
    const { defaultTenantEnv } = await import('./default-env')
    expect(defaultTenantEnv('MATRIX_URL')).toBe('http://matrix:8008')
  })

  it('returns undefined when the var is unset (caller supplies the fallback)', async () => {
    const { defaultTenantEnv } = await import('./default-env')
    expect(defaultTenantEnv('SOME_UNSET_VAR')).toBeUndefined()
  })

  it('reflects a later-set value (dynamic env, not a build-time snapshot)', async () => {
    const { defaultTenantEnv } = await import('./default-env')
    expect(defaultTenantEnv('HELIOS_URL')).toBeUndefined()
    envMock.HELIOS_URL = 'http://helios:8000'
    expect(defaultTenantEnv('HELIOS_URL')).toBe('http://helios:8000')
  })
})
