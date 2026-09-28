#!/usr/bin/env tsx
/**
 * services/content/scripts/backfill.ts — PG→PG data migration
 *
 * Copies content data from the kernel per-tenant DB (t_<slug> / content.*)
 * into the content leaf DB (content_<slug> / content.*) for one tenant.
 * Correctness is paramount — id preservation, UTC timestamps, checksum
 * verification.
 *
 * Usage:
 *   tsx scripts/backfill.ts \
 *     --tenant <slug> \
 *     --tenant-id <uuid> \
 *     --source-pg-url <url> \
 *     --source-db <dbname> \
 *     [--verify-only] \
 *     [--pg-url <url>] \
 *     [--db-prefix <prefix>]
 *
 * Flags:
 *   --tenant <slug>        REQUIRED. The tenant slug → target DB content_<slug>.
 *   --tenant-id <uuid>     Catalog id (required if slug is not a valid UUID).
 *   --source-pg-url <url>  PG admin URL for the SOURCE database (defaults to
 *                          $CONTENT_TEST_PG_URL or $CONTENT_PG_URL).
 *   --source-db <name>     Source database name (defaults to t_<slug>).
 *   --verify-only          Skip the copy; only run the verification gate against
 *                          an already-backfilled target (idempotent re-verify).
 *   --pg-url <url>         Admin PG URL for the TARGET leaf DB (defaults to
 *                          $CONTENT_PG_URL).
 *   --db-prefix <p>        DB-name prefix for the TARGET (defaults to "content_";
 *                          tests use "content_test_").
 *   --sqlite <path>        (ignored — kept for interface parity with newsletter)
 *
 * Behaviour:
 *   1. Source is read-only (we never modify the source database).
 *   2. Copy order (FK-safe): posts → post_media/post_channels/mailing_lists →
 *      mailing_list_members/post_recipients → unsubscribes/send_tokens/
 *      deliveries/publications/publish_ops.
 *   3. UUIDs PRESERVED via direct INSERT with explicit id values. All content
 *      tables use UUID PKs (gen_random_uuid()); there are no BIGINT GENERATED
 *      ALWAYS AS IDENTITY sequences, so no setval step is needed.
 *   4. Timestamps: source TIMESTAMPTZ values are read back as JS Date objects
 *      by postgres-js and normalized to ISO-Z strings before binding, ensuring
 *      the same instant is stored regardless of session timezone. NULL passes
 *      through.
 *   5. Safety: refuses a NON-EMPTY target unless --verify-only (fail-closed —
 *      no silent merge; backfill has no delta mode). ALSO refuses, before any
 *      copy, when the source and target resolve to the SAME database.
 *   6. Verification gate: per-table row counts equal + md5 checksum compare
 *      (sorted `email` for member/unsubscribe tables; sorted `token` for
 *      send_tokens) + a TARGET-side posts status histogram (informational — the
 *      kernel source has no posts.status column, so every copied post lands at
 *      the leaf DEFAULT status='draft'). Prints `BACKFILL OK tenant=<slug>` on
 *      success; ANY mismatch throws (CLI exit 1).
 */
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import postgres from 'postgres'
import {
  storeFor,
  _resetTenantStoreForTests,
  requireRuntimePgUrl,
  type Sql,
  type TenantRef,
} from '../src/tenant-store.ts'

// ── table catalog ─────────────────────────────────────────────────────────────

/**
 * Copy order — FK-safe (parents before children). §D.2 verbatim adapted for
 * the content schema (all PKs are UUID, no BIGINT identity).
 */
const COPY_ORDER = [
  'posts',
  'post_media',
  'post_channels',
  'mailing_lists',
  'mailing_list_members',
  'post_recipients',
  'unsubscribes',
  'send_tokens',
  'deliveries',
  'publications',
  'publish_ops',
] as const

/** All tables whose counts the verify gate compares. */
const ALL_TABLES = COPY_ORDER

