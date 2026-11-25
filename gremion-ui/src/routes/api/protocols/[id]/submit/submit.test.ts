import { describe, it, expect, vi, beforeEach } from 'vitest'

// Carve note: submission previously created a Nextcloud Polls approval vote and
// stored its id on the protocol. Nextcloud Polls is a feature module, not part of
// the governance-only kernel, so submit now simply flips the status to
// 'submitted' (approval is gated natively at publish via the INV-5 quorum
// context). The polls-client mock + poll assertions are therefore gone.
const { mockGetProtocol, mockSetProtocolStatus, mockListResolutions } = vi.hoisted(() => ({
  mockGetProtocol: vi.fn(),
  mockSetProtocolStatus: vi.fn(),
  mockListResolutions: vi.fn(),
}))
const { mockHasRole } = vi.hoisted(() => ({ mockHasRole: vi.fn().mockReturnValue(true) }))
// The attendance basis (members present) the submit gate holds the decisions against.
const { mockGetQuorumContext } = vi.hoisted(() => ({ mockGetQuorumContext: vi.fn() }))
const roomy = { eligibleVotingCount: 10, presentVotingCount: 10, quorate: true }
vi.mock('$lib/server/governance/quorum', () => ({ getQuorumContext: mockGetQuorumContext }))

vi.mock('$lib/server/protocols/protocol-db', () => ({
  getProtocol: mockGetProtocol,
  setProtocolStatus: mockSetProtocolStatus,
  listResolutions: mockListResolutions,
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
    mockListResolutions.mockReset()
    mockListResolutions.mockResolvedValue([])
    mockGetQuorumContext.mockReset()
    mockGetQuorumContext.mockResolvedValue(roomy)
  })

  it('flips status to submitted (no poll created — Nextcloud Polls is carved out)', async () => {
    mockGetProtocol.mockResolvedValue(draftProtocol)
    mockSetProtocolStatus.mockResolvedValue({ ...draftProtocol, status: 'submitted' })

    // @ts-expect-error partial mock
    const res = await POST({ locals: { user: { id: 'u1', roles: ['council-admin'] } }, params: { id: '123e4567-e89b-12d3-a456-426614174001' } })
    expect(res.status).toBe(200)
    expect(mockSetProtocolStatus).toHaveBeenCalledWith('p1', 'submitted')
  })

  it('returns 400 if protocol is not in draft status', async () => {
    mockGetProtocol.mockResolvedValue({ ...draftProtocol, status: 'submitted' })
    // @ts-expect-error partial mock
    const res = await POST({ locals: { user: { id: 'u1', roles: ['council-admin'] } }, params: { id: '123e4567-e89b-12d3-a456-426614174001' } })
    expect(res.status).toBe(400)
  })
})

// A counted resolution that nobody voted on yet is stored with the rule engine's
// placeholder "rejected". Submitting freezes the resolutions in the UI, so the
// protocol must not leave draft while such a row exists.
describe('POST /api/protocols/[id]/submit: every counted resolution needs a vote', () => {
  const event = () => ({
    locals: { user: { id: 'u1', roles: ['council-admin'] } },
    params: { id: '123e4567-e89b-12d3-a456-426614174001' },
  }) as unknown as Parameters<typeof POST>[0]
  const resolution = (over: Record<string, unknown> = {}) => ({
    id: 'r1', sequence_nr: 1, text: 'Antrag', adoption_mode: 'tally', required_majority: 'simple',
    votes_yes: 3, votes_no: 1, votes_abstain: 0, result: 'passed', ...over,
  })
  const untallied = (over: Record<string, unknown> = {}) =>
    resolution({ votes_yes: 0, votes_no: 0, votes_abstain: 0, result: 'rejected', ...over })

  beforeEach(() => {
    mockGetProtocol.mockReset()
    mockSetProtocolStatus.mockReset()
    mockListResolutions.mockReset()
    mockGetProtocol.mockResolvedValue(draftProtocol)
    mockSetProtocolStatus.mockResolvedValue({ ...draftProtocol, status: 'submitted' })
    mockGetQuorumContext.mockReset()
    mockGetQuorumContext.mockResolvedValue(roomy)
  })

  it('refuses (422) while a resolution has no vote, names it, and leaves the status alone', async () => {
    mockListResolutions.mockResolvedValue([resolution(), untallied({ id: 'r2', sequence_nr: 2 })])
    const res = await POST(event())
    expect(res.status).toBe(422)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/^Beschluss 2 hat noch keine Abstimmung/)
    expect(mockListResolutions).toHaveBeenCalledWith('p1')
    expect(mockSetProtocolStatus).not.toHaveBeenCalled()
  })

  it('submits once the count is entered', async () => {
    mockListResolutions.mockResolvedValue([resolution(), resolution({ id: 'r2', votes_yes: 0, votes_no: 4, result: 'rejected' })])
    const res = await POST(event())
    expect(res.status).toBe(200)
    expect(mockSetProtocolStatus).toHaveBeenCalledWith('p1', 'submitted')
  })

  it('submits with a withdrawn, a consent and an acclamation resolution that carry no count', async () => {
    mockListResolutions.mockResolvedValue([
      untallied({ id: 'r1', result: 'withdrawn' }),
      untallied({ id: 'r2', required_majority: 'consent', result: 'passed' }),
      untallied({ id: 'r3', adoption_mode: 'acclamation', votes_yes: null, votes_no: null, votes_abstain: null, result: 'passed' }),
    ])
    const res = await POST(event())
    expect(res.status).toBe(200)
    expect(mockSetProtocolStatus).toHaveBeenCalledWith('p1', 'submitted')
  })

  it('submits a protocol without resolutions', async () => {
    mockListResolutions.mockResolvedValue([])
    expect((await POST(event())).status).toBe(200)
  })
})

