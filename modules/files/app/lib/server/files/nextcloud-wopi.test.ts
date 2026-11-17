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

  // The name Collabora shows is the Nextcloud user the richdocuments session is created for. It must be the
  // person at the keyboard, never one shared service user.
  describe('editing identity', () => {
    const ok = () => ({ ok: true, json: async () => ({ ocs: { data: { url: 'http://nextcloud/editor' } } }) })
    const headersOfCall = (n: number) =>
      (mockFetch.mock.calls[n][1] as RequestInit & { headers: Record<string, string> }).headers

    it('creates the session with each user\'s own bearer, never the admin credentials', async () => {
      mockFetch.mockResolvedValueOnce(ok()).mockResolvedValueOnce(ok())
      const { createNextcloudClient } = await import('./nextcloud-client')
      await createNextcloudClient({ webdavBearer: 'bearer-alice' }).getDirectEditUrl(42, 'alice')
      await createNextcloudClient({ webdavBearer: 'bearer-bob' }).getDirectEditUrl(42, 'bob')

      expect(headersOfCall(0)['Authorization']).toBe('Bearer bearer-alice')
      expect(headersOfCall(1)['Authorization']).toBe('Bearer bearer-bob')
      for (const n of [0, 1]) {
        expect(headersOfCall(n)['Authorization']).not.toMatch(/^Basic /)
        expect(headersOfCall(n)['X-Nextcloud-User']).toBeUndefined()
      }
    })

    it('without a bearer, impersonates the requesting user: two users, two X-Nextcloud-User values', async () => {
      mockFetch.mockResolvedValueOnce(ok()).mockResolvedValueOnce(ok())
      const { createNextcloudClient } = await import('./nextcloud-client')
      const nc = createNextcloudClient()
      await nc.getDirectEditUrl(42, 'alice')
      await nc.getDirectEditUrl(42, 'bob')

      expect(headersOfCall(0)['X-Nextcloud-User']).toBe('alice')
      expect(headersOfCall(1)['X-Nextcloud-User']).toBe('bob')
    })

    it('resolves the file id as the same user that then creates the session', async () => {
      const propfind = {
        ok: true,
        text: async () =>
          '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:response><d:propstat><d:prop><oc:fileid>42</oc:fileid></d:prop></d:propstat></d:response></d:multistatus>'
      }
      mockFetch.mockResolvedValueOnce(propfind).mockResolvedValueOnce(ok())
      const { createNextcloudClient } = await import('./nextcloud-client')
      const nc = createNextcloudClient({ webdavBearer: 'bearer-carol' })
      const fileId = await nc.getFileId('/remote.php/dav/files/carol/doc.odt', 'carol')
      await nc.getDirectEditUrl(fileId, 'carol')

      expect(headersOfCall(0)['Authorization']).toBe('Bearer bearer-carol')
      expect(headersOfCall(1)['Authorization']).toBe('Bearer bearer-carol')
    })
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

// Collabora posts the editor's messages (save, close, UI_Close) to the origin Nextcloud recorded when it minted the
// WOPI token: the host of the request that opens the direct-view page, which is this server-side fetch. It must
// carry the origin the person's browser has, or the browser drops every message addressed to `http://nextcloud`.
describe('NextcloudClient.getCollaboraEditorUrl: editor origin', () => {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64')
  const directOk = () => ({
    ok: true,
    json: async () => ({ ocs: { data: { url: 'http://nextcloud/apps/richdocuments/direct/tok1' } } })
  })
  const page = {
    ok: true,
    status: 200,
    text: async () =>
      `<input id="initial-state-richdocuments-document" value="${b64({
        token: 'wopi-token',
        token_ttl: 1999999999,
        urlsrc: 'https://rat.example.test/office/browser/abc/cool.html?',
        fileId: '42_oc'
      })}"><input id="initial-state-richdocuments-wopi_callback_url" value="${b64('http://nextcloud')}">`
  }
  const headersOf = (n: number) =>
    (mockFetch.mock.calls[n][1] as RequestInit | undefined)?.headers as Record<string, string> | undefined

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('sends the browser origin as X-Forwarded-Host and X-Forwarded-Proto on the direct-view fetch only', async () => {
    mockFetch.mockResolvedValueOnce(directOk()).mockResolvedValueOnce(page)
    const { createNextcloudClient } = await import('./nextcloud-client')
    const out = await createNextcloudClient().getCollaboraEditorUrl(42, 'alice', {
      publicOrigin: 'https://rat.example.test'
    })

    expect(mockFetch.mock.calls[1][0]).toBe('http://nextcloud/apps/richdocuments/direct/tok1')
    expect(headersOf(1)).toEqual({ 'X-Forwarded-Host': 'rat.example.test', 'X-Forwarded-Proto': 'https' })
    // The createDirect call (the OCS POST) carries no forwarded header: only the page fetch mints the token.
    expect(headersOf(0)?.['X-Forwarded-Host']).toBeUndefined()
    // The editor URL itself is unchanged: WOPISrc stays the in-network callback.
    expect(out.editorUrl).toBe(
      'https://rat.example.test/office/browser/abc/cool.html?WOPISrc=' +
        encodeURIComponent('http://nextcloud/index.php/apps/richdocuments/wopi/files/42_oc') +
        '&access_token=wopi-token&access_token_ttl=1999999999000'
    )
  })

  it('keeps the port of the origin', async () => {
    mockFetch.mockResolvedValueOnce(directOk()).mockResolvedValueOnce(page)
    const { createNextcloudClient } = await import('./nextcloud-client')
    await createNextcloudClient().getCollaboraEditorUrl(42, 'alice', { publicOrigin: 'http://localhost:3000' })

    expect(headersOf(1)).toEqual({ 'X-Forwarded-Host': 'localhost:3000', 'X-Forwarded-Proto': 'http' })
  })

  it('sends no forwarded header without an origin (callers that have none keep the old behaviour)', async () => {
    mockFetch.mockResolvedValueOnce(directOk()).mockResolvedValueOnce(page)
    const { createNextcloudClient } = await import('./nextcloud-client')
    await createNextcloudClient().getCollaboraEditorUrl(42, 'alice')

    expect(mockFetch.mock.calls[1][1]).toBeUndefined()
  })

  it('opens the editor without the origin when Nextcloud does not accept it, with a fresh direct token', async () => {
    const refused = { ok: true, status: 200, text: async () => '<html>no editor state</html>' }
    mockFetch
      .mockResolvedValueOnce(directOk())
      .mockResolvedValueOnce(refused)
      .mockResolvedValueOnce(directOk())
      .mockResolvedValueOnce(page)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { createNextcloudClient } = await import('./nextcloud-client')
    const out = await createNextcloudClient().getCollaboraEditorUrl(42, 'alice', {
      publicOrigin: 'https://other.example.test'
    })

    expect(out.tokenTtl).toBe(1999999999)
    expect(mockFetch).toHaveBeenCalledTimes(4)
    expect(headersOf(1)?.['X-Forwarded-Host']).toBe('other.example.test')
    expect(mockFetch.mock.calls[3][1]).toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('trusted_domains'))
    warn.mockRestore()
  })
})

describe('NextcloudClient.getCollaboraEditorUrl: refused origin', () => {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64')
  const directOk = () => ({
    ok: true,
    json: async () => ({ ocs: { data: { url: 'http://nextcloud/apps/richdocuments/direct/tok1' } } })
  })
  const page = {
    ok: true,
    status: 200,
    text: async () =>
      `<input id="initial-state-richdocuments-document" value="${b64({
        token: 'wopi-token',
        token_ttl: 1999999999,
        urlsrc: 'https://rat.example.test/office/browser/abc/cool.html?',
        fileId: '42_oc'
      })}"><input id="initial-state-richdocuments-wopi_callback_url" value="${b64('http://nextcloud')}">`
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  // Nextcloud (stable33 base.php) answers a forwarded host outside trusted_domains with HTTP 400.
  it('retries without the origin when Nextcloud answers the forwarded host with HTTP 400', async () => {
    const badRequest = { ok: false, status: 400, text: async () => 'Trusted domain error.' }
    mockFetch
      .mockResolvedValueOnce(directOk())
      .mockResolvedValueOnce(badRequest)
      .mockResolvedValueOnce(directOk())
      .mockResolvedValueOnce(page)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { createNextcloudClient } = await import('./nextcloud-client')
    const out = await createNextcloudClient().getCollaboraEditorUrl(42, 'alice', {
      publicOrigin: 'https://other.example.test'
    })

    expect(out.tokenTtl).toBe(1999999999)
    expect(mockFetch).toHaveBeenCalledTimes(4)
    expect(mockFetch.mock.calls[3][1]).toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('trusted_domains'))
    warn.mockRestore()
  })

  it('does not retry (nor blame the origin) when createDirect itself fails', async () => {
    mockFetch.mockRejectedValueOnce(new Error('connect ECONNREFUSED'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { createNextcloudClient } = await import('./nextcloud-client')
    await expect(
      createNextcloudClient().getCollaboraEditorUrl(42, 'alice', { publicOrigin: 'https://rat.example.test' })
    ).rejects.toThrow('ECONNREFUSED')

    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('forwardedOriginHeaders', () => {
  it('accepts an http(s) origin with a plain host and refuses everything else', async () => {
    const { forwardedOriginHeaders } = await import('./nextcloud-client')
    expect(forwardedOriginHeaders('https://rat.example.test')).toEqual({
      'X-Forwarded-Host': 'rat.example.test',
      'X-Forwarded-Proto': 'https'
    })
    for (const bad of [undefined, '', 'not a url', 'javascript:alert(1)', 'ftp://rat.example.test']) {
      expect(forwardedOriginHeaders(bad), String(bad)).toEqual({})
    }
  })
})
