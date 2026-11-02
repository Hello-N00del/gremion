import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { RequestEvent } from '@sveltejs/kit'
import { Auth, setEnvDefaults } from '@auth/core'

// Issue #87: Auth.js `setEnvDefaults` does `provider.issuer ??= env.AUTH_KEYCLOAK_ISSUER`.
// The Keycloak() factory keeps a caller-supplied issuer under `provider.options`, so the
// top-level `provider.issuer` stayed undefined and an env value of '' (a compose
// `${AUTH_KEYCLOAK_ISSUER:-}` pass-through on a host install) landed there. `assertConfig`
// reads `provider.issuer ?? provider.options?.issuer`, gets '' (not nullish) and throws
// InvalidEndpoints, so every page behind auth returned 500.
//
// These tests drive Auth.js's REAL path: the exported setEnvDefaults, then the public
// Auth() entry (which runs assertConfig first and answers 500 on a config error).

const envMock: Record<string, string> = {}
vi.mock('$env/dynamic/private', () => ({ env: envMock }))
vi.mock('$lib/server/tenant/secrets', () => ({ resolveSecret: (ref: string) => `secret-for-${ref}` }))

const TENANT_ISSUER = 'https://kc.example.org/realms/tenant-a'
const tenant = {
  id: 'a', realmName: 'tenant-a', issuer: TENANT_ISSUER,
  kcInternal: 'http://keycloak:8080/auth/realms/tenant-a', authExternalBase: TENANT_ISSUER,
  authClientId: 'gremion-ui', authClientSecretRef: 'ui-a', audiences: ['gremion-ui'],
}
const event = { locals: { tenant } } as unknown as RequestEvent

type P = Record<string, unknown> & { options?: Record<string, unknown> }

async function buildWithProcessEnv(authKeycloakIssuer: string | undefined) {
  const { buildAuthConfig } = await import('./auth')
  const cfg = await buildAuthConfig(event)
  const processEnv: Record<string, string | undefined> = { AUTH_KEYCLOAK_ISSUER: authKeycloakIssuer }
  setEnvDefaults(processEnv, cfg)
  return cfg
}

async function providersStatus(cfg: Awaited<ReturnType<typeof buildWithProcessEnv>>) {
  const res = await Auth(new Request('http://localhost/auth/providers'), cfg as never)
  return res.status
}

describe('buildAuthConfig survives an env-level AUTH_KEYCLOAK_ISSUER (issue #87)', () => {
  beforeEach(() => { envMock.AUTH_SECRET = 'test-secret' })

  it('empty-string env: the provider issuer is the tenant issuer and Auth.js config assertion passes', async () => {
    const cfg = await buildWithProcessEnv('')
    const provider = (cfg.providers as unknown as P[])[0]
    expect(await providersStatus(cfg)).toBe(200)
    expect(provider.issuer).toBe(TENANT_ISSUER)
    expect(provider.options?.issuer).toBe(TENANT_ISSUER)
  })

  it('decoy env value: the tenant issuer wins', async () => {
    const cfg = await buildWithProcessEnv('https://decoy.example/auth/realms/decoy')
    const provider = (cfg.providers as unknown as P[])[0]
    expect(provider.issuer).toBe(TENANT_ISSUER)
    expect(provider.options?.issuer).toBe(TENANT_ISSUER)
    expect(await providersStatus(cfg)).toBe(200)
  })

  it('unset env: still passes (the path that already worked)', async () => {
    const cfg = await buildWithProcessEnv(undefined)
    expect((cfg.providers as unknown as P[])[0].issuer).toBe(TENANT_ISSUER)
    expect(await providersStatus(cfg)).toBe(200)
  })
})
