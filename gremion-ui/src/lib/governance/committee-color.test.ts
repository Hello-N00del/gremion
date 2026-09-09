import { describe, expect, it } from 'vitest'
import { deriveHue, deriveAbbr } from './committee-color'

describe('deriveHue', () => {
  it('returns the same hue for the same id', () => {
    const a = deriveHue('committee-uuid-1')
    const b = deriveHue('committee-uuid-1')
    expect(a).toBe(b)
  })

  it('returns a hue in [0, 360)', () => {
    for (const id of ['a', 'aaa', 'committee-1', '00000000-0000-0000-0000-000000000000']) {
      const h = deriveHue(id)
      expect(h).toBeGreaterThanOrEqual(0)
      expect(h).toBeLessThan(360)
    }
  })

  it('produces different hues for different ids (sample)', () => {
    const ids = ['a', 'b', 'c', 'plenum', 'praesidium', 'haushalt', 'oeffentlichkeit']
    const hues = new Set(ids.map(deriveHue))
    // not a hard guarantee, but for 7 short distinct strings we expect >1 unique hue
    expect(hues.size).toBeGreaterThan(1)
  })
})

describe('deriveAbbr', () => {
  it('takes the first two letters of a single word, uppercased', () => {
    expect(deriveAbbr('Plenum')).toBe('PL')
  })

  it('takes the first letter of each of the first two words for multi-word names', () => {
    expect(deriveAbbr('Haushalts Ausschuss')).toBe('HA')
    expect(deriveAbbr('Studenten Rat Vorstand')).toBe('SR')
  })

  it('strips punctuation', () => {
    expect(deriveAbbr('Vorstand & Präsidium')).toBe('VP')
  })

  it('handles empty input safely', () => {
    expect(deriveAbbr('')).toBe('??')
    expect(deriveAbbr('  ')).toBe('??')
  })
})
