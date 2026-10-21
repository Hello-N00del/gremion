import { describe, it, expect, vi, beforeEach } from 'vitest'

// F1 (operator ruling Q1, 2026-10-21): publish (= adoption) must work with NO
// files ProtocolDocumentPort and with Nextcloud down. The protocol body lives
// in-app (protocols.body_html). INV-5 quorum + the audit_log adoption record
// are unchanged.
const h = vi.hoisted(() => ({
  getProtocol: vi.fn(), setStatus: vi.fn(), updateProtocol: vi.fn(),
  listResolutions: vi.fn(), assignGlobalNrs: vi.fn(), recordAdoptions: vi.fn(),
  quorum: vi.fn(), downloadDraft: vi.fn(),
}))
vi.mock('$lib/server/protocols/protocol-db', () => ({
  getProtocol: h.getProtocol, setProtocolStatus: h.setStatus, updateProtocol: h.updateProtocol,
  listResolutions: h.listResolutions, assignGlobalNrs: h.assignGlobalNrs,
  recordResolutionAdoptions: h.recordAdoptions,
}))
vi.mock('$lib/server/documents/collabora-convert', () => ({
  convertOdtToHtml: vi.fn(), convertOdtToPdf: vi.fn(),
}))
vi.mock('$lib/server/db', () => ({
  getDb: () => ({ begin: async (cb: (tx: unknown) => unknown) => cb({ __tx: true }) }),
}))
vi.mock('$lib/server/governance/quorum', () => ({ getQuorumContext: h.quorum }))
vi.mock('$lib/auth', () => ({ hasRole: () => true, Role: { CouncilAdmin: 'council-admin' } }))

import { POST } from './+server'
import { registerProtocolDocumentPort, _resetRuntimeRegistryForTests } from '$lib/server/modules/runtime-registry'
import type { ProtocolDocumentPort } from '$lib/server/modules/runtime-registry'

const base = {
  id: 'p1', committee_id: 'c1', title: 'VV', meeting_date: '2026-04-16', status: 'submitted',
  nextcloud_draft_path: null, body_html: '<p>Beschluss</p><script>x()</script>', approval_poll_id: null,
}
const ev = () => ({
  locals: { user: { id: 'u1', roles: ['council-admin'] } },
  params: { id: '123e4567-e89b-12d3-a456-426614174001' },
}) as unknown as Parameters<typeof POST>[0]

describe('POST /api/protocols/[id]/publish - files off (F1)', () => {
  beforeEach(() => {
    _resetRuntimeRegistryForTests()
    Object.values(h).forEach((m) => m.mockReset())
    h.getProtocol.mockResolvedValue(base)
    h.listResolutions.mockResolvedValue([])
    h.assignGlobalNrs.mockResolvedValue([])
    h.recordAdoptions.mockResolvedValue(0)
    h.quorum.mockResolvedValue({ eligibleVotingCount: 3, presentVotingCount: 2, quorate: true })
    h.updateProtocol.mockResolvedValue({ ...base, status: 'published' })
    h.setStatus.mockResolvedValue({ ...base, status: 'published' })
  })

  it('publishes (200) with no document port and no draft path; stores the sanitized in-app body; flips status', async () => {
    const res = await POST(ev())
    expect(res.status).toBe(200)
    const arg = h.updateProtocol.mock.calls[0][1] as { bodyHtml?: string; pdfNextcloudPath?: string }
    expect(arg.bodyHtml).toContain('<p>Beschluss</p>')
    expect(arg.bodyHtml).not.toContain('<script')
    expect(arg.pdfNextcloudPath).toBeUndefined()
    expect(h.setStatus).toHaveBeenCalledWith('p1', 'published', expect.anything())
  })

  it('still writes the audit adoption record on the publish tx', async () => {
    const r = [{ id: 'r1', result: 'accepted' }]
    h.listResolutions.mockResolvedValue(r)
    await POST(ev())
    expect(h.recordAdoptions).toHaveBeenCalledWith('u1', r, { __tx: true })
  })

  it('still refuses (422) a non-quorate protocol with binding resolutions and writes nothing', async () => {
    h.listResolutions.mockResolvedValue([{ id: 'r1', result: 'accepted' }])
    h.quorum.mockResolvedValue({ eligibleVotingCount: 5, presentVotingCount: 1, quorate: false })
    await expect(POST(ev())).rejects.toMatchObject({ status: 422 })
    expect(h.setStatus).not.toHaveBeenCalled()
    expect(h.recordAdoptions).not.toHaveBeenCalled()
  })

  it('publishes without any approval_poll_id', async () => {
    h.getProtocol.mockResolvedValue({ ...base, approval_poll_id: null })
    expect((await POST(ev())).status).toBe(200)
  })

  it('files on but Nextcloud down: falls back to the in-app body instead of failing', async () => {
    h.downloadDraft.mockRejectedValue(new Error('nc down'))
    registerProtocolDocumentPort({ downloadDraft: h.downloadDraft } as unknown as ProtocolDocumentPort)
    h.getProtocol.mockResolvedValue({ ...base, nextcloud_draft_path: '/d/p1.odt' })
    expect((await POST(ev())).status).toBe(200)
    expect(h.downloadDraft).toHaveBeenCalled()
  })

  it('files on, Nextcloud down and NO in-app body: still fails (nothing to publish)', async () => {
    h.downloadDraft.mockRejectedValue(new Error('nc down'))
    registerProtocolDocumentPort({ downloadDraft: h.downloadDraft } as unknown as ProtocolDocumentPort)
    h.getProtocol.mockResolvedValue({ ...base, body_html: null, nextcloud_draft_path: '/d/p1.odt' })
    await expect(POST(ev())).rejects.toBeTruthy()
    expect(h.setStatus).not.toHaveBeenCalled()
  })
})
