#!/usr/bin/env tsx
/**
 * services/board/scripts/backfill.ts — kernel-PG→leaf-PG data migration.
 *
 * Copies the Deck board tables (board → stack → card, FK-safe order) from the
 * KERNEL's per-tenant database (t_<slug>, where 034_deck_board.sql created them)
 * into the board leaf's own database. IDs are preserved verbatim (UUID PKs — no
 * serial/identity sequence to fix). TIMESTAMPTZ columns round-trip as Date
 * objects; DATE (due_date) round-trips as-is.
 *
 * Usage:
 *   tsx scripts/backfill.ts --source-url <url> --target-url <url> [--verify-only]
 *
 * Flags:
 *   --source-url <url>  REQUIRED. Full DSN to the kernel source DB (t_<slug>).
 *   --target-url <url>  Full DSN to the leaf target DB. Defaults to $BOARD_PG_URL.
 *   --verify-only       Skip the copy; only run the verification gate.
 *
 * Behaviour:
 *   1. Ensures the leaf schema exists on the target (runMigrations, idempotent).
 *   2. Refuses when source and target resolve to the SAME database (fail-closed).
 *   3. Refuses a NON-EMPTY target unless --verify-only (no silent merge).
 *   4. Copies board → stack → card in FK-safe order, IDs preserved.
 *   5. Verify gate: per-table row counts equal + a per-table checksum column
 *      (md5 of the sorted column). Prints `BACKFILL OK` on success; ANY mismatch
 *      throws (CLI exit 1) via BackfillVerifyError naming the first failing table.
 */
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import postgres from 'postgres'
import { runMigrations, type Sql } from '../src/store/index.ts'

// ── table catalog ─────────────────────────────────────────────────────────────

/** Copy order — FK-safe (parents before children). */
const COPY_ORDER = ['board', 'stack', 'card'] as const

const COLUMNS: Record<string, string[]> = {
  board: ['id', 'org_unit_id', 'name', 'archived', 'created_at'],
  stack: ['id', 'board_id', 'name', 'sort_order'],
  card: [
    'id', 'stack_id', 'title', 'description', 'assignee_keycloak_id', 'due_date',
    'label', 'sort_order', 'protocol_action_item_id', 'created_by', 'created_at',
  ],
}

/** Checksummed tables: the column whose sorted md5 must match across stores. */
const CHECKSUM_COLUMN: Record<string, string> = {
  board: 'name',
  card: 'title',
}

// ── public types ──────────────────────────────────────────────────────────────

export interface BackfillOptions {
  sourceUrl: string
  targetUrl: string
  verifyOnly?: boolean
  log?: (msg: string) => void
}

export interface BackfillResult {
  ok: boolean
  counts: Record<string, { source: number; target: number }>
  checksums: Record<string, { source: string; target: string }>
}

