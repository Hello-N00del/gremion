import { getDb } from '../db'
import { getRunner as genericGetRunner, type PgTransaction } from '$lib/server/db/tx'
import { writeAuditEntry } from '$lib/server/audit-db'

// #235 (defects 2 & 3): the publish flow runs updateProtocol + the per-resolution
// global_nr assignment + setProtocolStatus inside ONE getDb().begin(...) tx. These
// writers accept an optional `tx` so they run on the caller's transaction; reads
// keep their bare single-arg signatures. Mirrors the org-units-db.ts pattern.
const getRunner = (tx: PgTransaction | undefined) => genericGetRunner(tx, getDb)

/**
 * Thrown by updateResolution / deleteResolution when the write matched no row
 * although the resolution exists: it is locked, i.e. its parent protocol is
 * published or the resolution is already adopted (decided_at stamped). The
 * routes map it to a 403 so a publish that commits between the route's early
 * check and the write is refused instead of surfacing as a 500.
 */
export class ResolutionPublishedError extends Error {
  constructor(public readonly resolutionId: string) {
    super(`Beschluss ${resolutionId} gehört zu einem veröffentlichten Protokoll und ist nicht änderbar`)
    this.name = 'ResolutionPublishedError'
  }
}

/**
 * Thrown by updateResolution / deleteResolution when the write matched no row
 * because the resolution does not exist (any more), e.g. another admin deleted
 * it between the route's check and the write. The routes map it to a 404.
 */
export class ResolutionNotFoundError extends Error {
  constructor(public readonly resolutionId: string) {
    super(`Beschluss ${resolutionId} nicht gefunden`)
    this.name = 'ResolutionNotFoundError'
  }
}

// ─── Types ───────────────────────────────────────────────────────────────────

export type ProtocolStatus = 'draft' | 'submitted' | 'published'
export type AttendanceStatus = 'present' | 'absent' | 'excused'
export type ResolutionResult = 'passed' | 'rejected' | 'withdrawn'
// T4 (#320 Phase 2): HOW a resolution's binding decision is reached.
// 'tally' — counted vote; the server computes `result` from rule + tallies.
// 'acclamation' — chair-declared result (declared_result at the API); tallies
// are NULL, or a full informational tally (all three) — the DB votes_mode
// CHECK enforces exactly that all-or-nothing shape.
export type AdoptionMode = 'tally' | 'acclamation'
// Persistence-layer type: the FULL 5-rule core decision-rule vocabulary the DB
// CHECK (migration 054) permits — the three majority rules plus 'consent' and the
// parametrised 'support_threshold' (whose parameters ride in decision_rule_params,
// e.g. { fraction: 0.5 }, fixed at creation like the rule itself). Mirrors
// CoreDecisionRuleId; kept as its own literal union so persistence does not depend
// on the registry module.
export type RequiredMajority = 'simple' | 'two_thirds' | 'absolute' | 'consent' | 'support_threshold'

export interface Protocol {
  id: string
  committee_id: string
  meeting_date: string
  location: string | null
  title: string
  body_html: string | null
  nextcloud_draft_path: string | null
  nextcloud_published_path: string | null
  pdf_nextcloud_path: string | null
  status: ProtocolStatus
  guest_edit_enabled: boolean
  approval_poll_id: string | null
  revision_notes: string | null
  created_by: string
  created_at: string
  updated_at: string
}

export interface ProtocolAttendance {
  id: string
  protocol_id: string
  user_keycloak_id: string
  status: AttendanceStatus
}

