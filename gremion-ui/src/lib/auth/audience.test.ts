import { describe, it, expect } from 'vitest'
import { parseAudiences, DEFAULT_AUDIENCES } from './audience'

describe('parseAudiences', () => {
  it('returns the default audiences when unset/empty', () => {
    expect(parseAudiences(undefined)).toEqual(DEFAULT_AUDIENCES)
    expect(parseAudiences('')).toEqual(DEFAULT_AUDIENCES)
    expect(parseAudiences('   ')).toEqual(DEFAULT_AUDIENCES)
  })

  it('splits a comma-separated list and trims/drops blanks', () => {
    expect(parseAudiences('gremion-ui, gremion-mobile ,svc-newsletter')).toEqual([
      'gremion-ui', 'gremion-mobile', 'svc-newsletter',
    ])
  })

  it('preserves the legacy default verbatim', () => {
    expect(DEFAULT_AUDIENCES).toEqual(['gremion-ui', 'gremion-mobile'])
  })
})
