// TRD-196 / PRD-OPS-005 — DB-backed proof of the board erasure hook against the
// real kernel schema (migration 0034: board / stack / card).
import { beforeEach, describe, expect, it } from 'vitest'
import { getDb } from '$lib/server/db'
import { boardErasureHook, BOARD_ERASED_MARKER } from './erasure'

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
})

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
})
