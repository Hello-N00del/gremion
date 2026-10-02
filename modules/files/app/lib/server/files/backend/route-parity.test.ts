// gremion-ui/src/lib/server/files/backend/route-parity.test.ts
// TDD seam test (mirrors calendar/content backend/route-parity intent for the
// files subsystem). With FILES_BACKEND unset the factory returns the INPROCESS
// client and every WebDAV op delegates to the existing kernel
// `createNextcloudClient` path UNCHANGED (byte-identical to the pre-seam route),
// and the chunked-upload assembly still runs its raw admin-Basic fetch path.
//
// This is the RED test: it fails until port + inprocess-client + index + resolve
// exist. It pins the delegation contract so the flag-OFF default can never drift
// away from byte-identical monolith behavior.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The inprocess client wraps createNextcloudClient() — mock it so we can observe
// pass-through delegation of every browser WebDAV op. NextcloudResponseError is
// re-exported through the seam, so the mock must also provide the class.
const { mkClient, ncMethods } = vi.hoisted(() => {
  const ncMethods = {
    propfind: vi.fn(),
    download: vi.fn(),
    upload: vi.fn(),
    mkcol: vi.fn(),
    delete: vi.fn(),
    move: vi.fn(),
    copy: vi.fn(),
  }
  return { ncMethods, mkClient: vi.fn(() => ncMethods) }
})

vi.mock('$lib/server/files/nextcloud-client', () => ({
  createNextcloudClient: mkClient,
  NextcloudResponseError: class NextcloudResponseError extends Error {},
}))

// The chunked-upload assembly resolves NC env via defaultTenantEnv →
// $env/dynamic/private and uses the global fetch. Mock both (mirrors
// upload-chunk.test.ts).
const envState: { values: Record<string, string | undefined> } = {
  values: {
    NEXTCLOUD_URL: 'https://cloud.example.com',
    NEXTCLOUD_ADMIN_USER: 'admin',
    NEXTCLOUD_ADMIN_PASSWORD: 'admin-secret',
  },
}
vi.mock('$env/dynamic/private', () => ({
  env: new Proxy({} as Record<string, string | undefined>, {
    get: (_t, prop: string) => envState.values[prop],
  }),
}))

const fetchMock = vi.fn()