export interface ProtocolResolution {
  id: string
  protocol_id: string
  sequence_nr: number
  global_nr: string | null
  text: string
  // T4: NULL tallies are legal ONLY for adoption_mode 'acclamation' (no count
  // was taken); a tally resolution always carries all three numbers.
  votes_yes: number | null
  votes_no: number | null
  votes_abstain: number | null
  result: ResolutionResult
  required_majority: RequiredMajority
  // T4: the adoption procedure ('tally' | 'acclamation'), fixed at creation.
  adoption_mode: AdoptionMode
  // T4: parameters of a parametrised decision rule (support_threshold →
  // { fraction }); NULL for the parameterless rules.
  decision_rule_params: Record<string, unknown> | null
  // INV-5 (#320, ported gremion#22 M3b): when the binding decision was
  // finalised at adoption (protocol publish). NULL for resolutions decided
  // before migration 048 added the column.
  decided_at: string | null
  created_at: string
}

export interface ProtocolActionItem {
  id: string
  protocol_id: string
  assignee_keycloak_id: string | null
  text: string
  due_date: string | null
  completed: boolean
  created_at: string
}

export interface BeschlussRegisterSettings {
  committee_id: string
  include_protocols: boolean
  include_polls: boolean
  include_elections: boolean
}

// ─── Protocols ────────────────────────────────────────────────────────────────

export async function createProtocol(input: {
  committeeId: string
  meetingDate: string
  location?: string
  title: string
  createdBy: string
}): Promise<Protocol> {
  const sql = getDb()
  const rows = await sql<Protocol[]>`
    INSERT INTO protocols (committee_id, meeting_date, location, title, created_by)
    VALUES (${input.committeeId}, ${input.meetingDate}, ${input.location ?? null}, ${input.title}, ${input.createdBy})
    RETURNING *
  `
  return rows[0]
}

export async function getProtocol(id: string): Promise<Protocol | null> {
  const sql = getDb()
  const rows = await sql<Protocol[]>`SELECT * FROM protocols WHERE id = ${id}`
  return rows[0] ?? null
}

export async function listProtocols(params: {
  committeeId: string
  status?: ProtocolStatus
  year?: number
}): Promise<Protocol[]> {
  const sql = getDb()
  // porsager/postgres cannot infer the parameter type when an untyped NULL is
  // passed via tagged-template interpolation, so PostgreSQL rejects the
  // prepared statement with "could not determine data type of parameter".
  // Casting the nullable params makes the type explicit.
  return sql<Protocol[]>`
    SELECT * FROM protocols
    WHERE committee_id = ${params.committeeId}
      AND (${params.status ?? null}::text IS NULL OR status = ${params.status ?? null}::text)
      AND (${params.year ?? null}::int IS NULL OR EXTRACT(YEAR FROM meeting_date) = ${params.year ?? null}::int)
    ORDER BY meeting_date DESC
  `
}

/**
 * #241: resolve a published protocol's stored PDF path for the anonymous public
 * PDF route. Enforces the SAME public-visibility gate as gremion-public's
 * public-db (status='published' AND the owning org unit is 'all_members'-visible)
 * so this directly-reachable endpoint cannot be used to read a non-public or
 * unpublished protocol's PDF. Returns null when no such public PDF exists.
 */
export async function getPublishedProtocolPdfPath(id: string): Promise<string | null> {
  const sql = getDb()
  const rows = await sql<{ pdf_nextcloud_path: string | null }[]>`
    SELECT p.pdf_nextcloud_path
    FROM   protocols p
    JOIN   org_units c ON c.id = p.committee_id
    WHERE  p.id = ${id}::uuid
      AND  p.status = 'published'
      AND  c.visibility = 'all_members'
    LIMIT  1
  `
  return rows[0]?.pdf_nextcloud_path ?? null
}

