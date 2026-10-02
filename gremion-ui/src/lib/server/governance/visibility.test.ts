// R29-F104-KTWIN: the D-3 rule itself (operator decision R29-I16, "NOTHING
// UNTIL PUBLISHED"), pinned with the REAL role helper ($lib/auth) so the role
// hierarchy (ITAdmin inherits CouncilAdmin, CouncilAdmin inherits Member) is
// what the predicates actually see.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Role } from '$lib/auth/types'

const h = vi.hoisted(() => ({ isMemberOf: vi.fn(), getOrgUnitIdsForUser: vi.fn() }))
vi.mock('./org-units-db', () => ({ isMemberOf: h.isMemberOf, getOrgUnitIdsForUser: h.getOrgUnitIdsForUser }))

import {
  canSeeOrgUnit,
  canSeeProtocol,
  filterVisibleProtocols,
  filterVisiblePublished,
  seesAllGovernance,
  viewerCanSeeProtocol,
  visiblePublishedWithoutMembership,
  visibleProtocolsWithoutMembership,
} from './visibility'

const CLOSED = { visibility: 'committee_only' as const }
const OPEN = { visibility: 'all_members' as const }
const GUEST = { id: 'guest', roles: [Role.Guest] }
const MEMBER = { id: 'member', roles: [Role.Member] }
const ADMIN = { id: 'admin', roles: [Role.CouncilAdmin] }
const IT = { id: 'it', roles: [Role.ITAdmin] }

beforeEach(() => {
  h.isMemberOf.mockReset().mockResolvedValue(false)
  h.getOrgUnitIdsForUser.mockReset().mockResolvedValue([])
})

describe('canSeeOrgUnit / canSeeProtocol (D-3)', () => {
  it('no session sees nothing', () => {
    expect(canSeeOrgUnit(null, OPEN, true)).toBe(false)
    expect(canSeeProtocol(undefined, OPEN, 'published', true)).toBe(false)
  })

  it('CouncilAdmin and ITAdmin (role hierarchy) see everything', () => {
    for (const v of [ADMIN, IT]) {
      expect(seesAllGovernance(v)).toBe(true)
      expect(canSeeOrgUnit(v, CLOSED, false)).toBe(true)
      expect(canSeeProtocol(v, CLOSED, 'draft', false)).toBe(true)
    }
  })

  it('a Guest sees only published protocols of all_members units, never a unit roster', () => {
    expect(canSeeOrgUnit(GUEST, OPEN, false)).toBe(false)
    expect(canSeeProtocol(GUEST, OPEN, 'published', false)).toBe(true)
    expect(canSeeProtocol(GUEST, OPEN, 'draft', false)).toBe(false)
    expect(canSeeProtocol(GUEST, OPEN, 'submitted', false)).toBe(false)
    expect(canSeeProtocol(GUEST, CLOSED, 'published', false)).toBe(false)
  })

  it('a Member sees all_members units in full and nothing of a foreign committee_only unit', () => {
    expect(canSeeOrgUnit(MEMBER, OPEN, false)).toBe(true)
    expect(canSeeProtocol(MEMBER, OPEN, 'draft', false)).toBe(true)
    expect(canSeeOrgUnit(MEMBER, CLOSED, false)).toBe(false)
    expect(canSeeProtocol(MEMBER, CLOSED, 'published', false)).toBe(false)
  })

  it('a unit member sees everything of their unit, whatever their realm role', () => {
    expect(canSeeOrgUnit(GUEST, CLOSED, true)).toBe(true)
    expect(canSeeProtocol(GUEST, CLOSED, 'draft', true)).toBe(true)
    expect(canSeeProtocol(MEMBER, CLOSED, 'draft', true)).toBe(true)
  })
})

describe('viewerCanSeeProtocol', () => {
  it('asks for membership only when it can change the answer', async () => {
    expect(await viewerCanSeeProtocol(MEMBER, 'u-open', OPEN, 'draft')).toBe(true)
    expect(await viewerCanSeeProtocol(ADMIN, 'u-closed', CLOSED, 'draft')).toBe(true)
    expect(h.isMemberOf).not.toHaveBeenCalled()
    h.isMemberOf.mockResolvedValueOnce(true)
    expect(await viewerCanSeeProtocol(MEMBER, 'u-closed', CLOSED, 'draft')).toBe(true)
    expect(h.isMemberOf).toHaveBeenCalledWith('u-closed', 'member')
    expect(await viewerCanSeeProtocol(MEMBER, 'u-closed', CLOSED, 'draft')).toBe(false)
  })

  it('no session is refused without a query', async () => {
    expect(await viewerCanSeeProtocol(null, 'u-open', OPEN, 'published')).toBe(false)
    expect(h.isMemberOf).not.toHaveBeenCalled()
  })
})

describe('row filters', () => {
  const rows = [
    { id: 'c-draft', committeeId: 'u-closed', visibility: 'committee_only' as const, status: 'draft' as const },
    { id: 'c-pub', committeeId: 'u-closed', visibility: 'committee_only' as const, status: 'published' as const },
    { id: 'o-draft', committeeId: 'u-open', visibility: 'all_members' as const, status: 'draft' as const },
    { id: 'o-pub', committeeId: 'u-open', visibility: 'all_members' as const, status: 'published' as const },
  ]
  const ids = (xs: Array<{ id: string }>) => xs.map((x) => x.id)

  it('filterVisibleProtocols applies D-3 per role with at most one membership query', async () => {
    expect(ids(await filterVisibleProtocols(GUEST, rows))).toEqual(['o-pub'])
    expect(ids(await filterVisibleProtocols(MEMBER, rows))).toEqual(['o-draft', 'o-pub'])
    expect(ids(await filterVisibleProtocols(ADMIN, rows))).toEqual(['c-draft', 'c-pub', 'o-draft', 'o-pub'])
    expect(ids(await filterVisibleProtocols(null, rows))).toEqual([])
    h.getOrgUnitIdsForUser.mockReset().mockResolvedValue(['u-closed'])
    expect(ids(await filterVisibleProtocols(MEMBER, rows))).toEqual(['c-draft', 'c-pub', 'o-draft', 'o-pub'])
    expect(h.getOrgUnitIdsForUser).toHaveBeenCalledTimes(1)
  })

  it('an admin needs no membership query', async () => {
    await filterVisibleProtocols(ADMIN, rows)
    expect(h.getOrgUnitIdsForUser).not.toHaveBeenCalled()
  })

  it('filterVisiblePublished treats every row as published', async () => {
    const pub = [
      { id: 'c', committeeId: 'u-closed', visibility: 'committee_only' as const },
      { id: 'o', committeeId: 'u-open', visibility: 'all_members' as const },
    ]
    expect(ids(await filterVisiblePublished(GUEST, pub))).toEqual(['o'])
    h.getOrgUnitIdsForUser.mockResolvedValue(['u-closed'])
    expect(ids(await filterVisiblePublished(GUEST, pub))).toEqual(['c', 'o'])
  })

  it('the fail-closed fallbacks keep only rows that need no membership', () => {
    expect(ids(visibleProtocolsWithoutMembership(MEMBER, rows))).toEqual(['o-draft', 'o-pub'])
    expect(ids(visibleProtocolsWithoutMembership(GUEST, rows))).toEqual(['o-pub'])
    expect(ids(visiblePublishedWithoutMembership(MEMBER, rows))).toEqual(['o-draft', 'o-pub'])
  })
})
