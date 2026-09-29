// T2 (#320 contestability): resolution-challenge service over migration 055's
// `resolution_challenges` (incl. its folded-in `decision_note` column).
//
// Contestability is a RECORDED channel, not auto-reversal — nothing here ever
// modifies protocol_resolutions.result. Each act (file / decide) commits
// together with its Civitas Governance Core INV-1 audit_log entry in ONE
// transaction (sql.begin + writeAuditEntry(entry, tx), audit-db.ts:27-33): a
// rolled-back act leaves no orphan audit row, and a committed act always
// carries its tamper-evident record.
import { getDb } from '../db'
import { writeAuditEntry } from '../audit-db'

/** Full status machine per migration 055; 'withdrawn' is a future author act,
 * not part of the admin disposition surface. */
export type ChallengeStatus = 'open' | 'upheld' | 'dismissed' | 'withdrawn'
export type ChallengeDisposition = 'upheld' | 'dismissed'

export interface ResolutionChallenge {
  id: string
  resolution_id: string
  raised_by: string
  grounds: string
  status: ChallengeStatus
  resolved_by: string | null
  resolved_at: string | null
  decision_note: string | null
  created_at: string
}

/** The same user already has an OPEN challenge on this resolution (migration
 * 055 partial unique index `resolution_challenges_one_open_per_challenger`). */
export class DuplicateOpenChallengeError extends Error {
  constructor(resolutionId: string, raisedBy: string) {
    super(`Offener Einspruch von ${raisedBy} zu Beschluss ${resolutionId} existiert bereits`)
    this.name = 'DuplicateOpenChallengeError'
  }
}

/** The challenged resolution does not exist (FK violation on INSERT). */
export class ResolutionNotFoundError extends Error {
  constructor(resolutionId: string) {
    super(`Beschluss ${resolutionId} nicht gefunden`)
    this.name = 'ResolutionNotFoundError'
  }
}

/**
 * The resolution exists but was never adopted (`decided_at IS NULL`) — its
 * protocol is still draft/submitted. Migration 055 scopes this channel to
 * contesting an ADOPTED resolution: publish IS adoption, and `decided_at` is
 * stamped only inside the publish transaction. Filing against a non-adopted
 * row would write a tamper-evident audit record for an act that was never a
 * binding decision.
 */
export class ResolutionNotAdoptedError extends Error {
  constructor(resolutionId: string) {
    super(`Beschluss ${resolutionId} ist noch nicht angenommen`)
    this.name = 'ResolutionNotAdoptedError'
  }
}

/** No OPEN challenge with this id under this resolution — unknown id,
 * mismatched resolution, or already decided/withdrawn. */
export class ChallengeNotOpenError extends Error {
  constructor(challengeId: string) {
    super(`Einspruch ${challengeId} nicht gefunden oder bereits entschieden`)
    this.name = 'ChallengeNotOpenError'
  }
}

interface PgErrorShape {
  code?: string
  constraint_name?: string
  table_name?: string
}

/**
 * File a member's challenge against a resolution. Same-tx INV-1: the challenge
 * INSERT and the 'resolution_challenge.raised' audit entry commit or roll back
 * together. The duplicate-open 409 is DB-backed (partial unique index), so two
 * racing POSTs cannot both file.
 */
export async function fileChallenge(input: {
  resolutionId: string
  raisedBy: string
  grounds: string
}): Promise<ResolutionChallenge> {
  const sql = getDb()
  try {
    return await sql.begin(async (tx) => {
      // Adoption gate: only an ADOPTED resolution can be contested. The FK
      // catch below proves the row EXISTS; it says nothing about whether the
      // decision was ever binding. `decided_at` is stamped exclusively by
      // recordResolutionAdoptions inside the publish tx, so NULL here means the
      // parent protocol is still draft/submitted. Read inside the tx so the
      // check and the INSERT see the same snapshot.
      const [resolution] = await tx<{ decided_at: string | null }[]>`
        SELECT decided_at FROM protocol_resolutions WHERE id = ${input.resolutionId}
      `
      if (!resolution) throw new ResolutionNotFoundError(input.resolutionId)
      if (resolution.decided_at === null) throw new ResolutionNotAdoptedError(input.resolutionId)

      const [challenge] = await tx<ResolutionChallenge[]>`
        INSERT INTO resolution_challenges (resolution_id, raised_by, grounds)
        VALUES (${input.resolutionId}, ${input.raisedBy}, ${input.grounds})
        RETURNING *
      `
      await writeAuditEntry(
        {
          userId: input.raisedBy,
          field: 'resolution_challenge.raised',
          oldValue: null,
          newValue: JSON.stringify({
            challengeId: challenge.id,
            resolutionId: challenge.resolution_id,
            grounds: challenge.grounds,
          }),
        },
        tx,
      )
      return challenge
    })
  } catch (err) {
    const pg = err as PgErrorShape
    if (pg.code === '23505' && pg.constraint_name === 'resolution_challenges_one_open_per_challenger') {
      throw new DuplicateOpenChallengeError(input.resolutionId, input.raisedBy)
    }
    if (pg.code === '23503' && pg.table_name === 'resolution_challenges') {
      throw new ResolutionNotFoundError(input.resolutionId)
    }
    throw err
  }
}

/**
 * Admin disposition of an OPEN challenge. The UPDATE is guarded on
 * `status = 'open'` (and the owning resolution id from the URL), so a decided
 * challenge can never be re-decided and a mismatched URL never matches. Same-tx
 * INV-1: the status flip and the 'resolution_challenge.decided' audit entry
 * commit or roll back together. protocol_resolutions is deliberately never
 * touched — an upheld challenge is a recorded outcome, not an auto-reversal.
 */
export async function decideChallenge(input: {
  challengeId: string
  resolutionId: string
  resolvedBy: string
  status: ChallengeDisposition
  decisionNote: string | null
}): Promise<ResolutionChallenge> {
  const sql = getDb()
  return sql.begin(async (tx) => {
    const [challenge] = await tx<ResolutionChallenge[]>`
      UPDATE resolution_challenges
      SET status = ${input.status},
          decision_note = ${input.decisionNote},
          resolved_by = ${input.resolvedBy},
          resolved_at = now()
      WHERE id = ${input.challengeId}
        AND resolution_id = ${input.resolutionId}
        AND status = 'open'
      RETURNING *
    `
    if (!challenge) throw new ChallengeNotOpenError(input.challengeId)
    await writeAuditEntry(
      {
        userId: input.resolvedBy,
        field: 'resolution_challenge.decided',
        oldValue: 'open',
        newValue: JSON.stringify({
          challengeId: challenge.id,
          resolutionId: challenge.resolution_id,
          status: challenge.status,
          decisionNote: challenge.decision_note,
        }),
      },
      tx,
    )
    return challenge
  })
}
