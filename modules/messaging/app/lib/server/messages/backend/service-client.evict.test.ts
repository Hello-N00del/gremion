// Service mode: when the leaf reports that Synapse invalidated the user token a
// call carried (structured errcode M_UNKNOWN_TOKEN, status stays 502), the
// cached Matrix token must be dropped so the next getMatrixToken re-exchanges
// instead of failing until the 1 h TTL.
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

import { ServiceMessagesClient, MessagesServiceError, __resetServiceMatrixTokenCacheForTests } from './service-client'

function jsonRes(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function jwtWith(sub: string, expSecondsFromNow = 3600): string {
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

const isExchange = (url: unknown) => String(url).endsWith('/api/v1/auth/matrix-token')
const exchanges = (f: ReturnType<typeof vi.fn>) => f.mock.calls.filter((c) => isExchange(c[0])).length

describe('service mode evicts a Matrix token Synapse invalidated (leaf errcode M_UNKNOWN_TOKEN)', () => {
  function leaf() {
    let n = 0
    const fetchImpl = vi.fn(async (url: string) => {
      if (isExchange(url)) return jsonRes({ matrixToken: `mx-${++n}`, matrixUserId: '@u:example.org' })
      return jsonRes({ success: false, errcode: 'M_UNKNOWN_TOKEN', error: 'Matrix GET /x -> 401: Unrecognised access token.' }, 502)
    })
    return { fetchImpl, c: new ServiceMessagesClient({ fetchImpl: fetchImpl as unknown as typeof fetch }) }
  }

  it('evicts the cached token on M_UNKNOWN_TOKEN so the next getMatrixToken re-exchanges', async () => {
    const { fetchImpl, c } = leaf()
    const jwt = jwtWith('svc-evict')
    const tok = await c.matrix().getMatrixToken(jwt)
    await expect(c.matrix().getJoinedRooms(tok)).rejects.toBeInstanceOf(MessagesServiceError)
    expect(await c.matrix().getMatrixToken(jwt)).toBe('mx-2')
    expect(exchanges(fetchImpl)).toBe(2)
  })

  it('evicts the cached token when media UPLOAD reports M_UNKNOWN_TOKEN', async () => {
    const { fetchImpl, c } = leaf()
    const jwt = jwtWith('svc-evict-upload')
    const tok = await c.matrix().getMatrixToken(jwt)
    await expect(c.matrix().uploadMedia(tok, new ArrayBuffer(4), 'image/png', 'a.png')).rejects.toBeInstanceOf(MessagesServiceError)
    expect(await c.matrix().getMatrixToken(jwt)).toBe('mx-2')
    expect(exchanges(fetchImpl)).toBe(2)
  })

  it('a 502 without the errcode does not evict', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      isExchange(url) ? jsonRes({ matrixToken: 'mx-1', matrixUserId: '@u:example.org' }) : jsonRes({ success: false, error: 'boom' }, 502))
    const c = new ServiceMessagesClient({ fetchImpl: fetchImpl as unknown as typeof fetch })
    const jwt = jwtWith('svc-keep')
    const tok = await c.matrix().getMatrixToken(jwt)
    await expect(c.matrix().getJoinedRooms(tok)).rejects.toBeInstanceOf(MessagesServiceError)
    await c.matrix().getMatrixToken(jwt)
    expect(exchanges(fetchImpl)).toBe(1)
  })
})
