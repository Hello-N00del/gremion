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
// While the board is switched off (Karenz) its rows stay where they are, so this hook still
// reaches them: the Art. 17 walk covers a module with a live Karenz row, and the replay on a re-enable
// calls it again with the id only. Every run is made of idempotent updates on the same tables.
//
// Where the board lives decides what ELSE this hook does, and it reads the same sources as the
// router (backend/index.ts): BOARD_BACKEND=service, or the customer's location flag in the default
// 'auto' mode, say the board is in the board module's own database.
//   always                    the two updates on the kernel tables, in one transaction. A board that has moved
//                             leaves its old copy there, and that copy holds the id as well.
//   kernel / moving / no row  that is all: the kernel tables ARE the board.
//   module                    after that transaction has committed, the leaf runs the same two updates in the
//                             board's own database (POST /api/v1/erase-subject) and its counts are reported
//                             beside the kernel copy's.
//     blocked database        the leaf answers 404 tenant_not_provisioned. Nothing was reached there, so the
//                             result is `deferred`: the erasure is owed, the report stays incomplete, and the
//                             replay at re-enable (module-karenz/erasure.ts) calls this hook again with the id
//                             only and fails the restore while it still defers.
//     any other failure       throws (reported `failed`; the orchestrator retries). Never `erased` for
//                             rows the hook did not reach.
//   flag unreadable           the read throws: reported `failed`, never a guess.
// BOARD_BACKEND=inprocess forces the kernel tables and ignores the flag, as the router does. Any value other
// than auto, inprocess or service throws, as the router's factory does.
//
// The flag is read AFTER the two updates, inside the same transaction, and that order matters. The flip of a
// move takes a table lock on the board tables, writes the flag and commits. An update that queued behind
// that lock runs only after the flip, against the old copy; a flag read taken BEFORE the updates would
// still say 'moving', the hook would report the old copy as the board and never reach the module database.
// A read taken after them (READ COMMITTED, so it sees what the flip committed) says 'module', and the leaf
// is asked. An update that got in before the lock makes the flip's own re-check fail, so the move does not
// complete on a copy that lacks it.
//
// The org-unit cascade (deleteBoardsOfOrgUnit, below) is the same decision for the other kernel-driven
// call: while the boards live in the kernel tables the database cascade of migration 0034 removes them
// with the org unit; in the board's own database nothing does, so the kernel asks the leaf.
import type { Sql } from '@gremion/db'
import type { ErasureHookResult, ModuleErasureHook } from '@gremion/ports/erasure'
import { getDb } from '$lib/server/db'
import type { BoardOrgUnitCleanup } from '$lib/server/modules/runtime-registry'
import { getTenant } from '$lib/server/tenant/context'
import { readBoardLocationFrom } from './backend/location'
import { BoardServiceError, ServiceBoardClient } from './backend/service-client'

export const BOARD_ERASED_MARKER = 'erased'

/** The leaf's answer for a blocked (switched-off) or dropped tenant database. */
const NOT_PROVISIONED = 'tenant_not_provisioned'

const isNotProvisioned = (err: unknown): boolean =>
  err instanceof BoardServiceError && err.status === 404 && err.code === NOT_PROVISIONED

type BoardMode = 'auto' | 'inprocess' | 'service'

/**
 * BOARD_BACKEND, read the way the router's factory (backend/index.ts) reads it: unset is 'auto', and a value
 * other than the three it knows is an error, not a guess about which database to touch.
 */
function boardMode(): BoardMode {
  const mode = process.env.BOARD_BACKEND ?? 'auto'
  if (mode === 'auto' || mode === 'inprocess' || mode === 'service') return mode
  throw new Error("[board-erasure] Unknown BOARD_BACKEND value. Valid values are 'auto' (default), 'inprocess' or 'service'.")
}

/**
 * The leaf is told whose database to open by the request's tenant context (the client sends its id and
 * slug). The erasure is for `tenantId`: if the context says another tenant, nothing is sent, because the
 * erasure would run in the wrong customer's database.
 */
function assertRequestTenant(tenantId: string): void {
  if (getTenant().id !== tenantId) {
    throw new Error('board erasure: the request tenant is not the tenant the erasure is for')
  }
}

async function eraseInBoardDatabase(tenantId: string, subjectId: string): Promise<ErasureHookResult> {
  assertRequestTenant(tenantId)
  try {
    const counts = await new ServiceBoardClient().eraseSubject(subjectId)
    return { status: 'erased', counts }
  } catch (err) {
    if (isNotProvisioned(err)) {
      return {
        status: 'deferred',
        reason: 'the board database is blocked (the module is switched off); the erasure is replayed when the module is switched on again',
      }
    }
    throw err
  }
}

export const boardErasureHook: ModuleErasureHook<Sql> = {
  moduleId: 'board',
  async erase({ tenantId, db, subjectId }) {
    if (db === null) return { status: 'skipped', reason: 'no database connection' }
    const mode = boardMode()
    // One transaction: the kernel copy first, then the flag (see the header for why in that order).
    const { kernel, inModule } = await db.begin(async (tx) => {
      const kernel = {
        card_assignee: (await tx`UPDATE card SET assignee_keycloak_id = NULL WHERE assignee_keycloak_id = ${subjectId}`).count,
        card_created_by: (await tx`UPDATE card SET created_by = ${BOARD_ERASED_MARKER} WHERE created_by = ${subjectId}`).count,
      }
      const inModule =
        mode === 'service' || (mode === 'auto' && (await readBoardLocationFrom(tx as unknown as Sql)) === 'module')
      return { kernel, inModule }
    })
    if (!inModule) return { status: 'erased', counts: kernel }
    // The transaction is closed: no database transaction waits on an HTTP call. A failure below leaves the
    // kernel copy erased, and the retry runs both parts again (both are idempotent).
    const leaf = await eraseInBoardDatabase(tenantId, subjectId)
    if (leaf.status !== 'erased') return leaf
    return {
      status: 'erased',
      counts: {
        ...leaf.counts,
        card_assignee_kernel_copy: kernel.card_assignee,
        card_created_by_kernel_copy: kernel.card_created_by,
      },
    }
  },
}

/**
 * After the kernel deleted an org unit: remove that org unit's boards from the board's own database.
 * The answer says which of three things happened:
 *   not-due   the boards live in the kernel tables (flag kernel / moving / no row, or BOARD_BACKEND=inprocess):
 *             the cascade did it, no call was made;
 *   deleted   the leaf removed `boards` boards;
 *   deferred  the call was owed (the boards are in the board's own database) and could not be made because
 *             that database is blocked or gone (404 tenant_not_provisioned). The caller says so in the log,
 *             since nothing else records that the boards of this org unit are still there.
 * Any other failure throws and the caller (the org-unit delete) logs it without undoing the delete.
 * The flag is read fresh from the kernel database, not from the router's 5 second cache.
 */
export async function deleteBoardsOfOrgUnit(orgUnitId: string): Promise<BoardOrgUnitCleanup> {
  const mode = boardMode()
  if (mode === 'inprocess') return { status: 'not-due' }
  if (mode === 'auto' && (await readBoardLocationFrom(getDb())) !== 'module') return { status: 'not-due' }
  try {
    return { status: 'deleted', boards: await new ServiceBoardClient().deleteBoardsForOrgUnit(orgUnitId) }
  } catch (err) {
    if (isNotProvisioned(err)) return { status: 'deferred' }
    throw err
  }
}
