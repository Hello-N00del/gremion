// TASK-080-a house review, findings 5-7: database-level guards of the bodies chain, proven against the REAL migrated
// schema on the scratch PG18. Each test states the failure it closes; the guard is done when it has been seen RED.
//   5  the acyclic triggers serialise re-parenting (two transactions re-parenting A->B and B->A both passed the walk)
//   6  membership.body_id is immutable; an org unit kind's may_adopt_beschluesse freezes once decided
//   7  inbox_state_times_check mirrors the outbox form; TRUNCATE is refused on the never-delete tables
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildBodiesWorld, type BodiesWorld } from '../harness/bodies-world.ts'
import type { Customer } from '../harness/scratch.ts'

let w: BodiesWorld
let C: Customer
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

beforeAll(async () => {
  w = await buildBodiesWorld('guards')
  C = await w.customer('guards-c', 'guards-c.example.org')
}, 300_000)
afterAll(async () => {
  await w?.close()
})

const admin = () => w.adminPool(C)
type PgError = { code?: string; message?: string }
/** The postgres error a statement raises, or null. */
const raises = (p: PromiseLike<unknown>): Promise<PgError | null> => Promise.resolve(p).then(() => null, (e: unknown) => e as PgError)

async function newBody(name: string): Promise<string> {
  const [r] = await admin()<{ id: string }[]>`
    INSERT INTO idt.body (customer_id, kind_key, name, created_by_kind, updated_by_kind) VALUES (${C.id}::uuid, 'stura', ${name}, 'system', 'system') RETURNING body_id::text AS id`
  return r!.id
}
async function newUnit(bodyId: string, name: string): Promise<string> {
  const [r] = await admin()<{ id: string }[]>`
    INSERT INTO idt.org_unit (customer_id, body_id, kind_key, name, created_by_kind, updated_by_kind) VALUES (${C.id}::uuid, ${bodyId}::uuid, 'committee', ${name}, 'system', 'system') RETURNING org_unit_id::text AS id`
  return r!.id
}

/**
 * Two transactions, the second started while the first still holds its uncommitted UPDATE open. Without a lock between
 * the two acyclic walks neither sees the other's row and both commit: a cycle. Returns each one's error code (null = committed).
 */
async function race(first: string, second: string): Promise<Array<string | null>> {
  let started!: () => void
  const firstRan = new Promise<void>((r) => (started = r))
  const t1 = admin().begin(async (tx) => {
    await tx.unsafe(first)
    started()
    await sleep(1_000) // hold the transaction open while the second walks
  })
  const t2 = firstRan.then(() => admin().begin(async (tx) => void (await tx.unsafe(second))))
  const settled = await Promise.allSettled([t1, t2])
  return settled.map((s) => (s.status === 'fulfilled' ? null : ((s.reason as PgError).code ?? String(s.reason))))
}

describe('finding 5: re-parenting is serialised, two concurrent transactions cannot close a cycle', () => {
  it('bodies: A->B and B->A concurrently give exactly one 23514, and the tree stays acyclic', async () => {
    const a = await newBody('Zyklus A')
    const b = await newBody('Zyklus B')
    const codes = await race(`UPDATE idt.body SET parent_body_id = '${b}' WHERE body_id = '${a}'`, `UPDATE idt.body SET parent_body_id = '${a}' WHERE body_id = '${b}'`)
    expect(codes.filter((c) => c === '23514'), JSON.stringify(codes)).toHaveLength(1)
    expect(codes.filter((c) => c === null), JSON.stringify(codes)).toHaveLength(1)
    const rows = await admin()<{ both: boolean }[]>`
      SELECT coalesce(x.parent_body_id = ${b}::uuid AND y.parent_body_id = ${a}::uuid, false) AS both FROM idt.body x, idt.body y WHERE x.body_id = ${a}::uuid AND y.body_id = ${b}::uuid`
    expect(rows).toEqual([{ both: false }])
  })

  it('org units: A->B and B->A concurrently give exactly one 23514, and the tree stays acyclic', async () => {
    const body = await newBody('Zyklus Einheiten')
    const a = await newUnit(body, 'Einheit A')
    const b = await newUnit(body, 'Einheit B')
    const codes = await race(
      `UPDATE idt.org_unit SET parent_org_unit_id = '${b}' WHERE org_unit_id = '${a}'`,
      `UPDATE idt.org_unit SET parent_org_unit_id = '${a}' WHERE org_unit_id = '${b}'`,
    )
    expect(codes.filter((c) => c === '23514'), JSON.stringify(codes)).toHaveLength(1)
    expect(codes.filter((c) => c === null), JSON.stringify(codes)).toHaveLength(1)
    const rows = await admin()<{ both: boolean }[]>`
      SELECT coalesce(x.parent_org_unit_id = ${b}::uuid AND y.parent_org_unit_id = ${a}::uuid, false) AS both FROM idt.org_unit x, idt.org_unit y WHERE x.org_unit_id = ${a}::uuid AND y.org_unit_id = ${b}::uuid`
    expect(rows).toEqual([{ both: false }])
  })

  it('sequentially the guard is unchanged: a re-parent with no cycle goes through, the closing one is refused', async () => {
    const a = await newBody('Kein Zyklus A')
    const b = await newBody('Kein Zyklus B')
    expect(await raises(admin().unsafe(`UPDATE idt.body SET parent_body_id = '${b}' WHERE body_id = '${a}'`))).toBeNull()
    expect(await raises(admin().unsafe(`UPDATE idt.body SET parent_body_id = '${a}' WHERE body_id = '${b}'`))).toMatchObject({ code: '23514' })
  })
})

