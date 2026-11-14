/**
 * Cross-customer isolation of the in-process board, on REAL PostgreSQL.
 *
 * This is the isolation:tenant case of the `board` module (proofKind
 * real-pg-app). The pilot serves the board in-process from the kernel's own
 * per-customer database, so the proof runs the code the pilot runs: the real
 * route handlers (/api/board and below, and the /tasks load), the real
 * scope resolver, the real board-db, the real getDb() and the real per-tenant
 * pool registry. Nothing between the handler and the database is mocked. Only
 * the display-name lookup (a Keycloak call) is replaced, because it is not data
 * access.
 *
 * Two customers, A and B, each own a PHYSICALLY separate database (the kernel
 * migration chain applied to both). A request is made as customer A by running
 * the handler inside runWithTenant(A's context), exactly as the request hook
 * does. What B owns must be invisible and untouchable from there, and the proof
 * that nothing changed does not rely on the code under test: the fixtures are
 * written, and the "did anything change" fingerprints are read, over separate
 * administrative connections to each database.
 *
 * Vectors (the board leaf's own case, modules/board/test/isolation/case.ts,
 * mapped to the kernel routes):
 *   1 list           GET /api/board                       B's board is not listed
 *   2 read           GET /api/board/{B's board}           404
 *   3 deck           the same route                       B's stacks and cards are not served
 *   4 oracle         promoted-id lookup                   B's promoted item is not reported
 *   5 card create    POST /api/board/{id}/cards           404 on B's board, 404 for B's stack
 *   6 card move      PATCH /api/board/{id}/cards          404 for B's card or B's stack
 *   6 card edit      the same route, no stackId           404 for B's card; B's member is not assignable
 *   7 promote        POST /api/board/{id}/promote         404 for B's item or B's board
 *   8 stack create   the port (the kernel has no route)   rejected, nothing written to B
 *   9 board create   POST /api/board with B's org unit    403 (scope), nothing written to B
 *   H fingerprint    B's board, stacks and cards are byte-identical after every attempt
 *
 * Why it can fail: replace getDb() by a shared pool (the mutation this file is
 * judged by) and the positive controls, the physical-database checks and the
 * 404 expectations all go red.
 *
 * The throwaway server is ISOLATION_TENANT_PG_URL when the isolation producer
 * runs this file (loopback, a port other than 5432). Otherwise it is the server
 * of DATABASE_URL, which the integration harness has already judged safe
 * (assert-safe-test-db-url). Every database this file creates is named
 * board_iso_test_*, and only those are ever dropped.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import type { Sql } from '@gremion/db'
import { isHttpError } from '@sveltejs/kit'
import { assertNonProductionDbUrl } from '../../../../tests/integration/assert-safe-test-db-url'
import { runWithTenant, type TenantContext } from '$lib/server/tenant/context'
import { getDb } from '$lib/server/db'
import { evictTenantPool, getPoolForTenant } from '$lib/server/db/pool-registry'
import { GET as listBoards, POST as createBoard } from '../../../routes/api/board/+server'
import { GET as readBoard } from '../../../routes/api/board/[id]/+server'
import { POST as createCard, PATCH as moveCard } from '../../../routes/api/board/[id]/cards/+server'
import { GET as promotable } from '../../../routes/api/board/[id]/promotable/+server'
import { POST as promote } from '../../../routes/api/board/[id]/promote/+server'
import { load as tasksLoad } from '../../../routes/tasks/+page.server'
import { getBoardBackend } from './backend'

// Guard at import like every harness that creates or drops a database; the isolation suite derives DATABASE_URL from the throwaway server.
assertNonProductionDbUrl(process.env.DATABASE_URL ?? '', 'DATABASE_URL')

// The display-name lookup asks Keycloak: not data access, and out of scope here.
vi.mock('$lib/server/identity/display-names', () => ({
  getDisplayNameResolver: () => ({ resolveMany: async () => new Map<string, string>() }),
}))

type Who = 'A' | 'B'

const UI_ROOT = path.resolve(__dirname, '..', '..', '..', '..')
const MIGRATIONS = path.join(UI_ROOT, 'migrations')
const READER_ROLE = 'gremion_public_reader'
const RUN = `${process.pid}_${Math.random().toString(36).slice(2, 8)}`
const DB_NAME: Record<Who, string> = { A: `board_iso_test_a_${RUN}`, B: `board_iso_test_b_${RUN}` }
const STACKS = ['Offen', 'In Arbeit', 'Erledigt']

// == the throwaway server

function serverUrl(): URL {
  const explicit = process.env.ISOLATION_TENANT_PG_URL
  if (explicit) {
    const u = new URL(explicit)
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
      throw new Error('[board-isolation] ISOLATION_TENANT_PG_URL must be loopback: refusing to run')
    }
    if (u.port === '' || u.port === '5432') {
      throw new Error('[board-isolation] ISOLATION_TENANT_PG_URL must not use port 5432 (the live server): refusing to run')
    }
    return u
  }
  // The integration harness guarded DATABASE_URL at config load (GREMION_PRODUCTION_STACK).
  const fallback = process.env.DATABASE_URL ?? ''
  assertNonProductionDbUrl(fallback, 'DATABASE_URL')
  return new URL(fallback)
}

function urlFor(db: string): string {
  const u = serverUrl()
  u.pathname = `/${db}`
  const url = u.toString()
  assertNonProductionDbUrl(url, `database ${db}`)
  return url
}

// == fixtures, written and read over administrative connections

interface Seed {
  ouId: string
  emptyOuId: string
  userId: string
  boardId: string
  stackIds: string[]
  cardId: string
  cardTitle: string
  boardName: string
  protocolId: string
  actionItemId: string
  promotedActionItemId: string
}

const created: string[] = []
let adminServer: Sql
let createdRole = false
const admin = {} as Record<Who, Sql>
const ctx = {} as Record<Who, TenantContext>
const seed = {} as Record<Who, Seed>

function kernelChain(): Array<{ name: string; text: string }> {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('_seed.sql'))
    .sort()
    .map((name) => ({ name, text: readFileSync(path.join(MIGRATIONS, name), 'utf8') }))
}

/**
 * 0058 requires the portal's read role, and 0008 grants CONNECT on a database
 * literally named `gremion` when the role already exists. The throwaway server
 * has no such database, so every database is migrated up to 0057 first, the role
 * is created next, and the rest of the chain follows: 0008 then skips its grant
 * (as it does on any role-less database) and 0058 binds the grant to the
 * database it runs in.
 */
