// @vitest-environment node
//
// Module Karenz (phase 2, Task 14): the two table writes of the elections participant. They touch only the
// given Helios uuids, only rows in the right archive state, and say how many rows they changed.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ calls: [] as Array<{ text: string; values: unknown[] }>, count: 0 }))
vi.mock('../db', () => ({
  getDb: () => (strings: TemplateStringsArray, ...values: unknown[]) => {
    h.calls.push({ text: strings.join('?').replace(/\s+/g, ' ').trim(), values })
    return Promise.resolve({ count: h.count })
  },
}))

import { ElectionDb } from './election-db'

beforeEach(() => {
  h.calls.length = 0
  h.count = 0
})

describe('ElectionDb Karenz writes', () => {
  it('archiveForKarenz archives only the given, not yet archived uuids and returns the row count', async () => {
    h.count = 2
    expect(await ElectionDb.archiveForKarenz(['a', 'b'])).toBe(2)
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]!.text).toMatch(/UPDATE committee_elections SET archived_at = now\(\) WHERE helios_uuid = ANY\(\?::text\[\]\) AND archived_at IS NULL/)
    expect(h.calls[0]!.text).not.toMatch(/DELETE/i)
    expect(h.calls[0]!.values).toEqual([['a', 'b']])
  })

  it('unarchiveForKarenz clears archived_at only for the given, archived uuids', async () => {
    h.count = 1
    expect(await ElectionDb.unarchiveForKarenz(['a'])).toBe(1)
    expect(h.calls[0]!.text).toMatch(/SET archived_at = NULL WHERE helios_uuid = ANY\(\?::text\[\]\) AND archived_at IS NOT NULL/)
    expect(h.calls[0]!.values).toEqual([['a']])
  })

  it('an empty list touches nothing', async () => {
    expect(await ElectionDb.archiveForKarenz([])).toBe(0)
    expect(await ElectionDb.unarchiveForKarenz([])).toBe(0)
    expect(h.calls).toEqual([])
  })
})
