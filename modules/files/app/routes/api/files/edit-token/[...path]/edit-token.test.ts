import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth'

const { mockGetFileId, mockGetCollaboraEditorUrl } = vi.hoisted(() => ({
  mockGetFileId: vi.fn(),
  mockGetCollaboraEditorUrl: vi.fn()
}))

vi.mock('$lib/server/files/nextcloud-client', () => ({
  createNextcloudClient: () => ({
    getFileId: mockGetFileId,
    getCollaboraEditorUrl: mockGetCollaboraEditorUrl
  })
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
    expect(mockGetCollaboraEditorUrl).toHaveBeenCalledWith(42, '1')
  })

  it('returns WOPI token for Guest role', async () => {
    const { GET } = await import('./+server')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (GET as any)(makeEvent('Docs/report.odt', [Role.Guest]))

    expect(mockGetCollaboraEditorUrl).toHaveBeenCalledWith(42, '1')
  })

  it('returns WOPI token for Finance role', async () => {
    const { GET } = await import('./+server')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (GET as any)(makeEvent('Finance/budget.ods', [Role.Finance]))

    expect(mockGetCollaboraEditorUrl).toHaveBeenCalledWith(42, '1')
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

  it('returns 400 for .md (not supported by Collabora)', async () => {
    const { GET } = await import('./+server')
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (GET as any)(makeEvent('Notes/meeting.md', [Role.Member]))
    ).rejects.toMatchObject({ status: 400 })
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