export async function updateProtocol(id: string, input: {
  location?: string
  title?: string
  bodyHtml?: string
  nextcloudDraftPath?: string
  nextcloudPublishedPath?: string
  // #235 (defect 4): the published PDF's Nextcloud path, read by the public PDF
  // proxy. Previously never written — the public PDF feature was structurally dead.
  pdfNextcloudPath?: string
  guestEditEnabled?: boolean
  approvalPollId?: string
  revisionNotes?: string
}, opts?: {
  tx?: PgTransaction
  // #235 (defect 3): the publish tx flips status to 'published' AFTER this write,
  // but it must run updateProtocol FIRST to persist body_html / paths. When set,
  // the `status != 'published'` guard is dropped so the publish tx's own ordering
  // governs (the row is still 'submitted' at that point anyway). Normal edits keep
  // the guard, which refuses to mutate an already-published protocol.
  allowPublished?: boolean
}): Promise<Protocol> {
  const sql = getRunner(opts?.tx)
  // Single statement so the guard stays inline; `allowPublished` is a bound
  // boolean param that, when true, neutralises the `status != 'published'`
  // backstop for the publish tx (which legitimately writes to a row it is about
  // to flip to 'published' in the same transaction).
  const allowPublished = opts?.allowPublished ?? false
  const rows = await sql<Protocol[]>`
    UPDATE protocols SET
      location                 = COALESCE(${input.location ?? null}, location),
      title                    = COALESCE(${input.title ?? null}, title),
      body_html                = COALESCE(${input.bodyHtml ?? null}, body_html),
      nextcloud_draft_path     = COALESCE(${input.nextcloudDraftPath ?? null}, nextcloud_draft_path),
      nextcloud_published_path = COALESCE(${input.nextcloudPublishedPath ?? null}, nextcloud_published_path),
      pdf_nextcloud_path       = COALESCE(${input.pdfNextcloudPath ?? null}, pdf_nextcloud_path),
      guest_edit_enabled       = COALESCE(${input.guestEditEnabled ?? null}, guest_edit_enabled),
      approval_poll_id         = COALESCE(${input.approvalPollId ?? null}, approval_poll_id),
      revision_notes           = COALESCE(${input.revisionNotes ?? null}, revision_notes),
      updated_at               = now()
    WHERE id = ${id} AND (${allowPublished} OR status != 'published')
    RETURNING *
  `
  if (!rows[0]) throw new Error(`Protocol ${id} not found or is published`)
  return rows[0]
}

/**
 * Delete a protocol. The published-guard rides in the statement (same shape as
 * updateProtocol), so a publish committing right before the delete cannot lose
 * an adopted, audit-chained protocol. Zero rows (unknown id OR published) throws
 * the same text updateProtocol uses. The only in-tree caller rolls back a
 * just-created draft, for which the guard is harmless.
 */
export async function deleteProtocol(
  id: string,
  opts?: { tx?: PgTransaction; allowPublished?: boolean },
): Promise<void> {
  const sql = getRunner(opts?.tx)
  const allowPublished = opts?.allowPublished ?? false
  const rows = await sql<{ id: string }[]>`
    DELETE FROM protocols
    WHERE id = ${id} AND (${allowPublished} OR status != 'published')
    RETURNING id
  `
  if (!rows[0]) throw new Error(`Protocol ${id} not found or is published`)
}

export async function setProtocolStatus(
  id: string,
  newStatus: ProtocolStatus,
  opts?: { appendRevisionNote?: string; tx?: PgTransaction }
): Promise<Protocol> {
  const sql = getRunner(opts?.tx)
  const current = await sql<{ status: string }[]>`SELECT status FROM protocols WHERE id = ${id}`
  if (!current[0]) throw new Error(`Protocol ${id} not found`)
  if (current[0].status === 'published') throw new Error(`Cannot change status of published protocol`)

  const rows = await sql<Protocol[]>`
    UPDATE protocols SET
      status         = ${newStatus},
      revision_notes = CASE
        WHEN ${opts?.appendRevisionNote ?? null}::text IS NOT NULL
        THEN COALESCE(revision_notes || E'\n', '') || ${opts?.appendRevisionNote ?? ''}
        ELSE revision_notes
      END,
      updated_at = now()
    WHERE id = ${id}
    RETURNING *
  `
  return rows[0]
}

// ─── Attendance ───────────────────────────────────────────────────────────────

