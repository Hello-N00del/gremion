/**
 * Cross-customer isolation of the board, on REAL PostgreSQL, through the router.
 *
 * This is the isolation:tenant case of the `board` module (proofKind
 * real-pg-app). It runs the code the pilot runs: the real route handlers
 * (/api/board and below, and the /tasks load), the real scope resolver, the real
 * board-db, the real getDb() and the real per-tenant pool registry, and, since a
 * customer's board can live in the board module's own database, the real router
 * (getBoardBackend() in its default `auto` mode), which reads each customer's
 * location flag and sends the call either to the kernel tables or to the board
 * service. Nothing between the handler and the database is mocked. Only the
 * display-name lookup (a Keycloak call) is replaced, because it is not data access.
 *
 * Three customers, each with a PHYSICALLY separate kernel database (the kernel
 * migration chain applied to all three):
 *   A  located `kernel`  its board rows are in its own kernel database; there is no module database for it
 *   B  located `module`  its board rows are in its own t_<hex32>__board database, served by the board
 *   C  located `module`  service (the real leaf, built by its own factory and listening on loopback);
 *                        its kernel tables hold no board rows at all
 * so every request below is judged for a customer served in-process AND for two customers served by
 * the one shared leaf process (B and C are the pair the leaf must keep apart).
 * A request is made as one customer by running the handler inside runWithTenant(that customer's
 * context), exactly as the request hook does. What another customer owns must be invisible and
 * untouchable from there, and the proof that nothing changed does not rely on the code under test:
 * the fixtures are written, and the "did anything change" fingerprints are read, over separate
 * administrative connections to each database (the kernel database AND, for B and C, the module
 * database, so a write that went to the wrong store shows).
 *
 * Vectors (the board leaf's own case, modules/board/test/isolation/case.ts, mapped to the kernel routes):
 *   1 list           GET /api/board                       another customer's board is not listed
 *   2 read           GET /api/board/{its board}           404
 *   3 deck           the same route                       its stacks and cards are not served
 *   4 oracle         promoted-id lookup                   its promoted item is not reported
 *   5 card create    POST /api/board/{id}/cards           404 on its board, 404 for its stack
 *   6 card move      PATCH /api/board/{id}/cards          404 for its card or its stack
 *   6 card edit      the same route, no stackId           404 for its card; its member is not assignable
 *   7 promote        POST /api/board/{id}/promote         404 for its item or its board
 *   8 stack create   the port (the kernel has no route)   rejected, nothing written to it
 *   9 board create   POST /api/board with its org unit    403 (scope), nothing written to it
 *   H fingerprint    every customer's boards, stacks and cards are byte-identical after every attempt
 * every one of them in BOTH directions for every ordered pair of customers (6 pairs).
 *
 * Why it can fail: replace getDb() by a shared pool (the mutation this file is judged by) and the
 * positive controls, the physical-database checks and the 404 expectations all go red; point the
 * board service at one database for every customer and the module customers' controls and attacks go red.
 *
 * The throwaway server is ISOLATION_TENANT_PG_URL when the isolation producer
 * runs this file (loopback, a port other than 5432). Otherwise it is the server
 * of DATABASE_URL, which the integration harness has already judged safe
 * (assert-safe-test-db-url). Every database this file creates is named
 * board_iso_test_* (kernel databases) or t_<hex32>__board of a tenant id minted for this run
 * (module databases), and only those are ever dropped.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import type http from 'node:http'
import path from 'node:path'
import type { Sql } from '@gremion/db'
import { runMigrations, tenantModuleDbName } from '@gremion/tenant-store'
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
import { getBoardLocation, resetBoardLocationCacheForTests, type BoardLocation } from './backend/location'

// Guard at import like every harness that creates or drops a database; the isolation suite derives DATABASE_URL from the throwaway server.
assertNonProductionDbUrl(process.env.DATABASE_URL ?? '', 'DATABASE_URL')

// The display-name lookup asks Keycloak: not data access, and out of scope here.
vi.mock('$lib/server/identity/display-names', () => ({
  getDisplayNameResolver: () => ({ resolveMany: async () => new Map<string, string>() }),
}))

type Who = 'A' | 'B' | 'C'

const WHOS: readonly Who[] = ['A', 'B', 'C']
/** Where each customer's board lives, as its location flag says. */
const LOCATION: Readonly<Record<Who, Extract<BoardLocation, 'kernel' | 'module'>>> = { A: 'kernel', B: 'module', C: 'module' }
const inModule = (who: Who): boolean => LOCATION[who] === 'module'
const othersOf = (who: Who): Who[] => WHOS.filter((w) => w !== who)
/** Every ordered pair (attacker, victim): A on B, B on A, A on C, ... */
const DIRECTIONS: ReadonlyArray<readonly [Who, Who]> = WHOS.flatMap((atk) => othersOf(atk).map((vic) => [atk, vic] as const))