export class BackfillVerifyError extends Error {
  readonly table: string
  constructor(table: string, message: string) {
    super(message)
    this.name = 'BackfillVerifyError'
    this.table = table
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function md5OfSortedColumn(values: Array<string | null>): string {
  const norm = values.map((v) => (v === null ? ' NULL' : v)).sort()
  return createHash('md5').update(norm.join('\n')).digest('hex')
}

async function readSourceRows(sql: Sql, table: string, columns: string[]): Promise<Array<Record<string, unknown>>> {
  const colList = columns.map((c) => `"${c}"`).join(', ')
  return sql.unsafe(`SELECT ${colList} FROM ${table} ORDER BY id`) as unknown as Promise<
    Array<Record<string, unknown>>
  >
}

async function pgTableCount(sql: Sql, table: string): Promise<number> {
  const rows = await sql<{ c: string }[]>`SELECT COUNT(*) AS c FROM ${sql(table)}`
  return Number(rows[0]!.c)
}

async function targetIsEmpty(sql: Sql): Promise<boolean> {
  for (const t of COPY_ORDER) {
    if ((await pgTableCount(sql, t)) > 0) return false
  }
  return true
}

function buildInsertSql(table: string): string {
  const cols = COLUMNS[table]!
  const placeholders = cols.map((_c, i) => `$${i + 1}`).join(', ')
  const colList = cols.map((c) => `"${c}"`).join(', ')
  return `INSERT INTO ${table} (${colList}) VALUES (${placeholders})`
}

async function copyTable(target: Sql, source: Sql, table: string, log: (m: string) => void): Promise<number> {
  const cols = COLUMNS[table]!
  const rows = await readSourceRows(source, table, cols)
  if (rows.length === 0) {
    log(`  copy ${table}: 0 rows`)
    return 0
  }
  const insertSql = buildInsertSql(table)
  await target.begin(async (tx) => {
    for (const row of rows) {
      const values = cols.map((c) => (row[c] === undefined ? null : row[c]))
      await tx.unsafe(insertSql, values as Parameters<typeof tx.unsafe>[1])
    }
  })
  log(`  copy ${table}: ${rows.length} rows`)
  return rows.length
}

async function pgSortedColumn(sql: Sql, table: string, column: string): Promise<Array<string | null>> {
  const rows = await sql<{ v: string | null }[]>`SELECT ${sql(column)} AS v FROM ${sql(table)}`
  return rows.map((r) => r.v)
}

async function verify(
  target: Sql,
  source: Sql,
  log: (m: string) => void,
): Promise<{ counts: BackfillResult['counts']; checksums: BackfillResult['checksums'] }> {
  const counts: BackfillResult['counts'] = {}
  const checksums: BackfillResult['checksums'] = {}

  for (const t of COPY_ORDER) {
    const s = await pgTableCount(source, t)
    const p = await pgTableCount(target, t)
    counts[t] = { source: s, target: p }
    log(`  count ${t}: source=${s} target=${p}`)
    if (s !== p) throw new BackfillVerifyError(t, `row-count mismatch for ${t}: source=${s} target=${p}`)
  }

  for (const [t, col] of Object.entries(CHECKSUM_COLUMN)) {
    const sHash = md5OfSortedColumn(await pgSortedColumn(source, t, col))
    const pHash = md5OfSortedColumn(await pgSortedColumn(target, t, col))
    checksums[t] = { source: sHash, target: pHash }
    log(`  checksum ${t}.${col}: source=${sHash} target=${pHash}`)
    if (sHash !== pHash) throw new BackfillVerifyError(t, `checksum mismatch for ${t}.${col}`)
  }

  return { counts, checksums }
}

// ── orchestration ─────────────────────────────────────────────────────────────

function resolvedDbId(url: string): string {
  const u = new URL(url)
  const host = (u.hostname || 'localhost').toLowerCase()
  const port = u.port || '5432'
  const db = u.pathname.replace(/^\//, '') || 'postgres'
  return `${host}:${port}/${db}`
}

export async function runBackfill(opts: BackfillOptions): Promise<BackfillResult> {
  const log = opts.log ?? ((m: string) => console.log(m))
  const verifyOnly = opts.verifyOnly ?? false

  if (resolvedDbId(opts.sourceUrl) === resolvedDbId(opts.targetUrl)) {
    throw new Error(
      `[backfill] source and target resolve to the SAME database (${resolvedDbId(opts.sourceUrl)}) — refusing.`,
    )
  }

  log(`[backfill] source=${resolvedDbId(opts.sourceUrl)} target=${resolvedDbId(opts.targetUrl)} mode=${verifyOnly ? 'verify-only' : 'copy'}`)

  // Ensure the leaf schema exists on the target (idempotent, manifest-verified).
  await runMigrations(opts.targetUrl)

  const source = postgres(opts.sourceUrl, { max: 4, prepare: false })
  const target = postgres(opts.targetUrl, { max: 4, prepare: false })

  try {
    if (!verifyOnly) {
      if (!(await targetIsEmpty(target))) {
        throw new Error(
          `[backfill] target is NON-EMPTY — refusing to backfill (no delta mode). ` +
            `Drop + re-migrate the target, or re-run with --verify-only.`,
        )
      }
      for (const t of COPY_ORDER) {
        await copyTable(target, source, t, log)
      }
    }

    const { counts, checksums } = await verify(target, source, log)
    log('BACKFILL OK')
    return { ok: true, counts, checksums }
  } finally {
    await source.end().catch(() => {})
    await target.end().catch(() => {})
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────

interface ParsedArgs {
  sourceUrl?: string
  targetUrl?: string
  verifyOnly: boolean
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { verifyOnly: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    switch (a) {
      case '--source-url':
        out.sourceUrl = argv[++i]
        break
      case '--target-url':
        out.targetUrl = argv[++i]
        break
      case '--verify-only':
        out.verifyOnly = true
        break
      default:
        throw new Error(`[backfill] unknown argument: ${a}`)
    }
  }
  return out
}

const USAGE = 'Usage: tsx scripts/backfill.ts --source-url <url> [--target-url <url>] [--verify-only]'

async function main(): Promise<void> {
  let args: ParsedArgs
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err))
    console.error(USAGE)
    process.exit(1)
  }

  const sourceUrl = args.sourceUrl
  const targetUrl = args.targetUrl ?? process.env.BOARD_PG_URL
  if (!sourceUrl || !targetUrl) {
    console.error('[backfill] --source-url is REQUIRED and --target-url must be given or $BOARD_PG_URL set.')
    console.error(USAGE)
    process.exit(1)
  }

  try {
    await runBackfill({ sourceUrl, targetUrl, verifyOnly: args.verifyOnly, log: (m) => console.log(m) })
    process.exit(0)
  } catch (err) {
    if (err instanceof BackfillVerifyError) {
      console.error(`BACKFILL FAILED table=${err.table}: ${err.message}`)
    } else {
      console.error(`BACKFILL FAILED: ${String(err instanceof Error ? err.message : err)}`)
    }
    process.exit(1)
  }
}

const isMain = (() => {
  try {
    const entry = process.argv[1]
    if (!entry) return false
    return import.meta.url === pathToFileURL(path.resolve(entry)).href
  } catch {
    return false
  }
})()

if (isMain) {
  void main()
}
