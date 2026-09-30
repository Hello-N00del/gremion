// services/board/test/api.integration.test.ts
//
// Integration tests for services/board/src/http/routes.ts. Each test drives an
// in-process node:http server backed by a REAL board leaf store on an EPHEMERAL,
// isolated Postgres (BOARD_TEST_PG_URL). A fail-closed guard refuses to run
// unless the host is localhost/127.0.0.1 — a test run can NEVER touch the live
// staging stack. The test creates + drops its own board_test_api database.
import http from 'node:http'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import { createServer } from '../src/http/server.ts'
import { buildApiRoutes } from '../src/http/routes.ts'
import { runMigrations, createBoard, createStack, type Sql } from '../src/store/index.ts'
import { requireEphemeralTestPgUrl, assertSafeTestEnv } from './support/pg-test-guard.ts'
import { TENANT_A } from './support/tenants.ts'

// -- fail-closed guard --------------------------------------------------------

const TEST_PG_URL = requireEphemeralTestPgUrl()
const TEST_DB_PREFIX = 'board_test_'
assertSafeTestEnv(TEST_PG_URL, TEST_DB_PREFIX)

const TEST_DB = 'board_test_api'
const TEST_SECRET = 'test-board-secret-123'

function dbUrlFor(adminUrl: string, dbName: string): string {
  const u = new URL(adminUrl)
  u.pathname = '/' + dbName
  return u.toString()
}

// -- HTTP helpers -------------------------------------------------------------

// A fixed canonical UUIDv7 fixture tenant: the guard refuses any other id shape.
const TENANT = TENANT_A

// org_unit_id / stack_id columns are UUID (mirrors the kernel 034 schema), so
// fixtures MUST use real UUIDs, not readable slugs.
const OU1 = '11111111-1111-1111-1111-111111111111'
const OU2 = '22222222-2222-2222-2222-222222222222'
const MISSING_UUID = '00000000-0000-0000-0000-000000000000'

function guardHeaders(): Record<string, string> {
  return {
    'x-internal-auth': TEST_SECRET,
    'x-tenant-id': TENANT.id,
    'x-tenant-slug': TENANT.slug,
    'content-type': 'application/json',
  }
}

interface FetchResult {
  status: number
  body: unknown
}

