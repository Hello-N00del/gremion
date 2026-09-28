#!/usr/bin/env tsx
/**
 * services/finance/scripts/backfill.ts — PG→PG data migration (#369 slice 2)
 *
 * Copies finance data from the kernel per-tenant DB (t_<slug> / finance.*) into
 * the finance leaf DB (finance_<slug> / finance.*) for one tenant. Correctness is
 * paramount — id preservation (BIGINT IDENTITY via OVERRIDING SYSTEM VALUE +
 * setval), UTC timestamps, DATE (no tz shift), JSONB / TEXT[] fidelity, and a
 * checksum verify gate. The table catalog is the single source of truth in
 * src/store/index.ts.
 *
 * Usage:
 *   tsx scripts/backfill.ts \
 *     --tenant <slug> --tenant-id <uuid> \
 *     --source-pg-url <url> --source-db <dbname> \
 *     [--verify-only] [--pg-url <url>] [--db-prefix <prefix>]
 *
 * Behaviour:
 *   1. Source is read-only (never modified).
 *   2. Copy order is FK-safe (src/store/index.ts COPY_ORDER); self-referencing
 *      tables (budget_plan.parent_plan_id, booking.supersedes) copy ORDER BY id.
 *   3. IDs PRESERVED: identity tables INSERT ... OVERRIDING SYSTEM VALUE, then
 *      setval(pg_get_serial_sequence(table,'id'), max(id)). booking_running_no_head
 *      has a composite PK (no id) — plain INSERT, no setval.
 *   4. Refuses a NON-EMPTY target unless --verify-only, and refuses (before any
 *      copy) when source and target resolve to the SAME database.
 *   5. Verify gate: per-table row counts equal + a sorted-column md5 checksum for
 *      the representative CHECKSUM_COLUMN tables. Prints `BACKFILL OK tenant=<slug>`;
 *      ANY mismatch throws (CLI exit 1) NAMING the failing table.
 */
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import postgres from 'postgres'
import {
  storeFor,
  requireRuntimePgUrl,
  _resetTenantStoreForTests,
  type Sql,
  type TenantRef,
} from '../src/tenant-store.ts'
import {
  FINANCE_SCHEMA,
  COPY_ORDER,
  ALL_TABLES,
  IDENTITY_TABLES,
  COLUMNS,
  TIMESTAMP_COLUMNS,
  DATE_COLUMNS,
  JSONB_COLUMNS,
  ARRAY_COLUMNS,
  CHECKSUM_COLUMN,
  type FinanceTable,
} from '../src/store/index.ts'

// ── public types ──────────────────────────────────────────────────────────────

export interface BackfillOptions {
  tenant: string
  tenantId?: string
  sourcePgUrl?: string
  sourceDbName?: string
  pgUrl?: string
  dbPrefix?: string
  verifyOnly?: boolean
  log?: (msg: string) => void
}

export interface BackfillResult {
  ok: boolean
  tenant: string
  counts: Record<string, { source: number; pg: number }>
  checksums: Record<string, { source: string; pg: string }>
}

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

function dbUrlFor(adminUrl: string, dbName: string): string {
  const u = new URL(adminUrl)
  u.pathname = '/' + dbName
  return u.toString()
}

/** Stable identity string (host:port/dbname) so source==target is caught
 *  regardless of URL spelling. */
function resolvedDbId(adminUrl: string, dbName: string): string {
  const u = new URL(adminUrl)
  const host = (u.hostname || 'localhost').toLowerCase()
  const port = u.port || '5432'
  return `${host}:${port}/${dbName}`
}

/** timestamptz → explicit-offset ISO-Z string (unambiguous instant). NULL → null. */
function toUtcIso(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (v instanceof Date) return v.toISOString()
  const s = String(v).trim()
  if (/(?:Z|[+-]\d{2}(?::?\d{2})?)$/.test(s)) return s.replace(' ', 'T')
  return s.replace(' ', 'T') + 'Z'
}

