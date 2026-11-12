import { describe, it, expect } from 'vitest'
import {
  isUntalliedResolution,
  tallyIsEmpty,
  untalliedPositions,
  untalliedResolutionsMessage,
} from './resolution-vote-state'
import { computeResult } from './compute-result'

const row = (over: Record<string, unknown> = {}) => ({
  result: 'rejected',
  required_majority: 'simple',
  adoption_mode: 'tally',
  votes_yes: 0,
  votes_no: 0,
  votes_abstain: 0,
  ...over,
})

describe('isUntalliedResolution', () => {
  it('a counted resolution with 0/0/0 has not been voted on, under every majority rule', () => {
    for (const rule of ['simple', 'two_thirds', 'absolute', 'support_threshold']) {
      expect(isUntalliedResolution(row({ required_majority: rule }))).toBe(true)
    }
  })

  it('a row read without an adoption mode is a counted vote', () => {
    expect(isUntalliedResolution(row({ adoption_mode: undefined }))).toBe(true)
    expect(isUntalliedResolution(row({ adoption_mode: null }))).toBe(true)
  })

  it('any recorded vote, an abstention included, is a vote', () => {
    expect(isUntalliedResolution(row({ votes_yes: 1 }))).toBe(false)
    expect(isUntalliedResolution(row({ votes_no: 1 }))).toBe(false)
    expect(isUntalliedResolution(row({ votes_abstain: 4 }))).toBe(false)
  })

  it('a consent resolution with an empty tally is adopted, not missing a vote', () => {
    const consent = row({ required_majority: 'consent', result: 'passed' })
    expect(isUntalliedResolution(consent)).toBe(false)
    // The rule mirror agrees: silence adopts.
    expect(computeResult(0, 0, 'consent', 5)).toBe('passed')
  })

  it('a withdrawn resolution needs no vote', () => {
    expect(isUntalliedResolution(row({ result: 'withdrawn' }))).toBe(false)
  })

  it('an acclamation resolution needs no count', () => {
    const acclamation = { adoption_mode: 'acclamation', votes_yes: null, votes_no: null, votes_abstain: null }
    expect(isUntalliedResolution(row({ ...acclamation, result: 'passed' }))).toBe(false)
    expect(isUntalliedResolution(row({ ...acclamation, result: 'rejected' }))).toBe(false)
  })

  it('fails closed: a counted row without counts is untallied whatever result it carries', () => {
    expect(isUntalliedResolution({ result: 'passed', required_majority: 'simple' })).toBe(true)
    expect(isUntalliedResolution(row({ result: 'passed', votes_yes: null, votes_no: null, votes_abstain: null }))).toBe(true)
  })
})

describe('tallyIsEmpty', () => {
  it('treats missing, empty and zero counts alike', () => {
    expect(tallyIsEmpty({ votes_yes: 0, votes_no: 0, votes_abstain: 0 })).toBe(true)
    expect(tallyIsEmpty({ votes_yes: null, votes_no: undefined, votes_abstain: '' })).toBe(true)
    expect(tallyIsEmpty({ votes_yes: 0, votes_no: 0, votes_abstain: 1 })).toBe(false)
  })
})

describe('untalliedPositions / untalliedResolutionsMessage', () => {
  const voted = row({ votes_yes: 3, votes_no: 1, result: 'passed' })

  it('reports nothing when every resolution has a vote', () => {
    expect(untalliedPositions([voted, row({ result: 'withdrawn' })])).toEqual([])
    expect(untalliedResolutionsMessage([voted])).toBeNull()
    expect(untalliedResolutionsMessage([])).toBeNull()
  })

  it('names the position of a single untallied resolution and the ways out', () => {
    const message = untalliedResolutionsMessage([voted, row()])
    expect(message).toMatch(/^Beschluss 2 hat noch keine Abstimmung\./)
    expect(message).toMatch(/Stimmen eintragen/)
    expect(message).toMatch(/zurückziehen/)
    expect(message).toMatch(/löschen/)
  })

  it('lists several untallied resolutions', () => {
    expect(untalliedPositions([row(), voted, row(), row()])).toEqual([1, 3, 4])
    expect(untalliedResolutionsMessage([row(), voted, row(), row()])).toMatch(
      /^Die Beschlüsse 1, 3 und 4 haben noch keine Abstimmung\./,
    )
    expect(untalliedResolutionsMessage([row(), row()])).toMatch(/^Die Beschlüsse 1 und 2 haben/)
  })
})
