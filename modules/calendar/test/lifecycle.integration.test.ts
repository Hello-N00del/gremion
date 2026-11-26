// modules/calendar/test/lifecycle.integration.test.ts
//
// End to end with the REAL module lifecycle (@gremion/tenant-store/lifecycle), against a scratch Postgres:
// the calendar leaf stores a customer's calendar in the database the lifecycle owns.
//
//   1. gremion_platform is migrated on the scratch server; plt.module / plt.module_version rows for
//      calendar 1.0.0 are seeded (the registry loads them for real in production).
//   2. enableModule(A, calendar) creates t_<A>__calendar OWNER m_calendar, migrates it as m_calendar and
//      grants DML to m_calendar_app. The enable gate is an allow fixture that lives in this file only.
//   3. The leaf writes and reads through its own code (the HTTP routes over storeFor) as m_calendar_app:
//      create (event + outbox row), read, list.
//   4. ROLE proof: pg_stat_activity for t_<A>__calendar shows backends, every one of them m_calendar_app.
//      NAME proof: the rows are in t_<A>__calendar and in no calendar_<slug> database.
//   5. disableModule(A, calendar) exports the database (pg_dump inside the scratch container): the export
//      CONTAINS the event the leaf wrote (pg_restore reads it back), the database is blocked (module
//      Karenz), and the very next request answers 404 tenant_not_provisioned on every route.
//   6. enableModule again (within the 30 days) unblocks it: the leaf serves the same event again.
// A second customer, B, is enabled too and never sees A's rows.
//
// The module server is the same scratch container as the platform database (the tenant-store lifecycle
// harness layout, reproduced here, not imported). Needs CALENDAR_TEST_PG_URL and
// CALENDAR_TEST_PG_CONTAINER (the container running it: pg_dump / pg_restore run inside it).
import { randomBytes, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'
import postgres from 'postgres'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  disableModule,
  enableModule,
  migratePlatform,
  pgDumpExporter,
  type EnableGate,
  type LifecycleDeps,
  type LifecycleModule,
  type ModuleServer,
} from '@gremion/tenant-store/lifecycle'
import { createServer } from '../src/http/server.ts'
import { buildApiRoutes } from '../src/http/routes.ts'
import { storeFor, _resetTenantStoreForTests, type TenantRef } from '../src/tenant-store.ts'
import { requireEphemeralTestPgUrl, assertSafeTestEnv } from './support/pg-test-guard.ts'
import { FIXTURE_DB_PATTERN, fixtureDb, fixtureId } from './support/scratch-pg.ts'

const TEST_PG_URL = requireEphemeralTestPgUrl()
const TEST_DB_PREFIX = 'calendar_test_'
assertSafeTestEnv(TEST_PG_URL, TEST_DB_PREFIX)

const SECRET = 'lifecycle-secret'
const PLATFORM_DB = 'gremion_platform'
const MODULE_SERVICE = 'calendar-postgres'
const APP_ROLE = 'm_calendar_app'
const OWNER_ROLE = 'm_calendar'
const APP_PASSWORD = randomBytes(24).toString('base64url')
const OPERATOR = { kind: 'operator' as const, id: randomUUID() }

const A: TenantRef = { id: fixtureId('0000000a11fe'), slug: 'life-a' }
const B: TenantRef = { id: fixtureId('0000000b11fe'), slug: 'life-b' }

const CALENDAR_DIR = fileURLToPath(new URL('../', import.meta.url))
/** Inside the module; .scratch/ is gitignored. */
const EXPORT_DIR = fileURLToPath(new URL(`../.scratch/exports/${process.pid}/`, import.meta.url))

/** pg_dump / pg_restore run INSIDE the scratch container (the server's own major). */
function scratchContainer(): string {
  const name = process.env.CALENDAR_TEST_PG_CONTAINER
  if (!name || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name)) {
    throw new Error('[lifecycle] CALENDAR_TEST_PG_CONTAINER (the scratch container running CALENDAR_TEST_PG_URL) is REQUIRED: disableModule exports with pg_dump inside it')
  }
  return name
}

