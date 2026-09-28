import { beforeEach, describe, expect, it, vi } from 'vitest'

// /content/new create action — the title field must come back as a rejected
// (400) validation, never a coerced string, when the client posts something
// other than a plain string under 'title' (e.g. a File). FormData.get()
// types as `string | File | null`, so `String(form.get('title') ?? '')`
// silently turns a File into the literal '[object File]' and persists it as
// the post title instead of refusing the submission.

const { mockRequireContentAuthor, mockResolveBackend, mockCreatePost } = vi.hoisted(() => ({
  mockRequireContentAuthor: vi.fn(),
  mockResolveBackend: vi.fn(),
  mockCreatePost: vi.fn(),
}))

vi.mock('$lib/server/content/route-auth', () => ({
  requireContentAuthor: mockRequireContentAuthor,
}))
vi.mock('$lib/server/content/backend/resolve', () => ({
  resolveContentBackendForPage: mockResolveBackend,
}))

import { actions } from './+page.server'

type Ev = Parameters<(typeof actions)['create']>[0]

function makeEvent(form: FormData): Ev {
  return {
    request: { formData: async () => form } as unknown as Request,
    locals: { user: { id: 'u1' } },
  } as unknown as Ev
}

describe('/content/new create action — title field type', () => {
  beforeEach(() => {
    mockRequireContentAuthor.mockReset()
    mockRequireContentAuthor.mockReturnValue({ id: 'u1' })
    mockResolveBackend.mockReset()
    mockResolveBackend.mockReturnValue({ createPost: mockCreatePost })
    mockCreatePost.mockReset()
  })

  it('accepts a plain string title and creates the post', async () => {
    const form = new FormData()
    form.set('title', 'Hello world')
    mockCreatePost.mockResolvedValue({ id: 'p1' })

    await expect(actions.create(makeEvent(form))).rejects.toMatchObject({
      status: 303,
      location: '/content/p1/edit',
    })
    expect(mockCreatePost).toHaveBeenCalledWith({ title: 'Hello world', created_by: 'u1' })
  })

  it('rejects a File posted under the title field with a 400 field error, never coercing it', async () => {
    const form = new FormData()
    form.set('title', new File(['x'], 'evil.txt', { type: 'text/plain' }))

    const result = await actions.create(makeEvent(form))

    expect(mockCreatePost).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      status: 400,
      data: { error: expect.any(String) },
    })
    // Must never persist the coerced '[object File]' string.
    expect((result as { data?: { title?: unknown } }).data?.title).not.toBe('[object File]')
  })

  it('still rejects a missing title with the existing empty-string message', async () => {
    const form = new FormData()

    const result = await actions.create(makeEvent(form))

    expect(mockCreatePost).not.toHaveBeenCalled()
    expect(result).toMatchObject({ status: 400, data: { error: 'Titel ist erforderlich.', title: '' } })
  })
})