/** DATE → bare YYYY-MM-DD (no tz shift). NULL → null. */
function toDateOnly(v: unknown): string | null {
  if (v === null || v === undefined) return null
  const s = v instanceof Date ? v.toISOString() : String(v).trim()
  return s.slice(0, 10)
}

interface ColKind {
  isTimestamp: boolean
  isDate: boolean
  isJsonb: boolean
  isArray: boolean
}

function bindValue(v: unknown, kind: ColKind): unknown {
  if (v === null || v === undefined) return null
  if (kind.isTimestamp) return toUtcIso(v)
  if (kind.isDate) return toDateOnly(v)
  // TASK-009 fix round 5: ALWAYS JSON.stringify the value postgres-js parsed from
  // the source jsonb, and bind it as TEXT (buildInsertSql casts `$n::text::jsonb`).
  // The old code bound a JSON *string* straight into a jsonb parameter; postgres-js
  // serialises a jsonb parameter with JSON.stringify, so the value was encoded
  // TWICE and landed as a jsonb STRING scalar ('"[{...}]"'). The live leaf then
  // served signerStages as a string and /finance/finanzordnung 500'd. A source
  // value that genuinely IS a jsonb string scalar is preserved as one.
  if (kind.isJsonb) return JSON.stringify(v)
  if (kind.isArray) return v // postgres-js binds a JS array to text[]
  if (typeof v === 'bigint') return Number(v)
  return v
}

function colKind(table: FinanceTable, col: string): ColKind {
  return {
    isTimestamp: TIMESTAMP_COLUMNS[table]!.has(col),
    isDate: DATE_COLUMNS[table]!.has(col),
    isJsonb: JSONB_COLUMNS[table]?.has(col) ?? false,
    isArray: ARRAY_COLUMNS[table]?.has(col) ?? false,
  }
}

const qualified = (table: string): string => `${FINANCE_SCHEMA}.${table}`

async function pgCount(sql: Sql, table: string): Promise<number> {
  const rows = await sql<{ c: string }[]>`SELECT COUNT(*) AS c FROM ${sql(qualified(table))}`
  return Number(rows[0]!.c)
}

/** COUNT(*) of an ARBITRARY (already schema-qualified) table — for the aux
 *  cross-schema copies whose source (public.org_units) and target
 *  (finance.org_unit_mirror) differ in schema AND name. `filter` (a static,
 *  caller-controlled SQL fragment — never user input) lets the org_unit_mirror
 *  aux check exclude consumer tombstones (fix round 1, see `verify` below). */
async function pgCountOf(sql: Sql, fullTable: string, filter?: string): Promise<number> {
  const rows = filter
    ? await sql<{ c: string }[]>`SELECT COUNT(*) AS c FROM ${sql(fullTable)} WHERE ${sql.unsafe(filter)}`
    : await sql<{ c: string }[]>`SELECT COUNT(*) AS c FROM ${sql(fullTable)}`
  return Number(rows[0]!.c)
}

/** Sorted `column::text` of an arbitrary table (for the aux checksum gate).
 *  `filter` — see pgCountOf. */
async function sortedColumnOf(
  sql: Sql,
  fullTable: string,
  column: string,
  filter?: string,
): Promise<Array<string | null>> {
  const rows = filter
    ? await sql<{ v: string | null }[]>`SELECT ${sql(column)}::text AS v FROM ${sql(fullTable)} WHERE ${sql.unsafe(filter)}`
    : await sql<{ v: string | null }[]>`SELECT ${sql(column)}::text AS v FROM ${sql(fullTable)}`
  return rows.map((r) => r.v)
}

/** True iff a relation (schema-qualified) exists in the source. Lets a non-kernel
 *  source (a finance-only DB with no governance tables) skip the aux copies. */
async function sourceHasTable(sql: Sql, fullTable: string): Promise<boolean> {
  const rows = await sql<{ reg: string | null }[]>`SELECT to_regclass(${fullTable})::text AS reg`
  return rows[0]?.reg != null
}

