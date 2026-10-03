// TASK-205 (Q5): serviceEnv is the fallback tier the module in-process halves read for the
// deployment-wide service endpoints that platformEnv (TASK-042) refuses by design. It serves ONLY an
// explicit frozen list of service-endpoint names (verifier r1 MEDIUM: serving every per-tenant-classed
// name handed DATABASE_URL, CONFIG_PATH, KEYCLOAK_REALM and the AUTH_KEYCLOAK_* secrets out process-wide,
// which is what TASK-042 removed). platformEnv and serviceEnv together still never hand out an arbitrary
// process variable.
import { describe, it, expect, afterEach } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { serviceEnv } from './service-env'
import { platformEnv, PLATFORM_ENV_NAMES } from './platform-env'
import { isPerTenantEnvName } from './per-tenant-env-names.js'
import { SERVICE_ENDPOINT_NAMES } from './service-endpoint-names.js'

const NAMES = ['NEXTCLOUD_URL', 'NEXTCLOUD_ADMIN_USER', 'CALDAV_SHARED_USER', 'MATRIX_URL', 'HELIOS_URL', 'LIVEKIT_URL'] as const
const saved = new Map(NAMES.map((n) => [n, process.env[n]]))

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..')

/** Every literal `serviceEnv('X')` name a module app half (or the shell) calls, from the real tree. */
function calledNames(): Set<string> {
  const out = new Set<string>()
  const re = /\bserviceEnv\(\s*['"]([A-Z0-9_]+)['"]/g
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name.startsWith('.')) continue
      const abs = path.join(dir, name)
      if (statSync(abs).isDirectory()) walk(abs)
      else if (/\.(ts|svelte)$/.test(name) && !/\.test\.ts$/.test(name)) {
        for (const m of readFileSync(abs, 'utf8').matchAll(re)) out.add(m[1])
      }
    }
  }
  walk(path.join(REPO_ROOT, 'modules'))
  return out
}

describe('serviceEnv (service-endpoint fallback for module halves, TASK-205 Q5)', () => {
  afterEach(() => {
    for (const [n, v] of saved) {
      if (v === undefined) delete process.env[n]
      else process.env[n] = v
    }
  })

  it.each(NAMES)('returns the set service variable %s, read from process.env at call time', (name) => {
    process.env[name] = 'value-a'
    expect(serviceEnv(name)).toBe('value-a')
    process.env[name] = 'value-b'
    expect(serviceEnv(name)).toBe('value-b')
  })

  it('returns undefined when the variable is unset (the caller supplies its own fallback)', () => {
    delete process.env.NEXTCLOUD_URL
    expect(serviceEnv('NEXTCLOUD_URL')).toBeUndefined()
  })

  it.each(['NATS_URL', 'TENANT_DATA_ROOT', 'PLATFORM_DOMAIN', 'PATH', 'HOME', 'DATABASE_PASSWORD', 'SOMETHING_ELSE'])(
    'refuses %s: not a service endpoint, so never served here',
    (name) => {
      expect(() => serviceEnv(name)).toThrow(new RegExp(`serviceEnv: ${name} is not a service-endpoint variable`))
    },
  )

  // verifier r1 MEDIUM: per-tenant-classed is NOT the same as service endpoint. The tenant's database, its
  // config path, its realm/admin URL and its OIDC client secret are resolved from the tenant only; serving
  // them here re-opened the process-wide read TASK-042 removed.
  it.each(['DATABASE_URL', 'CONFIG_PATH', 'KEYCLOAK_REALM', 'KEYCLOAK_ADMIN_URL', 'AUTH_KEYCLOAK_SECRET', 'AUTH_KEYCLOAK_ID', 'NEXTCLOUD_NOT_AN_ENDPOINT', 'LIVEKIT_SOMETHING'])(
    'refuses the per-tenant non-endpoint name %s',
    (name) => {
      expect(isPerTenantEnvName(name)).toBe(true)
      expect(() => serviceEnv(name)).toThrow(new RegExp(`serviceEnv: ${name} is not a service-endpoint variable`))
    },
  )

  it('the service-endpoint list is frozen and a strict subset of the per-tenant class', () => {
    expect(Object.isFrozen(SERVICE_ENDPOINT_NAMES)).toBe(true)
    expect(() => (SERVICE_ENDPOINT_NAMES as string[]).push('DATABASE_URL')).toThrow()
    for (const name of SERVICE_ENDPOINT_NAMES) expect(isPerTenantEnvName(name), name).toBe(true)
    expect(SERVICE_ENDPOINT_NAMES).not.toContain('DATABASE_URL')
  })

  it('serves every name a module half actually calls (the frozen list is not narrower than its callers)', () => {
    const called = calledNames()
    expect(called.size).toBeGreaterThanOrEqual(10)
    for (const name of called) expect(() => serviceEnv(name), name).not.toThrow()
  })

  it('is the exact complement of platformEnv: no name is served by both', () => {
    for (const name of PLATFORM_ENV_NAMES) {
      expect(isPerTenantEnvName(name)).toBe(false)
      expect(() => serviceEnv(name)).toThrow(/not a service-endpoint variable/)
    }
    for (const name of NAMES) {
      expect(() => platformEnv(name)).toThrow(/per-tenant variable/)
      expect(() => serviceEnv(name)).not.toThrow()
    }
  })
})
