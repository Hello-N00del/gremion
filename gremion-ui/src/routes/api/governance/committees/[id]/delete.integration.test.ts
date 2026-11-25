// delete.integration.test.ts -- DELETE /api/governance/committees/[id] against a real DB.
//
// A body that still has records the council would lose (minutes and the resolutions
// under them, elections, sub-groups, roster rows, boards, calendar events, caucuses)
// must be refused with a clean 409 and a German message that names what hangs on it.
// The refusal comes BEFORE the external teardown (Keycloak group, Nextcloud folder,
// Matrix room), so nothing is half-deleted: the row is locked, re-checked and deleted
// inside one transaction, and the teardown runs while that transaction is still open.
// Only the external teardown is faked; the handler, the guards and every SQL
// statement are the real ones.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getDb } from '$lib/server/db'
import { createOrgUnit, getOrgUnit } from '$lib/server/governance/org-units-db'
import { registerDataProvider, _resetRuntimeRegistryForTests } from '$lib/server/modules/runtime-registry'
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

async function addBoardWithCard(unitId: string): Promise<void> {
  const sql = getDb()
  const [b] = await sql<{ id: string }[]>`INSERT INTO board (org_unit_id, name) VALUES (${unitId}, 'Aufgaben') RETURNING id`
  const [s] = await sql<{ id: string }[]>`INSERT INTO stack (board_id, name) VALUES (${b.id}, 'Offen') RETURNING id`
  await sql`INSERT INTO card (stack_id, title) VALUES (${s.id}, 'Eine Karte')`
}

async function addEvent(unitId: string, startAt = '2020-03-01T10:00:00Z'): Promise<void> {
  const sql = getDb()
  const [e] = await sql<{ id: string }[]>`
    INSERT INTO calendar_events (title, start_at, end_at, created_by)
    VALUES ('Sitzung im Maerz', ${startAt}, ${startAt}, ${ADMIN.id}) RETURNING id`
  await sql`INSERT INTO event_committees (event_id, committee_id) VALUES (${e.id}, ${unitId})`
}

