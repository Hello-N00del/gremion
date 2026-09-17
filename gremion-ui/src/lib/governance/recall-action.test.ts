import { describe, expect, it } from 'vitest'
import { buildRevokeRequest } from './recall-action'

// Pure request builder for the recall ("Abberufung") action on the committee
// roster admin surface. Contract: the governance revoke endpoint
//   POST /api/governance/committees/:id/roles/:roleId/revoke  body: { reason }
// with a REQUIRED non-empty reason (German validation message on violation).

describe('buildRevokeRequest', () => {
  it('rejects an empty reason with a German validation message', () => {
    expect(() => buildRevokeRequest('committee-1', 'role-1', '')).toThrowError(
      'Bitte einen Grund für die Abberufung angeben.'
    )
  })

  it('rejects a whitespace-only reason with the same German message', () => {
    for (const blank of [' ', '   ', '\t', '\n', ' \t \n ']) {
      expect(() => buildRevokeRequest('committee-1', 'role-1', blank)).toThrowError(
        'Bitte einen Grund für die Abberufung angeben.'
      )
    }
  })

  it('builds the revoke request for a valid reason', () => {
    const req = buildRevokeRequest(
      '11111111-2222-3333-4444-555555555555',
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      'Vertrauensverlust nach Beschluss des Plenums'
    )
    expect(req).toEqual({
      url: '/api/governance/committees/11111111-2222-3333-4444-555555555555/roles/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/revoke',
      method: 'POST',
      body: { reason: 'Vertrauensverlust nach Beschluss des Plenums' },
    })
  })

  it('URL-encodes both path segments', () => {
    // Mirrors buildChallengePayload's encoding contract: an id carrying a
    // character that must be escaped may not break out of its path segment.
    const req = buildRevokeRequest('a/b', 'c d#e', 'Vertrauensverlust')
    expect(req.url).toBe('/api/governance/committees/a%2Fb/roles/c%20d%23e/revoke')
  })

  it('trims surrounding whitespace from an otherwise valid reason', () => {
    const req = buildRevokeRequest('c-1', 'r-1', '  Rücktritt verweigert  ')
    expect(req.body).toEqual({ reason: 'Rücktritt verweigert' })
  })
})
