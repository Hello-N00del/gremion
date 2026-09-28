/**
 * Integration tests for services/finance/scripts/backfill.ts
 *
 * Correctness — BIGINT id preservation (OVERRIDING SYSTEM VALUE + setval), UTC
 * timestamp round-trip, DATE (no tz shift), JSONB / TEXT[] fidelity, and checksum
 * verification — is paramount (this is the data migration the operator-held
 * cutover runs). Runs against FINANCE_TEST_PG_URL (a local throwaway Postgres).
 * Fail-closed guard: refuses unless host is localhost AND target DBs use the
 * `finance_test_` prefix.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import {
  storeFor,
  _resetTenantStoreForTests,
  type TenantRef,
  type Sql,
} from '../src/tenant-store.ts'
import { runBackfill } from '../scripts/backfill.ts'

// ── fail-closed guard ─────────────────────────────────────────────────────────
// FINANCE_TEST_PG_URL MUST be set explicitly to a throwaway Postgres on a
// NON-5432 port. We refuse to default to localhost:5432 — on this host that port
// is the LIVE staging Postgres, and this suite CREATEs/DROPs databases.
const TEST_PG_URL = requireEphemeralTestPgUrl()
const TEST_DB_PREFIX = 'finance_test_'

function requireEphemeralTestPgUrl(): string {
  const url = process.env.FINANCE_TEST_PG_URL
  if (!url) {
    throw new Error(
      '[fin-test-guard] FINANCE_TEST_PG_URL is REQUIRED for the finance integration suite — ' +
        'refusing to default to localhost:5432 (the LIVE staging Postgres on this host, which this ' +
        'suite would CREATE/DROP against). Start an ephemeral throwaway container on a NON-5432 ' +
        'port and export the URL, e.g.:\n' +
        '  docker run --rm -d --name fin-test-pg -p 127.0.0.1:55434:5432 -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16-alpine\n' +
        '  export FINANCE_TEST_PG_URL=postgres://postgres@localhost:55434/postgres',
    )
  }
  return url
}

function assertSafeTestEnv(url: string, dbPrefix: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`[fin-test-guard] FINANCE_TEST_PG_URL malformed: ${JSON.stringify(url)}`)
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error(`[fin-test-guard] must use postgres:// scheme. Got: ${parsed.protocol}`)
  }
  const rawHost = parsed.hostname.toLowerCase()
  const host = rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost
  if (!new Set(['localhost', '127.0.0.1', '::1']).has(host)) {
    throw new Error(`[fin-test-guard] SAFETY VIOLATION: non-localhost host "${host}" — refusing.`)
  }
  // Port 5432 (and the implicit default, i.e. empty port) is the LIVE staging PG
  // on this host — reject it outright so a misconfiguration can never hit live data.
  if (parsed.port === '' || parsed.port === '5432') {
    throw new Error(
      `[fin-test-guard] SAFETY VIOLATION: port "${parsed.port || '(implicit default 5432)'}" is the live ` +
        'Postgres — refusing. Use a throwaway container on a non-5432 port (e.g. 55434).',
    )
  }
  if (!dbPrefix.startsWith('finance_test_')) {
    throw new Error(`[fin-test-guard] SAFETY VIOLATION: dbPrefix "${dbPrefix}" — refusing.`)
  }
}
assertSafeTestEnv(TEST_PG_URL, TEST_DB_PREFIX)

// ── test tenant ───────────────────────────────────────────────────────────────
const TENANT: TenantRef = { id: 'dddddddd-dddd-dddd-dddd-dddddddddddd', slug: 'backfill' }
const SOURCE_DB = 'finance_test_backfill_src'

// The leaf schema DDL doubles as the synthetic-source schema (both sides are
// finance.*; the org_units FK omission is irrelevant to a PG→PG copy test).
const INIT_SQL = readFileSync(
  fileURLToPath(new URL('../migrations/001_finance_init.sql', import.meta.url)),
  'utf-8',
)

// Explicit BIGINT ids WITH GAPS to prove preservation (not regeneration).
const FU_A = 10
const FU_B = 20
const BANK_A = 5
const BANK_B = 8
const FY_A = 100
const FY_B = 200
const LEDGER_A = 30
const PLAN_A = 300
const PLAN_B = 305 // Nachtrag → parent_plan_id = PLAN_A (self-ref, higher id)
const SEC_A = 500
const GROUP_A = 510
const TITEL_A = 520
const PROJ_A = 50
const PROJ_B = 55
const EXP_A = 70
const BOOK_A = 400
const APPROVAL_A = 600
const STAGE_A = 610

const ORG_A = '11111111-1111-1111-1111-111111111111'
const ORG_B = '22222222-2222-2222-2222-222222222222'

const UTC_TS = '2026-01-15 09:30:00'
const UTC_TS_ISO = '2026-01-15T09:30:00.000Z'
const A_DATE = '2026-03-10'

function buildDbUrl(adminUrl: string, dbName: string): string {
  const u = new URL(adminUrl)
  u.pathname = '/' + dbName
  return u.toString()
}

async function buildSyntheticSourceDb(admin: ReturnType<typeof postgres>): Promise<void> {
  await admin.unsafe(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${SOURCE_DB}' AND pid <> pg_backend_pid()`,
  )
  await admin.unsafe(`DROP DATABASE IF EXISTS "${SOURCE_DB}"`)
  await admin.unsafe(`CREATE DATABASE "${SOURCE_DB}"`)

  const src = postgres(buildDbUrl(TEST_PG_URL, SOURCE_DB), { max: 1, prepare: false })
  try {
    await src.unsafe(INIT_SQL)

    // #383 Lane E1 — kernel-shaped governance tables the backfill mirrors into the
    // leaf (public.org_units → finance.org_unit_mirror, public.sub_org_type →
    // finance.sub_org_type). Minimal shape: only the columns the aux copy reads.
    await src.unsafe(`
      CREATE TABLE org_units (
        id UUID PRIMARY KEY, parent_id UUID, kind TEXT NOT NULL, name TEXT NOT NULL
      );
      CREATE TABLE sub_org_type (
        id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );`)
    await src.unsafe(
      `INSERT INTO org_units (id, parent_id, kind, name) VALUES
         ($1, NULL, 'council', 'StuRa'),
         ($2, $1, 'committee', 'Fachschaft Info')`,
      [ORG_A, ORG_B],
    )
    // BIGSERIAL accepts explicit ids — gaps (3, 7) prove id preservation on copy.
    await src.unsafe(
      `INSERT INTO sub_org_type (id, name, description) VALUES (3, 'Referat', 'ref desc'), (7, 'AG', NULL)`,
    )

    // finanzordnung_profile — id + two JSONB columns (default-shaped).
    await src.unsafe(
      `INSERT INTO finance.finanzordnung_profile (id, bundesland) OVERRIDING SYSTEM VALUE VALUES (1, 'Sachsen')`,
    )
    // finance_unit (org_unit_id plain UUID; no FK on the leaf)
    await src.unsafe(
      `INSERT INTO finance.finance_unit (id, org_unit_id, kind, bookkeeping_mode, carry_over_rule) OVERRIDING SYSTEM VALUE VALUES
         ($1, $3, 'central', 'central', 'to_reserves'),
         ($2, $4, 'standard', 'own', 'carry_forward')`,
      [FU_A, FU_B, ORG_A, ORG_B],
    )
    // bank_account (iban checksummed)
    await src.unsafe(
      `INSERT INTO finance.bank_account (id, name, iban) OVERRIDING SYSTEM VALUE VALUES
         ($1, 'Giro', 'DE00100000000000000001'),
         ($2, 'Spar', 'DE00100000000000000002')`,
      [BANK_A, BANK_B],
    )
    // fiscal_year (name checksummed; start/end are DATE)
    await src.unsafe(
      `INSERT INTO finance.fiscal_year (id, name, start_date, end_date) OVERRIDING SYSTEM VALUE VALUES
         ($1, 'HHJ 2026', '2026-01-01', '2026-12-31'),
         ($2, 'HHJ 2027', '2027-01-01', '2027-12-31')`,
      [FY_A, FY_B],
    )
    // ledger_account
    await src.unsafe(
      `INSERT INTO finance.ledger_account (id, finance_unit_id, bank_account_id, type, name) OVERRIDING SYSTEM VALUE VALUES ($1, $2, $3, 'own_account', 'Hauptkasse')`,
      [LEDGER_A, FU_A, BANK_A],
    )
    // budget_plan (self-ref: PLAN_B.parent = PLAN_A; created_at carries the UTC instant)
    await src.unsafe(
      `INSERT INTO finance.budget_plan (id, fiscal_year_id, name, parent_plan_id, created_at) OVERRIDING SYSTEM VALUE VALUES
         ($1, $3, 'Haushalt 2026', NULL, $4),
         ($2, $3, 'Nachtrag 2026', $1, $4)`,
      [PLAN_A, PLAN_B, FY_A, UTC_TS + 'Z'],
    )
    // budget_section / group / titel chain
    await src.unsafe(
      `INSERT INTO finance.budget_section (id, budget_plan_id, finance_unit_id) OVERRIDING SYSTEM VALUE VALUES ($1, $2, $3)`,
      [SEC_A, PLAN_A, FU_A],
    )
    await src.unsafe(
      `INSERT INTO finance.budget_group (id, budget_section_id, name, budget_type) OVERRIDING SYSTEM VALUE VALUES ($1, $2, 'Ausgaben', 'expense')`,
      [GROUP_A, SEC_A],
    )
    await src.unsafe(
      `INSERT INTO finance.budget_titel (id, budget_group_id, titel_name, planned_cents) OVERRIDING SYSTEM VALUE VALUES ($1, $2, 'Sachkosten', 500000)`,
      [TITEL_A, GROUP_A],
    )
    // project (name checksummed; date_start/date_end are DATE)
    await src.unsafe(
      `INSERT INTO finance.project (id, org_unit_id, type, name, date_start, date_end) OVERRIDING SYSTEM VALUE VALUES
         ($1, $3, 'internal', 'Ersti-Woche', $5, $6),
         ($2, $4, 'external_grant', 'Sommerfest', NULL, NULL)`,
      [PROJ_A, PROJ_B, ORG_A, ORG_B, A_DATE, A_DATE],
    )
    // expense (payee_name checksummed)
    await src.unsafe(
      `INSERT INTO finance.expense (id, finance_unit_id, project_id, payee_name, payment_method) OVERRIDING SYSTEM VALUE VALUES ($1, $2, $3, 'Musterfirma GmbH', 'bank_transfer')`,
      [EXP_A, FU_A, PROJ_A],
    )
    // booking — DATE booking_date + TIMESTAMPTZ retention_until
    await src.unsafe(
      `INSERT INTO finance.booking (id, ledger_account_id, budget_titel_id, fiscal_year_id, amount_cents, booking_date, running_no, payment_type, retention_until) OVERRIDING SYSTEM VALUE
       VALUES ($1, $2, $3, $4, 12345, $5, 1, 'bargeldlos', $6)`,
      [BOOK_A, LEDGER_A, TITEL_A, FY_A, A_DATE, UTC_TS + 'Z'],
    )
    // approval + approval_stage (TEXT[] certifies + TIMESTAMPTZ acted_at)
    await src.unsafe(
      `INSERT INTO finance.approval (id, approvable_type, approvable_id, created_by) OVERRIDING SYSTEM VALUE VALUES ($1, 'expense', $2, 'user-1')`,
      [APPROVAL_A, EXP_A],
    )
    await src.unsafe(
      `INSERT INTO finance.approval_stage (id, approval_id, stage_index, role, required_group, certifies, acted_at) OVERRIDING SYSTEM VALUE
       VALUES ($1, $2, 0, 'KV', 'ref-finanzen-kv', ARRAY['sachlich','rechnerisch'], $3)`,
      [STAGE_A, APPROVAL_A, UTC_TS + 'Z'],
    )
  } finally {
    await src.end()
  }
}

let admin: ReturnType<typeof postgres>

async function dropTestDbs(): Promise<void> {
  const rows = await admin<{ datname: string }[]>`
    SELECT datname FROM pg_database WHERE datname LIKE 'finance_test_%'
  `
  for (const { datname } of rows) {
    await admin.unsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${datname}' AND pid <> pg_backend_pid()`,
    )
    await admin.unsafe(`DROP DATABASE IF EXISTS "${datname}"`)
  }
}

async function freshTarget(): Promise<Sql> {
  await _resetTenantStoreForTests()
  await dropTestDbs()
  await buildSyntheticSourceDb(admin)
  return storeFor(TENANT, { pgUrl: TEST_PG_URL, dbPrefix: TEST_DB_PREFIX })
}

const OPTS = {
  tenant: TENANT.slug,
  tenantId: TENANT.id,
  sourcePgUrl: TEST_PG_URL,
  sourceDbName: SOURCE_DB,
  pgUrl: TEST_PG_URL,
  dbPrefix: TEST_DB_PREFIX,
} as const

beforeAll(async () => {
  admin = postgres(TEST_PG_URL, { max: 1, prepare: false })
  await buildSyntheticSourceDb(admin)
})

afterAll(async () => {
  await _resetTenantStoreForTests()
  await dropTestDbs()
  await admin.end()
})

describe('finance backfill — happy path (fresh target)', () => {
  beforeEach(async () => {
    await freshTarget()
  })

  it('migrates every table with equal row counts and prints BACKFILL OK', async () => {
    const logs: string[] = []
    const res = await runBackfill({ ...OPTS, verifyOnly: false, log: (m) => logs.push(m) })
    expect(res.ok).toBe(true)
    expect(res.counts['finance_unit']).toEqual({ source: 2, pg: 2 })
    expect(res.counts['bank_account']).toEqual({ source: 2, pg: 2 })
    expect(res.counts['fiscal_year']).toEqual({ source: 2, pg: 2 })
    expect(res.counts['budget_plan']).toEqual({ source: 2, pg: 2 })
    expect(res.counts['booking']).toEqual({ source: 1, pg: 1 })
    expect(res.counts['approval_stage']).toEqual({ source: 1, pg: 1 })
    // an empty table verifies 0 = 0
    expect(res.counts['reconciliation']).toEqual({ source: 0, pg: 0 })
    expect(logs.join('\n')).toContain(`BACKFILL OK tenant=${TENANT.slug}`)
  })

  it('prints checksum lines for the representative checksummed tables', async () => {
    const logs: string[] = []
    await runBackfill({ ...OPTS, verifyOnly: false, log: (m) => logs.push(m) })
    const out = logs.join('\n')
    expect(out).toMatch(/checksum.*bank_account/i)
    expect(out).toMatch(/checksum.*fiscal_year/i)
    expect(out).toMatch(/checksum.*project/i)
    expect(out).toMatch(/checksum.*expense/i)
  })

  // ── #383 Lane E1 — aux governance mirrors ─────────────────────────────────────
  it('mirrors public.org_units → finance.org_unit_mirror (row-count + name checksum match)', async () => {
    const res = await runBackfill({ ...OPTS, verifyOnly: false, log: () => {} })
    expect(res.counts['org_unit_mirror']).toEqual({ source: 2, pg: 2 })
    expect(res.checksums['org_unit_mirror']!.source).toBe(res.checksums['org_unit_mirror']!.pg)
  })

  it('mirrors public.sub_org_type → finance.sub_org_type, id-preserving (row-count + checksum match)', async () => {
    const sql = await freshTarget()
    const res = await runBackfill({ ...OPTS, verifyOnly: false, log: () => {} })
    expect(res.counts['sub_org_type']).toEqual({ source: 2, pg: 2 })
    expect(res.checksums['sub_org_type']!.source).toBe(res.checksums['sub_org_type']!.pg)
    // ids 3 and 7 (with a gap) preserved verbatim.
    const types = await sql<{ id: number; name: string }[]>`SELECT id, name FROM finance.sub_org_type ORDER BY id`
    expect(types.map((r) => Number(r.id))).toEqual([3, 7])
    // the identity sequence advanced past the max copied id.
    const inserted = await sql<{ id: number }[]>`
      INSERT INTO finance.sub_org_type (name) VALUES ('NEW') RETURNING id`
    expect(Number(inserted[0]!.id)).toBeGreaterThan(7)
  })

  it('copies the org_unit_mirror rows verbatim (id/name/kind/parent_id) with deleted=false', async () => {
    const sql = await freshTarget()
    await runBackfill({ ...OPTS, verifyOnly: false, log: () => {} })
    const rows = await sql<{ id: string; name: string; kind: string; parent_id: string | null; deleted: boolean }[]>`
      SELECT id, name, kind, parent_id, deleted FROM finance.org_unit_mirror ORDER BY name`
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ id: ORG_B, name: 'Fachschaft Info', kind: 'committee', parent_id: ORG_A, deleted: false })
    expect(rows[1]).toMatchObject({ id: ORG_A, name: 'StuRa', kind: 'council', parent_id: null, deleted: false })
  })

  // TASK-009 lane C: the netcup test env had org_unit_mirror ALREADY populated
  // by the live org-unit consumer (11 rows) before the backfill ever ran —
  // the ordinary state once FINANCE_BACKEND=service is flipped and events
  // start flowing, even though the runbook says backfill should run FIRST.
  // The old plain INSERT collided on the mirror's `id` PRIMARY KEY and threw,
  // aborting the whole backfill AFTER the other ~30 tables had already been
  // copied — leaving the leaf half-populated with no verify gate ever
  // reached (ROOT-CAUSE.md's "risks"). copyOrgUnitMirror must upsert instead.
  it('upserts org_unit_mirror instead of throwing a PK conflict when the target already has consumer-written rows', async () => {
    const sql = await freshTarget()
    // Simulate the live consumer having already mirrored ORG_A (same id as
    // the source) with a DIFFERENT name/kind — a stale/partial consumer
    // snapshot, exactly what a mid-cutover environment looks like.
    await sql`
      INSERT INTO finance.org_unit_mirror (id, name, kind, parent_id)
      VALUES (${ORG_A}, 'StuRa (consumer-stale)', 'council', NULL)`

    const res = await runBackfill({ ...OPTS, verifyOnly: false, log: () => {} })
    expect(res.ok).toBe(true)
    expect(res.counts['org_unit_mirror']).toEqual({ source: 2, pg: 2 })

    const rows = await sql<{ id: string; name: string }[]>`
      SELECT id, name FROM finance.org_unit_mirror ORDER BY name`
    expect(rows).toHaveLength(2)
    // The backfill's own copy of the source row wins on conflict — the
    // source is the id-preserving migration's single source of truth.
    expect(rows.find((r) => r.id === ORG_A)?.name).toBe('StuRa')
  })

  // Fix round 1 (review r1-finance-C1C2, MEDIUM/lang:sql): a consumer-written
  // TOMBSTONE row (an org unit the kernel hard-deleted, whose mirror row the
  // consumer marked deleted=true rather than removing) has no counterpart in
  // the source (public.org_units, hard-deletes). Before the fix, the aux
  // verify counted EVERY mirror row, so this extra tombstone made source !=
  // pg and threw BackfillVerifyError AFTER every other table had already
  // copied successfully.
  it('tolerates a consumer tombstone row in org_unit_mirror (verify gate excludes deleted=true)', async () => {
    const sql = await freshTarget()
    const TOMBSTONE_ID = '99999999-9999-9999-9999-999999999999'
    await sql`
      INSERT INTO finance.org_unit_mirror (id, name, kind, parent_id, deleted)
      VALUES (${TOMBSTONE_ID}, 'Deleted Referat', 'committee', NULL, true)`

    const res = await runBackfill({ ...OPTS, verifyOnly: false, log: () => {} })
    expect(res.ok).toBe(true)
    expect(res.counts['org_unit_mirror']).toEqual({ source: 2, pg: 2 })

    // The tombstone itself is untouched — the backfill neither deletes it nor
    // resurrects it.
    const tomb = await sql<{ deleted: boolean }[]>`
      SELECT deleted FROM finance.org_unit_mirror WHERE id = ${TOMBSTONE_ID}`
    expect(tomb[0]?.deleted).toBe(true)
  })

  // Fix round 1 (review r1-finance-C1C2, LOW/lang:sql): the upsert must not
  // clobber a row the live consumer has already updated with a NEWER event
  // than this backfill's own snapshot — the ordering guard mirrors
  // org-unit-consumer.ts's own (`WHERE EXCLUDED.source_occurred_at >
  // finance.org_unit_mirror.source_occurred_at`).
  it('never overwrites a newer consumer-applied event with older backfill snapshot data', async () => {
    const sql = await freshTarget()
    // `name` is kept IDENTICAL to the source ('StuRa') so the aux verify's name
    // checksum can never be the thing that fails this test either way — the
    // discriminating column is `kind`, which verify() does NOT checksum. The
    // consumer has (per this row's FUTURE source_occurred_at) already applied
    // a reclassification the source itself agrees with going forward; the
    // ordering guard must mean this backfill's snapshot never reverts it.
    const FUTURE = new Date(Date.now() + 24 * 60 * 60 * 1000) // 1 day ahead of "now"
    await sql`
      INSERT INTO finance.org_unit_mirror (id, name, kind, parent_id, source_occurred_at)
      VALUES (${ORG_A}, 'StuRa', 'committee', NULL, ${FUTURE})`

    const res = await runBackfill({ ...OPTS, verifyOnly: false, log: () => {} })
    expect(res.ok).toBe(true)

    const row = await sql<{ kind: string; source_occurred_at: Date }[]>`
      SELECT kind, source_occurred_at FROM finance.org_unit_mirror WHERE id = ${ORG_A}`
    // Pre-fix, the plain UPSERT unconditionally overwrote kind/name/parent_id
    // on every conflict — it would have reverted 'committee' back to the
    // source's 'council'. The guard must have skipped that write entirely.
    expect(row[0]!.kind).toBe('committee')
    expect(row[0]!.source_occurred_at.getTime()).toBe(FUTURE.getTime())
  })

  it('--verify-only catches a tampered org_unit_mirror name (checksum), NAMING the table', async () => {
    const sql = await freshTarget()
    await runBackfill({ ...OPTS, verifyOnly: false, log: () => {} })
    await sql`UPDATE finance.org_unit_mirror SET name = 'TAMPERED' WHERE id = ${ORG_A}`
    await expect(runBackfill({ ...OPTS, verifyOnly: true, log: () => {} })).rejects.toThrow(/org_unit_mirror/)
  })

  it('PRESERVES BIGINT ids: source ids (with gaps) appear verbatim in the target', async () => {
    const sql = await freshTarget()
    await runBackfill({ ...OPTS, verifyOnly: false, log: () => {} })
    const fu = await sql<{ id: number }[]>`SELECT id FROM finance.finance_unit ORDER BY id`
    expect(fu.map((r) => Number(r.id))).toEqual([FU_A, FU_B])
    const plans = await sql<{ id: number; parent_plan_id: number | null }[]>`SELECT id, parent_plan_id FROM finance.budget_plan ORDER BY id`
    expect(plans.map((r) => Number(r.id))).toEqual([PLAN_A, PLAN_B])
    // self-ref preserved: the Nachtrag still points at its parent plan.
    expect(Number(plans[1]!.parent_plan_id)).toBe(PLAN_A)
    const book = await sql<{ id: number }[]>`SELECT id FROM finance.booking`
    expect(Number(book[0]!.id)).toBe(BOOK_A)
  })

  it('advances identity sequences past the max copied id (no collision on the next insert)', async () => {
    const sql = await freshTarget()
    await runBackfill({ ...OPTS, verifyOnly: false, log: () => {} })
    // max fiscal_year id was FY_B (200); the next serial must be > 200.
    const inserted = await sql<{ id: number }[]>`
      INSERT INTO finance.fiscal_year (name, start_date, end_date)
      VALUES ('HHJ 2028', '2028-01-01', '2028-12-31') RETURNING id
    `
    expect(Number(inserted[0]!.id)).toBeGreaterThan(FY_B)
  })

  it('round-trips UTC timestamps (kernel UTC instant → same instant in timestamptz)', async () => {
    const sql = await freshTarget()
    await runBackfill({ ...OPTS, verifyOnly: false, log: () => {} })
    const rows = await sql<{ created_at: Date }[]>`SELECT created_at FROM finance.budget_plan WHERE id = ${PLAN_A}`
    expect(rows[0]!.created_at.toISOString()).toBe(UTC_TS_ISO)
    const bk = await sql<{ retention_until: Date }[]>`SELECT retention_until FROM finance.booking WHERE id = ${BOOK_A}`
    expect(bk[0]!.retention_until.toISOString()).toBe(UTC_TS_ISO)
  })

  it('round-trips DATE columns with no timezone shift', async () => {
    const sql = await freshTarget()
    await runBackfill({ ...OPTS, verifyOnly: false, log: () => {} })
    const fy = await sql<{ d: string }[]>`SELECT to_char(start_date, 'YYYY-MM-DD') AS d FROM finance.fiscal_year WHERE id = ${FY_A}`
    expect(fy[0]!.d).toBe('2026-01-01')
    const bk = await sql<{ d: string }[]>`SELECT to_char(booking_date, 'YYYY-MM-DD') AS d FROM finance.booking WHERE id = ${BOOK_A}`
    expect(bk[0]!.d).toBe(A_DATE)
  })

  it('preserves JSONB (finanzordnung signer_stages) and TEXT[] (approval_stage.certifies)', async () => {
    const sql = await freshTarget()
    await runBackfill({ ...OPTS, verifyOnly: false, log: () => {} })
    const prof = await sql<{ signer_stages: unknown; t_s: string; t_d: string }[]>`
      SELECT signer_stages,
             jsonb_typeof(signer_stages) AS t_s, jsonb_typeof(decision_authority_tiers) AS t_d
      FROM finance.finanzordnung_profile WHERE id = 1`
    // TASK-009 fix round 5: NO normalisation here. This test used to JSON.parse a
    // string result "because postgres-js may return JSONB as a string" — that
    // tolerance hid the real defect: the backfill bound the JSON *string* into a
    // jsonb parameter, postgres-js JSON.stringify'd it AGAIN, and the target held a
    // jsonb STRING scalar. The live leaf then served signerStages as a string and
    // /finance/finanzordnung 500'd ("data.signerStages.map is not a function").
    // The copy must land as a jsonb ARRAY, read back as a JS array.
    expect(prof[0]!.t_s).toBe('array')
    expect(prof[0]!.t_d).toBe('array')
    const stages = prof[0]!.signer_stages as Array<{ role?: string }>
    expect(Array.isArray(stages)).toBe(true)
    expect(stages.some((s) => s.role === 'KV')).toBe(true)
    const stage = await sql<{ certifies: string[] }[]>`SELECT certifies FROM finance.approval_stage WHERE id = ${STAGE_A}`
    expect(stage[0]!.certifies).toEqual(['sachlich', 'rechnerisch'])
  })

  it('refuses a NON-EMPTY target unless --verify-only', async () => {
    await runBackfill({ ...OPTS, verifyOnly: false, log: () => {} })
    await expect(runBackfill({ ...OPTS, verifyOnly: false, log: () => {} })).rejects.toThrow(/non-empty|not empty|already/i)
  })

  it('refuses when source and target resolve to the SAME database (before any copy)', async () => {
    await freshTarget()
    const targetDbName = TEST_DB_PREFIX + TENANT.slug
    await expect(
      runBackfill({ ...OPTS, sourceDbName: targetDbName, verifyOnly: false, log: () => {} }),
    ).rejects.toThrow(/same database|source and target/i)
  })

  it('is idempotent in --verify-only mode against a correctly-backfilled target', async () => {
    await runBackfill({ ...OPTS, verifyOnly: false, log: () => {} })
    const logs: string[] = []
    const res = await runBackfill({ ...OPTS, verifyOnly: true, log: (m) => logs.push(m) })
    expect(res.ok).toBe(true)
    expect(logs.join('\n')).toContain(`BACKFILL OK tenant=${TENANT.slug}`)
  })
})

describe('finance backfill — verify gate catches a TAMPERED target', () => {
  it('--verify-only on a tampered checksummed column exits non-ok NAMING the table', async () => {
    const sql = await freshTarget()
    await runBackfill({ ...OPTS, verifyOnly: false, log: () => {} })
    await sql`UPDATE finance.bank_account SET iban = 'DE99999999999999999999' WHERE id = ${BANK_A}`
    const logs: string[] = []
    await expect(runBackfill({ ...OPTS, verifyOnly: true, log: (m) => logs.push(m) })).rejects.toThrow(/bank_account/)
    expect(logs.join('\n')).not.toContain('BACKFILL OK')
  })

  it('--verify-only on a deleted row exits non-ok NAMING the table (count mismatch)', async () => {
    const sql = await freshTarget()
    await runBackfill({ ...OPTS, verifyOnly: false, log: () => {} })
    await sql`DELETE FROM finance.fiscal_year WHERE id = ${FY_B}`
    await expect(runBackfill({ ...OPTS, verifyOnly: true, log: () => {} })).rejects.toThrow(/fiscal_year/)
  })
})

// TASK-009 lane C, requested guard (finance-plan.md §6 item 1): the pipeline
// this whole change protects, end to end. F1's live symptom was an approval
// (#4, at the HV stage with KV already signed) sitting in the monolith while
// the leaf's own `finance.approval` was empty, so `listPendingApprovals`
// against the leaf returned nothing an ref-finanzen-hv actor could act on —
// "no approvable entry through the seam". This reproduces that EXACT shape
// (a second, HV-staged approval alongside the shared APPROVAL_A/STAGE_A KV
// fixture) directly in the monolith-shaped source, runs the real
// `runBackfill`, then reads the LEAF via the leaf's own
// store.listPendingApprovals (the same reader ServiceFinanceClient's HTTP
// route calls) — never gremion-ui's seam, which is a separate workspace with
// its own tenant-pool ALS context this integration suite does not stand up.
describe('finance backfill — leaf approvability after backfill (TASK-009 requested guard)', () => {
  it('an approval backfilled from the monolith is listPendingApprovals()-visible to an actor whose groups match its CURRENT stage', async () => {
    const tgt = await freshTarget()

    const EXP_HV = 71
    const APPROVAL_HV = 601
    const STAGE_HV_KV = 611 // stage_index 0 — already signed
    const STAGE_HV_HV = 612 // stage_index 1 — the current, pending stage

    const src = postgres(buildDbUrl(TEST_PG_URL, SOURCE_DB), { max: 1, prepare: false })
    try {
      await src.unsafe(
        `INSERT INTO finance.expense (id, finance_unit_id, project_id, payee_name, payment_method)
         OVERRIDING SYSTEM VALUE VALUES ($1, $2, NULL, 'HV-Fixture GmbH', 'bank_transfer')`,
        [EXP_HV, FU_A],
      )
      // current_stage_index=1: the KV stage (0) is already signed, mirroring
      // the live netcup approval #4 exactly (ROOT-CAUSE.md).
      await src.unsafe(
        `INSERT INTO finance.approval (id, approvable_type, approvable_id, created_by, current_stage_index)
         OVERRIDING SYSTEM VALUE VALUES ($1, 'expense', $2, 'user-1', 1)`,
        [APPROVAL_HV, EXP_HV],
      )
      await src.unsafe(
        `INSERT INTO finance.approval_stage
           (id, approval_id, stage_index, role, required_group, certifies, state, signer_user_id, acted_at)
         OVERRIDING SYSTEM VALUE VALUES ($1, $2, 0, 'KV', 'ref-finanzen-kv', ARRAY['sachlich','rechnerisch'], 'approved', 'user-kv', $3)`,
        [STAGE_HV_KV, APPROVAL_HV, UTC_TS + 'Z'],
      )
      await src.unsafe(
        `INSERT INTO finance.approval_stage (id, approval_id, stage_index, role, required_group, certifies, state)
         OVERRIDING SYSTEM VALUE VALUES ($1, $2, 1, 'HV', 'ref-finanzen-hv', ARRAY[]::text[], 'pending')`,
        [STAGE_HV_HV, APPROVAL_HV],
      )
    } finally {
      await src.end()
    }

    const res = await runBackfill({ ...OPTS, verifyOnly: false, log: () => {} })
    expect(res.ok).toBe(true)

    const { listPendingApprovals } = await import('../src/store/index.ts')
    // An auditor scope mirrors the probe/badge callers that need to SEE
    // every pending row before per-actor group eligibility is applied — the
    // point under test is reachability through the leaf's own reader, not
    // the separate org-unit-scope resolution.
    const pending = await listPendingApprovals(tgt, {
      isAuditor: true, isSuperuser: false, scopedOrgUnitIds: [],
    })

    const hvActorGroups = ['ref-finanzen-hv']
    const approvableForHvActor = pending.filter((a) => hvActorGroups.includes(a.current_required_group ?? ''))
    expect(approvableForHvActor.length, 'no approvable entry through the seam').toBeGreaterThanOrEqual(1)
    expect(approvableForHvActor[0]!.id).toBe(APPROVAL_HV)
    expect(approvableForHvActor[0]!.status).toBe('pending')
  })
})
