// TDD 4 + 5 (Q1): a first request to a service executes no DDL, and a
// database behind its manifest answers 503 for THAT tenant only while its
// schema_migrations stays unchanged. Plus the UUIDv7 id read through the API.
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { isUuidV7, tenantModuleDbName, envResolveTarget } from '../../src/names.js'
import { checkSchemaCurrent, schemaGate } from '../../src/schema-gate.js'
import { createTenantStore } from '../../src/store.js'
import { runMigrations } from '../../src/runner.js'
import { assertNonProductionDbUrl, connect, ddlAttempts, ddlLog, resetWithProbe, serverUrl } from '../harness/db.js'
import { cleanupFixtures, copyFixture, FIXTURE_MIGRATIONS } from '../harness/migrations.js'
import { createFixtureService } from '../fixtures/service.js'

const quiet = { log: () => {} }

describe('the fixture service: schemaGate in front, openTenantDb behind, two tenants', () => {
  const { A, B } = inject('tenants')
  const dbA = tenantModuleDbName(A, 'fixture')
  const dbB = tenantModuleDbName(B, 'fixture')
  let a: ReturnType<typeof connect>
  let b: ReturnType<typeof connect>
  let base: string
  let stop: () => Promise<void>
  let bLedgerBefore: { n: number; last: string }
  let attemptsBefore: { a: number; b: number }
  let gate: ReturnType<typeof schemaGate>

  const bLedger = async () => {
    const [r] = await b<{ n: number; last: string }[]>`SELECT count(*)::int AS n, max(applied_at)::text AS last FROM public.schema_migrations`
    return r!
  }

  beforeAll(async () => {
    await resetWithProbe(dbA)
    await resetWithProbe(dbB)
    a = connect(dbA)
    b = connect(dbB)
    await runMigrations({ sql: a, dir: FIXTURE_MIGRATIONS, ...quiet })
    // B is one file behind the manifest.
    await runMigrations({ sql: b, dir: copyFixture({ only: ['001_init.sql', '002_item_state.sql'] }), ...quiet })
    // the probe saw the setup's migrations (it is live), then starts empty
    expect((await ddlLog(a)).length).toBeGreaterThan(0)
    expect((await ddlLog(b)).length).toBeGreaterThan(0)
    await a`TRUNCATE t020_probe.ddl_log`
    await b`TRUNCATE t020_probe.ddl_log`
    attemptsBefore = { a: await ddlAttempts(a), b: await ddlAttempts(b) }
    bLedgerBefore = await bLedger()

    const env = envResolveTarget({ GREMION_FIXTURE_PG_URL: serverUrl() })
    const store = createTenantStore({
      resolveTarget: (t, m) => {
        const target = env(t, m)
        assertNonProductionDbUrl(target.url)
        return target
      },
    })
    gate = schemaGate({ dir: FIXTURE_MIGRATIONS, openDb: (t) => store.openTenantDb(t, 'fixture'), retryAfterSeconds: 7, cacheTtlMs: 0, log: () => {} })
    const server = createFixtureService({ store, gate, tenants: new Set([A, B]) })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    stop = async () => {
      await new Promise<void>((r) => server.close(() => r()))
      await store.close()
    }
  })

  afterAll(async () => {
    await stop?.()
    await a?.end()
    await b?.end()
    cleanupFixtures()
    await resetWithProbe(dbA)
    await resetWithProbe(dbB)
  })

  it('TDD 4: the first request to each tenant executes no DDL (A served, B refused)', async () => {
    const r = await fetch(`${base}/t/${A}/items`)
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ tenant: A, database: dbA, items: 0 })
    expect((await fetch(`${base}/t/${B}/items`)).status).toBe(503)
    expect(await ddlLog(a)).toEqual([])
    expect(await ddlLog(b)).toEqual([])
    expect(await ddlAttempts(a)).toBe(attemptsBefore.a)
    expect(await ddlAttempts(b)).toBe(attemptsBefore.b)
  })

  it('TDD 5: B, one file behind, gets 503 with Retry-After; A still gets 200', async () => {
    for (let i = 0; i < 3; i++) {
      const rb = await fetch(`${base}/t/${B}/items`)
      expect(rb.status).toBe(503)
      expect(rb.headers.get('retry-after')).toBe('7')
      const body = await rb.text()
      expect(body).not.toContain(A)
      expect(body).not.toMatch(/\.sql/)
      const ra = await fetch(`${base}/t/${A}/items`)
      expect(ra.status).toBe(200)
    }
    // 503 because B is BEHIND — not because its database was unreachable
    expect(await gate.check(B)).toEqual({ ok: false, reason: 'behind', retryAfterSeconds: 7 })
  })

  it('TDD 5: B\'s schema_migrations count(*) and max(applied_at) are unchanged, and neither database gained DDL', async () => {
    expect(await bLedger()).toEqual(bLedgerBefore)
    expect(await ddlLog(b)).toEqual([])
    expect(await ddlLog(a)).toEqual([])
    expect(await ddlAttempts(b)).toBe(attemptsBefore.b)
    expect(await ddlAttempts(a)).toBe(attemptsBefore.a)
  })

  it('checkSchemaCurrent names the state and runs read-only: B behind by 003, A current', async () => {
    expect(await checkSchemaCurrent({ sql: b, dir: FIXTURE_MIGRATIONS })).toEqual({
      state: 'behind',
      pending: ['003_item_state_idx.sql'],
      unknown: [],
      mismatched: [],
    })
    expect((await checkSchemaCurrent({ sql: a, dir: FIXTURE_MIGRATIONS })).state).toBe('current')
    expect(await ddlLog(b)).toEqual([])
  })

  it('once the runner (not the service) brings B current, B is served', async () => {
    await runMigrations({ sql: b, dir: FIXTURE_MIGRATIONS, ...quiet })
    expect((await fetch(`${base}/t/${B}/items`)).status).toBe(200)
  })

  it('UUIDv7: the tenant id read through the API parses as UUIDv7 and matches the control registry', async () => {
    const body = (await (await fetch(`${base}/t/${A}/items`)).json()) as { tenant: string }
    expect(isUuidV7(body.tenant)).toBe(true)
    const ms = parseInt(body.tenant.replaceAll('-', '').slice(0, 12), 16)
    expect(Math.abs(Date.now() - ms)).toBeLessThan(60 * 60 * 1000)
    const control = connect('control', { max: 1 })
    try {
      const rows = await control<{ id: string }[]>`SELECT id::text FROM tenant WHERE slug = 't020-a'`
      expect(rows).toEqual([{ id: body.tenant }])
    } finally {
      await control.end()
    }
  })
})
