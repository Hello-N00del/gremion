// TASK-205 (Q5): serviceEnv is the fallback tier the module in-process halves read for the
// deployment-wide service endpoints that platformEnv (TASK-042) refuses by design. It serves ONLY the
// names the per-tenant list classes; it is the complement of platformEnv, so the two together can never
// hand out an arbitrary process variable.
import { describe, it, expect, afterEach } from 'vitest'
import { serviceEnv } from './service-env'
import { platformEnv, PLATFORM_ENV_NAMES } from './platform-env'
import { isPerTenantEnvName } from './per-tenant-env-names.js'

const NAMES = ['NEXTCLOUD_URL', 'NEXTCLOUD_ADMIN_USER', 'CALDAV_SHARED_USER', 'MATRIX_URL', 'HELIOS_URL', 'LIVEKIT_URL'] as const
const saved = new Map(NAMES.map((n) => [n, process.env[n]]))

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
    'refuses %s: not a per-tenant-classed service endpoint, so never served here',
    (name) => {
      expect(() => serviceEnv(name)).toThrow(new RegExp(`serviceEnv: ${name} is not a service-endpoint variable`))
    },
  )

  it('is the exact complement of platformEnv: no name is served by both', () => {
    for (const name of PLATFORM_ENV_NAMES) {
      expect(isPerTenantEnvName(name)).toBe(false)
      expect(() => serviceEnv(name)).toThrow()
    }
    for (const name of NAMES) {
      expect(() => platformEnv(name)).toThrow(/per-tenant variable/)
      expect(() => serviceEnv(name)).not.toThrow()
    }
  })
})