export async function listAttendance(protocolId: string): Promise<ProtocolAttendance[]> {
  const sql = getDb()
  return sql<ProtocolAttendance[]>`
    SELECT * FROM protocol_attendance WHERE protocol_id = ${protocolId}
  `
}

export async function upsertAttendance(
  protocolId: string,
  userId: string,
  status: AttendanceStatus
): Promise<ProtocolAttendance> {
  const sql = getDb()
  const rows = await sql<ProtocolAttendance[]>`
    INSERT INTO protocol_attendance (protocol_id, user_keycloak_id, status)
    VALUES (${protocolId}, ${userId}, ${status})
    ON CONFLICT (protocol_id, user_keycloak_id) DO UPDATE SET status = EXCLUDED.status
    RETURNING *
  `
  return rows[0]
}

// ─── Resolutions ─────────────────────────────────────────────────────────────

export async function getResolutionById(id: string): Promise<ProtocolResolution | null> {
  const sql = getDb()
  const rows = await sql<ProtocolResolution[]>`SELECT * FROM protocol_resolutions WHERE id = ${id}`
  return rows[0] ?? null
}

export async function listResolutions(protocolId: string): Promise<ProtocolResolution[]> {
  const sql = getDb()
  return sql<ProtocolResolution[]>`
    SELECT * FROM protocol_resolutions
    WHERE protocol_id = ${protocolId}
    ORDER BY sequence_nr
  `
}

export async function addResolution(protocolId: string, input: {
  text: string
  votesYes: number | null
  votesNo: number | null
  votesAbstain: number | null
  result: ResolutionResult
  requiredMajority: RequiredMajority
  // T4: optional so every pre-existing caller keeps its exact 'tally' shape.
  adoptionMode?: AdoptionMode
  decisionRuleParams?: Record<string, unknown> | null
}): Promise<ProtocolResolution> {
  const sql = getDb()
  const rows = await sql<ProtocolResolution[]>`
    INSERT INTO protocol_resolutions
      (protocol_id, sequence_nr, text, votes_yes, votes_no, votes_abstain, result, required_majority,
       adoption_mode, decision_rule_params)
    VALUES (
      ${protocolId},
      (SELECT COALESCE(MAX(sequence_nr), 0) + 1 FROM protocol_resolutions WHERE protocol_id = ${protocolId}),
      ${input.text}, ${input.votesYes}, ${input.votesNo}, ${input.votesAbstain}, ${input.result}, ${input.requiredMajority},
      ${input.adoptionMode ?? 'tally'},
      ${input.decisionRuleParams != null ? (sql.json(input.decisionRuleParams as never) as never) : null}
    )
    RETURNING *
  `
  return rows[0]
}

