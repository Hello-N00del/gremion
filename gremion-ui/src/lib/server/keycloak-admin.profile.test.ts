// The profile unit's two admin-client calls: a name-only update that survives
// every other field of the user, and the required-action availability probe.
import { describe, it, expect, vi } from 'vitest'

vi.mock('$env/dynamic/private', () => ({ env: {} }))
vi.mock('$lib/server/tenant/secrets', () => ({ resolveSecret: (ref: string) => `secret-for-${ref}` }))

import { KeycloakAdminClient, KcAdminError } from './keycloak-admin'

const urlOf = (input: string | URL | Request): string => (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)

/** The user as Keycloak returns it: more than KcUser declares (requiredActions, federation link ...). */
const STORED = {
  id: 'u-1',
  username: 'anna.example',
  email: 'anna@example.org',
  emailVerified: true,
  firstName: 'Anna',
  lastName: 'Alt',
  enabled: true,
  attributes: { locale: ['de'], department: ['Finanzen'] },
  requiredActions: ['CONFIGURE_TOTP'],
  createdTimestamp: 1700000000000,
  federationLink: 'fed-1',
}

function client(fetchImpl: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: { method: string; url: string; body: unknown }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = urlOf(input)
      if (url.includes('/protocol/openid-connect/token')) {
        return new Response(JSON.stringify({ access_token: 't', expires_in: 300 }), { status: 200 })
      }
      calls.push({ method: init?.method ?? 'GET', url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined })
      return fetchImpl(url, init)
    }),
  )
  return { kc: new KeycloakAdminClient('http://keycloak:8080/auth', 'realm-a', 'admin', 'secret'), calls }
}

describe('KeycloakAdminClient.updateUserNames', () => {
  it('reads the stored user and PUTs it back whole with only firstName and lastName changed', async () => {
    const { kc, calls } = client((_u, init) =>
      (init?.method ?? 'GET') === 'GET' ? new Response(JSON.stringify(STORED), { status: 200 }) : new Response(null, { status: 204 }),
    )
    await kc.updateUserNames('u-1', { firstName: 'Anna Maria', lastName: 'Neu' })

    expect(calls.map((c) => c.method)).toEqual(['GET', 'PUT'])
    expect(calls[1]!.url).toBe('http://keycloak:8080/auth/admin/realms/realm-a/users/u-1')
    expect(calls[1]!.body).toEqual({ ...STORED, firstName: 'Anna Maria', lastName: 'Neu' })
    // the fields a bare PUT would blank or reset
    const put = calls[1]!.body as Record<string, unknown>
    expect(put.email).toBe('anna@example.org')
    expect(put.username).toBe('anna.example')
    expect(put.enabled).toBe(true)
    expect(put.attributes).toEqual(STORED.attributes)
    expect(put.requiredActions).toEqual(['CONFIGURE_TOTP'])
  })

  it('does not write when the user cannot be read', async () => {
    const { kc, calls } = client(() => new Response('{}', { status: 404 }))
    await expect(kc.updateUserNames('u-1', { firstName: 'A', lastName: 'B' })).rejects.toThrow('User not found')
    expect(calls.map((c) => c.method)).toEqual(['GET'])
  })

  it('refuses an id that cannot be one path segment', async () => {
    const { kc, calls } = client(() => new Response('{}', { status: 200 }))
    await expect(kc.updateUserNames('..', { firstName: 'A', lastName: 'B' })).rejects.toThrow('Invalid Keycloak id')
    expect(calls).toEqual([])
  })
})

describe('KeycloakAdminClient.isRequiredActionEnabled', () => {
  it('is true only for an enabled action', async () => {
    const { kc, calls } = client(() => new Response(JSON.stringify({ alias: 'UPDATE_EMAIL', enabled: true }), { status: 200 }))
    expect(await kc.isRequiredActionEnabled('UPDATE_EMAIL')).toBe(true)
    expect(calls[0]!.url).toBe('http://keycloak:8080/auth/admin/realms/realm-a/authentication/required-actions/UPDATE_EMAIL')
  })
  it('is false for a disabled action', async () => {
    const { kc } = client(() => new Response(JSON.stringify({ alias: 'UPDATE_EMAIL', enabled: false }), { status: 200 }))
    expect(await kc.isRequiredActionEnabled('UPDATE_EMAIL')).toBe(false)
  })
  it('is false when the realm does not know the action (404)', async () => {
    const { kc } = client(() => new Response('{}', { status: 404 }))
    expect(await kc.isRequiredActionEnabled('UPDATE_EMAIL')).toBe(false)
  })
  it('rejects on any other failure, so the caller can choose its default', async () => {
    const { kc } = client(() => new Response('nope', { status: 500 }))
    await expect(kc.isRequiredActionEnabled('UPDATE_EMAIL')).rejects.toBeInstanceOf(KcAdminError)
  })
})
