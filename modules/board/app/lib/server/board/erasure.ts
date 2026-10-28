// TRD-196 / PRD-OPS-005 — the board module's erasure hook (contract:
// @gremion/ports/erasure, registered in register.server.ts).
//
// Policy (retention catalogue RC-BRD: boards and cards are planning data with no
// statutory hold; the person, not the card, is what an erasure removes):
//   pseudonymised  card.created_by -> 'erased' (authorship; a marker that matches
//                  no user)
//   unlinked       card.assignee_keycloak_id -> NULL (an unassigned card is a valid
//                  state; the task itself stays for the council)
//   kept           boards, stacks, cards (their text is the council's task record;
//                  free text a user typed into a title is not searched for names)
//
// With BOARD_BACKEND=service the board leaf owns its own database; the kernel holds
// no connection to it, so this module reports `skipped` rather than claim an
// erasure it did not perform.
import type { Sql } from '@gremion/db'
import type { ModuleErasureHook } from '@gremion/ports/erasure'

export const BOARD_ERASED_MARKER = 'erased'

export const boardErasureHook: ModuleErasureHook<Sql> = {
  moduleId: 'board',
  async erase({ db, subjectId }) {
    if ((process.env.BOARD_BACKEND ?? 'inprocess') === 'service') {
      return {
        status: 'skipped',
        reason: 'board data lives in the board service database; the kernel holds no connection to it',
      }
    }
    if (db === null) return { status: 'skipped', reason: 'no database connection' }
    const counts = await db.begin(async (tx) => ({
      card_assignee: (await tx`UPDATE card SET assignee_keycloak_id = NULL WHERE assignee_keycloak_id = ${subjectId}`).count,
      card_created_by: (await tx`UPDATE card SET created_by = ${BOARD_ERASED_MARKER} WHERE created_by = ${subjectId}`).count,
    }))
    return { status: 'erased', counts }
  },
}