export async function updateResolution(id: string, input: Partial<{
  text: string
  votesYes: number
  votesNo: number
  votesAbstain: number
  result: ResolutionResult
  requiredMajority: RequiredMajority
  globalNr: string
  // T4: COALESCE semantics like every other field — the ROUTES never send
  // these on an edit (rule, params and mode are fixed at creation; the PATCH
  // handler pins them to the stored row, [resId]/+server.ts).
  adoptionMode: AdoptionMode
  decisionRuleParams: Record<string, unknown>
}>, opts?: {
  tx?: PgTransaction
  // The publish lock (below) is dropped when set. ONLY the publish flow's own
  // global_nr numbering passes it (assignGlobalNrs: it runs inside the publish
  // tx and again on republish); every edit path keeps the lock.
  allowPublished?: boolean
}): Promise<ProtocolResolution> {
  const sql = getRunner(opts?.tx)
  // Publish lock (#433). The lock is part of the UPDATE itself, not a prior SELECT:
  // a route-level check-then-write leaves a window in which a publish can commit
  // between the two statements. Two predicates close it, and BOTH are needed:
  //  - `decided_at IS NULL` is a column of the target row. When this statement
  //    blocked behind an open publish tx, Postgres (Read Committed) re-checks the
  //    WHERE clause against the newest version of the target row after the
  //    publish commits, and sees the decided_at the publish stamped.
  //  - the parent-status EXISTS carries FOR SHARE. Without it the sub-SELECT reads
  //    the statement's ORIGINAL snapshot (the re-check only refreshes the target
  //    row), still sees 'submitted' and lets the edit through. FOR SHARE conflicts
  //    with the row lock the publish's UPDATE of the protocol holds, so this
  //    statement waits for the publish and then re-reads the committed status.
  //    (Lock order is protocols then protocol_resolutions, the same as the publish
  //    tx, so the two cannot deadlock.)
  // Proven against a real database in protocol-publish-lock.integration.test.ts.
  const allowPublished = opts?.allowPublished ?? false
  const rows = await sql<ProtocolResolution[]>`
    UPDATE protocol_resolutions SET
      text              = COALESCE(${input.text ?? null}, text),
      votes_yes         = COALESCE(${input.votesYes ?? null}, votes_yes),
      votes_no          = COALESCE(${input.votesNo ?? null}, votes_no),
      votes_abstain     = COALESCE(${input.votesAbstain ?? null}, votes_abstain),
      result            = COALESCE(${input.result ?? null}, result),
      required_majority = COALESCE(${input.requiredMajority ?? null}, required_majority),
      adoption_mode     = COALESCE(${input.adoptionMode ?? null}, adoption_mode),
      decision_rule_params = COALESCE(${input.decisionRuleParams != null ? (sql.json(input.decisionRuleParams as never) as never) : null}, decision_rule_params),
      global_nr         = COALESCE(${input.globalNr ?? null}, global_nr)
    WHERE id = ${id}
      AND (${allowPublished} OR (
        decided_at IS NULL
        AND EXISTS (
          SELECT 1 FROM protocols p
          WHERE p.id = protocol_resolutions.protocol_id AND p.status != 'published'
          FOR SHARE OF p
        )
      ))
    RETURNING *
  `
  if (!rows[0]) return throwForZeroRows(sql, id)
  return rows[0]
}

/**
 * A write matched no row. Tell "locked" (403) apart from "gone" (404) with a
 * follow-up read, so a resolution deleted concurrently is not reported as adopted.
 */
async function throwForZeroRows(sql: ReturnType<typeof getRunner>, id: string): Promise<never> {
  const [row] = await sql<{ id: string }[]>`SELECT id FROM protocol_resolutions WHERE id = ${id}`
  throw row ? new ResolutionPublishedError(id) : new ResolutionNotFoundError(id)
}

/**
 * Delete a resolution under the same in-statement publish lock as
 * updateResolution (see the comment there for why both predicates are needed).
 * Zero rows throws ResolutionPublishedError when the resolution is locked and
 * ResolutionNotFoundError when it does not exist.
 */
export async function deleteResolution(
  id: string,
  opts?: { tx?: PgTransaction; allowPublished?: boolean },
): Promise<void> {
  const sql = getRunner(opts?.tx)
  const allowPublished = opts?.allowPublished ?? false
  const rows = await sql<{ id: string }[]>`
    DELETE FROM protocol_resolutions
    WHERE id = ${id}
      AND (${allowPublished} OR (
        decided_at IS NULL
        AND EXISTS (
          SELECT 1 FROM protocols p
          WHERE p.id = protocol_resolutions.protocol_id AND p.status != 'published'
          FOR SHARE OF p
        )
      ))
    RETURNING id
  `
  if (!rows[0]) await throwForZeroRows(sql, id)
}

export async function nextGlobalNr(
  committeeId: string,
  year: number,
  opts?: { tx?: PgTransaction },
): Promise<string> {
  const sql = getRunner(opts?.tx)
  const rows = await sql<{ count: string }[]>`
    SELECT COUNT(*) AS count
    FROM protocol_resolutions r
    JOIN protocols p ON p.id = r.protocol_id
    WHERE p.committee_id = ${committeeId}
      AND EXTRACT(YEAR FROM p.meeting_date) = ${year}
      AND r.global_nr IS NOT NULL
  `
  const next = parseInt(rows[0].count, 10) + 1
  return `B-${year}-${String(next).padStart(3, '0')}`
}

