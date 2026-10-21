import { describe, it, expect, vi, beforeEach } from 'vitest'

// F1 (Q1): protocol create works with NO files ProtocolDocumentPort; the
// in-app body is editable via PATCH (sanitized) while the protocol is a draft;
// the public PDF route answers a clean 404 when no NC document exists.
const h = vi.hoisted(() => ({
  createProtocol: vi.fn(), updateProtocol: vi.fn(), getProtocol: vi.fn(), pdfPath: vi.fn(),
}))
vi.mock('$lib/server/protocols/protocol-db', () => ({
  createProtocol: h.createProtocol, listProtocols: vi.fn(), deleteProtocol: vi.fn(),
  updateProtocol: h.updateProtocol, getProtocol: h.getProtocol, upsertAttendance: vi.fn(),
  listAttendance: vi.fn(), listResolutions: vi.fn(), listActionItems: vi.fn(),
  getPublishedProtocolPdfPath: h.pdfPath,
}))
vi.mock('$lib/server/governance/org-units-db', () => ({ getOrgUnit: vi.fn(), isMemberOf: vi.fn() }))
vi.mock('$lib/auth', () => ({ hasRole: () => true, Role: { CouncilAdmin: 'council-admin' } }))

import { POST } from './+server'
import { PATCH } from './[id]/+server'
import { GET as PDF } from '../public/protocols/[id]/pdf/+server'
import { _resetRuntimeRegistryForTests } from '$lib/server/modules/runtime-registry'

const user = { id: 'u1', roles: ['council-admin'] }
const ID = '123e4567-e89b-12d3-a456-426614174001'

describe('F1 protocols without the files module', () => {
  beforeEach(() => { _resetRuntimeRegistryForTests(); Object.values(h).forEach((m) => m.mockReset()) })

  it('POST /api/protocols -> 201 with no document port; no draft path written', async () => {
    h.createProtocol.mockResolvedValue({ id: 'p1', status: 'draft', nextcloud_draft_path: null })
    const res = await POST({
      locals: { user },
      request: { json: async () => ({ committeeId: 'c', meetingDate: '2026-01-01', title: 'T' }) },
    } as never)
    expect(res.status).toBe(201)
    expect(h.updateProtocol).not.toHaveBeenCalled()
  })

  it('PATCH bodyHtml stores the sanitized in-app body on a draft', async () => {
    h.getProtocol.mockResolvedValue({ id: ID, status: 'draft' })
    h.updateProtocol.mockResolvedValue({ id: ID })
    const res = await PATCH({
      locals: { user }, params: { id: ID },
      request: { json: async () => ({ bodyHtml: '<p>Hallo</p><script>x()</script>' }) },
    } as never)
    expect(res.status).toBe(200)
    const arg = h.updateProtocol.mock.calls[0][1] as { bodyHtml?: string }
    expect(arg.bodyHtml).toContain('<p>Hallo</p>')
    expect(arg.bodyHtml).not.toContain('<script')
  })

  it('PATCH bodyHtml on a submitted protocol is refused (403): the text is frozen once out for adoption', async () => {
    h.getProtocol.mockResolvedValue({ id: ID, status: 'submitted' })
    await expect(PATCH({
      locals: { user }, params: { id: ID },
      request: { json: async () => ({ bodyHtml: '<p>x</p>' }) },
    } as never)).rejects.toMatchObject({ status: 403 })
    expect(h.updateProtocol).not.toHaveBeenCalled()
  })

  it('public PDF with a stored path but no document port -> clean 404, not 503', async () => {
    h.pdfPath.mockResolvedValue('/published/p1/protocol.pdf')
    await expect(PDF({ params: { id: ID } } as never)).rejects.toMatchObject({ status: 404 })
  })
})
