// @vitest-environment node
// 'calendar:org-unit-refs': how many calendar events are tied to an org unit, read where the events
// really are. The kernel's committee delete asks it before it tears anything down.
import { describe, expect, it, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ listEvents: vi.fn() }))
vi.mock('./backend', () => ({ getCalendarBackend: () => ({ listEvents: h.listEvents }) }))

import { calendarRefsOfOrgUnit } from './org-unit-refs'

describe('calendarRefsOfOrgUnit', () => {
  beforeEach(() => { h.listEvents.mockReset() })

  it('counts the events of that unit over the whole calendar, not a window', async () => {
    h.listEvents.mockResolvedValue([{ id: 'e1' }, { id: 'e2' }, { id: 'e3' }])
    expect(await calendarRefsOfOrgUnit('ou-1')).toEqual({ referenced: true, counts: { events: 3 } })
    const filter = h.listEvents.mock.calls[0]![0] as { committeeId: string; from?: Date; to?: Date }
    expect(filter.committeeId).toBe('ou-1')
    // a past event still counts: asked with explicit bounds, the leaf cannot default to a window
    expect(filter.from?.getTime()).toBe(0)
    expect(filter.to?.getUTCFullYear()).toBeGreaterThanOrEqual(2099)
  })

  it('says not referenced for a unit without events', async () => {
    h.listEvents.mockResolvedValue([])
    expect(await calendarRefsOfOrgUnit('ou-2')).toEqual({ referenced: false, counts: { events: 0 } })
  })

  it('lets a failure through, never answering zero for it', async () => {
    h.listEvents.mockRejectedValue(new Error('leaf unreachable'))
    await expect(calendarRefsOfOrgUnit('ou-3')).rejects.toHaveProperty('message', 'leaf unreachable')
  })
})