/**
 * #235 (defect 2): assign official Beschluss numbers to a protocol's resolutions
 * SEQUENTIALLY inside the caller's transaction. The previous publish flow raced
 * `nextGlobalNr` across `Promise.all`, so every concurrent COUNT(*) read the same
 * value and handed the SAME B-number to every resolution. Awaiting each
 * COUNT→UPDATE pair in order (on one tx) guarantees each COUNT observes the prior
 * UPDATE, yielding DISTINCT, monotonic numbers. The committee+year UNIQUE backstop
 * added in migration 041 is the last line of defence against any residual race.
 *
 * Returns the assigned numbers in resolution-id order.
 */
export async function assignGlobalNrs(
  committeeId: string,
  year: number,
  resolutionIds: string[],
  tx: PgTransaction,
): Promise<string[]> {
  const assigned: string[] = []
  for (const resId of resolutionIds) {
    const globalNr = await nextGlobalNr(committeeId, year, { tx })
    // allowPublished: this runs inside the publish tx (row still 'submitted', but
    // the lock must not depend on that ordering) and on republish of an already
    // published protocol; it is the one legitimate writer past the publish lock.
    await updateResolution(resId, { globalNr }, { tx, allowPublished: true })
    assigned.push(globalNr)
  }
  return assigned
}

/**
 * Governance Core INV-5 + INV-1 (#320, ported gremion#22 M3b): record
 * REAL adoption of a protocol's resolutions. Adoption is the protocol-publish
 * moment (the quorum-hard path) — NOT draft data-entry, and NOT a pure
 * re-computation. For every BINDING resolution (result 'passed' | 'rejected')
 * this:
 *   1. stamps `decided_at = now()` on the row, and
 *   2. appends a tamper-evident `audit_log` entry (field `protocol_resolution.decided`).
 *
 * A `withdrawn` resolution is an author act, not a vote — it is skipped (no
 * decision was taken, so no decision timestamp and no audit record).
 *
 * #429: IDEMPOTENT. Republishing a protocol (e.g. after document regeneration)
 * calls this again with `allowPublished:true`, and must be a NON-EVENT for
 * already-decided resolutions — no decided_at re-stamp, no duplicate audit row.
 * The UPDATE only touches rows still `decided_at IS NULL`; RETURNING reports
 * which row(s) actually got stamped, and the audit entry is written ONLY for
 * that row. A resolution whose decided_at was already set (prior publish) is
 * therefore skipped entirely on a republish.
 *
 * MUST run on the publish transaction (`tx` is required): the decided_at
 * stamps AND the audit rows commit or roll back together with the
 * status→'published' flip. A rolled-back publish therefore leaves NO orphan
 * decided_at / audit row, and a committed publish always carries both. The
 * audit INSERT participates in the same tx so the hash-chain trigger (043)
 * links these rows in commit order.
 *
 * Returns the number of resolutions NEWLY recorded (binding + not already
 * decided). First publish returns the full binding count; a republish with
 * nothing new to decide returns 0.
 */
export async function recordResolutionAdoptions(
  userId: string,
  resolutions: ProtocolResolution[],
  tx: PgTransaction,
): Promise<number> {
  let recorded = 0
  for (const r of resolutions) {
    if (r.result === 'withdrawn') continue
    const stamped = await tx<{ id: string }[]>`
      UPDATE protocol_resolutions SET decided_at = now()
      WHERE id = ${r.id} AND decided_at IS NULL
      RETURNING id
    `
    // Already decided by an earlier publish — republish is a non-event for
    // this resolution: no re-stamp, no duplicate audit row.
    if (stamped.length === 0) continue
    await writeAuditEntry(
      {
        userId,
        field: 'protocol_resolution.decided',
        oldValue: null,
        newValue: JSON.stringify({
          resolutionId: r.id,
          result: r.result,
          // T4: NULL for an acclamation adoption without informational tally.
          votesYes: r.votes_yes,
          votesNo: r.votes_no,
          votesAbstain: r.votes_abstain,
          requiredMajority: r.required_majority,
          // T4: the evidentiary record states HOW the decision was reached;
          // snake_case key matching the DB column it mirrors.
          adoption_mode: r.adoption_mode,
        }),
      },
      tx,
    )
    recorded++
  }
  return recorded
}

