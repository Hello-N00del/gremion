import { beforeEach, describe, expect, it, vi } from 'vitest'

// #389: the public upload route was broken by construction — it allow-listed the
// REQUEST Content-Type (always `multipart/form-data; boundary=…`) against media
// prefixes and then called formData(): multipart 415'd on the allowlist, a raw
// body 500'd inside formData(). These tests pin the fixed shape: a multipart
// upload whose FILE content type is allow-listed succeeds; everything else is a
// clean 4xx.

const { mockGetMatrixToken, mockUploadMedia } = vi.hoisted(() => ({
  mockGetMatrixToken: vi.fn(),
  mockUploadMedia: vi.fn(),
}))

vi.mock('$lib/server/messages/backend', () => ({
  getMessagesBackend: () => ({
    matrix: () => ({
      getMatrixToken: mockGetMatrixToken,
      uploadMedia: mockUploadMedia,
    }),
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

beforeEach(async () => {
  process.env.AUTH_SECRET = 'test-secret'
  mockGetMatrixToken.mockReset().mockResolvedValue('matrix-token')
  mockUploadMedia.mockReset().mockResolvedValue('mxc://matrix.test/abc123')
  const mod = await import('./+server')
  POST = mod.POST as (event: unknown) => Promise<Response>
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
