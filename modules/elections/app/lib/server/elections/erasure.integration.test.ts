// TRD-196 / PRD-OPS-005 — DB-backed proof of the elections erasure hook against the
// real kernel schema (committee_elections): the organiser is pseudonymised, every
// election row (Helios uuid, org-unit link, archive state) survives, other
// people's elections are untouched.
import { beforeEach, describe, expect, it } from 'vitest'
import { getDb } from '$lib/server/db'
import { electionsErasureHook, ELECTIONS_ERASED_UUID } from './erasure'

const SUBJECT = '0b5f0e9c-3a56-4f3a-9a7a-1d8f0a2b7c01'
const OTHER = '0b5f0e9c-3a56-4f3a-9a7a-1d8f0a2b7c02'

beforeEach(async () => {
  await getDb()`TRUNCATE org_units CASCADE`
})

async function seed() {
  const sql = getDb()
  const [unit] = await sql<{ id: string }[]>`INSERT INTO org_units (name, kind) VALUES ('Wahl-Gremium', 'committee') RETURNING id`
  const el = (helios: string, by: string, archived: boolean) =>
    sql`INSERT INTO committee_elections (helios_uuid, org_unit_id, created_by, archived_at)
        VALUES (${helios}, ${unit.id}, ${by}, ${archived ? sql`now()` : null})`
  await el('helios-1', SUBJECT, false)
  await el('helios-2', SUBJECT, true)
  await el('helios-3', OTHER, false)
}

describe('electionsErasureHook (real schema)', () => {
  it('pseudonymises the organiser on live and archived elections, deletes nothing', async () => {
    await seed()
    const sql = getDb()
    const res = await electionsErasureHook.erase({ tenantId: 't', subjectId: SUBJECT, db: sql })
    expect(res).toEqual({ status: 'erased', counts: { committee_elections: 2 } })

    const rows = await sql<{ helios_uuid: string; created_by: string; archived: boolean }[]>`
      SELECT helios_uuid, created_by::text, archived_at IS NOT NULL AS archived FROM committee_elections ORDER BY helios_uuid`
    expect(rows).toEqual([
      { helios_uuid: 'helios-1', created_by: ELECTIONS_ERASED_UUID, archived: false },
      { helios_uuid: 'helios-2', created_by: ELECTIONS_ERASED_UUID, archived: true },
      { helios_uuid: 'helios-3', created_by: OTHER, archived: false },
    ])
  })

  it('a subject id that is not a uuid matches nothing and does not error', async () => {
    await seed()
    const res = await electionsErasureHook.erase({ tenantId: 't', subjectId: 'not-a-uuid', db: getDb() })
    expect(res).toEqual({ status: 'erased', counts: { committee_elections: 0 } })
  })

  it('is idempotent', async () => {
    await seed()
    const sql = getDb()
    await electionsErasureHook.erase({ tenantId: 't', subjectId: SUBJECT, db: sql })
    expect(await electionsErasureHook.erase({ tenantId: 't', subjectId: SUBJECT, db: sql })).toEqual({
      status: 'erased',
      counts: { committee_elections: 0 },
    })
  })
})
