import { getDb } from '../db'
import { getRunner, type PgTransaction } from '$lib/server/db/tx'
import { writeAuditEntry } from '$lib/server/audit-db'

// ── Types ──────────────────────────────────────────────────────────────────

export interface CommitteeRole {
  readonly id: string
  readonly org_unit_id: string
  readonly name: string
  readonly election_method: 'helios' | 'poll' | 'manual'
  readonly is_elected: boolean
  readonly grace_period_days: number
}

export interface RoleAssignment {
  readonly id: string
  readonly role_id: string
  readonly user_keycloak_id: string
  readonly start_date: Date | null
  readonly end_date: Date | null
  readonly status: 'active' | 'grace' | 'expired' | 'vacated'
  readonly assigned_by_keycloak_id: string
  readonly helios_election_id: string | null
  readonly created_at: Date
}

export interface RoleAssignmentHistory {
  readonly id: string
  readonly role_id: string
  readonly user_keycloak_id: string | null // nullable: NULL after GDPR hard erasure (migration 012)
  readonly start_date: Date
  readonly end_date: Date
  readonly ended_reason: ArchiveReason
  readonly created_at: Date
}

/** Why an assignment left the live table. 'recalled' = INV-3 recall act (migration 056). */
export type ArchiveReason = 'expired' | 'resigned' | 'removed' | 'recalled'

export interface ScheduledNotification {
  readonly id: string
  readonly type: 'term_reminder' | 'grace_start' | 'grace_expiry'
  readonly role_assignment_id: string
  readonly recipient_keycloak_id: string
  readonly scheduled_for: Date
  readonly sent_at: Date | null
  readonly failed_at: Date | null
  readonly failure_reason: string | null
}

// ── Roles ────────────────────────────────────────────────────────────────────

export async function listRoles(orgUnitId: string): Promise<readonly CommitteeRole[]> {
  const sql = getDb()
  return sql<CommitteeRole[]>`
    SELECT * FROM committee_roles WHERE org_unit_id = ${orgUnitId} ORDER BY name
  `
}

/**
 * Every DISTINCT committee-role name defined anywhere (all org units). Used by
 * role-group-reconcile.ts to compute the auto-managed group UNIVERSE — the union
 * of resolveRoleGroupGrants(name) over every role that could EVER grant a flat
 * Keycloak group (audit 420). A group outside that universe (e.g. the manually-
 * assigned -belege receipts-clerk group, which has no governance-role hook) is
 * never touched by reconciliation, no matter what a user's active roles are.
 */
export async function listAllRoleNames(): Promise<readonly string[]> {
  const sql = getDb()
  const rows = await sql<{ name: string }[]>`SELECT DISTINCT name FROM committee_roles`
  return rows.map((r) => r.name)
}

export async function createRole(data: {
  orgUnitId: string
  name: string
  electionMethod: 'helios' | 'poll' | 'manual'
  isElected: boolean
  gracePeriodDays: number
}): Promise<CommitteeRole> {
  const sql = getDb()
  const rows = await sql<CommitteeRole[]>`
    INSERT INTO committee_roles (org_unit_id, name, election_method, is_elected, grace_period_days)
    VALUES (${data.orgUnitId}, ${data.name}, ${data.electionMethod}, ${data.isElected}, ${data.gracePeriodDays})
    RETURNING *
  `
  return rows[0]!
}

// ── Role Assignments ─────────────────────────────────────────────────────────

export async function getActiveAssignment(roleId: string): Promise<RoleAssignment | null> {
  const sql = getDb()
  const rows = await sql<RoleAssignment[]>`
    SELECT * FROM role_assignments
    WHERE role_id = ${roleId} AND status IN ('active', 'grace')
    LIMIT 1
  `
  return rows[0] ?? null
}

export async function createAssignment(data: {
  roleId: string
  userKeycloakId: string
  startDate: Date
  endDate: Date
  assignedByKeycloakId: string
  heliosElectionId: string | null
}): Promise<RoleAssignment> {
  const sql = getDb()
  const rows = await sql<RoleAssignment[]>`
    INSERT INTO role_assignments
      (role_id, user_keycloak_id, start_date, end_date, assigned_by_keycloak_id, helios_election_id)
    VALUES
      (${data.roleId}, ${data.userKeycloakId}, ${data.startDate}, ${data.endDate},
       ${data.assignedByKeycloakId}, ${data.heliosElectionId})
    RETURNING *
  `
  return rows[0]!
}

/**
 * Names of every committee role a user STILL holds via a live assignment
 * (status active|grace), realm-wide (across all org units). Used by
 * role-group-reconcile.ts to compute a user's DERIVED flat-Keycloak-group set
 * (audit 420): the union of resolveRoleGroupGrants over exactly these role names.
 * The flat groups are realm-global (no per-org-unit namespacing), so this
 * deliberately spans every org unit, not just the one a given role sits in.
 */
export async function listActiveRoleNamesForUser(
  userKeycloakId: string
): Promise<readonly string[]> {
  const sql = getDb()
  const rows = await sql<{ name: string }[]>`
    SELECT cr.name
    FROM role_assignments ra
    JOIN committee_roles cr ON cr.id = ra.role_id
    WHERE ra.user_keycloak_id = ${userKeycloakId}
      AND ra.status IN ('active', 'grace')
  `
  return rows.map((r) => r.name)
}

