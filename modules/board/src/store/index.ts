// services/board/src/store/index.ts
//
// The board leaf's Postgres store: domain types, the re-exported migration
// runner (defined in ../migrations.ts), a single-DB connection accessor, and the
// board/stack/card query ops.
//
// The ops are lifted verbatim from gremion-ui/src/lib/server/board/board-db.ts
// (byte-identical SQL) but take an explicit `sql` handle as their first argument
// so tests can inject a pre-seeded pool (mirrors the newsletter/calendar leaf
// store-op shape). This leaf owns a SINGLE database (BOARD_PG_URL) — there is no
// per-tenant CREATE DATABASE machinery here (that provisioning is a documented
// cutover prerequisite, see docs/runbooks/board-cutover.md).

import postgres from 'postgres'
import { runMigrations, _resetMigrationCacheForTests } from '../migrations.js'

// Re-export the migration runner (relocated to src/migrations.ts at depth 1 so
// its MIGRATIONS_DIR resolves correctly from the depth-1 esbuild bundle as well
// as the source tree) so existing `store/index` importers keep working.
export { runMigrations }

/**
 * Resolve the runtime Postgres URL, failing closed. In production BOARD_PG_URL
 * is set; we deliberately DO NOT fall back to localhost:5432 — on the staging host
 * that port is the LIVE kernel Postgres (#394 require-explicit-env posture). Fires
 * only when neither an explicit pgUrl nor the env var is set (a misconfiguration).
 */
export function requireRuntimePgUrl(explicit: string | undefined, envName: string): string {
  const url = explicit || process.env[envName]
  if (!url) {
    throw new Error(
      `[board] no Postgres URL configured — set ${envName} (or pass options.pgUrl). ` +
        'Refusing to default to localhost:5432 (the LIVE kernel Postgres on the staging host).',
    )
  }
  return url
}

// ── types ─────────────────────────────────────────────────────────────────────

export type Sql = ReturnType<typeof postgres>

/** Minimal tenant identity carried on guard-validated headers (kept for HTTP
 *  handler-signature parity with the other leaves; the single-DB store ignores
 *  it today). */
export interface TenantRef {
  readonly id: string
  readonly slug: string
}

export interface Board {
  readonly id: string
  readonly org_unit_id: string
  readonly name: string
  readonly archived: boolean
  readonly created_at: Date
}

export interface Stack {
  readonly id: string
  readonly board_id: string
  readonly name: string
  readonly sort_order: number
}

export interface Card {
  readonly id: string
  readonly stack_id: string
  readonly title: string
  readonly description: string | null
  readonly assignee_keycloak_id: string | null
  readonly due_date: string | null
  readonly label: string | null
  readonly sort_order: number
  readonly protocol_action_item_id: string | null
  readonly created_by: string | null
  readonly created_at: Date
}

export interface Deck {
  board: Board
  stacks: readonly Stack[]
  cards: readonly Card[]
}

// ── single-DB connection accessor ────────────────────────────────────────────

let _pool: Sql | null = null

export interface StoreOptions {
  pgUrl?: string
}

/**
 * Return the leaf's single ready postgres-js pool, creating it (and running the
 * manifest-verified migrations) on first contact. Identity guarantee: repeated
 * calls return the SAME pool until _resetStoreForTests() drains it.
 */
export async function getStore(options: StoreOptions = {}): Promise<Sql> {
  if (_pool) return _pool
  const pgUrl = requireRuntimePgUrl(options.pgUrl, 'BOARD_PG_URL')
  await runMigrations(pgUrl)
  _pool = postgres(pgUrl, { max: 4, prepare: true, idle_timeout: 20, connect_timeout: 10 })
  return _pool
}

/** TEST-ONLY: drain the pool + clear the manifest cache. */
export async function _resetStoreForTests(): Promise<void> {
  if (_pool !== null) {
    await _pool.end().catch(() => {})
    _pool = null
  }
  _resetMigrationCacheForTests()
}

// ── store ops (byte-identical SQL to board-db.ts, sql-param shape) ────────────

export async function createBoard(
  sql: Sql,
  data: { orgUnitId: string; name: string; archived?: boolean },
): Promise<Board> {
  const rows = await sql<Board[]>`
    INSERT INTO board (org_unit_id, name, archived)
    VALUES (${data.orgUnitId}, ${data.name}, ${data.archived ?? false}) RETURNING *`
  return rows[0]!
}

export async function listBoardsForOrgUnits(sql: Sql, orgUnitIds: readonly string[]): Promise<readonly Board[]> {
  if (orgUnitIds.length === 0) return []
  return sql<Board[]>`SELECT * FROM board WHERE org_unit_id IN ${sql(orgUnitIds as string[])} ORDER BY archived, name`
}

export async function getBoard(sql: Sql, id: string): Promise<Board | null> {
  const rows = await sql<Board[]>`SELECT * FROM board WHERE id = ${id}`
  return rows[0] ?? null
}

