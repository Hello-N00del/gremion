#!/usr/bin/env tsx
/**
 * services/calendar/scripts/backfill.ts — kernel-PG→leaf-PG data migration
 *
 * The calendar analog of newsletter's backfill.ts (§D.2), adapted for a
 * Postgres→Postgres copy: the source is the KERNEL's own `t_<slug>` database
 * (calendar tables live there today, per gremion-ui/migrations/003_calendar_
 * schema.sql + 008_public_portal.sql's is_public column), NOT SQLite. Source
 * and target may live on the same Postgres server or two reachable servers:
 * the target is addressed by --pg-url and the source by the optional
 * --source-pg-url (which DEFAULTS to --pg-url when omitted), each with its own
 * database name — dbUrlFor() just swaps /dbname. Correctness — id preservation
 * (UUID PKs, no serial sequence to fix), UTC timestamp round-trip, checksum
 * verification — is paramount, mirroring the newsletter cutover's rigor.
 *
 * Usage:
 *   tsx scripts/backfill.ts --tenant <slug> --tenant-id <uuid> \
 *     [--source-pg-url <url>] [--source-db <name>] [--verify-only] \
 *     [--pg-url <url>] [--db-prefix <prefix>]
 *
 * Flags:
 *   --tenant <slug>      REQUIRED. The tenant slug → target DB calendar_<slug>.
 *   --tenant-id <uuid>   REQUIRED (tenant-by-UUID, #173). Catalog id; used to
 *                        key the pool + the tenant_catalog row. Also used to
 *                        derive the DEFAULT source DB name (t_<slug>) when
 *                        --source-db is omitted, UNLESS the slug itself is
 *                        not a valid DB-identifier-safe value — pass
 *                        --source-db explicitly in that case.
 *   --source-pg-url <url> Admin PG URL for the SOURCE (kernel) database.
 *                        Optional — DEFAULTS to --pg-url (source + target on
 *                        the same server); supply it to read the source from a
 *                        DIFFERENT Postgres server than the leaf target.
 *   --source-db <name>   Kernel source DB name (defaults to `t_<tenant>`,
 *                        mirroring gremion-ui's dbNameForSlug()). Tests point
 *                        this at a synthetic throwaway DB.
 *   --verify-only        Skip the copy; only run the verification gate
 *                        against an already-backfilled target (idempotent
 *                        re-verify).
 *   --pg-url <url>       Admin PG URL for the TARGET leaf DB (and the source
 *                        too, unless --source-pg-url overrides it). Defaults
 *                        to $CALENDAR_PG_URL.
 *   --db-prefix <p>      Target DB-name prefix (defaults to "calendar_";
 *                        tests use "calendar_test_").
 *
 * Behaviour (mirrors §D.2):
 *   1. Source read via a plain (non-transactional) postgres-js connection —
 *      READ ONLY at the SQL level: every source statement is a SELECT, the
 *      script never issues a write against the source DB.
 *   2. Copy order (FK-safe): event_types → calendar_events → event_recurrence
 *      / event_committees / committee_calendar_settings / caldav_sync_queue.
 *   3. IDs PRESERVED: every copied table's primary key is a UUID supplied
 *      verbatim from the source row — there is no serial/identity sequence
 *      in the calendar schema to advance (unlike newsletter's BIGINT
 *      identity columns), so straight INSERT with the source id already
 *      guarantees id preservation; no OVERRIDING SYSTEM VALUE / setval is
 *      needed for THIS table set. (Kept as a documented decision, not an
 *      oversight — if a future migration ever adds a serial/identity column
 *      to a backfilled table, this comment is the flag to add the
 *      newsletter-style sequence-fix step here too.)
 *   4. Timestamps: source columns are already TIMESTAMPTZ (an unambiguous
 *      instant) — postgres-js returns them as JS Date objects, which we bind
 *      straight through to the target's TIMESTAMPTZ columns with no string
 *      reformatting. This is why calendar's UTC-safety concern is simpler
 *      than newsletter's SQLite bare-string case; the round-trip is verified
 *      end-to-end in the integration suite regardless.
 *   5. Safety: refuses a NON-EMPTY target unless --verify-only (fail-closed —
 *      no silent merge; backfill has no delta mode). ALSO refuses, before any
 *      copy, when the source and target resolve to the SAME database.
 *   6. Verification gate: per-table row counts equal + md5 checksum compare
 *      (sorted stable columns per table). Prints `BACKFILL OK tenant=<slug>`
 *      on success; ANY mismatch throws (CLI exit 1) naming the first failing
 *      table via BackfillVerifyError.
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

/** Copy order — FK-safe (parents before children). Mirrors 001_init.sql's DDL order. */
const COPY_ORDER = [
  'event_types',
  'calendar_events',
  'event_recurrence',
  'event_committees',
  'committee_calendar_settings',
  'caldav_sync_queue',
] as const

