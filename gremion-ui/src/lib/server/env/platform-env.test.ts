// TASK-042 TDD 7 (Q4, TRD-075, PRD-PLAT-012): platformEnv is the one reader of
// DEPLOYMENT-GLOBAL environment variables. There is no default tenant any more,
// so no per-tenant variable may be read from the process env: every name the
// build-time env guard classes as per-tenant is refused, loudly, naming it.
import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { platformEnv, PLATFORM_ENV_NAMES } from './platform-env'

const saved = { NATS_URL: process.env.NATS_URL }

describe('platformEnv (deployment-global env only, TASK-042 Q4)', () => {
  afterEach(() => {
    if (saved.NATS_URL === undefined) delete process.env.NATS_URL
    else process.env.NATS_URL = saved.NATS_URL
  })

  it('returns a set deployment-global variable, read from process.env at call time', () => {
    process.env.NATS_URL = 'nats://nats-a:4222'
    expect(platformEnv('NATS_URL')).toBe('nats://nats-a:4222')
    process.env.NATS_URL = 'nats://nats-b:4222'
    expect(platformEnv('NATS_URL')).toBe('nats://nats-b:4222')
  })

  it('returns undefined when the variable is unset (the caller supplies its fallback)', () => {
    delete process.env.NATS_URL
    expect(platformEnv('NATS_URL')).toBeUndefined()
  })

  it.each(['LIVEKIT_URL', 'AUTH_KEYCLOAK_ISSUER', 'AUTH_KEYCLOAK_BASE', 'CONFIG_PATH', 'KEYCLOAK_ADMIN_URL', 'MATRIX_URL', 'DATABASE_URL', 'NEXTCLOUD_URL'])(
    'refuses the per-tenant name %s, naming it',
    (name) => {
      expect(() => platformEnv(name)).toThrow(new RegExp(`platformEnv: ${name} is a per-tenant variable`))
    },
  )

  it('refuses a name outside its closed list, naming it', () => {
    expect(() => platformEnv('SOMETHING_ELSE')).toThrow(/platformEnv: SOMETHING_ELSE is not a deployment-global variable/)
  })

  it('its closed list holds NATS_URL and no per-tenant name', () => {
    expect(PLATFORM_ENV_NAMES).toContain('NATS_URL')
    for (const n of PLATFORM_ENV_NAMES) expect(() => platformEnv(n)).not.toThrow()
  })
})

// TASK-042 R28 (MEDIUM 6): the per-tenant name list is RUNTIME data shared by
// this module and the build-time guard (scripts/check-tenant-env-guard.mjs).
// The runtime module owns it; the CLI script imports it, never the reverse, so
// no server module depends on an untyped (@ts-nocheck) build script.
describe('the per-tenant env name list is single-sourced in a runtime module', () => {
  const here = dirname(fileURLToPath(import.meta.url))

  it('platform-env.ts imports nothing from scripts/', () => {
    const src = readFileSync(resolve(here, 'platform-env.ts'), 'utf-8')
    expect(src).not.toMatch(/from\s+['"][^'"]*scripts\//)
  })

  it('the guard classifies exactly what the shared runtime module classifies', async () => {
    const shared = await import('./per-tenant-env-names.js')
    const guard = await import('../../../../scripts/check-tenant-env-guard.mjs')
    expect(guard.EXACT_VARS).toBe(shared.PER_TENANT_EXACT_VARS)
    expect(guard.PREFIX_VARS).toBe(shared.PER_TENANT_PREFIX_VARS)
    for (const n of ['CONFIG_PATH', 'LIVEKIT_URL', 'AUTH_KEYCLOAK_ISSUER', 'NATS_URL', 'PLATFORM_DOMAIN']) {
      expect(shared.isPerTenantEnvName(n)).toBe(n !== 'NATS_URL' && n !== 'PLATFORM_DOMAIN')
    }
  })
})
