import { describe, it, expect, vi, beforeEach } from 'vitest'

// boundary rule A3a-2: this route no longer imports protocols/protocol-wopi (which
// pulled in the files module internals). getDraftWopiToken comes from the
// ProtocolDocumentPort registered in runtime-registry; the test registers a fake
// port and exercises the degradation path when no port is registered.

const { mockGetProtocol, mockGetDraftWopiToken } = vi.hoisted(() => ({
  mockGetProtocol: vi.fn(),
  mockGetDraftWopiToken: vi.fn(),
}))
const { mockHasRole } = vi.hoisted(() => ({ mockHasRole: vi.fn().mockReturnValue(true) }))

vi.mock('$lib/server/protocols/protocol-db', () => ({ getProtocol: mockGetProtocol }))
vi.mock('$lib/auth', () => ({
  hasRole: mockHasRole,
  Role: { Guest: 'guest', Member: 'member', CouncilAdmin: 'council-admin' },
}))

import { GET } from './+server'
import {
  registerProtocolDocumentPort,
  _resetRuntimeRegistryForTests,
} from '$lib/server/modules/runtime-registry'
import type { ProtocolDocumentPort } from '$lib/server/modules/runtime-registry'

function registerFakePort() {
  registerProtocolDocumentPort({
    getDraftWopiToken: mockGetDraftWopiToken,
    createDraftFile: vi.fn(),
    downloadDraft: vi.fn(),
    publishFile: vi.fn(),
    uploadPublishedPdf: vi.fn(),
    downloadPublishedPdf: vi.fn(),
    deleteDraftFile: vi.fn(),
  } as unknown as ProtocolDocumentPort)
}

const draftProtocol = {
  id: 'p1',
  status: 'draft',
  guest_edit_enabled: false,
  nextcloud_draft_path: '/protocols/drafts/p1.odt',
}

function makeEvent(opts: { roles?: string[] } = {}) {
  return {
    locals: { user: { id: 'u1', roles: opts.roles ?? ['member'] } },
    params: { id: 'p1' },
  } as unknown as Parameters<typeof GET>[0]
}

async function statusOf(p: Promise<unknown>): Promise<number> {
  try {
    await p
    return 200
  } catch (e: unknown) {
    return (e as { status?: number })?.status ?? 0
  }
}

describe('GET /api/protocols/[id]/wopi-token', () => {
  beforeEach(() => {
    _resetRuntimeRegistryForTests()
    registerFakePort()
    mockGetProtocol.mockReset()
    mockGetDraftWopiToken.mockReset()
    mockHasRole.mockReturnValue(true)
  })

  it('returns the editor url + ttl for a draft', async () => {
    mockGetProtocol.mockResolvedValue(draftProtocol)
    mockGetDraftWopiToken.mockResolvedValue({ editorUrl: 'http://collabora/edit?token=abc', tokenTtl: 3600 })
    const res = (await GET(makeEvent())) as Response
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.editorUrl).toBe('http://collabora/edit?token=abc')
    expect(mockGetDraftWopiToken).toHaveBeenCalledWith('/protocols/drafts/p1.odt')
  })

  it('404s when the protocol does not exist', async () => {
    mockGetProtocol.mockResolvedValue(null)
    expect(await statusOf(Promise.resolve(GET(makeEvent())))).toBe(404)
  })

  it('403s when the protocol is not a draft', async () => {
    mockGetProtocol.mockResolvedValue({ ...draftProtocol, status: 'published' })
    expect(await statusOf(Promise.resolve(GET(makeEvent())))).toBe(403)
  })

  it('400s when the draft has no Nextcloud path', async () => {
    mockGetProtocol.mockResolvedValue({ ...draftProtocol, nextcloud_draft_path: null })
    expect(await statusOf(Promise.resolve(GET(makeEvent())))).toBe(400)
  })

  // boundary rule A3a-2 degradation: no ProtocolDocumentPort registered -> 503.
  it('returns 503 when no ProtocolDocumentPort is registered', async () => {
    _resetRuntimeRegistryForTests()
    mockGetProtocol.mockResolvedValue(draftProtocol)
    expect(await statusOf(Promise.resolve(GET(makeEvent())))).toBe(503)
  })
})