/** All tables whose counts the verify gate compares. */
const ALL_TABLES = COPY_ORDER

/** Column list per table (insert order). Verbatim from 001_init.sql + 002_add_is_public.sql. */
const COLUMNS: Record<string, string[]> = {
  event_types: ['id', 'name', 'color', 'is_system', 'created_at'],
  calendar_events: [
    'id', 'title', 'description', 'location', 'start_at', 'end_at', 'all_day',
    'is_public', 'event_type_id', 'is_multi_committee', 'created_by', 'source',
    'external_id', 'caldav_uid', 'caldav_synced_at', 'created_at', 'updated_at',
  ],
  event_recurrence: ['event_id', 'frequency', 'interval', 'until', 'count', 'byday', 'exceptions'],
  event_committees: ['event_id', 'committee_id'],
  committee_calendar_settings: ['committee_id', 'color', 'updated_at'],
  caldav_sync_queue: ['id', 'event_id', 'caldav_uid', 'operation', 'attempts', 'last_error', 'created_at'],
}

/** Which columns are timestamps (informational — bound straight through as Date, no cast needed). */
const TIMESTAMP_COLUMNS: Record<string, Set<string>> = {
  event_types: new Set(['created_at']),
  calendar_events: new Set(['start_at', 'end_at', 'caldav_synced_at', 'created_at', 'updated_at']),
  event_recurrence: new Set(),
  event_committees: new Set(),
  committee_calendar_settings: new Set(['updated_at']),
  caldav_sync_queue: new Set(['created_at']),
}

/**
 * Checksummed tables: column whose sorted md5 must match across stores.
 * Catches content drift the row-count check alone would miss.
 */
const CHECKSUM_COLUMN: Record<string, string> = {
  event_types: 'name',
  calendar_events: 'title',
  committee_calendar_settings: 'color',
}

// ── public types ──────────────────────────────────────────────────────────────

export interface BackfillOptions {
  tenant: string
  /** Catalog id (tenant-by-UUID, #173). Defaults to the slug ONLY if the
   *  slug itself is a valid UUID; otherwise callers must supply it. */
  tenantId?: string
  /** Kernel source DB name. Defaults to `t_<tenant>` if omitted. */
  sourceDb?: string
  /**
   * Admin PG URL for the SOURCE (kernel) database. Optional — DEFAULTS to
   * `pgUrl` (source and target on the same server). Set it to read the source
   * from a different Postgres server than the leaf target.
   */
  sourcePgUrl?: string
  verifyOnly?: boolean
  pgUrl?: string
  dbPrefix?: string
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
  // empty string. Newline-join.
  const norm = values.map((v) => (v === null ? ' NULL' : v)).sort()
  return createHash('md5').update(norm.join('\n')).digest('hex')
}

/** Read every row from a source table as plain objects (readonly — SELECT only). */
async function readSourceRows(
  sql: Sql,
  table: string,
  columns: string[],
): Promise<Array<Record<string, unknown>>> {
  const colList = columns.map((c) => `"${c}"`).join(', ')
  const orderBy = columns.includes('id') ? 'ORDER BY id' : ''
  return sql.unsafe(`SELECT ${colList} FROM ${table} ${orderBy}`) as unknown as Promise<
    Array<Record<string, unknown>>
  >
}

/** Count rows in a source or target table. */
async function pgTableCount(sql: Sql, table: string): Promise<number> {
  const rows = await sql<{ c: string }[]>`SELECT COUNT(*) AS c FROM ${sql(table)}`
  return Number(rows[0]!.c)
}

/**
 * Is the target empty across ALL tables? (the refuses-non-empty guard).
 *
 * event_types is special-cased: 001_init.sql's migration ALWAYS seeds the 5
 * system event types (idempotent, matched by name+is_system) with FRESH
 * gen_random_uuid() ids on every fresh DB — a brand-new target is therefore
 * never truly empty in that one table. Those migration-seeded system rows
 * are purged in purgeSeededSystemEventTypes() immediately before the copy
 * (so the source's OWN system-type ids — which calendar_events.event_type_id
 * FKs reference — win), so we exclude is_system rows from THIS emptiness
 * check to avoid a false "non-empty" refusal on a freshly-migrated target.
 * Any non-system event_types row, or any row in any other table, still
 * counts as non-empty (a genuine prior backfill / manual write).
 */
async function targetIsEmpty(sql: Sql): Promise<boolean> {
  for (const t of ALL_TABLES) {
    if (t === 'event_types') {
      const rows = await sql<{ c: string }[]>`
        SELECT COUNT(*) AS c FROM event_types WHERE is_system = false
      `
      if (Number(rows[0]!.c) > 0) return false
      continue
    }
    if ((await pgTableCount(sql, t)) > 0) return false
  }
  return true
}

