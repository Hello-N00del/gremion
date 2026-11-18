// TRD-196 / PRD-OPS-005 — DB-backed proof of the board erasure hook against the
// real kernel schema (migration 0034: board / stack / card).
import { createServer } from 'node:http'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDb } from '$lib/server/db'
import { deleteOrgUnit } from '$lib/server/governance/org-units-db'
import { registerDataProvider, _resetRuntimeRegistryForTests } from '$lib/server/modules/runtime-registry'
import { runWithTenant, type TenantContext } from '$lib/server/tenant/context'
import { boardErasureHook, BOARD_ERASED_MARKER, deleteBoardsOfOrgUnit } from './erasure'
import { resetBoardLocationCacheForTests } from './backend/location'

const SUBJECT = 'kc-board-subject'
const OTHER = 'kc-board-other'

async function seed() {
  const sql = getDb()
  const [unit] = await sql<{ id: string }[]>`INSERT INTO org_units (name, kind) VALUES ('Board-Gremium', 'committee') RETURNING id`
  const [board] = await sql<{ id: string }[]>`INSERT INTO board (org_unit_id, name) VALUES (${unit.id}, 'Aufgaben') RETURNING id`
  const [stack] = await sql<{ id: string }[]>`INSERT INTO stack (board_id, name) VALUES (${board.id}, 'To do') RETURNING id`
  const card = (title: string, assignee: string | null, createdBy: string | null) =>
    sql`INSERT INTO card (stack_id, title, assignee_keycloak_id, created_by) VALUES (${stack.id}, ${title}, ${assignee}, ${createdBy})`
  await card('assigned to subject, made by other', SUBJECT, OTHER)
  await card('made by subject, assigned to other', OTHER, SUBJECT)
  await card('both subject', SUBJECT, SUBJECT)
  await card('unrelated', OTHER, OTHER)
  await card('unowned', null, null)
}

beforeEach(async () => {
  await getDb()`TRUNCATE org_units CASCADE`
  await getDb()`DELETE FROM board_location`
  resetBoardLocationCacheForTests()
})

afterAll(async () => {
  await getDb()`DELETE FROM board_location`
  resetBoardLocationCacheForTests()
})

// The board lives in its own database: the hook asks the leaf (a stub here, the leaf has its own
// suite) and reports the leaf's counts. The kernel copy is not the board any more, but a move leaves it
// behind and it holds the id too, so the hook erases it as well, in the same pass.
async function withLeaf<T>(status: number, body: unknown, fn: (seen: { path: string; secret: string | undefined; tenant: string | undefined; body: string }[]) => Promise<T>): Promise<T> {
  const seen: { path: string; secret: string | undefined; tenant: string | undefined; body: string }[] = []
  const srv = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      seen.push({
        path: `${req.method} ${req.url}`,
        secret: req.headers['x-internal-auth'] as string | undefined,
        tenant: req.headers['x-tenant-id'] as string | undefined,
        body: Buffer.concat(chunks).toString('utf8'),
      })
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    })
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  const prev = { url: process.env.BOARD_SERVICE_URL, secret: process.env.INTERNAL_BOARD_SECRET }
  process.env.BOARD_SERVICE_URL = `http://127.0.0.1:${(srv.address() as { port: number }).port}`
  process.env.INTERNAL_BOARD_SECRET = 'erasure-test-secret'
  try {
    return await fn(seen)
  } finally {
    process.env.BOARD_SERVICE_URL = prev.url
    process.env.INTERNAL_BOARD_SECRET = prev.secret
    if (prev.url === undefined) delete process.env.BOARD_SERVICE_URL
    if (prev.secret === undefined) delete process.env.INTERNAL_BOARD_SECRET
    await new Promise<void>((r) => srv.close(() => r()))
  }
}
const asTenant = <T>(fn: () => Promise<T>) => runWithTenant({ id: 't', slug: 't' } as unknown as TenantContext, fn)