const ROLE_BOUNDARY = '0058_'

async function ensureReaderRole(): Promise<void> {
  const [{ exists }] = await adminServer<{ exists: boolean }[]>`
    SELECT EXISTS (SELECT FROM pg_roles WHERE rolname = ${READER_ROLE}) AS exists`
  if (!exists) {
    await adminServer.unsafe(`CREATE ROLE ${READER_ROLE} NOLOGIN`)
    createdRole = true
  }
}

async function migrate(sql: Sql, part: 'before-role' | 'after-role'): Promise<void> {
  for (const f of kernelChain()) {
    if ((part === 'before-role') !== f.name < ROLE_BOUNDARY) continue
    try {
      await sql.unsafe(f.text)
    } catch (e) {
      throw new Error(`${f.name}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}

async function seedTenant(who: Who, sql: Sql): Promise<Seed> {
  const tag = who.toLowerCase()
  // a user id has the shape the card routes accept for an assignee, so the membership check itself is reached
  const userId = `0192b0a0-0000-7000-8000-0000000000${tag}1`
  const [ou] = await sql<{ id: string }[]>`
    INSERT INTO org_units (name, kind, visibility, wants_matrix_room, wants_nextcloud_folder)
    VALUES (${`Gremium ${who}`}, 'council', 'all_members', false, false) RETURNING id`
  const [emptyOu] = await sql<{ id: string }[]>`
    INSERT INTO org_units (name, kind, visibility, wants_matrix_room, wants_nextcloud_folder)
    VALUES (${`Ausschuss ${who}`}, 'council', 'all_members', false, false) RETURNING id`
  await sql`INSERT INTO org_unit_members (org_unit_id, user_keycloak_id) VALUES (${ou!.id}, ${userId})`
  await sql`INSERT INTO org_unit_members (org_unit_id, user_keycloak_id) VALUES (${emptyOu!.id}, ${userId})`

  const boardName = `canary-board-${tag}`
  const [board] = await sql<{ id: string }[]>`
    INSERT INTO board (org_unit_id, name) VALUES (${ou!.id}, ${boardName}) RETURNING id`
  const stackIds: string[] = []
  for (const [order, name] of STACKS.entries()) {
    const [s] = await sql<{ id: string }[]>`
      INSERT INTO stack (board_id, name, sort_order) VALUES (${board!.id}, ${name}, ${order}) RETURNING id`
    stackIds.push(s!.id)
  }
  const cardTitle = `canary-card-${tag}`
  const [card] = await sql<{ id: string }[]>`
    INSERT INTO card (stack_id, title, created_by) VALUES (${stackIds[0]!}, ${cardTitle}, ${userId}) RETURNING id`

  const [proto] = await sql<{ id: string }[]>`
    INSERT INTO protocols (committee_id, meeting_date, title, created_by)
    VALUES (${ou!.id}, '2026-01-01', ${`Sitzung ${who}`}, ${userId}) RETURNING id`
  const [open] = await sql<{ id: string }[]>`
    INSERT INTO protocol_action_items (protocol_id, text) VALUES (${proto!.id}, ${`canary-item-${tag}`}) RETURNING id`
  // One item that already carries a card (the promoted-id oracle of vector 4).
  const [done] = await sql<{ id: string }[]>`
    INSERT INTO protocol_action_items (protocol_id, text) VALUES (${proto!.id}, ${`canary-promoted-${tag}`}) RETURNING id`
  await sql`
    INSERT INTO card (stack_id, title, protocol_action_item_id, created_by)
    VALUES (${stackIds[1]!}, ${`canary-promoted-card-${tag}`}, ${done!.id}, ${userId})`

  return {
    ouId: ou!.id,
    emptyOuId: emptyOu!.id,
    userId,
    boardId: board!.id,
    stackIds,
    cardId: card!.id,
    cardTitle,
    boardName,
    protocolId: proto!.id,
    actionItemId: open!.id,
    promotedActionItemId: done!.id,
  }
}

function tenantContext(who: Who): TenantContext {
  const tag = who.toLowerCase()
  return {
    id: `0192b0a0-0000-7000-8000-00000000b0${who === 'A' ? 'a' : 'b'}1`,
    slug: `iso-board-${tag}`,
    dbUrl: urlFor(DB_NAME[who]),
    dbMax: 3,
    dbPrepare: true,
  } as unknown as TenantContext
}

/** Everything the board owns in one database, in a stable order. Read over the admin connection. */
async function fingerprint(who: Who): Promise<string> {
  const sql = admin[who]
  // every column, so a write to any of them (due date, label, timestamps) changes the fingerprint
  const boards = await sql`SELECT * FROM board ORDER BY id`
  const stacks = await sql`SELECT * FROM stack ORDER BY id`
  const cards = await sql`SELECT * FROM card ORDER BY id`
  return JSON.stringify({ boards, stacks, cards })
}

// == driving the real handlers as one customer

const memberOf = (who: Who) => ({
  auth: async () => ({ user: { id: seed[who].userId, roles: ['member'] } }),
})

interface Reply {
  status: number
  body: unknown
}

/** Runs a handler inside the customer's tenant context; HTTP errors become a status, like the framework does. */
async function asTenant(who: Who, run: () => Promise<Response> | Response): Promise<Reply> {
  try {
    const res = await runWithTenant(ctx[who], () => run())
    const text = await res.text()
    let body: unknown = text
    try {
      body = JSON.parse(text)
    } catch {
      /* not JSON: keep the text */
    }
    return { status: res.status, body }
  } catch (e) {
    if (isHttpError(e)) return { status: e.status, body: e.body }
    throw e
  }
}

const json = (body: unknown) => new Request('http://board.example.org/', { method: 'POST', body: JSON.stringify(body) })
const patchJson = (body: unknown) => new Request('http://board.example.org/', { method: 'PATCH', body: JSON.stringify(body) })

const apiList = (who: Who) => asTenant(who, () => listBoards({ locals: memberOf(who) } as never))
const apiCreateBoard = (who: Who, orgUnitId: string) =>
  asTenant(who, () => createBoard({ request: json({ orgUnitId }), locals: memberOf(who) } as never))
const apiRead = (who: Who, id: string) =>
  asTenant(who, () => readBoard({ params: { id }, locals: memberOf(who) } as never))
const apiCreateCard = (who: Who, boardId: string, body: Record<string, unknown>) =>
  asTenant(who, () => createCard({ params: { id: boardId }, request: json(body), locals: memberOf(who) } as never))
const apiMoveCard = (who: Who, boardId: string, body: Record<string, unknown>) =>
  asTenant(who, () => moveCard({ params: { id: boardId }, request: patchJson(body), locals: memberOf(who) } as never))
// the edit is the same PATCH without a stackId
const apiEditCard = (who: Who, boardId: string, body: Record<string, unknown>) =>
  asTenant(who, () => moveCard({ params: { id: boardId }, request: patchJson(body), locals: memberOf(who) } as never))
const apiPromotable = (who: Who, boardId: string) =>
  asTenant(who, () => promotable({ params: { id: boardId }, locals: memberOf(who) } as never))
const apiPromote = (who: Who, boardId: string, actionItemId: string) =>
  asTenant(who, () => promote({ params: { id: boardId }, request: json({ actionItemId }), locals: memberOf(who) } as never))
const tasksPage = (who: Who, board?: string) =>
  asTenant(who, async () => {
    const url = new URL(`http://board.example.org/tasks${board ? `?board=${board}` : ''}`)
    return Response.json(await tasksLoad({ locals: memberOf(who), url } as never))
  })

/** The (only) names A must never see, as one substring list. */
const canariesOf = (who: Who) => {
  const s = seed[who]
  const tag = who.toLowerCase()
  return [
    s.boardName,
    s.cardTitle,
    `canary-card-${tag}`,
    `canary-promoted-card-${tag}`,
    `canary-item-${tag}`,
    `canary-promoted-${tag}`,
    `Gremium ${who}`,
    s.boardId,
    s.cardId,
    s.userId,
    ...s.stackIds,
  ]
}
const leaksNothingOf = (reply: Reply, who: Who) => {
  const text = JSON.stringify(reply.body)
  return canariesOf(who).filter((c) => text.includes(c))
}

// == setup

const ADMIN_ID = {
  server: 'board-iso-admin-server',
  A: 'board-iso-admin-a',
  B: 'board-iso-admin-b',
} as const

/**
 * An administrative connection, made with the kernel's own pool factory (this file
 * opens no driver of its own). One connection: the migration files carry their own
 * BEGIN/COMMIT. These pools are the test's oracle and are never reached through
 * getDb(): they are keyed by their own ids and URLs.
 */
const adminPool = (id: string, url: string): Sql => getPoolForTenant({ id, dbUrl: url, dbMax: 1, dbPrepare: false })

beforeAll(async () => {
  const adminUrl = (() => {
    const u = serverUrl()
    u.pathname = '/postgres'
    return u.toString()
  })()
  adminServer = adminPool(ADMIN_ID.server, adminUrl)
  for (const who of ['A', 'B'] as const) {
    await adminServer.unsafe(`CREATE DATABASE ${DB_NAME[who]}`)
    created.push(DB_NAME[who])
    admin[who] = adminPool(ADMIN_ID[who], urlFor(DB_NAME[who]))
    await migrate(admin[who], 'before-role')
  }
  await ensureReaderRole()
  for (const who of ['A', 'B'] as const) {
    await migrate(admin[who], 'after-role')
    seed[who] = await seedTenant(who, admin[who])
    ctx[who] = tenantContext(who)
  }
}, 180_000)

afterAll(async () => {
  let first: unknown
  const step = async (fn: () => unknown) => {
    try {
      await fn()
    } catch (e) {
      first ??= e
    }
  }
  // the customers' pools and the oracle's pools first; the server pool drops what this file created
  for (const who of ['A', 'B'] as const) {
    if (ctx[who]) await step(() => evictTenantPool(ctx[who].id))
    await step(() => evictTenantPool(ADMIN_ID[who]))
  }
  if (adminServer) {
    for (const name of created) await step(() => adminServer.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`))
    if (createdRole) await step(() => adminServer.unsafe(`DROP ROLE IF EXISTS ${READER_ROLE}`))
    await step(() => evictTenantPool(ADMIN_ID.server))
  }
  if (first) throw first
}, 60_000)

// == the case

describe('board: two customers on real PostgreSQL', () => {
  it('fixture: each customer is its own physical database holding only its own board', async () => {
    expect(DB_NAME.A).not.toBe(DB_NAME.B)
    for (const who of ['A', 'B'] as const) {
      const other: Who = who === 'A' ? 'B' : 'A'
      const [row] = await admin[who]<{ db: string }[]>`SELECT current_database() AS db`
      expect(row!.db).toBe(DB_NAME[who])
      const [own] = await admin[who]<{ n: string }[]>`SELECT count(*)::text AS n FROM board WHERE id = ${seed[who].boardId}`
      const [foreign] = await admin[who]<{ n: string }[]>`SELECT count(*)::text AS n FROM board WHERE id = ${seed[other].boardId}`
      expect(own!.n).toBe('1')
      expect(foreign!.n).toBe('0')
    }
  })

  it('pool routing: getDb() under a customer reaches that customer database and no other', async () => {
    const dbOf = async (who: Who) =>
      runWithTenant(ctx[who], async () => (await getDb()<{ db: string }[]>`SELECT current_database() AS db`)[0]!.db)
    expect(await dbOf('A')).toBe(DB_NAME.A)
    expect(await dbOf('B')).toBe(DB_NAME.B)
    // and back: the first answer was not cached for the second caller
    expect(await dbOf('A')).toBe(DB_NAME.A)
  })

  it('positive control: each customer lists, reads and loads its own board', async () => {
    for (const who of ['A', 'B'] as const) {
      const s = seed[who]
      const list = await apiList(who)
      expect(list.status).toBe(200)
      expect(JSON.stringify(list.body)).toContain(s.boardName)

      const read = await apiRead(who, s.boardId)
      expect(read.status).toBe(200)
      const text = JSON.stringify(read.body)
      expect(text).toContain(s.cardTitle)
      for (const id of s.stackIds) expect(text).toContain(id)

      const page = await tasksPage(who)
      expect(page.status).toBe(200)
      expect(JSON.stringify(page.body)).toContain(s.boardName)
      expect(JSON.stringify(page.body)).toContain(s.cardTitle)
    }
  })

  it('positive control: writes made as B land in B only, writes made as A land in A only', async () => {
    const beforeA = await fingerprint('A')
    const beforeB = await fingerprint('B')

    // B creates a card on its own board, then a three-stack board on its second org unit.
    const card = await apiCreateCard('B', seed.B.boardId, { stackId: seed.B.stackIds[0], title: 'control-b-card' })
    expect(card.status).toBe(201)
    const board = await apiCreateBoard('B', seed.B.emptyOuId)
    expect(board.status).toBe(201)
    const newBoardId = (board.body as { data: { id: string } }).data.id

    const bRows = await admin.B<{ n: string }[]>`SELECT count(*)::text AS n FROM card WHERE title = 'control-b-card'`
    expect(bRows[0]!.n).toBe('1')
    const stacks = await admin.B<{ name: string }[]>`SELECT name FROM stack WHERE board_id = ${newBoardId} ORDER BY sort_order`
    expect(stacks.map((s) => s.name)).toEqual(STACKS)
    // none of it reached A, and A's own state is untouched
    expect(await fingerprint('A')).toBe(beforeA)
    const aRows = await admin.A<{ n: string }[]>`SELECT count(*)::text AS n FROM card WHERE title = 'control-b-card'`
    expect(aRows[0]!.n).toBe('0')

    // the mirror image, A writes
    const afterB = await fingerprint('B')
    expect(afterB).not.toBe(beforeB)
    const cardA = await apiCreateCard('A', seed.A.boardId, { stackId: seed.A.stackIds[0], title: 'control-a-card' })
    expect(cardA.status).toBe(201)
    expect(await fingerprint('B')).toBe(afterB)
    const inB = await admin.B<{ n: string }[]>`SELECT count(*)::text AS n FROM card WHERE title = 'control-a-card'`
    expect(inB[0]!.n).toBe('0')
    const inA = await admin.A<{ n: string }[]>`SELECT count(*)::text AS n FROM card WHERE title = 'control-a-card'`
    expect(inA[0]!.n).toBe('1')
  })

  it('positive control: a card edit made as one customer changes that customer card only', async () => {
    for (const who of ['A', 'B'] as const) {
      const other: Who = who === 'A' ? 'B' : 'A'
      const before = await fingerprint(other)
      const s = seed[who]
      const note = `control-edit-${who.toLowerCase()}`
      const edit = await apiEditCard(who, s.boardId, { cardId: s.cardId, description: note, assigneeKeycloakId: s.userId, dueDate: '2026-12-15' })
      expect(edit.status).toBe(200)
      const [own] = await admin[who]<{ description: string | null; assignee_keycloak_id: string | null }[]>`
        SELECT description, assignee_keycloak_id FROM card WHERE id = ${s.cardId}`
      expect({ ...own }).toEqual({ description: note, assignee_keycloak_id: s.userId })
      expect(await fingerprint(other)).toBe(before)
      const elsewhere = await admin[other]<{ n: string }[]>`SELECT count(*)::text AS n FROM card WHERE description = ${note}`
      expect(elsewhere[0]!.n).toBe('0')
      // the page names the customer's own member for the picker, and never the other customer's member
      const page = await tasksPage(who, s.boardId)
      expect(JSON.stringify(page.body)).toContain(s.userId)
      expect(JSON.stringify(page.body)).not.toContain(seed[other].userId)
    }
  })

  // Every attempt below is made by one customer against what the other owns, in BOTH
  // directions (A on B, then B on A), so a shared pool or a shared database is caught
  // whichever customer's data it happens to serve. The fingerprints are read before and
  // after the whole battery (vector H), and the individual 404s are asserted one by one
  // so a failure names its vector.
  describe('attacks: each customer on the other', () => {
    const directions: Array<[Who, Who]> = [
      ['A', 'B'],
      ['B', 'A'],
    ]
    const before = {} as Record<Who, string>
    beforeAll(async () => {
      before.A = await fingerprint('A')
      before.B = await fingerprint('B')
    })

    it('1 list: the other customer board and everything under it is absent from the list', async () => {
      for (const [atk, vic] of directions) {
        const r = await apiList(atk)
        expect(r.status).toBe(200)
        expect(leaksNothingOf(r, vic)).toEqual([])
      }
    })

    it('2 read: the other customer board by id is 404, and says nothing of it', async () => {
      for (const [atk, vic] of directions) {
        const r = await apiRead(atk, seed[vic].boardId)
        expect(r.status).toBe(404)
        expect(leaksNothingOf(r, vic)).toEqual([])
      }
    })

    it('3 deck: no read path serves the other customer stacks or cards (page load, promotable list)', async () => {
      for (const [atk, vic] of directions) {
        for (const reply of [
          await tasksPage(atk, seed[vic].boardId),
          await tasksPage(atk),
          await apiPromotable(atk, seed[vic].boardId),
        ]) {
          expect(leaksNothingOf(reply, vic)).toEqual([])
        }
        expect((await apiPromotable(atk, seed[vic].boardId)).status).toBe(404)
      }
    })

    it('4 oracle: the promoted-id lookup does not report the other customer promoted action item', async () => {
      const backend = getBoardBackend()
      for (const [atk, vic] of directions) {
        const ids = await runWithTenant(ctx[atk], () =>
          backend.listPromotedActionItemIds([seed[vic].promotedActionItemId, seed[atk].promotedActionItemId]),
        )
        expect([...ids]).toEqual([seed[atk].promotedActionItemId])
      }
    })

    it('5 card create: a card on the other board, or on the own board with the other stack, is 404', async () => {
      for (const [atk, vic] of directions) {
        const onVictim = await apiCreateCard(atk, seed[vic].boardId, { stackId: seed[vic].stackIds[0], title: 'intrusion-5' })
        expect(onVictim.status).toBe(404)
        const intoVictimStack = await apiCreateCard(atk, seed[atk].boardId, { stackId: seed[vic].stackIds[0], title: 'intrusion-5b' })
        expect(intoVictimStack.status).toBe(404)
        const ownStackOnVictim = await apiCreateCard(atk, seed[vic].boardId, { stackId: seed[atk].stackIds[0], title: 'intrusion-5c' })
        expect(ownStackOnVictim.status).toBe(404)
      }
    })

    it('6 card move: the other card, or an own card into the other stack, is 404 and the own card stays', async () => {
      for (const [atk, vic] of directions) {
        const victimCardOnVictimBoard = await apiMoveCard(atk, seed[vic].boardId, { cardId: seed[vic].cardId, stackId: seed[vic].stackIds[1], order: 0 })
        expect(victimCardOnVictimBoard.status).toBe(404)
        const victimCardOnOwnBoard = await apiMoveCard(atk, seed[atk].boardId, { cardId: seed[vic].cardId, stackId: seed[atk].stackIds[1], order: 0 })
        expect(victimCardOnOwnBoard.status).toBe(404)
        const ownCardIntoVictimStack = await apiMoveCard(atk, seed[atk].boardId, { cardId: seed[atk].cardId, stackId: seed[vic].stackIds[1], order: 0 })
        expect(ownCardIntoVictimStack.status).toBe(404)
        const [stillThere] = await admin[atk]<{ stack_id: string }[]>`SELECT stack_id FROM card WHERE id = ${seed[atk].cardId}`
        expect(stillThere!.stack_id).toBe(seed[atk].stackIds[0])
      }
    })

    it('6 card edit: the other card is 404 on either board, and the other customer member cannot be assigned', async () => {
      for (const [atk, vic] of directions) {
        const victimCardOnVictimBoard = await apiEditCard(atk, seed[vic].boardId, { cardId: seed[vic].cardId, title: 'intrusion-6u', description: 'intrusion-6u' })
        expect(victimCardOnVictimBoard.status).toBe(404)
        expect(leaksNothingOf(victimCardOnVictimBoard, vic)).toEqual([])
        const victimCardOnOwnBoard = await apiEditCard(atk, seed[atk].boardId, { cardId: seed[vic].cardId, title: 'intrusion-6v', description: 'intrusion-6v' })
        expect(victimCardOnOwnBoard.status).toBe(404)
        expect(leaksNothingOf(victimCardOnOwnBoard, vic)).toEqual([])
        // an own card must not take the other customer's member as its assignee: that person is no member here
        const foreignAssignee = await apiEditCard(atk, seed[atk].boardId, { cardId: seed[atk].cardId, assigneeKeycloakId: seed[vic].userId })
        expect(foreignAssignee.status).toBe(400)
        const foreignAssigneeOnCreate = await apiCreateCard(atk, seed[atk].boardId, {
          stackId: seed[atk].stackIds[0],
          title: 'intrusion-6w',
          assigneeKeycloakId: seed[vic].userId,
        })
        expect(foreignAssigneeOnCreate.status).toBe(400)
      }
      // none of it was written anywhere: no intrusion text, and no card of one customer assigned to the other's member
      for (const who of ['A', 'B'] as const) {
        const other: Who = who === 'A' ? 'B' : 'A'
        const rows = await admin[who]<{ n: string }[]>`
          SELECT count(*)::text AS n FROM card
           WHERE title LIKE 'intrusion-6%' OR description LIKE 'intrusion-6%' OR assignee_keycloak_id = ${seed[other].userId}`
        expect(rows[0]!.n).toBe('0')
      }
    })

    it('7 promote: the other action item, or any item on the other board, is 404', async () => {
      for (const [atk, vic] of directions) {
        expect((await apiPromote(atk, seed[atk].boardId, seed[vic].actionItemId)).status).toBe(404)
        expect((await apiPromote(atk, seed[vic].boardId, seed[atk].actionItemId)).status).toBe(404)
        expect((await apiPromote(atk, seed[vic].boardId, seed[vic].actionItemId)).status).toBe(404)
      }
    })

    it('8 stack create: the port refuses a stack on the other board', async () => {
      const backend = getBoardBackend()
      for (const [atk, vic] of directions) {
        await expect(
          runWithTenant(ctx[atk], () => backend.createStack(seed[vic].boardId, { name: 'intrusion-8', order: 9 })),
        ).rejects.toBeTruthy()
        // the rejection must be the refusal, not an unrelated failure: no such stack exists in either database
        for (const who of ['A', 'B'] as const) {
          const rows = await admin[who]<{ n: string }[]>`SELECT count(*)::text AS n FROM stack WHERE name = 'intrusion-8'`
          expect(rows[0].n).toBe('0')
        }
      }
    })

    it('9 board create: the other org unit is refused (scope)', async () => {
      for (const [atk, vic] of directions) {
        expect([403, 404]).toContain((await apiCreateBoard(atk, seed[vic].ouId)).status)
        expect([403, 404]).toContain((await apiCreateBoard(atk, seed[vic].emptyOuId)).status)
      }
    })

    it('H fingerprint: both boards, stacks and cards are byte-identical after every attempt', async () => {
      expect(await fingerprint('A')).toBe(before.A)
      expect(await fingerprint('B')).toBe(before.B)
    })
  })
})

describe('board: every data handle comes from getDb()', () => {
  const dirs = [
    path.join(UI_ROOT, 'src', 'lib', 'server', 'board'),
    path.join(UI_ROOT, 'src', 'routes', 'api', 'board'),
    path.join(UI_ROOT, 'src', 'routes', 'tasks'),
  ]
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
    )
  const sources = dirs.flatMap(walk).filter((f) => /\.(ts|svelte)$/.test(f) && !f.endsWith('.test.ts'))

  it('the scan sees the board code', () => {
    expect(sources.some((f) => f.endsWith('board-db.ts'))).toBe(true)
    expect(sources.some((f) => f.includes(`${path.sep}api${path.sep}board${path.sep}`))).toBe(true)
  })

  it('no board file builds its own connection or reads the connection string', () => {
    const offenders = sources.filter((f) => {
      const text = readFileSync(f, 'utf8')
      return /from\s+['"]postgres['"]/.test(text) || /\bcreateDb\b/.test(text) || /DATABASE_URL/.test(text)
    })
    expect(offenders.map((f) => path.relative(UI_ROOT, f))).toEqual([])
  })

  it('the repository and its callers reach the database through getDb() only', () => {
    const boardDb = readFileSync(path.join(UI_ROOT, 'src', 'lib', 'server', 'board', 'board-db.ts'), 'utf8')
    expect(boardDb).toMatch(/import \{ getDb \} from '\.\.\/db'/)
    expect(boardDb).not.toMatch(/\bpostgres\(/)
  })
})
