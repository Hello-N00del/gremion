// modules/calendar/test/caldav-pusher.test.ts
//
// F1-FIX-08-K pusher behaviour (the WebDAV verbs themselves are covered in
// caldav.test.ts):
//   * K4#6  - DELETE 404/410 is SUCCESS (the object is already gone), so a
//             create-then-delete pair no longer parks in the failed list forever.
//   * K4#7  - every outbound fetch carries an AbortSignal timeout, so one hung
//             Nextcloud request cannot stall the tenant tick / the scheduler.

import { describe, it, expect, vi } from 'vitest'
import { createCalDavPusher } from '../src/caldav/pusher.js'

const BASE = {
  nextcloudUrl: 'http://nc.test',
  adminUser: 'admin',
  adminPassword: 'pw',
  sharedUser: 'admin',
  sharedCalendar: 'cal',
}

const ev = {
  uid: 'u1@stura',
  summary: 'X',
  description: null,
  location: null,
  dtstart: new Date('2026-06-01T10:00:00Z'),
  dtend: new Date('2026-06-01T11:00:00Z'),
  allDay: false,
}

describe('pushDelete: an already-gone object is success (K4#6)', () => {
  it('resolves on 404 and on 410', async () => {
    for (const status of [404, 410]) {
      const fetchImpl = vi.fn(async () => new Response('gone', { status }))
      const pusher = createCalDavPusher({ ...BASE, fetchImpl })
      await expect(pusher.pushDelete('u1@stura'), `status ${status}`).resolves.toBeUndefined()
    }
  })

  it('still rejects on a real failure (500) and on auth failure (401)', async () => {
    for (const status of [500, 401]) {
      const fetchImpl = vi.fn(async () => new Response('bad', { status }))
      const pusher = createCalDavPusher({ ...BASE, fetchImpl })
      await expect(pusher.pushDelete('u1@stura'), `status ${status}`).rejects.toThrow(String(status))
    }
  })

  it('does NOT make a PUT 404 a success (the collection is missing: that is a real error)', async () => {
    const fetchImpl = vi.fn(async () => new Response('no collection', { status: 404 }))
    const pusher = createCalDavPusher({ ...BASE, fetchImpl })
    await expect(pusher.pushCreate(ev)).rejects.toThrow('404')
  })
})

describe('outbound fetches are bounded by a timeout (K4#7)', () => {
  it('passes an AbortSignal on PUT and DELETE', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 204 }))
    const pusher = createCalDavPusher({ ...BASE, fetchImpl: fetchImpl as unknown as typeof fetch })
    await pusher.pushCreate(ev)
    await pusher.pushDelete('u1@stura')
    for (const [, init] of fetchImpl.mock.calls) {
      expect(init?.signal, 'fetch must carry an abort signal').toBeInstanceOf(AbortSignal)
    }
  })

  it('a hung Nextcloud rejects within the configured budget instead of stalling forever', async () => {
    const hung = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))
          // never resolves on its own
        }),
    )
    const pusher = createCalDavPusher({ ...BASE, timeoutMs: 25, fetchImpl: hung as unknown as typeof fetch })
    const started = Date.now()
    await expect(pusher.pushCreate(ev)).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(2000)
  })
})
