// A failed Nextcloud call used to be answered with the upstream error text, which
// carries the internal DAV path and with it the user's Nextcloud id
// ("Nextcloud PROPFIND /remote.php/dav/files/<id>/x → 404: ..."). The caller gets a
// plain German message and the right status; the detail goes to the server log only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextcloudResponseError } from '$lib/server/files/nextcloud-client'

const { mockPropfind, mockDownload, mockUpload, mockDelete, mockMove } = vi.hoisted(() => ({
  mockPropfind: vi.fn(),
  mockDownload: vi.fn(),
  mockUpload: vi.fn(),
  mockDelete: vi.fn(),
  mockMove: vi.fn(),
}))

vi.mock('$lib/server/files/backend/resolve', () => ({
  resolveFilesBackendOr503: () => ({
    propfind: mockPropfind,
    download: mockDownload,
    upload: mockUpload,
    delete: mockDelete,
    move: mockMove,
    copy: vi.fn(),
    mkcol: vi.fn(),
  }),
}))

import { GET, PUT, DELETE, PATCH } from './+server'

const UID = '3f0c9c1e-6a53-4f6e-9a3b-2f4a1c7d8e90'
const DAV = `/remote.php/dav/files/${UID}/Missing/Folder`
// The shape the real client throws for a failed request: it carries a numeric `status`.
const upstream = (status: number) =>
  new NextcloudResponseError({
    method: 'PROPFIND',
    path: DAV,
    status,
    contentType: 'application/xml',
    bodySnippet: '<d:error>sabre</d:error>',
  })

function event(path: string, init: { method?: string; body?: unknown } = {}) {
  return {
    params: { path },
    locals: {
      user: { id: UID, email: '', name: 'A', roles: ['member'], groups: [], loa: 0, authTime: 0 },
      accessToken: 'tok',
      accessTokenExpires: null,
    },
    url: new URL(`http://localhost/api/files/${path}`),
    request: new Request(`http://localhost/api/files/${path}`, {
      method: init.method ?? 'GET',
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
  } as never
}

/** Status and the whole response text of a handler that either returns or throws. */
async function outcome(run: () => Promise<Response> | Response): Promise<{ status: number; text: string }> {
  try {
    const res = await run()
    return { status: res.status, text: await res.text() }
  } catch (e) {
    const err = e as { status?: number; body?: unknown }
    return { status: err.status ?? 500, text: JSON.stringify(err.body ?? {}) }
  }
}

function expectClean(text: string) {
  expect(text).not.toContain('remote.php')
  expect(text).not.toContain(UID)
  expect(text).not.toContain('Nextcloud PROPFIND')
  expect(text).not.toContain('sabre')
}

let logged: unknown[][]
beforeEach(() => {
  for (const m of [mockPropfind, mockDownload, mockUpload, mockDelete, mockMove]) m.mockReset()
  logged = []
  vi.spyOn(console, 'error').mockImplementation((...a) => {
    logged.push(a)
  })
})
afterEach(() => vi.restoreAllMocks())

describe('GET /api/files/[...path] does not echo the internal path', () => {
  it('a missing folder answers 404 with a plain German message', async () => {
    mockPropfind.mockRejectedValue(upstream(404))
    const { status, text } = await outcome(() => GET(event('Missing/Folder')) as Promise<Response>)
    expect(status).toBe(404)
    expectClean(text)
    expect(text.toLowerCase()).toContain('nicht gefunden')
  })

  it('a missing file answers 404 without the path', async () => {
    mockDownload.mockRejectedValue(upstream(404))
    const { status, text } = await outcome(() => GET(event('Missing/x.pdf')) as Promise<Response>)
    expect(status).toBe(404)
    expectClean(text)
  })

  it('a refused folder answers 403 without the path', async () => {
    mockPropfind.mockRejectedValue(upstream(403))
    const { status, text } = await outcome(() => GET(event('Missing/Folder')) as Promise<Response>)
    expect(status).toBe(403)
    expectClean(text)
  })

  it('a failed PROPFIND answers 502 without the path', async () => {
    mockPropfind.mockRejectedValue(upstream(500))
    const { status, text } = await outcome(() => GET(event('Missing/Folder')) as Promise<Response>)
    expect(status).toBe(502)
    expectClean(text)
  })

  it('keeps the detail in the server log', async () => {
    mockPropfind.mockRejectedValue(upstream(404))
    await outcome(() => GET(event('Missing/Folder')) as Promise<Response>)
    expect(JSON.stringify(logged)).toContain('remote.php/dav/files')
  })
})

describe('PUT, DELETE and PATCH do not echo the internal path either', () => {
  it('PUT', async () => {
    mockUpload.mockRejectedValue(upstream(409))
    const { status, text } = await outcome(() => PUT(event('Missing/x.txt', { method: 'PUT', body: 'x' })) as Promise<Response>)
    expect(status).toBe(502)
    expectClean(text)
  })
  it('DELETE', async () => {
    mockDelete.mockRejectedValue(upstream(500))
    const { status, text } = await outcome(() => DELETE(event('Missing/x.txt', { method: 'DELETE' })) as Promise<Response>)
    expect(status).toBe(502)
    expectClean(text)
  })
  it('PATCH', async () => {
    mockMove.mockRejectedValue(upstream(412))
    const { status, text } = await outcome(
      () => PATCH(event('Missing/x.txt', { method: 'PATCH', body: { action: 'move', destination: 'y.txt' } })) as Promise<Response>,
    )
    expect(status).toBe(502)
    expectClean(text)
    expect(text).toContain('Dokumentenspeicher')
  })
  it('PATCH of a missing source is a 502 with the German message', async () => {
    mockMove.mockRejectedValue(upstream(404))
    const { status, text } = await outcome(
      () => PATCH(event('Missing/x.txt', { method: 'PATCH', body: { action: 'move', destination: 'y.txt' } })) as Promise<Response>,
    )
    expect(status).toBe(502)
    expectClean(text)
    expect(text).toContain('Dokumentenspeicher')
  })
  it('PATCH with an unknown action stays a 400', async () => {
    const { status } = await outcome(
      () => PATCH(event('Missing/x.txt', { method: 'PATCH', body: { action: 'nope', destination: 'y.txt' } })) as Promise<Response>,
    )
    expect(status).toBe(400)
  })
})