async function callServer(
  srv: http.Server,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<FetchResult> {
  const addr = srv.address()
  if (!addr || typeof addr === 'string') throw new Error('server not listening')
  const port = addr.port
  return new Promise<FetchResult>((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          ...headers,
          ...(payload !== undefined ? { 'content-length': Buffer.byteLength(payload).toString() } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8')
          let parsed: unknown
          try {
            parsed = JSON.parse(raw)
          } catch {
            parsed = raw
          }
          resolve({ status: res.statusCode ?? 0, body: parsed })
        })
      },
    )
    req.on('error', reject)
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

// -- setup --------------------------------------------------------------------

let admin: Sql
let sql: Sql
let server: http.Server

async function dropTestDb(pgSql: Sql): Promise<void> {
  await pgSql
    .unsafe(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${TEST_DB}' AND pid <> pg_backend_pid()`)
    .catch(() => {})
  await pgSql.unsafe(`DROP DATABASE IF EXISTS "${TEST_DB}"`)
}

beforeAll(async () => {
  admin = postgres(TEST_PG_URL, { max: 1, prepare: false })
  await dropTestDb(admin)
  await admin.unsafe(`CREATE DATABASE "${TEST_DB}"`)

  const testUrl = dbUrlFor(TEST_PG_URL, TEST_DB)
  await runMigrations(testUrl)
  sql = postgres(testUrl, { max: 4, prepare: true })

  const routes = buildApiRoutes(() => Promise.resolve(sql))
  server = createServer({ secret: TEST_SECRET, routes })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await sql.end().catch(() => {})
  await dropTestDb(admin)
  await admin.end()
})

beforeEach(async () => {
  await sql`DELETE FROM card`
  await sql`DELETE FROM stack`
  await sql`DELETE FROM board`
})

// -- /healthz (guard-exempt) --------------------------------------------------

describe('GET /healthz', () => {
  it('returns 200 without any auth headers', async () => {
    const r = await callServer(server, 'GET', '/healthz', {})
    expect(r.status).toBe(200)
    expect((r.body as Record<string, unknown>)['status']).toBe('ok')
  })
})

// -- guard --------------------------------------------------------------------

describe('guard', () => {
  it('returns 403 without x-internal-auth', async () => {
    const r = await callServer(server, 'GET', '/api/v1/boards', { 'x-tenant-id': TENANT.id, 'x-tenant-slug': TENANT.slug })
    expect(r.status).toBe(403)
  })
  it('returns 400 with missing x-tenant-id', async () => {
    const r = await callServer(server, 'GET', '/api/v1/boards', { 'x-internal-auth': TEST_SECRET, 'x-tenant-slug': TENANT.slug })
    expect(r.status).toBe(400)
  })
})

// -- boards -------------------------------------------------------------------

describe('GET /api/v1/boards', () => {
  it('returns only boards in the requested org-unit scope', async () => {
    await createBoard(sql, { orgUnitId: OU1, name: 'StuRa' })
    await createBoard(sql, { orgUnitId: OU2, name: 'Other' })
    const r = await callServer(server, 'GET', `/api/v1/boards?orgUnitId=${OU1}`, guardHeaders())
    expect(r.status).toBe(200)
    const data = (r.body as { data: { org_unit_id: string }[] }).data
    expect(data).toHaveLength(1)
    expect(data[0]!.org_unit_id).toBe(OU1)
  })

  it('returns [] when no org-unit scope is passed', async () => {
    await createBoard(sql, { orgUnitId: OU1, name: 'StuRa' })
    const r = await callServer(server, 'GET', '/api/v1/boards', guardHeaders())
    expect(r.status).toBe(200)
    expect((r.body as { data: unknown[] }).data).toEqual([])
  })
})

describe('GET /api/v1/boards/:id', () => {
  it('returns a board by id', async () => {
    const b = await createBoard(sql, { orgUnitId: OU1, name: 'StuRa' })
    const r = await callServer(server, 'GET', `/api/v1/boards/${b.id}`, guardHeaders())
    expect(r.status).toBe(200)
    expect((r.body as { id: string }).id).toBe(b.id)
  })
  it('returns 404 for an unknown board', async () => {
    const r = await callServer(server, 'GET', '/api/v1/boards/00000000-0000-0000-0000-000000000000', guardHeaders())
    expect(r.status).toBe(404)
  })
})

describe('GET /api/v1/boards/:id/deck', () => {
  it('returns board + stacks + cards', async () => {
    const b = await createBoard(sql, { orgUnitId: OU1, name: 'StuRa' })
    const s = await createStack(sql, { boardId: b.id, name: 'To Do', order: 0 })
    await callServer(server, 'POST', '/api/v1/cards', guardHeaders(), { stackId: s.id, title: 'Card A', createdBy: 'u1' })
    const r = await callServer(server, 'GET', `/api/v1/boards/${b.id}/deck`, guardHeaders())
    expect(r.status).toBe(200)
    const deck = r.body as { board: { id: string }; stacks: unknown[]; cards: unknown[] }
    expect(deck.board.id).toBe(b.id)
    expect(deck.stacks).toHaveLength(1)
    expect(deck.cards).toHaveLength(1)
  })
  it('returns 404 for an unknown board deck', async () => {
    const r = await callServer(server, 'GET', '/api/v1/boards/00000000-0000-0000-0000-000000000000/deck', guardHeaders())
    expect(r.status).toBe(404)
  })
})

// -- cards --------------------------------------------------------------------

describe('POST /api/v1/cards', () => {
  it('creates a card and returns 201', async () => {
    const b = await createBoard(sql, { orgUnitId: OU1, name: 'StuRa' })
    const s = await createStack(sql, { boardId: b.id, name: 'To Do', order: 0 })
    const r = await callServer(server, 'POST', '/api/v1/cards', guardHeaders(), { stackId: s.id, title: 'Neu', createdBy: 'u1' })
    expect(r.status).toBe(201)
    expect((r.body as { title: string }).title).toBe('Neu')
  })
  it('returns 400 on a missing title', async () => {
    const b = await createBoard(sql, { orgUnitId: OU1, name: 'StuRa' })
    const s = await createStack(sql, { boardId: b.id, name: 'To Do', order: 0 })
    const r = await callServer(server, 'POST', '/api/v1/cards', guardHeaders(), { stackId: s.id })
    expect(r.status).toBe(400)
  })
})

describe('PATCH /api/v1/cards/:id/move', () => {
  it('moves a card to another stack', async () => {
    const b = await createBoard(sql, { orgUnitId: OU1, name: 'StuRa' })
    const s1 = await createStack(sql, { boardId: b.id, name: 'To Do', order: 0 })
    const s2 = await createStack(sql, { boardId: b.id, name: 'Done', order: 1 })
    const created = await callServer(server, 'POST', '/api/v1/cards', guardHeaders(), { stackId: s1.id, title: 'X', createdBy: 'u1' })
    const cardId = (created.body as { id: string }).id
    const r = await callServer(server, 'PATCH', `/api/v1/cards/${cardId}/move`, guardHeaders(), { stackId: s2.id, order: 0 })
    expect(r.status).toBe(200)
    expect((r.body as { stack_id: string }).stack_id).toBe(s2.id)
  })
  it('returns 404 moving an unknown card', async () => {
    const r = await callServer(server, 'PATCH', `/api/v1/cards/${MISSING_UUID}/move`, guardHeaders(), { stackId: OU1, order: 0 })
    expect(r.status).toBe(404)
  })
})

// -- promote ------------------------------------------------------------------

describe('POST /api/v1/boards/:id/promote', () => {
  it('promotes a resolved action item into the first stack as a "Sitzung" card (201) and is idempotent', async () => {
    const b = await createBoard(sql, { orgUnitId: OU1, name: 'StuRa' })
    await createStack(sql, { boardId: b.id, name: 'To Do', order: 0 })
    const item = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', text: 'Do the thing', assigneeKeycloakId: null, dueDate: null }
    const r1 = await callServer(server, 'POST', `/api/v1/boards/${b.id}/promote`, guardHeaders(), { item, createdBy: 'u1' })
    expect(r1.status).toBe(201)
    expect((r1.body as { label: string }).label).toBe('Sitzung')
    // idempotent — the partial unique index means a second promote does not duplicate.
    const r2 = await callServer(server, 'POST', `/api/v1/boards/${b.id}/promote`, guardHeaders(), { item, createdBy: 'u1' })
    expect(r2.status).toBe(201)
    const count = await sql<{ c: string }[]>`SELECT COUNT(*) AS c FROM card WHERE protocol_action_item_id = ${item.id}`
    expect(Number(count[0]!.c)).toBe(1)
  })

  it('returns 409 when the board has no stacks', async () => {
    const b = await createBoard(sql, { orgUnitId: OU1, name: 'StuRa' })
    const item = { id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', text: 'x', assigneeKeycloakId: null, dueDate: null }
    const r = await callServer(server, 'POST', `/api/v1/boards/${b.id}/promote`, guardHeaders(), { item, createdBy: 'u1' })
    expect(r.status).toBe(409)
  })
})

// -- promoted id-set (#384, #387) -----------------------------------------------

describe('POST /api/v1/cards/promoted', () => {
  const AI_PROMOTED = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
  const AI_OPEN = 'dddddddd-dddd-dddd-dddd-dddddddddddd'

  it('returns exactly the subset of the supplied action-item ids that have a card', async () => {
    const b = await createBoard(sql, { orgUnitId: OU1, name: 'StuRa' })
    await createStack(sql, { boardId: b.id, name: 'To Do', order: 0 })
    const item = { id: AI_PROMOTED, text: 'Promoted', assigneeKeycloakId: null, dueDate: null }
    await callServer(server, 'POST', `/api/v1/boards/${b.id}/promote`, guardHeaders(), { item, createdBy: 'u1' })

    const r = await callServer(
      server,
      'POST',
      '/api/v1/cards/promoted',
      guardHeaders(),
      { candidateIds: [AI_PROMOTED, AI_OPEN] },
    )
    expect(r.status).toBe(200)
    expect((r.body as { data: string[] }).data).toEqual([AI_PROMOTED])
  })

  it('returns an empty set for an empty candidate list', async () => {
    const r = await callServer(server, 'POST', '/api/v1/cards/promoted', guardHeaders(), {
      candidateIds: [],
    })
    expect(r.status).toBe(200)
    expect((r.body as { data: string[] }).data).toEqual([])
  })

  it('400s when candidateIds is missing or not an array of strings', async () => {
    const missing = await callServer(server, 'POST', '/api/v1/cards/promoted', guardHeaders(), {})
    expect(missing.status).toBe(400)
    const wrongType = await callServer(server, 'POST', '/api/v1/cards/promoted', guardHeaders(), {
      candidateIds: 'not-an-array',
    })
    expect(wrongType.status).toBe(400)
  })

  it('is guarded like every other route (403 without the secret)', async () => {
    const r = await callServer(
      server,
      'POST',
      '/api/v1/cards/promoted',
      { 'x-tenant-id': TENANT.id, 'x-tenant-slug': TENANT.slug, 'content-type': 'application/json' },
      { candidateIds: [] },
    )
    expect(r.status).toBe(403)
  })
})
