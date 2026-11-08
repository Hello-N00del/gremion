// TASK-084-a Task 4 (database half): migration 0001_gov_setup.sql applied to a
// fresh governance database as its owner role (DV1), then read back.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Sql } from '@gremion/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { dropGovernanceDatabase, ensureGovernanceDatabase, GOVERNANCE_LEDGER, governanceDbName, governanceRoles } from '../../src/lifecycle/governance.js'
import { openAsOwner } from '../../src/lifecycle/enable.js'
import type { ModuleServer } from '../../src/lifecycle/types.js'
import { runMigrations } from '../../src/runner.js'
import { admin as openAdmin, adminOn, connectAs, genPassword, uuidv7 } from '../harness/t084.js'

const REPO = fileURLToPath(new URL('../../../../', import.meta.url))
const DIR = join(REPO, 'services', 'governance', 'migrations')
const FILE = '0001_gov_setup.sql'
const FIXTURES = fileURLToPath(new URL('../fixtures/governance/', import.meta.url))
/** 4 plumbing tables (outbox, inbox, applied_aggregate_version, job) + the 19 part-2 tables. */
const FORCED_TABLES = 23

type Err = { code?: string; message?: string }
async function failure(p: PromiseLike<unknown>): Promise<Err | null> {
  try {
    await p
    return null
  } catch (e) {
    return e as Err
  }
}

