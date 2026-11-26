// Leaf service twin of the in-process guard: an event or event-type id that is not a UUID names
// nothing, so the store answers null (the routes turn that into 404) instead of letting the
// driver reject it (SQLSTATE 22P02, a 500). The fake client rejects a non-UUID like the driver.
import { describe, it, expect } from 'vitest'
import { getEvent } from '../src/store/events.js'
import { getEventType, deleteEventType } from '../src/store/event-types.js'
import type { Sql } from '../src/tenant-store.js'

function fakeSql() {
  const queries: unknown[][] = []
  const sql = (async (_strings: TemplateStringsArray, ...values: unknown[]) => {
    queries.push(values)
    for (const v of values) {
      if (typeof v === 'string' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) {
        throw Object.assign(new Error('invalid input syntax for type uuid'), { code: '22P02' })
      }
    }
    return []
  }) as unknown as Sql
  return { sql, queries }
}

describe('calendar leaf store: a malformed id names nothing', () => {
  it('getEvent answers null without querying', async () => {
    const { sql, queries } = fakeSql()
    await expect(getEvent(sql, 'not-a-uuid')).resolves.toBeNull()
    expect(queries).toEqual([])
  })

  it('getEventType answers null without querying', async () => {
    const { sql, queries } = fakeSql()
    await expect(getEventType(sql, 'not-a-uuid')).resolves.toBeNull()
    expect(queries).toEqual([])
  })

  it('deleteEventType reports not found, not a driver error', async () => {
    const { sql } = fakeSql()
    await expect(deleteEventType(sql, 'not-a-uuid')).rejects.toThrow('Event type not found')
  })
})