describe('boardErasureHook (real schema)', () => {
  it('unassigns and pseudonymises the subject, keeps every card, leaves others untouched', async () => {
    await seed()
    const sql = getDb()
    const res = await boardErasureHook.erase({ tenantId: 't', subjectId: SUBJECT, db: sql })
    expect(res).toEqual({ status: 'erased', counts: { card_assignee: 2, card_created_by: 2 } })

    expect(await sql`SELECT 1 FROM card WHERE assignee_keycloak_id = ${SUBJECT} OR created_by = ${SUBJECT}`).toHaveLength(0)
    expect(await sql`SELECT 1 FROM card`).toHaveLength(5)
    const byTitle = Object.fromEntries(
      (await sql<{ title: string; assignee_keycloak_id: string | null; created_by: string | null }[]>`SELECT title, assignee_keycloak_id, created_by FROM card`).map((r) => [r.title, r]),
    )
    expect(byTitle['assigned to subject, made by other']).toMatchObject({ assignee_keycloak_id: null, created_by: OTHER })
    expect(byTitle['made by subject, assigned to other']).toMatchObject({ assignee_keycloak_id: OTHER, created_by: BOARD_ERASED_MARKER })
    expect(byTitle['both subject']).toMatchObject({ assignee_keycloak_id: null, created_by: BOARD_ERASED_MARKER })
    expect(byTitle['unrelated']).toMatchObject({ assignee_keycloak_id: OTHER, created_by: OTHER })
    expect(byTitle['unowned']).toMatchObject({ assignee_keycloak_id: null, created_by: null })
  })

  it('is idempotent: a re-run erases nothing and still reports erased with zero counts', async () => {
    await seed()
    const sql = getDb()
    await boardErasureHook.erase({ tenantId: 't', subjectId: SUBJECT, db: sql })
    const again = await boardErasureHook.erase({ tenantId: 't', subjectId: SUBJECT, db: sql })
    expect(again).toEqual({ status: 'erased', counts: { card_assignee: 0, card_created_by: 0 } })
  })

  it('with the location flag at module the hook calls the board leaf, reports its counts, and leaves no kernel card holding the subject', async () => {
    await seed()
    const sql = getDb()
    await sql`INSERT INTO board_location (id, location) VALUES (true, 'module')`
    await withLeaf(200, { counts: { card_assignee: 6, card_created_by: 7 } }, async (seen) => {
      const res = await asTenant(() => boardErasureHook.erase({ tenantId: 't', subjectId: SUBJECT, db: sql }))
      expect(res).toEqual({
        status: 'erased',
        counts: { card_assignee: 6, card_created_by: 7, card_assignee_kernel_copy: 2, card_created_by_kernel_copy: 2 },
      })
      expect(seen).toHaveLength(1)
      expect(seen[0]).toMatchObject({ path: 'POST /api/v1/erase-subject', secret: 'erasure-test-secret', tenant: 't' })
      expect(JSON.parse(seen[0]!.body)).toEqual({ subjectId: SUBJECT })
    })
    // the old copy in the kernel tables does not keep the person; every card stays and the others are untouched
    expect(await sql`SELECT 1 FROM card WHERE assignee_keycloak_id = ${SUBJECT} OR created_by = ${SUBJECT}`).toHaveLength(0)
    expect(await sql`SELECT 1 FROM card`).toHaveLength(5)
    expect(await sql`SELECT 1 FROM card WHERE assignee_keycloak_id = ${OTHER} OR created_by = ${OTHER}`).toHaveLength(3)
  })

  // The flip of a move takes a table lock, writes the flag and commits. An erasure that read the flag as
  // 'moving' and then queued its updates behind that lock runs them against the OLD copy once the flip has
  // committed; the board is in the module database by then, so only a flag read AFTER the updates reaches it.
  it('an erasure whose updates wait behind the flip of a move still reaches the module database', async () => {
    await seed()
    const sql = getDb()
    await sql`INSERT INTO board_location (id, location) VALUES (true, 'moving')`
    const locker = await sql.reserve()
    try {
      await withLeaf(200, { counts: { card_assignee: 1, card_created_by: 1 } }, async (seen) => {
        await locker`BEGIN`
        await locker`LOCK TABLE card IN SHARE ROW EXCLUSIVE MODE`
        const erasing = asTenant(() => boardErasureHook.erase({ tenantId: 't', subjectId: SUBJECT, db: sql }))
        // wait until the hook's update is really queued behind the lock (no guessing with a sleep)
        const deadline = Date.now() + 10_000
        for (;;) {
          const waiting = await locker`
            SELECT 1 FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
             WHERE c.relname = 'card' AND NOT l.granted`
          if (waiting.length > 0) break
          if (Date.now() > deadline) throw new Error('the erasure never queued behind the lock')
          await new Promise((r) => setTimeout(r, 25))
        }
        await locker`UPDATE board_location SET location = 'module', changed_at = now()`
        await locker`COMMIT`
        const res = await erasing
        expect(res.status).toBe('erased')
        expect(seen.map((s) => s.path)).toEqual(['POST /api/v1/erase-subject'])
      })
    } finally {
      await locker`ROLLBACK`.catch(() => undefined)
      locker.release()
    }
  })

  it('with the flag at module and the leaf answering 404 tenant_not_provisioned (blocked database) the hook is deferred, never erased', async () => {
    await seed()
    const sql = getDb()
    await sql`INSERT INTO board_location (id, location) VALUES (true, 'module')`
    await withLeaf(404, { success: false, error: 'tenant_not_provisioned' }, async () => {
      const res = await asTenant(() => boardErasureHook.erase({ tenantId: 't', subjectId: SUBJECT, db: sql }))
      expect(res.status).toBe('deferred')
    })
    // the kernel copy was erased before the leaf was asked, and stays so
    expect(await sql`SELECT 1 FROM card WHERE assignee_keycloak_id = ${SUBJECT} OR created_by = ${SUBJECT}`).toHaveLength(0)
  })

  it('with the flag at module and the leaf answering 500 the hook throws', async () => {
    await seed()
    const sql = getDb()
    await sql`INSERT INTO board_location (id, location) VALUES (true, 'module')`
    await withLeaf(500, { success: false, error: 'internal error' }, async () => {
      await expect(asTenant(() => boardErasureHook.erase({ tenantId: 't', subjectId: SUBJECT, db: sql }))).rejects.toThrow(/500/)
    })
  })

  it('with the flag at moving the kernel copy still serves, so the hook erases', async () => {
    await seed()
    const sql = getDb()
    await sql`INSERT INTO board_location (id, location) VALUES (true, 'moving')`
    const res = await boardErasureHook.erase({ tenantId: 't', subjectId: SUBJECT, db: sql })
    expect(res.status).toBe('erased')
    expect(await sql`SELECT 1 FROM card WHERE assignee_keycloak_id = ${SUBJECT} OR created_by = ${SUBJECT}`).toHaveLength(0)
  })
})

