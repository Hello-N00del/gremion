// ASVS 4.0.3 V3.3.2 (L2) / NIST SP 800-63B AAL2: pins the kernel tenant session
// defaults - Keycloak realm template and the Auth.js app cookie.
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

vi.mock('$env/dynamic/private', () => ({ env: { AUTH_SECRET: 'test-secret' } }))
vi.mock('$lib/server/tenant/secrets', () => ({ resolveSecret: () => 's' }))

describe('session timeout defaults (V3.3.2 L2 / AAL2)', () => {
  it('tenant realm template: idle 1800 s, max 43200 s, access token 600 s', () => {
    const realm = JSON.parse(readFileSync(resolve(__dirname, '../../docker/keycloak/realm-export.base.json'), 'utf8'))
    expect(realm.ssoSessionIdleTimeout).toBe(1800)
    expect(realm.ssoSessionMaxLifespan).toBe(43200)
    expect(realm.accessTokenLifespan).toBe(600)
  })
  it('Auth.js session cookie maxAge is 43200 s (sliding JWT)', async () => {
    const { buildAuthConfig } = await import('./auth')
    const cfg = await buildAuthConfig({ locals: { tenant: {
      id: 'a', realmName: 'a', issuer: 'https://kc/realms/a', kcInternal: 'http://kc/realms/a',
      authExternalBase: 'https://kc/realms/a', authClientId: 'gremion-ui', authClientSecretRef: 'r', audiences: [],
    } } } as never)
    expect(cfg.session).toMatchObject({ strategy: 'jwt', maxAge: 43200 })
  })
})