describe('0001_gov_setup.sql on a fresh governance database', () => {
  let a: Sql
  const pools: Sql[] = []
  const X = uuidv7()
  const pw = genPassword()
  const roles = governanceRoles(X)
  const db = governanceDbName(X)
  let owner: Sql
  let app: Sql
  let first: Awaited<ReturnType<typeof runMigrations>>
  let second: Awaited<ReturnType<typeof runMigrations>>
  const server = (): ModuleServer => ({
    admin: a,
    open: (d, o) => {
      const p = adminOn(d, o?.role ? { role: o.role } : {})
      pools.push(p)
      return p
    },
  })

  beforeAll(async () => {
    a = openAdmin(3)
    await ensureGovernanceDatabase(server(), X, pw)
    owner = await openAsOwner(server(), db, roles.owner)
    first = await runMigrations({ sql: owner, dir: DIR, ledger: GOVERNANCE_LEDGER, releaseRef: 'dist-t084', log: () => {} })
    second = await runMigrations({ sql: owner, dir: DIR, ledger: GOVERNANCE_LEDGER, releaseRef: 'dist-t084', log: () => {} })
    app = connectAs(db, roles.app, pw)
  })

  afterAll(async () => {
    await app?.end({ timeout: 5 }).catch(() => {})
    await owner?.end({ timeout: 5 }).catch(() => {})
    await Promise.all(pools.map((p) => p.end({ timeout: 5 }).catch(() => {})))
    try {
      await dropGovernanceDatabase(server(), X)
    } catch (e) {
      console.error('[t084] drop failed', e)
    }
    await a?.end({ timeout: 5 }).catch(() => {})
  })

  it('applies once and the ledger carries the file sha256; a second run applies nothing', async () => {
    const bytes = readFileSync(join(DIR, FILE))
    expect(first.applied).toEqual([FILE])
    const rows = await owner<{ filename: string; sha256: string; phase: string; release_ref: string }[]>`
      SELECT filename, sha256, phase, release_ref FROM gov.schema_migration ORDER BY filename`
    expect(rows).toEqual([{ filename: FILE, sha256: createHash('sha256').update(bytes).digest('hex'), phase: 'expand', release_ref: 'dist-t084' }])
    expect(second.applied).toEqual([])
    expect(second.alreadyApplied).toBe(1)
  })

  it('the lock pins that sha256', () => {
    const lock = JSON.parse(readFileSync(join(REPO, 'scripts', 'migrations', 'applied.lock.json'), 'utf8')) as {
      chains: Record<string, { files: Record<string, string> }>
    }
    expect(lock.chains.governance?.files[FILE]).toBe(createHash('sha256').update(readFileSync(join(DIR, FILE))).digest('hex'))
  })

  it('every object of schema gov is owned by the customer owner role', async () => {
    const o = adminOn(db)
    pools.push(o)
    const bad = await o`SELECT c.relname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace JOIN pg_catalog.pg_roles r ON r.oid = c.relowner
                         WHERE n.nspname = 'gov' AND r.rolname <> ${roles.owner}`
    expect(bad).toEqual([])
  })

  describe('catalogue checks (each expects an empty list)', () => {
    let o: Sql
    beforeAll(() => {
      o = adminOn(db)
      pools.push(o)
    })
    it('(a) every foreign key has an index with the same leading columns', async () => {
      const rows = await o<{ conname: string }[]>`
        SELECT c.conname FROM pg_catalog.pg_constraint c
         WHERE c.contype = 'f' AND c.connamespace = 'gov'::regnamespace
           AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_index i
                            WHERE i.indrelid = c.conrelid
                              AND pg_catalog.array_to_string((i.indkey::int2[])[0:pg_catalog.cardinality(c.conkey) - 1], ',') = pg_catalog.array_to_string(c.conkey, ','))`
      expect(rows.map((r) => r.conname)).toEqual([])
    })
    it('(b) every table in gov except schema_migration has a COMMENT', async () => {
      const rows = await o<{ relname: string }[]>`
        SELECT c.relname FROM pg_catalog.pg_class c
         WHERE c.relnamespace = 'gov'::regnamespace AND c.relkind = 'r' AND c.relname <> 'schema_migration'
           AND pg_catalog.obj_description(c.oid, 'pg_class') IS NULL`
      expect(rows.map((r) => r.relname)).toEqual([])
    })
    it('(c) no constraint or index name is 60 bytes or longer', async () => {
      const rows = await o<{ n: string }[]>`
        SELECT conname::text AS n FROM pg_catalog.pg_constraint WHERE connamespace = 'gov'::regnamespace AND pg_catalog.octet_length(conname::text) >= 60
        UNION ALL
        SELECT c.relname::text FROM pg_catalog.pg_class c WHERE c.relnamespace = 'gov'::regnamespace AND c.relkind = 'i' AND pg_catalog.octet_length(c.relname::text) >= 60`
      expect(rows.map((r) => r.n)).toEqual([])
    })
    it('(d) every table with a customer_id column except database_binding has FORCE row level security and a policy', async () => {
      const rows = await o<{ relname: string }[]>`
        SELECT c.relname FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_attribute at ON at.attrelid = c.oid AND at.attname = 'customer_id' AND NOT at.attisdropped
         WHERE c.relnamespace = 'gov'::regnamespace AND c.relkind = 'r' AND c.relname <> 'database_binding'
           AND NOT (c.relrowsecurity AND c.relforcerowsecurity AND EXISTS (SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid = c.oid))`
      expect(rows.map((r) => r.relname)).toEqual([])
    })
    it(`(e) exactly ${FORCED_TABLES} tables have both flags (4 plumbing + 19 part-2 tables)`, async () => {
      const [r] = await o<{ n: string }[]>`
        SELECT count(*)::text AS n FROM pg_catalog.pg_class WHERE relnamespace = 'gov'::regnamespace AND relkind = 'r' AND relrowsecurity AND relforcerowsecurity`
      expect(Number(r?.n)).toBe(FORCED_TABLES)
    })
  })

  it('A5 RLS fails closed as g_X_app', async () => {
    const run = (guc: string | null, fn: (tx: Sql) => Promise<unknown>) =>
      app.begin(async (tx) => {
        if (guc !== null) await tx`SELECT set_config('gremion.customer_id', ${guc}, true)`
        return fn(tx as unknown as Sql)
      })
    const insertMeeting = (tx: Sql, customer: string, withRun: boolean) => tx`
      INSERT INTO gov.meeting (customer_id, body_id, title, scheduled_start, notice_period_days_snapshot, notice_due_at, created_by_kind, updated_by_kind, test_run_id)
      VALUES (${customer}, ${uuidv7()}, 'RLS probe', now() + interval '30 days', 14, now() + interval '10 days', 'system', 'system', ${withRun ? uuidv7() : null})`
    await run(X, (tx) => insertMeeting(tx, X, true))
    const count = async (guc: string | null) => Number(((await run(guc, (tx) => tx`SELECT count(*)::text AS n FROM gov.meeting`)) as { n: string }[])[0]?.n)
    expect(await count(null)).toBe(0)
    expect(await count(uuidv7())).toBe(0)
    expect(await count(X)).toBe(1)
    const foreign = await failure(run(X, (tx) => insertMeeting(tx, uuidv7(), false)))
    expect(foreign?.code).toBe('42501')
    console.info(`[t084] A5 foreign-customer INSERT: ${foreign?.message}`)
    const upd = await failure(run(X, (tx) => tx`UPDATE gov.quorum_check SET customer_id = customer_id`))
    const del = await failure(run(X, (tx) => tx`DELETE FROM gov.quorum_check`))
    expect(upd?.code).toBe('42501')
    expect(del?.code).toBe('42501')
    // clean the probe row as the owner (RLS is forced on the owner too)
    await owner.begin(async (tx) => {
      await tx`SELECT set_config('gremion.customer_id', ${X}, true)`
      await tx`DELETE FROM gov.meeting`
    })
  })

  it('grants: the app holds exactly the granted privileges; the ledger is not writable by it', async () => {
    const o = adminOn(db)
    pools.push(o)
    const priv = async (role: string, table: string, p: string) =>
      (await o<{ ok: boolean }[]>`SELECT has_table_privilege(${role}, ${table}, ${p}) AS ok`)[0]?.ok
    expect(await priv(roles.app, 'gov.meeting', 'DELETE')).toBe(false)
    expect(await priv(roles.app, 'gov.meeting', 'INSERT')).toBe(true)
    expect(await priv(roles.app, 'gov.quorum_check', 'UPDATE')).toBe(false)
    expect(await priv(roles.app, 'gov.schema_migration', 'SELECT')).toBe(true)
    for (const p of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) expect(await priv(roles.app, 'gov.schema_migration', p)).toBe(false)
    const col = async (role: string, table: string, c: string) =>
      (await o<{ ok: boolean }[]>`SELECT has_column_privilege(${role}, ${table}, ${c}, 'UPDATE') AS ok`)[0]?.ok
    expect(await col(roles.purger, 'gov.notice_override', 'days_short')).toBe(false)
    expect(await col(roles.purger, 'gov.notice_override', 'reason')).toBe(true)
    // the application login cannot write the migration ledger (DV1)
    const w = await failure(app`INSERT INTO gov.schema_migration (filename, sha256, phase, release_ref) VALUES ('0002_x.sql', 'x', 'expand', 'r')`)
    expect(w?.code).toBe('42501')
    // and cannot SET ROLE to the table owner
    const s = await failure(app`SET ROLE ${app(roles.owner)}`)
    expect(s?.code).toBe('42501')
  })

  // The chain is part 2 of the schema, verbatim (plan R6). gov.remove_test_run names gov.poll and the
  // erasure guard calls gov.redaction_covers; both objects belong to a later part of the schema and are
  // NOT in 0001. regression-1.sql and regression-2.sql stand them in as test doubles. This records the gap:
  // when a later chain file creates them, this test fails and the doubles are to be dropped from the fixtures.
  it('the objects 0001 only refers to (gov.poll, gov.redaction_covers) are absent from the shipped schema; the fixtures stand them in', async () => {
    const rows = await owner<{ poll: string | null; covers: string | null }[]>`
      SELECT to_regclass('gov.poll')::text AS poll,
             to_regprocedure('gov.redaction_covers(uuid,text,text,text[])')::text AS covers`
    expect(rows[0]).toEqual({ poll: null, covers: null })
    expect(readFileSync(join(FIXTURES, 'regression-1.sql'), 'utf8')).toMatch(/CREATE TABLE IF NOT EXISTS gov\.poll/)
    expect(readFileSync(join(FIXTURES, 'regression-2.sql'), 'utf8')).toMatch(/CREATE OR REPLACE FUNCTION gov\.redaction_covers/)
  })

  it('SCHEMA 2.21 regression 1 and 2 pass as the owner and leave no meeting behind', async () => {
    for (const f of ['regression-1.sql', 'regression-2.sql']) {
      const text = readFileSync(join(FIXTURES, f), 'utf8')
      // the fixtures open and roll back their own transaction: one reserved connection
      const conn = await owner.reserve()
      try {
        const err = await failure(conn.unsafe(text))
        expect(err, `${f}: ${err?.message}`).toBeNull()
      } finally {
        conn.release()
      }
    }
    const left = await owner.begin(async (tx) => {
      await tx`SELECT set_config('gremion.customer_id', ${X}, true)`
      const rows = await tx<{ n: string }[]>`SELECT count(*)::text AS n FROM gov.meeting`
      return Number(rows[0]?.n)
    })
    expect(left).toBe(0)
  })
})
