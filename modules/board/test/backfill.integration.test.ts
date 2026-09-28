// services/board/test/backfill.integration.test.ts
//
// Integration tests for services/board/scripts/backfill.ts against an EPHEMERAL,
// isolated Postgres (BOARD_TEST_PG_URL). A fail-closed guard refuses any
// non-localhost host — a backfill test can NEVER read/write the live staging
// stack. The SOURCE stand-in uses the leaf schema (identical board/stack/card
// column set to the kernel's 034_deck_board.sql) so rows can be seeded without
// the kernel's cross-DB FK targets.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { runMigrations, createBoard, createStack, createCard, type Sql } from '../src/store/index.ts'
import { runBackfill } from '../scripts/backfill.ts'
import { requireEphemeralTestPgUrl, assertSafeTestEnv } from './support/pg-test-guard.ts'

const TEST_PG_URL = requireEphemeralTestPgUrl()
const TEST_DB_PREFIX = 'board_test_'
assertSafeTestEnv(TEST_PG_URL, TEST_DB_PREFIX)

const SRC_DB = 'board_test_backfill_src'
const TGT_DB = 'board_test_backfill_tgt'

function dbUrlFor(adminUrl: string, dbName: string): string {
  const u = new URL(adminUrl)
  u.pathname = '/' + dbName
  return u.toString()
}

let admin: Sql
const SRC_URL = dbUrlFor(TEST_PG_URL, SRC_DB)
const TGT_URL = dbUrlFor(TEST_PG_URL, TGT_DB)

async function dropDb(name: string): Promise<void> {
  await admin
    .unsafe(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${name}' AND pid <> pg_backend_pid()`)
    .catch(() => {})
  await admin.unsafe(`DROP DATABASE IF EXISTS "${name}"`)
}

const silent = () => {}

beforeAll(async () => {
  admin = postgres(TEST_PG_URL, { max: 1, prepare: false })
  await dropDb(SRC_DB)
  await dropDb(TGT_DB)
  await admin.unsafe(`CREATE DATABASE "${SRC_DB}"`)
  await admin.unsafe(`CREATE DATABASE "${TGT_DB}"`)

  // Seed the SOURCE (kernel stand-in) with the leaf schema + fixture rows.
  await runMigrations(SRC_URL)
  const src = postgres(SRC_URL, { max: 2, prepare: false })
  try {
    const b1 = await createBoard(src, { orgUnitId: '11111111-1111-1111-1111-111111111111', name: 'StuRa Board' })
    const b2 = await createBoard(src, { orgUnitId: '22222222-2222-2222-2222-222222222222', name: 'Referat Board', archived: true })
    const s1 = await createStack(src, { boardId: b1.id, name: 'To Do', order: 0 })
    const s2 = await createStack(src, { boardId: b1.id, name: 'Done', order: 1 })
    await createStack(src, { boardId: b2.id, name: 'Backlog', order: 0 })
    await createCard(src, { stackId: s1.id, title: 'Alpha', createdBy: 'u1' })
    await createCard(src, { stackId: s1.id, title: 'Beta', dueDate: '2026-07-15', createdBy: 'u1' })
    await createCard(src, { stackId: s2.id, title: 'Gamma', createdBy: 'u2' })
    await createCard(src, {
      stackId: s2.id,
      title: 'Delta',
      protocolActionItemId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      label: 'Sitzung',
      createdBy: 'u2',
    })
  } finally {
    await src.end()
  }
})

afterAll(async () => {
  await dropDb(SRC_DB)
  await dropDb(TGT_DB)
  await admin.end()
})

describe('runBackfill — kernel→leaf copy + verify gate', () => {
  it('copies board/stack/card FK-safe with IDs preserved and passes the verify gate', async () => {
    const result = await runBackfill({ sourceUrl: SRC_URL, targetUrl: TGT_URL, log: silent })
    expect(result.ok).toBe(true)
    expect(result.counts['board']).toEqual({ source: 2, target: 2 })
    expect(result.counts['stack']).toEqual({ source: 3, target: 3 })
    expect(result.counts['card']).toEqual({ source: 4, target: 4 })

    // IDs preserved + data intact on the target.
    const tgt = postgres(TGT_URL, { max: 2, prepare: false })
    try {
      const src = postgres(SRC_URL, { max: 2, prepare: false })
      try {
        const [srcBoards, tgtBoards] = await Promise.all([
          src<{ id: string }[]>`SELECT id FROM board ORDER BY id`,
          tgt<{ id: string }[]>`SELECT id FROM board ORDER BY id`,
        ])
        expect(tgtBoards.map((b) => b.id)).toEqual(srcBoards.map((b) => b.id))
        const promoted = await tgt<{ title: string }[]>`SELECT title FROM card WHERE protocol_action_item_id = 'cccccccc-cccc-cccc-cccc-cccccccccccc'`
        expect(promoted[0]!.title).toBe('Delta')
      } finally {
        await src.end()
      }
    } finally {
      await tgt.end()
    }
  })

  it('refuses a NON-EMPTY target (no silent merge)', async () => {
    // The target now holds the prior copy → a second copy must be refused.
    await expect(runBackfill({ sourceUrl: SRC_URL, targetUrl: TGT_URL, log: silent })).rejects.toThrow(/NON-EMPTY/)
  })

  it('verify-only re-verifies an already-backfilled target without copying', async () => {
    const result = await runBackfill({ sourceUrl: SRC_URL, targetUrl: TGT_URL, verifyOnly: true, log: silent })
    expect(result.ok).toBe(true)
    expect(result.counts['card']).toEqual({ source: 4, target: 4 })
  })

  it('refuses when source and target resolve to the SAME database', async () => {
    await expect(runBackfill({ sourceUrl: SRC_URL, targetUrl: SRC_URL, log: silent })).rejects.toThrow(/SAME database/)
  })
})
