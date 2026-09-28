#!/usr/bin/env tsx
/**
 * services/newsletter/scripts/backfill.ts — SQLite→PG data migration (§D.2)
 *
 * THE named highest Phase-1 risk: the data migration the live cutover (Task 22)
 * actually runs. Correctness is paramount — id preservation, UTC timestamps,
 * checksum verification.
 *
 * Usage (run under Node 22 — better-sqlite3's readonly reader is N22-only):
 *   tsx scripts/backfill.ts --tenant <slug> --sqlite <path> [--verify-only]
 *
 * Flags:
 *   --tenant <slug>     REQUIRED. The tenant slug → target DB newsletter_<slug>.
 *   --sqlite <path>     REQUIRED. Source SQLite file (the D-NLPATH location).
 *   --verify-only       Skip the copy; only run the verification gate against an
 *                       already-backfilled target (idempotent re-verify).
 *   --tenant-id <uuid>  Catalog id (defaults to the slug; used to key the pool +
 *                       the tenant_catalog row).
 *   --pg-url <url>      Admin PG URL (defaults to $NEWSLETTER_PG_URL).
 *   --db-prefix <p>     DB-name prefix (defaults to "newsletter_"; tests use
 *                       "newsletter_test_").
 *
 * Behaviour (§D.2):
 *   1. Source read with better-sqlite3 in { readonly: true } mode (never writes
 *      the SQLite file — the cutover relies on SQLite being frozen + untouched).
 *   2. Copy order (FK-safe): mailing_lists → mailing_list_members → newsletters
 *      → newsletter_recipients → unsubscribes → send_tokens → newsletter_audit.
 *      `deliveries` is NOT migrated — it is per-send runtime state (the ledger),
 *      reconstructed implicitly from newsletters.status; copying claimed/sent
 *      rows would mask the freshly-extracted service's own idempotency gate.
 *   3. IDs PRESERVED via INSERT … OVERRIDING SYSTEM VALUE on the four identity
 *      tables, then setval(pg_get_serial_sequence(table,'id'), max(id)) so the
 *      next serial does not collide with a backfilled id. send_tokens /
 *      newsletter_recipients reference newsletter ids, and live unsubscribe
 *      tokens are embedded in already-sent mail → identity MUST survive.
 *   4. Timestamps: SQLite datetime('now') strings are UTC but carry NO offset
 *      ('YYYY-MM-DD HH:MM:SS'). We normalize each to an explicit-offset ISO-Z
 *      string IN JS ('YYYY-MM-DDTHH:MM:SSZ') before binding, so timestamptz
 *      parses an unambiguous instant regardless of the pool's session timezone
 *      or the driver's parameter-type inference. (An in-SQL
 *      `::timestamp AT TIME ZONE 'UTC'` cast is NOT used: when postgres-js binds
 *      the param the operand can resolve to timestamptz and the cast then runs
 *      the WRONG direction under a non-UTC session — a silent ±tz-offset
 *      corruption this very task exists to prevent.) NULL passes through.
 *      Property-tested on round-trip in the integration suite.
 *   5. Safety: refuses a NON-EMPTY target unless --verify-only (fail-closed —
 *      no silent merge; backfill has no delta mode).
 *   6. Verification gate: per-table row counts equal + md5 checksum compare
 *      (sorted `email` for member/unsubscribe tables; sorted `token` for
 *      send_tokens) + newsletters status histogram equal. Prints
 *      `BACKFILL OK tenant=<slug>` on success; ANY mismatch throws (CLI exit 1).
 */
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import Database from 'better-sqlite3'
import { storeFor, _resetTenantStoreForTests, type Sql, type TenantRef } from '../src/tenant-store.ts'

// ── table catalog ─────────────────────────────────────────────────────────────

/** Tables that carry a BIGINT GENERATED ALWAYS AS IDENTITY `id` column. */
const IDENTITY_TABLES = [
  'mailing_lists',
  'mailing_list_members',
  'newsletters',
  'newsletter_audit',
] as const

/** Copy order — FK-safe (parents before children). §D.2 verbatim. */
const COPY_ORDER = [
  'mailing_lists',
  'mailing_list_members',
  'newsletters',
  'newsletter_recipients',
  'unsubscribes',
  'send_tokens',
  'newsletter_audit',
] as const

/** All tables whose counts the verify gate compares. */
const ALL_TABLES = COPY_ORDER

