// gremion-ui/src/lib/server/tenant/provisioner/board-location-flag.ts
//
// The create flow's one write to the board location flag (table board_location, migration 0066): a customer
// created with board ticked has the board's own database from the first minute, so the flag says `module`
// and the board is served from it. Nothing is ever moved on a new customer.
//
// This is a change of WHERE THE DATA LIVES, so it is held to the rule that every such change follows: one
// transaction that locks the three board tables, re-checks that they are empty and only then writes. A
// writer that is still in flight (the kernel erasure hook, an org-unit cascade) therefore either finishes
// before the lock is granted and is seen by the count, or waits until the flag is `module`; a row can never
// land in the kernel tables after the count and sit unseen behind the flag.
//
//   - an ACTIVE customer is never flipped (assertBoardLocationModule reads and refuses): it has live
//     traffic and the router keeps its answer for 5 seconds, so a write that read `kernel` just before
//     a flip would land in the kernel tables behind the new flag, and the table lock cannot see it. Only a
//     customer still being created has no traffic. The move closes that gap for a live customer;
//   - a flag that already says `module` is left alone: no transaction, no lock, no write (a rerun of the
//     create over a finished customer makes no change);
//   - a move that is running (`moving`) is refused: the move owns the flag until it flips it;
//   - rows in `board`, `stack` or `card` are refused: only the move carries rows, and flagging `module`
//     over them would hide them. A refusal names the counts and nothing else;
//   - the row is read back after the commit: the flag is `module` or the create fails.
//
// It is called from the provisioner's kernel context (the customer's own database, the app role), and
// never from a request path.
import type { Sql } from '@gremion/db'
import { ProvisioningError } from '@gremion/provisioning'

export async function setBoardLocationModule(sql: Sql): Promise<{ changed: boolean }> {
  const before = await readLocation(sql)
  if (before === 'module') return { changed: false }
  if (before === 'moving') throw movingRefusal()

  const changed = await sql.begin(async (tx) => {
    // bounds the wait for the tables (5 s); a writer that holds them longer fails the create, which is resumable
    await tx`SET LOCAL lock_timeout = '5s'`
    await tx`LOCK TABLE board, stack, card IN SHARE ROW EXCLUSIVE MODE`
    const [n] = await tx<{ board: string; stack: string; card: string }[]>`
      SELECT (SELECT count(*) FROM board)::text AS board, (SELECT count(*) FROM stack)::text AS stack, (SELECT count(*) FROM card)::text AS card`
    const counts = { board: Number(n?.board ?? 0), stack: Number(n?.stack ?? 0), card: Number(n?.card ?? 0) }
    if (counts.board + counts.stack + counts.card > 0) {
      throw new ProvisioningError(
        'CUSTOMER_STATE',
        `the kernel board tables hold ${counts.board} board(s), ${counts.stack} stack(s) and ${counts.card} card(s): the board location is not set to module over rows; they are carried by board-move`,
      )
    }
    const written = await tx<{ location: string }[]>`
      INSERT INTO board_location (id, location, changed_at) VALUES (true, 'module', now())
      ON CONFLICT (id) DO UPDATE SET location = 'module', changed_at = now() WHERE board_location.location = 'kernel'
      RETURNING location`
    if (written.length > 0) return true
    // the row changed between the read above and the lock: what it says now decides
    const now = await readLocation(tx as unknown as Sql)
    if (now === 'module') return false
    throw now === 'moving' ? movingRefusal() : new ProvisioningError('POSTCONDITION', 'the board location row could not be written')
  })

  const after = await readLocation(sql)
  if (after !== 'module') throw new ProvisioningError('POSTCONDITION', `the board location reads ${after ?? 'no row'} after it was set to module`)
  return { changed }
}

/**
 * The read-only form, for a customer that is already active (a rerun of the create over a finished
 * customer): `module` is the answer that was set while it was still being created; anything else is a
 * refusal that points at the move. No transaction, no lock, no write.
 */
export async function assertBoardLocationModule(sql: Sql): Promise<{ changed: boolean }> {
  const location = await readLocation(sql)
  if (location === 'module') return { changed: false }
  throw new ProvisioningError(
    'CUSTOMER_STATE',
    `the board location of this active customer reads ${location ?? 'no row'}, not module: it is not set while the customer is live; run board-move to put the board in its own database`,
  )
}

async function readLocation(sql: Sql): Promise<string | null> {
  const rows = await sql<{ location: string }[]>`SELECT location FROM board_location WHERE id`
  return rows[0]?.location ?? null
}

function movingRefusal(): ProvisioningError {
  return new ProvisioningError('CUSTOMER_STATE', 'a board move is running for this customer: the board location is not set while it runs')
}
