// modules/board/test/lifecycle.integration.test.ts
//
// R29-BOARD-STORE-K A8: end to end with the REAL lifecycle (TASK-021).
//   1. gremion_platform is migrated from PLATFORM_MIGRATIONS_DIR on the scratch
//      server; plt.module / plt.module_version rows for board 1.0.0 are seeded
//      (TASK-021 Q2; TASK-077's registry loads them for real).
//   2. enableModule(A, board) creates t_<A>__board OWNER m_board, migrates it as
//      m_board and grants DML to m_board_app. The enable gate is an allow
//      fixture that lives in this file only (TASK-044 implements the real one).
//   3. The leaf is built with buildApp({GREMION_BOARD_PG_URL: <m_board_app url>})
//      and answers 2xx on all nine routes for A.
//   4. Role proof: pg_stat_activity for t_<A>__board shows backends, every one
//      of them m_board_app — the lifecycle grants are enough, and the leaf does
//      not run as a superuser.
//   5. disableModule(A, board) exports (pg_dump inside the scratch container),
//      then drops WITH (FORCE); the VERY NEXT request — no sleep, the gate's ok
//      verdict still cached — answers 404 tenant_not_provisioned on every route
//      (the query-time mapping, §3.2).
// The module server is the same scratch container as the platform database
// (the tenant-store lcfix harness layout, reproduced here, not imported).
import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
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
import { buildApp } from '../src/app.ts'
import { leafRequest } from './isolation/leaf-api.ts'
import {
  connectAdmin,
  connectScratchDb,
  databaseNames,
  dropScratchDb,
  scratchServerUrlAs,
  tenantBoardDb,
  type ScratchSql,
} from './support/scratch-pg.ts'
import { everyRouteCall } from './support/route-calls.ts'
import { TENANT_A } from './support/tenants.ts'

const SECRET = 'r29bk-lifecycle-secret'
const PLATFORM_DB = 'gremion_platform'
const MODULE_SERVICE = 'board-postgres'
const APP_ROLE = 'm_board_app'
const OWNER_ROLE = 'm_board'
const APP_PASSWORD = randomBytes(24).toString('base64url')
const OPERATOR = { kind: 'operator' as const, id: randomUUID() }
/** The gate's verdict cache (schema-gate.ts default TTL). */
const GATE_TTL_MS = 5000

const BOARD_DIR = fileURLToPath(new URL('../', import.meta.url))
/** Inside the module (the module-source scan refuses a path leaving it); .scratch/ is gitignored. */
const EXPORT_DIR = fileURLToPath(new URL(`../.scratch/exports/${process.pid}/`, import.meta.url))

/** pg_dump / pg_restore run INSIDE the scratch container (PostgreSQL 18, the server's own major). */
function scratchContainer(): string {
  const name = process.env.BOARD_TEST_PG_CONTAINER
  if (!name || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name)) {
    throw new Error('[lifecycle] BOARD_TEST_PG_CONTAINER (the scratch container running BOARD_TEST_PG_URL) is REQUIRED: disableModule exports with pg_dump inside it')
  }
  return name
}

const boardModule: LifecycleModule = {
  id: 'board',
  dir: BOARD_DIR,
  moduleJson: JSON.parse(readFileSync(new URL('../module.json', import.meta.url), 'utf8')) as LifecycleModule['moduleJson'],
}

/** Test-only allow fixture for the level-1 gate (TASK-044 implements the real one). */
const allowGate: EnableGate = () => ({ isolationTestResultId: randomUUID(), dpiaDecisionId: randomUUID() })

let admin: ScratchSql
let platform: ScratchSql
const pools: ScratchSql[] = []
let deps: LifecycleDeps

async function dropRoles(): Promise<void> {
  await admin.unsafe(`DROP ROLE IF EXISTS ${APP_ROLE}`)
  await admin.unsafe(`DROP ROLE IF EXISTS ${OWNER_ROLE}`)
}

