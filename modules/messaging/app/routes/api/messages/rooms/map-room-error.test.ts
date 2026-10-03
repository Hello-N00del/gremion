// src/routes/api/messages/rooms/map-room-error.test.ts
//
// LOW fix (house review, round-1 deferred, r2-rooms-B3): the 502 catch-all
// branch used to return the raw upstream Matrix/Synapse error message
// verbatim to the client — internal URLs, Synapse error codes and other
// transport detail leaking into a browser-visible JSON body. It now returns
// a fixed sentinel string; the raw message goes only to console.error.
import { describe, expect, it, vi } from 'vitest'
import {
  MatrixUnavailableError, RoomConflictError, RoomNotFoundError,
} from '$lib/server/messages/admin/room-admin'
import { mapRoomError } from './map-room-error'

describe('mapRoomError', () => {
  it('502s an unclassified error with a fixed sentinel, never the raw message', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = mapRoomError(new Error('connect to https://internal-synapse.local:8448 -> 500: <html>leaked</html>'))
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body).toEqual({ success: false, error: 'MATRIX_UPSTREAM_ERROR' })
    // The raw detail still reaches server-side logs, just never the client.
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('unclassified upstream error'),
      expect.objectContaining({ error: expect.stringContaining('internal-synapse.local') })
    )
    errSpy.mockRestore()
  })

  it('503s MatrixUnavailableError with the MATRIX_UNAVAILABLE sentinel', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = mapRoomError(new MatrixUnavailableError('ECONNREFUSED'))
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ success: false, error: 'MATRIX_UNAVAILABLE' })
  })

  it('409s RoomConflictError with the conflicting roomId', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = mapRoomError(new RoomConflictError('!existing:matrix.test'))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      success: false, error: 'room already exists', data: { roomId: '!existing:matrix.test' },
    })
  })

  it('404s RoomNotFoundError with its own (application-level, not upstream) message', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = mapRoomError(new RoomNotFoundError('org unit not found: u1'))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ success: false, error: 'org unit not found: u1' })
  })
})
