// The create flow's one write to the board location flag (board-location-flag.ts), over a recording
// stand-in for the customer's kernel connection. What the SQL does on a real database is proven in
// board-location-flag.integration.test.ts; this file pins the ORDER and the refusals:
//   - the three board tables are locked BEFORE they are counted, in one transaction, so a writer that
//     is still in flight cannot add a row after the count and hide behind the flag;
//   - a flag that already says `module` is left alone without a lock or a write;
//   - rows, a running move or a flag that does not read back as `module` are refusals, never a quiet pass;
//   - every message carries counts only.
import { describe, expect, it } from 'vitest'
import { setBoardLocationModule } from './board-location-flag'

interface Model {
  location: 'kernel' | 'moving' | 'module' | null
  counts: { board: number; stack: number; card: number }
  /** what the read-back after the commit sees (default: what was written) */
  readBack?: string
  /** the upsert matched no row (the row changed between the read and the lock) */
  upsertMissed?: boolean
}

function fakeSql(m: Model, log: string[]) {
  let written: string | null = null
  let reads = 0
  const run = async (strings: TemplateStringsArray): Promise<unknown[]> => {
    const text = strings.join('?').replace(/\s+/g, ' ').trim()
    log.push(text)
    if (text.startsWith('SELECT location FROM board_location')) {
      // the first read is the caller's own; every later one is a re-read or the read-back
      const seen = reads++ === 0 ? m.location : (m.readBack ?? written ?? m.location)
      return seen === null ? [] : [{ location: seen }]
    }
    if (/count\(\*\)/.test(text)) return [{ board: String(m.counts.board), stack: String(m.counts.stack), card: String(m.counts.card) }]
    if (text.startsWith('INSERT INTO board_location')) {
      if (m.upsertMissed) return []
      written = 'module'
      return [{ location: 'module' }]
    }
    return []
  }
  const sql = Object.assign((strings: TemplateStringsArray) => run(strings), {
    begin: async (fn: (tx: unknown) => Promise<unknown>) => {
      log.push('BEGIN')
      const out = await fn((strings: TemplateStringsArray) => run(strings))
      log.push('COMMIT')
      return out
    },
  })
  return sql as never
}

const EMPTY = { board: 0, stack: 0, card: 0 }

describe('setBoardLocationModule', () => {
  it('locks the three board tables before it counts them, then writes the flag in the same transaction', async () => {
    const log: string[] = []
    const r = await setBoardLocationModule(fakeSql({ location: null, counts: EMPTY }, log))
    expect(r).toEqual({ changed: true })
    const at = (re: RegExp) => log.findIndex((l) => re.test(l))
    expect(at(/^BEGIN$/)).toBeGreaterThan(-1)
    expect(at(/^SET LOCAL lock_timeout/)).toBeGreaterThan(at(/^BEGIN$/))
    expect(at(/^LOCK TABLE board, stack, card IN SHARE ROW EXCLUSIVE MODE$/)).toBeGreaterThan(at(/^SET LOCAL lock_timeout/))
    expect(at(/count\(\*\)/)).toBeGreaterThan(at(/^LOCK TABLE/))
    expect(at(/^INSERT INTO board_location/)).toBeGreaterThan(at(/count\(\*\)/))
    expect(at(/^COMMIT$/)).toBeGreaterThan(at(/^INSERT INTO board_location/))
  })

  it('writes `module` over a kernel row and reads the result back', async () => {
    const log: string[] = []
    expect(await setBoardLocationModule(fakeSql({ location: 'kernel', counts: EMPTY }, log))).toEqual({ changed: true })
    expect(log.filter((l) => l.startsWith('SELECT location FROM board_location')).length).toBeGreaterThanOrEqual(2) // before and after
  })

  it('a flag that already says module is not touched: no transaction, no lock, no write', async () => {
    const log: string[] = []
    expect(await setBoardLocationModule(fakeSql({ location: 'module', counts: { board: 3, stack: 9, card: 40 } }, log))).toEqual({ changed: false })
    expect(log.some((l) => /BEGIN|LOCK|INSERT|UPDATE/.test(l))).toBe(false)
  })

  it('refuses while a move is running, without a lock or a write', async () => {
    const log: string[] = []
    await expect(setBoardLocationModule(fakeSql({ location: 'moving', counts: EMPTY }, log))).rejects.toMatchObject({ code: 'CUSTOMER_STATE' })
    expect(log.some((l) => /BEGIN|LOCK|INSERT/.test(l))).toBe(false)
  })

  it.each([
    ['a board', { board: 1, stack: 0, card: 0 }],
    ['a stack', { board: 0, stack: 2, card: 0 }],
    ['a card', { board: 0, stack: 0, card: 7 }],
  ])('refuses over %s in the kernel tables: the rows are carried by the move, never hidden behind the flag', async (_n, counts) => {
    const log: string[] = []
    await expect(setBoardLocationModule(fakeSql({ location: 'kernel', counts }, log))).rejects.toMatchObject({ code: 'CUSTOMER_STATE' })
    expect(log.some((l) => l.startsWith('INSERT INTO board_location'))).toBe(false)
    expect(log).not.toContain('COMMIT')
  })

  it('names the counts and nothing else', async () => {
    const err = await setBoardLocationModule(fakeSql({ location: 'kernel', counts: { board: 2, stack: 5, card: 11 } }, [])).then(() => null, (e: Error) => e)
    expect(err?.message).toMatch(/2 board/)
    expect(err?.message).toMatch(/5 stack/)
    expect(err?.message).toMatch(/11 card/)
  })

  it('a flag that changed between the read and the lock is re-read: `module` is a no-op, anything else a refusal', async () => {
    await expect(setBoardLocationModule(fakeSql({ location: 'kernel', counts: EMPTY, upsertMissed: true, readBack: 'module' }, []))).resolves.toEqual({ changed: false })
    await expect(setBoardLocationModule(fakeSql({ location: 'kernel', counts: EMPTY, upsertMissed: true, readBack: 'moving' }, []))).rejects.toMatchObject({ code: 'CUSTOMER_STATE' })
  })

  it('a flag that does not read back as module after the commit is a failure, not a success', async () => {
    await expect(setBoardLocationModule(fakeSql({ location: null, counts: EMPTY, readBack: 'kernel' }, []))).rejects.toMatchObject({ code: 'POSTCONDITION' })
  })
})
