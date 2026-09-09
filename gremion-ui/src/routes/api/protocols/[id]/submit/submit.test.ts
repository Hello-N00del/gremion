import { describe, it, expect, vi, beforeEach } from 'vitest'

// Carve note: submission previously created a Nextcloud Polls approval vote and
// stored its id on the protocol. Nextcloud Polls is a feature module, not part of
// the governance-only kernel, so submit now simply flips the status to
// 'submitted' (approval is gated natively at publish via the INV-5 quorum
// context). The polls-client mock + poll assertions are therefore gone.
const { mockGetProtocol, mockSetProtocolStatus } = vi.hoisted(() => ({
  mockGetProtocol: vi.fn(),
  mockSetProtocolStatus: vi.fn(),
}))
const { mockHasRole } = vi.hoisted(() => ({ mockHasRole: vi.fn().mockReturnValue(true) }))

vi.mock('$lib/server/protocols/protocol-db', () => ({
  getProtocol: mockGetProtocol,
  setProtocolStatus: mockSetProtocolStatus,
}))
vi.mock('$lib/auth', () => ({
  hasRole: mockHasRole,
  Role: { CouncilAdmin: 'council-admin' },
}))

import { POST } from './+server'

const draftProtocol = {
  id: 'p1', committee_id: 'c1', title: 'VV April', meeting_date: '2026-04-16',
  status: 'draft', nextcloud_draft_path: '/protocols/drafts/p1.odt',
  approval_poll_id: null,
}

describe('POST /api/protocols/[id]/submit', () => {
  beforeEach(() => {
    mockGetProtocol.mockReset()
    mockSetProtocolStatus.mockReset()
  })

  it('flips status to submitted (no poll created — Nextcloud Polls is carved out)', async () => {
    mockGetProtocol.mockResolvedValue(draftProtocol)
    mockSetProtocolStatus.mockResolvedValue({ ...draftProtocol, status: 'submitted' })

    // @ts-expect-error partial mock
    const res = await POST({ locals: { user: { id: 'u1', roles: ['council-admin'] } }, params: { id: 'p1' } })
    expect(res.status).toBe(200)
    expect(mockSetProtocolStatus).toHaveBeenCalledWith('p1', 'submitted')
  })

  it('returns 400 if protocol is not in draft status', async () => {
    mockGetProtocol.mockResolvedValue({ ...draftProtocol, status: 'submitted' })
    // @ts-expect-error partial mock
    const res = await POST({ locals: { user: { id: 'u1', roles: ['council-admin'] } }, params: { id: 'p1' } })
    expect(res.status).toBe(400)
  })
})