export async function createStack(
  sql: Sql,
  data: { boardId: string; name: string; order: number },
): Promise<Stack> {
  const rows = await sql<Stack[]>`
    INSERT INTO stack (board_id, name, sort_order) VALUES (${data.boardId}, ${data.name}, ${data.order}) RETURNING *`
  return rows[0]!
}

export async function createCard(
  sql: Sql,
  data: {
    stackId: string
    title: string
    description?: string | null
    assigneeKeycloakId?: string | null
    dueDate?: string | null
    label?: string | null
    order?: number
    protocolActionItemId?: string | null
    createdBy?: string | null
  },
): Promise<Card> {
  const rows = await sql<Card[]>`
    INSERT INTO card (stack_id, title, description, assignee_keycloak_id, due_date, label, sort_order, protocol_action_item_id, created_by)
    VALUES (${data.stackId}, ${data.title}, ${data.description ?? null}, ${data.assigneeKeycloakId ?? null},
            ${data.dueDate ?? null}, ${data.label ?? null}, ${data.order ?? 0}, ${data.protocolActionItemId ?? null}, ${data.createdBy ?? null})
    RETURNING *`
  return rows[0]!
}

export async function moveCard(sql: Sql, id: string, to: { stackId: string; order: number }): Promise<Card | null> {
  const rows = await sql<Card[]>`
    UPDATE card SET stack_id = ${to.stackId}, sort_order = ${to.order} WHERE id = ${id} RETURNING *`
  return rows[0] ?? null
}

export async function updateCard(
  sql: Sql,
  id: string,
  patch: { title?: string; description?: string | null; assigneeKeycloakId?: string | null; dueDate?: string | null; label?: string | null },
): Promise<Card | null> {
  const rows = await sql<Card[]>`
    UPDATE card SET
      title = COALESCE(${patch.title ?? null}, title),
      description = ${patch.description !== undefined ? patch.description : sql`description`},
      assignee_keycloak_id = ${patch.assigneeKeycloakId !== undefined ? patch.assigneeKeycloakId : sql`assignee_keycloak_id`},
      due_date = ${patch.dueDate !== undefined ? patch.dueDate : sql`due_date`},
      label = ${patch.label !== undefined ? patch.label : sql`label`}
    WHERE id = ${id} RETURNING *`
  return rows[0] ?? null
}

export async function deckFor(sql: Sql, boardId: string): Promise<Deck> {
  const board = await getBoard(sql, boardId)
  if (!board) throw new Error('board not found')
  const stacks = await sql<Stack[]>`SELECT * FROM stack WHERE board_id = ${boardId} ORDER BY sort_order`
  const cards = await sql<Card[]>`
    SELECT c.* FROM card c JOIN stack s ON c.stack_id = s.id
    WHERE s.board_id = ${boardId} ORDER BY c.sort_order`
  return { board, stacks, cards }
}

/**
 * Promote a RESOLVED protocol action item into a card in the board's first
 * stack. Idempotent: the partial unique index on protocol_action_item_id guards
 * dups. THROWS 'board has no stacks' when the board is empty.
 */
export async function promoteActionItem(
  sql: Sql,
  boardId: string,
  item: { id: string; text: string; assigneeKeycloakId: string | null; dueDate: string | null },
  createdBy: string,
): Promise<Card> {
  const stacks = await sql<Stack[]>`SELECT * FROM stack WHERE board_id = ${boardId} ORDER BY sort_order LIMIT 1`
  const first = stacks[0]
  if (!first) throw new Error('board has no stacks')
  const rows = await sql<Card[]>`
    INSERT INTO card (stack_id, title, assignee_keycloak_id, due_date, label, protocol_action_item_id, created_by)
    VALUES (${first.id}, ${item.text}, ${item.assigneeKeycloakId}, ${item.dueDate}, 'Sitzung', ${item.id}, ${createdBy})
    ON CONFLICT (protocol_action_item_id) WHERE protocol_action_item_id IS NOT NULL DO UPDATE SET title = EXCLUDED.title
    RETURNING *`
  return rows[0]!
}

/**
 * #384 — the board-owned half of the kernel's /promotable filter. Returns the
 * subset of the given (kernel-supplied) protocol-action-item ids that already
 * have a card in THIS leaf's card table. Same semantics as the kernel's former
 * `NOT EXISTS (SELECT 1 FROM card c WHERE c.protocol_action_item_id = ai.id)`:
 * any card counts, NOT board-scoped (mirrors the global partial unique index on
 * card.protocol_action_item_id). Empty input → [].
 */
export async function listPromotedActionItemIds(sql: Sql, candidateIds: readonly string[]): Promise<readonly string[]> {
  if (candidateIds.length === 0) return []
  const rows = await sql<{ protocol_action_item_id: string }[]>`
    SELECT c.protocol_action_item_id FROM card c
    WHERE c.protocol_action_item_id IN ${sql(candidateIds as string[])}`
  return rows.map((r) => r.protocol_action_item_id)
}
