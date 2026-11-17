import { describe, test, expect, vi, beforeEach } from 'vitest'
import { Role } from '$lib/auth'
import {
  registerDataProvider,
  _resetRuntimeRegistryForTests,
  type UpcomingEventRow,
} from '$lib/server/modules/runtime-registry'

// The dashboard tile "In meinen Gremien" counts the upcoming events that sit in a body
// the viewer belongs to. A Vorstand member showed 0:
//  1. "belongs to" read org_unit_members only, so a body the person holds an office in
//     (role_assignments, independent of the roster) never counted;
//  2. the count ran over the six-row preview list, not over every event in the window.
// Memberships stay the authz source (getOrgUnitIdsForUser); the dashboard uses the
// display-only union of membership and live office (getOrgUnitIdsWithOfficesForUser).
const getOrgUnitIdsForUser = vi.fn<(id: string) => Promise<readonly string[]>>()
const getOrgUnitIdsWithOfficesForUser = vi.fn<(id: string) => Promise<readonly string[]>>()
vi.mock('$lib/server/governance/org-units-db', () => ({
  getOrgUnitIdsForUser: (id: string) => getOrgUnitIdsForUser(id),
  getOrgUnitIdsWithOfficesForUser: (id: string) => getOrgUnitIdsWithOfficesForUser(id),
}))

import { load } from './+page.server'

type LoadResult = {
  unplaced?: boolean
  myEventCount: number
  upcomingCount: number
  upcomingEvents: Array<{ id: string; mine: boolean }>
}

const VORSTAND = 'ou-vorstand'
const OTHER = 'ou-haushalt'

function eventStub(opts: { roles: Role[]; groups?: string[] }): Parameters<typeof load>[0] {
  return {
    locals: {
      auth: async () => ({
        user: { id: 'u-vorstand', name: 'Vera Vorstand', email: 'v@example.com', roles: opts.roles, groups: opts.groups ?? [] },
        expires: '2099-01-01T00:00:00.000Z',
      }),
      user: { id: 'u-vorstand', roles: opts.roles },
    },
    fetch: async () => ({ ok: true, json: async () => ({ data: [] }) }),
    parent: async () => ({}),
  } as unknown as Parameters<typeof load>[0]
}

function event(n: number, committeeIds: string[]): UpcomingEventRow {
  return {
    id: `ev-${n}`,
    startAt: new Date(Date.now() + n * 3_600_000),
    title: `Sitzung ${n}`,
    location: null,
    committeeIds,
  }
}

beforeEach(() => {
  getOrgUnitIdsForUser.mockReset()
  getOrgUnitIdsWithOfficesForUser.mockReset()
  getOrgUnitIdsForUser.mockResolvedValue([])
  _resetRuntimeRegistryForTests()
})

describe('dashboard load — bodies counted as "mine"', () => {
  test('a Vorstand member who holds an office but has no roster row counts that body', async () => {
    getOrgUnitIdsForUser.mockResolvedValue([])
    getOrgUnitIdsWithOfficesForUser.mockResolvedValue([VORSTAND])
    registerDataProvider('calendar:upcoming-events', async () => [event(1, [VORSTAND]), event(2, [OTHER])])

    const result = (await load(eventStub({ roles: [Role.Member], groups: ['mitglied'] }))) as LoadResult

    expect(result.upcomingEvents.map((e) => [e.id, e.mine])).toEqual([['ev-1', true], ['ev-2', false]])
    expect(result.myEventCount).toBe(1)
  })

  test('a plain roster member is still counted (office lookup returns the union)', async () => {
    getOrgUnitIdsForUser.mockResolvedValue([VORSTAND])
    getOrgUnitIdsWithOfficesForUser.mockResolvedValue([VORSTAND])
    registerDataProvider('calendar:upcoming-events', async () => [event(1, [VORSTAND]), event(2, [OTHER, VORSTAND])])

    const result = (await load(eventStub({ roles: [Role.Member], groups: ['mitglied'] }))) as LoadResult

    expect(result.myEventCount).toBe(2)
  })

  test('the tile counts every event in the window, not only the six shown in the list', async () => {
    getOrgUnitIdsWithOfficesForUser.mockResolvedValue([VORSTAND])
    // Six earlier events of another body push the Vorstand events past the preview cut.
    const rows = [...[1, 2, 3, 4, 5, 6].map((n) => event(n, [OTHER])), event(7, [VORSTAND]), event(8, [VORSTAND])]
    registerDataProvider('calendar:upcoming-events', async () => rows)

    const result = (await load(eventStub({ roles: [Role.Member], groups: ['mitglied'] }))) as LoadResult

    expect(result.upcomingEvents).toHaveLength(6)
    expect(result.upcomingCount).toBe(8)
    expect(result.myEventCount).toBe(2)
  })

  test('a lookup failure degrades to zero, not to an error page', async () => {
    getOrgUnitIdsWithOfficesForUser.mockRejectedValue(new Error('db down'))
    registerDataProvider('calendar:upcoming-events', async () => [event(1, [VORSTAND])])

    const result = (await load(eventStub({ roles: [Role.Member], groups: ['mitglied'] }))) as LoadResult

    expect(result.myEventCount).toBe(0)
  })

  test('a guest who only holds an office is placed, not shown the unplaced card', async () => {
    getOrgUnitIdsWithOfficesForUser.mockResolvedValue([VORSTAND])
    registerDataProvider('calendar:upcoming-events', async () => [])

    const result = (await load(eventStub({ roles: [Role.Guest], groups: [] }))) as LoadResult

    expect(result.unplaced).not.toBe(true)
  })
})