async function targetIsEmpty(sql: Sql): Promise<boolean> {
  for (const t of ALL_TABLES) {
    if ((await pgCount(sql, t)) > 0) return false
  }
  return true
}

// ── copy phase ────────────────────────────────────────────────────────────────

function buildInsertSql(table: FinanceTable): string {
  const cols = COLUMNS[table]
  // JSONB columns: bind the (already JSON.stringify'd, see bindValue) value as
  // text and let Postgres parse it — never let the driver re-encode it.
  const jsonb = JSONB_COLUMNS[table]
  const placeholders = cols
    .map((c, i) => (jsonb?.has(c) ? `$${i + 1}::text::jsonb` : `$${i + 1}`))
    .join(', ')
  const overriding = (IDENTITY_TABLES as readonly string[]).includes(table)
    ? 'OVERRIDING SYSTEM VALUE '
    : ''
  const colList = cols.map((c) => `"${c}"`).join(', ')
  return `INSERT INTO ${qualified(table)} (${colList}) ${overriding}VALUES (${placeholders})`
}

async function copyTable(src: Sql, tgt: Sql, table: FinanceTable, log: (m: string) => void): Promise<number> {
  const cols = COLUMNS[table]
  const colList = cols.map((c) => `"${c}"`).join(', ')
  const orderBy = cols.includes('id') ? 'ORDER BY id' : `ORDER BY "${cols[0]!}"`
  const rows = await src<Record<string, unknown>[]>`
    SELECT ${src.unsafe(colList)} FROM ${src.unsafe(qualified(table))} ${src.unsafe(orderBy)}
  `
  if (rows.length === 0) {
    log(`  copy ${table}: 0 rows`)
    return 0
  }
  const insertSql = buildInsertSql(table)
  await tgt.begin(async (tx) => {
    for (const row of rows) {
      const values = cols.map((c) => bindValue(row[c], colKind(table, c)))
      await tx.unsafe(insertSql, values as Parameters<typeof tx.unsafe>[1])
    }
  })
  log(`  copy ${table}: ${rows.length} rows`)
  return rows.length
}

/** Advance an identity table's id sequence past the max copied id (no collision). */
async function fixSequence(sql: Sql, table: FinanceTable, log: (m: string) => void): Promise<void> {
  const rows = await sql<{ maxid: string | null }[]>`
    SELECT MAX(id)::text AS maxid FROM ${sql(qualified(table))}
  `
  const maxId = rows[0]!.maxid
  if (maxId === null) {
    log(`  setval ${table}: (empty — sequence left at start)`)
    return
  }
  await sql`SELECT setval(pg_get_serial_sequence(${qualified(table)}, 'id'), ${Number(maxId)})`
  log(`  setval ${table}: id sequence advanced to ${maxId}`)
}

// ── aux cross-schema copies (#383 Lane E1) ──────────────────────────────────────
// The kernel governance tables the finance leaf now MIRRORS: public.org_units →
// finance.org_unit_mirror (project + sub-org reads) and public.sub_org_type →
// finance.sub_org_type (the sub-org-type catalog the leaf owns post-cutover). Both
// are cross-schema/cross-name copies, so they are NOT part of the same-name COPY_ORDER.
// A source without these governance tables (a finance-only DB) skips them (→ null).

/** Copy public.org_units → finance.org_unit_mirror (id/name/kind/parent_id). The
 *  mirror's source_occurred_at is stamped with ONE snapshot instant, captured
 *  BEFORE the source read (not the column default's own now() per row), so an
 *  in-flight event that PRE-dates the snapshot is dropped by the consumer, not replayed.
 *  Returns the row count, or null when the source has no org_units. */
