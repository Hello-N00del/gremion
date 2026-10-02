import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth'

// G-023 regression net.
//
// Wave 3a T2.5 hardens the chunked-upload route along three axes:
//   1. env vars resolved via `$env/dynamic/private` (not `process.env`);
//   2. `finalPath` runs through the shared `sanitizeRelPath` guard
//      (decodeURIComponent + `..` rejection + leading-slash strip);
//   3. `uploadId` must match `/^[A-Za-z0-9._-]{1,64}$/` so a hostile client
//      cannot inject `../other-user-id/...` into the Nextcloud upload URL.
//
// We mock the global `fetch` to observe what would be sent to Nextcloud
// without making real HTTP calls. `$env/dynamic/private` is mocked so we
// can vary which env vars are present per-test (mirrors the pattern in
// fints-config.integration.test.ts).
//
// `vi.resetModules()` between tests forces the handler to re-read the
// mocked `env` proxy each time, so per-test env overrides take effect.

const envState: { values: Record<string, string | undefined> } = {
  values: {
    NEXTCLOUD_URL: 'https://cloud.example.com',
    NEXTCLOUD_ADMIN_USER: 'admin',
    NEXTCLOUD_ADMIN_PASSWORD: 'admin-secret'
  }
}

// TASK-205a: the Nextcloud endpoint comes through the serviceEnv seam (the successor of the deleted
// default-tenant env reader), so the test drives the seam, not `$env/dynamic/private`.
vi.mock('$lib/server/env/service-env', () => ({
  serviceEnv: (name: string) => envState.values[name]
}))

function makeUser(role: Role = Role.Member): SessionUser {
  return {
    id: 'kc-sub-alice',
    email: 'alice@example.com',
    name: 'Alice',
    preferredUsername: 'alice',
    roles: [role],
    groups: [],
    loa: 0,
    authTime: 0
  }
}

