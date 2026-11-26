// A board id that is not a UUID names no board. The in-process store used to hand it to the
// driver, which rejects it (SQLSTATE 22P02) and the route answered 500. The mocked tagged-template
// client below rejects a non-UUID value exactly like the driver, so a missing guard shows up as a
// thrown driver error instead of a quiet "not found". The leaf service answers the same way
// (src/http/routes.ts tests its id against a UUID pattern first).
import { describe, it, expect, vi, beforeEach } from 'vitest'

const BOARD = '3f0c8a52-7d1e-4b8a-9c55-0a1b2c3d4e5f'

const h = vi.hoisted(() => ({
  queries: [] as unknown[][],
}))

vi.mock('$lib/server/db', () => ({
  getDb: () => {
    const sql = async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      h.queries.push(values)
      for (const v of values) {
        if (typeof v === 'string' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) {
          throw Object.assign(new Error('invalid input syntax for type uuid'), { code: '22P02' })
        }
      }
      return [{ id: values[0], org_unit_id: 'ou', name: 'Vorstand', archived: false }]
    }
    return sql
  },
}))

import { getBoard, deckFor } from './board-db'

beforeEach(() => {
  h.queries.length = 0
})

describe('board store: a malformed board id names no board', () => {
  it('getBoard answers null without querying', async () => {
    await expect(getBoard('not-a-uuid')).resolves.toBeNull()
    expect(h.queries).toEqual([])
  })

  it('getBoard still reads a well-formed id', async () => {
    await expect(getBoard(BOARD)).resolves.toMatchObject({ id: BOARD })
  })

  it('deckFor reports a missing board, not a driver error', async () => {
    await expect(deckFor('not-a-uuid')).rejects.toThrow('board not found')
  })
})
