import { describe, it, expect } from 'vitest'
import {
  computeEventColour,
  FALLBACK_COLOR,
  DEFAULT_SHARED_EVENT_COLOR,
} from './calendar-color'

describe('computeEventColour', () => {
  const shared = DEFAULT_SHARED_EVENT_COLOR

  it('single committee: primary=committee, secondary=event type', () => {
    const result = computeEventColour({
      isMultiCommittee: false,
      hasCommittee: true,
      committeeColor: '#3b82f6',
      eventTypeColor: '#ef4444',
      sharedEventColor: shared,
    })
    expect(result).toEqual({ primary: '#3b82f6', secondary: '#ef4444' })
  })

  it('multi-committee: primary=sharedEventColor, secondary=event type', () => {
    const result = computeEventColour({
      isMultiCommittee: true,
      hasCommittee: true,
      committeeColor: '#3b82f6',
      eventTypeColor: '#ef4444',
      sharedEventColor: shared,
    })
    expect(result).toEqual({ primary: shared, secondary: '#ef4444' })
  })

  it('no committee (holiday): solid event-type colour', () => {
    const result = computeEventColour({
      isMultiCommittee: false,
      hasCommittee: false,
      committeeColor: null,
      eventTypeColor: '#f59e0b',
      sharedEventColor: shared,
    })
    expect(result).toEqual({ primary: '#f59e0b', secondary: '#f59e0b' })
  })

  it('no event type colour: falls back to default', () => {
    const result = computeEventColour({
      isMultiCommittee: false,
      hasCommittee: true,
      committeeColor: '#3b82f6',
      eventTypeColor: null,
      sharedEventColor: shared,
    })
    expect(result).toEqual({ primary: '#3b82f6', secondary: FALLBACK_COLOR })
  })

  it('no committee colour + hasCommittee true: falls back to default', () => {
    const result = computeEventColour({
      isMultiCommittee: false,
      hasCommittee: true,
      committeeColor: null,
      eventTypeColor: '#f59e0b',
      sharedEventColor: shared,
    })
    expect(result).toEqual({ primary: FALLBACK_COLOR, secondary: '#f59e0b' })
  })

  it('holiday with null event type colour: solid fallback', () => {
    const result = computeEventColour({
      isMultiCommittee: false,
      hasCommittee: false,
      committeeColor: null,
      eventTypeColor: null,
      sharedEventColor: shared,
    })
    expect(result).toEqual({ primary: FALLBACK_COLOR, secondary: FALLBACK_COLOR })
  })
})
