// An event or event-type id that is not a UUID names nothing. The in-process store used to hand it
// to the driver, which rejects it (SQLSTATE 22P02) and the route answered 500. The mocked client
// rejects a non-UUID value exactly like the driver does, so a missing guard shows up as a thrown
// driver error instead of a quiet "not found".
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ queries: [] as unknown[][] }))

vi.mock('$lib/server/db', () => ({
  getDb: () => {
    const sql = async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      h.queries.push(values)
      for (const v of values) {
        if (typeof v === 'string' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) {
          throw Object.assign(new Error('invalid input syntax for type uuid'), { code: '22P02' })
        }
      }
      return []
    }
    return sql
  },
}))
vi.mock('$lib/server/config', () => ({ readConfig: () => ({}) }))

import { getEvent, getEventType, deleteEventType } from './calendar-db'

beforeEach(() => {
  h.queries.length = 0
})

describe('calendar store: a malformed id names nothing', () => {
  it('getEvent answers null without querying', async () => {
    await expect(getEvent('not-a-uuid')).resolves.toBeNull()
    expect(h.queries).toEqual([])
  })

  it('getEventType answers null without querying', async () => {
    await expect(getEventType('not-a-uuid')).resolves.toBeNull()
    expect(h.queries).toEqual([])
  })

  it('deleteEventType reports not found, not a driver error', async () => {
    await expect(deleteEventType('not-a-uuid')).rejects.toThrow('Event type not found')
  })

  it('a well-formed id still reaches the store', async () => {
    await expect(getEvent('3f0c8a52-7d1e-4b8a-9c55-0a1b2c3d4e5f')).resolves.toBeNull()
    expect(h.queries.length).toBe(1)
  })
})