// Publish holds the stored counts against the attendance again, and once the protocol is
// submitted the attendance is frozen and a counted row cannot be edited, so a misfit that
// slips through submit would be a dead end. The decisions have to fit BEFORE the status
// flips, with the same rule (and wording) the resolution routes use.
describe('POST /api/protocols/[id]/submit: the decisions have to fit the meeting', () => {
  const event = () => ({
    locals: { user: { id: 'u1', roles: ['council-admin'] } },
    params: { id: '123e4567-e89b-12d3-a456-426614174001' },
  }) as unknown as Parameters<typeof POST>[0]
  const resolution = (over: Record<string, unknown> = {}) => ({
    id: 'r1', sequence_nr: 1, text: 'Antrag', adoption_mode: 'tally', required_majority: 'simple',
    votes_yes: 2, votes_no: 0, votes_abstain: 0, result: 'passed', ...over,
  })

  beforeEach(() => {
    mockGetProtocol.mockReset()
    mockSetProtocolStatus.mockReset()
    mockListResolutions.mockReset()
    mockGetQuorumContext.mockReset()
    mockGetProtocol.mockResolvedValue(draftProtocol)
    mockSetProtocolStatus.mockResolvedValue({ ...draftProtocol, status: 'submitted' })
    mockGetQuorumContext.mockResolvedValue({ eligibleVotingCount: 3, presentVotingCount: 2, quorate: true })
  })

  it('refuses (422) a stored count above the members present, names the resolution, keeps the status', async () => {
    mockListResolutions.mockResolvedValue([resolution(), resolution({ id: 'r2', sequence_nr: 2, votes_yes: 999 })])
    const res = await POST(event())
    expect(res.status).toBe(422)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/^Beschluss 2:/)
    expect(body.error).toMatch(/übersteigen/)
    expect(mockGetQuorumContext).toHaveBeenCalledWith('p1')
    expect(mockSetProtocolStatus).not.toHaveBeenCalled()
  })

  it('refuses (422) a decision of a meeting that is not beschlussfähig', async () => {
    mockGetQuorumContext.mockResolvedValue({ eligibleVotingCount: 3, presentVotingCount: 1, quorate: false })
    mockListResolutions.mockResolvedValue([resolution({ votes_yes: 1 })])
    const res = await POST(event())
    expect(res.status).toBe(422)
    expect(((await res.json()) as { error: string }).error).toMatch(/Nicht beschlussfähig/)
    expect(mockSetProtocolStatus).not.toHaveBeenCalled()
  })

  it('submits a decision that fits the attendance', async () => {
    mockListResolutions.mockResolvedValue([resolution({ votes_yes: 2, votes_no: 0, votes_abstain: 0 })])
    expect((await POST(event())).status).toBe(200)
    expect(mockSetProtocolStatus).toHaveBeenCalledWith('p1', 'submitted')
  })

  it('a withdrawn resolution with an implausible stored count does not block, and needs no attendance lookup', async () => {
    mockListResolutions.mockResolvedValue([resolution({ result: 'withdrawn', votes_yes: 999 })])
    expect((await POST(event())).status).toBe(200)
    expect(mockGetQuorumContext).not.toHaveBeenCalled()
  })
})
