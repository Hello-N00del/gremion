// video.token minted a LiveKit JWT for ANY input -- an empty room name (a token
// for no pinned room), an empty identity, or with an empty LIVEKIT_API_SECRET (a
// token signed with ''). The leaf must refuse all three instead of minting.
import { describe, it, expect } from 'vitest'
import { OPERATIONS } from '../src/operations.ts'
import { dispatchOp } from '../src/http/dispatch.ts'
import type { LeafDeps } from '../src/http/deps.ts'

const op = OPERATIONS.find((o) => o.op === 'video.token')!

function deps(apiSecret = 'this-secret-is-at-least-32-bytes-long!!'): LeafDeps {
  return {
    matrix: {} as LeafDeps['matrix'],
    synapse: {} as LeafDeps['synapse'],
    livekit: { apiKey: 'APIkey123', apiSecret },
  }
}

const GOOD = { roomName: 'tenant-a-room-abc', identity: '@u:example.org', displayName: 'U', canPublish: false }

describe('video.token refuses to mint on empty input or an empty secret', () => {
  it('mints for a complete request (control)', async () => {
    const r = await dispatchOp(op, GOOD, deps())
    expect(r.status).toBe(200)
    expect(typeof (r.body as { token?: unknown }).token).toBe('string')
  })

  for (const [label, body] of [
    ['empty roomName', { ...GOOD, roomName: '' }],
    ['missing roomName', { identity: '@u:example.org', displayName: 'U' }],
    ['empty identity', { ...GOOD, identity: '' }],
  ] as const) {
    it(`refuses a request with ${label}`, async () => {
      const r = await dispatchOp(op, body as Record<string, unknown>, deps())
      // The exact guard answer, not merely "not 200": an incidental throw would
      // surface as 502 and must not pass this test.
      expect(r.status).toBe(400)
      expect((r.body as { error?: unknown }).error).toBe('roomName and identity are required')
      expect((r.body as { token?: unknown }).token).toBeUndefined()
    })
  }

  it('refuses when the LiveKit secret is empty', async () => {
    const r = await dispatchOp(op, GOOD, deps(''))
    expect(r.status).toBe(503)
    expect((r.body as { error?: unknown }).error).toBe('LiveKit is not configured')
    expect((r.body as { token?: unknown }).token).toBeUndefined()
  })
})
