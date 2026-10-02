import { error, json } from '@sveltejs/kit'
import type { RequestEvent } from '@sveltejs/kit'
import type { SessionUser } from '$lib/auth'
import { getBeschlussregisterSettings } from '$lib/server/protocols/protocol-db'
import { getDb } from '$lib/server/db'
import { getOrgUnit } from '$lib/server/governance/org-units-db'
import { viewerCanSeeProtocol } from '$lib/server/governance/visibility'

function requireAuth(event: RequestEvent): SessionUser {
  const user = event.locals.user as SessionUser | undefined
  if (!user) throw error(401, 'Unauthenticated')
  return user
}

// R29-F104-KTWIN (kernel twin of F1-FIX-04 / S3#39, operator decision D-3): the
// register lists PUBLISHED resolutions, so it follows canSeeProtocol for status
// 'published': a committee_only unit only for its members and CouncilAdmins, an
// all_members unit for every signed-in user. A hidden unit answers 404, exactly
// like a missing one, before any register read.
export async function GET(event: RequestEvent) {
  const user = requireAuth(event)
  const committeeId = event.params.id!
  const unit = await getOrgUnit(committeeId)
  if (!unit || !(await viewerCanSeeProtocol(user, committeeId, unit, 'published'))) {
    throw error(404, 'Gremium nicht gefunden')
  }
  const settings = await getBeschlussregisterSettings(committeeId)

  const yearParam = event.url.searchParams.get('year')
  const year = yearParam ? parseInt(yearParam, 10) : undefined

  const entries: unknown[] = []
  const sql = getDb()

  if (settings.include_protocols) {
    // Cast year to ::int so porsager/postgres can infer the parameter type
    // when the value is null (otherwise PostgreSQL rejects the prepared
    // statement with "could not determine data type of parameter").
    const rows = await sql`
      SELECT
        r.id, r.global_nr, r.sequence_nr, r.text,
        r.votes_yes, r.votes_no, r.votes_abstain, r.result, r.created_at,
        p.meeting_date, p.title AS protocol_title, p.id AS protocol_id,
        'beschluss' AS type
      FROM protocol_resolutions r
      JOIN protocols p ON p.id = r.protocol_id
      WHERE p.committee_id = ${committeeId}
        AND p.status = 'published'
        AND (${year ?? null}::int IS NULL OR EXTRACT(YEAR FROM p.meeting_date) = ${year ?? null}::int)
      ORDER BY p.meeting_date DESC, r.sequence_nr
    `
    entries.push(...rows)
  }

  // (open-core carve) settings.include_polls previously merged Nextcloud Polls
  // entries into the Beschlussregister. Nextcloud Polls is a feature module, not
  // part of the governance kernel; only native protocol resolutions are listed
  // here. A re-added polls module contributes its entries via a registered
  // provider rather than being imported by name.

  return json({ entries, settings })
}
