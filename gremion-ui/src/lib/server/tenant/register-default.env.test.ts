// src/lib/server/tenant/register-default.env.test.ts
// Guard: the default tenant's identity comes from env, never from a literal.
//
// registerDefaultTenant used to fall back to the operator's own staging
// deployment when the auth env was unset — a fresh clone booted and registered
// tenant #1 with an issuer pointing at somebody else's host. This suite pins
// the replacement contract: no host-bearing defaults, fail loudly instead, and
// derive the realm from the issuer the operator actually configured.
import { describe, it, expect, beforeEach, vi } from 'vitest'

const envMock = vi.hoisted(() => ({}) as Record<string, string | undefined>)
vi.mock('$env/dynamic/private', () => ({ env: envMock }))
// The env resolution must happen BEFORE anything touches the control plane, so
// both collaborators are stubbed to fail loudly if the code gets that far.
vi.mock('./control-db', () => ({
  getControlDb: () => {
    throw new Error('control DB reached — env resolution did not fail first')
  },
}))
vi.mock('./registry', () => ({
  getTenantBySlug: async () => {
    throw new Error('registry reached — env resolution did not fail first')
  },
}))

import { registerDefaultTenant, resolveDefaultTenantEnv } from './register-default'

const ISSUER = 'https://council.example/auth/realms/council'

beforeEach(() => {
  for (const k of Object.keys(envMock)) delete envMock[k]
})

describe('registerDefaultTenant — env is the only source of tenant #1 identity', () => {
  it('refuses to boot with AUTH_KEYCLOAK_ISSUER unset instead of defaulting to a host', async () => {
    await expect(registerDefaultTenant()).rejects.toThrow(/AUTH_KEYCLOAK_ISSUER/)
  })

  it('names no deployment host in the failure message', async () => {
    let caught: unknown
    try {
      await registerDefaultTenant()
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(Error)
    // Not "no retired host" — no host at all. A message that hands the reader a
    // URL is how the literal came back last time.
    const message = (caught as Error).message
    expect(message).not.toMatch(/https?:/)
    expect(message).not.toMatch(/sturaos/i)
  })
})

describe('resolveDefaultTenantEnv', () => {
  it('derives the realm name from the issuer when KEYCLOAK_REALM is unset', () => {
    envMock.AUTH_KEYCLOAK_ISSUER = ISSUER
    expect(resolveDefaultTenantEnv().realmName).toBe('council')
  })

  it('lets KEYCLOAK_REALM win over the derived value', () => {
    envMock.AUTH_KEYCLOAK_ISSUER = ISSUER
    envMock.KEYCLOAK_REALM = 'explicit'
    expect(resolveDefaultTenantEnv().realmName).toBe('explicit')
  })

  it('rejects an issuer that carries no /realms/<name> segment', () => {
    envMock.AUTH_KEYCLOAK_ISSUER = 'https://council.example/auth'
    expect(() => resolveDefaultTenantEnv()).toThrow(/KEYCLOAK_REALM/)
  })

  it('strips a trailing slash and reuses the issuer as the internal URL', () => {
    envMock.AUTH_KEYCLOAK_ISSUER = `${ISSUER}/`
    const r = resolveDefaultTenantEnv()
    expect(r.issuer).toBe(ISSUER)
    expect(r.kcInternal).toBe(ISSUER)
  })

  it('honours AUTH_KEYCLOAK_INTERNAL when the cluster-internal URL differs', () => {
    envMock.AUTH_KEYCLOAK_ISSUER = ISSUER
    envMock.AUTH_KEYCLOAK_INTERNAL = 'http://keycloak:8080/auth/realms/council/'
    expect(resolveDefaultTenantEnv().kcInternal).toBe('http://keycloak:8080/auth/realms/council')
  })

  it('leaves matrix_space empty when no messaging module supplies a server name', () => {
    envMock.AUTH_KEYCLOAK_ISSUER = ISSUER
    expect(resolveDefaultTenantEnv().matrixSpace).toEqual({})
  })

  it('records only the configured Matrix server name when one is set', () => {
    envMock.AUTH_KEYCLOAK_ISSUER = ISSUER
    envMock.SYNAPSE_SERVER_NAME = 'matrix.council.example'
    expect(resolveDefaultTenantEnv().matrixSpace).toEqual({ serverName: 'matrix.council.example' })
  })
})