// The org-unit cascade, against the real kernel schema: deleteOrgUnit(id) removes the org unit and, while
// the boards live in the kernel tables, the database cascade removes them with it; the board module's
// provider then has nothing to call. Once the flag says module, the same delete asks the leaf.
describe('org-unit delete and the boards (real schema)', () => {

  async function seedUnitWithBoard(): Promise<string> {
    const sql = getDb()
    const [unit] = await sql<{ id: string }[]>`INSERT INTO org_units (name, kind) VALUES ('Board-Gremium', 'committee') RETURNING id`
    const [board] = await sql<{ id: string }[]>`INSERT INTO board (org_unit_id, name) VALUES (${unit!.id}, 'Aufgaben') RETURNING id`
    const [stack] = await sql<{ id: string }[]>`INSERT INTO stack (board_id, name) VALUES (${board!.id}, 'To do') RETURNING id`
    await sql`INSERT INTO card (stack_id, title) VALUES (${stack!.id}, 'Karte')`
    return unit!.id
  }

  beforeEach(() => {
    registerDataProvider('board:delete-org-unit-boards', deleteBoardsOfOrgUnit)
  })
  afterEach(() => {
    _resetRuntimeRegistryForTests()
  })

  it('flag kernel (no row): the cascade removes the boards, stacks and cards, and the leaf is not called', async () => {
    const id = await seedUnitWithBoard()
    const sql = getDb()
    await withLeaf(200, { deleted: 1 }, async (seen) => {
      await deleteOrgUnit(id)
      expect(seen).toHaveLength(0)
    })
    expect(await sql`SELECT 1 FROM board`).toHaveLength(0)
    expect(await sql`SELECT 1 FROM stack`).toHaveLength(0)
    expect(await sql`SELECT 1 FROM card`).toHaveLength(0)
  })

  it('flag module: after the delete commits the leaf is asked to delete that org unit\'s boards', async () => {
    const id = await seedUnitWithBoard()
    const sql = getDb()
    await sql`INSERT INTO board_location (id, location) VALUES (true, 'module')`
    await withLeaf(200, { deleted: 1 }, async (seen) => {
      await deleteOrgUnit(id)
      expect(seen.map((s) => s.path)).toEqual([`DELETE /api/v1/org-units/${id}/boards`])
    })
    expect(await sql`SELECT 1 FROM org_units WHERE id = ${id}`).toHaveLength(0)
  })

  it('flag module, leaf down: the org unit is still deleted and the delete does not fail', async () => {
    const id = await seedUnitWithBoard()
    const sql = getDb()
    await sql`INSERT INTO board_location (id, location) VALUES (true, 'module')`
    await withLeaf(500, { success: false, error: 'internal error' }, async () => {
      await expect(deleteOrgUnit(id)).resolves.toBeUndefined()
    })
    expect(await sql`SELECT 1 FROM org_units WHERE id = ${id}`).toHaveLength(0)
  })

  it('flag module, board database blocked: the org unit is deleted, and the cleanup that is owed is warned about without the id', async () => {
    const id = await seedUnitWithBoard()
    const sql = getDb()
    await sql`INSERT INTO board_location (id, location) VALUES (true, 'module')`
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await withLeaf(404, { success: false, error: 'tenant_not_provisioned' }, async () => {
        await expect(deleteOrgUnit(id)).resolves.toBeUndefined()
      })
      const warned = warn.mock.calls.flat().join(' ')
      expect(warned).toMatch(/board/i)
      expect(warned).not.toContain(id)
    } finally {
      warn.mockRestore()
    }
    expect(await sql`SELECT 1 FROM org_units WHERE id = ${id}`).toHaveLength(0)
  })

  it('flag module, deleteOrgUnit(tx, id): the leaf is never asked, even though the transaction commits', async () => {
    const id = await seedUnitWithBoard()
    const sql = getDb()
    await sql`INSERT INTO board_location (id, location) VALUES (true, 'module')`
    await withLeaf(200, { deleted: 1 }, async (seen) => {
      await sql.begin(async (tx) => deleteOrgUnit(tx as never, id))
      expect(seen).toHaveLength(0)
    })
  })
})