const UI_ROOT = path.resolve(__dirname, '..', '..', '..', '..')
const MIGRATIONS = path.join(UI_ROOT, 'migrations')
/** The board module as it sits in the repository: the leaf's source and its migrations. */
const BOARD_MODULE_ROOT = path.resolve(UI_ROOT, '..', 'modules', 'board')
const LEAF_MIGRATIONS = path.join(BOARD_MODULE_ROOT, 'migrations')
const READER_ROLE = 'gremion_public_reader'
const RUN = `${process.pid}_${Math.random().toString(36).slice(2, 8)}`
const DB_NAME: Record<Who, string> = { A: `board_iso_test_a_${RUN}`, B: `board_iso_test_b_${RUN}`, C: `board_iso_test_c_${RUN}` }
/** Tenant ids are canonical v7 uuids minted for this run, so two runs on one server never share a module database. */
const RUN_HEX = randomBytes(4).toString('hex')
const TENANT_ID: Record<Who, string> = {
  A: `0192b0a0-0000-7000-8000-${RUN_HEX}b0a1`,
  B: `0192b0a0-0000-7000-8000-${RUN_HEX}b0b1`,
  C: `0192b0a0-0000-7000-8000-${RUN_HEX}b0c1`,
}
const LEAF_DB: Record<Who, string> = {
  A: tenantModuleDbName(TENANT_ID.A, 'board'),
  B: tenantModuleDbName(TENANT_ID.B, 'board'),
  C: tenantModuleDbName(TENANT_ID.C, 'board'),
}
const LEAF_SECRET = `board-iso-secret-${RUN_HEX}`
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

/**
 * The url of a module database on the throwaway server. A tenant database is never named "test", so the
 * guard cannot judge its name: it judges the SERVER (through the kernel fixture database of the same run,
 * which the guard accepts only on a safe host), and the name must be the one this file minted.
 */
