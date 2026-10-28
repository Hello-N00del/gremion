import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runWithTenant, type TenantContext } from '$lib/server/tenant/context'

// P2.1b T7 (D-LIVEKIT) — LiveKit resolves url/key/secret via TenantContext (registry services refs, falling
// back to the deployment-wide env), livekitRoomName/roomNameFromMatrixId/dmRoomName carry the tenant-slug
// namespace prefix for EVERY tenant (TASK-042: there is no default tenant), and mintToken REJECTS a room
// outside the current tenant's namespace (the room-pinned grant retires R12).
// Tenant context module is REAL; per-tenant cases use EXPLICIT runWithTenant.

const lkEnv = vi.hoisted(
  () =>
    ({
      LIVEKIT_API_KEY: 'env-key',
      LIVEKIT_API_SECRET: 'env-secret',
      LIVEKIT_URL: 'ws://livekit-default:7880',
      MATRIX_URL: 'http://matrix.test:8008',
      LK_MUNI_KEY: 'muni-key',
      LK_MUNI_SECRET: 'muni-secret',
    }) as Record<string, string | undefined>,
)
// TASK-205b: the service endpoints (Matrix, Helios, LiveKit, Nextcloud) come through the serviceEnv seam, the
// successor of the deleted default-tenant env reader. This suite feeds the seam the same values it already
// feeds its `$env/dynamic/private` mock, so every case keeps its own env fixture.
vi.mock('$lib/server/env/service-env', async () => {
  const { env } = await import('$env/dynamic/private')
  return { serviceEnv: (name: string) => (env as Record<string, string | undefined>)[name] }
})
vi.mock('$env/dynamic/private', () => ({ env: lkEnv }))

interface MintRecord {
  key: string
  secret: string
  identity?: string
  grant?: Record<string, unknown>
}
const aliasMock = vi.hoisted(() => vi.fn())
vi.mock('./matrix-client', () => ({
  getMatrixClient: () => ({ getRoomIdByAlias: aliasMock }),
}))
const minted = vi.hoisted(() => [] as MintRecord[])

vi.mock('livekit-server-sdk', () => ({
  AccessToken: class {
    grant: Record<string, unknown> | undefined
    constructor(
      public key: string,
      public secret: string,
      public opts: { identity?: string },
    ) {}
    addGrant(g: Record<string, unknown>) {
      this.grant = g
      minted.push({ key: this.key, secret: this.secret, identity: this.opts?.identity, grant: g })
    }
    async toJwt() {
      return `jwt.${this.key}.${String(this.grant?.room)}`
    }
  },
}))

import {
  roomNameFromMatrixId,
  dmRoomName,
  mintToken,
  livekitServerUrl,
  evictLivekitSettings,
  __resetLivekitForTests,
} from './livekit-client'
import { livekitRoomName, handleSfuRequest } from './livekit-jwt'

// A tenant WITHOUT service refs: url, key and secret fall back to the deployment-wide env.
const ENV_CTX = {
  id: 'tid-alpha',
  slug: 'alpha',
} as unknown as TenantContext

const MUNI_CTX = {
  id: 'tid-muni',
  slug: 'muni',
  services: {
    matrixUrl: 'http://matrix-muni:8008',
    livekitUrl: 'wss://lk.muni.example.org',
    livekitApiKeyRef: 'env:LK_MUNI_KEY',
    livekitApiSecretRef: 'env:LK_MUNI_SECRET',
  },
} as unknown as TenantContext

beforeEach(() => {
  __resetLivekitForTests()
  minted.length = 0
  lkEnv.LIVEKIT_API_KEY = 'env-key'
  lkEnv.LK_MUNI_KEY = 'muni-key'
})
afterEach(() => vi.unstubAllGlobals())