/** Column list per table (insert order). */
const COLUMNS: Record<string, string[]> = {
  mailing_lists: ['id', 'name', 'created_at'],
  mailing_list_members: ['id', 'list_id', 'email', 'name', 'source', 'created_at'],
  newsletters: [
    'id', 'title', 'odt_path', 'subject', 'status',
    'scheduled_at', 'sent_at', 'error', 'created_by', 'created_at', 'updated_at',
  ],
  newsletter_recipients: ['newsletter_id', 'mailing_list_id', 'keycloak_group_id'],
  unsubscribes: ['email', 'token', 'unsubscribed_at'],
  send_tokens: ['token', 'newsletter_id', 'email', 'expires_at'],
  newsletter_audit: ['id', 'newsletter_id', 'actor_sub', 'action', 'created_at'],
}

/** Which columns are timestamps (need the UTC-cast). */
const TIMESTAMP_COLUMNS: Record<string, Set<string>> = {
  mailing_lists: new Set(['created_at']),
  mailing_list_members: new Set(['created_at']),
  newsletters: new Set(['scheduled_at', 'sent_at', 'created_at', 'updated_at']),
  newsletter_recipients: new Set(),
  unsubscribes: new Set(['unsubscribed_at']),
  send_tokens: new Set(['expires_at']),
  newsletter_audit: new Set(['created_at']),
}

/**
 * Checksummed tables: column whose sorted md5 must match across stores (§D.2.5).
 * Catches content drift the row-count check alone would miss.
 */
const CHECKSUM_COLUMN: Record<string, string> = {
  mailing_list_members: 'email',
  unsubscribes: 'email',
  send_tokens: 'token',
}

// ── public types ──────────────────────────────────────────────────────────────

export interface BackfillOptions {
  tenant: string
  /** Catalog id; defaults to the slug if omitted. */
  tenantId?: string
  sqlitePath: string
  verifyOnly?: boolean
  pgUrl?: string
  dbPrefix?: string
  /** Sink for human-readable progress + the verify-gate lines (defaults to console.log). */
  log?: (msg: string) => void
}

export interface BackfillResult {
  ok: boolean
  tenant: string
  /** Per-table { sqlite, pg } row counts. */
  counts: Record<string, { sqlite: number; pg: number }>
  /** Per-checksummed-table { sqlite, pg } md5 hex. */
  checksums: Record<string, { sqlite: string; pg: string }>
  /** newsletters status histograms on both sides. */
  histogram: { sqlite: Record<string, number>; pg: Record<string, number> }
}

/** Raised by the verify gate; .table names the first failing table. */
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
  // Sort lexicographically; encode NULL distinctly so a NULL never aliases the
  // empty string. Newline-join (newlines cannot occur in emails/tokens here).
  const norm = values.map((v) => (v === null ? ' NULL' : v)).sort()
  return createHash('md5').update(norm.join('\n')).digest('hex')
}

/** Read every row from a SQLite table as plain objects (readonly reader). */
function readSqliteRows(
  db: Database.Database,
  table: string,
  columns: string[],
): Array<Record<string, unknown>> {
  const colList = columns.map((c) => `"${c}"`).join(', ')
  // Stable order for identity tables (by id); others by their natural columns.
  const orderBy = columns.includes('id') ? 'ORDER BY id' : ''
  return db.prepare(`SELECT ${colList} FROM ${table} ${orderBy}`).all() as Array<
    Record<string, unknown>
  >
}

/** Count rows in a SQLite table. */
function sqliteCount(db: Database.Database, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }
  return Number(row.c)
}

/** Count rows in a PG table. */
async function pgCount(sql: Sql, table: string): Promise<number> {
  const rows = await sql<{ c: string }[]>`SELECT COUNT(*) AS c FROM ${sql(table)}`
  return Number(rows[0]!.c)
}

/** Is the target empty across ALL tables? (the refuses-non-empty guard). */
async function targetIsEmpty(sql: Sql): Promise<boolean> {
  for (const t of ALL_TABLES) {
    if ((await pgCount(sql, t)) > 0) return false
  }
  return true
}

// ── copy phase ────────────────────────────────────────────────────────────────

/**
 * Build the positional INSERT for one table. Identity tables prefix
 * `OVERRIDING SYSTEM VALUE` so the explicit id is honoured against the
 * GENERATED ALWAYS identity. Timestamp columns are normalized in JS to an
 * explicit-offset ISO-Z string before binding (see toUtcIso), so a plain
 * placeholder binds an unambiguous timestamptz instant.
 */