async function copyOrgUnitMirror(src: Sql, tgt: Sql, log: (m: string) => void): Promise<number | null> {
  if (!(await sourceHasTable(src, 'public.org_units'))) {
    log('  copy org_unit_mirror: (source has no public.org_units — skipped)')
    return null
  }
  // Fix round 1 (review r1-finance-C1C2, LOW/lang:sql): one snapshot instant
  // for the WHOLE read, not a fresh now() per row (the column default). Used
  // below in the ordering guard so a live consumer event applied concurrently
  // with this backfill is never clobbered by older snapshot data.
  const snapshotAt = new Date()
  const rows = await src<Array<{ id: string; name: string; kind: string; parent_id: string | null }>>`
    SELECT id, name, kind, parent_id FROM org_units ORDER BY id`
  if (rows.length === 0) {
    log('  copy org_unit_mirror: 0 rows')
    return 0
  }
  // TASK-009 lane C: an operator running this AFTER the leaf's org-unit
  // consumer has already synced some org units (the ordinary state once
  // FINANCE_BACKEND=service is live and events are flowing, even though the
  // runbook says backfill should run FIRST) would hit the mirror's `id`
  // PRIMARY KEY on a plain INSERT and abort mid-backfill, half-populated,
  // never reaching the verify gate. UPSERT instead: the source (the
  // id-preserving migration's single source of truth) wins on conflict —
  // but ONLY when this backfill's snapshot is not older than what the
  // consumer already applied (fix round 1: the WHERE guard below mirrors
  // org-unit-consumer.ts's own per-aggregate ordering guard EXACTLY —
  // `WHERE EXCLUDED.source_occurred_at > finance.org_unit_mirror.source_occurred_at`
  // — so the row keeps whichever write has the LATER source_occurred_at,
  // consumer or backfill, instead of the backfill silently overwriting a
  // newer consumer-applied event with older snapshot data). `deleted` is
  // left untouched on conflict — the backfill's source query never includes
  // a hard-deleted org unit, so it has nothing useful to say about tombstone
  // state, which stays the consumer's own.
  await tgt.begin(async (tx) => {
    for (const r of rows) {
      await tx`
        INSERT INTO finance.org_unit_mirror (id, name, kind, parent_id, source_occurred_at)
        VALUES (${r.id}, ${r.name}, ${r.kind}, ${r.parent_id}, ${snapshotAt})
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          kind = EXCLUDED.kind,
          parent_id = EXCLUDED.parent_id,
          source_occurred_at = EXCLUDED.source_occurred_at
        WHERE EXCLUDED.source_occurred_at > finance.org_unit_mirror.source_occurred_at`
    }
  })
  log(`  copy org_unit_mirror: ${rows.length} rows`)
  return rows.length
}

/** Copy public.sub_org_type → finance.sub_org_type, id-preserving (OVERRIDING SYSTEM
 *  VALUE + setval, like the finance.* identity tables). Returns the row count, or null
 *  when the source has no sub_org_type. */
async function copySubOrgType(src: Sql, tgt: Sql, log: (m: string) => void): Promise<number | null> {
  if (!(await sourceHasTable(src, 'public.sub_org_type'))) {
    log('  copy sub_org_type: (source has no public.sub_org_type — skipped)')
    return null
  }
  const rows = await src<Array<{ id: string; name: string; description: string | null; created_at: unknown }>>`
    SELECT id, name, description, created_at FROM sub_org_type ORDER BY id`
  if (rows.length === 0) {
    log('  copy sub_org_type: 0 rows')
    return 0
  }
  await tgt.begin(async (tx) => {
    for (const r of rows) {
      await tx`
        INSERT INTO finance.sub_org_type (id, name, description, created_at) OVERRIDING SYSTEM VALUE
        VALUES (${Number(r.id)}, ${r.name}, ${r.description}, ${toUtcIso(r.created_at)})`
    }
  })
  const maxRow = await tgt<{ maxid: string | null }[]>`SELECT MAX(id)::text AS maxid FROM finance.sub_org_type`
  if (maxRow[0]!.maxid !== null) {
    await tgt`SELECT setval(pg_get_serial_sequence('finance.sub_org_type', 'id'), ${Number(maxRow[0]!.maxid)})`
  }
  log(`  copy sub_org_type: ${rows.length} rows`)
  return rows.length
}

