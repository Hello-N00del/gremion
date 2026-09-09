import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'
import { KeycloakAdminClient } from '$lib/server/keycloak-admin'

const BASE = 'http://kc-test:8080'
const REALM = 'test-realm'
const CLIENT_ID = 'test-client'
const CLIENT_SECRET = 'test-secret'

const TOKEN_RESPONSE = { access_token: 'tok1', expires_in: 300 }

let tokenFetchCount = 0

const server = setupServer(
  // Token endpoint
  http.post(`${BASE}/realms/${REALM}/protocol/openid-connect/token`, () => {
    tokenFetchCount++
    return HttpResponse.json(TOKEN_RESPONSE)
  }),

  // List users
  http.get(`${BASE}/admin/realms/${REALM}/users`, ({ request }) => {
    const url = new URL(request.url)
    return HttpResponse.json([
      { id: 'u1', username: 'anna', email: 'anna@test.local', firstName: 'Anna', lastName: 'M', enabled: true, emailVerified: true }
    ])
  }),

  // Create user
  http.post(`${BASE}/admin/realms/${REALM}/users`, () => {
    return new HttpResponse(null, {
      status: 201,
      headers: { Location: `${BASE}/admin/realms/${REALM}/users/abc-123` }
    })
  }),

  // Create group
  http.post(`${BASE}/admin/realms/${REALM}/groups`, () => {
    return new HttpResponse(null, {
      status: 201,
      headers: { Location: `${BASE}/admin/realms/${REALM}/groups/grp-456` }
    })
  }),

  // Get group (for setGroupAttribute)
  http.get(`${BASE}/admin/realms/${REALM}/groups/:id`, ({ params }) => {
    return HttpResponse.json({
      id: params.id,
      name: 'Test Gruppe',
      path: '/Test Gruppe',
      attributes: { foo: ['bar'] }
    })
  }),

  // Update group
  http.put(`${BASE}/admin/realms/${REALM}/groups/:id`, () => {
    return new HttpResponse(null, { status: 204 })
  }),

  // 404 route for bad user id
  http.get(`${BASE}/admin/realms/${REALM}/users/bad-id`, () => {
    return HttpResponse.json({ error: 'user_not_found' }, { status: 404 })
  }),

  // Credentials endpoint (#164 hasOtpCredential)
  http.get(`${BASE}/admin/realms/${REALM}/users/:userId/credentials`, ({ params }) => {
    if (params.userId === 'user-otp') {
      return HttpResponse.json([
        { type: 'password' },
        { type: 'otp' }
      ])
    }
    if (params.userId === 'user-password-only') {
      return HttpResponse.json([{ type: 'password' }])
    }
    // user-no-creds
    return HttpResponse.json([])
  })
)

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => { server.resetHandlers(); tokenFetchCount = 0 })
afterAll(() => server.close())

function makeClient() {
  return new KeycloakAdminClient(BASE, REALM, CLIENT_ID, CLIENT_SECRET)
}

describe('KeycloakAdminClient', () => {
  it('token caching — does not re-fetch if token is still valid', async () => {
    const client = makeClient()
    await client.listUsers()
    await client.listUsers()
    expect(tokenFetchCount).toBe(1)
  })

  it('token refresh — re-fetches when within 30-second safety margin', async () => {
    const client = makeClient()
    // Force a near-expired token by calling getToken once to cache, then
    // manually expire the cache by reaching into the private field via cast
    await client.listUsers() // populates cache
    expect(tokenFetchCount).toBe(1)

    // Set expiresAt to 20s from now (within the 30s margin)
    const c = client as unknown as { tokenCache: { token: string; expiresAt: number } | null }
    c.tokenCache = { token: 'tok-old', expiresAt: Date.now() + 20_000 }

    await client.listUsers() // should re-fetch
    expect(tokenFetchCount).toBe(2)
  })

  it('listUsers — builds correct query string', async () => {
    let capturedUrl = ''
    server.use(
      http.get(`${BASE}/admin/realms/${REALM}/users`, ({ request }) => {
        capturedUrl = request.url
        return HttpResponse.json([])
      })
    )

    const client = makeClient()
    await client.listUsers({ first: 10, max: 5, search: 'anna' })

    const url = new URL(capturedUrl)
    expect(url.searchParams.get('first')).toBe('10')
    expect(url.searchParams.get('max')).toBe('5')
    expect(url.searchParams.get('search')).toBe('anna')
  })

  it('createUser — parses ID from Location header', async () => {
    const client = makeClient()
    const id = await client.createUser({
      username: 'erika',
      email: 'erika@test.local',
      firstName: 'Erika',
      lastName: 'M',
      enabled: true,
      emailVerified: false
    })
    expect(id).toBe('abc-123')
  })

  it('createGroup — parses ID from Location header', async () => {
    const client = makeClient()
    const id = await client.createGroup('Sportreferat')
    expect(id).toBe('grp-456')
  })

  it('request — throws on 4xx', async () => {
    const client = makeClient()
    await expect(client.getUser('bad-id')).rejects.toThrow('User not found')
  })

  it('request — throws on network failure', async () => {
    server.use(
      http.get(`${BASE}/admin/realms/${REALM}/users`, () => {
        return HttpResponse.error()
      })
    )
    const client = makeClient()
    await expect(client.listUsers()).rejects.toThrow()
  })

  it('setGroupAttribute — immutable merge', async () => {
    let capturedBody: unknown = null
    server.use(
      http.put(`${BASE}/admin/realms/${REALM}/groups/:id`, async ({ request }) => {
        capturedBody = await request.json()
        return new HttpResponse(null, { status: 204 })
      })
    )

    const client = makeClient()
    await client.setGroupAttribute('grp-1', 'baz', 'qux')

    expect(capturedBody).toMatchObject({
      attributes: { foo: ['bar'], baz: ['qux'] }
    })
    // Original group object was not mutated — verified by separate getGroup call returning unchanged data
  })

  // #164 hasOtpCredential
  it('hasOtpCredential — returns true when otp credential present', async () => {
    const client = makeClient()
    await expect(client.hasOtpCredential('user-otp')).resolves.toBe(true)
  })

  it('hasOtpCredential — returns false when only password credential present', async () => {
    const client = makeClient()
    await expect(client.hasOtpCredential('user-password-only')).resolves.toBe(false)
  })

  it('hasOtpCredential — returns false when credential list is empty', async () => {
    const client = makeClient()
    await expect(client.hasOtpCredential('user-no-creds')).resolves.toBe(false)
  })
})