/** Column list per table (insert order). All values from the source DB. */
const COLUMNS: Record<string, string[]> = {
  // KERNEL source shape (gremion-ui/migrations/044_content_schema.sql): exactly 7
  // columns. status/scheduled_at/sent_at/error are LEAF-only (added by
  // services/content/migrations/002_posts_status.sql) — they do NOT exist on the
  // kernel source, so we never read them here; the leaf DEFAULT status='draft'
  // fills status for every copied post.
  posts: [
    'id', 'slug', 'title', 'body_html', 'created_by', 'created_at', 'updated_at',
  ],
  post_media: ['id', 'post_id', 'url', 'role', 'position', 'alt'],
  post_channels: ['post_id', 'channel', 'enabled', 'status', 'scheduled_at', 'overrides'],
  mailing_lists: ['id', 'name', 'created_at'],
  mailing_list_members: ['id', 'mailing_list_id', 'email', 'name', 'source', 'created_at'],
  post_recipients: ['id', 'post_id', 'mailing_list_id', 'keycloak_group_id'],
  unsubscribes: ['email', 'created_at'],
  send_tokens: ['token', 'post_id', 'email', 'expires_at'],
  deliveries: [
    'id', 'post_id', 'email', 'status', 'claimed_at',
    'sent_at', 'failed_at', 'smtp_message_id', 'error_message',
  ],
  publications: ['post_id', 'channel', 'external_ref', 'published_at'],
  publish_ops: [
    'id', 'post_id', 'channel', 'op', 'status', 'attempts',
    'next_attempt_at', 'first_failed_at', 'last_error', 'external_ref',
    'created_at', 'updated_at',
  ],
}

/** Which columns are timestamps (need JS Date → ISO-Z normalization). */
const TIMESTAMP_COLUMNS: Record<string, Set<string>> = {
  posts: new Set(['created_at', 'updated_at']),
  post_media: new Set(),
  post_channels: new Set(['scheduled_at']),
  mailing_lists: new Set(['created_at']),
  mailing_list_members: new Set(['created_at']),
  post_recipients: new Set(),
  unsubscribes: new Set(['created_at']),
  send_tokens: new Set(['expires_at']),
  deliveries: new Set(['claimed_at', 'sent_at', 'failed_at']),
  publications: new Set(['published_at']),
  publish_ops: new Set(['next_attempt_at', 'first_failed_at', 'created_at', 'updated_at']),
}

/**
 * Checksummed tables: column whose sorted md5 must match across stores.
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
  /** Catalog id; defaults to the slug if omitted (must be UUID). */
  tenantId?: string
  /** (kept for interface parity with newsletter backfill — unused for content) */
  sqlitePath?: string
  /**
   * PG admin URL for the SOURCE database (kernel PG).
   * Defaults to $CONTENT_PG_URL.
   */
  sourcePgUrl?: string
  /**
   * Name of the source database (e.g. 't_<slug>' in production or
   * 'content_test_backfill_src' in tests). Defaults to 't_<slug>'.
   */
  sourceDbName?: string
  /** Admin PG URL for the TARGET leaf DB. Defaults to $CONTENT_PG_URL. */
  pgUrl?: string
  /** DB name prefix for the TARGET (default "content_", tests "content_test_"). */
  dbPrefix?: string
  verifyOnly?: boolean
  /** Sink for human-readable progress + the verify-gate lines (defaults to console.log). */
  log?: (msg: string) => void
}

