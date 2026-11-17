import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SessionUser } from '$lib/auth'

// The editor page load mints the WOPI editor URL. The origin the browser has for this app must reach
// the Nextcloud client: the editor posts its messages (save, close) to it, and the in-network origin
// is dropped by the browser.
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

import { load } from './+page.server'

function makeEvent(path: string, origin: string) {
  const user = { id: 'u1', roles: [], groups: [] } as unknown as SessionUser
  return {
    params: { path },
    locals: { user },
    url: new URL(`${origin}/files/edit/${path}`)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

describe('files edit page load', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetFileId.mockResolvedValue(42)
    mockGetCollaboraEditorUrl.mockResolvedValue({ editorUrl: 'http://collabora/edit?x=1', tokenTtl: 3600 })
  })

  it('forwards the browser origin so the editor posts its messages to the customer host', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = (await (load as any)(makeEvent('Docs/Protokoll.odt', 'https://kunde.example'))) as {
      editorUrl: string
    }
    expect(data.editorUrl).toBe('http://collabora/edit?x=1')
    expect(mockGetCollaboraEditorUrl).toHaveBeenCalledWith(42, 'u1', { publicOrigin: 'https://kunde.example' })
  })
})
