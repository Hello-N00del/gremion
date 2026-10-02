import { describe, it, expect } from 'vitest'
import { clientIp, clientIpWithReason } from './client-ip'

// T04 round 2. The five copies this replaces all returned the string
// `'unknown'` on failure, which put every un-addressable caller into ONE shared
// rate-limit bucket on endpoints that are unauthenticated by design. The
// contract asserted here is that an absent address is `null` — a value a caller
// cannot accidentally use as a key.
describe('clientIp — an absent address is null, never a sentinel string', () => {
  it('returns the address when getClientAddress works', () => {
    expect(clientIp({ getClientAddress: () => '203.0.113.7' })).toBe('203.0.113.7')
  })

  it('trims surrounding whitespace so one client cannot occupy two buckets', () => {
    expect(clientIp({ getClientAddress: () => '  203.0.113.7  ' })).toBe('203.0.113.7')
  })

  it('returns null when the event has no getClientAddress at all', () => {
    expect(clientIp({})).toBeNull()
  })

  // The live path this change created. adapter-node throws when a configured
  // ADDRESS_HEADER is missing from the request, and docker-compose.prod.yml now
  // sets ADDRESS_HEADER on gremion-ui. Before that the call read the socket and
  // could not throw, so this branch was dead code.
  it('returns null when getClientAddress throws (adapter-node, ADDRESS_HEADER absent)', () => {
    expect(
      clientIp({
        getClientAddress: () => {
          throw new Error('Address header x-forwarded-for not present in request')
        },
      }),
    ).toBeNull()
  })

  it('returns null for an empty or whitespace-only address', () => {
    expect(clientIp({ getClientAddress: () => '' })).toBeNull()
    expect(clientIp({ getClientAddress: () => '   ' })).toBeNull()
  })

  it('returns null when getClientAddress returns a non-string', () => {
    expect(clientIp({ getClientAddress: () => undefined as unknown as string })).toBeNull()
    expect(clientIp({ getClientAddress: () => 42 as unknown as string })).toBeNull()
  })

  // The regression guard proper: no input may ever produce the old sentinel.
  it('never returns the string "unknown"', () => {
    const events: Array<{ getClientAddress?: () => string }> = [
      {},
      { getClientAddress: () => '' },
      {
        getClientAddress: () => {
          throw new Error('boom')
        },
      },
      { getClientAddress: () => undefined as unknown as string },
    ]
    for (const e of events) expect(clientIp(e)).not.toBe('unknown')
  })
})

// ============================================================================
// T04 round 3 — an absent address must say WHY.
//
// Round 2 collapsed five copies of this helper into one that returns `null`,
// and both callers turned `null` into an unconditional 429. That is fail-closed
// and it is also UNDIAGNOSABLE: the three ways an address goes missing have
// completely different remedies —
//
//   • `getClientAddress` THREW  → adapter-node has ADDRESS_HEADER configured
//                                 and the request carried no X-Forwarded-For.
//                                 That is an edge/misconfiguration problem
//                                 (a probe bypassing Traefik, a missing
//                                 forward header on a runbook command), and it
//                                 is the one that made the seed step in the
//                                 netcup runbook 429 before it reached the
//                                 handler.
//   • the event had NO getClientAddress → a partial event; only tests.
//   • the address was blank / not a string → adapter returned something
//                                 unusable.
//
// A 429 with no reason forces an operator to guess between them from a status
// code. `clientIpWithReason` names it, and `clientIp` stays the thin
// string-or-null wrapper every existing caller already uses.
// ============================================================================
describe('clientIpWithReason — an absent address names its cause', () => {
  it('reports ok with the address when getClientAddress works', () => {
    expect(clientIpWithReason({ getClientAddress: () => '203.0.113.7' })).toEqual({
      ip: '203.0.113.7',
      reason: 'ok',
    })
  })

  it('reports "unavailable" when the event exposes no getClientAddress', () => {
    expect(clientIpWithReason({})).toEqual({ ip: null, reason: 'unavailable' })
  })

  it('reports "threw" when adapter-node rejects a request with no ADDRESS_HEADER', () => {
    const result = clientIpWithReason({
      getClientAddress: () => {
        throw new Error('Address header x-forwarded-for not present in request')
      },
    })
    expect(result.ip).toBeNull()
    expect(result.reason).toBe('threw')
  })

  it('reports "blank" for an empty or whitespace-only address', () => {
    expect(clientIpWithReason({ getClientAddress: () => '' }).reason).toBe('blank')
    expect(clientIpWithReason({ getClientAddress: () => '   ' }).reason).toBe('blank')
  })

  it('reports "not-a-string" when the adapter returns a non-string', () => {
    expect(clientIpWithReason({ getClientAddress: () => 42 as unknown as string }).reason).toBe(
      'not-a-string',
    )
  })

  it('agrees with clientIp on every input — one is defined in terms of the other', () => {
    const events: Array<{ getClientAddress?: () => string }> = [
      {},
      { getClientAddress: () => '203.0.113.7' },
      { getClientAddress: () => '  203.0.113.7  ' },
      { getClientAddress: () => '' },
      {
        getClientAddress: () => {
          throw new Error('boom')
        },
      },
      { getClientAddress: () => undefined as unknown as string },
    ]
    for (const e of events) expect(clientIp(e)).toBe(clientIpWithReason(e).ip)
  })
})
