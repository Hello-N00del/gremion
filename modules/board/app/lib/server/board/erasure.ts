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
// While the board is switched off (Karenz) its rows stay in the tenant's kernel database, so this hook still
// reaches them: the Art. 17 walk covers a module with a live Karenz row, and the replay on a re-enable
// calls it again with the id only. Both runs are idempotent updates on the same tables.
//
// Where the board lives decides what this hook may claim, and it reads the same sources as the
// router (backend/index.ts): BOARD_BACKEND=service, or the customer's location flag in the default
// 'auto' mode, say the board is in the board module's own database. The kernel holds no connection
// to that database, so the hook reports `skipped` rather than claim an erasure it did not perform.
//   kernel / moving / no row  the kernel tables serve the board: run the updates. While a move is
//                             copying, the flip of that move takes a table lock and re-checks the
//                             copy, so these updates are not lost.
//   module                    skipped.
//   flag unreadable           the read throws: reported `failed`, never a guess.
// BOARD_BACKEND=inprocess forces the kernel tables and ignores the flag, as the router does.
import type { Sql } from '@gremion/db'
import type { ModuleErasureHook } from '@gremion/ports/erasure'
import { readBoardLocationFrom } from './backend/location'

export const BOARD_ERASED_MARKER = 'erased'

const MODULE_DB_REASON = 'board data lives in the board module database; the kernel holds no connection to it'

export const boardErasureHook: ModuleErasureHook<Sql> = {
  moduleId: 'board',
  async erase({ db, subjectId }) {
    const mode = process.env.BOARD_BACKEND ?? 'auto'
    if (mode === 'service') return { status: 'skipped', reason: MODULE_DB_REASON }
    if (db === null) return { status: 'skipped', reason: 'no database connection' }
    // The flag is read inside the transaction of the updates, uncached, so the answer is as fresh as
    // the updates it guards (the router's own read may be up to 5 seconds old).
    const counts = await db.begin(async (tx) => {
      if (mode === 'auto' && (await readBoardLocationFrom(tx as unknown as Sql)) === 'module') return null
      return {
        card_assignee: (await tx`UPDATE card SET assignee_keycloak_id = NULL WHERE assignee_keycloak_id = ${subjectId}`).count,
        card_created_by: (await tx`UPDATE card SET created_by = ${BOARD_ERASED_MARKER} WHERE created_by = ${subjectId}`).count,
      }
    })
    if (counts === null) return { status: 'skipped', reason: MODULE_DB_REASON }
    return { status: 'erased', counts }
  },
}
