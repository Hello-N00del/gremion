/**
 * JSONB wire-shape guard for the finance leaf (TASK-009 fix round 5).
 *
 * LIVE REGRESSION (2026-09-25, netcup test env, FINANCE_BACKEND=service, leaf
 * backfilled): /finance/finanzordnung → 500 "data.signerStages.map is not a
 * function". Root cause: the backfill bound each JSONB value as a JSON *string*
 * into a jsonb parameter; postgres-js serialises a jsonb parameter with
 * JSON.stringify, so the string was encoded TWICE and stored as a jsonb string
 * scalar ('"[{...}]"'). postgres-js parses that back to a JS string, the leaf
 * sent `"signerStages": "[{...}]"` over HTTP, and the page's `.map` threw. The
 * leaf's own closeBudget wrote budget_plan.statement the same way.
 *
 * This file asserts the REAL HTTP JSON shape against a real Postgres:
 *   - getSignerConfig / updateSignerConfig return ARRAYS (proper + legacy rows)
 *   - getFinanzordnungProfile returns the DTO object (numbers, no JSONB leak)
 *   - migration 005 repairs the double-encoded rows at rest
 *   - closeBudget persists budget_plan.statement as a jsonb OBJECT and the
 *     statement read returns an object (proper + legacy rows)
 *
 * Runs against FINANCE_TEST_PG_URL (a local throwaway Postgres); fail-closed
 * guard: localhost-only, non-5432 port, finance_test_ DB-name prefix.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'
import { createServer } from '../src/http/server.ts'
import { buildApiRoutes } from '../src/http/routes.ts'
import { storeFor, _resetTenantStoreForTests, type TenantRef, type Sql } from '../src/tenant-store.ts'
import { closeBudget, getBudgetStatement, getSignerConfig, type ActorContext } from '../src/store/index.ts'

const TEST_PG_URL = requireEphemeralTestPgUrl()
const TEST_DB_PREFIX = 'finance_test_'

function requireEphemeralTestPgUrl(): string {
  const url = process.env.FINANCE_TEST_PG_URL
  if (!url) {
    throw new Error(
      '[fin-test-guard] FINANCE_TEST_PG_URL is REQUIRED for the finance integration suite — ' +
        'refusing to default to localhost:5432. Start an ephemeral throwaway container on a ' +
        'NON-5432 port and export the URL.',
    )
  }
  return url
}

function assertSafeTestEnv(url: string, dbPrefix: string): void {
  const parsed = new URL(url)
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error(`[fin-test-guard] must use postgres:// scheme. Got: ${parsed.protocol}`)
  }
  const rawHost = parsed.hostname.toLowerCase()
  const host = rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost
  if (!new Set(['localhost', '127.0.0.1', '::1']).has(host)) {
    throw new Error(`[fin-test-guard] SAFETY VIOLATION: non-localhost host "${host}" — refusing.`)
  }
  if (parsed.port === '' || parsed.port === '5432') {
    throw new Error(`[fin-test-guard] SAFETY VIOLATION: port "${parsed.port || '5432'}" is the live Postgres — refusing.`)
  }
  if (!dbPrefix.startsWith('finance_test_')) {
    throw new Error(`[fin-test-guard] SAFETY VIOLATION: dbPrefix "${dbPrefix}" — refusing.`)
  }
}
assertSafeTestEnv(TEST_PG_URL, TEST_DB_PREFIX)

const SECRET = 'jsonb-shape-secret'
const TENANT: TenantRef = { id: 'abababab-abab-4bab-8bab-abababababab', slug: 'jsonbshape' }
const HEADERS = {
  'x-internal-auth': SECRET,
  'x-tenant-id': TENANT.id,
  'x-tenant-slug': TENANT.slug,
  'x-finance-user-id': 'dev.admin',
  'x-finance-groups-json': Buffer.from(JSON.stringify(['admin']), 'utf8').toString('base64url'),
  'content-type': 'application/json',
}
const SUPER: ActorContext = { isAuditor: false, isSuperuser: true, scopedOrgUnitIds: [], userId: 'dev.admin', groups: ['admin'] }

const STAGES = [
  { role: 'KV', required_group: 'ref-finanzen-kv', certifies: ['sachlich', 'rechnerisch'] },
  { role: 'HV', required_group: 'ref-finanzen-hv', certifies: ['anordnung'] },
]
const TIERS = [{ max_amount_cents: 50000, required_group: 'ref-finanzen-hv' }]

/** Read lazily so a missing file fails only the migration test, not the file. */
function migration005(): string {
  return readFileSync(
    fileURLToPath(new URL('../migrations/005_unwrap_double_encoded_jsonb.sql', import.meta.url)),
    'utf-8',
  )
}

