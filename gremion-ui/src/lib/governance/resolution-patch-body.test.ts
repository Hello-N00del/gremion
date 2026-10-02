// TASK-206-A review (H1): the protocol editor sent the whole resolution row to
// PATCH /api/protocols/[id]/resolutions/[resId], `result` included, and the
// Phase-2 route refuses a free-hand 'passed'|'rejected' (INV-5) with a 400, so
// every edit failed. The body is shaped to the resolution-write contract here
// (source: the f2 editor's saveResolution).
import { describe, it, expect } from 'vitest'
import { resolutionPatchBody } from './resolution-patch-body'

const tally = {
  text: 'Haushalt',
  votes_yes: 5,
  votes_no: 1,
  votes_abstain: 0,
  result: 'passed' as const,
  adoption_mode: 'tally' as const,
}

describe('resolutionPatchBody', () => {
  it('a tally row sends text + tallies and never a free-hand result', () => {
    expect(resolutionPatchBody(tally)).toEqual({ text: 'Haushalt', votes_yes: 5, votes_no: 1, votes_abstain: 0 })
  })

  it('a row without adoption_mode is a tally row', () => {
    const { adoption_mode: _omit, ...legacy } = tally
    expect(resolutionPatchBody(legacy)).toEqual({ text: 'Haushalt', votes_yes: 5, votes_no: 1, votes_abstain: 0 })
  })

  it("a withdrawn row sends result 'withdrawn' (an author act) and no tallies", () => {
    expect(resolutionPatchBody({ ...tally, result: 'withdrawn' })).toEqual({ text: 'Haushalt', result: 'withdrawn' })
  })

  it('an acclamation row sends the declared outcome, tallies all-or-none', () => {
    const acc = { ...tally, adoption_mode: 'acclamation' as const, result: 'rejected' as const }
    expect(resolutionPatchBody(acc)).toEqual({
      text: 'Haushalt', declared_result: 'rejected', votes_yes: 5, votes_no: 1, votes_abstain: 0,
    })
    expect(resolutionPatchBody({ ...acc, votes_yes: null, votes_no: null, votes_abstain: null })).toEqual({
      text: 'Haushalt', declared_result: 'rejected',
    })
    expect(resolutionPatchBody({ ...acc, votes_no: null })).toEqual({ text: 'Haushalt', declared_result: 'rejected' })
  })
})
