import { describe, test, expect } from 'vitest'
import { ACTIONS, getActionPolicy } from './actions'

describe('action registry', () => {
  test('the governance-only kernel ships no built-in protected actions', () => {
    // Feature modules (e.g. finance) register their step-up-gated actions here
    // when present; the carved kernel registry is empty by design.
    expect(Object.keys(ACTIONS)).toEqual([])
  })

  test('getActionPolicy + ActionPolicy plumbing remains exported', () => {
    expect(typeof getActionPolicy).toBe('function')
  })
})