/**
 * archiveAssignment refuses assignments it cannot archive (NULL start/end
 * dates — legal on role_assignments since migration 010, but
 * role_assignment_history requires concrete dates). Typed so route callers can
 * map it to a clean 4xx instead of a generic 500 (see the revoke route).
 */
export class UnarchivableAssignmentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnarchivableAssignmentError'
  }
}

/**
 * Move a live assignment into role_assignment_history. Pass `tx` to run both
 * statements on the caller's transaction (getRunner) — REQUIRED when the
 * archive is one part of a larger atomic act (e.g. revokeMandate pairs it with
 * the 'mandate.revoked' audit act: all writes commit or roll back together).
 * Omitting `tx` keeps the historical pool (auto-commit) behaviour.
 */
export async function archiveAssignment(
  assignment: RoleAssignment,
  reason: ArchiveReason,
  tx?: PgTransaction
): Promise<void> {
  // role_assignments allows null dates since migration 010; role_assignment_history still requires concrete dates (NOT NULL from migration 001)
  if (assignment.start_date === null || assignment.end_date === null) {
    throw new UnarchivableAssignmentError(
      `Cannot archive assignment ${assignment.id}: start_date or end_date is null`
    )
  }
  const sql = getRunner(tx, getDb)
  await sql`
    INSERT INTO role_assignment_history
      (role_id, user_keycloak_id, start_date, end_date, ended_reason)
    VALUES
      (${assignment.role_id}, ${assignment.user_keycloak_id},
       ${assignment.start_date}, ${assignment.end_date}, ${reason})
  `
  await sql`DELETE FROM role_assignments WHERE id = ${assignment.id}`
}

/**
 * INV-3 recall (#320 Phase 3): ending a mandate is a recorded, attributable
 * governance act — not a passive data edit. In ONE transaction this
 *   1. archives the live assignment with ended_reason 'recalled'
 *      (history INSERT + role_assignments DELETE via archiveAssignment's tx path),
 *   2. appends the tamper-evident 'mandate.revoked' audit act whose payload
 *      carries the assignment id, the free-text reason, and the acting revoker.
 * A failure anywhere rolls back ALL writes — a recall either fully happened
 * (with its record) or did not happen at all.
 *
 * Throws UnarchivableAssignmentError for an assignment with NULL dates
 * (surfaced by the revoke route as a clean 4xx). Keycloak group reconciliation
 * is deliberately NOT part of the transaction — the route runs the shared
 * role-group-reconcile path best-effort after the commit, same as assign.
 */
export async function revokeMandate(
  assignment: RoleAssignment,
  reason: string,
  revokedBy: string
): Promise<void> {
  await getDb().begin(async (tx) => {
    await archiveAssignment(assignment, 'recalled', tx)
    await writeAuditEntry(
      {
        userId: revokedBy,
        field: 'mandate.revoked',
        oldValue: null,
        newValue: JSON.stringify({ assignmentId: assignment.id, reason, revokedBy }),
      },
      tx
    )
  })
}

export async function listDueNotifications(): Promise<readonly ScheduledNotification[]> {
  const sql = getDb()
  return sql<ScheduledNotification[]>`
    SELECT * FROM scheduled_notifications
    WHERE scheduled_for <= now() AND sent_at IS NULL AND failed_at IS NULL
  `
}

export async function markNotificationSent(id: string): Promise<void> {
  const sql = getDb()
  await sql`UPDATE scheduled_notifications SET sent_at = now() WHERE id = ${id}`
}

export async function markNotificationFailed(id: string, reason: string): Promise<void> {
  const sql = getDb()
  await sql`
    UPDATE scheduled_notifications
    SET failed_at = now(), failure_reason = ${reason}
    WHERE id = ${id}
  `
}

export async function scheduleNotifications(
  assignment: RoleAssignment,
  recipientIds: readonly string[]
): Promise<void> {
  if (assignment.end_date === null) return
  const sql = getDb()
  const endDate = new Date(assignment.end_date)

  const entries: Array<{
    type: string
    role_assignment_id: string
    recipient_keycloak_id: string
    scheduled_for: Date
  }> = []

  for (const recipientId of recipientIds) {
    for (const daysBeforeEnd of [30, 14, 7]) {
      const scheduledFor = new Date(endDate)
      scheduledFor.setDate(scheduledFor.getDate() - daysBeforeEnd)
      entries.push({
        type: 'term_reminder',
        role_assignment_id: assignment.id,
        recipient_keycloak_id: recipientId,
        scheduled_for: scheduledFor
      })
    }
    entries.push({
      type: 'grace_expiry',
      role_assignment_id: assignment.id,
      recipient_keycloak_id: recipientId,
      scheduled_for: endDate
    })
  }

  if (entries.length === 0) return
  await sql`INSERT INTO scheduled_notifications ${sql(entries)}`
}

// ── History ───────────────────────────────────────────────────────────────────

export async function listHistory(orgUnitId: string): Promise<readonly RoleAssignmentHistory[]> {
  const sql = getDb()
  return sql<RoleAssignmentHistory[]>`
    SELECT rah.* FROM role_assignment_history rah
    JOIN committee_roles cr ON cr.id = rah.role_id
    WHERE cr.org_unit_id = ${orgUnitId}
    ORDER BY rah.created_at DESC
  `
}