export interface BackfillResult {
  ok: boolean
  tenant: string
  /** Per-table { source, pg } row counts. */
  counts: Record<string, { source: number; pg: number }>
  /** Per-checksummed-table { source, pg } md5 hex. */
  checksums: Record<string, { source: string; pg: string }>
  /**
   * posts status histogram on the TARGET (leaf) side — informational only.
   * The kernel source (044_content_schema.sql) has no posts.status column, so
   * there is no source histogram to compare against; every copied post lands
   * with the leaf DEFAULT status='draft'.
   */
  histogram: { pg: Record<string, number> }
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

// ── helpers ──────────────────────────────────────────────────────────────────

function md5OfSortedColumn(values: Array<string | null>): string {
  const norm = values.map((v) => (v === null ? ' NULL' : v)).sort()
  return createHash('md5').update(norm.join('\n')).digest('hex')
}

/** Build a postgres URL pointing at a specific database on the same server. */
function dbUrlFor(adminUrl: string, dbName: string): string {
  const u = new URL(adminUrl)
  u.pathname = '/' + dbName
  return u.toString()
}

/**
 * Resolve a stable identity string (host:port/dbname) for a PG connection so a
 * source==target misconfiguration is caught regardless of URL spelling. Host is
 * lowercased and the port defaults to 5432 to match libpq's default.
 */
function resolvedDbId(adminUrl: string, dbName: string): string {
  const u = new URL(adminUrl)
  const host = (u.hostname || 'localhost').toLowerCase()
  const port = u.port || '5432'
  return `${host}:${port}/${dbName}`
}

/**
 * Normalize a JS Date (or string) timestamp to an explicit-offset ISO-Z string.
 * postgres-js returns TIMESTAMPTZ columns as JS Date objects; we convert them to
 * ISO-Z strings before binding into the target to ensure unambiguous instant
 * storage regardless of the target session's timezone. NULL → null.
 */
function toUtcIso(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (v instanceof Date) return v.toISOString()
  const s = String(v).trim()
  // Already offset-qualified? (ends with Z, or has a +HH / -HH after the time)
  if (/(?:Z|[+-]\d{2}(?::?\d{2})?)$/.test(s)) return s.replace(' ', 'T')
  // Bare 'YYYY-MM-DD HH:MM:SS[.fff]' (UTC) → append Z.
  return s.replace(' ', 'T') + 'Z'
}

/**
 * Coerce a source PG cell to a bind value for the target. Timestamp columns
 * are normalized to an explicit-UTC ISO string; JSONB comes in as an object
 * and must be re-serialized. Everything else passes through.
 */
function bindValue(v: unknown, isTimestamp: boolean, isJsonb: boolean): unknown {
  if (v === null || v === undefined) return null
  if (isTimestamp) return toUtcIso(v)
  if (isJsonb) return typeof v === 'string' ? v : JSON.stringify(v)
  return v
}

/** Columns in each table that carry JSONB values (need re-serialization). */
const JSONB_COLUMNS: Record<string, Set<string>> = {
  post_channels: new Set(['overrides']),
}

/** Count rows in a PG table. */
async function pgCount(sql: Sql, table: string): Promise<number> {
  const rows = await sql<{ c: string }[]>`SELECT COUNT(*) AS c FROM ${sql('content.' + table)}`
  return Number(rows[0]!.c)
}

/** Count rows in the source table (schema-qualified as content.<table>). */
async function sourceCount(src: Sql, table: string): Promise<number> {
  const rows = await src<{ c: string }[]>`SELECT COUNT(*) AS c FROM ${src('content.' + table)}`
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
 * Build the positional INSERT for one table.
 * All content tables use UUID PKs (gen_random_uuid()), so we never need
 * OVERRIDING SYSTEM VALUE. We just insert with explicit id values directly.
 */
function buildInsertSql(table: string): string {
  const cols = COLUMNS[table]!
  const placeholders = cols.map((_c, i) => `$${i + 1}`).join(', ')
  const colList = cols.map((c) => `"${c}"`).join(', ')
  return `INSERT INTO content.${table} (${colList}) VALUES (${placeholders})`
}

async function copyTable(
  src: Sql,
  tgt: Sql,
  table: string,
  log: (m: string) => void,
): Promise<number> {
  const cols = COLUMNS[table]!
  const colList = cols.map((c) => `"${c}"`).join(', ')
  // Stable order for tables with an id column; others by first column.
  const orderBy = cols.includes('id') ? 'ORDER BY id' : `ORDER BY ${'"' + cols[0]! + '"'}`
  const rows = await src<Record<string, unknown>[]>`
    SELECT ${src.unsafe(colList)} FROM ${src.unsafe('content.' + table)} ${src.unsafe(orderBy)}
  `
  if (rows.length === 0) {
    log(`  copy ${table}: 0 rows`)
    return 0
  }
  const insertSql = buildInsertSql(table)
  const tsCols = TIMESTAMP_COLUMNS[table]!
  const jsonbCols = JSONB_COLUMNS[table] ?? new Set<string>()

  // One transaction per table — atomic per table.
  await tgt.begin(async (tx) => {
    for (const row of rows) {
      const values = cols.map((c) => bindValue(row[c], tsCols.has(c), jsonbCols.has(c)))
      await tx.unsafe(insertSql, values as Parameters<typeof tx.unsafe>[1])
    }
  })
  log(`  copy ${table}: ${rows.length} rows`)
  return rows.length
}

// ── verify gate ───────────────────────────────────────────────────────────────

async function pgSortedColumn(sql: Sql, table: string, column: string): Promise<Array<string | null>> {
  const rows = await sql<{ v: string | null }[]>`
    SELECT ${sql(column)} AS v FROM ${sql('content.' + table)}
  `
  return rows.map((r) => r.v)
}

async function sourceSortedColumn(src: Sql, table: string, column: string): Promise<Array<string | null>> {
  const rows = await src<{ v: string | null }[]>`
    SELECT ${src(column)} AS v FROM ${src('content.' + table)}
  `
  return rows.map((r) => r.v)
}

async function pgStatusHistogram(sql: Sql): Promise<Record<string, number>> {
  const rows = await sql<{ status: string; c: string }[]>`
    SELECT status, COUNT(*) AS c FROM content.posts GROUP BY status
  `
  const h: Record<string, number> = {}
  for (const r of rows) h[r.status] = Number(r.c)
  return h
}

/**
 * The verification gate. Throws BackfillVerifyError NAMING the first failing
 * table on any mismatch; returns the assembled counts/checksums on pass.
 */
async function verify(
  src: Sql,
  tgt: Sql,
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
    const s = await sourceCount(src, t)
    const p = await pgCount(tgt, t)
    counts[t] = { source: s, pg: p }
    log(`  count ${t}: source=${s} pg=${p}`)
    if (s !== p) {
      throw new BackfillVerifyError(
        t,
        `row-count mismatch for ${t}: source=${s} pg=${p}`,
      )
    }
  }

  // 2. Checksum compare (sorted column md5) for the checksummed tables.
  for (const [t, col] of Object.entries(CHECKSUM_COLUMN)) {
    const sHash = md5OfSortedColumn(await sourceSortedColumn(src, t, col))
    const pHash = md5OfSortedColumn(await pgSortedColumn(tgt, t, col))
    checksums[t] = { source: sHash, pg: pHash }
    log(`  checksum ${t}.${col}: source=${sHash} pg=${pHash}`)
    if (sHash !== pHash) {
      throw new BackfillVerifyError(
        t,
        `checksum mismatch for ${t}.${col}: source=${sHash} pg=${pHash}`,
      )
    }
  }

  // 3. posts status histogram — TARGET side only (informational). The kernel
  //    source (044_content_schema.sql) has no posts.status column, so there is
  //    nothing to compare; every copied post lands with the leaf DEFAULT
  //    status='draft'. We still emit the histogram so the operator can eyeball
  //    the target distribution after a cutover.
  const pHist = await pgStatusHistogram(tgt)
  log(`  histogram posts.status (target): pg=${JSON.stringify(pHist)}`)

  return { counts, checksums, histogram: { pg: pHist } }
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

  // Resolve source connection info (require-explicit-env, no localhost:5432
  // default — #394; an explicit --source / CONTENT_TEST_PG_URL still wins).
  const sourcePgUrl = requireRuntimePgUrl(
    opts.sourcePgUrl ?? process.env.CONTENT_TEST_PG_URL,
    'CONTENT_PG_URL',
  )
  const sourceDbName = opts.sourceDbName ?? ('t_' + tenant)
  const sourceUrl = dbUrlFor(sourcePgUrl, sourceDbName)

  // Refuse a source==target misconfiguration BEFORE opening any connection or
  // copying a single row. Resolve the TARGET identity the same way storeFor()
  // will (opts.pgUrl ?? $CONTENT_PG_URL, prefix + slug). Backfilling a database
  // into itself is never valid — fail-closed.
  const targetPgUrl = requireRuntimePgUrl(opts.pgUrl, 'CONTENT_PG_URL')
  const targetDbName = (opts.dbPrefix ?? 'content_') + tenant
  if (resolvedDbId(sourcePgUrl, sourceDbName) === resolvedDbId(targetPgUrl, targetDbName)) {
    throw new Error(
      `[backfill] source and target resolve to the SAME database ` +
        `(${resolvedDbId(sourcePgUrl, sourceDbName)}) — refusing. The source must be the ` +
        `kernel t_<slug> DB, distinct from the leaf target "${targetDbName}".`,
    )
  }

  log(`[backfill] tenant=${tenant} source=${sourceDbName} mode=${verifyOnly ? 'verify-only' : 'copy'}`)

  // Source: read-only PG connection to the kernel tenant DB.
  const src = postgres(sourceUrl, { max: 2, prepare: false, connection: { options: '-c default_transaction_read_only=on' } })
  // Target pool (creates the leaf DB + applies migration 001 on first contact).
  const tgt = await storeFor(tenantRef, { pgUrl: opts.pgUrl, dbPrefix: opts.dbPrefix })

  try {
    if (!verifyOnly) {
      // Safety: refuse a non-empty target (fail-closed — no silent merge).
      if (!(await targetIsEmpty(tgt))) {
        throw new Error(
          `[backfill] target for tenant=${tenant} is NON-EMPTY — refusing to backfill ` +
            `(no delta mode). To re-run: drop content_<slug> + its catalog row, then re-run. ` +
            `To check what is present without writing, re-run with --verify-only.`,
        )
      }
      // Copy in FK-safe order.
      for (const t of COPY_ORDER) {
        await copyTable(src, tgt, t, log)
      }
      // No setval needed — all content tables use UUID PKs (gen_random_uuid()).
    }

    // Verify gate (always — both after copy AND in verify-only mode).
    const { counts, checksums, histogram } = await verify(src, tgt, log)

    log(`BACKFILL OK tenant=${tenant}`)
    return { ok: true, tenant, counts, checksums, histogram }
  } finally {
    await src.end().catch(() => {})
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────

interface ParsedArgs {
  tenant?: string
  tenantId?: string
  sqlite?: string
  sourcePgUrl?: string
  sourceDb?: string
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
        out.sqlite = argv[++i] // ignored — kept for interface parity
        break
      case '--source-pg-url':
        out.sourcePgUrl = argv[++i]
        break
      case '--source-db':
        out.sourceDb = argv[++i]
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
  'Usage: tsx scripts/backfill.ts --tenant <slug> --tenant-id <uuid> ' +
  '[--source-pg-url <url>] [--source-db <name>] [--verify-only] ' +
  '[--pg-url <url>] [--db-prefix <prefix>]'

async function main(): Promise<void> {
  let args: ParsedArgs
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err))
    console.error(USAGE)
    process.exit(1)
  }

  if (!args.tenant) {
    console.error('[backfill] --tenant is REQUIRED.')
    console.error(USAGE)
    process.exit(1)
  }

  // The control catalog's tenant_id is a UUID. If --tenant-id is omitted we fall
  // back to the slug, which is only a valid UUID for already-uuid slugs. Catch
  // the common operator mistake (forgetting --tenant-id) with a clear message.
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

  const sourcePgUrl = args.sourcePgUrl ?? process.env.CONTENT_TEST_PG_URL ?? process.env.CONTENT_PG_URL
  const pgUrl = args.pgUrl ?? process.env.CONTENT_TEST_PG_URL ?? process.env.CONTENT_PG_URL

  try {
    await runBackfill({
      tenant: args.tenant,
      tenantId: args.tenantId,
      sourcePgUrl,
      sourceDbName: args.sourceDb,
      verifyOnly: args.verifyOnly,
      pgUrl,
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
