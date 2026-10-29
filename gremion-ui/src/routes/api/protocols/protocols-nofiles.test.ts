import { describe, it, expect, vi, beforeEach } from 'vitest'

// F1 (Q1): protocol create works with NO files ProtocolDocumentPort; the
// in-app body is editable via PATCH (sanitized) while the protocol is a draft;
// the public PDF route answers a clean 404 when no NC document exists.
const h = vi.hoisted(() => {
  const lists = [vi.fn(), vi.fn(), vi.fn()]
  return {
    createProtocol: vi.fn(), updateProtocol: vi.fn(), getProtocol: vi.fn(), pdfPath: vi.fn(),
    lists,
  }
})
vi.mock('$lib/server/protocols/protocol-db', () => ({
  createProtocol: h.createProtocol, listProtocols: vi.fn(), deleteProtocol: vi.fn(),
  updateProtocol: h.updateProtocol, getProtocol: h.getProtocol, upsertAttendance: vi.fn(),
  listAttendance: (...a: unknown[]) => h.lists[0](...a), listResolutions: (...a: unknown[]) => h.lists[1](...a), listActionItems: (...a: unknown[]) => h.lists[2](...a),
  getPublishedProtocolPdfPath: h.pdfPath,
}))
vi.mock('$lib/server/governance/org-units-db', () => ({ getOrgUnit: vi.fn(), isMemberOf: vi.fn() }))
vi.mock('$lib/auth', () => ({ hasRole: () => true, Role: { CouncilAdmin: 'council-admin' } }))

import { POST } from './+server'
import { PATCH, GET } from './[id]/+server'
import { GET as PDF } from '../public/protocols/[id]/pdf/+server'
import { _resetRuntimeRegistryForTests, registerProtocolDocumentPort } from '$lib/server/modules/runtime-registry'

const user = { id: 'u1', roles: ['council-admin'] }
const ID = '123e4567-e89b-12d3-a456-426614174001'

describe('F1 protocols without the files module', () => {
  beforeEach(() => { _resetRuntimeRegistryForTests(); Object.values(h).flat().forEach((m) => m.mockReset()) })

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

  const XSS = '<p>ok</p><img src="x" onerror="alert(1)"><a href="javascript:alert(2)">l</a><svg onload="alert(3)"></svg><script>x()</script>'
  const HOSTILE = /<script|onerror|onload|javascript:|<svg/i

  it('PATCH bodyHtml strips script, onerror and javascript: URLs before it is stored', async () => {
    h.getProtocol.mockResolvedValue({ id: ID, status: 'draft' })
    h.updateProtocol.mockResolvedValue({ id: ID })
    await PATCH({ locals: { user }, params: { id: ID }, request: { json: async () => ({ bodyHtml: XSS }) } } as never)
    const stored = (h.updateProtocol.mock.calls[0][1] as { bodyHtml: string }).bodyHtml
    expect(stored).toContain('<p>ok</p>')
    expect(stored).not.toMatch(HOSTILE)
  })

  it('GET returns a sanitized body_html even when a legacy row stored hostile markup', async () => {
    h.getProtocol.mockResolvedValue({ id: ID, status: 'draft', committee_id: 'c', body_html: XSS, nextcloud_draft_path: null })
    h.lists.forEach((m) => m.mockResolvedValue([]))
    const res = await GET({ locals: { user: { id: 'u1', roles: ['council-admin'] } }, params: { id: ID } } as never)
    const served = (await res.json()).protocol.body_html
    expect(served).toContain('<p>ok</p>')
    expect(served).not.toMatch(HOSTILE)
  })

  it('GET hasDraftDocument: true only with draft path AND files port', async () => {
    h.lists.forEach((m) => m.mockResolvedValue([]))
    const get = async (path: string | null) => {
      h.getProtocol.mockResolvedValue({ id: ID, status: 'draft', committee_id: 'c', body_html: null, nextcloud_draft_path: path })
      const res = await GET({ locals: { user: { id: 'u1', roles: ['council-admin'] } }, params: { id: ID } } as never)
      return (await res.json()).protocol
    }
    expect((await get('/d/p1.odt')).hasDraftDocument).toBe(false) // path but no port
    registerProtocolDocumentPort({} as never)
    const withOdt = await get('/d/p1.odt')
    expect(withOdt.hasDraftDocument).toBe(true)
    expect(withOdt.nextcloud_draft_path).toBeUndefined()
    expect((await get(null)).hasDraftDocument).toBe(false)
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