beforeAll(async () => {
  const container = scratchContainer()
  admin = connectAdmin()
  await dropScratchDb(admin, tenantBoardDb(TENANT_A.id))
  await dropRoles()
  await admin.unsafe(`DROP DATABASE IF EXISTS ${PLATFORM_DB} WITH (FORCE)`)
  await admin.unsafe(`CREATE DATABASE ${PLATFORM_DB}`)
  platform = connectScratchDb(PLATFORM_DB, { max: 3 })
  // TASK-075: every run names its release (ledger release_ref)
  await migratePlatform(platform, { releaseRef: 'dist-v0.0.1', log: () => {} })
  await platform`
    INSERT INTO plt.module (module_key, name, owning_context_code, toggleable, created_by_kind, updated_by_kind)
    VALUES ('board', 'board', 'brd', true, 'system', 'system')`
  await platform`
    INSERT INTO plt.module_version (module_id, semver, retention_profile_default_id, created_by_kind, updated_by_kind)
    SELECT module_id, ${boardModule.moduleJson.runtime.version}, 'rp-brd-module-data', 'system', 'system' FROM plt.module WHERE module_key = 'board'`

  const server: ModuleServer = {
    admin,
    open(database, options) {
      const sql = connectScratchDb(database, { max: 2, ...(options?.role ? { role: options.role } : {}) })
      pools.push(sql)
      return sql
    },
  }
  deps = {
    platform,
    server: (service) => {
      if (service !== MODULE_SERVICE) throw new Error(`[lifecycle] no module server ${service}`)
      return server
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
    // TASK-075: enable refuses a module with a database without the release it ships
    releaseRef: 'dist-v0.0.1',
    log: () => {},
  }
}, 60_000)

afterAll(async () => {
  await Promise.all(pools.map((p) => p.end({ timeout: 5 }).catch(() => {})))
  await platform?.end({ timeout: 5 })
  if (admin) {
    await dropScratchDb(admin, tenantBoardDb(TENANT_A.id))
    await dropRoles()
    await admin.unsafe(`DROP DATABASE IF EXISTS ${PLATFORM_DB} WITH (FORCE)`)
    await admin.end({ timeout: 5 })
  }
  rmSync(EXPORT_DIR, { recursive: true, force: true })
}, 60_000)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('board leaf on the real lifecycle (A8)', () => {
  it('enable -> 2xx on all nine routes as m_board_app -> disable -> the very next request is 404 on every route', async () => {
    const dbA = tenantBoardDb(TENANT_A.id)

    // ── enable ───────────────────────────────────────────────────────────────
    const enabled = await enableModule(TENANT_A.id, boardModule, OPERATOR, deps)
    expect(enabled).toMatchObject({ database: dbA, created: true, applied: ['001_init.sql'], noop: false })

    const app = buildApp({ GREMION_BOARD_PG_URL: scratchServerUrlAs(APP_ROLE, APP_PASSWORD), INTERNAL_BOARD_SECRET: SECRET })
    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve))
    try {
      const call = (method: string, path: string, body?: unknown) => leafRequest(app.server, SECRET, TENANT_A, method, path, body)
      const statuses: Record<string, number> = {}
      const orgUnitId = randomUUID()
      const actionItemId = randomUUID()

      // ── all nine routes, 2xx, as A ─────────────────────────────────────────
      const created = await call('POST', '/api/v1/boards', { orgUnitId, name: 'Vorstand', stacks: ['To Do', 'Done'] })
      statuses['POST /api/v1/boards'] = created.status
      expect(created.status, `POST /api/v1/boards answered ${created.status} ${JSON.stringify(created.body)}`).toBe(201)
      const { board, stacks } = created.body as { board: { id: string }; stacks: { id: string }[] }
      statuses['GET /api/v1/boards'] = (await call('GET', `/api/v1/boards?orgUnitId=${orgUnitId}`)).status
      statuses['GET /api/v1/boards/:id'] = (await call('GET', `/api/v1/boards/${board.id}`)).status
      statuses['GET /api/v1/boards/:id/deck'] = (await call('GET', `/api/v1/boards/${board.id}/deck`)).status
      statuses['POST /api/v1/boards/:id/stacks'] = (await call('POST', `/api/v1/boards/${board.id}/stacks`, { name: 'Review', order: 2 })).status
      const card = await call('POST', '/api/v1/cards', { stackId: stacks[0]!.id, title: 'Card', createdBy: 'lifecycle' })
      statuses['POST /api/v1/cards'] = card.status
      const cardId = (card.body as { id: string }).id
      statuses['PATCH /api/v1/cards/:id/move'] = (await call('PATCH', `/api/v1/cards/${cardId}/move`, { stackId: stacks[1]!.id, order: 0 })).status
      statuses['POST /api/v1/boards/:id/promote'] = (
        await call('POST', `/api/v1/boards/${board.id}/promote`, {
          item: { id: actionItemId, text: 'Promoted', assigneeKeycloakId: null, dueDate: null },
          createdBy: 'lifecycle',
        })
      ).status
      const promoted = await call('POST', '/api/v1/cards/promoted', { candidateIds: [actionItemId] })
      statuses['POST /api/v1/cards/promoted'] = promoted.status
      expect(promoted.body).toEqual({ data: [actionItemId] })
      expect(Object.keys(statuses)).toHaveLength(9)
      for (const [route, status] of Object.entries(statuses)) expect(status >= 200 && status < 300, `${route} answered ${status}`).toBe(true)

      // ── role proof ─────────────────────────────────────────────────────────
      const backends = await admin<{ usename: string }[]>`SELECT usename FROM pg_stat_activity WHERE datname = ${dbA}`
      expect(backends.length, `no backend on ${dbA}`).toBeGreaterThan(0)
      expect([...new Set(backends.map((b) => b.usename))]).toEqual([APP_ROLE])

      // ── disable, then the very next request ─────────────────────────────────
      // Let the gate's verdict lapse, then refresh it with one request, so the
      // post-disable request provably runs on a CACHED ok verdict.
      await sleep(GATE_TTL_MS + 200)
      const t0 = Date.now()
      expect((await call('GET', `/api/v1/boards?orgUnitId=${orgUnitId}`)).status).toBe(200)
      const disabled = await disableModule(TENANT_A.id, boardModule, OPERATOR, deps)
      expect(disabled).toMatchObject({ database: dbA, dropped: true, noop: false })
      expect(disabled.export?.bytes).toBeGreaterThan(0)
      expect(await databaseNames(admin)).not.toContain(dbA)

      const results: { route: string; status: number; body: unknown }[] = []
      const firstAt = Date.now()
      for (const c of everyRouteCall({ orgUnitId, boardId: board.id, stackId: stacks[0]!.id, cardId })) {
        const r = await call(c.method, c.path, c.body)
        results.push({ route: c.route, status: r.status, body: r.body })
      }
      expect(firstAt - t0, 'the disable outlasted the gate TTL: the cached-verdict path was not exercised').toBeLessThan(GATE_TTL_MS)
      expect(results).toEqual(
        everyRouteCall().map((c) => ({ route: c.route, status: 404, body: { success: false, error: 'tenant_not_provisioned' } })),
      )
    } finally {
      await app.close()
    }
  }, 60_000)
})
