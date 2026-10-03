import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth'

// G-021 regression: the rename branch of PATCH /api/files/[...path] must
// route `destination` through buildWebdavPath so the shared path-traversal
// guard rejects `..` segments. Move/copy already do this; rename used to
// concatenate `dir + '/' + destination` and bypass the guard.

const { mockMove, mockCopy } = vi.hoisted(() => ({
  mockMove: vi.fn(),
  mockCopy: vi.fn()
}))

vi.mock('$lib/server/files/nextcloud-client', () => ({
  createNextcloudClient: () => ({
    move: mockMove,
    copy: mockCopy
  })
}))
vi.mock('$env/dynamic/private', () => ({ env: {} }))

function makeEvent(
  path: string,
  roles: Role[],
  body: unknown,
  preferredUsername: string | undefined = 'alice'
) {
  const user: SessionUser | undefined = roles.length
    ? {
        id: '1',
        email: 'alice@example.com',
        name: 'Alice',
        preferredUsername,
        roles,
        groups: [],
        loa: 0,
        authTime: 0
      }
    : undefined
  return {
    params: { path },
    locals: { user },
    url: new URL(`http://localhost/api/files/${path}`),
    request: new Request(`http://localhost/api/files/${path}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    // SvelteKit's RequestEvent has many fields we don't exercise here.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

function makeAnonymousEvent(path: string, body: unknown) {
  return {
    params: { path },
    locals: { user: undefined },
    url: new URL(`http://localhost/api/files/${path}`),
    request: new Request(`http://localhost/api/files/${path}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

describe('PATCH /api/files/[...path] — rename action (G-021)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockMove.mockResolvedValue(undefined)
    mockCopy.mockResolvedValue(undefined)
  })

  it('returns 400 when destination contains a path-traversal segment (`..`)', async () => {
    const { PATCH } = await import('./[...path]/+server')
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (PATCH as any)(
        makeEvent('Docs/file.txt', [Role.Member], {
          action: 'rename',
          destination: '../../../etc/passwd'
        })
      )
    ).rejects.toMatchObject({ status: 400 })
    // The guard must fire before any WebDAV call is dispatched.
    expect(mockMove).not.toHaveBeenCalled()
  })

  it('calls nextcloud.move with a destination scoped to the user webdav root for a valid basename', async () => {
    const { PATCH } = await import('./[...path]/+server')
    const res = await (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      PATCH as any
    )(
      makeEvent('Docs/old.txt', [Role.Member], {
        action: 'rename',
        destination: 'newname.txt'
      })
    )
    expect(res.status).toBe(200)
    expect(mockMove).toHaveBeenCalledTimes(1)
    expect(mockMove).toHaveBeenCalledWith(
      '/remote.php/dav/files/1/Docs/old.txt',
      '/remote.php/dav/files/1/newname.txt',
      '1'
    )
  })

  it('returns 403 for Guest (read-only) role', async () => {
    const { PATCH } = await import('./[...path]/+server')
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (PATCH as any)(
        makeEvent('Docs/file.txt', [Role.Guest], {
          action: 'rename',
          destination: 'newname.txt'
        })
      )
    ).rejects.toMatchObject({ status: 403 })
    expect(mockMove).not.toHaveBeenCalled()
  })

  it('returns 401 when the request is unauthenticated', async () => {
    const { PATCH } = await import('./[...path]/+server')
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (PATCH as any)(
        makeAnonymousEvent('Docs/file.txt', {
          action: 'rename',
          destination: 'newname.txt'
        })
      )
    ).rejects.toMatchObject({ status: 401 })
    expect(mockMove).not.toHaveBeenCalled()
  })
})