/** Run a migration file exactly as tenant-store.ts#runMigrations does: strip the
 *  file's own BEGIN/COMMIT and execute the body inside sql.begin. */
async function runMigrationFile(sql: Sql, text: string): Promise<void> {
  const stripped = text.replace(/^\s*BEGIN\s*;?\s*/im, '').replace(/\s*COMMIT\s*;?\s*$/im, '')
  await sql.begin(async (tx) => {
    await tx.unsafe(stripped)
  })
}

/** Seed the singleton profile row EXACTLY the way the pre-fix backfill did:
 *  a JSON *string* bound (via sql.unsafe) into the jsonb columns. */
async function seedBackfillShapedProfile(sql: Sql): Promise<void> {
  await sql.unsafe(
    `INSERT INTO finance.finanzordnung_profile (bundesland, signer_stages, decision_authority_tiers)
     VALUES ('Sachsen', $1, $2)`,
    [JSON.stringify(STAGES), JSON.stringify(TIERS)],
  )
}

/** Seed a correctly-encoded profile row (jsonb arrays). */
async function seedProperProfile(sql: Sql): Promise<void> {
  await sql`
    INSERT INTO finance.finanzordnung_profile (bundesland, signer_stages, decision_authority_tiers)
    VALUES ('Sachsen', ${sql.json(STAGES as never) as never}, ${sql.json(TIERS as never) as never})`
}

