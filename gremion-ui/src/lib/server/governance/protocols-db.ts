// src/lib/server/governance/protocols-db.ts
// Read-side aggregation for the two top-level governance surfaces that draw
// from the meeting-minutes schema (migrations/0007_protocols.sql):
//   • /protokolle  — every protocol across all committees (listProtocols)
//   • /beschluesse — passed resolutions across all published protocols
//                    (listBeschluesse) — the canonical Beschlussbuch source.
// `committees` was renamed to `org_units` (migration 010), so
// `protocols.committee_id` joins `org_units.id` 1:1.
import { getDb } from '../db'

export interface BeschlussRow {
  id: string
  globalNr: string | null
  sequenceNr: number
  text: string
  // Nullable (Phase-2 acclamation franchise): an acclamation Beschluss carries
  // NO tally — the counts are optional show-of-hands numbers, NULL when unrecorded.
  votesYes: number | null
  votesNo: number | null
  votesAbstain: number | null
  // 'tally' = counted vote (verdict computed); 'acclamation' = declared by the
  // chair. Values match the DB column (migration 054) 1:1.
  adoptionMode: 'tally' | 'acclamation'
  meetingDate: string // YYYY-MM-DD
  protocolTitle: string
  committeeId: string
  committeeName: string
  // T6 (#320 contestability): number of OPEN challenges (migration 055,
  // resolution_challenges.status = 'open') against this resolution — drives
  // the 'Einspruch offen' badge on /beschluesse.
  openChallengeCount: number
}

// Passed resolutions from published protocols, newest meeting first. Drafts and
// rejected/withdrawn resolutions are excluded — the Beschlussbuch only carries
// binding, published decisions.
export async function listBeschluesse(): Promise<readonly BeschlussRow[]> {
  return getDb()<BeschlussRow[]>`
    SELECT r.id::text                                AS "id",
           r.global_nr                               AS "globalNr",
           r.sequence_nr                             AS "sequenceNr",
           r.text                                    AS "text",
           r.votes_yes                               AS "votesYes",
           r.votes_no                                AS "votesNo",
           r.votes_abstain                           AS "votesAbstain",
           r.adoption_mode                           AS "adoptionMode",
           to_char(p.meeting_date, 'YYYY-MM-DD')     AS "meetingDate",
           p.title                                   AS "protocolTitle",
           ou.id::text                               AS "committeeId",
           ou.name                                   AS "committeeName",
           (SELECT count(*)::int FROM resolution_challenges c
              WHERE c.resolution_id = r.id AND c.status = 'open') AS "openChallengeCount"
    FROM protocol_resolutions r
    JOIN protocols  p  ON p.id = r.protocol_id
    JOIN org_units  ou ON ou.id = p.committee_id
    WHERE r.result = 'passed' AND p.status = 'published'
    ORDER BY p.meeting_date DESC, r.sequence_nr ASC`
}

// T6 (#320 contestability): one challenge row for the admin disposition
// controls on /beschluesse. Field names follow the APPLIED 055 schema
// (raised_by / resolved_by / resolved_at) — the migration is the source of
// truth for this read side. resolvedBy/resolvedAt are NULL while the
// challenge is open.
export interface BeschlussChallengeRow {
  id: string
  resolutionId: string
  raisedBy: string
  grounds: string
  status: 'open' | 'upheld' | 'dismissed' | 'withdrawn'
  resolvedBy: string | null
  resolvedAt: string | null
  createdAt: string
}

// Companion to listBeschluesse for CouncilAdmin viewers: every challenge whose
// resolution is IN the register universe (passed + published — same predicate
// as listBeschluesse, so a challenge can never reference a row the page does
// not render). Open challenges first, newest first within each group.
export async function listChallengesForBeschluesse(): Promise<readonly BeschlussChallengeRow[]> {
  return getDb()<BeschlussChallengeRow[]>`
    SELECT c.id::text            AS "id",
           c.resolution_id::text AS "resolutionId",
           c.raised_by           AS "raisedBy",
           c.grounds             AS "grounds",
           c.status              AS "status",
           c.resolved_by         AS "resolvedBy",
           to_char(c.resolved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "resolvedAt",
           to_char(c.created_at  AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "createdAt"
    FROM resolution_challenges c
    JOIN protocol_resolutions r ON r.id = c.resolution_id
    JOIN protocols p            ON p.id = r.protocol_id
    WHERE r.result = 'passed' AND p.status = 'published'
    ORDER BY (c.status = 'open') DESC, c.created_at DESC`
}

export interface ProtokollRow {
  id: string
  title: string
  meetingDate: string // YYYY-MM-DD
  status: 'draft' | 'submitted' | 'published'
  committeeId: string
  committeeName: string
  attended: number
  total: number
  // TOPs (Tagesordnungspunkte) aren't modelled as a distinct table, so we use
  // the count of structured outcomes (resolutions + action items) as a proxy.
  // Documented seam: revisit if an agenda-item model lands.
  tops: number
}

// Every protocol across all committees, newest meeting first.
export async function listProtocols(): Promise<readonly ProtokollRow[]> {
  return getDb()<ProtokollRow[]>`
    SELECT p.id::text                            AS "id",
           p.title                               AS "title",
           to_char(p.meeting_date, 'YYYY-MM-DD') AS "meetingDate",
           p.status                              AS "status",
           ou.id::text                           AS "committeeId",
           ou.name                               AS "committeeName",
           (SELECT count(*)::int FROM protocol_attendance a
              WHERE a.protocol_id = p.id AND a.status = 'present')  AS "attended",
           (SELECT count(*)::int FROM protocol_attendance a
              WHERE a.protocol_id = p.id)                          AS "total",
           ((SELECT count(*) FROM protocol_resolutions r WHERE r.protocol_id = p.id)
            + (SELECT count(*) FROM protocol_action_items ai WHERE ai.protocol_id = p.id))::int AS "tops"
    FROM protocols p
    JOIN org_units ou ON ou.id = p.committee_id
    ORDER BY p.meeting_date DESC`
}