async function count(table: string): Promise<number> {
  const rows = await getDb().unsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${table}`)
  return rows[0]!.n
}

describe('DELETE /api/governance/committees/[id] (integration)', () => {
  beforeEach(async () => {
    h.deprovision.mockClear()
    _resetRuntimeRegistryForTests()
    const sql = getDb()
    await sql`TRUNCATE audit_log RESTART IDENTITY CASCADE`
    await sql`TRUNCATE org_units RESTART IDENTITY CASCADE`
    await sql`TRUNCATE calendar_events RESTART IDENTITY CASCADE`
  })
  afterEach(() => _resetRuntimeRegistryForTests())

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

  describe('boards, calendar events and caucuses (rows the database would cascade away silently)', () => {
    it('refuses a body with a board: 409 naming the board, the board and its card survive', async () => {
      const unit = await makeUnit('Gremium mit Board')
      await addBoardWithCard(unit.id)
      const r = await del(unit.id)
      expect(r.status).toBe(409)
      expect(r.body.error).toMatch(/Board/)
      expect(await getOrgUnit(unit.id)).not.toBeNull()
      expect(await count('card')).toBe(1)
      expect(h.deprovision).not.toHaveBeenCalled()
    })

    it('refuses a body with a calendar event, however old: 409 naming the event, the link survives', async () => {
      const unit = await makeUnit('Gremium mit Termin')
      await addEvent(unit.id)
      const r = await del(unit.id)
      expect(r.status).toBe(409)
      expect(r.body.error).toMatch(/Termin/)
      expect(await getOrgUnit(unit.id)).not.toBeNull()
      expect(await count('event_committees')).toBe(1)
      expect(h.deprovision).not.toHaveBeenCalled()
    })

    it('refuses a council with a caucus: 409 naming the caucus', async () => {
      const unit = await makeUnit('Rat mit Fraktion')
      await getDb()`INSERT INTO caucus (council_org_unit_id, name) VALUES (${unit.id}, 'Fraktion A')`
      const r = await del(unit.id)
      expect(r.status).toBe(409)
      expect(r.body.error).toMatch(/Fraktion/)
      expect(await count('caucus')).toBe(1)
      expect(h.deprovision).not.toHaveBeenCalled()
    })

    it('refuses a body whose office is still held, but not one with only ended offices', async () => {
      const sql = getDb()
      const held = await makeUnit('Gremium mit Amt')
      const ended = await makeUnit('Gremium mit altem Amt')
      for (const [unit, status] of [[held, 'active'], [ended, 'vacated']] as const) {
        const [role] = await sql<{ id: string }[]>`
          INSERT INTO committee_roles (org_unit_id, name) VALUES (${unit.id}, 'Vorsitz') RETURNING id`
        await sql`
          INSERT INTO role_assignments (role_id, user_keycloak_id, start_date, end_date, status, assigned_by_keycloak_id)
          VALUES (${role.id}, ${actor('holder')}, '2026-01-01', '2026-12-31', ${status}, ${ADMIN.id})`
      }
      const refused = await del(held.id)
      expect(refused.status).toBe(409)
      expect(refused.body.error).toMatch(/Amt|Ämter/)
      expect(await getOrgUnit(held.id)).not.toBeNull()
      const allowed = await del(ended.id)
      expect(allowed.status).toBe(200)
      expect(await getOrgUnit(ended.id)).toBeNull()
    })

    it('asks the board and calendar module providers when they are registered, and trusts their count', async () => {
      const unit = await makeUnit('Gremium im Modul')
      const board = vi.fn(async () => ({ referenced: true, counts: { boards: 2 } }))
      const calendar = vi.fn(async () => ({ referenced: true, counts: { events: 3 } }))
      registerDataProvider('board:org-unit-refs', board)
      registerDataProvider('calendar:org-unit-refs', calendar)
      const r = await del(unit.id)
      expect(r.status).toBe(409)
      expect(board).toHaveBeenCalledWith(unit.id)
      expect(calendar).toHaveBeenCalledWith(unit.id)
      expect(r.body.error).toMatch(/2 Boards/)
      expect(r.body.error).toMatch(/3 Termine/)
      expect(h.deprovision).not.toHaveBeenCalled()
    })

    it('does not count stale kernel rows when a module provider says the body has none', async () => {
      // A board that moved to the module database leaves its old copy in the kernel tables.
      const unit = await makeUnit('Gremium nach Umzug')
      await addBoardWithCard(unit.id)
      registerDataProvider('board:org-unit-refs', async () => ({ referenced: false, counts: { boards: 0 } }))
      const r = await del(unit.id)
      expect(r.status).toBe(200)
      expect(await getOrgUnit(unit.id)).toBeNull()
    })

    it('refuses when a module provider cannot answer: 503, nothing touched, never read as zero', async () => {
      const unit = await makeUnit('Gremium ohne Antwort')
      registerDataProvider('board:org-unit-refs', async () => { throw new Error('tenant_not_provisioned') })
      const r = await del(unit.id)
      expect(r.status).toBe(503)
      expect(r.body.error).toMatch(/Board/)
      expect(r.body.error).not.toMatch(/tenant_not_provisioned/)
      expect(await getOrgUnit(unit.id)).not.toBeNull()
      expect(h.deprovision).not.toHaveBeenCalled()
    })

    it('refuses on the finance module answer too', async () => {
      const unit = await makeUnit('Gremium mit Haushalt')
      registerDataProvider('finance:org-unit-refs', async () => ({ referenced: true, counts: { budget: 1 } }))
      const r = await del(unit.id)
      expect(r.status).toBe(409)
      expect(r.body.error).toMatch(/Finanz/)
      expect(h.deprovision).not.toHaveBeenCalled()
    })
  })

  describe('nothing is half-deleted', () => {
    it('a dependent no guard knows about is refused BEFORE the external teardown', async () => {
      const sql = getDb()
      await sql.unsafe('CREATE TABLE bd_fx8_unknown_dep (org_unit_id uuid NOT NULL REFERENCES org_units(id))')
      try {
        const unit = await makeUnit('Gremium mit Unbekanntem')
        await sql.unsafe(`INSERT INTO bd_fx8_unknown_dep (org_unit_id) VALUES ('${unit.id}')`)
        const r = await del(unit.id)
        expect(r.status).toBe(409)
        expect(r.body.error).toMatch(/gelöscht werden/)
        expect(await getOrgUnit(unit.id)).not.toBeNull()
        expect(h.deprovision).not.toHaveBeenCalled()
      } finally {
        await sql.unsafe('DROP TABLE bd_fx8_unknown_dep')
      }
    })

    it('minutes written while the teardown runs wait for the lock; the delete wins and the write fails cleanly', async () => {
      const unit = await makeUnit('Gremium im Wettlauf')
      let late: Promise<unknown> | undefined
      let settledAt = 0
      let teardownEndedAt = 0
      h.deprovision.mockImplementationOnce(async (unitId: string) => {
        late = addMinutes(unitId)
        late.then(() => { settledAt = Date.now() }, () => { settledAt = Date.now() })
        await new Promise((resolve) => setTimeout(resolve, 400))
        teardownEndedAt = Date.now()
        return { unitId, subsystems: [] }
      })
      const r = await del(unit.id)
      expect(r.status).toBe(200)
      // the write was blocked behind the row lock for the whole teardown ...
      await expect(late).rejects.toMatchObject({ code: '23503' })
      expect(settledAt).toBeGreaterThanOrEqual(teardownEndedAt)
      // ... and, once the delete committed, it failed on the foreign key (no minutes without a body)
      expect(await getOrgUnit(unit.id)).toBeNull()
      expect(await count('protocols')).toBe(0)
    })

    it('the REAL teardown still finds the ledger after the delete cascaded it inside the open transaction', async () => {
      // deprovisionOrgUnit reads provisioning_resources on its own connection while the delete
      // transaction (which already removed those rows) is still open. It must see the committed
      // rows and call every adapter; a teardown that saw nothing would orphan the external resources.
      const unit = await makeUnit('Gremium mit echtem Abbau')
      const sql = getDb()
      await sql`
        INSERT INTO provisioning_resources (org_unit_id, subsystem, external_id, status)
        VALUES (${unit.id}, 'keycloak', 'kc-1', 'ok'), (${unit.id}, 'nextcloud', '7:ou-x', 'ok')`
      const removed: string[] = []
      const adapter = (name: 'keycloak' | 'nextcloud') => ({
        name,
        async ensureResource() { return { externalId: 'unused' } },
        async removeResource(externalId: string) { removed.push(`${name}:${externalId}`) },
        async addMember() {}, async removeMember() {}, async reconcileMembers() {},
      })
      const actual = await vi.importActual<typeof import('$lib/server/governance/provisioning/orchestrator')>(
        '$lib/server/governance/provisioning/orchestrator')
      h.deprovision.mockImplementationOnce((unitId: string) =>
        actual.deprovisionOrgUnit(unitId, { keycloak: adapter('keycloak'), nextcloud: adapter('nextcloud') } as never) as never)
      const r = await del(unit.id)
      expect(r.status).toBe(200)
      expect(removed).toEqual(['nextcloud:7:ou-x', 'keycloak:kc-1'])
      expect(await getOrgUnit(unit.id)).toBeNull()
      expect(await count('provisioning_resources')).toBe(0)
    })

    it('a failed teardown keeps the body whole: 207, row, members and ledger untouched', async () => {
      const unit = await makeUnit('Gremium mit Fehler')
      await getDb()`
        INSERT INTO provisioning_resources (org_unit_id, subsystem, external_id, status)
        VALUES (${unit.id}, 'keycloak', 'kc-1', 'ok')`
      h.deprovision.mockImplementationOnce(async (unitId: string) => ({
        unitId, subsystems: [{ status: 'failed' }],
      }))
      const r = await del(unit.id)
      expect(r.status).toBe(207)
      expect(await getOrgUnit(unit.id)).not.toBeNull()
      expect(await count('provisioning_resources')).toBe(1)
    })
  })
})

// The classification of every foreign key onto org_units. A new table that points at an
// org unit must be put in one of the two lists on purpose: either the delete refuses
// while rows exist (and says so), or the rows belong to the unit and go with it.
describe('every foreign key onto org_units is classified', () => {
  const REFUSED = new Set([
    'org_units.committees_parent_id_fkey', // sub-groups
    'org_unit_members.committee_members_committee_id_fkey', // roster
    'committee_elections.committee_elections_committee_id_fkey', // elections
    'protocols.protocols_committee_id_fkey', // minutes
    'protocol_resolutions.protocol_resolutions_committee_id_fkey', // resolutions
    'board.board_org_unit_id_fkey', // boards, via the board module's provider or the kernel table
    'event_committees.event_committees_committee_id_fkey', // calendar events, via the calendar module's provider or the kernel table
    'caucus.caucus_council_org_unit_id_fkey', // caucuses
  ])
  const GOES_WITH_THE_UNIT = new Set([
    'committee_roles.committee_roles_committee_id_fkey', // role definitions and ended assignments; a LIVE office (active, grace) refuses the delete
    'committee_calendar_settings.committee_calendar_settings_committee_id_fkey', // calendar colour
    'beschluss_register_settings.beschluss_register_settings_committee_id_fkey', // register numbering
    'provisioning_resources.provisioning_resources_org_unit_id_fkey', // the ledger of the external resources
    'provisioning_member_ops.provisioning_member_ops_org_unit_id_fkey', // pending roster operations
    'governance_membership_record.governance_membership_record_org_unit_id_fkey', // erasure bookkeeping of the unit
  ])

  it('lists no foreign key that is in neither list, and no stale entry', async () => {
    const rows = await getDb()<{ fk: string }[]>`
      SELECT conrelid::regclass::text || '.' || conname AS fk
      FROM pg_constraint
      WHERE confrelid = 'org_units'::regclass AND contype = 'f'`
    const found = new Set(rows.map((r) => r.fk))
    const classified = new Set([...REFUSED, ...GOES_WITH_THE_UNIT])
    expect([...found].filter((fk) => !classified.has(fk))).toEqual([])
    expect([...classified].filter((fk) => !found.has(fk))).toEqual([])
  })
})
