import { beforeEach, describe, expect, it, vi } from 'vitest'

// #389: the public upload route was broken by construction — it allow-listed the
// REQUEST Content-Type (always `multipart/form-data; boundary=…`) against media
// prefixes and then called formData(): multipart 415'd on the allowlist, a raw
// body 500'd inside formData(). These tests pin the fixed shape: a multipart
// upload whose FILE content type is allow-listed succeeds; everything else is a
// clean 4xx.

const { mockGetMatrixToken, mockUploadMedia, mockDownloadMedia, mockResolveCreds, mockIsRoomMember } = vi.hoisted(() => ({
  mockGetMatrixToken: vi.fn(),
  mockUploadMedia: vi.fn(),
  mockDownloadMedia: vi.fn(),
  mockResolveCreds: vi.fn(),
  mockIsRoomMember: vi.fn(),
}))

vi.mock('$lib/server/messages/backend', () => ({
  getMessagesBackend: () => ({
    matrix: () => ({
      getMatrixToken: mockGetMatrixToken,
      uploadMedia: mockUploadMedia,
      downloadMedia: mockDownloadMedia,
    }),
    resolveMatrixCreds: mockResolveCreds,
    synapse: () => ({ isRoomMember: mockIsRoomMember }),
  }),
}))

// The route only calls headers.get() + formData() on event.request — a small fake
// gives precise control over the Content-Type / Content-Length / body without
// depending on how the test runtime serializes a real multipart Request.
function fakeRequest(opts: {
  contentType?: string
  contentLength?: string
  formData?: FormData
  formDataThrows?: boolean
}): Request {
  const h = new Headers()
  if (opts.contentType) h.set('content-type', opts.contentType)
  if (opts.contentLength) h.set('content-length', opts.contentLength)
  return {
    headers: h,
    formData: async () => {
      if (opts.formDataThrows) throw new Error('malformed multipart')
      return opts.formData ?? new FormData()
    },
  } as unknown as Request
}

function makeEvent(opts: { authed?: boolean; request: Request; roomId?: string; accessToken?: string }) {
  const { authed = true, request, roomId = '!room1:matrix.test', accessToken = 'kc-jwt' } = opts
  const user = authed ? { id: 'u', email: 'u@example.org', name: 'u' } : null
  return {
    locals: {
      user,
      auth: async () => (user ? { user, accessToken, expires: '2099-01-01T00:00:00.000Z' } : null),
    },
    params: { roomId },
    request,
    url: new URL('http://localhost/api/messages/rooms/r/media'),
  } as unknown as import('@sveltejs/kit').RequestEvent
}

function multipart(file?: File): Request {
  const fd = new FormData()
  if (file) fd.append('file', file)
  return fakeRequest({ contentType: 'multipart/form-data; boundary=xyz', formData: fd })
}

/** Build a File and guarantee `.arrayBuffer()` — jsdom's File (the test env's
 *  global, which the route's `instanceof File` matches) omits it, though the real
 *  SvelteKit/undici runtime provides it. The payload bytes are never asserted
 *  (uploadMedia is mocked), so a constant string body suffices. */
function mediaFile(name: string, type: string): File {
  const body = 'media-bytes'
  const file = new File([body], name, { type })
  if (typeof (file as { arrayBuffer?: unknown }).arrayBuffer !== 'function') {
    Object.defineProperty(file, 'arrayBuffer', {
      value: async () => new TextEncoder().encode(body).buffer,
      configurable: true,
    })
  }
  return file
}

/** Assert the handler yields the given HTTP status whether it returns a Response
 *  or throws a SvelteKit HttpError. */
async function expectStatus(p: Promise<Response>, status: number) {
  try {
    const res = await p
    expect(res.status, await res.clone().text()).toBe(status)
  } catch (err) {
    expect((err as { status?: number }).status).toBe(status)
  }
}

let POST: (event: unknown) => Promise<Response>
let GET: (event: unknown) => Promise<Response>