describe('room-name namespace (D-LIVEKIT)', () => {
  it('every tenant gets the t.<slug>. namespace prefix on every derivation, one without service refs included', () => {
    runWithTenant(ENV_CTX, () => {
      expect(roomNameFromMatrixId('!abc123:matrix.example.com')).toBe('t.alpha.stura-room-abc123')
      expect(dmRoomName('@alice:m.test', '@bob:m.test')).toMatch(/^t\.alpha\.stura-dm-[0-9a-f]{16}$/)
      expect(livekitRoomName('#general:m.test')).toBe('t.alpha.general')
      expect(livekitRoomName('bare-room')).toBe('t.alpha.bare-room')
    })
    runWithTenant(MUNI_CTX, () => {
      expect(roomNameFromMatrixId('!abc123:muni.example.org')).toBe('t.muni.stura-room-abc123')
      expect(dmRoomName('@a:muni.example.org', '@b:muni.example.org')).toMatch(
        /^t\.muni\.stura-dm-[0-9a-f]{16}$/,
      )
      expect(livekitRoomName('#general:muni.example.org')).toBe('t.muni.general')
      expect(livekitRoomName('bare-room')).toBe('t.muni.bare-room')
      // Idempotent: an already-namespaced bare name is not double-prefixed.
      expect(livekitRoomName('t.muni.already')).toBe('t.muni.already')
    })
  })

  it('fail-closed: room-name derivation outside any tenant scope throws', () => {
    expect(() => roomNameFromMatrixId('!abc:m.test')).toThrow(/No tenant context/)
  })
})

describe('mintToken — per-tenant creds + room-pinned grant + cross-tenant rejection', () => {
  it('a tenant without service refs mints with the env key/secret and pins its namespaced room in the grant', async () => {
    const jwt = await runWithTenant(ENV_CTX, () =>
      mintToken({ roomName: 't.alpha.stura-room-x', identity: '@u:m', displayName: 'U', canPublish: true }),
    )
    expect(jwt).toContain('env-key')
    expect(minted[0]).toMatchObject({ key: 'env-key', secret: 'env-secret' })
    expect(minted[0].grant).toMatchObject({ room: 't.alpha.stura-room-x', roomJoin: true })
  })

  it('a tenant with no key anywhere keeps the exact error', async () => {
    delete lkEnv.LIVEKIT_API_KEY
    await expect(
      runWithTenant(ENV_CTX, () =>
        mintToken({ roomName: 't.alpha.stura-room-x', identity: '@u:m', displayName: 'U', canPublish: true }),
      ),
    ).rejects.toThrow('LIVEKIT_API_KEY not configured')
  })

  it('a tenant mints with ITS resolved key/secret refs', async () => {
    await runWithTenant(MUNI_CTX, () =>
      mintToken({ roomName: 't.muni.stura-room-x', identity: '@u:muni', displayName: 'U', canPublish: true }),
    )
    expect(minted[0]).toMatchObject({ key: 'muni-key', secret: 'muni-secret' })
    expect(minted[0].grant).toMatchObject({ room: 't.muni.stura-room-x' })
  })

  it('CROSS-TENANT REJECTION: a tenant cannot mint into another tenant namespaced room', async () => {
    await expect(
      runWithTenant(ENV_CTX, () =>
        mintToken({ roomName: 't.muni.stura-room-x', identity: '@u:m', displayName: 'U', canPublish: true }),
      ),
    ).rejects.toThrow(/cross-tenant/)
    expect(minted).toHaveLength(0)
  })

  it('CROSS-TENANT REJECTION: a tenant cannot mint outside its own namespace, an un-namespaced room included', async () => {
    await expect(
      runWithTenant(MUNI_CTX, () =>
        mintToken({ roomName: 'stura-room-x', identity: '@u:muni', displayName: 'U', canPublish: true }),
      ),
    ).rejects.toThrow(/cross-tenant/)
    await expect(
      runWithTenant(MUNI_CTX, () =>
        mintToken({ roomName: 't.other.room', identity: '@u:muni', displayName: 'U', canPublish: true }),
      ),
    ).rejects.toThrow(/cross-tenant/)
    expect(minted).toHaveLength(0)
  })

  it('fail-closed: minting outside any tenant scope throws', async () => {
    await expect(
      mintToken({ roomName: 'stura-room-x', identity: '@u:m', displayName: 'U', canPublish: true }),
    ).rejects.toThrow(/No tenant context/)
  })
})

