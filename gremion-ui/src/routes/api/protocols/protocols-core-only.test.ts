import { describe, it, expect, vi, beforeEach } from 'vitest'

// A core-only customer (SECONDARY_TENANT_HOSTS): its tenant config pins the files module off
// (pinned_off_modules). The protocol routes are governance, so they are always on, and the document port
// the files module registers is process-wide, so a registered port alone must never put such a
// customer's minutes into the shared Nextcloud or mint a shared Collabora editor URL for it. Each route
// reads the CURRENT tenant's files switch; the protocol then lives in-app (body_html) only.
const h = vi.hoisted(() => ({
  config: { modules: { files: false } } as { modules: Record<string, boolean> },
  createProtocol: vi.fn(), updateProtocol: vi.fn(), deleteProtocol: vi.fn(), getProtocol: vi.fn(),
  setStatus: vi.fn(), listResolutions: vi.fn(), assignGlobalNrs: vi.fn(), recordAdoptions: vi.fn(),
  pdfPath: vi.fn(), quorum: vi.fn(), convert: vi.fn(), convertPdf: vi.fn(),
  lists: [vi.fn(), vi.fn(), vi.fn()],
  port: {
    createDraftFile: vi.fn(), deleteDraftFile: vi.fn(), getDraftWopiToken: vi.fn(), downloadDraft: vi.fn(),
    publishFile: vi.fn(), uploadPublishedPdf: vi.fn(), downloadPublishedPdf: vi.fn(), restoreDraftFile: vi.fn(),
  },
}))
vi.mock('$lib/server/config', async (orig) => ({
  ...(await orig<typeof import('$lib/server/config')>()),
  readConfig: () => h.config,
}))
vi.mock('$lib/server/protocols/protocol-db', () => ({
  createProtocol: h.createProtocol, listProtocols: vi.fn(), deleteProtocol: h.deleteProtocol,
  updateProtocol: h.updateProtocol, getProtocol: h.getProtocol, upsertAttendance: vi.fn(),
  setProtocolStatus: h.setStatus, listResolutions: (...a: unknown[]) => h.listResolutions(...a),
  assignGlobalNrs: h.assignGlobalNrs, recordResolutionAdoptions: h.recordAdoptions,
  listAttendance: (...a: unknown[]) => h.lists[0](...a), listActionItems: (...a: unknown[]) => h.lists[2](...a),
  getPublishedProtocolPdfPath: h.pdfPath,
}))
vi.mock('$lib/server/governance/org-units-db', () => ({
  getOrgUnit: vi.fn(async () => ({ id: 'c1', visibility: 'all_members' })), isMemberOf: vi.fn(async () => true),
}))
vi.mock('$lib/server/documents/collabora-convert', () => ({ convertOdtToHtml: h.convert, convertOdtToPdf: h.convertPdf }))
vi.mock('$lib/server/db', () => ({
  getDb: () => ({ begin: async (cb: (tx: unknown) => unknown) => cb({ __tx: true }) }),
}))
vi.mock('$lib/server/governance/quorum', () => ({ getQuorumContext: h.quorum }))
vi.mock('$lib/auth', () => ({
  hasRole: () => true,
  Role: { Guest: 'guest', Member: 'member', CouncilAdmin: 'council-admin' },
}))

import { parseConfig } from '$lib/server/config'
import { POST as CREATE } from './+server'
import { GET as DETAIL } from './[id]/+server'
import { POST as PUBLISH } from './[id]/publish/+server'
import { GET as WOPI } from './[id]/wopi-token/+server'
import { GET as PDF } from '../public/protocols/[id]/pdf/+server'
import { _resetRuntimeRegistryForTests, registerProtocolDocumentPort } from '$lib/server/modules/runtime-registry'
import type { ProtocolDocumentPort } from '$lib/server/modules/runtime-registry'

const ID = '123e4567-e89b-12d3-a456-426614174001'
const user = { id: 'u1', roles: ['council-admin'] }
const withDraft = {
  id: ID, committee_id: 'c1', title: 'VV', meeting_date: '2026-04-16', status: 'draft', guest_edit_enabled: false,
  nextcloud_draft_path: '/protocols/drafts/p1.odt', body_html: '<p>In-App</p>', approval_poll_id: null,
}

// The config of a core-only customer exactly as the host's create handler writes it and the app reads it:
// the stored file says files is on, the pin says it is not.
const pinnedConfig = () =>
  parseConfig({ modules: { files: true }, pinned_off_modules: ['files'] }) as unknown as { modules: Record<string, boolean> }

const create = () => CREATE({
  locals: { user },
  request: { json: async () => ({ committeeId: 'c1', meetingDate: '2026-01-01', title: 'T' }) },
} as never)

