import { describe, it, expect } from 'vitest'
import { checkResolutionAgainstAttendance } from './resolution-plausibility'

const QUORATE = { eligibleVotingCount: 5, presentVotingCount: 4, quorate: true }
const NOT_QUORATE = { eligibleVotingCount: 5, presentVotingCount: 2, quorate: false }

const tally = (yes: number, no = 0, abstain = 0, extra: Record<string, unknown> = {}) => ({
  result: 'rejected',
  required_majority: 'simple',
  adoption_mode: 'tally',
  votes_yes: yes,
  votes_no: no,
  votes_abstain: abstain,
  ...extra,
})

describe('checkResolutionAgainstAttendance', () => {
  it('accepts a count that fits the attendance, up to exactly the number present', () => {
    expect(checkResolutionAgainstAttendance(tally(2, 1, 1), QUORATE)).toBeNull()
    expect(checkResolutionAgainstAttendance(tally(1), QUORATE)).toBeNull()
  })

  it('refuses a count above the number present, abstentions included, naming both numbers', () => {
    const r = checkResolutionAgainstAttendance(tally(2, 1, 2), QUORATE)
    expect(r?.code).toBe('votes_exceed_attendance')
    expect(r?.message).toMatch(/5/)
    expect(r?.message).toMatch(/4/)
    expect(r?.message).toMatch(/anwesend/)
  })

  it('refuses any decision of a meeting that is not beschlussfähig, and says what to do', () => {
    const r = checkResolutionAgainstAttendance(tally(2), NOT_QUORATE)
    expect(r?.code).toBe('not_quorate')
    expect(r?.message).toMatch(/nicht beschlussfähig/i)
    expect(r?.message).toMatch(/2/)
    expect(r?.message).toMatch(/Anwesenheit/)
  })

  it('names the missing quorum before the count when both are wrong', () => {
    expect(checkResolutionAgainstAttendance(tally(999), { eligibleVotingCount: 2, presentVotingCount: 0, quorate: false })?.code)
      .toBe('not_quorate')
  })

  it('lets a withdrawn resolution through, whatever the count and the meeting', () => {
    expect(checkResolutionAgainstAttendance(tally(999, 0, 0, { result: 'withdrawn' }), NOT_QUORATE)).toBeNull()
  })

  it('treats a row nobody voted on as a placeholder, not as a decision', () => {
    expect(checkResolutionAgainstAttendance(tally(0), NOT_QUORATE)).toBeNull()
  })

  it('treats a consent resolution with an empty tally as adopted', () => {
    expect(checkResolutionAgainstAttendance(tally(0, 0, 0, { required_majority: 'consent' }), NOT_QUORATE)?.code)
      .toBe('not_quorate')
  })

  it('handles an acclamation without a count and one with an informational count', () => {
    const acclamation = { result: 'passed', required_majority: 'simple', adoption_mode: 'acclamation' }
    expect(checkResolutionAgainstAttendance({ ...acclamation, votes_yes: null, votes_no: null, votes_abstain: null }, QUORATE)).toBeNull()
    expect(checkResolutionAgainstAttendance({ ...acclamation, votes_yes: 9, votes_no: 0, votes_abstain: 0 }, QUORATE)?.code)
      .toBe('votes_exceed_attendance')
    expect(checkResolutionAgainstAttendance(acclamation, NOT_QUORATE)?.code).toBe('not_quorate')
  })

  it('reads counts that arrive as strings', () => {
    expect(checkResolutionAgainstAttendance(tally(0, 0, 0, { votes_yes: '9' }), QUORATE)?.code)
      .toBe('votes_exceed_attendance')
  })
})