// ── verify gate ───────────────────────────────────────────────────────────────

async function sortedColumn(sql: Sql, table: string, column: string): Promise<Array<string | null>> {
  const rows = await sql<{ v: string | null }[]>`
    SELECT ${sql(column)}::text AS v FROM ${sql(qualified(table))}
  `
  return rows.map((r) => r.v)
}

async function verify(
  src: Sql,
  tgt: Sql,
  log: (m: string) => void,
): Promise<{ counts: BackfillResult['counts']; checksums: BackfillResult['checksums'] }> {
  const counts: BackfillResult['counts'] = {}
  const checksums: BackfillResult['checksums'] = {}

  for (const t of ALL_TABLES) {
    const s = await pgCount(src, t)
    const p = await pgCount(tgt, t)
    counts[t] = { source: s, pg: p }
    log(`  count ${t}: source=${s} pg=${p}`)
    if (s !== p) {
      throw new BackfillVerifyError(t, `row-count mismatch for ${t}: source=${s} pg=${p}`)
    }
  }

  for (const [t, col] of Object.entries(CHECKSUM_COLUMN)) {
    const sHash = md5OfSortedColumn(await sortedColumn(src, t, col))
    const pHash = md5OfSortedColumn(await sortedColumn(tgt, t, col))
    checksums[t] = { source: sHash, pg: pHash }
    log(`  checksum ${t}.${col}: source=${sHash} pg=${pHash}`)
    if (sHash !== pHash) {
      throw new BackfillVerifyError(t, `checksum mismatch for ${t}.${col}: source=${sHash} pg=${pHash}`)
    }
  }

  // Aux cross-schema mirrors (#383 Lane E1): public.org_units → finance.org_unit_mirror,
  // public.sub_org_type → finance.sub_org_type. Row-count + name checksum, when present.
  // Fix round 1 (review r1-finance-C1C2, MEDIUM/lang:sql): org_unit_mirror's `tgtFilter`
  // excludes consumer-written TOMBSTONE rows (`deleted = true`) from both the count and
  // the checksum. Without it, a consumer that had already deleted an org unit before this
  // backfill ran left a mirror row the source (public.org_units, hard-deletes) no longer
  // has — the aux count then NEVER matched and BackfillVerifyError aborted AFTER every
  // other table had already copied successfully, even though the copy itself was correct.
  const aux: Array<{ key: string; srcTable: string; tgtTable: string; col: string; tgtFilter?: string }> = [
    {
      key: 'org_unit_mirror',
      srcTable: 'public.org_units',
      tgtTable: 'finance.org_unit_mirror',
      col: 'name',
      tgtFilter: 'NOT deleted',
    },
    { key: 'sub_org_type', srcTable: 'public.sub_org_type', tgtTable: 'finance.sub_org_type', col: 'name' },
  ]
  for (const a of aux) {
    if (!(await sourceHasTable(src, a.srcTable))) continue
    const s = await pgCountOf(src, a.srcTable)
    const p = await pgCountOf(tgt, a.tgtTable, a.tgtFilter)
    counts[a.key] = { source: s, pg: p }
    log(`  count ${a.key}: source=${s} pg=${p}`)
    if (s !== p) {
      throw new BackfillVerifyError(a.key, `row-count mismatch for ${a.key}: source=${s} pg=${p}`)
    }
    const sHash = md5OfSortedColumn(await sortedColumnOf(src, a.srcTable, a.col))
    const pHash = md5OfSortedColumn(await sortedColumnOf(tgt, a.tgtTable, a.col, a.tgtFilter))
    checksums[a.key] = { source: sHash, pg: pHash }
    log(`  checksum ${a.key}.${a.col}: source=${sHash} pg=${pHash}`)
    if (sHash !== pHash) {
      throw new BackfillVerifyError(a.key, `checksum mismatch for ${a.key}.${a.col}: source=${sHash} pg=${pHash}`)
    }
  }

  return { counts, checksums }
}

// ── orchestration ─────────────────────────────────────────────────────────────

