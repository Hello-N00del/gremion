import { describe, test, expect, vi } from 'vitest'

// The "Dein Gremium" dot and the "Nur meine" toggle mark the bodies the viewer belongs to.
// That is the roster plus live offices (the set the dashboard counts), so a Vorstand office
// holder without a roster row still sees the body marked as theirs.
const VORSTAND = 'ou-vorstand'
const OTHER = 'ou-haushalt'

const getOrgUnitIdsWithOfficesForUser = vi.fn<(id: string) => Promise<readonly string[]>>()
vi.mock('$lib/server/governance/org-units-db', () => ({
  listOrgUnits: async () => [
    { id: VORSTAND, name: 'Vorstand' },
    { id: OTHER, name: 'Haushaltsausschuss' },
  ],
  // The office holder has no roster row: the roster-only lookup answers nothing.
  getOrgUnitIdsForUser: async () => [],
  getOrgUnitIdsWithOfficesForUser: (id: string) => getOrgUnitIdsWithOfficesForUser(id),
}))
vi.mock('$lib/server/calendar/backend/resolve', () => ({
  resolveCalendarBackendForPage: () => ({ listEventTypes: async () => [] }),
}))

import { load } from './+page.server'

function stub(user: { id: string } | null): Parameters<typeof load>[0] {
  return {
    locals: { auth: async () => (user ? { user } : null) },
  } as unknown as Parameters<typeof load>[0]
}

describe('calendar page: committees marked as mine', () => {
  test('an office holder without a roster row sees that body marked as theirs', async () => {
    getOrgUnitIdsWithOfficesForUser.mockResolvedValue([VORSTAND])
    const result = (await load(stub({ id: 'u-vorstand' }))) as { committees: Array<{ key: string; mine: boolean }> }
    expect(result.committees.map((c) => [c.key, c.mine])).toEqual([
      [VORSTAND, true],
      [OTHER, false],
    ])
  })

  test('a lookup failure degrades to nothing marked, not to an error page', async () => {
    getOrgUnitIdsWithOfficesForUser.mockRejectedValue(new Error('db down'))
    const result = (await load(stub({ id: 'u-vorstand' }))) as { committees: Array<{ mine: boolean }> }
    expect(result.committees.every((c) => !c.mine)).toBe(true)
  })

  test('an anonymous viewer has nothing marked and no lookup is made', async () => {
    getOrgUnitIdsWithOfficesForUser.mockClear()
    const result = (await load(stub(null))) as { committees: Array<{ mine: boolean }> }
    expect(result.committees.every((c) => !c.mine)).toBe(true)
    expect(getOrgUnitIdsWithOfficesForUser).not.toHaveBeenCalled()
  })
})