describe('finding 6: membership.body_id is immutable, may_adopt_beschluesse freezes once decided', () => {
  it('moving a membership to another body is refused (its derived body_adopts_beschluesse would no longer describe its body)', async () => {
    const one = await newBody('Mitgliedschaft Eins')
    const two = await newBody('Mitgliedschaft Zwei')
    const [p] = await admin()<{ id: string }[]>`
      INSERT INTO idt.person (customer_id, display_name, email, pseudonym, created_by_kind, updated_by_kind) VALUES (${C.id}::uuid, 'Mia Mitglied', 'mia@example.org', 'p_guard_mia', 'system', 'system') RETURNING person_id::text AS id`
    const [m] = await admin()<{ id: string }[]>`
      INSERT INTO idt.membership (customer_id, body_id, person_id, participation_kind, voting, valid_from, source, created_by_kind, updated_by_kind)
      VALUES (${C.id}::uuid, ${one}::uuid, ${p!.id}::uuid, 'elected_member', true, '2026-04-01', 'admin', 'system', 'system') RETURNING membership_id::text AS id`
    const e = await raises(admin()`UPDATE idt.membership SET body_id = ${two}::uuid WHERE membership_id = ${m!.id}::uuid`)
    expect(e?.code).toBe('23514')
    expect(e?.message).toMatch(/body_id .*immutable/)
    expect(await admin()`SELECT body_id::text FROM idt.membership WHERE membership_id = ${m!.id}::uuid`).toEqual([{ body_id: one }])
    // every other column still changes, and re-stating the same body is not a move
    expect(await raises(admin()`UPDATE idt.membership SET voting = false WHERE membership_id = ${m!.id}::uuid`)).toBeNull()
    expect(await raises(admin()`UPDATE idt.membership SET body_id = ${one}::uuid WHERE membership_id = ${m!.id}::uuid`)).toBeNull()
  })

  it('a kind that is still undecided may be decided once; a decided kind never changes its answer', async () => {
    await admin().unsafe(`INSERT INTO idt.org_unit_kind (kind_key, customer_id, level, label_de, label_en, origin, created_by_kind, updated_by_kind)
      VALUES ('guard_kind', '${C.id}', 'unit', 'Waechter', 'Guard', 'customer_defined', 'system', 'system')`)
    expect(await raises(admin().unsafe(`UPDATE idt.org_unit_kind SET label_en = 'Guard 2' WHERE kind_key = 'guard_kind'`))).toBeNull()
    expect(await raises(admin().unsafe(`UPDATE idt.org_unit_kind SET may_adopt_beschluesse = 'yes' WHERE kind_key = 'guard_kind'`))).toBeNull() // undecided -> decided
    for (const to of ['no', 'undecided']) {
      const e = await raises(admin().unsafe(`UPDATE idt.org_unit_kind SET may_adopt_beschluesse = '${to}' WHERE kind_key = 'guard_kind'`))
      expect(e?.code, to).toBe('23514')
      expect(e?.message).toMatch(/may_adopt_beschluesse .*decided/)
    }
    expect(await admin()`SELECT may_adopt_beschluesse FROM idt.org_unit_kind WHERE kind_key = 'guard_kind'`).toEqual([{ may_adopt_beschluesse: 'yes' }])
    // a vendor kind seeded as decided is frozen the same way; re-stating the same answer is not a change
    expect(await raises(admin().unsafe(`UPDATE idt.org_unit_kind SET may_adopt_beschluesse = 'no' WHERE kind_key = 'stura'`))).toMatchObject({ code: '23514' })
    expect(await raises(admin().unsafe(`UPDATE idt.org_unit_kind SET may_adopt_beschluesse = 'yes' WHERE kind_key = 'stura'`))).toBeNull()
  })
})
