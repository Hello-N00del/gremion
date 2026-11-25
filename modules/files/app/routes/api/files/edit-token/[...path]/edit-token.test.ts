import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth'

const { mockGetFileId, mockGetCollaboraEditorUrl, clientOpts } = vi.hoisted(() => ({
  clientOpts: [] as Array<{ webdavBearer?: string } | undefined>,
  mockGetFileId: vi.fn(),
  mockGetCollaboraEditorUrl: vi.fn()
}))

vi.mock('$lib/server/files/nextcloud-client', () => ({
  createNextcloudClient: (opts?: { webdavBearer?: string }) => {
    clientOpts.push(opts)
    return { getFileId: mockGetFileId, getCollaboraEditorUrl: mockGetCollaboraEditorUrl }
  }
}))
vi.mock('$env/dynamic/private', () => ({ env: {} }))

function makeEvent(path: string, roles: Role[], preferredUsername: string | undefined = 'alice') {
  const user: SessionUser = {
    id: '1',
    email: 'alice@example.com',
    name: 'Alice',
    preferredUsername,
    roles,
    groups: [],
    loa: 0,
    authTime: 0
  }
  return {
    params: { path },
    locals: { user },
    url: new URL(`http://localhost/api/files/edit-token/${path}`),
    request: new Request(`http://localhost/api/files/edit-token/${path}`)
    // Intentionally loose — SvelteKit's RequestEvent has many fields we don't use here.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

describe('GET /api/files/edit-token/[...path]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetFileId.mockResolvedValue(42)
    // getCollaboraEditorUrl returns the full URL with access_token embedded as a query param.
    // The server strips it out and returns token/tokenTtl/editorUrl separately.
    mockGetCollaboraEditorUrl.mockResolvedValue({
      editorUrl: 'http://localhost:9980/loleaflet/index.html?access_token=tok123&access_token_ttl=36000000',
      tokenTtl: 36000
    })
  })

  it('returns WOPI token for .odt file for Member', async () => {
    const { GET } = await import('./+server')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (GET as any)(makeEvent('Docs/Protokoll.odt', [Role.Member]))
    const body = await res.json()

    expect(body).toEqual({
      token: 'tok123',
      tokenTtl: 36000,
      editorUrl: 'http://localhost:9980/loleaflet/index.html'
    })
    expect(mockGetCollaboraEditorUrl).toHaveBeenCalledWith(42, '1', { publicOrigin: 'http://localhost' })
  })

  it('returns WOPI token for Guest role', async () => {
    const { GET } = await import('./+server')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (GET as any)(makeEvent('Docs/report.odt', [Role.Guest]))

    expect(mockGetCollaboraEditorUrl).toHaveBeenCalledWith(42, '1', { publicOrigin: 'http://localhost' })
  })

  it('returns WOPI token for Finance role', async () => {
    const { GET } = await import('./+server')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (GET as any)(makeEvent('Finance/budget.ods', [Role.Finance]))

    expect(mockGetCollaboraEditorUrl).toHaveBeenCalledWith(42, '1', { publicOrigin: 'http://localhost' })
  })

  // Collabora posts the editor's messages (save, close) to the origin the WOPI token was minted for, so the
  // token request carries the host the person's browser has: the customer host of THIS request.
  it('asks for the editor under the origin of the request, not the in-network name', async () => {
    const { GET } = await import('./+server')
    const event = makeEvent('Docs/Protokoll.odt', [Role.Member])
    event.url = new URL('https://rat.example.test/api/files/edit-token/Docs/Protokoll.odt')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (GET as any)(event)

    expect(mockGetCollaboraEditorUrl).toHaveBeenCalledWith(42, '1', { publicOrigin: 'https://rat.example.test' })
  })

  it('returns 400 for unsupported extension .zip', async () => {
    const { GET } = await import('./+server')
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (GET as any)(makeEvent('archive.zip', [Role.Member]))
    ).rejects.toMatchObject({ status: 400 })
  })

  it('returns token for .pdf (Collabora supports PDF editing)', async () => {
    const { GET } = await import('./+server')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (GET as any)(makeEvent('report.pdf', [Role.Member]))
    const body = await res.json()
    expect(body.token).toBe('tok123')
  })

  it('returns 401 when user is not authenticated', async () => {
    const { GET } = await import('./+server')
    const event = {
      params: { path: 'file.odt' },
      locals: { user: undefined },
      url: new URL('http://localhost/'),
      request: new Request('http://localhost/')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect((GET as any)(event)).rejects.toMatchObject({ status: 401 })
  })

  it('returns 400 on path traversal attempt', async () => {
    const { GET } = await import('./+server')
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (GET as any)(makeEvent('Docs/../../etc/shadow.odt', [Role.Member]))
    ).rejects.toMatchObject({ status: 400 })
  })

  it('propagates Nextcloud errors as 502', async () => {
    mockGetFileId.mockRejectedValue(new Error('Nextcloud PROPFIND → 404: Not Found'))
    const { GET } = await import('./+server')
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (GET as any)(makeEvent('missing.odt', [Role.Member]))
    ).rejects.toMatchObject({ status: 502 })
  })

  it('answers a plain German message without the DAV path or the user id, and logs the detail', async () => {
    const uid = '3f0c9c1e-6a53-4f6e-9a3b-2f4a1c7d8e90'
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    mockGetFileId.mockRejectedValue(
      new Error(`Nextcloud PROPFIND /remote.php/dav/files/${uid}/missing.odt → 404: <d:error>sabre</d:error>`)
    )
    const { GET } = await import('./+server')
    let text = ''
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (GET as any)(makeEvent('missing.odt', [Role.Member]))
    } catch (e) {
      text = JSON.stringify((e as { body?: unknown }).body ?? {})
    }
    expect(text).toContain('Dokumentenspeicher')
    expect(text).not.toContain('remote.php')
    expect(text).not.toContain(uid)
    expect(text).not.toContain('Nextcloud PROPFIND')
    expect(JSON.stringify(log.mock.calls)).toContain('remote.php')
    log.mockRestore()
  })

  it('returns 400 for .md (not supported by Collabora)', async () => {
    const { GET } = await import('./+server')
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (GET as any)(makeEvent('Notes/meeting.md', [Role.Member]))
    ).rejects.toMatchObject({ status: 400 })
  })

  // Collabora shows the name of whoever the WOPI token was minted for. Two people co-editing one file must each
  // be minted their own token, as themselves: their own Keycloak id and their own bearer, never one shared
  // service identity (which would show both as the same person).
  it('mints the token as the requesting user: two users get their own id and their own bearer', async () => {
    const { GET } = await import('./+server')
    const asUser = (id: string, accessToken: string) =>
      ({
        params: { path: 'Docs/Protokoll.odt' },
        locals: { user: { id, email: `${id}@example.com`, name: id, roles: [Role.Member], groups: [], loa: 0, authTime: 0 }, accessToken },
        url: new URL('http://localhost/api/files/edit-token/Docs/Protokoll.odt'),
        request: new Request('http://localhost/api/files/edit-token/Docs/Protokoll.odt')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any

    clientOpts.length = 0
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (GET as any)(asUser('kc-alice', 'bearer-alice'))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (GET as any)(asUser('kc-bob', 'bearer-bob'))

    expect(clientOpts).toEqual([{ webdavBearer: 'bearer-alice' }, { webdavBearer: 'bearer-bob' }])
    expect(mockGetFileId.mock.calls.map((c) => c[1])).toEqual(['kc-alice', 'kc-bob'])
    expect(mockGetCollaboraEditorUrl.mock.calls.map((c) => c[1])).toEqual(['kc-alice', 'kc-bob'])
  })

  it('keys the WebDAV path by the Keycloak user id, not preferredUsername', async () => {
    const { GET } = await import('./+server')
    // Nextcloud user_oidc --unique-uid=0 → NC user id = Keycloak UUID (user.id).
    // preferredUsername 'bob' must be ignored; the path uses the mock id '1'.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (GET as any)(makeEvent('Docs/file.odt', [Role.Member], 'bob'))
    expect(mockGetFileId).toHaveBeenCalledWith(
      '/remote.php/dav/files/1/Docs/file.odt',
      '1'
    )
  })
})