function makeEvent(
  user: SessionUser | undefined,
  params: Record<string, string>,
  body: BodyInit | null = 'chunk-bytes'
) {
  const qs = new URLSearchParams(params).toString()
  const url = new URL(`http://localhost/api/files/upload-chunk?${qs}`)
  return {
    locals: { user },
    url,
    request: new Request(url, { method: 'POST', body })
    // SvelteKit's RequestEvent has many fields we don't exercise here.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

// `fetch` is mocked globally; each test seeds queued responses.
const fetchMock = vi.fn()

beforeEach(() => {
  vi.resetModules()
  envState.values = {
    NEXTCLOUD_URL: 'https://cloud.example.com',
    NEXTCLOUD_ADMIN_USER: 'admin',
    NEXTCLOUD_ADMIN_PASSWORD: 'admin-secret'
  }
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('POST /api/files/upload-chunk — G-023 validation gate', () => {
  it('returns 400 when finalPath contains a `..` segment', async () => {
    const { POST } = await import('./+server')
    await expect(
      POST(
        makeEvent(makeUser(), {
          uploadId: 'abc123',
          chunkIndex: '0',
          totalChunks: '1',
          finalPath: '../../etc/passwd'
        })
      )
    ).rejects.toMatchObject({ status: 400 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns 400 when uploadId contains a `..` segment', async () => {
    const { POST } = await import('./+server')
    await expect(
      POST(
        makeEvent(makeUser(), {
          uploadId: '../other',
          chunkIndex: '0',
          totalChunks: '1',
          finalPath: 'upload.bin'
        })
      )
    ).rejects.toMatchObject({ status: 400 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns 400 when uploadId contains unsafe characters', async () => {
    const { POST } = await import('./+server')
    await expect(
      POST(
        makeEvent(makeUser(), {
          uploadId: '<script>',
          chunkIndex: '0',
          totalChunks: '1',
          finalPath: 'upload.bin'
        })
      )
    ).rejects.toMatchObject({ status: 400 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns 400 when uploadId is empty', async () => {
    const { POST } = await import('./+server')
    await expect(
      POST(
        makeEvent(makeUser(), {
          uploadId: '',
          chunkIndex: '0',
          totalChunks: '1',
          finalPath: 'upload.bin'
        })
      )
    ).rejects.toMatchObject({ status: 400 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns 400 when uploadId exceeds 64 chars', async () => {
    const { POST } = await import('./+server')
    await expect(
      POST(
        makeEvent(makeUser(), {
          uploadId: 'a'.repeat(65),
          chunkIndex: '0',
          totalChunks: '1',
          finalPath: 'upload.bin'
        })
      )
    ).rejects.toMatchObject({ status: 400 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns 401 when no session user is present', async () => {
    const { POST } = await import('./+server')
    await expect(
      POST(
        makeEvent(undefined, {
          uploadId: 'abc123',
          chunkIndex: '0',
          totalChunks: '1',
          finalPath: 'upload.bin'
        })
      )
    ).rejects.toMatchObject({ status: 401 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns 403 for read-only Guest role', async () => {
    const { POST } = await import('./+server')
    await expect(
      POST(
        makeEvent(makeUser(Role.Guest), {
          uploadId: 'abc123',
          chunkIndex: '0',
          totalChunks: '1',
          finalPath: 'upload.bin'
        })
      )
    ).rejects.toMatchObject({ status: 403 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns 500 when Nextcloud env vars are missing', async () => {
    envState.values = {} // wipe all env
    const { POST } = await import('./+server')
    await expect(
      POST(
        makeEvent(makeUser(), {
          uploadId: 'abc123',
          chunkIndex: '0',
          totalChunks: '1',
          finalPath: 'upload.bin'
        })
      )
    ).rejects.toMatchObject({ status: 500 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('PUTs an intermediate chunk and returns success/complete=false', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 201 }))
    const { POST } = await import('./+server')
    const res = await POST(
      makeEvent(makeUser(), {
        uploadId: 'abc123',
        chunkIndex: '0',
        totalChunks: '3',
        finalPath: 'Docs/big.zip'
      })
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, complete: false })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [putUrl, putInit] = fetchMock.mock.calls[0]
    expect(putUrl).toBe(
      'https://cloud.example.com/remote.php/dav/uploads/kc-sub-alice/abc123/0000000000'
    )
    expect(putInit.method).toBe('PUT')
    expect(putInit.headers.Authorization).toMatch(/^Basic /)
  })

  it('PUTs the last chunk then MOVEs to dav/files/<userId>/<sanitizedPath>', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('', { status: 201 })) // PUT
      .mockResolvedValueOnce(new Response('', { status: 201 })) // MOVE
    const { POST } = await import('./+server')
    const res = await POST(
      makeEvent(makeUser(), {
        uploadId: 'abc123',
        chunkIndex: '2',
        totalChunks: '3',
        finalPath: '/Docs/big.zip',
        totalSize: '12345'
      })
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, complete: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)

    const [putUrl, putInit] = fetchMock.mock.calls[0]
    expect(putUrl).toBe(
      'https://cloud.example.com/remote.php/dav/uploads/kc-sub-alice/abc123/0000000002'
    )
    expect(putInit.method).toBe('PUT')

    const [moveUrl, moveInit] = fetchMock.mock.calls[1]
    expect(moveUrl).toBe(
      'https://cloud.example.com/remote.php/dav/uploads/kc-sub-alice/abc123/.file'
    )
    expect(moveInit.method).toBe('MOVE')
    expect(moveInit.headers.Destination).toBe(
      'https://cloud.example.com/remote.php/dav/files/kc-sub-alice/Docs/big.zip'
    )
    expect(moveInit.headers['OC-Total-Length']).toBe('12345')
    expect(moveInit.headers.Overwrite).toBe('F')
  })

  it('accepts a UUID-shaped uploadId as the client uses crypto.randomUUID()', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 201 }))
    const { POST } = await import('./+server')
    const res = await POST(
      makeEvent(makeUser(), {
        uploadId: '4f3c2b1a-1234-5678-9abc-def012345678',
        chunkIndex: '0',
        totalChunks: '2',
        finalPath: 'upload.bin'
      })
    )

    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
