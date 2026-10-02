import { describe, expect, it, vi } from 'vitest'

vi.mock('$env/dynamic/private', () => ({
  env: {
    LIVEKIT_API_KEY: 'testkey',
    LIVEKIT_API_SECRET: 'testsecret-must-be-at-least-32-chars',
  },
}))

// P2.1b T7 — room-name derivation is tenant-scoped (fail-closed; the default
// tenant's names are byte-identical). Pin a default-tenant scope here; the
// per-tenant namespace + mint-rejection behaviour lives in livekit.tenant.test.ts.
vi.mock('$lib/server/tenant/context', () => ({
  getTenant: () => ({ id: 'default', slug: 'default' }),
  currentTenantId: () => 'default',
}))

describe('roomNameFromMatrixId', () => {
  it('extracts localpart from a standard Matrix room ID', async () => {
    const { roomNameFromMatrixId } = await import('./livekit-client')
    expect(roomNameFromMatrixId('!abc123:matrix.example.com')).toBe('stura-room-abc123')
  })

  it('handles room IDs with complex localparts', async () => {
    const { roomNameFromMatrixId } = await import('./livekit-client')
    expect(roomNameFromMatrixId('!room-with-dashes:matrix.example.com')).toBe('stura-room-room-with-dashes')
  })
})

describe('dmRoomName', () => {
  it('produces the same name regardless of argument order', async () => {
    const { dmRoomName } = await import('./livekit-client')
    const a = dmRoomName('@alice:matrix.example.com', '@bob:matrix.example.com')
    const b = dmRoomName('@bob:matrix.example.com', '@alice:matrix.example.com')
    expect(a).toBe(b)
  })

  it('starts with stura-dm- prefix and has 16 hex chars', async () => {
    const { dmRoomName } = await import('./livekit-client')
    const name = dmRoomName('@alice:matrix.example.com', '@bob:matrix.example.com')
    expect(name).toMatch(/^stura-dm-[0-9a-f]{16}$/)
  })
})

// JWT minting is covered by the Playwright E2E suite in
// tests/e2e/video-calls-b3.spec.ts. A unit test here would have to mock
// livekit-server-sdk end-to-end because of a payload-type mismatch
// between livekit-server-sdk 2.15.1 and jose 5.10 under vitest.