/**
 * The lifecycle runs against the shipped module.json as it is: it declares the database on
 * calendar-postgres and the export under rp-cal-module-data, so a drift between that file and what
 * enableModule and disableModule need to create, migrate, export and block t_<tenant>__calendar is red
 * here. Nothing is overridden.
 */
const moduleJson = JSON.parse(readFileSync(new URL('../module.json', import.meta.url), 'utf8')) as LifecycleModule['moduleJson']
const calendarModule: LifecycleModule = { id: 'calendar', dir: CALENDAR_DIR, moduleJson }

function urlFor(db: string, user?: string, password?: string): string {
  const u = new URL(TEST_PG_URL)
  u.pathname = `/${db}`
  if (user !== undefined) {
    u.username = user
    u.password = encodeURIComponent(password ?? '')
  }
  return u.toString()
}

/** Test-only allow fixture for the level-1 gate. */
const allowGate: EnableGate = async (_tenantId, moduleKey) => {
  // the enablement's isolation reference is a foreign key (every new row is checked): mint a real passing row
  const [r] = await platform<{ id: string }[]>`
    INSERT INTO plt.isolation_test_result (module_id, test_kind, passed, run_at, evidence_ref, release_tip_sha)
    SELECT module_id, 'cross_customer', true, now(), 'scratch-fixture:calendar-lifecycle', ${'a'.repeat(40)}
      FROM plt.module WHERE module_key = ${moduleKey}
    RETURNING isolation_test_result_id::text AS id`
  if (!r) throw new Error(`[lifecycle] no plt.module row for ${moduleKey}`)
  return { isolationTestResultId: r.id, dpiaDecisionId: randomUUID() }
}

let admin: postgres.Sql<{}>
let platform: postgres.Sql<{}>
const pools: postgres.Sql<{}>[] = []
let deps: LifecycleDeps
let server: ReturnType<typeof createServer>
let base: string

const OPTS = { pgUrl: TEST_PG_URL, dbPrefix: TEST_DB_PREFIX, moduleUrl: urlFor('postgres', APP_ROLE, APP_PASSWORD) }

