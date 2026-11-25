import { beforeEach, describe, expect, test, vi } from 'vitest'

// The editor page load answers 404 for a post id that is not a UUID, before it
// asks the backend (the posts table keys on a uuid column; a malformed id would
// otherwise surface as a 500 from the database).

const { mockGetPost, mockGetChannels, mockListMedia } = vi.hoisted(() => ({
  mockGetPost: vi.fn(),
  mockGetChannels: vi.fn(),
  mockListMedia: vi.fn(),
}))

vi.mock('$lib/server/content/route-auth', () => ({ requireContentRead: () => undefined }))
vi.mock('$lib/server/content/backend/resolve', () => ({
  resolveContentBackendForPage: () => ({
    getPost: mockGetPost,
    getChannels: mockGetChannels,
    listMedia: mockListMedia,
  }),
}))

import { load } from './+page.server'

type LoadEvent = Parameters<typeof load>[0]

const PID = '0b7c6f1e-4a8e-4c51-9f3a-2d1e8c7b6a50'

function loadFor(id: string) {
  return load({ params: { id }, locals: { user: { id: 'u1' } } } as unknown as LoadEvent)
}

describe('content editor page load', () => {
  beforeEach(() => {
    mockGetPost.mockReset().mockResolvedValue({ id: PID, title: 'T' })
    mockGetChannels.mockReset().mockResolvedValue([])
    mockListMedia.mockReset().mockResolvedValue([])
  })

  test('404s a malformed post id before any backend call', async () => {
    await expect(loadFor('not-a-uuid')).rejects.toMatchObject({ status: 404 })
    expect(mockGetPost).not.toHaveBeenCalled()
  })

  test('loads the post for a valid id', async () => {
    const data = (await loadFor(PID)) as { post: { id: string } }
    expect(data.post.id).toBe(PID)
  })
})
