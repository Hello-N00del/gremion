// T6 (#320 contestability UI): the /beschluesse read side must surface the
// contestability channel (migration 055, resolution_challenges):
//   • listBeschluesse returns per-row `openChallengeCount` (status='open' only)
//     so the register can badge affected rows;
//   • the admin companion listChallengesForBeschluesse returns each register
//     row's challenge disposition data (status/raisedBy/resolvedBy/resolvedAt)
//     for the CouncilAdmin-gated disposition controls.
// Column names follow the APPLIED 055 schema (raised_by / resolved_by /
// resolved_at) — the migration is the source of truth for the read side.
import { describe, it, expect, beforeEach } from 'vitest'
import { getDb } from '../db'
import { createOrgUnit } from './org-units-db'
import { createProtocol } from '../protocols/protocol-db'
import { listBeschluesse, listChallengesForBeschluesse, listProtocols } from './protocols-db'

// A published protocol under a fresh org unit with `n` passed resolutions.
// Returns the resolution ids in sequence order.
async function seedPublishedProtocolWithResolutions(n: number): Promise<string[]> {
  const unit = await createOrgUnit({
    name: 'Rat', description: null, parentId: null, kind: 'council',
    visibility: 'all_members', wantsMatrixRoom: false, wantsNextcloudFolder: false,
  })
  const protocol = await createProtocol({
    committeeId: unit.id, meetingDate: '2026-07-01', title: 'Sitzung', createdBy: 'chair-0',
  })
  const sql = getDb()
  await sql`UPDATE protocols SET status = 'published' WHERE id = ${protocol.id}`
  const ids: string[] = []
  for (let i = 1; i <= n; i++) {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO protocol_resolutions
        (protocol_id, sequence_nr, text, votes_yes, votes_no, votes_abstain, result)
      VALUES (${protocol.id}, ${i}, ${`Beschluss ${i}`}, 5, 1, 0, 'passed')
      RETURNING id::text AS "id"`
    ids.push(row!.id)
  }
  return ids
}

describe('beschluesse challenge read side (T6)', () => {
  beforeEach(async () => {
    const sql = getDb()
    // Cascades protocols → protocol_resolutions → resolution_challenges.
    await sql`TRUNCATE org_units RESTART IDENTITY CASCADE`
  })

  describe('listBeschluesse openChallengeCount', () => {
    it('returns 0 for rows without challenges', async () => {
      await seedPublishedProtocolWithResolutions(1)
      const rows = await listBeschluesse()
      expect(rows).toHaveLength(1)
      expect(rows[0]!.openChallengeCount).toBe(0)
    })

    it('counts ONLY open challenges, per row', async () => {
      const [res1, res2] = await seedPublishedProtocolWithResolutions(2)
      const sql = getDb()
      // res1: two open + one dismissed → count 2. res2: none → 0.
      await sql`INSERT INTO resolution_challenges (resolution_id, raised_by, grounds)
                VALUES (${res1!}, 'member-1', 'Formfehler'), (${res1!}, 'member-2', 'Fristverstoß')`
      await sql`INSERT INTO resolution_challenges
                  (resolution_id, raised_by, grounds, status, resolved_by, resolved_at)
                VALUES (${res1!}, 'member-3', 'Unzuständig', 'dismissed', 'admin-1', now())`
      const rows = await listBeschluesse()
      expect(rows).toHaveLength(2)
      const byId = new Map(rows.map((r) => [r.id, r]))
      expect(byId.get(res1!)!.openChallengeCount).toBe(2)
      expect(byId.get(res2!)!.openChallengeCount).toBe(0)
    })
  })

  // R29-F104-KTWIN (D-3): the /beschluesse and /protokolle loaders filter rows
  // by the unit's visibility, so both queries must carry it from the real schema.
  describe('unit visibility on the read side', () => {
    it('listBeschluesse returns each row\'s org unit visibility', async () => {
      await seedPublishedProtocolWithResolutions(1)
      const sql = getDb()
      await sql`UPDATE org_units SET visibility = 'committee_only'`
      const rows = await listBeschluesse()
      expect(rows).toHaveLength(1)
      expect(rows[0]!.visibility).toBe('committee_only')
    })

    it('listProtocols returns each row\'s org unit visibility', async () => {
      await seedPublishedProtocolWithResolutions(1)
      const sql = getDb()
      await sql`UPDATE org_units SET visibility = 'committee_only'`
      const rows = await listProtocols()
      expect(rows).toHaveLength(1)
      expect(rows[0]!.visibility).toBe('committee_only')
      expect(rows[0]!.status).toBe('published')
    })
  })

  describe('listChallengesForBeschluesse (admin disposition data)', () => {
    it('returns each register row\'s challenges with disposition data', async () => {
      const [res1] = await seedPublishedProtocolWithResolutions(1)
      const sql = getDb()
      await sql`INSERT INTO resolution_challenges (resolution_id, raised_by, grounds)
                VALUES (${res1!}, 'member-1', 'Formfehler')`
      await sql`INSERT INTO resolution_challenges
                  (resolution_id, raised_by, grounds, status, resolved_by, resolved_at)
                VALUES (${res1!}, 'member-2', 'Unzuständig', 'dismissed', 'admin-1', now())`

      const challenges = await listChallengesForBeschluesse()
      expect(challenges).toHaveLength(2)

      const open = challenges.find((c) => c.status === 'open')!
      expect(open.resolutionId).toBe(res1!)
      expect(open.raisedBy).toBe('member-1')
      expect(open.grounds).toBe('Formfehler')
      expect(open.resolvedBy).toBeNull()
      expect(open.resolvedAt).toBeNull()
      expect(typeof open.id).toBe('string')
      expect(open.createdAt).toBeTruthy()

      const dismissed = challenges.find((c) => c.status === 'dismissed')!
      expect(dismissed.resolutionId).toBe(res1!)
      expect(dismissed.raisedBy).toBe('member-2')
      expect(dismissed.resolvedBy).toBe('admin-1')
      expect(dismissed.resolvedAt).toBeTruthy()
    })

    it('excludes challenges whose protocol is not published (register universe only)', async () => {
      const [res1] = await seedPublishedProtocolWithResolutions(1)
      const sql = getDb()
      await sql`INSERT INTO resolution_challenges (resolution_id, raised_by, grounds)
                VALUES (${res1!}, 'member-1', 'Formfehler')`
      // Flip the protocol back to draft: the register no longer carries the row,
      // so its challenges must vanish from the admin companion too.
      await sql`UPDATE protocols SET status = 'draft'
                WHERE id = (SELECT protocol_id FROM protocol_resolutions WHERE id = ${res1!})`
      expect(await listChallengesForBeschluesse()).toHaveLength(0)
    })
  })
})
