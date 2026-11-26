import { describe, it, expect, vi, beforeEach } from 'vitest'

// Publishing minutes needs a second person. The rule is enforced by the route
// (a direct POST gets the same answer as the page's button), so these tests call
// the handler with the identities a request carries and look at what was refused
// or written.
//   - the person who submitted the protocol cannot publish it
//   - the person who created it cannot publish it
//   - the person who publishes must be a customer admin or a voting member of the body
//   - a publish records who approved

const h = vi.hoisted(() => ({
  getProtocol: vi.fn(), setStatus: vi.fn(), updateProtocol: vi.fn(),
  listResolutions: vi.fn(), assignGlobalNrs: vi.fn(), recordAdoptions: vi.fn(),
  isVotingMember: vi.fn(), quorum: vi.fn(), isAdmin: vi.fn(),
}))
vi.mock('$lib/server/protocols/protocol-db', () => ({
  getProtocol: h.getProtocol, setProtocolStatus: h.setStatus, updateProtocol: h.updateProtocol,
  listResolutions: h.listResolutions, assignGlobalNrs: h.assignGlobalNrs,
  recordResolutionAdoptions: h.recordAdoptions, isVotingMemberOfBody: h.isVotingMember,
}))
vi.mock('$lib/server/documents/collabora-convert', () => ({
  convertOdtToHtml: vi.fn(), convertOdtToPdf: vi.fn(),
}))
vi.mock('$lib/server/db', () => ({
  getDb: () => ({ begin: async (cb: (tx: unknown) => unknown) => cb({ __tx: true }) }),
}))
vi.mock('$lib/server/governance/quorum', () => ({ getQuorumContext: h.quorum }))
vi.mock('$lib/auth', () => ({ hasRole: h.isAdmin, Role: { CouncilAdmin: 'council-admin' } }))

import { POST } from './+server'
import { _resetRuntimeRegistryForTests } from '$lib/server/modules/runtime-registry'

const protocol = {
  id: 'p1', committee_id: 'c1', title: 'VV', meeting_date: '2026-04-16', status: 'submitted',
  nextcloud_draft_path: null, body_html: '<p>Beschluss</p>',
  created_by: 'author', submitted_by: 'submitter',
}
const ev = (userId: string) => ({
  locals: { user: { id: userId, roles: [] } },
  params: { id: '123e4567-e89b-12d3-a456-426614174001' },
}) as unknown as Parameters<typeof POST>[0]

async function statusOf(userId: string): Promise<number> {
  try {
    return (await POST(ev(userId))).status
  } catch (e) {
    return (e as { status?: number }).status ?? 500
  }
}

describe('POST /api/protocols/[id]/publish - second person', () => {
  beforeEach(() => {
    _resetRuntimeRegistryForTests()
    Object.values(h).forEach((m) => m.mockReset())
    h.isAdmin.mockReturnValue(true)
    h.isVotingMember.mockResolvedValue(false)
    h.getProtocol.mockResolvedValue(protocol)
    h.listResolutions.mockResolvedValue([])
    h.assignGlobalNrs.mockResolvedValue([])
    h.recordAdoptions.mockResolvedValue(0)
    h.quorum.mockResolvedValue({ eligibleVotingCount: 3, presentVotingCount: 2, quorate: true })
    h.updateProtocol.mockResolvedValue({ ...protocol, status: 'published' })
    h.setStatus.mockResolvedValue({ ...protocol, status: 'published' })
  })

  it('refuses the person who submitted the protocol, even by a direct POST', async () => {
    expect(await statusOf('submitter')).toBe(403)
    expect(h.updateProtocol).not.toHaveBeenCalled()
    expect(h.setStatus).not.toHaveBeenCalled()
  })

  it('refuses the person who created the protocol', async () => {
    expect(await statusOf('author')).toBe(403)
    expect(h.setStatus).not.toHaveBeenCalled()
  })

  it('refuses before any file or database write', async () => {
    h.getProtocol.mockResolvedValue({ ...protocol, created_by: 'someone', submitted_by: 'u9' })
    expect(await statusOf('u9')).toBe(403)
    expect(h.listResolutions).not.toHaveBeenCalled()
    expect(h.updateProtocol).not.toHaveBeenCalled()
  })

  it('publishes for a second admin and records who approved', async () => {
    expect(await statusOf('second')).toBe(200)
    expect(h.setStatus).toHaveBeenCalledWith('p1', 'published', expect.objectContaining({ actorId: 'second' }))
  })

  it('publishes for a second person who is only a voting member of the body', async () => {
    h.isAdmin.mockReturnValue(false)
    h.isVotingMember.mockResolvedValue(true)
    expect(await statusOf('member')).toBe(200)
    expect(h.isVotingMember).toHaveBeenCalledWith('c1', 'member')
    expect(h.setStatus).toHaveBeenCalledWith('p1', 'published', expect.objectContaining({ actorId: 'member' }))
  })

  it('refuses a second person who is neither admin nor voting member of the body', async () => {
    h.isAdmin.mockReturnValue(false)
    h.isVotingMember.mockResolvedValue(false)
    expect(await statusOf('outsider')).toBe(403)
    expect(h.updateProtocol).not.toHaveBeenCalled()
    expect(h.setStatus).not.toHaveBeenCalled()
  })

  it('answers the same 403 for a non-eligible person whether or not the protocol exists', async () => {
    h.isAdmin.mockReturnValue(false)
    h.getProtocol.mockResolvedValue(null)
    expect(await statusOf('outsider')).toBe(403)
  })

  it('still publishes a protocol that was submitted before the submitter was recorded, for anyone but its creator', async () => {
    h.getProtocol.mockResolvedValue({ ...protocol, submitted_by: null })
    expect(await statusOf('second')).toBe(200)
    expect(await statusOf('author')).toBe(403)
  })
})
