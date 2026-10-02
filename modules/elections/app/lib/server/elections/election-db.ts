import { getDb } from '../db'

export interface CommitteeElection {
  readonly id: string
  readonly helios_uuid: string
  readonly org_unit_id: string
  readonly created_by: string
  readonly calendar_linked: boolean
  readonly created_at: Date
  readonly archived_at: Date | null
}

export interface InsertElectionDto {
  heliosUuid: string
  orgUnitId: string
  createdBy: string
  calendarLinked: boolean
}

export const ElectionDb = {
  async insert(dto: InsertElectionDto): Promise<CommitteeElection> {
    const sql = getDb()
    const rows = await sql<CommitteeElection[]>`
      INSERT INTO committee_elections (helios_uuid, org_unit_id, created_by, calendar_linked)
      VALUES (${dto.heliosUuid}, ${dto.orgUnitId}, ${dto.createdBy}, ${dto.calendarLinked})
      RETURNING *
    `
    return rows[0]
  },

  async findByOrgUnitIds(orgUnitIds: string[]): Promise<readonly CommitteeElection[]> {
    if (orgUnitIds.length === 0) return []
    const sql = getDb()
    return sql<CommitteeElection[]>`
      SELECT * FROM committee_elections
      WHERE org_unit_id = ANY(${orgUnitIds}::uuid[])
        AND archived_at IS NULL
      ORDER BY created_at DESC
    `
  },

  /**
   * Elections visible to a user: those of every org-unit the user is a member of.
   * Membership (org_unit_members) is the source of truth — the redesign dropped
   * org_units.keycloak_group_id, so visibility no longer keys off Keycloak groups.
   */
  async findVisibleToUser(userKeycloakId: string): Promise<readonly CommitteeElection[]> {
    const sql = getDb()
    return sql<CommitteeElection[]>`
      SELECT ce.*
      FROM committee_elections ce
      JOIN org_unit_members oum ON oum.org_unit_id = ce.org_unit_id
      WHERE oum.user_keycloak_id = ${userKeycloakId}
        AND ce.archived_at IS NULL
      ORDER BY ce.created_at DESC
    `
  },

  async findAll(): Promise<readonly CommitteeElection[]> {
    const sql = getDb()
    return sql<CommitteeElection[]>`
      SELECT * FROM committee_elections
      WHERE archived_at IS NULL
      ORDER BY created_at DESC
    `
  },

  async findByHeliosUuid(heliosUuid: string): Promise<CommitteeElection | null> {
    const sql = getDb()
    const rows = await sql<CommitteeElection[]>`
      SELECT * FROM committee_elections
      WHERE helios_uuid = ${heliosUuid}
        AND archived_at IS NULL
      LIMIT 1
    `
    return rows[0] ?? null
  },

  async markCalendarLinked(heliosUuid: string): Promise<void> {
    const sql = getDb()
    await sql`
      UPDATE committee_elections
      SET calendar_linked = true
      WHERE helios_uuid = ${heliosUuid}
    `
  },
}