describe('finance leaf — JSONB columns cross the HTTP boundary as JSON arrays/objects (real PG)', () => {
  let server: ReturnType<typeof createServer>
  let base: string
  let sql: Sql

  beforeAll(async () => {
    await _resetTenantStoreForTests()
    sql = await storeFor(TENANT, { pgUrl: TEST_PG_URL, dbPrefix: TEST_DB_PREFIX })
    const storeFn = (t: TenantRef) => storeFor(t, { pgUrl: TEST_PG_URL, dbPrefix: TEST_DB_PREFIX })
    server = createServer({ secret: SECRET, routes: buildApiRoutes(storeFn) })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
    await _resetTenantStoreForTests()
  })

  beforeEach(async () => {
    await sql`TRUNCATE finance.finanzordnung_profile, finance.budget_plan, finance.fiscal_year,
              finance.finance_unit RESTART IDENTITY CASCADE`
  })

  async function getJson(path: string): Promise<{ status: number; body: any; text: string }> {
    const res = await fetch(`${base}${path}`, { headers: HEADERS })
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : undefined, text }
  }

  it('GET /api/v1/finanzordnung/signer-config returns ARRAYS for a correctly-encoded row', async () => {
    await seedProperProfile(sql)
    const { status, body, text } = await getJson('/api/v1/finanzordnung/signer-config')
    expect(status, text).toBe(200)
    expect(Array.isArray(body.signerStages), text).toBe(true)
    expect(Array.isArray(body.decisionAuthorityTiers), text).toBe(true)
    expect(body).toEqual({ signerStages: STAGES, decisionAuthorityTiers: TIERS })
  })

  it('GET /api/v1/finanzordnung/signer-config returns ARRAYS for a backfill-shaped (double-encoded) row', async () => {
    await seedBackfillShapedProfile(sql)
    // Precondition: the row really is double-encoded (what the live leaf held).
    const raw = await sql<{ t: string }[]>`SELECT jsonb_typeof(signer_stages) AS t FROM finance.finanzordnung_profile`
    expect(raw[0]!.t).toBe('string')
    const { status, body, text } = await getJson('/api/v1/finanzordnung/signer-config')
    expect(status, text).toBe(200)
    expect(Array.isArray(body.signerStages), text).toBe(true)
    expect(Array.isArray(body.decisionAuthorityTiers), text).toBe(true)
    expect(body).toEqual({ signerStages: STAGES, decisionAuthorityTiers: TIERS })
  })

  it('store getSignerConfig (the createApproval input) yields arrays for a backfill-shaped row', async () => {
    await seedBackfillShapedProfile(sql)
    const cfg = await getSignerConfig(sql)
    expect(Array.isArray(cfg!.signerStages)).toBe(true)
    expect(cfg!.signerStages.map((s) => s.role)).toEqual(['KV', 'HV'])
    expect(Array.isArray(cfg!.decisionAuthorityTiers)).toBe(true)
  })

  it('PUT /api/v1/finanzordnung/signer-config stores jsonb ARRAYS and echoes arrays', async () => {
    await seedBackfillShapedProfile(sql)
    const res = await fetch(`${base}/api/v1/finanzordnung/signer-config`, {
      method: 'PUT',
      headers: HEADERS,
      body: JSON.stringify({ signerStages: STAGES, decisionAuthorityTiers: TIERS }),
    })
    const text = await res.text()
    expect(res.status, text).toBe(200)
    const body = JSON.parse(text)
    expect(Array.isArray(body.signerStages), text).toBe(true)
    expect(Array.isArray(body.decisionAuthorityTiers), text).toBe(true)
    const t = await sql<{ s: string; d: string }[]>`
      SELECT jsonb_typeof(signer_stages) AS s, jsonb_typeof(decision_authority_tiers) AS d
      FROM finance.finanzordnung_profile`
    expect(t[0]).toEqual({ s: 'array', d: 'array' })
  })

  it('GET /api/v1/finanzordnung returns the profile DTO object (numbers, no JSONB columns)', async () => {
    await seedBackfillShapedProfile(sql)
    const { status, body, text } = await getJson('/api/v1/finanzordnung')
    expect(status, text).toBe(200)
    expect(typeof body).toBe('object')
    expect(body.bundesland).toBe('Sachsen')
    expect(typeof body.id).toBe('number')
    expect(typeof body.deckungsfaehigkeit_pct).toBe('number')
    expect(typeof body.retention_years).toBe('number')
    expect(body).not.toHaveProperty('signer_stages')
    expect(body).not.toHaveProperty('decision_authority_tiers')
  })

  it('migration 005 unwraps double-encoded jsonb rows at rest (and is a no-op on proper rows)', async () => {
    await seedBackfillShapedProfile(sql)
    await runMigrationFile(sql, migration005())
    const t = await sql<{ s: string; d: string; stages: unknown }[]>`
      SELECT jsonb_typeof(signer_stages) AS s, jsonb_typeof(decision_authority_tiers) AS d,
             signer_stages AS stages
      FROM finance.finanzordnung_profile`
    expect(t[0]!.s).toBe('array')
    expect(t[0]!.d).toBe('array')
    expect(t[0]!.stages).toEqual(STAGES)
    // Idempotent: a second run changes nothing.
    await runMigrationFile(sql, migration005())
    const again = await sql<{ stages: unknown }[]>`SELECT signer_stages AS stages FROM finance.finanzordnung_profile`
    expect(again[0]!.stages).toEqual(STAGES)
  })

  async function seedActivePlan(): Promise<number> {
    const fy = await sql<{ id: string }[]>`
      INSERT INTO finance.fiscal_year (name, start_date, end_date)
      VALUES ('HH 2026', '2026-01-01', '2026-12-31') RETURNING id`
    const fu = await sql<{ id: string }[]>`
      INSERT INTO finance.finance_unit (org_unit_id, kind, bookkeeping_mode, carry_over_rule)
      VALUES ('11111111-1111-4111-8111-111111111111', 'central', 'central', 'to_reserves') RETURNING id`
    const plan = await sql<{ id: string }[]>`
      INSERT INTO finance.budget_plan (fiscal_year_id, name, state)
      VALUES (${fy[0]!.id}, 'HH 2026', 'active') RETURNING id`
    await sql`INSERT INTO finance.budget_section (budget_plan_id, finance_unit_id) VALUES (${plan[0]!.id}, ${fu[0]!.id})`
    return Number(plan[0]!.id)
  }

  it('closeBudget persists budget_plan.statement as a jsonb OBJECT and returns an object', async () => {
    await seedProperProfile(sql)
    const planId = await seedActivePlan()
    const dto = await closeBudget(sql, SUPER, planId)
    expect(typeof dto).toBe('object')
    expect(dto).toHaveProperty('meta')
    expect((dto as unknown as { meta: { budget_plan_id: number } }).meta.budget_plan_id).toBe(planId)
    const t = await sql<{ t: string }[]>`SELECT jsonb_typeof(statement) AS t FROM finance.budget_plan WHERE id = ${planId}`
    expect(t[0]!.t).toBe('object')
  })

  it('getBudgetStatement returns an object for a closed plan whose statement is double-encoded (legacy row)', async () => {
    const planId = await seedActivePlan()
    const stmt = { meta: { budget_plan_id: planId }, titel_actuals: [], carry_over: null }
    await sql.unsafe(`UPDATE finance.budget_plan SET state = 'closed', closed_at = now(), statement = $1 WHERE id = $2`, [
      JSON.stringify(stmt),
      planId,
    ])
    const raw = await sql<{ t: string }[]>`SELECT jsonb_typeof(statement) AS t FROM finance.budget_plan WHERE id = ${planId}`
    expect(raw[0]!.t).toBe('string')
    const dto = await getBudgetStatement(sql, planId, SUPER)
    expect(dto).toHaveProperty('meta')
    expect((dto as unknown as { titel_actuals: unknown }).titel_actuals).toEqual([])
    expect(dto).not.toHaveProperty('0')
  })
})
