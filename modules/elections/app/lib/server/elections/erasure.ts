// TRD-196 / PRD-OPS-005 — the elections module's erasure hook (contract:
// @gremion/ports/erasure, registered in register.server.ts).
//
// Policy (retention catalogue RC-ELE: ballots and electorates follow RC-GOV-SECRET,
// results follow RC-GOV-RES; the tally and the election record are never erased):
//   pseudonymised  committee_elections.created_by -> the nil uuid (the organiser;
//                  the column is NOT NULL uuid, so a marker uuid that matches no
//                  user, not NULL)
//   kept           every committee_elections row (Helios uuid, org-unit link,
//                  calendar link, archive state): the election record
//
// Named residual (NOT done here, and why): the voter roll and the cast-vote
// trail live in the external Helios instance. Helios offers the kernel no way to
// delete or anonymise a voter, and doing so would break the verifiability of a
// frozen election (the voter list is part of the public audit trail). Ballots
// are anonymous by Helios design (encrypted, tallied homomorphically); the
// individual ballot/voter data is deleted by the Helios operator after the
// challenge window (RC-GOV-SECRET). The kernel keeps no voter linkage of its own,
// so there is nothing further to pseudonymise on this side.
import type { Sql } from '@gremion/db'
import type { ModuleErasureHook } from '@gremion/ports/erasure'

export const ELECTIONS_ERASED_UUID = '00000000-0000-0000-0000-000000000000'

export const electionsErasureHook: ModuleErasureHook<Sql> = {
  moduleId: 'elections',
  async erase({ db, subjectId }) {
    if (db === null) return { status: 'skipped', reason: 'no database connection' }
    // created_by is uuid: compare as text so a non-uuid subject id matches nothing
    // instead of raising "invalid input syntax for type uuid".
    const res = await db`UPDATE committee_elections SET created_by = ${ELECTIONS_ERASED_UUID} WHERE created_by::text = ${subjectId}`
    return { status: 'erased', counts: { committee_elections: res.count } }
  },
}
