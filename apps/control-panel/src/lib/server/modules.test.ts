// requestEvents: the events shown on the customer page. A create writes many lines and the cause of a failure
// is at the tail, so the page needs the NEWEST `limit` lines, oldest of those first.
import { describe, expect, it } from 'vitest'
import { requestEvents } from './modules'

describe('requestEvents', () => {
  it('takes the newest lines (descending read) and returns them oldest first', async () => {
    let sqlText = ''
    // what the database answers to "newest first, at most 3" over the lines 1..5
    const sql = (async (strings: TemplateStringsArray) => {
      sqlText = strings.join('?')
      return [5, 4, 3].map((n) => ({ level: 'info', step: 's', message: `line ${n}` }))
    }) as never
    const out = await requestEvents(sql, '0192f0c4-0000-7000-8000-0000000000aa', 3)
    expect(out.map((e) => e.message)).toEqual(['line 3', 'line 4', 'line 5'])
    expect(sqlText).toMatch(/ORDER BY at DESC, event_id DESC\s+LIMIT/)
  })
})
