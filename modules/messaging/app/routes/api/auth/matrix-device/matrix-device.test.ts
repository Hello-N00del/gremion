// matrix-device.test.ts — #368 Finding 1: the DELETE /api/auth/matrix-device route
// now drives the Synapse admin device-delete through the MessagesBackendPort seam
// (backend.synapse().deleteDevice), NOT a direct fetch to the Synapse admin API.
// This keeps SYNAPSE_ADMIN_TOKEN in the messages backend (the leaf, in service mode).
// These pin the route's contract: it forwards (localpart, deviceId), returns 200 on
// success, and maps a thrown backend/Synapse error to a 502 with the message verbatim
// (byte-identical to the pre-seam inline-fetch route).

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockDeleteDevice } = vi.hoisted(() => ({ mockDeleteDevice: vi.fn() }))

vi.mock('$lib/server/messages/backend', () => ({
  getMessagesBackend: () => ({
    synapse: () => ({ deleteDevice: mockDeleteDevice }),
  }),
}))

function makeEvent(opts: { user?: unknown; body?: unknown }) {
  const init: RequestInit = { method: 'DELETE', headers: { 'content-type': 'application/json' } }
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body)
  return {
    locals: { user: opts.user ?? undefined },
    request: new Request('http://localhost/api/auth/matrix-device', init),
  }
}

let DELETE: (event: unknown) => Promise<Response>

beforeEach(async () => {
  vi.resetModules()
  mockDeleteDevice.mockReset().mockResolvedValue(undefined)
  const mod = await import('./+server')
  DELETE = mod.DELETE as (event: unknown) => Promise<Response>
})

describe('DELETE /api/auth/matrix-device', () => {
  it('drives the Synapse device-delete through backend.synapse().deleteDevice (localpart + deviceId) → 200', async () => {
    const res = await DELETE(makeEvent({ user: { id: 'sub-1', preferredUsername: 'alice' }, body: { deviceId: 'DEVXYZ' } }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })
    // localpart = preferredUsername; the backend forms @{localpart}:{serverName}.
    expect(mockDeleteDevice).toHaveBeenCalledWith('alice', 'DEVXYZ')
  })

  it('falls back to user.id as the localpart when preferredUsername is absent', async () => {
    await DELETE(makeEvent({ user: { id: 'sub-1' }, body: { deviceId: 'DEVXYZ' } }))
    expect(mockDeleteDevice).toHaveBeenCalledWith('sub-1', 'DEVXYZ')
  })

  it('returns 401 when unauthenticated and never touches the backend', async () => {
    const res = await DELETE(makeEvent({ body: { deviceId: 'DEVXYZ' } }))
    expect(res.status).toBe(401)
    expect(mockDeleteDevice).not.toHaveBeenCalled()
  })

  it('returns 400 when deviceId is missing', async () => {
    const res = await DELETE(makeEvent({ user: { id: 'sub-1' }, body: {} }))
    expect(res.status).toBe(400)
    expect(mockDeleteDevice).not.toHaveBeenCalled()
  })

  it('maps a backend/Synapse failure to 502 with the thrown message (byte-identical error contract)', async () => {
    mockDeleteDevice.mockRejectedValueOnce(new Error('Synapse 404'))
    const res = await DELETE(makeEvent({ user: { id: 'sub-1', preferredUsername: 'alice' }, body: { deviceId: 'DEVXYZ' } }))
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ success: false, error: 'Synapse 404' })
  })
})