beforeEach(async () => {
  process.env.AUTH_SECRET = 'test-secret'
  mockGetMatrixToken.mockReset().mockResolvedValue('matrix-token')
  mockUploadMedia.mockReset().mockResolvedValue('mxc://matrix.test/abc123')
  mockDownloadMedia.mockReset().mockResolvedValue({ data: new ArrayBuffer(3), contentType: 'image/png' })
  mockResolveCreds.mockReset().mockResolvedValue({ userId: '@u:matrix.test', accessToken: 'mx' })
  mockIsRoomMember.mockReset().mockResolvedValue(true)
  const mod = await import('./+server')
  POST = mod.POST as (event: unknown) => Promise<Response>
  GET = mod.GET as (event: unknown) => Promise<Response>
})

describe('POST /api/messages/rooms/[roomId]/media (#389)', () => {
  it('accepts a valid multipart upload (allow-listed FILE type) and returns a signed proxy URL', async () => {
    const file = mediaFile('pic.png', 'image/png')
    const res = await POST(makeEvent({ request: multipart(file) }))

    expect(res.status, await res.clone().text()).toBe(200)
    const body = (await res.json()) as { success: boolean; data: { url: string; filename: string; mimeType: string } }
    expect(body.success).toBe(true)
    expect(body.data.filename).toBe('pic.png')
    expect(body.data.mimeType).toBe('image/png')
    expect(body.data.url).toContain('/api/messages/rooms/')
    expect(body.data.url).toContain('mxc=')
    expect(body.data.url).toContain('sig=')
    expect(body.data.url).toContain('exp=')
    // uploaded AS the session's Matrix token, with the file's real bytes + type.
    expect(mockGetMatrixToken).toHaveBeenCalledWith('kc-jwt')
    expect(mockUploadMedia).toHaveBeenCalledOnce()
    const [token, , mime, name] = mockUploadMedia.mock.calls[0]
    expect(token).toBe('matrix-token')
    expect(mime).toBe('image/png')
    expect(name).toBe('pic.png')
  })

  it('rejects a non-multipart (raw body) request with 415 and never touches Matrix', async () => {
    await expectStatus(POST(makeEvent({ request: fakeRequest({ contentType: 'image/png' }) })), 415)
    expect(mockGetMatrixToken).not.toHaveBeenCalled()
    expect(mockUploadMedia).not.toHaveBeenCalled()
  })

  it('rejects a multipart upload missing the "file" field with 400', async () => {
    const fd = new FormData()
    fd.append('notfile', 'x')
    await expectStatus(
      POST(makeEvent({ request: fakeRequest({ contentType: 'multipart/form-data; boundary=xyz', formData: fd }) })),
      400,
    )
    expect(mockUploadMedia).not.toHaveBeenCalled()
  })

  it('rejects a file whose content type is not allow-listed with 415', async () => {
    const file = mediaFile('a.zip', 'application/zip')
    await expectStatus(POST(makeEvent({ request: multipart(file) })), 415)
    expect(mockUploadMedia).not.toHaveBeenCalled()
  })

  it('rejects an oversized upload via the Content-Length guard with 413 before parsing', async () => {
    await expectStatus(
      POST(
        makeEvent({
          request: fakeRequest({
            contentType: 'multipart/form-data; boundary=xyz',
            contentLength: String(21 * 1024 * 1024),
          }),
        }),
      ),
      413,
    )
    expect(mockUploadMedia).not.toHaveBeenCalled()
  })

  it('returns 400 on a malformed multipart body (formData parse error)', async () => {
    await expectStatus(
      POST(makeEvent({ request: fakeRequest({ contentType: 'multipart/form-data; boundary=xyz', formDataThrows: true }) })),
      400,
    )
    expect(mockUploadMedia).not.toHaveBeenCalled()
  })

  it('returns 401 for an unauthenticated request and never touches Matrix', async () => {
    const file = mediaFile('p.png', 'image/png')
    await expectStatus(POST(makeEvent({ authed: false, request: multipart(file) })), 401)
    expect(mockGetMatrixToken).not.toHaveBeenCalled()
    expect(mockUploadMedia).not.toHaveBeenCalled()
  })
})

