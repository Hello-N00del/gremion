// T6 (#320 contestability UI): pure client-side helper for the /beschluesse
// 'Anfechten' form. Validation mirrors the DB bound (migration 055:
// char_length(grounds) BETWEEN 1 AND 4000) so the member gets a German
// message client-side instead of a 500 from the CHECK constraint, and the
// payload builder pins the POST contract of
// POST /api/protocols/resolutions/[resId]/challenges (T2): JSON { grounds }.
import { describe, it, expect } from 'vitest'
import {
  CHALLENGE_GROUNDS_MAX,
  validateChallengeGrounds,
  buildChallengePayload,
} from './challenge-form'

describe('CHALLENGE_GROUNDS_MAX', () => {
  it('mirrors the 055 CHECK upper bound (4000)', () => {
    expect(CHALLENGE_GROUNDS_MAX).toBe(4000)
  })
})

describe('validateChallengeGrounds', () => {
  it('rejects empty grounds with a German message', () => {
    const r = validateChallengeGrounds('')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('Begründung ist erforderlich.')
  })

  it('rejects whitespace-only grounds (trimmed empty) with the same German message', () => {
    const r = validateChallengeGrounds('   \n\t ')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('Begründung ist erforderlich.')
  })

  it('rejects grounds over the 055 CHECK bound client-side with a German message', () => {
    const r = validateChallengeGrounds('x'.repeat(CHALLENGE_GROUNDS_MAX + 1))
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toBe('Begründung darf höchstens 4000 Zeichen umfassen.')
    }
  })

  it('accepts grounds exactly at the bound', () => {
    const r = validateChallengeGrounds('x'.repeat(CHALLENGE_GROUNDS_MAX))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.grounds).toHaveLength(CHALLENGE_GROUNDS_MAX)
  })

  it('trims surrounding whitespace and returns the trimmed grounds', () => {
    const r = validateChallengeGrounds('  Verstoß gegen §7 der GO.  ')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.grounds).toBe('Verstoß gegen §7 der GO.')
  })

  it('measures the bound on the TRIMMED grounds (what is actually sent)', () => {
    // 4000 payload chars padded by whitespace must still be valid.
    const r = validateChallengeGrounds('  ' + 'x'.repeat(CHALLENGE_GROUNDS_MAX) + '  ')
    expect(r.ok).toBe(true)
  })
})

describe('buildChallengePayload', () => {
  it('produces the POST body for /api/protocols/resolutions/[resId]/challenges', () => {
    const req = buildChallengePayload('7c9e6679-7425-40de-944b-e07fc1f90ae7', ' Formfehler bei der Abstimmung ')
    expect(req).toEqual({
      url: '/api/protocols/resolutions/7c9e6679-7425-40de-944b-e07fc1f90ae7/challenges',
      method: 'POST',
      body: { grounds: 'Formfehler bei der Abstimmung' },
    })
  })

  it('URL-encodes the resolution id', () => {
    const req = buildChallengePayload('a/b', 'Begründung')
    expect(req.url).toBe('/api/protocols/resolutions/a%2Fb/challenges')
  })

  it('throws the German validation message for empty grounds', () => {
    expect(() => buildChallengePayload('res-1', '')).toThrowError('Begründung ist erforderlich.')
  })

  it('throws the German validation message for grounds over the bound', () => {
    expect(() => buildChallengePayload('res-1', 'x'.repeat(CHALLENGE_GROUNDS_MAX + 1))).toThrowError(
      'Begründung darf höchstens 4000 Zeichen umfassen.',
    )
  })
})
