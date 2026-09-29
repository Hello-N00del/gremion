// T4 (#320 Phase 2 — adoption modes): route-level gating for
// POST /api/protocols/[id]/resolutions and PATCH .../resolutions/[resId].
//
// Mock pattern per the sibling publish/publish.test.ts: protocol-db, db, auth
// and the quorum context are mocked; decideResolution + evaluateMajority run
// REAL (pure, given the mocked quorum) so computed-result assertions pin
// genuine rule evaluation instead of a mock echo.
//
// Pinned contract:
//   (a) POST without adoption_mode defaults to 'tally' and behaves exactly as
//       before: the server computes `result` from rule + tallies; the client
//       `result` field is consulted ONLY for 'withdrawn' (+server.ts).
//   (b) POST tally with free-hand result 'passed'/'rejected' → 400 — INV-5:
//       the binding result is never accepted from the client.
//   (c) POST acclamation + declared_result:'passed' → 201 with NULL stored
//       tallies and result 'passed'.
//   (d) POST acclamation without declared_result → 400.
//   (e) POST acclamation informational tally: partial → 400, full → stored.
//   (f) requiredMajority 'support_threshold' without
//       decision_rule_params.fraction → 400; with fraction the params are
//       persisted through addResolution.
//   (g) PATCH mirrors the same gating and still pins required_majority (and
//       the adoption procedure) to the STORED row ([resId]/+server.ts:38
//       precedent) — an edit can never retroactively switch rule or mode.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const {
  mockGetProtocol, mockAddResolution, mockUpdateResolution, mockDeleteResolution,
} = vi.hoisted(() => ({
  mockGetProtocol: vi.fn(),
  mockAddResolution: vi.fn(),
  mockUpdateResolution: vi.fn(),
  mockDeleteResolution: vi.fn(),
}))
vi.mock('$lib/server/protocols/protocol-db', () => ({
  getProtocol: mockGetProtocol,
  addResolution: mockAddResolution,
  updateResolution: mockUpdateResolution,
  deleteResolution: mockDeleteResolution,
}))

// decideResolution runs REAL; only its quorum lookup is stubbed (quorate by
// default, so 'simple'/'two_thirds' evaluation is pure arithmetic).
const { mockGetQuorumContext } = vi.hoisted(() => ({ mockGetQuorumContext: vi.fn() }))
vi.mock('$lib/server/governance/quorum', () => ({ getQuorumContext: mockGetQuorumContext }))

const { mockHasRole } = vi.hoisted(() => ({ mockHasRole: vi.fn().mockReturnValue(true) }))
vi.mock('$lib/auth', () => ({ hasRole: mockHasRole, Role: { CouncilAdmin: 'council-admin' } }))

// PATCH reads the stored row via a raw getDb() tagged-template SELECT — the
// mock sql function resolves with whatever row a test arranges.
const { mockSql, mockGetDb } = vi.hoisted(() => {
  const sqlFn = vi.fn()
  return { mockSql: sqlFn, mockGetDb: vi.fn(() => sqlFn) }
})
vi.mock('$lib/server/db', () => ({ getDb: mockGetDb }))

import { POST } from './+server'
import { PATCH } from './[resId]/+server'

const draftProtocol = { id: 'p1', committee_id: 'c1', status: 'draft' }

const storedTallyRow = {
  protocol_id: 'p1',
  votes_yes: 2, votes_no: 1, votes_abstain: 0,
  required_majority: 'simple', adoption_mode: 'tally',
}
const storedAcclamationRow = {
  protocol_id: 'p1',
  votes_yes: null, votes_no: null, votes_abstain: null,
  required_majority: 'simple', adoption_mode: 'acclamation',
}

function makePostEvent(body: unknown) {
  return {
    locals: { user: { id: 'u1', roles: ['council-admin'] } },
    params: { id: 'p1' },
    request: { json: async () => body },
  } as unknown as Parameters<typeof POST>[0]
}

function makePatchEvent(body: unknown) {
  return {
    locals: { user: { id: 'u1', roles: ['council-admin'] } },
    params: { id: 'p1', resId: 'r1' },
    request: { json: async () => body },
  } as unknown as Parameters<typeof PATCH>[0]
}

type ResolutionInput = Record<string, unknown>

