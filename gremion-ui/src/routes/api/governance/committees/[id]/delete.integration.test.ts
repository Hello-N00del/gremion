// delete.integration.test.ts -- DELETE /api/governance/committees/[id] against a real DB.
//
// A body that still has records the database refuses to orphan (minutes and the
// resolutions under them, elections, sub-groups, roster rows) must be refused
// with a clean 409 and a German message that names what hangs on it. The refusal
// comes BEFORE the external teardown (Keycloak group, Nextcloud folder, Matrix
// room), so nothing is half-deleted. Only the external teardown is faked; the
// handler, the guards and every SQL statement are the real ones.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getDb } from '$lib/server/db'
import { createOrgUnit, getOrgUnit } from '$lib/server/governance/org-units-db'
import { Role } from '$lib/auth/types'
import { actor } from '$lib/server/audit-test-actor'

const h = vi.hoisted(() => ({
  deprovision: vi.fn(async (unitId: string) => ({ unitId, subsystems: [] as Array<{ status: string }> })),
}))
vi.mock('$lib/server/governance/provisioning/orchestrator', () => ({
  deprovisionOrgUnit: h.deprovision,
  addMember: vi.fn(),
}))

import { DELETE } from './+server'

const ADMIN = { id: actor('council-admin'), roles: [Role.CouncilAdmin] }

async function makeUnit(name: string, parentId: string | null = null) {
  return createOrgUnit({
    name, description: null, parentId, kind: 'committee',
    visibility: 'all_members', wantsMatrixRoom: false, wantsNextcloudFolder: false,
  })
}

async function del(id: string): Promise<{ status: number; body: { success: boolean; error?: string } }> {
  const res = await DELETE({ params: { id }, locals: { auth: async () => ({ user: ADMIN }) } } as never)
  return { status: res.status, body: (await res.json()) as { success: boolean; error?: string } }
}

async function addMinutes(unitId: string): Promise<string> {
  const rows = await getDb()<{ id: string }[]>`
    INSERT INTO protocols (committee_id, meeting_date, title, created_by)
    VALUES (${unitId}, '2026-11-01', 'Sitzung', ${ADMIN.id}) RETURNING id`
  return rows[0].id
}

describe('DELETE /api/governance/committees/[id] (integration)', () => {
  beforeEach(async () => {
    h.deprovision.mockClear()
    const sql = getDb()
    await sql`TRUNCATE audit_log RESTART IDENTITY CASCADE`
    await sql`TRUNCATE org_units RESTART IDENTITY CASCADE`
  })

  it('deletes an empty body and tears its external resources down', async () => {
    const unit = await makeUnit('Leeres Gremium')
    const r = await del(unit.id)
    expect(r.status).toBe(200)
    expect(await getOrgUnit(unit.id)).toBeNull()
    expect(h.deprovision).toHaveBeenCalledTimes(1)
  })

  it('refuses a body with minutes: 409, German message naming the minutes, nothing touched', async () => {
    const unit = await makeUnit('Gremium mit Protokoll')
    await addMinutes(unit.id)
    const r = await del(unit.id)
    expect(r.status).toBe(409)
    expect(r.body.success).toBe(false)
    expect(r.body.error).toMatch(/Protokoll/)
    expect(await getOrgUnit(unit.id)).not.toBeNull()
    expect(h.deprovision).not.toHaveBeenCalled()
  })

  it('names every kind of dependent record, not just the first', async () => {
    const unit = await makeUnit('Gremium mit Allem')
    await makeUnit('Untergruppe', unit.id)
    const protocolId = await addMinutes(unit.id)
    await getDb()`
      INSERT INTO protocol_resolutions (protocol_id, sequence_nr, text, result, created_at)
      VALUES (${protocolId}, 1, 'Beschluss', 'passed', now())`
    const r = await del(unit.id)
    expect(r.status).toBe(409)
    expect(r.body.error).toMatch(/Protokoll/)
    expect(r.body.error).toMatch(/Beschl/)
    expect(r.body.error).toMatch(/Untergruppe/)
    expect(h.deprovision).not.toHaveBeenCalled()
  })

  it('answers 409, not 500, when minutes appear between the guard and the delete', async () => {
    const unit = await makeUnit('Gremium im Wettlauf')
    h.deprovision.mockImplementationOnce(async (unitId: string) => {
      await addMinutes(unitId)
      return { unitId, subsystems: [] }
    })
    const r = await del(unit.id)
    expect(r.status).toBe(409)
    expect(r.body.error).toMatch(/Protokoll/)
    expect(await getOrgUnit(unit.id)).not.toBeNull()
  })
})
