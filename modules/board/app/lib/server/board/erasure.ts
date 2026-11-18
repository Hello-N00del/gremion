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
// calls it again with the id only. Both runs are idempotent updates on the same tables.
//
// Where the board lives decides what this hook does, and it reads the same sources as the
// router (backend/index.ts): BOARD_BACKEND=service, or the customer's location flag in the default
// 'auto' mode, say the board is in the board module's own database.
//   kernel / moving / no row  the kernel tables serve the board: run the updates. While a move is
//                             copying, the flip of that move takes a table lock and re-checks the
//                             copy, so these updates are not lost.
//   module                    the board's own database: ask the leaf to run the same two updates
//                             (POST /api/v1/erase-subject) and report ITS counts.
//     blocked database        the leaf answers 404 tenant_not_provisioned. Nothing was reached, so the
//                             result is `skipped` with a reason that begins "deferred:": the erasure is
//                             owed and the replay at re-enable (module-karenz/erasure.ts) calls this hook
//                             again with the id only. The port has no separate "deferred" status, and the
//                             orchestrator already treats a skip as an incomplete erasure, which is true.
//     any other failure       throws (reported `failed`; the orchestrator retries). Never `erased` for
//                             rows the hook did not reach.
//   flag unreadable           the read throws: reported `failed`, never a guess.
// BOARD_BACKEND=inprocess forces the kernel tables and ignores the flag, as the router does.
//
// The org-unit cascade (deleteBoardsOfOrgUnit, below) is the same decision for the other kernel-driven
// call: while the boards live in the kernel tables the database cascade of migration 0034 removes them
// with the org unit; in the board's own database nothing does, so the kernel asks the leaf.
import type { Sql } from '@gremion/db'
import type { ErasureHookResult, ModuleErasureHook } from '@gremion/ports/erasure'
import { getDb } from '$lib/server/db'
import { getTenant } from '$lib/server/tenant/context'
import { readBoardLocationFrom } from './backend/location'
import { BoardServiceError, ServiceBoardClient } from './backend/service-client'

export const BOARD_ERASED_MARKER = 'erased'

/** The leaf's answer for a blocked (switched-off) or dropped tenant database. */
const NOT_PROVISIONED = 'tenant_not_provisioned'

const isNotProvisioned = (err: unknown): boolean =>
  err instanceof BoardServiceError && err.status === 404 && err.code === NOT_PROVISIONED

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
        status: 'skipped',
        reason: 'deferred: the board database is blocked (the module is switched off); the erasure is replayed when the module is switched on again',
      }
    }
    throw err
  }
}

export const boardErasureHook: ModuleErasureHook<Sql> = {
  moduleId: 'board',
  async erase({ tenantId, db, subjectId }) {
    const mode = process.env.BOARD_BACKEND ?? 'auto'
    if (mode === 'service') return eraseInBoardDatabase(tenantId, subjectId)
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
    if (counts === null) return eraseInBoardDatabase(tenantId, subjectId)
    return { status: 'erased', counts }
  },
}

/**
 * After the kernel deleted an org unit: remove that org unit's boards from the board's own database.
 * Returns how many boards the leaf deleted, or null when no call was due or none could be made:
 *   - the boards live in the kernel tables (flag kernel / moving / no row, or BOARD_BACKEND=inprocess):
 *     the cascade did it, nothing to call;
 *   - the board database is blocked or gone (404 tenant_not_provisioned): nothing is reachable now.
 * Any other failure throws and the caller (the org-unit delete) logs it without undoing the delete.
 * The flag is read fresh from the kernel database, not from the router's 5 second cache.
 */
export async function deleteBoardsOfOrgUnit(orgUnitId: string): Promise<number | null> {
  const mode = process.env.BOARD_BACKEND ?? 'auto'
  if (mode === 'inprocess') return null
  if (mode === 'auto' && (await readBoardLocationFrom(getDb())) !== 'module') return null
  try {
    return await new ServiceBoardClient().deleteBoardsForOrgUnit(orgUnitId)
  } catch (err) {
    if (isNotProvisioned(err)) return null
    throw err
  }
}