beforeEach(() => {
  mockGetProtocol.mockReset().mockResolvedValue(draftProtocol)
  mockAddResolution.mockReset().mockImplementation(
    async (_protocolId: string, input: ResolutionInput) => ({ id: 'r-new', protocol_id: 'p1', ...input }),
  )
  mockUpdateResolution.mockReset().mockImplementation(
    async (id: string, input: ResolutionInput) => ({ id, protocol_id: 'p1', ...input }),
  )
  mockDeleteResolution.mockReset()
  mockGetQuorumContext.mockReset().mockResolvedValue({
    eligibleVotingCount: 5, presentVotingCount: 4, quorate: true,
  })
  mockSql.mockReset().mockResolvedValue([storedTallyRow])
  mockHasRole.mockReturnValue(true)
})

// ─────────────────────────────────────────────────────────────────────────────
// POST — tally (default) mode
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/protocols/[id]/resolutions — tally (default)', () => {
  it('(a) without adoption_mode defaults to tally: server computes the result from rule + tallies', async () => {
    const res = await POST(makePostEvent({ text: 'Antrag A', votesYes: 3, votesNo: 1, votesAbstain: 0 }))
    expect(res.status).toBe(201)

    expect(mockAddResolution).toHaveBeenCalledOnce()
    const input = mockAddResolution.mock.calls[0][1] as ResolutionInput
    expect(input.adoptionMode).toBe('tally')
    expect(input.requiredMajority).toBe('simple')
    expect(input.result).toBe('passed') // computed: 3 > 1 under 'simple' — not client-supplied
    expect(input.votesYes).toBe(3)
    expect(input.votesNo).toBe(1)
    expect(input.votesAbstain).toBe(0)
  })

  it("(a) client result is consulted ONLY for 'withdrawn'", async () => {
    const res = await POST(makePostEvent({ text: 'Zurückgezogen', votesYes: 0, votesNo: 0, votesAbstain: 0, result: 'withdrawn' }))
    expect(res.status).toBe(201)
    const input = mockAddResolution.mock.calls[0][1] as ResolutionInput
    expect(input.result).toBe('withdrawn')
  })

  it.each(['passed', 'rejected'] as const)(
    "(b) free-hand result '%s' in tally mode → 400, nothing persisted",
    async (freehand) => {
      await expect(
        POST(makePostEvent({ text: 'X', votesYes: 0, votesNo: 5, votesAbstain: 0, result: freehand })),
      ).rejects.toMatchObject({ status: 400 })
      expect(mockAddResolution).not.toHaveBeenCalled()
    },
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// POST — acclamation mode
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/protocols/[id]/resolutions — acclamation', () => {
  it("(c) declared_result 'passed' → 201 with NULL stored tallies and result 'passed'", async () => {
    const res = await POST(makePostEvent({ text: 'Per Akklamation', adoption_mode: 'acclamation', declared_result: 'passed' }))
    expect(res.status).toBe(201)

    expect(mockAddResolution).toHaveBeenCalledOnce()
    const input = mockAddResolution.mock.calls[0][1] as ResolutionInput
    expect(input.adoptionMode).toBe('acclamation')
    expect(input.result).toBe('passed')
    expect(input.votesYes).toBeNull()
    expect(input.votesNo).toBeNull()
    expect(input.votesAbstain).toBeNull()
    // Acclamation is a declaration, not a computation — no quorum lookup.
    expect(mockGetQuorumContext).not.toHaveBeenCalled()
  })

  it('(d) without declared_result → 400, nothing persisted', async () => {
    await expect(
      POST(makePostEvent({ text: 'Per Akklamation', adoption_mode: 'acclamation' })),
    ).rejects.toMatchObject({ status: 400 })
    expect(mockAddResolution).not.toHaveBeenCalled()
  })

  it('(e) partial informational tally → 400', async () => {
    await expect(
      POST(makePostEvent({ text: 'X', adoption_mode: 'acclamation', declared_result: 'passed', votesYes: 10 })),
    ).rejects.toMatchObject({ status: 400 })
    expect(mockAddResolution).not.toHaveBeenCalled()
  })

  it('(e) full informational tally → stored alongside the declared result', async () => {
    const res = await POST(makePostEvent({
      text: 'X', adoption_mode: 'acclamation', declared_result: 'passed',
      votesYes: 10, votesNo: 1, votesAbstain: 2,
    }))
    expect(res.status).toBe(201)
    const input = mockAddResolution.mock.calls[0][1] as ResolutionInput
    expect(input.votesYes).toBe(10)
    expect(input.votesNo).toBe(1)
    expect(input.votesAbstain).toBe(2)
    expect(input.result).toBe('passed')
    expect(input.adoptionMode).toBe('acclamation')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// POST — support_threshold rule params
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/protocols/[id]/resolutions — support_threshold params', () => {
  it('(f) support_threshold without decision_rule_params.fraction → 400', async () => {
    await expect(
      POST(makePostEvent({ text: 'X', requiredMajority: 'support_threshold', votesYes: 3, votesNo: 0, votesAbstain: 0 })),
    ).rejects.toMatchObject({ status: 400 })
    expect(mockAddResolution).not.toHaveBeenCalled()
  })

  it('(f) support_threshold WITH fraction persists decision_rule_params through addResolution', async () => {
    const res = await POST(makePostEvent({
      text: 'X', requiredMajority: 'support_threshold',
      decision_rule_params: { fraction: 0.5 },
      votesYes: 3, votesNo: 0, votesAbstain: 0,
    }))
    expect(res.status).toBe(201)
    const input = mockAddResolution.mock.calls[0][1] as ResolutionInput
    expect(input.requiredMajority).toBe('support_threshold')
    expect(input.decisionRuleParams).toEqual({ fraction: 0.5 })
  })

  it.each([0, -0.25, 1.5] as const)(
    '(4) tally support_threshold with out-of-(0,1] fraction %s → clean 400, nothing persisted',
    async (fraction) => {
      await expect(
        POST(makePostEvent({
          text: 'X', requiredMajority: 'support_threshold',
          decision_rule_params: { fraction },
          votesYes: 3, votesNo: 0, votesAbstain: 0,
        })),
      ).rejects.toMatchObject({ status: 400 })
      expect(mockAddResolution).not.toHaveBeenCalled()
    },
  )

  it('(4) acclamation support_threshold with NO fraction → 201 (rule inert, fraction guard skipped)', async () => {
    const res = await POST(makePostEvent({
      text: 'Per Akklamation', adoption_mode: 'acclamation',
      requiredMajority: 'support_threshold', declared_result: 'passed',
    }))
    expect(res.status).toBe(201)
    const input = mockAddResolution.mock.calls[0][1] as ResolutionInput
    expect(input.requiredMajority).toBe('support_threshold')
    expect(input.decisionRuleParams).toBeNull()
    expect(input.result).toBe('passed')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// PATCH — mirrors the gating, pins rule + mode to the stored row
// ─────────────────────────────────────────────────────────────────────────────

describe('PATCH /api/protocols/[id]/resolutions/[resId]', () => {
  it.each(['passed', 'rejected'] as const)(
    "(g/b) free-hand result '%s' on a tally row → 400, nothing persisted",
    async (freehand) => {
      mockSql.mockResolvedValue([storedTallyRow])
      await expect(PATCH(makePatchEvent({ result: freehand }))).rejects.toMatchObject({ status: 400 })
      expect(mockUpdateResolution).not.toHaveBeenCalled()
    },
  )

  it('(g) pins required_majority to the STORED row: a client-sent rule cannot flip the outcome', async () => {
    mockSql.mockResolvedValue([{ ...storedTallyRow, required_majority: 'two_thirds' }])
    const res = await PATCH(makePatchEvent({ votesYes: 4, votesNo: 3, votesAbstain: 0, requiredMajority: 'simple' }))
    expect(res.status).toBe(200)

    const input = mockUpdateResolution.mock.calls[0][1] as ResolutionInput
    expect(input.requiredMajority).toBe('two_thirds') // stored rule, not the client's 'simple'
    // 4 vs 3 passes 'simple' but FAILS 'two_thirds' — proves the stored rule governed.
    expect(input.result).toBe('rejected')
  })

  it("(g/a) client result 'withdrawn' is still honoured on a tally row", async () => {
    mockSql.mockResolvedValue([storedTallyRow])
    await PATCH(makePatchEvent({ result: 'withdrawn' }))
    const input = mockUpdateResolution.mock.calls[0][1] as ResolutionInput
    expect(input.result).toBe('withdrawn')
  })

  it("(g/c) acclamation row: declared_result 'passed' updates the result without quorum or recomputation", async () => {
    mockSql.mockResolvedValue([storedAcclamationRow])
    const res = await PATCH(makePatchEvent({ declared_result: 'passed' }))
    expect(res.status).toBe(200)

    const input = mockUpdateResolution.mock.calls[0][1] as ResolutionInput
    expect(input.result).toBe('passed')
    expect(mockGetQuorumContext).not.toHaveBeenCalled()
  })

  it("(g/a) acclamation row: client result 'withdrawn' updates the result (no silent no-op)", async () => {
    // Regression: the acclamation branch used to ignore body.result, so the UI's
    // "Zurückziehen" (which sends { result: 'withdrawn' } for acclamation rows
    // too) never took effect. It must now behave like the tally branch.
    mockSql.mockResolvedValue([storedAcclamationRow])
    const res = await PATCH(makePatchEvent({ result: 'withdrawn' }))
    expect(res.status).toBe(200)

    const input = mockUpdateResolution.mock.calls[0][1] as ResolutionInput
    expect(input.result).toBe('withdrawn')
    // Withdrawal is an author act, not a declared outcome — no quorum lookup.
    expect(mockGetQuorumContext).not.toHaveBeenCalled()
  })

  it('(g/a) acclamation row: a withdrawn row is un-withdrawn by a fresh declared_result (tally-branch parity)', async () => {
    mockSql.mockResolvedValue([{ ...storedAcclamationRow, result: 'withdrawn' }])
    const res = await PATCH(makePatchEvent({ declared_result: 'passed' }))
    expect(res.status).toBe(200)

    const input = mockUpdateResolution.mock.calls[0][1] as ResolutionInput
    expect(input.result).toBe('passed')
  })

  it('(g/d) acclamation row: omitting declared_result leaves the stored result untouched (text-only edit)', async () => {
    mockSql.mockResolvedValue([storedAcclamationRow])
    const res = await PATCH(makePatchEvent({ text: 'Neuer Text' }))
    expect(res.status).toBe(200)

    const input = mockUpdateResolution.mock.calls[0][1] as ResolutionInput
    expect(input.text).toBe('Neuer Text')
    expect(input.result).toBeUndefined()
    expect(input.votesYes).toBeUndefined() // NULL tallies stay NULL — not coerced
  })

  it('(g/e) acclamation row: partial informational tally → 400', async () => {
    mockSql.mockResolvedValue([storedAcclamationRow])
    await expect(PATCH(makePatchEvent({ declared_result: 'passed', votesYes: 5 }))).rejects.toMatchObject({ status: 400 })
    expect(mockUpdateResolution).not.toHaveBeenCalled()
  })

  it('(g/e) acclamation row: full informational tally → stored', async () => {
    mockSql.mockResolvedValue([storedAcclamationRow])
    const res = await PATCH(makePatchEvent({ declared_result: 'rejected', votesYes: 1, votesNo: 8, votesAbstain: 0 }))
    expect(res.status).toBe(200)

    const input = mockUpdateResolution.mock.calls[0][1] as ResolutionInput
    expect(input.votesYes).toBe(1)
    expect(input.votesNo).toBe(8)
    expect(input.votesAbstain).toBe(0)
    expect(input.result).toBe('rejected')
  })

  it('(4) tally support_threshold row with an out-of-range STORED fraction → clean 400 (not a 500)', async () => {
    mockSql.mockResolvedValue([
      { ...storedTallyRow, required_majority: 'support_threshold', decision_rule_params: { fraction: 0 } },
    ])
    await expect(
      PATCH(makePatchEvent({ votesYes: 3, votesNo: 0, votesAbstain: 0 })),
    ).rejects.toMatchObject({ status: 400 })
    expect(mockUpdateResolution).not.toHaveBeenCalled()
  })

  it('(4) tally support_threshold row with a valid STORED fraction recomputes normally', async () => {
    mockSql.mockResolvedValue([
      { ...storedTallyRow, required_majority: 'support_threshold', decision_rule_params: { fraction: 0.5 } },
    ])
    // eligible 5 (mocked quorum), fraction 0.5 → threshold ceil(2.5)=3; yes=3 passes.
    const res = await PATCH(makePatchEvent({ votesYes: 3, votesNo: 0, votesAbstain: 0 }))
    expect(res.status).toBe(200)
    const input = mockUpdateResolution.mock.calls[0][1] as ResolutionInput
    expect(input.result).toBe('passed')
  })

  it('404 when the resolution does not exist', async () => {
    mockSql.mockResolvedValue([])
    await expect(PATCH(makePatchEvent({ text: 'X' }))).rejects.toMatchObject({ status: 404 })
  })
})