async function dropFixtures(): Promise<void> {
  const rows = await admin<{ datname: string }[]>`SELECT datname FROM pg_database WHERE datname ~ ${FIXTURE_DB_PATTERN} OR datname LIKE 'calendar_test_%'`
  for (const { datname } of rows) await admin.unsafe(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`)
  await admin.unsafe(`DROP ROLE IF EXISTS ${APP_ROLE}`)
  await admin.unsafe(`DROP ROLE IF EXISTS ${OWNER_ROLE}`)
}

beforeAll(async () => {
  const container = scratchContainer()
  admin = postgres(TEST_PG_URL, { max: 2, prepare: false, onnotice: () => {} })
  await dropFixtures()
  await admin.unsafe(`DROP DATABASE IF EXISTS ${PLATFORM_DB} WITH (FORCE)`)
  await admin.unsafe(`CREATE DATABASE ${PLATFORM_DB}`)
  platform = postgres(urlFor(PLATFORM_DB), { max: 3, prepare: false, onnotice: () => {} })
  await migratePlatform(platform, { releaseRef: 'dist-v0.0.1', log: () => {} })
  await platform`
    INSERT INTO plt.module (module_key, name, owning_context_code, toggleable, created_by_kind, updated_by_kind)
    VALUES ('calendar', 'calendar', 'cal', true, 'system', 'system')`
  await platform`
    INSERT INTO plt.module_version (module_id, semver, retention_profile_default_id, created_by_kind, updated_by_kind)
    SELECT module_id, ${calendarModule.moduleJson.runtime.version}, 'rp-cal-module-data', 'system', 'system' FROM plt.module WHERE module_key = 'calendar'`

  const moduleServer: ModuleServer = {
    admin,
    open(database, options) {
      const sql = postgres(urlFor(database), {
        max: 2,
        prepare: false,
        onnotice: () => {},
        ...(options?.role ? { connection: { options: `-c role=${options.role}` } } : {}),
      })
      pools.push(sql)
      return sql
    },
  }
  deps = {
    platform,
    server: (service) => {
      if (service !== MODULE_SERVICE) throw new Error(`[lifecycle] no module server ${service}`)
      return moduleServer
    },
    enableGate: allowGate,
    secrets: { appPassword: () => APP_PASSWORD },
    exporter: pgDumpExporter({
      pgDump: ['docker', 'exec', '-i', container, 'pg_dump'],
      pgRestore: ['docker', 'exec', '-i', container, 'pg_restore'],
      connection: (t) => {
        if (t.service !== MODULE_SERVICE) throw new Error(`[lifecycle] no container for ${t.service}`)
        return { args: ['-U', 'postgres', '-d', t.database] }
      },
    }),
    exportDir: EXPORT_DIR,
    releaseRef: 'dist-v0.0.1',
    log: () => {},
  }

  // The leaf, through its own routes and its own storeFor, as the module's app role.
  server = createServer({ secret: SECRET, routes: buildApiRoutes((tenant) => storeFor(tenant, OPTS)) })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 60_000)

afterAll(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  await _resetTenantStoreForTests()
  await Promise.all(pools.map((p) => p.end({ timeout: 5 }).catch(() => {})))
  await platform?.end({ timeout: 5 })
  if (admin) {
    await dropFixtures()
    await admin.unsafe(`DROP DATABASE IF EXISTS ${PLATFORM_DB} WITH (FORCE)`)
    await admin.end({ timeout: 5 })
  }
  rmSync(EXPORT_DIR, { recursive: true, force: true })
}, 60_000)

const headers = (t: TenantRef): Record<string, string> => ({
  'x-internal-auth': SECRET,
  'x-tenant-id': t.id,
  'x-tenant-slug': t.slug,
  'content-type': 'application/json',
})

async function call(t: TenantRef, method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${base}${path}`, { method, headers: headers(t), ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** The schema gate's verdict cache (packages/tenant-store schema-gate default TTL). */
const GATE_TTL_MS = 5000

const EVENT = {
  title: 'Lifecycle-Probe',
  startAt: '2030-06-01T10:00:00.000Z',
  endAt: '2030-06-01T11:00:00.000Z',
  createdBy: 'lifecycle',
}

describe('calendar leaf on the real lifecycle', () => {
  it('enable -> the leaf writes into t_<tenant>__calendar as m_calendar_app -> disable exports those rows and blocks -> the very next request is 404', async () => {
    const dbA = fixtureDb(A.id)
    const dbB = fixtureDb(B.id)

    // ── enable both customers ────────────────────────────────────────────────
    const enabledA = await enableModule(A.id, calendarModule, OPERATOR, deps)
    expect(enabledA).toMatchObject({ database: dbA, created: true, noop: false })
    expect(enabledA.applied).toEqual(['001_init.sql', '002_add_is_public.sql', '003_holiday_unique.sql'])
    await enableModule(B.id, calendarModule, OPERATOR, deps)

    // ── the leaf, through its routes: create (event + outbox row), read, list ─
    const created = await call(A, 'POST', '/api/v1/events', EVENT)
    expect(created.status, `POST /api/v1/events answered ${created.status} ${JSON.stringify(created.body)}`).toBe(201)
    const eventId = (created.body as { id: string }).id
    expect((await call(A, 'GET', `/api/v1/events/${eventId}`)).status).toBe(200)
    const listed = await call(A, 'GET', '/api/v1/events')
    expect(listed.status).toBe(200)
    expect(JSON.stringify(listed.body)).toContain(EVENT.title)
    expect((await call(B, 'POST', '/api/v1/events', { ...EVENT, title: 'Probe-B' })).status).toBe(201)
    expect(JSON.stringify((await call(B, 'GET', '/api/v1/events')).body)).not.toContain(EVENT.title)

    // ── NAME proof: the rows are in the lifecycle database, in no calendar_<slug> database ──
    const direct = postgres(urlFor(dbA), { max: 1, prepare: false })
    const aRows = await (async () => {
      try {
        const events = await direct<{ title: string }[]>`SELECT title FROM calendar_events`
        const outbox = await direct<{ n: string }[]>`SELECT count(*) AS n FROM outbox`
        return { events, outbox: Number(outbox[0]!.n) }
      } finally {
        // closed before the role proof below: its backend would be a superuser one
        await direct.end({ timeout: 5 })
      }
    })()
    expect(aRows.events.map((e) => e.title)).toEqual([EVENT.title])
    expect(aRows.outbox).toBe(1)
    const legacy = await admin<{ datname: string }[]>`SELECT datname FROM pg_database WHERE datname LIKE ${TEST_DB_PREFIX + 'life-%'}`
    expect(legacy).toEqual([])

    // ── ROLE proof ───────────────────────────────────────────────────────────
    const backends = await admin<{ usename: string }[]>`SELECT usename FROM pg_stat_activity WHERE datname = ${dbA}`
    expect(backends.length, `no backend on ${dbA}`).toBeGreaterThan(0)
    expect([...new Set(backends.map((b) => b.usename))]).toEqual([APP_ROLE])

    // ── disable: the export holds what the leaf wrote ────────────────────────
    // Let the gate's verdict lapse, then refresh it with one request, so the post-disable request runs
    // on a CACHED ok verdict (and a warm pool) - the case the query-failure mapping exists for.
    await sleep(GATE_TTL_MS + 200)
    const t0 = Date.now()
    expect((await call(A, 'GET', '/api/v1/events')).status).toBe(200)
    const disabled = await disableModule(A.id, calendarModule, OPERATOR, deps)
    // module Karenz: a switch-off blocks the database for 30 days instead of dropping it
    expect(disabled).toMatchObject({ database: dbA, dropped: false, blocked: true, noop: false })
    expect(disabled.export?.bytes).toBeGreaterThan(0)
    const restored = spawnSync(
      'docker',
      ['exec', '-i', scratchContainer(), 'pg_restore', '--data-only', '--table=calendar_events', '-f', '-'],
      { input: readFileSync(disabled.export!.path), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    )
    expect(restored.status, restored.stderr).toBe(0)
    expect(restored.stdout, 'the export of t_<tenant>__calendar must contain the event the leaf wrote').toContain(EVENT.title)
    expect(await admin<{ datname: string }[]>`SELECT datname FROM pg_database WHERE datname = ${dbA}`).toHaveLength(1)
    const [canConnect] = await admin<{ can: boolean }[]>`SELECT has_database_privilege(${APP_ROLE}, ${dbA}, 'CONNECT') AS can`
    expect(canConnect?.can).toBe(false)

    // ── the very next request, on every route, is 404 ────────────────────────
    const firstAt = Date.now()
    const after = [
      await call(A, 'GET', '/api/v1/events'),
      await call(A, 'GET', `/api/v1/events/${eventId}`),
      await call(A, 'GET', '/api/v1/event-types'),
      await call(A, 'POST', '/api/v1/events', EVENT),
      await call(A, 'DELETE', `/api/v1/events/${eventId}`),
    ]
    expect(firstAt - t0, 'the disable outlasted the gate TTL: the cached-verdict path was not exercised').toBeLessThan(GATE_TTL_MS)
    expect(after.map((r) => r.status)).toEqual([404, 404, 404, 404, 404])
    for (const r of after) expect(r.body).toEqual({ success: false, error: 'tenant_not_provisioned' })
    // B is untouched
    expect((await call(B, 'GET', '/api/v1/events')).status).toBe(200)

    // ── switch it on again within the 30 days: the same rows are back ─────────
    await sleep(GATE_TTL_MS + 200)
    const again = await enableModule(A.id, calendarModule, OPERATOR, deps)
    expect(again).toMatchObject({ database: dbA, noop: false })
    const back = await call(A, 'GET', `/api/v1/events/${eventId}`)
    expect(back.status).toBe(200)
    expect((back.body as { title: string }).title).toBe(EVENT.title)
    expect(dbB).not.toBe(dbA)
  }, 120_000)
})