/**
 * Delete the migration-seeded system event_types rows (is_system = true) from
 * the target, immediately before copying event_types from source. This lets
 * the source's own system-type rows (with their ORIGINAL ids, which
 * calendar_events.event_type_id in the copied data references) land intact,
 * rather than co-existing with a duplicate migration-seeded set under
 * different ids. Safe: calendar_events has not been copied yet at this point
 * in COPY_ORDER, so no FK from calendar_events → event_types exists yet to
 * violate.
 */
async function purgeSeededSystemEventTypes(sql: Sql): Promise<void> {
  await sql`DELETE FROM event_types WHERE is_system = true`
}

// NOTE on a real-deployment caveat: 001_init.sql's seed step is idempotent
// PER NAME ("WHERE NOT EXISTS (... name = v.name AND is_system = true)"), so
// if the source's system event_types set does NOT cover all 5 seeded names
// (Treffen/Frist/Wahl/Soziales/Feiertag), any LATER storeFor() call against
// this same target (migrations re-run — always idempotent-safe by design)
// will re-seed the missing names with FRESH ids. In real deployments this is
// a non-issue: the kernel seeds all 5 the same way (003_calendar_schema.sql),
// so every real tenant's source already has full coverage. Operators backfilling
// from an unusual/edited source should verify all 5 system names are present
// before running the live cutover.

// ── copy phase ────────────────────────────────────────────────────────────────

/** Build the positional INSERT for one table. Every PK here is a source-supplied UUID — no identity/serial handling needed. */
function buildInsertSql(table: string): string {
  const cols = COLUMNS[table]!
  const placeholders = cols.map((_c, i) => `$${i + 1}`).join(', ')
  const colList = cols.map((c) => `"${c}"`).join(', ')
  return `INSERT INTO ${table} (${colList}) VALUES (${placeholders})`
}

/** Coerce a source cell to a PG bind value. Timestamps are already Date objects (from a TIMESTAMPTZ source column) — passed straight through, no reformatting. Arrays pass through as-is. */
function bindValue(v: unknown): unknown {
  if (v === undefined) return null
  return v
}

async function copyTable(
  target: Sql,
  source: Sql,
  table: string,
  log: (m: string) => void,
): Promise<number> {
  const cols = COLUMNS[table]!
  const rows = await readSourceRows(source, table, cols)
  if (rows.length === 0) {
    log(`  copy ${table}: 0 rows`)
    return 0
  }
  const insertSql = buildInsertSql(table)
  await target.begin(async (tx) => {
    for (const row of rows) {
      const values = cols.map((c) => bindValue(row[c]))
      await tx.unsafe(insertSql, values as Parameters<typeof tx.unsafe>[1])
    }
  })
  log(`  copy ${table}: ${rows.length} rows`)
  return rows.length
}

// ── verify gate ─────────────────────────────────────────────────────────────

async function pgSortedColumn(sql: Sql, table: string, column: string): Promise<Array<string | null>> {
  const rows = await sql<{ v: string | null }[]>`
    SELECT ${sql(column)} AS v FROM ${sql(table)}
  `
  return rows.map((r) => r.v)
}

/**
 * The verification gate. Throws BackfillVerifyError NAMING the first failing
 * table on any mismatch; returns the assembled counts/checksums on pass.
 */
async function verify(
  target: Sql,
  source: Sql,
  log: (m: string) => void,
): Promise<{
  counts: BackfillResult['counts']
  checksums: BackfillResult['checksums']
}> {
  const counts: BackfillResult['counts'] = {}
  const checksums: BackfillResult['checksums'] = {}

  // 1. Per-table row counts equal.
  for (const t of ALL_TABLES) {
    const s = await pgTableCount(source, t)
    const p = await pgTableCount(target, t)
    counts[t] = { source: s, pg: p }
    log(`  count ${t}: source=${s} pg=${p}`)
    if (s !== p) {
      throw new BackfillVerifyError(t, `row-count mismatch for ${t}: source=${s} pg=${p}`)
    }
  }

  // 2. Checksum compare (sorted column md5) for the checksummed tables.
  for (const [t, col] of Object.entries(CHECKSUM_COLUMN)) {
    const sHash = md5OfSortedColumn(await pgSortedColumn(source, t, col))
    const pHash = md5OfSortedColumn(await pgSortedColumn(target, t, col))
    checksums[t] = { source: sHash, pg: pHash }
    log(`  checksum ${t}.${col}: source=${sHash} pg=${pHash}`)
    if (sHash !== pHash) {
      throw new BackfillVerifyError(t, `checksum mismatch for ${t}.${col}: source=${sHash} pg=${pHash}`)
    }
  }

  return { counts, checksums }
}