// Security sweep: signed download URLs are bound to {mxc, roomId, exp} with a key derived from
// AUTH_SECRET, the download re-checks room membership, and the upstream Content-Type is not echoed.
describe('GET /api/messages/rooms/[roomId]/media (signed URL hardening)', () => {
  async function signedUrl(roomId = '!room1:matrix.test'): Promise<URL> {
    const res = await POST(makeEvent({ request: multipart(mediaFile('pic.png', 'image/png')), roomId }))
    const { data } = (await res.json()) as { data: { url: string } }
    return new URL(data.url, 'http://localhost')
  }
  function getEvent(url: URL, roomId = '!room1:matrix.test') {
    const user = { id: 'u', email: 'u@example.org', name: 'u' }
    return {
      locals: { user, auth: async () => ({ user, accessToken: 'kc-jwt' }) },
      params: { roomId },
      request: new Request(url),
      url,
    } as unknown as import('@sveltejs/kit').RequestEvent
  }

  it('serves a fresh signed URL to a room member with nosniff + attachment', async () => {
    const res = await GET(getEvent(await signedUrl()))
    expect(res.status).toBe(200)
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(res.headers.get('Content-Disposition')).toBe('attachment')
    expect(res.headers.get('Content-Type')).toBe('image/png')
  })

  it('rejects an expired URL', async () => {
    const url = await signedUrl()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 7 * 24 * 3600_000)
    try {
      await expectStatus(GET(getEvent(url)), 403)
    } finally {
      vi.useRealTimers()
    }
    expect(mockDownloadMedia).not.toHaveBeenCalled()
  })

  it('rejects a tampered exp (signature covers it)', async () => {
    const url = await signedUrl()
    url.searchParams.set('exp', String(Number(url.searchParams.get('exp')) + 1_000_000))
    await expectStatus(GET(getEvent(url)), 403)
  })

  it('rejects the URL replayed against another room', async () => {
    const url = await signedUrl('!room1:matrix.test')
    await expectStatus(GET(getEvent(url, '!other:matrix.test')), 403)
    expect(mockDownloadMedia).not.toHaveBeenCalled()
  })

  it('rejects a logged-in user who is not a member of the room', async () => {
    const url = await signedUrl()
    mockIsRoomMember.mockResolvedValue(false)
    await expectStatus(GET(getEvent(url)), 403)
    expect(mockDownloadMedia).not.toHaveBeenCalled()
  })

  it('rejects the legacy unbound signature HMAC(AUTH_SECRET, mxc)', async () => {
    const { createHmac } = await import('node:crypto')
    const mxc = 'mxc://matrix.test/abc123'
    const sig = createHmac('sha256', 'test-secret').update(mxc).digest('hex')
    const url = new URL(`http://localhost/api/messages/rooms/r/media?mxc=${encodeURIComponent(mxc)}&sig=${sig}`)
    await expectStatus(GET(getEvent(url)), 403)
  })

  it('does not echo an active upstream content type: html/svg become octet-stream', async () => {
    mockDownloadMedia.mockResolvedValue({ data: new ArrayBuffer(3), contentType: 'text/html' })
    const res = await GET(getEvent(await signedUrl()))
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream')
    mockDownloadMedia.mockResolvedValue({ data: new ArrayBuffer(3), contentType: 'image/svg+xml' })
    const res2 = await GET(getEvent(await signedUrl()))
    expect(res2.headers.get('Content-Type')).toBe('application/octet-stream')
  })
})

describe('POST membership gate', () => {
  it('403s an upload to a room the caller is not a member of, before touching Matrix media', async () => {
    mockIsRoomMember.mockResolvedValue(false)
    const file = mediaFile('p.png', 'image/png')
    await expectStatus(POST(makeEvent({ request: multipart(file) })), 403)
    expect(mockUploadMedia).not.toHaveBeenCalled()
  })

  it('403s when the caller has no Matrix identity', async () => {
    mockResolveCreds.mockResolvedValue({ userId: '', accessToken: '' })
    const file = mediaFile('p.png', 'image/png')
    await expectStatus(POST(makeEvent({ request: multipart(file) })), 403)
    expect(mockUploadMedia).not.toHaveBeenCalled()
  })
})
