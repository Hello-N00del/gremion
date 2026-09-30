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
import { leafApi } from './isolation/leaf-api.ts'
import { boardIsolationCase, type BoardRecord } from './isolation/case.ts'
import { describeFailures, runIsolation } from './isolation/harness.ts'
import type { BoardApi } from './isolation/api.ts'
import {
  connectAdmin,
  dropScratchDb,
  provisionDb,
  scratchDbUrl,
  scratchServerUrl,
  tenantBoardDb,
  type ScratchSql,
} from './support/scratch-pg.ts'
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

describe('two-tenant isolation through the board routes (A7)', () => {
  it("as A, every §3.3 vector against B's ids is refused; controls pass first", async () => {
    const report = await runIsolation(boardIsolationCase(api, seed), { api, attacker: TENANT_A, victim: TENANT_B })
    expect(report.controls.length, 'no positive control ran').toBeGreaterThan(0)
    expect(report.aborted, describeFailures(report)).toBeUndefined()
    expect(report.attempts.length, 'zero attempts: vacuous').toBeGreaterThan(0)
    expect(report.ok, describeFailures(report)).toBe(true)
  })
})
