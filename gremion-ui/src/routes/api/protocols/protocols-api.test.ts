import { describe, it, expect, vi, beforeEach } from 'vitest'

// boundary rule A3a-2: this route no longer imports protocols/protocol-wopi (which
// pulled in the files module internals). The Nextcloud draft ops come from the
// ProtocolDocumentPort registered in runtime-registry; the test registers a fake
// port (files module absent in unit tests) and exercises the degradation path
// when no port is registered.

const { mockCreateProtocol, mockListProtocols, mockGetProtocol,
        mockCreateDraftFile, mockDeleteDraftFile, mockUpdateProtocolDb, mockDeleteProtocol } = vi.hoisted(() => ({
  mockCreateProtocol: vi.fn(),
  mockListProtocols: vi.fn(),
  mockGetProtocol: vi.fn(),
  mockCreateDraftFile: vi.fn(),
  mockDeleteDraftFile: vi.fn(),
  mockUpdateProtocolDb: vi.fn(),
  mockDeleteProtocol: vi.fn(),
}))
const { mockHasRole } = vi.hoisted(() => ({ mockHasRole: vi.fn().mockReturnValue(true) }))

vi.mock('$lib/server/protocols/protocol-db', () => ({
  createProtocol: mockCreateProtocol,
  listProtocols: mockListProtocols,
  getProtocol: mockGetProtocol,
  updateProtocol: mockUpdateProtocolDb,
  deleteProtocol: mockDeleteProtocol,
}))
// R29-F104-KTWIN: GET resolves the unit before listing (unknown unit = 404 for
// every role), so the unit lookup is stubbed here; the visibility rule itself
// is pinned in protocols-visibility.test.ts with the real role helper.
vi.mock('$lib/server/governance/org-units-db', () => ({
  getOrgUnit: vi.fn(async (id: string) => ({ id, visibility: 'all_members' })),
  isMemberOf: vi.fn(async () => false),
}))
vi.mock('$lib/auth', () => ({
  hasRole: mockHasRole,
  Role: { Guest: 'guest', Member: 'member', CouncilAdmin: 'council-admin', ITAdmin: 'it-admin' },
}))

import { GET, POST } from './+server'
import {
  registerProtocolDocumentPort,
  _resetRuntimeRegistryForTests,
} from '$lib/server/modules/runtime-registry'
import type { ProtocolDocumentPort } from '$lib/server/modules/runtime-registry'

// A fake port: only the two ops this route drives are wired; the rest throw so a
// mis-wiring is loud.
function registerFakePort() {
  registerProtocolDocumentPort({
    createDraftFile: mockCreateDraftFile,
    deleteDraftFile: mockDeleteDraftFile,
    getDraftWopiToken: vi.fn(),
    downloadDraft: vi.fn(),
    publishFile: vi.fn(),
    uploadPublishedPdf: vi.fn(),
    downloadPublishedPdf: vi.fn(),
  } as unknown as ProtocolDocumentPort)
}

function makeEvent(opts: { roles?: string[]; body?: unknown; params?: Record<string, string>; search?: Record<string, string> } = {}) {
  return {
    locals: { user: { id: 'user-1', roles: opts.roles ?? ['council-admin'] } },
    request: { json: async () => opts.body ?? {} },
    params: opts.params ?? {},
    url: { searchParams: new URLSearchParams(opts.search ?? {}) },
  }
}

describe('GET /api/protocols', () => {
  beforeEach(() => { _resetRuntimeRegistryForTests(); registerFakePort(); mockListProtocols.mockReset() })

  it('returns protocol list for a committee', async () => {
    mockListProtocols.mockResolvedValue([{ id: 'p1', title: 'VV April', status: 'draft' }])
    // @ts-expect-error partial mock
    const res = await GET(makeEvent({ search: { committeeId: 'comm-1' } }))
    const body = await res.json()
    expect(body.protocols).toHaveLength(1)
    expect(body.protocols[0].id).toBe('p1')
  })

  it('returns 400 if committeeId missing', async () => {
    // @ts-expect-error partial mock
    const res = await GET(makeEvent())
    expect(res.status).toBe(400)
  })
})

describe('POST /api/protocols', () => {
  beforeEach(() => {
    _resetRuntimeRegistryForTests()
    registerFakePort()
    mockCreateProtocol.mockReset(); mockCreateDraftFile.mockReset(); mockDeleteDraftFile.mockReset()
    mockUpdateProtocolDb.mockReset(); mockDeleteProtocol.mockReset()
    mockHasRole.mockReturnValue(true)
  })

  it('creates protocol + draft file and returns 201', async () => {
    mockCreateProtocol.mockResolvedValue({ id: 'p-new', status: 'draft' })
    mockCreateDraftFile.mockResolvedValue('/protocols/drafts/p-new.odt')
    mockUpdateProtocolDb.mockResolvedValue({ id: 'p-new', status: 'draft', nextcloud_draft_path: '/protocols/drafts/p-new.odt' })
    // @ts-expect-error partial mock
    const res = await POST(makeEvent({ body: { committeeId: 'c1', meetingDate: '2026-04-16', title: 'VV' } }))
    expect(res.status).toBe(201)
  })

  it('F1: keeps the protocol (in-app only) and returns 201 when Nextcloud draft creation fails', async () => {
    mockCreateProtocol.mockResolvedValue({ id: 'p-nc-down', status: 'draft' })
    mockCreateDraftFile.mockRejectedValue(new Error('Nextcloud upload failed'))
    // @ts-expect-error partial mock
    const res = await POST(makeEvent({ body: { committeeId: 'c1', meetingDate: '2026-04-16', title: 'VV' } }))
    expect(res.status).toBe(201)
    expect(mockDeleteProtocol).not.toHaveBeenCalled()
    expect(mockUpdateProtocolDb).not.toHaveBeenCalled()
  })

  it('deletes the protocol row + orphaned draft and returns 502 when updateProtocol fails (#185/#208)', async () => {
    mockCreateProtocol.mockResolvedValue({ id: 'p-orphan2', status: 'draft' })
    mockCreateDraftFile.mockResolvedValue('/protocols/drafts/p-orphan2.odt')
    mockUpdateProtocolDb.mockRejectedValue(new Error('DB write failed'))
    mockDeleteProtocol.mockResolvedValue(undefined)
    mockDeleteDraftFile.mockResolvedValue(undefined)
    // @ts-expect-error partial mock
    const res = await POST(makeEvent({ body: { committeeId: 'c1', meetingDate: '2026-04-16', title: 'VV' } }))
    expect(res.status).toBe(502)
    expect(mockDeleteProtocol).toHaveBeenCalledWith('p-orphan2')
    // #208: the draft ODT was uploaded before the failed row update — it must be
    // removed too, or it would orphan a file on Nextcloud with no DB row.
    expect(mockDeleteDraftFile).toHaveBeenCalledWith('/protocols/drafts/p-orphan2.odt')
  })

  it('returns 403 if user is not admin', async () => {
    mockHasRole.mockReturnValueOnce(false)
    // @ts-expect-error partial mock
    const res = await POST(makeEvent({ roles: ['member'], body: { committeeId: 'c1', meetingDate: '2026-04-16', title: 'VV' } }))
    expect(res.status).toBe(403)
  })

  // F1: the files module absent (no ProtocolDocumentPort) is no longer a 503; the
  // protocol is created in-app (see protocols-nofiles.test.ts).
})