function leafUrlFor(db: string): string {
  if (!Object.values(LEAF_DB).includes(db)) throw new Error('[board-isolation] refusing a module database this file did not mint')
  assertNonProductionDbUrl(urlFor(DB_NAME.A), 'the server of the module databases')
  const u = serverUrl()
  u.pathname = `/${db}`
  return u.toString()
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

/** The board service, as this file uses it: the leaf's own factory (modules/board/src/app.ts). */
interface Leaf {
  server: http.Server
  close(): Promise<void>
}

const created: string[] = []
let adminServer: Sql
let createdRole = false
let leaf: Leaf | undefined
let fetchSpy: { mock: { calls: unknown[][] }; mockRestore(): void }
const savedEnv: Record<string, string | undefined> = {}
/** The kernel database of each customer. */
const kernelAdmin = {} as Record<Who, Sql>
/** The board module's database of B and C (A has none). */
const leafAdmin = {} as Record<'B' | 'C', Sql>
/** Where each customer's boards physically are: its kernel database for A, its module database for B and C. */
const boardAdmin = {} as Record<Who, Sql>
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

/**
 * One customer's fixture. The org units, their members, the protocols and the action items are the
 * kernel's and are written to the kernel database; the board, its stacks and its cards are written
 * to `boards`, the database the customer's location flag names (the same connection for A).
 */
async function seedTenant(who: Who, kernel: Sql, boards: Sql): Promise<Seed> {
  const tag = who.toLowerCase()
  // a user id has the shape the card routes accept for an assignee, so the membership check itself is reached
  const userId = `0192b0a0-0000-7000-8000-0000000000${tag}1`
  const [ou] = await kernel<{ id: string }[]>`
    INSERT INTO org_units (name, kind, visibility, wants_matrix_room, wants_nextcloud_folder)
    VALUES (${`Gremium ${who}`}, 'council', 'all_members', false, false) RETURNING id`
  const [emptyOu] = await kernel<{ id: string }[]>`
    INSERT INTO org_units (name, kind, visibility, wants_matrix_room, wants_nextcloud_folder)
    VALUES (${`Ausschuss ${who}`}, 'council', 'all_members', false, false) RETURNING id`
  await kernel`INSERT INTO org_unit_members (org_unit_id, user_keycloak_id) VALUES (${ou!.id}, ${userId})`
  await kernel`INSERT INTO org_unit_members (org_unit_id, user_keycloak_id) VALUES (${emptyOu!.id}, ${userId})`

  const [proto] = await kernel<{ id: string }[]>`
    INSERT INTO protocols (committee_id, meeting_date, title, created_by)
    VALUES (${ou!.id}, '2026-01-01', ${`Sitzung ${who}`}, ${userId}) RETURNING id`
  const [open] = await kernel<{ id: string }[]>`
    INSERT INTO protocol_action_items (protocol_id, text) VALUES (${proto!.id}, ${`canary-item-${tag}`}) RETURNING id`
  // One item that already carries a card (the promoted-id oracle of vector 4).
  const [done] = await kernel<{ id: string }[]>`
    INSERT INTO protocol_action_items (protocol_id, text) VALUES (${proto!.id}, ${`canary-promoted-${tag}`}) RETURNING id`

  const boardName = `canary-board-${tag}`
  const [board] = await boards<{ id: string }[]>`
    INSERT INTO board (org_unit_id, name) VALUES (${ou!.id}, ${boardName}) RETURNING id`
  const stackIds: string[] = []
  for (const [order, name] of STACKS.entries()) {
    const [s] = await boards<{ id: string }[]>`
      INSERT INTO stack (board_id, name, sort_order) VALUES (${board!.id}, ${name}, ${order}) RETURNING id`
    stackIds.push(s!.id)
  }
  const cardTitle = `canary-card-${tag}`
  const [card] = await boards<{ id: string }[]>`
    INSERT INTO card (stack_id, title, created_by) VALUES (${stackIds[0]!}, ${cardTitle}, ${userId}) RETURNING id`
  await boards`
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
  return {
    id: TENANT_ID[who],
    slug: `iso-board-${who.toLowerCase()}`,
    dbUrl: urlFor(DB_NAME[who]),
    dbMax: 3,
    dbPrepare: true,
  } as unknown as TenantContext
}

async function boardTables(sql: Sql) {
  // every column, so a write to any of them (due date, label, timestamps) changes the fingerprint
  return {
    boards: await sql`SELECT * FROM board ORDER BY id`,
    stacks: await sql`SELECT * FROM stack ORDER BY id`,
    cards: await sql`SELECT * FROM card ORDER BY id`,
  }
}

/**
 * Everything the board owns for one customer, in a stable order, read over the administrative
 * connections: the board tables of its kernel database and, for B and C, those of its module
 * database. A write that landed in the store the flag does not name changes it too.
 */
async function fingerprint(who: Who): Promise<string> {
  return JSON.stringify({
    kernel: await boardTables(kernelAdmin[who]),
    module: inModule(who) ? await boardTables(leafAdmin[who as 'B' | 'C']) : null,
  })
}

/** How many rows of `table` match, in the database where `who`'s boards physically are. */
async function countWhere(who: Who, table: 'board' | 'stack' | 'card', where: string, ...params: string[]): Promise<number> {
  const rows = await boardAdmin[who].unsafe<{ n: string }[]>(`SELECT count(*)::text AS n FROM ${table} WHERE ${where}`, params)
  return Number(rows[0]!.n)
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

/** The (only) names another customer must never see, as one substring list. */
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
  kernel: (who: Who) => `board-iso-admin-${who.toLowerCase()}`,
  leaf: (who: 'B' | 'C') => `board-iso-leaf-admin-${who.toLowerCase()}`,
} as const

/**
 * An administrative connection, made with the kernel's own pool factory (this file
 * opens no driver of its own). One connection: the migration files carry their own
 * BEGIN/COMMIT. These pools are the test's oracle and are never reached through
 * getDb(): they are keyed by their own ids and URLs.
 */
const adminPool = (id: string, url: string, max = 1): Sql => getPoolForTenant({ id, dbUrl: url, dbMax: max, dbPrepare: false })

/** The board service's own database for one customer, migrated by the module's own runner like a real enable does. */
async function provisionLeafDatabase(who: 'B' | 'C'): Promise<void> {
  const name = LEAF_DB[who]
  await adminServer.unsafe(`CREATE DATABASE "${name}"`)
  created.push(name)
  // the migration runner needs a second connection for its lock
  const sql = adminPool(ADMIN_ID.leaf(who), leafUrlFor(name), 2)
  leafAdmin[who] = sql
  await runMigrations({
    sql,
    dir: LEAF_MIGRATIONS,
    releaseRef: 'dist-v0.0.1',
    phaseFor: () => ({ phase: 'expand' as const }),
    log: () => {},
  })
}

async function setLocation(who: Who): Promise<void> {
  await kernelAdmin[who]`
    INSERT INTO board_location (id, location) VALUES (true, ${LOCATION[who]})
    ON CONFLICT (id) DO UPDATE SET location = EXCLUDED.location, changed_at = now()`
}

beforeAll(async () => {
  const adminUrl = (() => {
    const u = serverUrl()
    u.pathname = '/postgres'
    return u.toString()
  })()
  adminServer = adminPool(ADMIN_ID.server, adminUrl)
  for (const who of WHOS) {
    await adminServer.unsafe(`CREATE DATABASE ${DB_NAME[who]}`)
    created.push(DB_NAME[who])
    kernelAdmin[who] = adminPool(ADMIN_ID.kernel(who), urlFor(DB_NAME[who]))
    await migrate(kernelAdmin[who], 'before-role')
  }
  await ensureReaderRole()
  for (const who of WHOS) await migrate(kernelAdmin[who], 'after-role')

  for (const who of ['B', 'C'] as const) await provisionLeafDatabase(who)
  for (const who of WHOS) {
    boardAdmin[who] = inModule(who) ? leafAdmin[who as 'B' | 'C'] : kernelAdmin[who]
    seed[who] = await seedTenant(who, kernelAdmin[who], boardAdmin[who])
    ctx[who] = tenantContext(who)
    await setLocation(who)
  }

  // The board service: the leaf's own factory, on loopback, opening t_<hex32>__board on the throwaway server.
  // It is imported by path from the repository (the app half has no dependency on the leaf's package).
  const leafApp = path.join(BOARD_MODULE_ROOT, 'src', 'app.ts')
  const { buildApp } = (await import(/* @vite-ignore */ leafApp)) as {
    buildApp(env: Record<string, string | undefined>): Leaf
  }
  const built = buildApp({ GREMION_BOARD_PG_URL: serverUrl().toString(), INTERNAL_BOARD_SECRET: LEAF_SECRET })
  leaf = built
  await new Promise<void>((resolve) => built.server.listen(0, '127.0.0.1', resolve))
  const addr = built.server.address()
  if (!addr || typeof addr === 'string') throw new Error('[board-isolation] the board service is not listening')

  for (const key of ['BOARD_BACKEND', 'BOARD_SERVICE_URL', 'INTERNAL_BOARD_SECRET']) savedEnv[key] = process.env[key]
  process.env.BOARD_BACKEND = 'auto'
  process.env.BOARD_SERVICE_URL = `http://127.0.0.1:${addr.port}`
  process.env.INTERNAL_BOARD_SECRET = LEAF_SECRET
  resetBoardLocationCacheForTests()
  // wraps the real fetch: it only counts which calls the router sent to the board service
  fetchSpy = vi.spyOn(globalThis, 'fetch')
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
  fetchSpy?.mockRestore()
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  resetBoardLocationCacheForTests()
  // the board service first (its pools hold sessions on the module databases), then the customers' and the oracle's pools
  if (leaf) await step(() => leaf!.close())
  for (const who of WHOS) {
    if (ctx[who]) await step(() => evictTenantPool(ctx[who].id))
    await step(() => evictTenantPool(ADMIN_ID.kernel(who)))
  }
  for (const who of ['B', 'C'] as const) await step(() => evictTenantPool(ADMIN_ID.leaf(who)))
  // the server pool drops what this file created
  if (adminServer) {
    for (const name of created) await step(() => adminServer.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`))
    if (createdRole) await step(() => adminServer.unsafe(`DROP ROLE IF EXISTS ${READER_ROLE}`))
    await step(() => evictTenantPool(ADMIN_ID.server))
  }
  if (first) throw first
}, 60_000)

// == the case

describe('board: three customers on real PostgreSQL, one served in-process and two by the board service', () => {
  it('fixture: each customer is its own physical database holding only its own board, where its flag says', async () => {
    expect(new Set(WHOS.map((w) => DB_NAME[w])).size).toBe(WHOS.length)
    const existing = (await adminServer<{ datname: string }[]>`SELECT datname FROM pg_database`).map((r) => r.datname)
    for (const who of WHOS) {
      const [kernelDb] = await kernelAdmin[who]<{ db: string }[]>`SELECT current_database() AS db`
      expect(kernelDb!.db).toBe(DB_NAME[who])
      const [boardDb] = await boardAdmin[who]<{ db: string }[]>`SELECT current_database() AS db`
      expect(boardDb!.db).toBe(inModule(who) ? LEAF_DB[who] : DB_NAME[who])
      expect(await countWhere(who, 'board', 'id = $1', seed[who].boardId)).toBe(1)
      for (const other of othersOf(who)) expect(await countWhere(who, 'board', 'id = $1', seed[other].boardId)).toBe(0)
      // a module customer's kernel tables hold no board rows: the board is served by the module database, not by a stale copy
      if (inModule(who)) {
        const [kernelRows] = await kernelAdmin[who]<{ n: string }[]>`SELECT (SELECT count(*) FROM board) + (SELECT count(*) FROM stack) + (SELECT count(*) FROM card) AS n`
        expect(Number(kernelRows!.n)).toBe(0)
        expect(existing).toContain(LEAF_DB[who])
      } else {
        // the kernel customer has no module database at all
        expect(existing).not.toContain(LEAF_DB[who])
      }
    }
  })

  it('location: the router reads each customer flag from that customer own kernel database', async () => {
    for (const who of WHOS) {
      expect(await runWithTenant(ctx[who], () => getBoardLocation())).toBe(LOCATION[who])
    }
    expect(getBoardBackend().kind).toBe('routed')
  })

  it('pool routing: getDb() under a customer reaches that customer database and no other', async () => {
    const dbOf = async (who: Who) =>
      runWithTenant(ctx[who], async () => (await getDb()<{ db: string }[]>`SELECT current_database() AS db`)[0]!.db)
    for (const who of WHOS) expect(await dbOf(who)).toBe(DB_NAME[who])
    // and back: the first answer was not cached for the second caller
    expect(await dbOf('A')).toBe(DB_NAME.A)
  })

  it('positive control: each customer lists, reads and loads its own board', async () => {
    for (const who of WHOS) {
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

  it('positive control: the router sends a module customer to the board service and a kernel customer to the kernel tables', async () => {
    const toLeaf = () => fetchSpy.mock.calls.filter(([input]) => String(input).startsWith(process.env.BOARD_SERVICE_URL!)).length
    for (const who of WHOS) {
      const before = toLeaf()
      const read = await apiRead(who, seed[who].boardId)
      expect(read.status).toBe(200)
      // module customers: the board answered is the one in the module database, called over HTTP; kernel customer: no call
      expect(toLeaf() > before).toBe(inModule(who))
    }
  })

  it('positive control: writes made as one customer land in that customer only', async () => {
    for (const who of WHOS) {
      const tag = who.toLowerCase()
      const others = othersOf(who)
      const before = Object.fromEntries(await Promise.all(others.map(async (o) => [o, await fingerprint(o)] as const)))
      const ownBefore = await fingerprint(who)

      // a card on its own board, then a three-stack board on its second org unit
      const card = await apiCreateCard(who, seed[who].boardId, { stackId: seed[who].stackIds[0], title: `control-card-${tag}` })
      expect(card.status).toBe(201)
      const board = await apiCreateBoard(who, seed[who].emptyOuId)
      expect(board.status).toBe(201)
      const newBoardId = (board.body as { data: { id: string } }).data.id

      // the rows are in the database the flag names, and in no other database of any customer
      expect(await countWhere(who, 'card', 'title = $1', `control-card-${tag}`)).toBe(1)
      const stacks = await boardAdmin[who]<{ name: string }[]>`SELECT name FROM stack WHERE board_id = ${newBoardId} ORDER BY sort_order`
      expect(stacks.map((s) => s.name)).toEqual(STACKS)
      expect(await fingerprint(who)).not.toBe(ownBefore)
      if (inModule(who)) {
        // not in its own kernel tables either
        const [stray] = await kernelAdmin[who]<{ n: string }[]>`SELECT count(*)::text AS n FROM card WHERE title = ${`control-card-${tag}`}`
        expect(stray!.n).toBe('0')
      }
      for (const o of others) {
        expect(await fingerprint(o)).toBe(before[o])
        expect(await countWhere(o, 'card', 'title = $1', `control-card-${tag}`)).toBe(0)
      }
    }
  })

  it('positive control: a card edit made as one customer changes that customer card only', async () => {
    for (const who of WHOS) {
      const others = othersOf(who)
      const before = Object.fromEntries(await Promise.all(others.map(async (o) => [o, await fingerprint(o)] as const)))
      const s = seed[who]
      const note = `control-edit-${who.toLowerCase()}`
      const edit = await apiEditCard(who, s.boardId, { cardId: s.cardId, description: note, assigneeKeycloakId: s.userId, dueDate: '2026-12-15' })
      expect(edit.status).toBe(200)
      const [own] = await boardAdmin[who]<{ description: string | null; assignee_keycloak_id: string | null }[]>`
        SELECT description, assignee_keycloak_id FROM card WHERE id = ${s.cardId}`
      expect({ ...own }).toEqual({ description: note, assignee_keycloak_id: s.userId })
      for (const o of others) {
        expect(await fingerprint(o)).toBe(before[o])
        expect(await countWhere(o, 'card', 'description = $1', note)).toBe(0)
      }
      // the page names the customer's own member for the picker, and never another customer's member
      const page = await tasksPage(who, s.boardId)
      expect(JSON.stringify(page.body)).toContain(s.userId)
      for (const o of others) expect(JSON.stringify(page.body)).not.toContain(seed[o].userId)
    }
  })

  // Every attempt below is made by one customer against what another owns, in BOTH
  // directions for EVERY pair (A on B, B on A, A on C, ...), so a shared pool or a shared
  // database is caught whichever customer's data it happens to serve, and the two customers
  // that share the board service (B and C) are judged against each other. The fingerprints
  // are read before and after the whole battery (vector H), and the individual 404s are
  // asserted one by one so a failure names its vector.
  describe('attacks: each customer on every other', () => {
    const before = {} as Record<Who, string>
    beforeAll(async () => {
      for (const who of WHOS) before[who] = await fingerprint(who)
    })

    it('1 list: another customer board and everything under it is absent from the list', async () => {
      for (const [atk, vic] of DIRECTIONS) {
        const r = await apiList(atk)
        expect(r.status).toBe(200)
        expect(leaksNothingOf(r, vic)).toEqual([])
      }
    })

    it('2 read: another customer board by id is 404, and says nothing of it', async () => {
      for (const [atk, vic] of DIRECTIONS) {
        const r = await apiRead(atk, seed[vic].boardId)
        expect(r.status).toBe(404)
        expect(leaksNothingOf(r, vic)).toEqual([])
      }
    })

    it('3 deck: no read path serves another customer stacks or cards (page load, promotable list)', async () => {
      for (const [atk, vic] of DIRECTIONS) {
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

    it('4 oracle: the promoted-id lookup does not report another customer promoted action item', async () => {
      const backend = getBoardBackend()
      for (const [atk, vic] of DIRECTIONS) {
        const ids = await runWithTenant(ctx[atk], () =>
          backend.listPromotedActionItemIds([seed[vic].promotedActionItemId, seed[atk].promotedActionItemId]),
        )
        expect([...ids]).toEqual([seed[atk].promotedActionItemId])
      }
    })

    it('5 card create: a card on another board, or on the own board with another stack, is 404', async () => {
      for (const [atk, vic] of DIRECTIONS) {
        const onVictim = await apiCreateCard(atk, seed[vic].boardId, { stackId: seed[vic].stackIds[0], title: 'intrusion-5' })
        expect(onVictim.status).toBe(404)
        const intoVictimStack = await apiCreateCard(atk, seed[atk].boardId, { stackId: seed[vic].stackIds[0], title: 'intrusion-5b' })
        expect(intoVictimStack.status).toBe(404)
        const ownStackOnVictim = await apiCreateCard(atk, seed[vic].boardId, { stackId: seed[atk].stackIds[0], title: 'intrusion-5c' })
        expect(ownStackOnVictim.status).toBe(404)
      }
    })

    it('6 card move: another card, or an own card into another stack, is 404 and the own card stays', async () => {
      for (const [atk, vic] of DIRECTIONS) {
        const victimCardOnVictimBoard = await apiMoveCard(atk, seed[vic].boardId, { cardId: seed[vic].cardId, stackId: seed[vic].stackIds[1], order: 0 })
        expect(victimCardOnVictimBoard.status).toBe(404)
        const victimCardOnOwnBoard = await apiMoveCard(atk, seed[atk].boardId, { cardId: seed[vic].cardId, stackId: seed[atk].stackIds[1], order: 0 })
        expect(victimCardOnOwnBoard.status).toBe(404)
        const ownCardIntoVictimStack = await apiMoveCard(atk, seed[atk].boardId, { cardId: seed[atk].cardId, stackId: seed[vic].stackIds[1], order: 0 })
        expect(ownCardIntoVictimStack.status).toBe(404)
        const [stillThere] = await boardAdmin[atk]<{ stack_id: string }[]>`SELECT stack_id FROM card WHERE id = ${seed[atk].cardId}`
        expect(stillThere!.stack_id).toBe(seed[atk].stackIds[0])
      }
    })

    it('6 card edit: another card is 404 on either board, and another customer member cannot be assigned', async () => {
      for (const [atk, vic] of DIRECTIONS) {
        const victimCardOnVictimBoard = await apiEditCard(atk, seed[vic].boardId, { cardId: seed[vic].cardId, title: 'intrusion-6u', description: 'intrusion-6u' })
        expect(victimCardOnVictimBoard.status).toBe(404)
        expect(leaksNothingOf(victimCardOnVictimBoard, vic)).toEqual([])
        const victimCardOnOwnBoard = await apiEditCard(atk, seed[atk].boardId, { cardId: seed[vic].cardId, title: 'intrusion-6v', description: 'intrusion-6v' })
        expect(victimCardOnOwnBoard.status).toBe(404)
        expect(leaksNothingOf(victimCardOnOwnBoard, vic)).toEqual([])
        // an own card must not take another customer's member as its assignee: that person is no member here
        const foreignAssignee = await apiEditCard(atk, seed[atk].boardId, { cardId: seed[atk].cardId, assigneeKeycloakId: seed[vic].userId })
        expect(foreignAssignee.status).toBe(400)
        const foreignAssigneeOnCreate = await apiCreateCard(atk, seed[atk].boardId, {
          stackId: seed[atk].stackIds[0],
          title: 'intrusion-6w',
          assigneeKeycloakId: seed[vic].userId,
        })
        expect(foreignAssigneeOnCreate.status).toBe(400)
      }
      // none of it was written anywhere: no intrusion text, and no card of one customer assigned to another's member
      for (const who of WHOS) {
        for (const other of othersOf(who)) {
          expect(await countWhere(who, 'card', `title LIKE 'intrusion-6%' OR description LIKE 'intrusion-6%' OR assignee_keycloak_id = $1`, seed[other].userId)).toBe(0)
        }
      }
    })

    it('7 promote: another action item, or any item on another board, is 404', async () => {
      for (const [atk, vic] of DIRECTIONS) {
        expect((await apiPromote(atk, seed[atk].boardId, seed[vic].actionItemId)).status).toBe(404)
        expect((await apiPromote(atk, seed[vic].boardId, seed[atk].actionItemId)).status).toBe(404)
        expect((await apiPromote(atk, seed[vic].boardId, seed[vic].actionItemId)).status).toBe(404)
      }
    })

    it('8 stack create: the port refuses a stack on another board', async () => {
      const backend = getBoardBackend()
      for (const [atk, vic] of DIRECTIONS) {
        await expect(
          runWithTenant(ctx[atk], () => backend.createStack(seed[vic].boardId, { name: 'intrusion-8', order: 9 })),
        ).rejects.toBeTruthy()
        // the rejection must be the refusal, not an unrelated failure: no such stack exists in any customer's database
        for (const who of WHOS) {
          expect(await countWhere(who, 'stack', `name = 'intrusion-8'`)).toBe(0)
          const [kernelRows] = await kernelAdmin[who]<{ n: string }[]>`SELECT count(*)::text AS n FROM stack WHERE name = 'intrusion-8'`
          expect(kernelRows!.n).toBe('0')
        }
      }
    })

    it('9 board create: another org unit is refused (scope)', async () => {
      for (const [atk, vic] of DIRECTIONS) {
        expect([403, 404]).toContain((await apiCreateBoard(atk, seed[vic].ouId)).status)
        expect([403, 404]).toContain((await apiCreateBoard(atk, seed[vic].emptyOuId)).status)
      }
    })

    it('H fingerprint: every customer boards, stacks and cards are byte-identical after every attempt', async () => {
      for (const who of WHOS) expect(await fingerprint(who)).toBe(before[who])
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
