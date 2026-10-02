// service-client.test.ts — messages leaf HTTP ACL contract.
// Pins the request/response ENVELOPE the ServiceMessagesClient sends to the leaf
// against contracts/messages/openapi.messages-internal.json for the security-
// sensitive paths: the matrix-token RETURN op (G-022 — raw token to the kernel,
// never a browser body) and the resolveMatrixCreds SOFT-FAIL (a leaf error maps
// to empty creds without throwing). Flag OFF this client is never used at runtime;
// this test is the only thing pinning it to the leaf contract.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// getTenant() is fail-closed (throws without an AsyncLocalStorage context).
// Mock it so buildHeaders() can emit x-tenant-id / x-tenant-slug.
vi.mock('$lib/server/tenant/context', () => ({
  getTenant: () => ({ id: 'tenant-1', slug: 'default' }),
}))
// getKeycloakJwt() reads the session; mock it so resolveMatrixCreds can run
// without a real RequestEvent. livekit-client is mocked to avoid pulling the
// livekit-server-sdk + tenant graph (only its pure room-name helpers are used).
vi.mock('$lib/server/messages/matrix-creds', () => ({
  getKeycloakJwt: vi.fn(async () => 'kc-jwt'),
}))
vi.mock('$lib/server/messages/livekit-client', () => ({
  roomNameFromMatrixId: (id: string) => `stura-room-${id}`,
  dmRoomName: () => 'stura-dm-x',
}))

import {
  ServiceMessagesClient,
  MessagesServiceError,
  REQUEST_TIMEOUT_MS,
  evictServiceMatrixTokenCache,
  __resetServiceMatrixTokenCacheForTests,
} from './service-client'
import { getKeycloakJwt } from '../matrix-creds'

// Load the committed contract — the matrix-token op must be declared.
const CONTRACT = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../../../../../contracts/messages/openapi.messages-internal.json'),
    'utf8',
  ),
) as {
  paths: Record<string, unknown>
  components: { schemas: Record<string, { required?: string[]; properties?: Record<string, unknown> }> }
}

function jsonRes(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function contractPath(url: string): string {
  return new URL(url).pathname
}

const fakeEvent = {} as unknown as import('@sveltejs/kit').RequestEvent

// `process.env` is the only PROCESS-global this file writes, and it is the one
// piece of state vitest's per-file `isolate` cannot be relied on to undo: turn
// `isolate` off (or run this file in a shared worker) and every later file
// inherits a populated MESSAGES_SERVICE_URL / INTERNAL_MESSAGES_SECRET, which
// silently flips any fail-closed "the secret is unset" assertion to green.
// Snapshot and restore, so this file leaves the process exactly as it found it.
const ENV_KEYS = ['MESSAGES_SERVICE_URL', 'INTERNAL_MESSAGES_SECRET'] as const
let envSnapshot: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {}

beforeEach(() => {
  envSnapshot = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  process.env.MESSAGES_SERVICE_URL = 'http://messages-service:8080'
  process.env.INTERNAL_MESSAGES_SECRET = 's3cr3t'
  vi.mocked(getKeycloakJwt).mockResolvedValue('kc-jwt')
  // #389: getMatrixToken caches per session (module-level). Reset between tests
  // so each starts from a cold cache.
  __resetServiceMatrixTokenCacheForTests()
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    const prior = envSnapshot[k]
    if (prior === undefined) delete process.env[k]
    else process.env[k] = prior
  }
  // The token cache is module-level too: leave it cold for the next file's
  // import of this module, not carrying the last test's session key.
  __resetServiceMatrixTokenCacheForTests()
})

/** A minimal (unverified) JWT carrying `sub`/`exp` so the token cache keys it. */
function jwtWith(sub: string, expSecondsFromNow = 3600): string {
  const payload = Buffer.from(
    JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + expSecondsFromNow }),
  ).toString('base64url')
  return `h.${payload}.s`
}

