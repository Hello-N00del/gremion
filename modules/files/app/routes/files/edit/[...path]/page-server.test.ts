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
  // A failed Nextcloud call used to be shown with the upstream text, which carries the
  // internal DAV path and the user's Nextcloud id. The page shows a plain German sentence.
  const UID = '3f0c9c1e-6a53-4f6e-9a3b-2f4a1c7d8e90'
  const upstream = (status: number) =>
    new Error(`Nextcloud PROPFIND /remote.php/dav/files/${UID}/Docs/Missing.odt → ${status}: <d:error>sabre</d:error>`)

  async function failure(): Promise<{ status: number; text: string }> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (load as any)(makeEvent('Docs/Missing.odt', 'https://kunde.example'))
    } catch (e) {
      const err = e as { status?: number; body?: unknown }
      return { status: err.status ?? 0, text: JSON.stringify(err.body ?? {}) }
    }
    throw new Error('load did not fail')
  }

  function expectClean(text: string) {
    expect(text).not.toContain('remote.php')
    expect(text).not.toContain(UID)
    expect(text).not.toContain('Nextcloud PROPFIND')
    expect(text).not.toContain('sabre')
  }

  it('a missing file answers 404 without the DAV path or the user id', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    mockGetFileId.mockRejectedValue(upstream(404))
    const out = await failure()
    expect(out.status).toBe(404)
    expectClean(out.text)
  })

  it('a failed PROPFIND answers 502 without the DAV path or the user id and logs the detail', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    mockGetFileId.mockRejectedValue(upstream(500))
    const out = await failure()
    expect(out.status).toBe(502)
    expectClean(out.text)
    expect(JSON.stringify(log.mock.calls)).toContain('remote.php')
  })
})
