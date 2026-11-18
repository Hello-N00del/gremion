// The location flag against a real migrated database (pnpm test:integration, throwaway Postgres):
// the table of migration 0066, its constraints, the reader's 5 second cache and its database-clock
// rule for a stale 'moving', and the router over the real kernel tables.
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { getDb } from '../db'
import { createOrgUnit } from '../governance/org-units-db'
import { getBoardBackend } from './backend'
import { getBoardLocation, resetBoardLocationCacheForTests, BoardMovingError } from './backend/location'

const sql = () => getDb()

async function setFlag(location: 'kernel' | 'moving' | 'module', ageSeconds = 0) {
  await sql()`
    INSERT INTO board_location (id, location, changed_at)
    VALUES (true, ${location}, now() - make_interval(secs => ${ageSeconds}))
    ON CONFLICT (id) DO UPDATE SET location = EXCLUDED.location, changed_at = EXCLUDED.changed_at`
}

// The integration database is shared by every file of the suite: leave no flag row behind, a
// leftover 'moving' row would refuse the next file's board writes.
afterAll(async () => {
  resetBoardLocationCacheForTests()
  await sql()`DELETE FROM board_location`
  await sql()`TRUNCATE card, stack, board RESTART IDENTITY CASCADE`
})

beforeEach(async () => {
  resetBoardLocationCacheForTests()
  await sql()`DELETE FROM board_location`
  await sql()`TRUNCATE card, stack, board RESTART IDENTITY CASCADE`
})

describe('board_location (migration 0066)', () => {
  it('starts with no row, which reads as kernel', async () => {
    expect(Number((await sql()<{ n: string }[]>`SELECT count(*)::text AS n FROM board_location`)[0]!.n)).toBe(0)
    expect(await getBoardLocation()).toBe('kernel')
  })

  it('refuses a second row', async () => {
    await sql()`INSERT INTO board_location DEFAULT VALUES`
    await expect(sql()`INSERT INTO board_location (id) VALUES (true)`).rejects.toMatchObject({ code: '23505' })
    await expect(sql()`INSERT INTO board_location (id) VALUES (false)`).rejects.toMatchObject({ code: '23514' })
  })

  it('refuses a location that is not kernel, moving or module', async () => {
    await sql()`INSERT INTO board_location DEFAULT VALUES`
    await expect(sql()`UPDATE board_location SET location = 'elsewhere'`).rejects.toMatchObject({ code: '23514' })
  })

  it('keeps the counts and fingerprints of a move as an object, and nothing else', async () => {
    await sql()`INSERT INTO board_location DEFAULT VALUES`
    const state = { counts: { board: 1, stack: 3, card: 9 }, fingerprints: { board: 'd41d8cd98f00b204e9800998ecf8427e' } }
    await sql()`UPDATE board_location SET location = 'module', moved_state = ${sql().json(state)}`
    const [row] = await sql()<{ moved_state: unknown }[]>`SELECT moved_state FROM board_location`
    expect(row!.moved_state).toEqual(state)
    await expect(sql()`UPDATE board_location SET moved_state = '[1]'::jsonb`).rejects.toMatchObject({ code: '23514' })
    await expect(sql()`UPDATE board_location SET moved_state = '"x"'::jsonb`).rejects.toMatchObject({ code: '23514' })
  })
})

describe('getBoardLocation over the real table', () => {
  it.each(['kernel', 'module'] as const)('reads %s', async (loc) => {
    await setFlag(loc)
    expect(await getBoardLocation()).toBe(loc)
  })

  it('a fresh moving row is moving; one past 300 seconds on the DATABASE clock is kernel', async () => {
    await setFlag('moving', 100)
    expect(await getBoardLocation()).toBe('moving')
    resetBoardLocationCacheForTests()
    await setFlag('moving', 301)
    expect(await getBoardLocation()).toBe('kernel')
  })

  it('a read is held for the cache window: a flip written meanwhile is seen only after it', async () => {
    await setFlag('kernel')
    expect(await getBoardLocation()).toBe('kernel')
    await setFlag('module')
    expect(await getBoardLocation()).toBe('kernel') // within 5 seconds
    resetBoardLocationCacheForTests() // stands for the 5 seconds having passed
    expect(await getBoardLocation()).toBe('module')
  })
})

describe('the router over the real kernel tables', () => {
  async function anOrgUnit() {
    return createOrgUnit({
      name: 'StuRa',
      description: null,
      parentId: null,
      kind: 'council',
      visibility: 'all_members',
      wantsMatrixRoom: false,
      wantsNextcloudFolder: false,
      childTerm: null,
    })
  }

  it('kernel: creates and reads a board in the kernel tables', async () => {
    const ou = await anOrgUnit()
    const backend = getBoardBackend()
    expect(backend.kind).toBe('routed')
    const { board } = await backend.createBoard({ orgUnitId: ou.id, name: 'Plenum', stacks: ['Offen', 'Erledigt'] })
    expect((await backend.deckFor(board.id)).stacks).toHaveLength(2)
    expect(Number((await sql()<{ n: string }[]>`SELECT count(*)::text AS n FROM board`)[0]!.n)).toBe(1)
  })

  it('moving: reads work and a write is refused, leaving the kernel tables as they were', async () => {
    const ou = await anOrgUnit()
    const backend = getBoardBackend()
    const { board } = await backend.createBoard({ orgUnitId: ou.id, name: 'Plenum', stacks: ['Offen'] })
    const deck = await backend.deckFor(board.id)

    await setFlag('moving', 1)
    resetBoardLocationCacheForTests()
    expect((await backend.deckFor(board.id)).board.id).toBe(board.id)
    await expect(backend.createCard({ stackId: deck.stacks[0]!.id, title: 'Neu' })).rejects.toBeInstanceOf(BoardMovingError)
    expect(Number((await sql()<{ n: string }[]>`SELECT count(*)::text AS n FROM card`)[0]!.n)).toBe(0)
  })

  it('the forced in-process client ignores the flag, as an older copy of the app does', async () => {
    const ou = await anOrgUnit()
    await setFlag('moving', 1)
    const previous = process.env.BOARD_BACKEND
    process.env.BOARD_BACKEND = 'inprocess'
    try {
      const { board } = await getBoardBackend().createBoard({ orgUnitId: ou.id, name: 'Plenum' })
      expect(board.name).toBe('Plenum')
    } finally {
      if (previous === undefined) delete process.env.BOARD_BACKEND
      else process.env.BOARD_BACKEND = previous
    }
  })
})