describe('livekitServerUrl + settings cache eviction', () => {
  it('a tenant without services.livekitUrl falls back to env.LIVEKIT_URL', () => {
    expect(runWithTenant(ENV_CTX, () => livekitServerUrl())).toBe('ws://livekit-default:7880')
  })

  it('a tenant with services.livekitUrl resolves it', () => {
    expect(runWithTenant(MUNI_CTX, () => livekitServerUrl())).toBe('wss://lk.muni.example.org')
  })

  it('evictLivekitSettings drops the cached per-tenant resolution', async () => {
    await runWithTenant(MUNI_CTX, () =>
      mintToken({ roomName: 't.muni.r', identity: '@u', displayName: 'U', canPublish: true }),
    )
    expect(minted[0].key).toBe('muni-key')

    lkEnv.LK_MUNI_KEY = 'muni-key-2'
    await runWithTenant(MUNI_CTX, () =>
      mintToken({ roomName: 't.muni.r', identity: '@u', displayName: 'U', canPublish: true }),
    )
    expect(minted[1].key).toBe('muni-key') // still cached

    evictLivekitSettings('tid-muni')
    await runWithTenant(MUNI_CTX, () =>
      mintToken({ roomName: 't.muni.r', identity: '@u', displayName: 'U', canPublish: true }),
    )
    expect(minted[2].key).toBe('muni-key-2') // re-resolved after eviction
  })
})

describe('handleSfuRequest — per-tenant validate + membership gate + namespaced room grant', () => {
  // #257-1: the SFU flow now (1) validates the OpenID token, (2) verifies the
  // caller is a MEMBER of the requested Matrix room via the Synapse Admin API,
  // and only then mints a publish token. The mock routes by URL so the OpenID
  // userinfo call and the admin members call return distinct bodies.
  function stubFetch(opts: { sub: string; members: string[] }) {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/_matrix/federation/v1/openid/userinfo')) {
        return new Response(JSON.stringify({ sub: opts.sub }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.includes('/_synapse/admin/v1/rooms/') && url.includes('/members')) {
        return new Response(JSON.stringify({ members: opts.members, total: opts.members.length }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response('not found', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('member: validates against the tenant homeserver, mints the namespaced room, returns the tenant LiveKit url', async () => {
    const fetchMock = stubFetch({ sub: '@user:muni.example.org', members: ['@user:muni.example.org'] })

    const result = await runWithTenant(MUNI_CTX, () =>
      handleSfuRequest({
        room: '!abc:muni.example.org',
        openid_token: { access_token: 'tok', token_type: 'Bearer' },
      }),
    )

    const [validateUrl] = fetchMock.mock.calls[0] as unknown as [string]
    expect(validateUrl).toContain(
      'http://matrix-muni:8008/_matrix/federation/v1/openid/userinfo',
    )
    expect(result.url).toBe('wss://lk.muni.example.org')
    expect(minted[0].grant).toMatchObject({ room: 't.muni.stura-room-abc' })
  })

  it('NON-MEMBER REJECTION: a validated user not in the room gets no publish token', async () => {
    stubFetch({ sub: '@intruder:muni.example.org', members: ['@someone-else:muni.example.org'] })

    await expect(
      runWithTenant(MUNI_CTX, () =>
        handleSfuRequest({
          room: '!abc:muni.example.org',
          openid_token: { access_token: 'tok', token_type: 'Bearer' },
        }),
      ),
    ).rejects.toThrow(/not a member/)
    expect(minted).toHaveLength(0)
  })

  it('fail-closed: an unresolvable (bare) room name is rejected (cannot verify membership)', async () => {
    stubFetch({ sub: '@user:muni.example.org', members: ['@user:muni.example.org'] })

    await expect(
      runWithTenant(MUNI_CTX, () =>
        handleSfuRequest({
          room: 'bare-room',
          openid_token: { access_token: 'tok', token_type: 'Bearer' },
        }),
      ),
    ).rejects.toThrow(/not a member/)
    expect(minted).toHaveLength(0)
  })

  it('ALIAS: the LiveKit room is derived from the RESOLVED room id the membership check ran on, not the alias text', async () => {
    // The caller is a member of !mine, but names an alias whose localpart is the
    // LiveKit room of someone else's call. The grant must pin the resolved id's room.
    aliasMock.mockResolvedValue('!mine:muni.example.org')
    stubFetch({ sub: '@user:muni.example.org', members: ['@user:muni.example.org'] })

    await runWithTenant(MUNI_CTX, () =>
      handleSfuRequest({
        room: '#stura-room-victim:muni.example.org',
        openid_token: { access_token: 'tok', token_type: 'Bearer' },
      }),
    )

    expect(minted[0].grant).toMatchObject({ room: 't.muni.stura-room-mine' })
  })
})
