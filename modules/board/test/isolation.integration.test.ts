// modules/board/test/isolation.integration.test.ts
//
// R29-BOARD-STORE-K A7: two-tenant isolation through the board's own routes
// (TRD-060/061 at leaf level, TRD-426 routing test). Tenants A and B each get a
// (tenant, board) database t_<hex32>__board, migrated with the one runner
// (@gremion/tenant-store runMigrations, Q7). The leaf is built ONLY through the
// shipped factory buildApp(env); B is seeded through app.storeFor(B), the exact
// store function buildApp hands to the routes, so the seed lands where the
// routes read B — on the pre-change single-DB tree and after.
//
// A decoy shared database (board_test_shared, the pre-D13 BOARD_PG_URL) is set in
// the env too: the leaf must never fall back to it.
import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { buildApp } from '../src/app.ts'
import { createBoard, createCard, createStack, promoteActionItem, type Sql, type TenantRef } from '../src/store/index.ts'
import { leafApi, leafRequest } from './isolation/leaf-api.ts'
import { BOARD_ROUTE_KINDS, boardIsolationCase, type BoardRecord } from './isolation/case.ts'
import { describeFailures, runIsolation } from './isolation/harness.ts'
import type { BoardApi } from './isolation/api.ts'
import {
  connectAdmin,
  createEmptyDb,
  databaseNames,
  dropScratchDb,
  provisionDb,
  scratchDbUrl,
  scratchServerUrl,
  tenantBoardDb,
  userTableCount,
  type ScratchSql,
} from './support/scratch-pg.ts'
import { everyRouteCall } from './support/route-calls.ts'
import { TENANT_A, TENANT_B, TENANT_C } from './support/tenants.ts'

const SECRET = 'r29bk-isolation-secret'
const DECOY_DB = 'board_test_shared'

let admin: ScratchSql
let app: ReturnType<typeof buildApp>
let api: BoardApi

async function storeSql(as: TenantRef): Promise<Sql> {
  const r = await app.storeFor(as)
  if (typeof r !== 'function') throw new Error(`[isolation] app.storeFor(${as.id}) refused: ${JSON.stringify(r)}`)
  return r as Sql
}

/** Seeds one tenant through app.storeFor(tenant): a board (canary name), two stacks, a card, a promoted action item. */
async function seed(as: TenantRef): Promise<BoardRecord> {
  const sql = await storeSql(as)
  const canary = `canary-${as.slug}-${randomUUID()}`
  const orgUnitId = randomUUID()
  const board = await createBoard(sql, { orgUnitId, name: canary })
  const s1 = await createStack(sql, { boardId: board.id, name: 'To Do', order: 0 })
  const s2 = await createStack(sql, { boardId: board.id, name: 'Done', order: 1 })
  const card = await createCard(sql, { stackId: s1.id, title: canary, createdBy: 'seed' })
  const actionItemId = randomUUID()
  await promoteActionItem(sql, board.id, { id: actionItemId, text: canary, assigneeKeycloakId: null, dueDate: null }, 'seed')
  return { tenant: as, orgUnitId, boardId: board.id, stackIds: [s1.id, s2.id], cardId: card.id, actionItemId, canary }
}

beforeAll(async () => {
  admin = connectAdmin()
  await provisionDb(admin, tenantBoardDb(TENANT_A.id))
  await provisionDb(admin, tenantBoardDb(TENANT_B.id))
  await dropScratchDb(admin, tenantBoardDb(TENANT_C.id))
  await provisionDb(admin, DECOY_DB)
  app = buildApp({
    GREMION_BOARD_PG_URL: scratchServerUrl(),
    BOARD_PG_URL: scratchDbUrl(DECOY_DB),
    INTERNAL_BOARD_SECRET: SECRET,
  })
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve))
  api = leafApi(app.server, SECRET)
}, 60_000)

afterAll(async () => {
  await app?.close()
  if (admin) {
    for (const t of [TENANT_A, TENANT_B, TENANT_C]) await dropScratchDb(admin, tenantBoardDb(t.id))
    await dropScratchDb(admin, DECOY_DB)
    await admin.end({ timeout: 5 })
  }
}, 60_000)

/** A second leaf, built the same way, with its own gate (so no verdict cached by another case leaks in). */
async function freshLeaf(): Promise<ReturnType<typeof buildApp>> {
  const leaf = buildApp({
    GREMION_BOARD_PG_URL: scratchServerUrl(),
    BOARD_PG_URL: scratchDbUrl(DECOY_DB),
    INTERNAL_BOARD_SECRET: SECRET,
  })
  await new Promise<void>((resolve) => leaf.server.listen(0, '127.0.0.1', resolve))
  return leaf
}

