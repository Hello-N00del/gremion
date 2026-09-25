/**
 * Integration tests for the #383 Lane E1 org-unit mirror — the REAL Postgres
 * sqlOrgUnitMirrorStore (migration 002 applied via storeFor) + the project/sub-org
 * read ops resolving against finance.org_unit_mirror end-to-end.
 *
 * Proves against real SQL what the unit doubles assert in JS:
 *   - the ON CONFLICT … WHERE source_occurred_at guard (per-aggregate ordering),
 *   - event_consumption idempotency,
 *   - the tombstone (a stale upsert cannot resurrect a deleted row),
 *   - the reads JOIN the mirror for ou.name / ou.kind (no kernel round-trip).
 *
 * Fail-closed guard (same as backfill.integration.test.ts): FINANCE_TEST_PG_URL on a
 * NON-5432 port + the finance_test_ db prefix. This suite CREATEs/DROPs databases.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import {
  storeFor,
  _resetTenantStoreForTests,
  type TenantRef,
  type Sql,
} from '../src/tenant-store.ts'
import { sqlOrgUnitMirrorStore, type OrgUnitMirrorOp } from '../src/org-unit-consumer.ts'
import { listSubOrgs, listSubOrgTypes, getProject } from '../src/store/index.ts'

const TEST_PG_URL = requireEphemeralTestPgUrl()
const TEST_DB_PREFIX = 'finance_test_'

function requireEphemeralTestPgUrl(): string {
  const url = process.env.FINANCE_TEST_PG_URL
  if (!url) {
    throw new Error(
      '[fin-test-guard] FINANCE_TEST_PG_URL is REQUIRED — refusing to default to localhost:5432 ' +
        '(the LIVE staging Postgres). Start an ephemeral throwaway container on a NON-5432 port, e.g.:\n' +
        '  docker run --rm -d -p 127.0.0.1:55434:5432 -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16-alpine\n' +
        '  export FINANCE_TEST_PG_URL=postgres://postgres@localhost:55434/postgres',
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
    throw new Error(`[fin-test-guard] SAFETY VIOLATION: port "${parsed.port || '(implicit 5432)'}" is live — refusing.`)
  }
  if (!dbPrefix.startsWith('finance_test_')) {
    throw new Error(`[fin-test-guard] SAFETY VIOLATION: dbPrefix "${dbPrefix}" — refusing.`)
  }
}
assertSafeTestEnv(TEST_PG_URL, TEST_DB_PREFIX)

const TENANT: TenantRef = { id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', slug: 'mirror' }
const OU_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const OU_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const T1 = '2026-01-01T00:00:00.000Z'
const T2 = '2026-01-02T00:00:00.000Z'
const T3 = '2026-01-03T00:00:00.000Z'
const AUDITOR = { isAuditor: true, isSuperuser: false, scopedOrgUnitIds: [] as string[] }

let admin: ReturnType<typeof postgres>

async function dropTestDbs(): Promise<void> {
  const rows = await admin<{ datname: string }[]>`SELECT datname FROM pg_database WHERE datname LIKE 'finance_test_%'`
  for (const { datname } of rows) {
    await admin.unsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${datname}' AND pid <> pg_backend_pid()`,
    )
    await admin.unsafe(`DROP DATABASE IF EXISTS "${datname}"`)
  }
}

async function fresh(): Promise<Sql> {
  await _resetTenantStoreForTests()
  await dropTestDbs()
  return storeFor(TENANT, { pgUrl: TEST_PG_URL, dbPrefix: TEST_DB_PREFIX })
}

function upsert(id: string, name: string, kind: string, occurredAt: string, eventId: string): OrgUnitMirrorOp {
  return { type: 'upsert', eventId, occurredAt, id, name, kind, parentId: null }
}
function del(id: string, occurredAt: string, eventId: string): OrgUnitMirrorOp {
  return { type: 'delete', eventId, occurredAt, id }
}
async function mirrorRow(sql: Sql, id: string) {
  const rows = await sql<{ name: string; kind: string; deleted: boolean; source_occurred_at: Date }[]>`
    SELECT name, kind, deleted, source_occurred_at FROM finance.org_unit_mirror WHERE id = ${id}`
  return rows[0] ?? null
}

beforeAll(async () => {
  admin = postgres(TEST_PG_URL, { max: 1, prepare: false })
})
afterAll(async () => {
  await _resetTenantStoreForTests()
  await dropTestDbs()
  await admin.end()
})

describe('sqlOrgUnitMirrorStore.apply — real Postgres', () => {
  let sql: Sql
  beforeEach(async () => {
    sql = await fresh()
  })

  it('upsert inserts a live mirror row', async () => {
    const store = sqlOrgUnitMirrorStore(sql)
    expect(await store.apply(upsert(OU_A, 'StuRa', 'council', T1, 'e1'))).toBe('applied')
    expect(await mirrorRow(sql, OU_A)).toMatchObject({ name: 'StuRa', kind: 'council', deleted: false })
  })

  it('is idempotent: the same eventId twice applies once (event_consumption)', async () => {
    const store = sqlOrgUnitMirrorStore(sql)
    const op = upsert(OU_A, 'StuRa', 'council', T1, 'dup-evt')
    expect(await store.apply(op)).toBe('applied')
    expect(await store.apply(op)).toBe('duplicate')
    const ec = await sql<{ c: string }[]>`SELECT COUNT(*) AS c FROM finance.event_consumption WHERE event_id = ${'dup-evt'}`
    expect(Number(ec[0]!.c)).toBe(1)
  })

  it('drops a stale out-of-order upsert (t2 then t1 → mirror stays at t2)', async () => {
    const store = sqlOrgUnitMirrorStore(sql)
    expect(await store.apply(upsert(OU_A, 'NEW', 'council', T2, 'e2'))).toBe('applied')
    expect(await store.apply(upsert(OU_A, 'OLD', 'committee', T1, 'e1'))).toBe('stale')
    expect(await mirrorRow(sql, OU_A)).toMatchObject({ name: 'NEW', kind: 'council' })
  })

  it('a delete tombstones; a later stale upsert cannot resurrect it', async () => {
    const store = sqlOrgUnitMirrorStore(sql)
    expect(await store.apply(del(OU_A, T3, 'ed'))).toBe('applied')
    expect(await mirrorRow(sql, OU_A)).toMatchObject({ deleted: true })
    expect(await store.apply(upsert(OU_A, 'ZOMBIE', 'council', T2, 'eu'))).toBe('stale')
    expect(await mirrorRow(sql, OU_A)).toMatchObject({ deleted: true })
  })

  it('a newer upsert over a tombstone revives the row (deleted=false)', async () => {
    const store = sqlOrgUnitMirrorStore(sql)
    await store.apply(del(OU_A, T1, 'ed'))
    expect(await store.apply(upsert(OU_A, 'REBORN', 'group', T2, 'eu'))).toBe('applied')
    expect(await mirrorRow(sql, OU_A)).toMatchObject({ name: 'REBORN', kind: 'group', deleted: false })
  })
})

describe('reads resolve against the mirror end-to-end', () => {
  it('listSubOrgs / listSubOrgTypes / getProject JOIN finance.org_unit_mirror', async () => {
    const sql = await fresh()
    const store = sqlOrgUnitMirrorStore(sql)
    await store.apply(upsert(OU_A, 'StuRa', 'council', T1, 'e-a'))
    await store.apply(upsert(OU_B, 'Fachschaft Info', 'committee', T1, 'e-b'))

    // Seed the leaf finance_unit + project rows that reference the mirrored org units.
    await sql`INSERT INTO finance.finance_unit (org_unit_id, kind, bookkeeping_mode, carry_over_rule)
              VALUES (${OU_A}, 'central', 'central', 'to_reserves'), (${OU_B}, 'standard', 'own', 'carry_forward')`
    const proj = await sql<{ id: string }[]>`
      INSERT INTO finance.project (org_unit_id, type, name) VALUES (${OU_B}, 'internal', 'Ersti') RETURNING id`

    const subOrgs = await listSubOrgs(sql, AUDITOR)
    expect(subOrgs.map((s) => s.name).sort()).toEqual(['Fachschaft Info', 'StuRa'])
    expect(subOrgs.find((s) => s.name === 'Fachschaft Info')).toMatchObject({ type: 'committee', type_id: 2 })

    const types = await listSubOrgTypes(sql)
    expect(types.map((t) => t.name).sort()).toEqual(['committee', 'council'])

    const detail = await getProject(sql, AUDITOR, Number(proj[0]!.id))
    expect(detail).toMatchObject({ org: 'Fachschaft Info', expenses_count: 0 })
  })

  it('a tombstoned org unit drops out of the sub-org read (its finance pair is gone)', async () => {
    const sql = await fresh()
    const store = sqlOrgUnitMirrorStore(sql)
    await store.apply(upsert(OU_A, 'StuRa', 'council', T1, 'e-a'))
    await sql`INSERT INTO finance.finance_unit (org_unit_id, kind, bookkeeping_mode, carry_over_rule)
              VALUES (${OU_A}, 'central', 'central', 'to_reserves')`
    // Delete the finance pair + tombstone the mirror row (the sub-org saga order).
    await sql`DELETE FROM finance.finance_unit WHERE org_unit_id = ${OU_A}`
    await store.apply(del(OU_A, T2, 'e-del'))
    expect(await listSubOrgs(sql, AUDITOR)).toEqual([])
    expect(await listSubOrgTypes(sql)).toEqual([])
  })
})
