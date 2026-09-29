// T1 (#320 Phase 2) — migration 054 adoption-mode CHECK matrix, DB-backed.
//
// Migration 054 adds `adoption_mode` ('tally' | 'acclamation') to
// protocol_resolutions, makes the three vote-tally columns NULLABLE, and
// enforces the vote/mode CHECK matrix in the DB. These constraints live in
// Postgres, so only a real DB can prove them (pattern:
// resolution-adoption.integration.test.ts, same vitest.integration.config.ts
// lane against the safe local test DB):
//   (a) adoption_mode='tally' with ANY of votes_yes/no/abstain NULL
//       → CHECK violation, SQLSTATE 23514,
//   (b) 'acclamation' with all three NULL → row lands (votes read back NULL),
//   (c) 'acclamation' with all three set → row lands (a recorded count is
//       still allowed alongside an acclamation decision),
//   (d) 'acclamation' with exactly one or two tallies set → 23514
//       (all-or-nothing — a partial tally is never storable),
//   (e) required_majority accepts the new 'consent' and 'support_threshold'
//       values and still rejects an unknown value → 23514,
//   (f) decision_rule_params JSONB round-trips and defaults to NULL.
//
// required_majority is INERT for acclamation rows (declarative metadata only)
// — documented in 054's header; nothing here ties the rule to the mode.

import { describe, it, expect, beforeEach } from 'vitest'
import { getDb } from '../db'
import { createOrgUnit } from '../governance/org-units-db'
import { createProtocol } from './protocol-db'

interface ResolutionRow {
  id: string
  votes_yes: number | null
  votes_no: number | null
  votes_abstain: number | null
  adoption_mode: string
  required_majority: string
  decision_rule_params: Record<string, unknown> | null
}

let protocolId: string
let seq: number

async function insertResolution(opts: {
  adoptionMode: string
  votesYes: number | null
  votesNo: number | null
  votesAbstain: number | null
  requiredMajority?: string
  /** JSONB payload; `undefined` omits the column so the DB default applies. */
  decisionRuleParams?: Record<string, unknown>
}): Promise<ResolutionRow> {
  const sql = getDb()
  const requiredMajority = opts.requiredMajority ?? 'simple'
  const rows =
    opts.decisionRuleParams === undefined
      ? await sql<ResolutionRow[]>`
          INSERT INTO protocol_resolutions
            (protocol_id, sequence_nr, text, votes_yes, votes_no, votes_abstain,
             result, required_majority, adoption_mode)
          VALUES
            (${protocolId}, ${++seq}, 'Antrag', ${opts.votesYes}, ${opts.votesNo},
             ${opts.votesAbstain}, 'passed', ${requiredMajority}, ${opts.adoptionMode})
          RETURNING id, votes_yes, votes_no, votes_abstain, adoption_mode,
                    required_majority, decision_rule_params
        `
      : await sql<ResolutionRow[]>`
          INSERT INTO protocol_resolutions
            (protocol_id, sequence_nr, text, votes_yes, votes_no, votes_abstain,
             result, required_majority, adoption_mode, decision_rule_params)
          VALUES
            (${protocolId}, ${++seq}, 'Antrag', ${opts.votesYes}, ${opts.votesNo},
             ${opts.votesAbstain}, 'passed', ${requiredMajority}, ${opts.adoptionMode},
             ${sql.json(opts.decisionRuleParams as never) as never})
          RETURNING id, votes_yes, votes_no, votes_abstain, adoption_mode,
                    required_majority, decision_rule_params
        `
  return rows[0]
}

/** Asserts the insert rejects with the given SQLSTATE (postgres.js `code`). */
async function expectSqlState(p: Promise<unknown>, sqlstate: string): Promise<void> {
  let caught: unknown
  try {
    await p
  } catch (e) {
    caught = e
  }
  expect(caught, `expected query to reject with SQLSTATE ${sqlstate}`).toBeDefined()
  expect((caught as { code?: string }).code).toBe(sqlstate)
}