describe('unprovisioned tenant: fail closed on every route (A3)', () => {
  it('a valid v7 tenant with no t_<hex32>__board answers 404 tenant_not_provisioned on every route, creates nothing, is never cached', async () => {
    const leaf = await freshLeaf()
    try {
      const dbC = tenantBoardDb(TENANT_C.id)
      await dropScratchDb(admin, dbC)
      const before = await databaseNames(admin)
      expect(before).not.toContain(dbC)
      for (const round of [1, 2]) {
        for (const call of everyRouteCall()) {
          const r = await leafRequest(leaf.server, SECRET, TENANT_C, call.method, call.path, call.body)
          expect({ round, route: call.route, status: r.status, body: r.body }).toEqual({
            round,
            route: call.route,
            status: 404,
            body: { success: false, error: 'tenant_not_provisioned' },
          })
          expect(r.headers['cache-control'], call.route).toBe('no-store')
        }
      }
      // no database was created, and nothing fell back to the decoy shared database
      expect(await databaseNames(admin)).toEqual(before)
      // never cached: the moment C's database exists and is current, C is served
      await provisionDb(admin, dbC)
      const ok = await leafRequest(leaf.server, SECRET, TENANT_C, 'GET', `/api/v1/boards?orgUnitId=${randomUUID()}`)
      expect(ok.status).toBe(200)
      expect(ok.body).toEqual({ data: [] })
    } finally {
      await leaf.close()
      await dropScratchDb(admin, tenantBoardDb(TENANT_C.id))
    }
  })
})

describe('schema behind: no DDL on the request path (A4, B21)', () => {
  it('a database with no ledger and no tables answers 503 schema_not_current with retry-after on every route and stays empty', async () => {
    const leaf = await freshLeaf()
    const dbC = tenantBoardDb(TENANT_C.id)
    try {
      await createEmptyDb(admin, dbC)
      expect(await userTableCount(dbC)).toBe(0)
      for (const call of everyRouteCall()) {
        const r = await leafRequest(leaf.server, SECRET, TENANT_C, call.method, call.path, call.body)
        expect({ route: call.route, status: r.status, body: r.body }).toEqual({
          route: call.route,
          status: 503,
          body: { success: false, error: 'schema_not_current' },
        })
        expect(Number(r.headers['retry-after']), call.route).toBeGreaterThan(0)
      }
      expect(await userTableCount(dbC)).toBe(0)
    } finally {
      await leaf.close()
      await dropScratchDb(admin, dbC)
    }
  })
})

describe('query-time mapping: a database dropped under a cached ok verdict (A8 at leaf level)', () => {
  it('the very next request, no sleep, answers 404 tenant_not_provisioned on every route', async () => {
    const leaf = await freshLeaf()
    const dbC = tenantBoardDb(TENANT_C.id)
    try {
      await provisionDb(admin, dbC)
      // warm: the gate caches C's ok verdict (5 s) and the store holds C's pool
      const warm = await leafRequest(leaf.server, SECRET, TENANT_C, 'GET', `/api/v1/boards?orgUnitId=${randomUUID()}`)
      expect(warm.status).toBe(200)
      await dropScratchDb(admin, dbC) // WITH (FORCE): terminates the pool's backends, as disableModule does
      for (const call of everyRouteCall()) {
        const r = await leafRequest(leaf.server, SECRET, TENANT_C, call.method, call.path, call.body)
        expect({ route: call.route, status: r.status, body: r.body }).toEqual({
          route: call.route,
          status: 404,
          body: { success: false, error: 'tenant_not_provisioned' },
        })
      }
    } finally {
      await leaf.close()
      await dropScratchDb(admin, dbC)
    }
  })

  it("the tenant's backends terminated, database still there: the next request is never a 500", async () => {
    const leaf = await freshLeaf()
    const dbC = tenantBoardDb(TENANT_C.id)
    try {
      await provisionDb(admin, dbC)
      const warm = await leafRequest(leaf.server, SECRET, TENANT_C, 'GET', `/api/v1/boards?orgUnitId=${randomUUID()}`)
      expect(warm.status).toBe(200)
      await admin`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${dbC} AND pid <> pg_backend_pid()`
      const r = await leafRequest(leaf.server, SECRET, TENANT_C, 'GET', `/api/v1/boards?orgUnitId=${randomUUID()}`)
      // either the pool reconnected (200) or the leaf refused cleanly (503 tenant_unavailable);
      // one unconditional assertion (vitest/no-conditional-expect, lint-js ratchet)
      const outcome = r.status === 200 ? { status: 200 } : { status: r.status, body: r.body }
      expect([{ status: 200 }, { status: 503, body: { success: false, error: 'tenant_unavailable' } }]).toContainEqual(
        outcome,
      )
    } finally {
      await leaf.close()
      await dropScratchDb(admin, dbC)
    }
  })
})

describe('two-tenant isolation through the board routes (A7)', () => {
  it("as A, every §3.3 vector against B's ids is refused; controls pass first", async () => {
    const report = await runIsolation(boardIsolationCase(api, seed), {
      api,
      attacker: TENANT_A,
      victim: TENANT_B,
      routes: BOARD_ROUTE_KINDS,
    })
    expect(report.controls.length, 'no positive control ran').toBeGreaterThan(0)
    expect(report.aborted, describeFailures(report)).toBeUndefined()
    expect(report.attempts.length, 'zero attempts: vacuous').toBeGreaterThan(0)
    expect(report.ok, describeFailures(report)).toBe(true)
  })
})