// ─── Action Items ─────────────────────────────────────────────────────────────

export async function listActionItems(protocolId: string): Promise<ProtocolActionItem[]> {
  const sql = getDb()
  return sql<ProtocolActionItem[]>`
    SELECT * FROM protocol_action_items
    WHERE protocol_id = ${protocolId}
    ORDER BY created_at
  `
}

export async function addActionItem(protocolId: string, input: {
  text: string
  assigneeKeycloakId?: string
  dueDate?: string
}): Promise<ProtocolActionItem> {
  const sql = getDb()
  const rows = await sql<ProtocolActionItem[]>`
    INSERT INTO protocol_action_items (protocol_id, text, assignee_keycloak_id, due_date)
    VALUES (${protocolId}, ${input.text}, ${input.assigneeKeycloakId ?? null}, ${input.dueDate ?? null})
    RETURNING *
  `
  return rows[0]
}

export async function getActionItem(id: string): Promise<ProtocolActionItem | null> {
  const sql = getDb()
  const rows = await sql<ProtocolActionItem[]>`SELECT * FROM protocol_action_items WHERE id = ${id}`
  return rows[0] ?? null
}

export async function updateActionItem(id: string, input: Partial<{
  text: string
  assigneeKeycloakId: string
  dueDate: string
  completed: boolean
}>): Promise<ProtocolActionItem> {
  const sql = getDb()
  const rows = await sql<ProtocolActionItem[]>`
    UPDATE protocol_action_items SET
      text                 = COALESCE(${input.text ?? null}, text),
      assignee_keycloak_id = COALESCE(${input.assigneeKeycloakId ?? null}, assignee_keycloak_id),
      due_date             = COALESCE(${input.dueDate ?? null}, due_date),
      completed            = COALESCE(${input.completed ?? null}, completed)
    WHERE id = ${id}
    RETURNING *
  `
  return rows[0]
}

// ─── Beschlussregister settings ───────────────────────────────────────────────

export async function getBeschlussregisterSettings(committeeId: string): Promise<BeschlussRegisterSettings> {
  const sql = getDb()
  const rows = await sql<BeschlussRegisterSettings[]>`
    SELECT * FROM beschluss_register_settings WHERE committee_id = ${committeeId}
  `
  return rows[0] ?? {
    committee_id: committeeId,
    include_protocols: true,
    include_polls: true,
    include_elections: true,
  }
}

export async function upsertBeschlussregisterSettings(
  committeeId: string,
  input: Partial<Omit<BeschlussRegisterSettings, 'committee_id'>>
): Promise<BeschlussRegisterSettings> {
  const sql = getDb()
  const rows = await sql<BeschlussRegisterSettings[]>`
    INSERT INTO beschluss_register_settings (committee_id, include_protocols, include_polls, include_elections)
    VALUES (
      ${committeeId},
      ${input.include_protocols ?? true},
      ${input.include_polls ?? true},
      ${input.include_elections ?? true}
    )
    ON CONFLICT (committee_id) DO UPDATE SET
      include_protocols = COALESCE(${input.include_protocols ?? null}, beschluss_register_settings.include_protocols),
      include_polls     = COALESCE(${input.include_polls ?? null}, beschluss_register_settings.include_polls),
      include_elections = COALESCE(${input.include_elections ?? null}, beschluss_register_settings.include_elections)
    RETURNING *
  `
  return rows[0]
}
