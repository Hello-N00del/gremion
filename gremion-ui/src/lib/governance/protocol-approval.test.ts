import { describe, it, expect } from 'vitest'
import { evaluateApprover, countOtherEligible, APPROVAL_MESSAGES } from './protocol-approval'

const subject = { created_by: 'author', submitted_by: 'submitter' }
const admin = (userId: string) => ({ userId, isAdmin: true, isVotingMember: false })
const voter = (userId: string) => ({ userId, isAdmin: false, isVotingMember: true })

describe('evaluateApprover', () => {
  it('refuses the submitter, the creator and anyone who is neither admin nor voting member', () => {
    expect(evaluateApprover(subject, admin('submitter'))).toEqual({
      ok: false, reason: 'submitter', message: APPROVAL_MESSAGES.submitter,
    })
    expect(evaluateApprover(subject, voter('author'))).toEqual({
      ok: false, reason: 'author', message: APPROVAL_MESSAGES.author,
    })
    expect(evaluateApprover(subject, { userId: 'x', isAdmin: false, isVotingMember: false })).toMatchObject({
      ok: false, reason: 'not-eligible',
    })
  })

  it('accepts a second admin or a second voting member', () => {
    expect(evaluateApprover(subject, admin('other'))).toEqual({ ok: true })
    expect(evaluateApprover(subject, voter('other'))).toEqual({ ok: true })
  })

  it('tells an outsider nothing about who submitted', () => {
    const verdict = evaluateApprover(subject, { userId: 'submitter', isAdmin: false, isVotingMember: false })
    expect(verdict).toMatchObject({ ok: false, reason: 'not-eligible' })
  })

  it('holds the creator rule when no submitter was recorded', () => {
    const legacy = { created_by: 'author', submitted_by: null }
    expect(evaluateApprover(legacy, admin('other'))).toEqual({ ok: true })
    expect(evaluateApprover(legacy, admin('author'))).toMatchObject({ ok: false, reason: 'author' })
  })

  it('never lets two empty identities match', () => {
    const noOne = { created_by: null, submitted_by: null }
    expect(evaluateApprover(noOne, admin('other'))).toEqual({ ok: true })
  })
})

describe('countOtherEligible', () => {
  it('counts admins and voting members once each, without the submitter and the creator', () => {
    expect(countOtherEligible(subject, ['submitter', 'a1', 'a2'], ['a2', 'v1', 'author'])).toBe(3)
  })

  it('is 0 when the submitter and the creator are the only eligible people', () => {
    expect(countOtherEligible(subject, ['submitter'], ['author', 'submitter'])).toBe(0)
  })
})
