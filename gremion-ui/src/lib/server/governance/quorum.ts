import { getDb } from '../db'
import { getRunner as genericGetRunner, type PgTransaction } from '$lib/server/db/tx'

const getRunner = (tx: PgTransaction | undefined) => genericGetRunner(tx, getDb)

export interface QuorumContext {
  eligibleVotingCount: number
  presentVotingCount: number
  quorate: boolean
}

/**
 * Governance Core INV-5 (quorum gate). Eligible voters = voting members of
 * the protocol's body; present = those with attendance 'present'. Preset rule:
 * quorate iff a strict majority of eligible voting members are present.
 */
export async function getQuorumContext(
  protocolId: string,
  tx?: PgTransaction,
): Promise<QuorumContext> {
  const sql = getRunner(tx)
  const rows = await sql<{ eligible: string; present: string }[]>`
    WITH body AS (
      SELECT committee_id FROM protocols WHERE id = ${protocolId}
    ),
    eligible AS (
      SELECT m.user_keycloak_id
      FROM org_unit_members m
      JOIN body ON m.org_unit_id = body.committee_id
      WHERE m.voting = true
    )
    SELECT
      (SELECT count(*) FROM eligible)::text AS eligible,
      (SELECT count(*)
         FROM eligible e
         JOIN protocol_attendance a
           ON a.user_keycloak_id = e.user_keycloak_id
          AND a.protocol_id = ${protocolId}
          AND a.status = 'present')::text AS present
  `
  const eligibleVotingCount = Number(rows[0]?.eligible ?? 0)
  const presentVotingCount = Number(rows[0]?.present ?? 0)
  const quorate = eligibleVotingCount > 0 && presentVotingCount * 2 > eligibleVotingCount
  return { eligibleVotingCount, presentVotingCount, quorate }
}