describe('ServiceMessagesClient — leaf ACL contract', () => {
  it('kind is service', () => {
    expect(new ServiceMessagesClient().kind).toBe('service')
  })

  it('the matrix-token op is declared in the messages-internal contract', () => {
    expect(CONTRACT.paths['/api/v1/auth/matrix-token']).toBeDefined()
  })

  // G-022 (Finding 3a): the creds op's contract must model BOTH fields
  // resolveMatrixCreds maps — matrixToken (required, the raw token to the KERNEL)
  // AND matrixUserId — so the ACL twin can never silently drop the identity.
  it('the MatrixTokenResult contract models BOTH matrixToken AND matrixUserId', () => {
    const schema = CONTRACT.components.schemas.MatrixTokenResult
    expect(schema).toBeDefined()
    expect(schema.properties).toHaveProperty('matrixToken')
    expect(schema.properties).toHaveProperty('matrixUserId')
    // matrixToken is the security-sensitive raw token → required in the envelope.
    expect(schema.required).toContain('matrixToken')
  })

  it('getMatrixToken: POST /api/v1/auth/matrix-token with secret+tenant headers → returns the RAW token to the kernel (G-022)', async () => {
    const fetchImpl = vi.fn(async () => jsonRes({ matrixToken: 'mx_raw_token', matrixUserId: '@u:s' }))
    const c = new ServiceMessagesClient({ correlationId: 'corr-1', fetchImpl })
    const token = await c.matrix().getMatrixToken('kc-jwt', 'device-1')

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    const path = contractPath(url)
    expect(path).toBe('/api/v1/auth/matrix-token')
    expect(CONTRACT.paths[path]).toBeDefined()
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers['x-internal-auth']).toBe('s3cr3t')
    expect(headers['x-tenant-id']).toBe('tenant-1')
    expect(headers['x-tenant-slug']).toBe('default')
    expect(headers['x-correlation-id']).toBe('corr-1')
    expect(JSON.parse(init.body as string)).toEqual({ keycloakJwt: 'kc-jwt', deviceId: 'device-1' })
    // G-022: the RAW token is returned to the kernel caller — a plain string, not
    // wrapped in any browser-facing body/object.
    expect(token).toBe('mx_raw_token')
    expect(typeof token).toBe('string')
  })

  // #389: the kernel caches the exchanged Matrix token per session so a burst of
  // messages API calls does not trigger one Synapse /login (leaf round-trip) each
  // — which would trip Synapse's rc_login rate limit (429 → 502 cascade).
  it('getMatrixToken: caches per session — a second call reuses the token with no second leaf call', async () => {
    let n = 0
    const fetchImpl = vi.fn(async () => jsonRes({ matrixToken: `mx-${++n}`, matrixUserId: '@u:s' }))
    const c = new ServiceMessagesClient({ fetchImpl })
    const jwt = jwtWith('user-a')

    const first = await c.matrix().getMatrixToken(jwt)
    const second = await c.matrix().getMatrixToken(jwt)

    expect(first).toBe('mx-1')
    expect(second).toBe('mx-1')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('getMatrixToken: a concurrent cold-cache burst collapses into ONE leaf /login (in-flight dedup)', async () => {
    let n = 0
    const fetchImpl = vi.fn(
      async () =>
        new Promise<Response>((resolve) =>
          setTimeout(() => resolve(jsonRes({ matrixToken: `mx-${++n}`, matrixUserId: '@u:s' })), 5),
        ),
    )
    const c = new ServiceMessagesClient({ fetchImpl })
    const jwt = jwtWith('user-b')

    const [a, b, d] = await Promise.all([
      c.matrix().getMatrixToken(jwt),
      c.matrix().getMatrixToken(jwt),
      c.matrix().getMatrixToken(jwt),
    ])
    expect(a).toBe('mx-1')
    expect(b).toBe('mx-1')
    expect(d).toBe('mx-1')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('getMatrixToken: distinct sessions (different sub) are cached independently', async () => {
    let n = 0
    const fetchImpl = vi.fn(async () => jsonRes({ matrixToken: `mx-${++n}`, matrixUserId: '@u:s' }))
    const c = new ServiceMessagesClient({ fetchImpl })

    const a = await c.matrix().getMatrixToken(jwtWith('user-1'))
    const b = await c.matrix().getMatrixToken(jwtWith('user-2'))
    expect(a).toBe('mx-1')
    expect(b).toBe('mx-2')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('evictServiceMatrixTokenCache: drops a tenant’s cached token so the next call re-exchanges', async () => {
    let n = 0
    const fetchImpl = vi.fn(async () => jsonRes({ matrixToken: `mx-${++n}`, matrixUserId: '@u:s' }))
    const c = new ServiceMessagesClient({ fetchImpl })
    const jwt = jwtWith('user-c')

    await c.matrix().getMatrixToken(jwt)
    evictServiceMatrixTokenCache('tenant-1') // getTenant() is mocked to tenant-1
    const after = await c.matrix().getMatrixToken(jwt)

    expect(after).toBe('mx-2')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('resolveMatrixCreds: maps the matrix-token op result to { userId, accessToken }', async () => {
    const fetchImpl = vi.fn(async () => jsonRes({ matrixToken: 'mx_raw_token', matrixUserId: '@u:s' }))
    const c = new ServiceMessagesClient({ fetchImpl })
    const creds = await c.resolveMatrixCreds(fakeEvent)
    expect(creds).toEqual({ userId: '@u:s', accessToken: 'mx_raw_token' })
    // never leaks the token in a browser body — it is returned to the kernel route
    // which scopes it to an HttpOnly /matrix cookie (G-022).
    expect(contractPath((fetchImpl.mock.calls[0] as unknown as [string])[0])).toBe('/api/v1/auth/matrix-token')
  })

  it('resolveMatrixCreds: a leaf failure maps to EMPTY creds WITHOUT throwing (soft-fail preserved)', async () => {
    const fetchImpl = vi.fn(async () => new Response('upstream boom', { status: 502 }))
    const c = new ServiceMessagesClient({ fetchImpl })
    await expect(c.resolveMatrixCreds(fakeEvent)).resolves.toEqual({ userId: '', accessToken: '' })
  })

  it('resolveMatrixCreds: a missing session token (getKeycloakJwt throws) also soft-fails to empty creds', async () => {
    vi.mocked(getKeycloakJwt).mockRejectedValueOnce(new Error('No Keycloak access token in session'))
    const fetchImpl = vi.fn(async () => jsonRes({ matrixToken: 'x', matrixUserId: '@u:s' }))
    const c = new ServiceMessagesClient({ fetchImpl })
    await expect(c.resolveMatrixCreds(fakeEvent)).resolves.toEqual({ userId: '', accessToken: '' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  // #370: the admin all-rooms list is folded into the port (synapse().listAllRoomIds)
  // so the matrix-token + messages/rooms routes no longer fetch the Synapse admin
  // API (or reference SYNAPSE_ADMIN_TOKEN) directly. In service mode it forwards to
  // the video.meeting-room admin multiplex with { listRooms: true } → { roomIds }.
  it('listAllRoomIds (#370): POST /api/v1/video/meeting-room { listRooms:true } → roomIds', async () => {
    const fetchImpl = vi.fn(async () => jsonRes({ roomIds: ['!a:s', '!b:s'] }))
    const c = new ServiceMessagesClient({ fetchImpl })
    const ids = await c.synapse().listAllRoomIds()

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    const path = contractPath(url)
    expect(path).toBe('/api/v1/video/meeting-room')
    expect(CONTRACT.paths[path]).toBeDefined()
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ listRooms: true })
    expect(ids).toEqual(['!a:s', '!b:s'])
  })

  it('listAllRoomIds (#370): a missing roomIds field degrades to []', async () => {
    const fetchImpl = vi.fn(async () => jsonRes({}))
    const c = new ServiceMessagesClient({ fetchImpl })
    await expect(c.synapse().listAllRoomIds()).resolves.toEqual([])
  })

  // Regression (4-lens review, HIGH / security): downloadMedia must hand back an
  // ArrayBuffer sized EXACTLY to the payload. Small (<4096 byte) payloads are
  // allocated from Node's shared 8192-byte Buffer pool, so a raw `Buffer.from(..)
  // .buffer` returns the WHOLE pool — a garbage prefix at byteOffset (breaks
  // magic-byte decoding of small images) plus trailing pool memory that may hold
  // OTHER requests' bytes (cross-request disclosure once a route does
  // `new Response(data)`). The inprocess MatrixClient.downloadMedia returns an
  // exact-sized `await res.arrayBuffer()`, so service mode must match. This fails
  // on the pooled `.buffer` and passes on the byteOffset/byteLength slice.
  it('downloadMedia: returns an EXACT-sized ArrayBuffer for a small payload (no pooled-buffer prefix/overrun)', async () => {
    // <100 bytes → allocated from the shared pool. PNG magic + a distinctive tail.
    const payload = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xde, 0xad, 0xbe, 0xef])
    const b64 = Buffer.from(payload).toString('base64')
    const fetchImpl = vi.fn(async () => jsonRes({ data: b64, contentType: 'image/png' }))
    const c = new ServiceMessagesClient({ fetchImpl })

    const { data, contentType } = await c.matrix().downloadMedia('mxc://s/x')

    // exact-sized: the buffer is JUST the payload, not the 8192-byte pool.
    expect(data.byteLength).toBe(payload.length)
    // and the bytes round-trip exactly — magic bytes at index 0, no garbage prefix.
    expect(new Uint8Array(data)).toEqual(payload)
    expect(contentType).toBe('image/png')
  })

  it('throws MessagesServiceError on a non-2xx op response', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 502 }))
    const c = new ServiceMessagesClient({ fetchImpl })
    await expect(c.matrix().getMatrixToken('kc-jwt')).rejects.toBeInstanceOf(MessagesServiceError)
  })

  it('fails closed when INTERNAL_MESSAGES_SECRET is unset', async () => {
    delete process.env.INTERNAL_MESSAGES_SECRET
    const fetchImpl = vi.fn(async () => jsonRes({ matrixToken: 'x' }))
    const c = new ServiceMessagesClient({ fetchImpl })
    await expect(c.matrix().getMatrixToken('kc-jwt')).rejects.toThrow(/INTERNAL_MESSAGES_SECRET/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

// #449(b): the /api/messages/rooms 502 could not be diagnosed because every
// caller folds a leaf failure into a generic 502 ("Matrix authentication
// failed: …") and leafJson dropped the leaf's own status + body on the floor.
// These pin the diagnostic record — WITHOUT changing what is thrown and without
// introducing a retry (writes here are not idempotent).
describe('leafJson diagnostics (#449 b) — a leaf failure is logged before it folds into a 502', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    errorSpy.mockRestore()
  })

  /** The whole console.error record (format string + args) as one string. */
  const logged = (): string =>
    (errorSpy.mock.calls as unknown[][])
      .map((args) => args.map((a) => String(a)).join(' '))
      .join('\n')

  it('logs the leaf STATUS, the op and the path on a non-2xx response', async () => {
    const fetchImpl = vi.fn(async () => new Response('M_LIMIT_EXCEEDED: too many login attempts', { status: 429 }))
    const c = new ServiceMessagesClient({ fetchImpl })

    await expect(c.matrix().getJoinedRooms('mx-token')).rejects.toBeInstanceOf(MessagesServiceError)

    const record = logged()
    expect(errorSpy).toHaveBeenCalled()
    expect(record).toContain('429')
    // the op name — so a 502 is attributable to the exact leaf op, not just a path
    expect(record).toContain('messages.rooms')
    expect(record).toContain('/api/v1/messages/rooms')
  })

  it('logs the leaf BODY — the actual diagnostic the 502 swallowed', async () => {
    const fetchImpl = vi.fn(async () => new Response('synapse refused: rc_login rate limit', { status: 502 }))
    const c = new ServiceMessagesClient({ fetchImpl })

    await expect(c.matrix().getJoinedRooms('mx-token')).rejects.toBeInstanceOf(MessagesServiceError)
    expect(logged()).toContain('synapse refused: rc_login rate limit')
  })

  it('logs a TRANSPORT failure too (connect refused / the 5 s abort), which never had a status', async () => {
    const boom = Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:8080'), { name: 'TypeError' })
    const fetchImpl = vi.fn(async () => {
      throw boom
    })
    const c = new ServiceMessagesClient({ fetchImpl })

    await expect(c.matrix().getJoinedRooms('mx-token')).rejects.toBe(boom)

    const record = logged()
    expect(record).toContain('transport failure')
    expect(record).toContain('connect ECONNREFUSED 10.0.0.5:8080')
    expect(record).toContain('messages.rooms')
  })

  it('never logs the REQUEST body — it carries the user’s Matrix/Keycloak token', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 500 }))
    const c = new ServiceMessagesClient({ fetchImpl })

    await expect(c.matrix().getJoinedRooms('super-secret-user-token')).rejects.toBeInstanceOf(
      MessagesServiceError,
    )
    expect(logged()).not.toContain('super-secret-user-token')
  })

  it('logging is additive: the thrown MessagesServiceError still carries status + truncated body', async () => {
    const fetchImpl = vi.fn(async () => new Response('leaf detail', { status: 503 }))
    const c = new ServiceMessagesClient({ fetchImpl })

    await expect(c.matrix().getJoinedRooms('mx-token')).rejects.toMatchObject({
      status: 503,
      message: expect.stringContaining('leaf detail'),
    })
    // …and no retry was introduced — exactly ONE leaf call for one op.
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('a fail-closed CONFIG error is not mislabelled as a leaf transport failure', async () => {
    // buildHeaders() throws when INTERNAL_MESSAGES_SECRET is unset. It is
    // resolved before the fetch try/catch, so it never reaches the leaf and
    // never enters the transport-failure log path.
    delete process.env.INTERNAL_MESSAGES_SECRET
    const fetchImpl = vi.fn(async () => jsonRes({ rooms: [] }))
    const c = new ServiceMessagesClient({ fetchImpl })

    await expect(c.matrix().getJoinedRooms('mx-token')).rejects.toThrow(/INTERNAL_MESSAGES_SECRET/)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(logged()).not.toContain('transport failure')
  })

  it('a SUCCESSFUL op logs nothing', async () => {
    const fetchImpl = vi.fn(async () => jsonRes({ rooms: ['!a:s'] }))
    const c = new ServiceMessagesClient({ fetchImpl })

    await expect(c.matrix().getJoinedRooms('mx-token')).resolves.toEqual(['!a:s'])
    expect(errorSpy).not.toHaveBeenCalled()
  })
})

// leafJson BOUNDED network retry. This client was the only leaf HTTP ACL in the
// kernel with no retry at all: every sibling (board/calendar/content/finance/
// newsletter/vault/files/elections) retries ONCE on a transport error or a 503,
// and only for a call the caller declared idempotent. A single ECONNRESET from
// a rolling leaf restart therefore surfaced to the user as a 502 on a pure READ.
//
// Two boundaries the retry must NOT cross, both pinned below:
//   - a NON-2xx status is never retried (a 500 is the leaf's answer, not a lost
//     connection; retrying it doubles the load on an already-failing leaf), and
//   - a WRITE POST (send / read-marker / typing / media upload / room create) is
//     never retried — this transport has no idempotency key, so a blind replay
//     can duplicate a Matrix event. Every op here is an HTTP POST, so the
//     read/write split is carried by the explicit `idempotent` opt-in, not by
//     the HTTP verb.
// "Bounded" = exactly ONE extra attempt: at most 2 fetches, never a loop.
describe('leafJson bounded retry — one extra attempt, reads only, transport only', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const econnreset = () =>
    Object.assign(new Error('read ECONNRESET'), { name: 'Error', code: 'ECONNRESET' })

  it('retries an idempotent READ once after ECONNRESET and then SUCCEEDS', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(econnreset())
      .mockResolvedValueOnce(jsonRes({ rooms: ['!a:s'] }))
    const c = new ServiceMessagesClient({ fetchImpl })

    await expect(c.matrix().getJoinedRooms('mx-token')).resolves.toEqual(['!a:s'])
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('is BOUNDED: a second ECONNRESET is not retried again — exactly 2 attempts, then throw', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(econnreset())
    const c = new ServiceMessagesClient({ fetchImpl })

    await expect(c.matrix().getJoinedRooms('mx-token')).rejects.toThrow(/ECONNRESET/)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('does NOT retry a 500 — a leaf status is an answer, not a lost connection', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 }))
    const c = new ServiceMessagesClient({ fetchImpl })

    await expect(c.matrix().getJoinedRooms('mx-token')).rejects.toBeInstanceOf(MessagesServiceError)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('does NOT retry a WRITE post — sendMessage must never be replayed', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(econnreset())
    const c = new ServiceMessagesClient({ fetchImpl })

    await expect(
      c.matrix().sendMessage('mx-token', '!r:s', { msgtype: 'm.text', body: 'hi' }),
    ).rejects.toThrow(/ECONNRESET/)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('does NOT retry the matrix-token exchange (a Synapse /login is rate-limited, not idempotent)', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(econnreset())
    const c = new ServiceMessagesClient({ fetchImpl })

    await expect(c.matrix().getMatrixToken(jwtWith('u-retry'), 'dev-1')).rejects.toThrow(
      /ECONNRESET/,
    )
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  // Review finding: the retry handed the SECOND attempt the FIRST attempt's
  // AbortController. The docstring named "this method's own 5 s abort" as a
  // retryable transport class, but when that abort is what killed attempt 1 the
  // signal is already in the aborted state and fetch rejects a pre-aborted
  // signal immediately — so the one class the comment advertised could never
  // recover. Each attempt now gets its own controller and its own budget.
  it('gives each attempt a FRESH AbortController — a timed-out read still gets a real retry', async () => {
    vi.useFakeTimers()
    try {
      const signals: AbortSignal[] = []
      let secondSignalAlreadyAborted: boolean | null = null
      const fetchImpl = vi.fn(async (_url: unknown, init: { signal: AbortSignal }) => {
        signals.push(init.signal)
        if (signals.length === 1) {
          // let this attempt's own 5 s timeout fire, exactly as in production
          vi.advanceTimersByTime(REQUEST_TIMEOUT_MS)
          throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })
        }
        secondSignalAlreadyAborted = init.signal.aborted
        return jsonRes({ rooms: ['!ok:s'] })
      }) as unknown as typeof globalThis.fetch
      const c = new ServiceMessagesClient({ fetchImpl })

      await expect(c.matrix().getJoinedRooms('mx-token')).resolves.toEqual(['!ok:s'])
      expect(signals).toHaveLength(2)
      expect(signals[0].aborted).toBe(true)
      expect(signals[0]).not.toBe(signals[1])
      expect(secondSignalAlreadyAborted).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('logs the RETRY attempt’s own failure too — the record and the throw must agree', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(econnreset())
      .mockRejectedValueOnce(Object.assign(new Error('getaddrinfo ENOTFOUND'), { name: 'Error' }))
    const c = new ServiceMessagesClient({ fetchImpl })

    await expect(c.matrix().getJoinedRooms('mx-token')).rejects.toThrow(/ENOTFOUND/)
    const record = errorSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n')
    expect(record).toContain('ECONNRESET')
    expect(record).toContain('ENOTFOUND')
  })
})