describe('protocol routes for a customer whose files module is pinned off', () => {
  beforeEach(() => {
    _resetRuntimeRegistryForTests()
    for (const v of Object.values(h)) {
      if (typeof v === 'function' && 'mockReset' in v) (v as ReturnType<typeof vi.fn>).mockReset()
    }
    h.lists.forEach((m) => { m.mockReset(); m.mockResolvedValue([]) })
    Object.values(h.port).forEach((m) => m.mockReset())
    h.config = pinnedConfig()
    registerProtocolDocumentPort(h.port as unknown as ProtocolDocumentPort)
    h.createProtocol.mockResolvedValue({ id: ID, status: 'draft', nextcloud_draft_path: null })
    h.getProtocol.mockResolvedValue(withDraft)
    h.listResolutions.mockResolvedValue([])
    h.assignGlobalNrs.mockResolvedValue([])
    h.recordAdoptions.mockResolvedValue(0)
    h.quorum.mockResolvedValue({ eligibleVotingCount: 3, presentVotingCount: 2, quorate: true })
    h.updateProtocol.mockResolvedValue({ ...withDraft, status: 'published' })
    h.setStatus.mockResolvedValue({ ...withDraft, status: 'published' })
    h.pdfPath.mockResolvedValue('/protocols/published/p1/protocol.pdf')
  })

  it('the pin really reads files as off although the stored file says on', () => {
    expect(h.config.modules.files).toBe(false)
  })

  it('create: the registered port is never asked for a draft; the protocol is created in-app only', async () => {
    const res = await create()
    expect(res.status).toBe(201)
    expect(h.port.createDraftFile).not.toHaveBeenCalled()
    expect(h.updateProtocol).not.toHaveBeenCalled()
  })

  it('wopi-token: no shared editor URL is minted, 503', async () => {
    const ev = {
      locals: { user }, params: { id: ID }, url: new URL(`https://kunde.example/api/protocols/${ID}/wopi-token`),
    } as never
    await expect(WOPI(ev)).rejects.toMatchObject({ status: 503 })
    expect(h.port.getDraftWopiToken).not.toHaveBeenCalled()
  })

  it('publish: nothing is read from, moved in or uploaded to the shared Nextcloud; the in-app body is published', async () => {
    h.getProtocol.mockResolvedValue({ ...withDraft, status: 'submitted' })
    const res = await PUBLISH({ locals: { user }, params: { id: ID } } as never)
    expect(res.status).toBe(200)
    for (const op of ['downloadDraft', 'publishFile', 'uploadPublishedPdf', 'restoreDraftFile'] as const) {
      expect(h.port[op]).not.toHaveBeenCalled()
    }
    expect(h.convert).not.toHaveBeenCalled()
    expect(h.convertPdf).not.toHaveBeenCalled()
    expect((h.updateProtocol.mock.calls[0][1] as { bodyHtml?: string }).bodyHtml).toContain('In-App')
  })

  it('public pdf: a clean 404, the shared Nextcloud is not asked for a file', async () => {
    await expect(PDF({ params: { id: ID } } as never)).rejects.toMatchObject({ status: 404 })
    expect(h.port.downloadPublishedPdf).not.toHaveBeenCalled()
  })

  it('detail: a stale draft path does not claim a draft document (the page offers the in-app editor)', async () => {
    const res = await DETAIL({ locals: { user }, params: { id: ID } } as never)
    expect((await res.json()).protocol.hasDraftDocument).toBe(false)
  })

  it('control: with the files module on, the same create DOES ask the port (the guard is not vacuous)', async () => {
    h.config = { modules: { files: true } }
    h.port.createDraftFile.mockResolvedValue('/protocols/drafts/p1.odt')
    h.updateProtocol.mockResolvedValue({ id: ID })
    expect((await create()).status).toBe(201)
    expect(h.port.createDraftFile).toHaveBeenCalledTimes(1)
  })

  // The page tells the admin when a customer that uses the shared Nextcloud got a minutes record without its draft
  // document, instead of silently showing the in-app editor.
  describe('detail: draftDocumentMissing', () => {
    const detail = async () => (await (await DETAIL({ locals: { user }, params: { id: ID } } as never)).json()).protocol

    it('is true when the files module is on and the draft was never created', async () => {
      h.config = { modules: { files: true } }
      h.getProtocol.mockResolvedValue({ ...withDraft, nextcloud_draft_path: null })
      expect((await detail()).draftDocumentMissing).toBe(true)
    })

    it('is false when the draft document exists', async () => {
      h.config = { modules: { files: true } }
      expect((await detail()).draftDocumentMissing).toBe(false)
    })

    it('is false for a customer without the files module (the in-app body is the design there)', async () => {
      h.getProtocol.mockResolvedValue({ ...withDraft, nextcloud_draft_path: null })
      expect((await detail()).draftDocumentMissing).toBe(false)
    })

    it('is false once the minutes are no longer a draft', async () => {
      h.config = { modules: { files: true } }
      h.getProtocol.mockResolvedValue({ ...withDraft, status: 'submitted', nextcloud_draft_path: null })
      expect((await detail()).draftDocumentMissing).toBe(false)
    })
  })
})