beforeEach(() => {
  delete process.env.FILES_BACKEND
  for (const fn of Object.values(ncMethods)) fn.mockReset()
  mkClient.mockClear()
  envState.values = {
    NEXTCLOUD_URL: 'https://cloud.example.com',
    NEXTCLOUD_ADMIN_USER: 'admin',
    NEXTCLOUD_ADMIN_PASSWORD: 'admin-secret',
  }
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('files backend seam — FILES_BACKEND unset → inprocess delegation', () => {
  it('getFilesBackend() returns the inprocess client', async () => {
    const { getFilesBackend } = await import('./index')
    expect(getFilesBackend().kind).toBe('inprocess')
  })

  it('resolveFilesBackendOr503() returns the inprocess client (not a Response)', async () => {
    const { resolveFilesBackendOr503 } = await import('./resolve')
    const resolved = resolveFilesBackendOr503()
    expect(resolved).not.toBeInstanceOf(Response)
    expect((resolved as { kind: string }).kind).toBe('inprocess')
  })

  it('constructs createNextcloudClient with the per-request webdavBearer on first op', async () => {
    ncMethods.propfind.mockResolvedValue([])
    const { getFilesBackend } = await import('./index')
    // NC is built lazily on the first WebDAV op (byte-identical to the route's
    // single per-request `const nc = createNextcloudClient({...})`).
    await getFilesBackend({ webdavBearer: 'kc-access-token' }).propfind('/remote.php/dav/files/u/', 'u')
    expect(mkClient).toHaveBeenCalledWith({ webdavBearer: 'kc-access-token' })
  })

  it('propfind delegates to createNextcloudClient().propfind unchanged', async () => {
    ncMethods.propfind.mockResolvedValue([{ href: '/remote.php/dav/files/u/A' }])
    const { getFilesBackend } = await import('./index')
    const out = await getFilesBackend({ webdavBearer: 't' }).propfind(
      '/remote.php/dav/files/u/Docs',
      'u',
    )
    expect(ncMethods.propfind).toHaveBeenCalledWith('/remote.php/dav/files/u/Docs', 'u')
    expect(out).toEqual([{ href: '/remote.php/dav/files/u/A' }])
  })

  it('download delegates to createNextcloudClient().download unchanged', async () => {
    const resp = new Response('bytes')
    ncMethods.download.mockResolvedValue(resp)
    const { getFilesBackend } = await import('./index')
    const out = await getFilesBackend().download('/remote.php/dav/files/u/f.pdf', 'u')
    expect(ncMethods.download).toHaveBeenCalledWith('/remote.php/dav/files/u/f.pdf', 'u')
    expect(out).toBe(resp)
  })

  it('upload delegates to createNextcloudClient().upload unchanged', async () => {
    ncMethods.upload.mockResolvedValue(undefined)
    const { getFilesBackend } = await import('./index')
    const body = new ReadableStream()
    await getFilesBackend().upload('/remote.php/dav/files/u/f.txt', 'u', body, 'text/plain')
    expect(ncMethods.upload).toHaveBeenCalledWith('/remote.php/dav/files/u/f.txt', 'u', body, 'text/plain')
  })

  it('mkcol delegates to createNextcloudClient().mkcol unchanged', async () => {
    ncMethods.mkcol.mockResolvedValue(undefined)
    const { getFilesBackend } = await import('./index')
    await getFilesBackend().mkcol('/remote.php/dav/files/u/NewDir', 'u')
    expect(ncMethods.mkcol).toHaveBeenCalledWith('/remote.php/dav/files/u/NewDir', 'u')
  })

  it('delete delegates to createNextcloudClient().delete unchanged', async () => {
    ncMethods.delete.mockResolvedValue(undefined)
    const { getFilesBackend } = await import('./index')
    await getFilesBackend().delete('/remote.php/dav/files/u/f.txt', 'u')
    expect(ncMethods.delete).toHaveBeenCalledWith('/remote.php/dav/files/u/f.txt', 'u')
  })

  it('move delegates to createNextcloudClient().move unchanged', async () => {
    ncMethods.move.mockResolvedValue(undefined)
    const { getFilesBackend } = await import('./index')
    await getFilesBackend().move(
      '/remote.php/dav/files/u/old.txt',
      '/remote.php/dav/files/u/new.txt',
      'u',
    )
    expect(ncMethods.move).toHaveBeenCalledWith(
      '/remote.php/dav/files/u/old.txt',
      '/remote.php/dav/files/u/new.txt',
      'u',
    )
  })

  it('copy delegates to createNextcloudClient().copy unchanged', async () => {
    ncMethods.copy.mockResolvedValue(undefined)
    const { getFilesBackend } = await import('./index')
    await getFilesBackend().copy(
      '/remote.php/dav/files/u/a.txt',
      '/remote.php/dav/files/u/b.txt',
      'u',
    )
    expect(ncMethods.copy).toHaveBeenCalledWith(
      '/remote.php/dav/files/u/a.txt',
      '/remote.php/dav/files/u/b.txt',
      'u',
    )
  })

  it('uploadChunk assembles via the raw admin-Basic fetch path (PUT then MOVE on last chunk)', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('', { status: 201 })) // PUT chunk
      .mockResolvedValueOnce(new Response('', { status: 201 })) // MOVE assemble
    const { getFilesBackend } = await import('./index')
    const res = await getFilesBackend().uploadChunk({
      userId: 'kc-sub-alice',
      uploadId: 'abc123',
      chunkIndex: 2,
      totalChunks: 3,
      sanitizedPath: 'Docs/big.zip',
      totalSize: '12345',
      body: null,
    })
    expect(res).toEqual({ complete: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [putUrl, putInit] = fetchMock.mock.calls[0]
    expect(putUrl).toBe(
      'https://cloud.example.com/remote.php/dav/uploads/kc-sub-alice/abc123/0000000002',
    )
    expect(putInit.method).toBe('PUT')
    const [moveUrl, moveInit] = fetchMock.mock.calls[1]
    expect(moveUrl).toBe(
      'https://cloud.example.com/remote.php/dav/uploads/kc-sub-alice/abc123/.file',
    )
    expect(moveInit.method).toBe('MOVE')
    expect(moveInit.headers.Destination).toBe(
      'https://cloud.example.com/remote.php/dav/files/kc-sub-alice/Docs/big.zip',
    )
    // NC path is NOT touched by createNextcloudClient — chunked assembly is raw.
    expect(mkClient).not.toHaveBeenCalled()
  })

  it('uploadChunk throws a 500 when NC env is missing (before any fetch)', async () => {
    envState.values = {}
    const { getFilesBackend } = await import('./index')
    await expect(
      getFilesBackend().uploadChunk({
        userId: 'u',
        uploadId: 'abc123',
        chunkIndex: 0,
        totalChunks: 1,
        sanitizedPath: 'f.bin',
        totalSize: null,
        body: null,
      }),
    ).rejects.toMatchObject({ status: 500 })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