export async function runBackfill(opts: BackfillOptions): Promise<BackfillResult> {
  const log = opts.log ?? ((m: string) => console.log(m))
  const tenant = opts.tenant
  const tenantRef: TenantRef = { id: opts.tenantId ?? opts.tenant, slug: opts.tenant }
  const verifyOnly = opts.verifyOnly ?? false

  // #394 require-explicit-env: NEVER fall open to localhost:5432. On the
  // staging host that port is the LIVE kernel Postgres, and this script both
  // reads the source and WRITES the target — an unconfigured run was a
  // wrong-database operation with no signal. Same posture and same helper as
  // src/tenant-store.ts. Resolved BEFORE any postgres() handle is opened.
  const sourcePgUrl = requireRuntimePgUrl(
    // `??`, not `||`: an explicitly-passed EMPTY sourcePgUrl is a
    // misconfiguration, not an invitation to fall through to the env.
    opts.sourcePgUrl ?? process.env.FINANCE_TEST_PG_URL,
    'FINANCE_PG_URL',
    // Name the option that actually satisfies THIS call. The shared default
    // (`options.pgUrl`) is the TARGET endpoint: telling an operator who has
    // already passed pgUrl to pass it again is a diagnosability regression on
    // the very path this guard exists for.
    'options.sourcePgUrl, or set FINANCE_TEST_PG_URL, for the SOURCE endpoint',
  )
  const sourceDbName = opts.sourceDbName ?? 't_' + tenant
  const sourceUrl = dbUrlFor(sourcePgUrl, sourceDbName)

  const targetPgUrl = requireRuntimePgUrl(opts.pgUrl, 'FINANCE_PG_URL')
  const targetDbName = (opts.dbPrefix ?? 'finance_') + tenant
  if (resolvedDbId(sourcePgUrl, sourceDbName) === resolvedDbId(targetPgUrl, targetDbName)) {
    throw new Error(
      `[backfill] source and target resolve to the SAME database ` +
        `(${resolvedDbId(sourcePgUrl, sourceDbName)}) — refusing. The source must be the ` +
        `kernel t_<slug> DB, distinct from the leaf target "${targetDbName}".`,
    )
  }

  log(`[backfill] tenant=${tenant} source=${sourceDbName} mode=${verifyOnly ? 'verify-only' : 'copy'}`)

  const src = postgres(sourceUrl, {
    max: 2,
    prepare: false,
    connection: { options: '-c default_transaction_read_only=on' },
  })
  const tgt = await storeFor(tenantRef, { pgUrl: opts.pgUrl, dbPrefix: opts.dbPrefix })

  try {
    if (!verifyOnly) {
      if (!(await targetIsEmpty(tgt))) {
        throw new Error(
          `[backfill] target for tenant=${tenant} is NON-EMPTY — refusing to backfill ` +
            `(no delta mode). To re-run: drop finance_<slug> + its catalog row, then re-run. ` +
            `To check what is present without writing, re-run with --verify-only.`,
        )
      }
      for (const t of COPY_ORDER) {
        await copyTable(src, tgt, t, log)
      }
      for (const t of IDENTITY_TABLES) {
        await fixSequence(tgt, t, log)
      }
      // #383 Lane E1 — the aux cross-schema governance mirrors (skipped when the
      // source is a finance-only DB with no org_units / sub_org_type).
      await copyOrgUnitMirror(src, tgt, log)
      await copySubOrgType(src, tgt, log)
    }

    const { counts, checksums } = await verify(src, tgt, log)
    log(`BACKFILL OK tenant=${tenant}`)
    return { ok: true, tenant, counts, checksums }
  } finally {
    await src.end().catch(() => {})
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────

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

  const sourcePgUrl = args.sourcePgUrl ?? process.env.FINANCE_TEST_PG_URL ?? process.env.FINANCE_PG_URL
  const pgUrl = args.pgUrl ?? process.env.FINANCE_TEST_PG_URL ?? process.env.FINANCE_PG_URL

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
