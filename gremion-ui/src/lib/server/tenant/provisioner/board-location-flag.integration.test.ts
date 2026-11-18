// The create flow's board location flag against a real migrated kernel database (pnpm test:integration):
// the write itself, the refusals over rows and a running move, the lock that keeps an in-flight writer from
// landing a row behind the flag, and the first board request of the new customer reaching the board
// service (a stub) instead of the kernel tables.
import postgres from 'postgres'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getBoardBackend } from '$lib/server/board/backend'
import { getBoardLocation, resetBoardLocationCacheForTests } from '$lib/server/board/backend/location'
import { getDb } from '$lib/server/db'
import { createOrgUnit } from '$lib/server/governance/org-units-db'
import { setBoardLocationModule } from './board-location-flag'

const sql = () => getDb()

async function clean() {
  resetBoardLocationCacheForTests()
  await sql()`DELETE FROM board_location`
  await sql()`TRUNCATE card, stack, board RESTART IDENTITY CASCADE`
}
beforeEach(clean)
// leave nothing behind: a leftover `module` or `moving` row would redirect or refuse the next file's board access
afterAll(clean)
afterEach(() => vi.unstubAllGlobals())

async function orgUnitId(): Promise<string> {
  return (await createOrgUnit({ name: 'Rat', description: null, parentId: null, kind: 'council', visibility: 'all_members', wantsMatrixRoom: false, wantsNextcloudFolder: false })).id
}
const flag = async () => (await sql()<{ location: string; changed_at: Date }[]>`SELECT location, changed_at FROM board_location`)[0] ?? null

describe('setBoardLocationModule on a real kernel database', () => {
  it('a fresh customer (no row, empty board tables) is set to module, and the reader says module', async () => {
    expect(await setBoardLocationModule(sql())).toEqual({ changed: true })
    expect((await flag())?.location).toBe('module')
    resetBoardLocationCacheForTests()
    expect(await getBoardLocation()).toBe('module')
  })

  it('a kernel row is updated; a rerun changes nothing, not even changed_at', async () => {
    await sql()`INSERT INTO board_location (id, location) VALUES (true, 'kernel')`
    expect(await setBoardLocationModule(sql())).toEqual({ changed: true })
    const first = await flag()
    expect(first?.location).toBe('module')
    expect(await setBoardLocationModule(sql())).toEqual({ changed: false })
    expect((await flag())?.changed_at).toEqual(first?.changed_at)
  })

  it('refuses over a board with rows: the flag stays unset and the reader still says kernel', async () => {
    const org = await orgUnitId()
    await sql()`INSERT INTO board (org_unit_id, name) VALUES (${org}, 'Vorstand')`
    await expect(setBoardLocationModule(sql())).rejects.toMatchObject({ code: 'CUSTOMER_STATE' })
    expect(await flag()).toBeNull()
    resetBoardLocationCacheForTests()
    expect(await getBoardLocation()).toBe('kernel')
  })

  it('refuses while a move is running and leaves the row as the move wrote it', async () => {
    await sql()`INSERT INTO board_location (id, location) VALUES (true, 'moving')`
    await expect(setBoardLocationModule(sql())).rejects.toMatchObject({ code: 'CUSTOMER_STATE' })
    expect((await flag())?.location).toBe('moving')
  })

  it('works as a role that holds DML on the four tables and nothing more (not a superuser, not the owner)', async () => {
    const role = 'bd7_flag_app'
    const tables = 'board, stack, card, board_location'
    await sql().unsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF; END $$`)
    await sql().unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${tables} TO ${role}`)
    // the startup option makes every statement of this connection run as the role (privileges are checked against current_user)
    const asRole = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {}, connection: { options: `-c role=${role}` } })
    try {
      const [who] = await asRole<{ u: string; super: boolean }[]>`SELECT current_user AS u, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS super`
      expect(who).toEqual({ u: role, super: false })
      expect(await setBoardLocationModule(asRole)).toEqual({ changed: true })
      expect((await flag())?.location).toBe('module')
    } finally {
      await asRole.end({ timeout: 5 })
      await sql().unsafe(`REVOKE ALL ON ${tables} FROM ${role}`)
      await sql().unsafe(`DROP ROLE ${role}`)
    }
  })

  it('a writer still in flight cannot land a row behind the flag: the call waits for its tables and fails on the lock timeout', async () => {
    const org = await orgUnitId()
    // a second connection to the same database: an uncommitted insert into board, the way the kernel erasure hook or a cascade would be mid-transaction
    const writer = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} })
    try {
      const open = writer.begin(async (tx) => {
        await tx`INSERT INTO board (org_unit_id, name) VALUES (${org}, 'Spaeter')`
        // the flag call runs now and must not get past its lock while this transaction holds the table
        const err = await setBoardLocationModule(sql()).then(() => null, (e: { code?: string }) => e)
        expect(err).toMatchObject({ code: '55P03' }) // lock_not_available after the 5 s timeout
        expect(await flag()).toBeNull()
      })
      await open
    } finally {
      await writer.end({ timeout: 5 })
    }
    // the writer committed: its row is there, and a rerun now refuses over it instead of hiding it
    await expect(setBoardLocationModule(sql())).rejects.toMatchObject({ code: 'CUSTOMER_STATE' })
    expect(await flag()).toBeNull()
  }, 30_000)
})

describe('the first board request of a customer flagged module', () => {
  it('reaches the board service (a stub), and a customer with no row still reads the kernel tables', async () => {
    vi.stubEnv('BOARD_BACKEND', 'auto')
    vi.stubEnv('BOARD_SERVICE_URL', 'http://board-service.invalid:8080')
    vi.stubEnv('INTERNAL_BOARD_SECRET', 'unit-test-secret-not-real')
    const stub = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', stub)
    const org = await orgUnitId()

    // no row: the kernel tables serve it, the service is never called
    expect(await getBoardBackend().listBoardsForOrgUnits([org])).toEqual([])
    expect(stub).not.toHaveBeenCalled()

    await setBoardLocationModule(sql())
    resetBoardLocationCacheForTests()
    expect(await getBoardBackend().listBoardsForOrgUnits([org])).toEqual([])
    expect(stub).toHaveBeenCalledTimes(1)
    const [url, init] = stub.mock.calls[0] as unknown as [string, { headers: Record<string, string> }]
    expect(url.startsWith('http://board-service.invalid:8080/')).toBe(true)
    expect(init.headers['x-internal-auth']).toBe('unit-test-secret-not-real')
  })
})