describe('#320 T1 migration 054 — adoption_mode CHECK matrix (integration)', () => {
  beforeEach(async () => {
    const sql = getDb()
    await sql`DELETE FROM protocol_attendance`
    await sql`DELETE FROM protocols` // cascades protocol_resolutions
    await sql`DELETE FROM org_unit_members`
    await sql`DELETE FROM org_units`
    const unit = await createOrgUnit({
      name: 'Rat', description: null, parentId: null, kind: 'council',
      visibility: 'all_members', wantsMatrixRoom: false, wantsNextcloudFolder: false,
    })
    const protocol = await createProtocol({
      committeeId: unit.id, meetingDate: '2026-07-21', title: 'Sitzung', createdBy: 'voter-0',
    })
    protocolId = protocol.id
    seq = 0
  })

  it('(a) tally with any vote tally NULL raises 23514', async () => {
    expect.hasAssertions() // the assertions live in expectSqlState
    const partials = [
      { votesYes: null, votesNo: 0, votesAbstain: 0 },
      { votesYes: 1, votesNo: null, votesAbstain: 0 },
      { votesYes: 1, votesNo: 0, votesAbstain: null },
      { votesYes: null, votesNo: null, votesAbstain: null },
    ]
    for (const votes of partials) {
      await expectSqlState(insertResolution({ adoptionMode: 'tally', ...votes }), '23514')
    }
  })

  it('(b) acclamation with all three tallies NULL succeeds and reads back NULL', async () => {
    const row = await insertResolution({
      adoptionMode: 'acclamation', votesYes: null, votesNo: null, votesAbstain: null,
    })
    expect(row.adoption_mode).toBe('acclamation')
    expect(row.votes_yes).toBeNull()
    expect(row.votes_no).toBeNull()
    expect(row.votes_abstain).toBeNull()
  })

  it('(c) acclamation with all three tallies set succeeds', async () => {
    const row = await insertResolution({
      adoptionMode: 'acclamation', votesYes: 5, votesNo: 1, votesAbstain: 2,
    })
    expect(row.adoption_mode).toBe('acclamation')
    expect(row.votes_yes).toBe(5)
    expect(row.votes_no).toBe(1)
    expect(row.votes_abstain).toBe(2)
  })

  it('(d) acclamation with exactly one or two tallies set raises 23514', async () => {
    expect.hasAssertions() // the assertions live in expectSqlState
    const partials = [
      // exactly one set
      { votesYes: 1, votesNo: null, votesAbstain: null },
      { votesYes: null, votesNo: 1, votesAbstain: null },
      { votesYes: null, votesNo: null, votesAbstain: 1 },
      // exactly two set
      { votesYes: 1, votesNo: 1, votesAbstain: null },
      { votesYes: 1, votesNo: null, votesAbstain: 1 },
      { votesYes: null, votesNo: 1, votesAbstain: 1 },
    ]
    for (const votes of partials) {
      await expectSqlState(insertResolution({ adoptionMode: 'acclamation', ...votes }), '23514')
    }
  })

  it("(e) required_majority accepts 'consent' + 'support_threshold', rejects unknown", async () => {
    const consent = await insertResolution({
      adoptionMode: 'tally', votesYes: 3, votesNo: 0, votesAbstain: 0,
      requiredMajority: 'consent',
    })
    expect(consent.required_majority).toBe('consent')

    const support = await insertResolution({
      adoptionMode: 'tally', votesYes: 3, votesNo: 1, votesAbstain: 0,
      requiredMajority: 'support_threshold',
    })
    expect(support.required_majority).toBe('support_threshold')

    await expectSqlState(
      insertResolution({
        adoptionMode: 'tally', votesYes: 3, votesNo: 0, votesAbstain: 0,
        requiredMajority: 'landslide',
      }),
      '23514',
    )
  })

  it('(f) decision_rule_params JSONB round-trips and defaults NULL', async () => {
    const params = { threshold: 0.6, basis: 'members_present' }
    const withParams = await insertResolution({
      adoptionMode: 'tally', votesYes: 3, votesNo: 2, votesAbstain: 0,
      requiredMajority: 'support_threshold', decisionRuleParams: params,
    })
    expect(withParams.decision_rule_params).toEqual(params)

    // Re-read from disk (not just RETURNING) to prove the round-trip.
    const sql = getDb()
    const reread = await sql<Pick<ResolutionRow, 'decision_rule_params'>[]>`
      SELECT decision_rule_params FROM protocol_resolutions WHERE id = ${withParams.id}
    `
    expect(reread[0].decision_rule_params).toEqual(params)

    const withoutParams = await insertResolution({
      adoptionMode: 'tally', votesYes: 1, votesNo: 0, votesAbstain: 0,
    })
    expect(withoutParams.decision_rule_params).toBeNull()
  })
})
