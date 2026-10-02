import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock $env/dynamic/private before importing the client
vi.mock('$env/dynamic/private', () => ({
  env: {
    NEXTCLOUD_URL: 'http://nextcloud',
    NEXTCLOUD_ADMIN_USER: 'admin',
    NEXTCLOUD_ADMIN_PASSWORD: 'secret',
    NEXTCLOUD_USER_TOKENS: '',
    NEXTCLOUD_CALDAV_USER_TOKENS: ''
  }
}))

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

describe('NextcloudClient.getFileId', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('parses fileid from PROPFIND response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:response>
    <d:href>/remote.php/dav/files/alice/doc.odt</d:href>
    <d:propstat>
      <d:prop><oc:fileid>42</oc:fileid></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`
    })

    const { createNextcloudClient } = await import('./nextcloud-client')
    const nc = createNextcloudClient()
    const fileId = await nc.getFileId('/remote.php/dav/files/alice/doc.odt', 'alice')

    expect(fileId).toBe(42)
    expect(mockFetch).toHaveBeenCalledWith(
      'http://nextcloud/remote.php/dav/files/alice/doc.odt',
      expect.objectContaining({ method: 'PROPFIND' })
    )
  })

  it('sends Depth:0 and impersonation header when no user token configured', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:response><d:propstat><d:prop><oc:fileid>7</oc:fileid></d:prop></d:propstat></d:response>
</d:multistatus>`
    })

    const { createNextcloudClient } = await import('./nextcloud-client')
    const nc = createNextcloudClient()
    await nc.getFileId('/remote.php/dav/files/bob/file.odt', 'bob')

    const call = mockFetch.mock.calls[0][1] as RequestInit & { headers: Record<string, string> }
    expect(call.headers['Depth']).toBe('0')
    expect(call.headers['X-Nextcloud-User']).toBe('bob')
    expect(call.headers['OCS-APIRequest']).toBe('true')
  })

  it('throws when fileid is missing from response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () =>
        `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:"><d:response><d:href>/path</d:href></d:response></d:multistatus>`
    })

    const { createNextcloudClient } = await import('./nextcloud-client')
    const nc = createNextcloudClient()
    await expect(
      nc.getFileId('/remote.php/dav/files/alice/missing.odt', 'alice')
    ).rejects.toThrow('Could not parse fileId')
  })

  it('throws on non-2xx response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => 'Not Found'
    })

    const { createNextcloudClient } = await import('./nextcloud-client')
    const nc = createNextcloudClient()
    await expect(
      nc.getFileId('/remote.php/dav/files/alice/missing.odt', 'alice')
    ).rejects.toThrow(/404/)
  })
})

describe('NextcloudClient.getDirectEditUrl', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns the editor URL from the OCS response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ocs: {
          meta: { status: 'ok', statuscode: 200 },
          data: { url: 'http://nextcloud/apps/richdocuments/open?fileId=42&token=abc' }
        }
      })
    })

    const { createNextcloudClient } = await import('./nextcloud-client')
    const nc = createNextcloudClient()
    const result = await nc.getDirectEditUrl(42, 'alice')

    expect(result).toBe('http://nextcloud/apps/richdocuments/open?fileId=42&token=abc')
  })

  it('POSTs to the richdocuments OCS endpoint with fileId in body', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ocs: { data: { url: 'http://nextcloud/editor' } } })
    })

    const { createNextcloudClient } = await import('./nextcloud-client')
    const nc = createNextcloudClient()
    await nc.getDirectEditUrl(99, 'bob')

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/ocs/v2.php/apps/richdocuments/api/v1/document')
    expect(init.method).toBe('POST')
    expect(init.body).toBe('fileId=99')
  })

  it('uses X-Nextcloud-User impersonation when no per-user token is configured', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ocs: { data: { url: 'http://nextcloud/editor' } } })
    })

    const { createNextcloudClient } = await import('./nextcloud-client')
    const nc = createNextcloudClient()
    await nc.getDirectEditUrl(42, 'charlie')

    const headers = (mockFetch.mock.calls[0][1] as RequestInit & { headers: Record<string, string> }).headers
    expect(headers['X-Nextcloud-User']).toBe('charlie')
  })

  it('throws when url is missing from the response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ocs: { data: {} } })
    })

    const { createNextcloudClient } = await import('./nextcloud-client')
    const nc = createNextcloudClient()
    await expect(nc.getDirectEditUrl(42, 'alice')).rejects.toThrow('createDirect: missing url in response')
  })
})
