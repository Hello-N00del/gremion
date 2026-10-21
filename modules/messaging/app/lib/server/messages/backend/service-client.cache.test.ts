// The service-mode Matrix token cache must not expire with the Keycloak access
// token: every rotation re-exchanged through the leaf, and since all web users
// log in from the one app-server address, Synapse's per-address login limit
// answered 429. The Matrix token has its own fixed 1 h TTL.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'

vi.mock('$lib/server/tenant/context', () => ({
  getTenant: () => ({ id: 'tenant-1', slug: 'default' }),
}))
vi.mock('$lib/server/messages/matrix-creds', () => ({
  getKeycloakJwt: vi.fn(async () => 'kc-jwt'),
}))
vi.mock('$lib/server/messages/livekit-client', () => ({
  roomNameFromMatrixId: (id: string) => `room-${id}`,
  dmRoomName: () => 'dm-x',
}))

import { ServiceMessagesClient, __resetServiceMatrixTokenCacheForTests } from './service-client'

function jsonRes(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function jwtWith(sub: string, expSecondsFromNow: number): string {
  const payload = Buffer.from(
    JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + expSecondsFromNow }),
  ).toString('base64url')
  return `h.${payload}.s`
}

const ENV_KEYS = ['MESSAGES_SERVICE_URL', 'INTERNAL_MESSAGES_SECRET'] as const
let envSnapshot: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {}

beforeEach(() => {
  envSnapshot = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  process.env.MESSAGES_SERVICE_URL = 'http://messages-service:8080'
  process.env.INTERNAL_MESSAGES_SECRET = 's3cr3t'
  __resetServiceMatrixTokenCacheForTests()
  vi.useFakeTimers({ toFake: ['Date'] })
})

afterEach(() => {
  vi.useRealTimers()
  for (const k of ENV_KEYS) {
    const prior = envSnapshot[k]
    if (prior === undefined) delete process.env[k]
    else process.env[k] = prior
  }
  __resetServiceMatrixTokenCacheForTests()
})

describe('ServiceMatrixClient token cache', () => {
  it('serves the cached token past the Keycloak exp; re-exchanges only after the 1 h TTL', async () => {
    let n = 0
    const fetchImpl = vi.fn(async () => jsonRes({ matrixToken: `mx-${++n}`, matrixUserId: '@u:s' }))
    const c = new ServiceMessagesClient({ fetchImpl })
    expect(await c.matrix().getMatrixToken(jwtWith('user-ttl', 600))).toBe('mx-1')
    vi.advanceTimersByTime(15 * 60_000) // the 10-min Keycloak token has rotated
    expect(await c.matrix().getMatrixToken(jwtWith('user-ttl', 600))).toBe('mx-1')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(46 * 60_000) // past 1 h since the exchange
    expect(await c.matrix().getMatrixToken(jwtWith('user-ttl', 600))).toBe('mx-2')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('still refuses a fresh exchange with an expired Keycloak JWT', async () => {
    const fetchImpl = vi.fn(async () => jsonRes({ matrixToken: 'mx-1', matrixUserId: '@u:s' }))
    const c = new ServiceMessagesClient({ fetchImpl })
    await expect(c.matrix().getMatrixToken(jwtWith('user-old', -10))).rejects.toThrow(/expired/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