function buildInsertSql(table: string): string {
  const cols = COLUMNS[table]!
  const placeholders = cols.map((_c, i) => `$${i + 1}`).join(', ')
  const overriding = (IDENTITY_TABLES as readonly string[]).includes(table)
    ? 'OVERRIDING SYSTEM VALUE '
    : ''
  const colList = cols.map((c) => `"${c}"`).join(', ')
  return `INSERT INTO ${table} (${colList}) ${overriding}VALUES (${placeholders})`
}

/**
 * Normalize a SQLite UTC datetime string to an explicit-offset ISO-Z string.
 * SQLite's datetime('now') writes 'YYYY-MM-DD HH:MM:SS' (UTC, NO offset). We
 * turn the space into 'T' and append 'Z' so timestamptz parses the SAME instant
 * regardless of the receiving session's timezone. Values that already carry an
 * offset (a trailing Z / +HH / -HH) are passed through untouched. NULL → NULL.
 */
function toUtcIso(v: string | null): string | null {
  if (v === null) return null
  const s = v.trim()
  // Already offset-qualified? (ends with Z, or has a +HH / -HH after the time)
  if (/(?:Z|[+-]\d{2}(?::?\d{2})?)$/.test(s)) return s.replace(' ', 'T')
  // Bare 'YYYY-MM-DD HH:MM:SS[.fff]' (UTC) → append Z.
  return s.replace(' ', 'T') + 'Z'
}

/**
 * Coerce a SQLite cell to a PG bind value. Timestamp columns are normalized to
 * an explicit-UTC ISO string (toUtcIso); everything else passes through, with
 * bigint narrowed to number (ids fit safely in JS number range here).
 */
function bindValue(v: unknown, isTimestamp: boolean): string | number | null {
  if (v === null || v === undefined) return null
  if (isTimestamp) return toUtcIso(String(v))
  if (typeof v === 'bigint') return Number(v)
  return v as string | number
}

async function copyTable(
  sql: Sql,
  sqlite: Database.Database,
  table: string,
  log: (m: string) => void,
): Promise<number> {
  const cols = COLUMNS[table]!
  const rows = readSqliteRows(sqlite, table, cols)
  if (rows.length === 0) {
    log(`  copy ${table}: 0 rows`)
    return 0
  }
  const insertSql = buildInsertSql(table)
  const tsCols = TIMESTAMP_COLUMNS[table]!
  // One transaction per table — atomic per table; the per-table verify gate
  // (after all copies) is the cross-table consistency check.
  await sql.begin(async (tx) => {
    for (const row of rows) {
      const values = cols.map((c) => bindValue(row[c], tsCols.has(c)))
      await tx.unsafe(insertSql, values as Parameters<typeof tx.unsafe>[1])
    }
  })
  log(`  copy ${table}: ${rows.length} rows`)
  return rows.length
}

/**
 * After copying an identity table, advance its sequence so the next serial is
 * max(id)+1 — no collision with a backfilled id. setval(seq, max) leaves the
 * sequence "already used up to max", so nextval returns max+1. If the table is
 * empty we leave the sequence untouched (it starts at 1).
 */
async function fixSequence(sql: Sql, table: string, log: (m: string) => void): Promise<void> {
  const rows = await sql<{ maxid: string | null }[]>`
    SELECT MAX(id)::text AS maxid FROM ${sql(table)}
  `
  const maxId = rows[0]!.maxid
  if (maxId === null) {
    log(`  setval ${table}: (empty — sequence left at start)`)
    return
  }
  // pg_get_serial_sequence resolves the identity sequence for the id column.
  await sql`
    SELECT setval(pg_get_serial_sequence(${table}, 'id'), ${Number(maxId)})
  `
  log(`  setval ${table}: id sequence advanced to ${maxId}`)
}

// ── verify gate ─────────────────────────────────────────────────────────────

async function pgSortedColumn(sql: Sql, table: string, column: string): Promise<Array<string | null>> {
  const rows = await sql<{ v: string | null }[]>`
    SELECT ${sql(column)} AS v FROM ${sql(table)}
  `
  return rows.map((r) => r.v)
}

function sqliteSortedColumn(
  db: Database.Database,
  table: string,
  column: string,
): Array<string | null> {
  const rows = db.prepare(`SELECT "${column}" AS v FROM ${table}`).all() as Array<{ v: string | null }>
  return rows.map((r) => r.v)
}