// ── orchestration ─────────────────────────────────────────────────────────────

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
 * Run the backfill (or verify-only) for ONE tenant. Returns a BackfillResult
 * on success; throws (BackfillVerifyError, or a plain Error for the
 * non-empty-target guard / missing source) on failure. The CLI maps a throw
 * to exit 1.
 */
export async function runBackfill(opts: BackfillOptions): Promise<BackfillResult> {
  const log = opts.log ?? ((m: string) => console.log(m))
  const tenant = opts.tenant
  const tenantRef: TenantRef = { id: opts.tenantId ?? opts.tenant, slug: opts.tenant }
  const verifyOnly = opts.verifyOnly ?? false
  // Target connection URL — resolved the same way storeFor() will resolve it
  // (require-explicit-env, no localhost:5432 default — #394).
  const targetPgUrl = requireRuntimePgUrl(opts.pgUrl, 'CALENDAR_PG_URL')
  // Source connection URL — an explicit --source-pg-url wins; otherwise default
  // to the same server as the target (backward-compatible single-URL usage).
  const sourcePgUrl = opts.sourcePgUrl ?? targetPgUrl
  const sourceDbName = opts.sourceDb ?? `t_${opts.tenant}`
  const targetDbName = (opts.dbPrefix ?? 'calendar_') + tenant

  // Refuse a source==target misconfiguration BEFORE opening any connection or
  // copying a single row. Backfilling a database into itself is never valid —
  // fail-closed.
  if (resolvedDbId(sourcePgUrl, sourceDbName) === resolvedDbId(targetPgUrl, targetDbName)) {
    throw new Error(
      `[backfill] source and target resolve to the SAME database ` +
        `(${resolvedDbId(sourcePgUrl, sourceDbName)}) — refusing. The source must be the ` +
        `kernel t_<slug> DB, distinct from the leaf target "${targetDbName}".`,
    )
  }

  log(`[backfill] tenant=${tenant} source-db=${sourceDbName} mode=${verifyOnly ? 'verify-only' : 'copy'}`)

  // Source: a plain connection to the kernel's t_<slug> DB — read-only at the
  // SQL level (only SELECT statements are ever issued against it).
  const source = postgres(dbUrlFor(sourcePgUrl, sourceDbName), { max: 4, prepare: false })
  // Target pool (creates the DB + applies leaf migrations on first contact).
  const target = await storeFor(tenantRef, { pgUrl: opts.pgUrl, dbPrefix: opts.dbPrefix })

  try {
    if (!verifyOnly) {
      // Safety: refuse a non-empty target (fail-closed — no silent merge).
      if (!(await targetIsEmpty(target))) {
        throw new Error(
          `[backfill] target for tenant=${tenant} is NON-EMPTY — refusing to backfill ` +
            `(no delta mode). To re-run: drop calendar_<slug> + its catalog row, then re-run. ` +
            `To check what is present without writing, re-run with --verify-only.`,
        )
      }
      // Purge the migration-seeded system event_types rows FIRST so the
      // source's own system-type ids (referenced by calendar_events FKs in
      // the data we are about to copy) land intact instead of co-existing
      // with a duplicate migration-seeded set under different ids.
      await purgeSeededSystemEventTypes(target)
      log(`  purge event_types: removed migration-seeded system rows`)

      // Copy in FK-safe order.
      for (const t of COPY_ORDER) {
        await copyTable(target, source, t, log)
      }
    }

    // Verify gate (always — both after copy AND in verify-only mode).
    const { counts, checksums } = await verify(target, source, log)

    log(`BACKFILL OK tenant=${tenant}`)
    return { ok: true, tenant, counts, checksums }
  } finally {
    await source.end().catch(() => {})
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────

interface ParsedArgs {
  tenant?: string
  tenantId?: string
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
  '[--source-pg-url <url>] [--source-db <name>] [--verify-only] [--pg-url <url>] [--db-prefix <prefix>]'

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

  // The control catalog's tenant_id is a UUID (tenant-by-UUID, #173). If
  // --tenant-id is omitted we fall back to the slug, which is only a valid
  // UUID for already-uuid slugs. Catch the common operator mistake (forgetting
  // --tenant-id) with a clear message instead of a raw PG
  // "invalid input syntax for type uuid".
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

  const sourcePgUrl = args.sourcePgUrl ?? process.env.CALENDAR_TEST_PG_URL ?? process.env.CALENDAR_PG_URL
  const pgUrl = args.pgUrl ?? process.env.CALENDAR_TEST_PG_URL ?? process.env.CALENDAR_PG_URL

  try {
    await runBackfill({
      tenant: args.tenant,
      tenantId: args.tenantId,
      sourcePgUrl,
      sourceDb: args.sourceDb,
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
