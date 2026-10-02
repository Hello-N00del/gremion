import { describe, expect, it } from 'vitest'
import { dedupeDegradedUuids, deriveHeliosStatus } from './helios-status'
import type { VoteItem } from './types'

function fakeVote(over: Partial<VoteItem> = {}): VoteItem {
  return {
    id: 'helios:uuid-1',
    kind: 'helios',
    lifecycle: 'open',
    title: 'Wahl',
    description: '',
    turnout: 0,
    quorum: 0,
    voterCount: 0,
    castVotes: 0,
    opens: '',
    closes: '',
    ...over,
  }
}

describe('deriveHeliosStatus (D4 — single reachability source)', () => {
  it('is success „Helios verbunden“ only when there is no pollError and no degraded row', () => {
    const s = deriveHeliosStatus(null, 0)
    expect(s.kind).toBe('connected')
    expect(s.tone).toBe('success')
    expect(s.label).toBe('Helios verbunden')
    // Pill-icon contract (CR-3): success → check.
    expect(s.icon).toBe('check')
  })

  it('is warn „Helios nicht erreichbar“ on a full outage (pollError set)', () => {
    const s = deriveHeliosStatus('upstream 503', 0)
    expect(s.kind).toBe('unreachable')
    expect(s.tone).toBe('warn')
    expect(s.label).toBe('Helios nicht erreichbar')
    // Pill-icon contract (CR-3): warn → clock.
    expect(s.icon).toBe('clock')
  })

  it('is warn „Helios eingeschränkt“ on a partial outage (some degraded rows)', () => {
    const s = deriveHeliosStatus(null, 2)
    expect(s.kind).toBe('degraded')
    expect(s.tone).toBe('warn')
    expect(s.label).toBe('Helios eingeschränkt')
    expect(s.icon).toBe('clock')
  })

  it('lets the full outage outrank the partial state when both apply', () => {
    const s = deriveHeliosStatus('upstream 503', 3)
    expect(s.kind).toBe('unreachable')
    expect(s.label).toBe('Helios nicht erreichbar')
  })

  it('never uses danger — an unreachable satellite is an Einschränkung (R2), not a hard failure', () => {
    for (const s of [
      deriveHeliosStatus(null, 0),
      deriveHeliosStatus('boom', 0),
      deriveHeliosStatus(null, 5),
    ]) {
      expect(['success', 'warn']).toContain(s.tone)
    }
  })
})

describe('dedupeDegradedUuids (D4 — combined list never repeats a helios_uuid)', () => {
  it('drops a degraded uuid that is already hydrated (the hydrated row wins)', () => {
    const hydrated = [fakeVote({ id: 'helios:uuid-1' })]
    expect(dedupeDegradedUuids(hydrated, ['uuid-1', 'uuid-2'])).toEqual(['uuid-2'])
  })

  it('drops repeats within the degraded set itself, preserving first-seen order', () => {
    expect(dedupeDegradedUuids([], ['uuid-2', 'uuid-1', 'uuid-2', 'uuid-1'])).toEqual([
      'uuid-2',
      'uuid-1',
    ])
  })

  it('ignores poll items when collecting hydrated uuids (poll:7 must not shadow uuid "7")', () => {
    const hydrated = [fakeVote({ id: 'poll:7', kind: 'poll' })]
    expect(dedupeDegradedUuids(hydrated, ['7'])).toEqual(['7'])
  })

  it('passes an already-clean degraded set through unchanged', () => {
    const hydrated = [fakeVote({ id: 'helios:uuid-1' })]
    expect(dedupeDegradedUuids(hydrated, ['uuid-2', 'uuid-3'])).toEqual(['uuid-2', 'uuid-3'])
  })

  it('returns empty for an empty degraded set', () => {
    expect(dedupeDegradedUuids([fakeVote()], [])).toEqual([])
  })
})