async function pgStatusHistogram(sql: Sql): Promise<Record<string, number>> {
  const rows = await sql<{ status: string; c: string }[]>`
    SELECT status, COUNT(*) AS c FROM newsletters GROUP BY status
  `
  const h: Record<string, number> = {}
  for (const r of rows) h[r.status] = Number(r.c)
  return h
}

function sqliteStatusHistogram(db: Database.Database): Record<string, number> {
  const rows = db
    .prepare(`SELECT status, COUNT(*) AS c FROM newsletters GROUP BY status`)
    .all() as Array<{ status: string; c: number }>
  const h: Record<string, number> = {}
  for (const r of rows) h[r.status] = Number(r.c)
  return h
}

/**
 * The verification gate (§D.2.5). Throws BackfillVerifyError NAMING the first
 * failing table on any mismatch; returns the assembled counts/checksums on pass.
 */
async function verify(
  sql: Sql,
  sqlite: Database.Database,
  log: (m: string) => void,
): Promise<{
  counts: BackfillResult['counts']
  checksums: BackfillResult['checksums']
  histogram: BackfillResult['histogram']
}> {
  const counts: BackfillResult['counts'] = {}
  const checksums: BackfillResult['checksums'] = {}

  // 1. Per-table row counts equal.
  for (const t of ALL_TABLES) {
    const s = sqliteCount(sqlite, t)
    const p = await pgCount(sql, t)
    counts[t] = { sqlite: s, pg: p }
    log(`  count ${t}: sqlite=${s} pg=${p}`)
    if (s !== p) {
      throw new BackfillVerifyError(
        t,
        `row-count mismatch for ${t}: sqlite=${s} pg=${p}`,
      )
    }
  }

  // 2. Checksum compare (sorted column md5) for the checksummed tables.
  for (const [t, col] of Object.entries(CHECKSUM_COLUMN)) {
    const sHash = md5OfSortedColumn(sqliteSortedColumn(sqlite, t, col))
    const pHash = md5OfSortedColumn(await pgSortedColumn(sql, t, col))
    checksums[t] = { sqlite: sHash, pg: pHash }
    log(`  checksum ${t}.${col}: sqlite=${sHash} pg=${pHash}`)
    if (sHash !== pHash) {
      throw new BackfillVerifyError(
        t,
        `checksum mismatch for ${t}.${col}: sqlite=${sHash} pg=${pHash}`,
      )
    }
  }

  // 3. newsletters status histogram equal.
  const sHist = sqliteStatusHistogram(sqlite)
  const pHist = await pgStatusHistogram(sql)
  log(`  histogram newsletters.status: sqlite=${JSON.stringify(sHist)} pg=${JSON.stringify(pHist)}`)
  const allStatuses = new Set([...Object.keys(sHist), ...Object.keys(pHist)])
  for (const st of allStatuses) {
    if ((sHist[st] ?? 0) !== (pHist[st] ?? 0)) {
      throw new BackfillVerifyError(
        'newsletters',
        `status histogram mismatch for newsletters: status='${st}' sqlite=${sHist[st] ?? 0} pg=${pHist[st] ?? 0}`,
      )
    }
  }

  return { counts, checksums, histogram: { sqlite: sHist, pg: pHist } }
}

// ── orchestration ─────────────────────────────────────────────────────────────

/**
 * Run the backfill (or verify-only) for ONE tenant. Returns a BackfillResult on
 * success; throws (BackfillVerifyError, or a plain Error for the non-empty-target
 * guard / missing source) on failure. The CLI maps a throw to exit 1.
 */
