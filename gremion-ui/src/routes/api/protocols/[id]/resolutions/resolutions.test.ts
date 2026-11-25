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
  mockGetProtocol, mockAddResolution, mockUpdateResolution, mockDeleteResolution, ResolutionPublishedError, ResolutionNotFoundError, ProtocolNotEditableError,
} = vi.hoisted(() => ({
  mockGetProtocol: vi.fn(),
  mockAddResolution: vi.fn(),
  mockUpdateResolution: vi.fn(),
  mockDeleteResolution: vi.fn(),
  // Same shape as the real class in protocol-db.ts; the route maps it to a 403
  // with an instanceof check, so the mock factory must export the SAME class the
  // tests throw.
  ResolutionPublishedError: class ResolutionPublishedError extends Error {
    constructor(public readonly resolutionId: string) {
      super(`Resolution ${resolutionId} belongs to a published protocol`)
      this.name = 'ResolutionPublishedError'
    }
  },
  ResolutionNotFoundError: class ResolutionNotFoundError extends Error {
    constructor(public readonly resolutionId: string) {
      super(`Resolution ${resolutionId} not found`)
      this.name = 'ResolutionNotFoundError'
    }
  },
  ProtocolNotEditableError: class ProtocolNotEditableError extends Error {
    constructor(public readonly protocolId: string) {
      super(`Protocol ${protocolId} takes no more resolutions`)
      this.name = 'ProtocolNotEditableError'
    }
  },
}))
vi.mock('$lib/server/protocols/protocol-db', () => ({
  getProtocol: mockGetProtocol,
  addResolution: mockAddResolution,
  updateResolution: mockUpdateResolution,
  deleteResolution: mockDeleteResolution,
  ResolutionPublishedError,
  ResolutionNotFoundError,
  ProtocolNotEditableError,
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
import { PATCH, DELETE } from './[resId]/+server'

// R30-F1-PROTO-K: route ids under /api/protocols/** must be UUIDs.
const PID = '123e4567-e89b-12d3-a456-426614174001'
const RID = '123e4567-e89b-12d3-a456-426614174002'

const draftProtocol = { id: PID, committee_id: 'c1', status: 'draft' }

const storedTallyRow = {
  protocol_id: PID,
  votes_yes: 2, votes_no: 1, votes_abstain: 0,
  required_majority: 'simple', adoption_mode: 'tally',
}
const storedAcclamationRow = {
  protocol_id: PID,
  votes_yes: null, votes_no: null, votes_abstain: null,
  required_majority: 'simple', adoption_mode: 'acclamation',
}

function makePostEvent(body: unknown) {
  return {
    locals: { user: { id: 'u1', roles: ['council-admin'] } },
    params: { id: PID },
    request: { json: async () => body },
  } as unknown as Parameters<typeof POST>[0]
}

function makePatchEvent(body: unknown) {
  return {
    locals: { user: { id: 'u1', roles: ['council-admin'] } },
    params: { id: PID, resId: RID },
    request: { json: async () => body },
  } as unknown as Parameters<typeof PATCH>[0]
}

type ResolutionInput = Record<string, unknown>

// Eligible 5, present 4: quorate, and a tally of up to 4 votes fits the attendance.
const QUORATE = { eligibleVotingCount: 5, presentVotingCount: 4, quorate: true }
// Eligible 9, present 7: quorate and roomy, for the cases that pin rule arithmetic with larger tallies.
const ROOMY = { eligibleVotingCount: 9, presentVotingCount: 7, quorate: true }
// Eligible 5, only 2 present: not quorate by the app's rule (strict majority).
const NOT_QUORATE = { eligibleVotingCount: 5, presentVotingCount: 2, quorate: false }

beforeEach(() => {
  mockGetProtocol.mockReset().mockResolvedValue(draftProtocol)
  mockAddResolution.mockReset().mockImplementation(
    async (_protocolId: string, input: ResolutionInput) => ({ id: 'r-new', protocol_id: PID, ...input }),
  )
  mockUpdateResolution.mockReset().mockImplementation(
    async (id: string, input: ResolutionInput) => ({ id, protocol_id: PID, ...input }),
  )
  mockDeleteResolution.mockReset()
  mockGetQuorumContext.mockReset().mockResolvedValue(QUORATE)
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
    // Acclamation is a declaration, not a computation, but it is still a decision
    // of the meeting: the quorum is looked up (a non-quorate meeting is refused,
    // see the plausibility block below).
    expect(mockGetQuorumContext).toHaveBeenCalledOnce()
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
    mockGetQuorumContext.mockResolvedValue({ eligibleVotingCount: 20, presentVotingCount: 15, quorate: true })
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
    mockGetQuorumContext.mockResolvedValue(ROOMY)
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

  it("(g/c) acclamation row: declared_result 'passed' updates the result without recomputation (quorum is checked)", async () => {
    mockSql.mockResolvedValue([storedAcclamationRow])
    const res = await PATCH(makePatchEvent({ declared_result: 'passed' }))
    expect(res.status).toBe(200)

    const input = mockUpdateResolution.mock.calls[0][1] as ResolutionInput
    expect(input.result).toBe('passed')
    expect(mockGetQuorumContext).toHaveBeenCalledOnce()
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
    mockGetQuorumContext.mockResolvedValue(ROOMY)
    mockSql.mockResolvedValue([storedAcclamationRow])
    const res = await PATCH(makePatchEvent({ declared_result: 'rejected', votesYes: 1, votesNo: 6, votesAbstain: 0 }))
    expect(res.status).toBe(200)

    const input = mockUpdateResolution.mock.calls[0][1] as ResolutionInput
    expect(input.votesYes).toBe(1)
    expect(input.votesNo).toBe(6)
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

// ─────────────────────────────────────────────────────────────────────────────
// Client-input errors from the decision-rule engine are 400s, never 500s
// (R28 house review MEDIUM: UnknownDecisionRuleError / InvalidDecisionRuleTallyError
// escaped both write routes as opaque 500s).
// ─────────────────────────────────────────────────────────────────────────────

describe('resolution write routes — decision-rule input errors map to 400', () => {
  it('(h) POST tally with an unknown requiredMajority → 400, nothing persisted', async () => {
    await expect(
      POST(makePostEvent({ text: 'X', requiredMajority: 'bogus', votesYes: 3, votesNo: 1, votesAbstain: 0 })),
    ).rejects.toMatchObject({ status: 400 })
    expect(mockAddResolution).not.toHaveBeenCalled()
  })

  it('(h) POST acclamation with an unknown requiredMajority → 400 (never reaches the DB CHECK)', async () => {
    await expect(
      POST(makePostEvent({ text: 'X', adoption_mode: 'acclamation', declared_result: 'passed', requiredMajority: 'bogus' })),
    ).rejects.toMatchObject({ status: 400 })
    expect(mockAddResolution).not.toHaveBeenCalled()
  })

  it.each([
    ['negative', { votesYes: -1, votesNo: 0, votesAbstain: 0 }],
    ['non-integer', { votesYes: 1.5, votesNo: 0, votesAbstain: 0 }],
    ['string', { votesYes: '3', votesNo: 0, votesAbstain: 0 }],
  ] as const)('(h) POST tally with a %s tally → 400, nothing persisted', async (_label, votes) => {
    await expect(POST(makePostEvent({ text: 'X', ...votes }))).rejects.toMatchObject({ status: 400 })
    expect(mockAddResolution).not.toHaveBeenCalled()
  })

  it('(h) PATCH tally row with a negative tally → 400, nothing persisted', async () => {
    mockSql.mockResolvedValue([storedTallyRow])
    await expect(
      PATCH(makePatchEvent({ votesYes: 3, votesNo: -2, votesAbstain: 0 })),
    ).rejects.toMatchObject({ status: 400 })
    expect(mockUpdateResolution).not.toHaveBeenCalled()
  })

  it('(h) PATCH on a row whose STORED rule is unknown → 400, nothing persisted', async () => {
    mockSql.mockResolvedValue([{ ...storedTallyRow, required_majority: 'retired_rule' }])
    await expect(
      PATCH(makePatchEvent({ votesYes: 3, votesNo: 0, votesAbstain: 0 })),
    ).rejects.toMatchObject({ status: 400 })
    expect(mockUpdateResolution).not.toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// An adopted resolution is immutable through PATCH/DELETE (R28 house review
// MEDIUM, security): publish IS adoption, so after it the binding result may
// change only through the recorded challenge channel — never a silent edit. The
// row must also belong to the protocol named in the URL.
// ─────────────────────────────────────────────────────────────────────────────

describe('resolution PATCH/DELETE — adopted rows and foreign protocols are refused', () => {
  const publishedAcclamationRow = {
    ...storedAcclamationRow, result: 'passed', protocol_status: 'published', decided_at: '2026-09-01T10:00:00Z',
  }

  it('(i) PATCH declared_result on an acclamation row of a PUBLISHED protocol → 403, nothing persisted', async () => {
    mockSql.mockResolvedValue([publishedAcclamationRow])
    await expect(PATCH(makePatchEvent({ declared_result: 'rejected' }))).rejects.toMatchObject({ status: 403 })
    expect(mockUpdateResolution).not.toHaveBeenCalled()
  })

  it('(i) PATCH tallies on an ADOPTED tally row (decided_at set) → 403, nothing persisted', async () => {
    mockSql.mockResolvedValue([{ ...storedTallyRow, protocol_status: 'submitted', decided_at: '2026-09-01T10:00:00Z' }])
    await expect(PATCH(makePatchEvent({ votesYes: 0, votesNo: 5, votesAbstain: 0 }))).rejects.toMatchObject({ status: 403 })
    expect(mockUpdateResolution).not.toHaveBeenCalled()
  })

  it('(i) PATCH on a resolution of ANOTHER protocol than the URL names → 404, nothing persisted', async () => {
    mockSql.mockResolvedValue([{ ...storedTallyRow, protocol_id: 'p-other', protocol_status: 'draft', decided_at: null }])
    await expect(PATCH(makePatchEvent({ text: 'X' }))).rejects.toMatchObject({ status: 404 })
    expect(mockUpdateResolution).not.toHaveBeenCalled()
  })

  it('(i) PATCH on a draft protocol still works', async () => {
    mockSql.mockResolvedValue([{ ...storedTallyRow, protocol_status: 'draft', decided_at: null }])
    const res = await PATCH(makePatchEvent({ text: 'Neu' }))
    expect(res.status).toBe(200)
    expect(mockUpdateResolution).toHaveBeenCalledOnce()
  })

  it('(i) DELETE on a resolution of a PUBLISHED protocol → 403, nothing deleted', async () => {
    mockSql.mockResolvedValue([publishedAcclamationRow])
    await expect(DELETE(makePatchEvent(undefined))).rejects.toMatchObject({ status: 403 })
    expect(mockDeleteResolution).not.toHaveBeenCalled()
  })

  it('(i) DELETE on a resolution of ANOTHER protocol → 404, nothing deleted', async () => {
    mockSql.mockResolvedValue([{ ...storedTallyRow, protocol_id: 'p-other', protocol_status: 'draft', decided_at: null }])
    await expect(DELETE(makePatchEvent(undefined))).rejects.toMatchObject({ status: 404 })
    expect(mockDeleteResolution).not.toHaveBeenCalled()
  })

  it('(i) DELETE on an unknown resolution → 404', async () => {
    mockSql.mockResolvedValue([])
    await expect(DELETE(makePatchEvent(undefined))).rejects.toMatchObject({ status: 404 })
    expect(mockDeleteResolution).not.toHaveBeenCalled()
  })

  it('(i) DELETE on a draft protocol → 204', async () => {
    mockSql.mockResolvedValue([{ ...storedTallyRow, protocol_status: 'draft', decided_at: null }])
    const res = await DELETE(makePatchEvent(undefined))
    expect(res.status).toBe(204)
    expect(mockDeleteResolution).toHaveBeenCalledWith(RID)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Publish race (#433): loadEditableResolution reads, THEN the write runs. A
// publish committing in between passes the early check, so the lock in the
// write statement is what refuses it; the db layer reports that as
// ResolutionPublishedError and the route must answer 403 (same text as the
// early check), never a 500.
// ─────────────────────────────────────────────────────────────────────────────

describe('resolution PATCH/DELETE — publish committed between the check and the write → 403', () => {
  const draftRow = { ...storedTallyRow, protocol_status: 'draft', decided_at: null }
  const lockedText = 'Angenommene Beschlüsse sind nicht bearbeitbar (Einspruch statt Änderung)'

  it('tally PATCH: the write is refused by the lock → 403 with the same text as the early check', async () => {
    mockSql.mockResolvedValue([draftRow])
    mockUpdateResolution.mockRejectedValueOnce(new ResolutionPublishedError('r1'))
    await expect(PATCH(makePatchEvent({ votesYes: 3, votesNo: 0, votesAbstain: 0 })))
      .rejects.toMatchObject({ status: 403, body: { message: lockedText } })
  })

  it('acclamation PATCH (declared_result): → 403', async () => {
    mockSql.mockResolvedValue([{ ...storedAcclamationRow, protocol_status: 'draft', decided_at: null }])
    mockUpdateResolution.mockRejectedValueOnce(new ResolutionPublishedError('r1'))
    await expect(PATCH(makePatchEvent({ declared_result: 'passed' }))).rejects.toMatchObject({ status: 403 })
  })

  it('acclamation PATCH (withdrawn): → 403', async () => {
    mockSql.mockResolvedValue([{ ...storedAcclamationRow, protocol_status: 'draft', decided_at: null }])
    mockUpdateResolution.mockRejectedValueOnce(new ResolutionPublishedError('r1'))
    await expect(PATCH(makePatchEvent({ result: 'withdrawn' }))).rejects.toMatchObject({ status: 403 })
  })

  it('DELETE: the delete is refused by the lock → 403 with the same text', async () => {
    mockSql.mockResolvedValue([draftRow])
    mockDeleteResolution.mockRejectedValueOnce(new ResolutionPublishedError('r1'))
    await expect(DELETE(makePatchEvent(undefined)))
      .rejects.toMatchObject({ status: 403, body: { message: lockedText } })
  })

  it('PATCH: the row vanished between the check and the write → 404, not 403', async () => {
    mockSql.mockResolvedValue([draftRow])
    mockUpdateResolution.mockRejectedValueOnce(new ResolutionNotFoundError('r1'))
    await expect(PATCH(makePatchEvent({ text: 'X' }))).rejects.toMatchObject({ status: 404 })
  })

  it('DELETE: the row vanished between the check and the write → 404, not 403', async () => {
    mockSql.mockResolvedValue([draftRow])
    mockDeleteResolution.mockRejectedValueOnce(new ResolutionNotFoundError('r1'))
    await expect(DELETE(makePatchEvent(undefined))).rejects.toMatchObject({ status: 404 })
  })

  it('an unrelated write failure is NOT mapped to 403', async () => {
    mockSql.mockResolvedValue([draftRow])
    mockUpdateResolution.mockRejectedValueOnce(new Error('connection reset'))
    await expect(PATCH(makePatchEvent({ text: 'X' }))).rejects.toThrow('connection reset')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Publish race on POST: getProtocol reads, THEN addResolution inserts. A publish
// committing in between passes the early check; the status guard inside the
// INSERT refuses it and the db layer reports ProtocolNotEditableError. The route
// answers 403 with the same text as the early check, never a 500.
// ─────────────────────────────────────────────────────────────────────────────

describe('resolution POST — publish committed between the check and the insert → 403', () => {
  it('tally: the insert is refused by the guard → 403 with the same text as the early check', async () => {
    mockAddResolution.mockRejectedValueOnce(new ProtocolNotEditableError(PID))
    await expect(POST(makePostEvent({ text: 'Antrag', votesYes: 3, votesNo: 1, votesAbstain: 0 })))
      .rejects.toMatchObject({ status: 403, body: { message: 'Nicht bearbeitbar' } })
  })

  it('acclamation: the insert is refused by the guard → 403', async () => {
    mockAddResolution.mockRejectedValueOnce(new ProtocolNotEditableError(PID))
    await expect(POST(makePostEvent({ text: 'Antrag', adoption_mode: 'acclamation', declared_result: 'passed' })))
      .rejects.toMatchObject({ status: 403, body: { message: 'Nicht bearbeitbar' } })
  })

  it('an unrelated insert failure is NOT mapped to 403', async () => {
    mockAddResolution.mockRejectedValueOnce(new Error('connection reset'))
    await expect(POST(makePostEvent({ text: 'Antrag', votesYes: 3, votesNo: 1, votesAbstain: 0 })))
      .rejects.toThrow('connection reset')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// A decision without text is never stored (IT-admin pass 2026-11-13: the
// editor's "+ Beschluss hinzufügen" used to POST an empty row at once).
// ─────────────────────────────────────────────────────────────────────────────

describe('resolution write routes — a decision needs its text', () => {
  it.each([
    ['empty string', { text: '' }],
    ['whitespace only', { text: '   \n\t ' }],
    ['text missing', {}],
    ['text null', { text: null }],
    ['text not a string', { text: 42 }],
  ] as const)('POST tally with %s → 400 with a German message, nothing persisted', async (_label, extra) => {
    await expect(
      POST(makePostEvent({ ...extra, votesYes: 0, votesNo: 0, votesAbstain: 0, requiredMajority: 'simple' })),
    ).rejects.toMatchObject({ status: 400, body: { message: expect.stringContaining('Beschlusstext') } })
    expect(mockAddResolution).not.toHaveBeenCalled()
  })

  it('POST acclamation without text → 400, nothing persisted', async () => {
    await expect(
      POST(makePostEvent({ text: ' ', adoption_mode: 'acclamation', declared_result: 'passed' })),
    ).rejects.toMatchObject({ status: 400 })
    expect(mockAddResolution).not.toHaveBeenCalled()
  })

  it('POST stores the trimmed text when it has content', async () => {
    const res = await POST(makePostEvent({ text: '  Antrag A  ', votesYes: 0, votesNo: 0, votesAbstain: 0 }))
    expect(res.status).toBe(201)
    const input = mockAddResolution.mock.calls[0][1] as ResolutionInput
    expect(input.text).toBe('Antrag A')
  })

  it.each(['', '   '])('PATCH clearing the text (%j) → 400, row untouched', async (blank) => {
    mockSql.mockResolvedValue([storedTallyRow])
    await expect(PATCH(makePatchEvent({ text: blank, votesYes: 1, votesNo: 0, votesAbstain: 0 })))
      .rejects.toMatchObject({ status: 400, body: { message: expect.stringContaining('Beschlusstext') } })
    expect(mockUpdateResolution).not.toHaveBeenCalled()
  })

  it('PATCH clearing the text of an acclamation row → 400, row untouched', async () => {
    mockSql.mockResolvedValue([storedAcclamationRow])
    await expect(PATCH(makePatchEvent({ text: '', declared_result: 'passed' }))).rejects.toMatchObject({ status: 400 })
    expect(mockUpdateResolution).not.toHaveBeenCalled()
  })

  it('PATCH without a text field still edits the tallies (text is COALESCEd, not cleared)', async () => {
    mockSql.mockResolvedValue([storedTallyRow])
    const res = await PATCH(makePatchEvent({ votesYes: 3, votesNo: 0, votesAbstain: 0 }))
    expect(res.status).toBe(200)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Plausibility: the votes must fit the attendance, and a meeting that is not
// quorate by the app's own rule stores no decision. Found by a live test: 999 yes
// votes in a body of 2 members, both marked absent, on a page that said
// "Nicht beschlussfähig", was stored and shown as "Angenommen".
// ─────────────────────────────────────────────────────────────────────────────

const refusal = (err: unknown) => err as { status: number; body: { message: string } }

describe('POST /api/protocols/[id]/resolutions — votes must fit the attendance', () => {
  it('the live case: 999 yes in a body of 2, both absent → refused, nothing stored', async () => {
    mockGetQuorumContext.mockResolvedValue({ eligibleVotingCount: 2, presentVotingCount: 0, quorate: false })
    const err = await POST(makePostEvent({ text: 'Antrag', votesYes: 999, votesNo: 0, votesAbstain: 0 })).catch((e) => e)
    expect(refusal(err).status).toBe(422)
    expect(refusal(err).body.message).toMatch(/nicht beschlussfähig/i)
    expect(mockAddResolution).not.toHaveBeenCalled()
  })

  it('more votes than members present in a quorate meeting → 400 naming both numbers, nothing stored', async () => {
    const err = await POST(makePostEvent({ text: 'Antrag', votesYes: 3, votesNo: 2, votesAbstain: 0 })).catch((e) => e)
    expect(refusal(err).status).toBe(400)
    expect(refusal(err).body.message).toMatch(/5/)
    expect(refusal(err).body.message).toMatch(/4/)
    expect(refusal(err).body.message).toMatch(/anwesend/)
    expect(mockAddResolution).not.toHaveBeenCalled()
  })

  it('abstentions count towards the total', async () => {
    await expect(
      POST(makePostEvent({ text: 'Antrag', votesYes: 1, votesNo: 1, votesAbstain: 3 })),
    ).rejects.toMatchObject({ status: 400 })
    expect(mockAddResolution).not.toHaveBeenCalled()
  })

  it('exactly as many votes as members present is plausible → 201', async () => {
    const res = await POST(makePostEvent({ text: 'Antrag', votesYes: 2, votesNo: 1, votesAbstain: 1 }))
    expect(res.status).toBe(201)
    expect(mockAddResolution).toHaveBeenCalledOnce()
  })

  it('a valid vote in a quorate meeting is stored with the computed result', async () => {
    const res = await POST(makePostEvent({ text: 'Antrag', votesYes: 3, votesNo: 1, votesAbstain: 0 }))
    expect(res.status).toBe(201)
    expect((mockAddResolution.mock.calls[0][1] as ResolutionInput).result).toBe('passed')
  })

  it('a meeting that is not quorate stores no counted decision, even with a plausible count', async () => {
    mockGetQuorumContext.mockResolvedValue(NOT_QUORATE)
    const err = await POST(makePostEvent({ text: 'Antrag', votesYes: 2, votesNo: 0, votesAbstain: 0 })).catch((e) => e)
    expect(refusal(err).status).toBe(422)
    expect(refusal(err).body.message).toMatch(/nicht beschlussfähig/i)
    expect(refusal(err).body.message).toMatch(/Anwesenheit/)
    expect(mockAddResolution).not.toHaveBeenCalled()
  })

  it('a withdrawn resolution is no vote: stored in a non-quorate meeting and with any count', async () => {
    mockGetQuorumContext.mockResolvedValue(NOT_QUORATE)
    const res = await POST(makePostEvent({ text: 'Zurück', votesYes: 999, votesNo: 0, votesAbstain: 0, result: 'withdrawn' }))
    expect(res.status).toBe(201)
    expect((mockAddResolution.mock.calls[0][1] as ResolutionInput).result).toBe('withdrawn')
  })

  it('a row nobody voted on (0/0/0) is a placeholder, not a decision: stored in a non-quorate meeting', async () => {
    mockGetQuorumContext.mockResolvedValue(NOT_QUORATE)
    const res = await POST(makePostEvent({ text: 'Antrag', votesYes: 0, votesNo: 0, votesAbstain: 0 }))
    expect(res.status).toBe(201)
  })

  it('a consent resolution with an empty tally is adopted, so a non-quorate meeting refuses it', async () => {
    mockGetQuorumContext.mockResolvedValue(NOT_QUORATE)
    await expect(
      POST(makePostEvent({ text: 'Konsens', requiredMajority: 'consent', votesYes: 0, votesNo: 0, votesAbstain: 0 })),
    ).rejects.toMatchObject({ status: 422 })
    expect(mockAddResolution).not.toHaveBeenCalled()
  })

  it('acclamation in a non-quorate meeting is refused like a counted decision', async () => {
    mockGetQuorumContext.mockResolvedValue(NOT_QUORATE)
    await expect(
      POST(makePostEvent({ text: 'Akklamation', adoption_mode: 'acclamation', declared_result: 'passed' })),
    ).rejects.toMatchObject({ status: 422 })
    expect(mockAddResolution).not.toHaveBeenCalled()
  })

  it('an acclamation count that exceeds the attendance → 400', async () => {
    await expect(
      POST(makePostEvent({
        text: 'Akklamation', adoption_mode: 'acclamation', declared_result: 'passed',
        votesYes: 40, votesNo: 0, votesAbstain: 0,
      })),
    ).rejects.toMatchObject({ status: 400 })
    expect(mockAddResolution).not.toHaveBeenCalled()
  })

  it('an acclamation count with a negative part that cancels the rest (999 / -999) → 400, nothing stored', async () => {
    mockGetQuorumContext.mockResolvedValue({ eligibleVotingCount: 2, presentVotingCount: 2, quorate: true })
    const err = await POST(makePostEvent({
      text: 'Akklamation', adoption_mode: 'acclamation', declared_result: 'passed',
      votesYes: 999, votesNo: -999, votesAbstain: 0,
    })).catch((e) => e)
    expect(refusal(err).status).toBe(400)
    expect(refusal(err).body.message).toMatch(/ganze Zahl/)
    expect(mockAddResolution).not.toHaveBeenCalled()
  })

  it.each(['2', '0x2', '1e0', ' 2 ', '-1'])(
    'an acclamation count sent as the string %j → 400, nothing stored (number-only, like the tally path)',
    async (raw) => {
      mockGetQuorumContext.mockResolvedValue({ eligibleVotingCount: 4, presentVotingCount: 4, quorate: true })
      const err = await POST(makePostEvent({
        text: 'Akklamation', adoption_mode: 'acclamation', declared_result: 'passed',
        votesYes: raw, votesNo: 0, votesAbstain: 0,
      })).catch((e) => e)
      expect(refusal(err).status).toBe(400)
      expect(refusal(err).body.message).toMatch(/ganze Zahl/)
      expect(mockAddResolution).not.toHaveBeenCalled()
    },
  )

  it('an acclamation count that is not a whole number → 400, nothing stored', async () => {
    await expect(
      POST(makePostEvent({
        text: 'Akklamation', adoption_mode: 'acclamation', declared_result: 'passed',
        votesYes: 1.5, votesNo: 0, votesAbstain: 0,
      })),
    ).rejects.toMatchObject({ status: 400 })
    await expect(
      POST(makePostEvent({
        text: 'Akklamation', adoption_mode: 'acclamation', declared_result: 'passed',
        votesYes: 'zwei', votesNo: 0, votesAbstain: 0,
      })),
    ).rejects.toMatchObject({ status: 400 })
    expect(mockAddResolution).not.toHaveBeenCalled()
  })

  it('an acclamation without a count in a quorate meeting is stored', async () => {
    const res = await POST(makePostEvent({ text: 'Akklamation', adoption_mode: 'acclamation', declared_result: 'passed' }))
    expect(res.status).toBe(201)
  })
})

describe('PATCH /api/protocols/[id]/resolutions/[resId] — votes must fit the attendance', () => {
  it('an edit that raises the count above the attendance → 400, nothing updated', async () => {
    mockSql.mockResolvedValue([storedTallyRow])
    const err = await PATCH(makePatchEvent({ votesYes: 999 })).catch((e) => e)
    expect(refusal(err).status).toBe(400)
    expect(refusal(err).body.message).toMatch(/anwesend/)
    expect(mockUpdateResolution).not.toHaveBeenCalled()
  })

  it('an edit in a meeting that is not quorate → 422, nothing updated', async () => {
    mockGetQuorumContext.mockResolvedValue(NOT_QUORATE)
    mockSql.mockResolvedValue([storedTallyRow])
    const err = await PATCH(makePatchEvent({ votesYes: 2, votesNo: 0, votesAbstain: 0 })).catch((e) => e)
    expect(refusal(err).status).toBe(422)
    expect(refusal(err).body.message).toMatch(/nicht beschlussfähig/i)
    expect(mockUpdateResolution).not.toHaveBeenCalled()
  })

  it('the live case on the edit path: 999 yes, both absent → refused', async () => {
    mockGetQuorumContext.mockResolvedValue({ eligibleVotingCount: 2, presentVotingCount: 0, quorate: false })
    mockSql.mockResolvedValue([storedTallyRow])
    await expect(PATCH(makePatchEvent({ votesYes: 999 }))).rejects.toMatchObject({ status: 422 })
    expect(mockUpdateResolution).not.toHaveBeenCalled()
  })

  it('an edit that keeps the count within the attendance is stored', async () => {
    mockSql.mockResolvedValue([storedTallyRow])
    const res = await PATCH(makePatchEvent({ votesYes: 3, votesNo: 1, votesAbstain: 0 }))
    expect(res.status).toBe(200)
    expect((mockUpdateResolution.mock.calls[0][1] as ResolutionInput).result).toBe('passed')
  })

  it('withdrawing stays possible in a non-quorate meeting and for a row whose stored count is implausible', async () => {
    mockGetQuorumContext.mockResolvedValue(NOT_QUORATE)
    mockSql.mockResolvedValue([{ ...storedTallyRow, votes_yes: 999 }])
    const res = await PATCH(makePatchEvent({ result: 'withdrawn' }))
    expect(res.status).toBe(200)
    expect((mockUpdateResolution.mock.calls[0][1] as ResolutionInput).result).toBe('withdrawn')
  })

  it('an acclamation edit declaring a result in a non-quorate meeting → 422', async () => {
    mockGetQuorumContext.mockResolvedValue(NOT_QUORATE)
    mockSql.mockResolvedValue([storedAcclamationRow])
    await expect(PATCH(makePatchEvent({ declared_result: 'passed' }))).rejects.toMatchObject({ status: 422 })
    expect(mockUpdateResolution).not.toHaveBeenCalled()
  })

  it('an acclamation count above the attendance → 400', async () => {
    mockSql.mockResolvedValue([storedAcclamationRow])
    await expect(
      PATCH(makePatchEvent({ declared_result: 'passed', votesYes: 30, votesNo: 0, votesAbstain: 0 })),
    ).rejects.toMatchObject({ status: 400 })
    expect(mockUpdateResolution).not.toHaveBeenCalled()
  })

  it('an acclamation edit with a negative part that cancels the rest (999 / -999) → 400, nothing updated', async () => {
    mockSql.mockResolvedValue([storedAcclamationRow])
    mockGetQuorumContext.mockResolvedValue({ eligibleVotingCount: 2, presentVotingCount: 2, quorate: true })
    const err = await PATCH(makePatchEvent({
      declared_result: 'passed', votesYes: 999, votesNo: -999, votesAbstain: 0,
    })).catch((e) => e)
    expect(refusal(err).status).toBe(400)
    expect(refusal(err).body.message).toMatch(/ganze Zahl/)
    expect(mockUpdateResolution).not.toHaveBeenCalled()
  })

  it.each(['2', '0x2', '1e0', ' 2 ', '-1'])(
    'an acclamation edit with a count sent as the string %j → 400, nothing updated (number-only, like the tally path)',
    async (raw) => {
      mockSql.mockResolvedValue([storedAcclamationRow])
      mockGetQuorumContext.mockResolvedValue({ eligibleVotingCount: 4, presentVotingCount: 4, quorate: true })
      const err = await PATCH(makePatchEvent({
        declared_result: 'passed', votesYes: 0, votesNo: raw, votesAbstain: 0,
      })).catch((e) => e)
      expect(refusal(err).status).toBe(400)
      expect(refusal(err).body.message).toMatch(/ganze Zahl/)
      expect(mockUpdateResolution).not.toHaveBeenCalled()
    },
  )

  it('an acclamation edit with a count that is not a whole number → 400, nothing updated', async () => {
    mockSql.mockResolvedValue([storedAcclamationRow])
    await expect(
      PATCH(makePatchEvent({ declared_result: 'passed', votesYes: 0.5, votesNo: 0, votesAbstain: 0 })),
    ).rejects.toMatchObject({ status: 400 })
    expect(mockUpdateResolution).not.toHaveBeenCalled()
  })

  it('an edit of an untallied placeholder (text only) stays possible in a non-quorate meeting', async () => {
    mockGetQuorumContext.mockResolvedValue(NOT_QUORATE)
    mockSql.mockResolvedValue([{ ...storedTallyRow, votes_yes: 0, votes_no: 0, votes_abstain: 0 }])
    const res = await PATCH(makePatchEvent({ text: 'Neuer Text' }))
    expect(res.status).toBe(200)
  })
})