export async function runBackfill(opts: BackfillOptions): Promise<BackfillResult> {
  const log = opts.log ?? ((m: string) => console.log(m))
  const tenant = opts.tenant
  const tenantRef: TenantRef = { id: opts.tenantId ?? opts.tenant, slug: opts.tenant }
  const verifyOnly = opts.verifyOnly ?? false

  log(`[backfill] tenant=${tenant} sqlite=${opts.sqlitePath} mode=${verifyOnly ? 'verify-only' : 'copy'}`)

  // Source: readonly reader — NEVER writes the SQLite file (cutover freezes it).
  const sqlite = new Database(opts.sqlitePath, { readonly: true, fileMustExist: true })
  // Target pool (creates the DB + applies migration 001 on first contact).
  const sql = await storeFor(tenantRef, { pgUrl: opts.pgUrl, dbPrefix: opts.dbPrefix })

  try {
    if (!verifyOnly) {
      // Safety: refuse a non-empty target (fail-closed — no silent merge).
      if (!(await targetIsEmpty(sql))) {
        throw new Error(
          `[backfill] target for tenant=${tenant} is NON-EMPTY — refusing to backfill ` +
            `(no delta mode). To re-run: drop newsletter_<slug> + its catalog row, then re-run. ` +
            `To check what is present without writing, re-run with --verify-only.`,
        )
      }
      // Copy in FK-safe order.
      for (const t of COPY_ORDER) {
        await copyTable(sql, sqlite, t, log)
      }
      // Advance identity sequences past the max copied id (no collision).
      for (const t of IDENTITY_TABLES) {
        await fixSequence(sql, t, log)
      }
    }

    // Verify gate (always — both after copy AND in verify-only mode).
    const { counts, checksums, histogram } = await verify(sql, sqlite, log)

    log(`BACKFILL OK tenant=${tenant}`)
    return { ok: true, tenant, counts, checksums, histogram }
  } finally {
    sqlite.close()
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────

interface ParsedArgs {
  tenant?: string
  tenantId?: string
  sqlite?: string
  verifyOnly: boolean
  pgUrl?: string
  dbPrefix?: string
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { verifyOnly: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    switch (a) {
      case '--tenant':
        out.tenant = argv[++i]
        break
      case '--tenant-id':
        out.tenantId = argv[++i]
        break
      case '--sqlite':
        out.sqlite = argv[++i]
        break
      case '--verify-only':
        out.verifyOnly = true
        break
      case '--pg-url':
        out.pgUrl = argv[++i]
        break
      case '--db-prefix':
        out.dbPrefix = argv[++i]
        break
      default:
        throw new Error(`[backfill] unknown argument: ${a}`)
    }
  }
  return out
}

const USAGE =
  'Usage: tsx scripts/backfill.ts --tenant <slug> --sqlite <path> [--verify-only] ' +
  '[--tenant-id <uuid>] [--pg-url <url>] [--db-prefix <prefix>]'

async function main(): Promise<void> {
  let args: ParsedArgs
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err))
    console.error(USAGE)
    process.exit(1)
  }

  if (!args.tenant || !args.sqlite) {
    console.error('[backfill] --tenant and --sqlite are REQUIRED.')
    console.error(USAGE)
    process.exit(1)
  }

  // The control catalog's tenant_id is a UUID. If --tenant-id is omitted we fall
  // back to the slug, which is only a valid UUID for already-uuid slugs. Catch
  // the common operator mistake (forgetting --tenant-id) with a clear message
  // instead of a raw PG "invalid input syntax for type uuid".
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const effectiveTenantId = args.tenantId ?? args.tenant
  if (!UUID_RE.test(effectiveTenantId)) {
    console.error(
      `[backfill] --tenant-id must be the tenant's catalog UUID (got "${effectiveTenantId}"). ` +
        `Pass it explicitly: --tenant-id <uuid> (from the kernel tenant registry).`,
    )
    console.error(USAGE)
    process.exit(1)
  }

  // Honour an explicit --pg-url, else the test env, else the prod env, else the
  // tenant-store default. (--db-prefix lets tests stay in the newsletter_test_ ns.)
  try {
    await runBackfill({
      tenant: args.tenant,
      tenantId: args.tenantId,
      sqlitePath: args.sqlite,
      verifyOnly: args.verifyOnly,
      pgUrl: args.pgUrl ?? process.env.NEWSLETTER_TEST_PG_URL ?? process.env.NEWSLETTER_PG_URL,
      dbPrefix: args.dbPrefix,
      log: (m) => console.log(m),
    })
    await _resetTenantStoreForTests()
    process.exit(0)
  } catch (err) {
    if (err instanceof BackfillVerifyError) {
      console.error(`BACKFILL FAILED tenant=${args.tenant} table=${err.table}: ${err.message}`)
    } else {
      console.error(`BACKFILL FAILED tenant=${args.tenant}: ${String(err instanceof Error ? err.message : err)}`)
    }
    await _resetTenantStoreForTests().catch(() => {})
    process.exit(1)
  }
}

// Run main() only when invoked directly as a script (not when imported by tests).
// Compare this module's URL to the URL of the process entry point: equal ⇒ this
// file was executed directly (tsx scripts/backfill.ts); differ ⇒ imported.
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
