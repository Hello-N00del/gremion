// TRD-144 / TRD-145 on the scratch stack: the purge runner deletes rows past each
// category's window AS the kernel database's purger role, keeps younger rows and other
// classes, writes one plt.job_run row per run, and is safe to re-run.
import { randomBytes } from 'node:crypto'
import type { Sql } from '@gremion/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  dropKernelDatabase,
  ensureKernelDatabase,
  ensureKernelPurgeGrants,
  kernelDbName,
  kernelRoles,
  openPurgerSession,
  runPurge,
} from '../../src/lifecycle/index.js'
import type { PurgeDeps, PurgeServer } from '../../src/lifecycle/index.js'
import { connect, connectAs } from '../harness/db.js'
import { platformDb, uuidv7 } from '../harness/lifecycle.js'

/**
 * The kernel server as customer-adapters.ts kernelServer builds it: every admin
 * open of a customer database sends search_path=pg_catalog as a startup
 * parameter (it overrides the owner's ALTER DATABASE SET). `bare` is a
 * ModuleServer that forgets it: the lifecycle's own pinning must hold alone.
 */
function kernelServer(opts: { bare?: boolean } = {}): PurgeServer & { close(): Promise<void>; logins: string[] } {
  const admin = connect('t020_test_admin', { max: 2 })
  const pools: Sql[] = []
  const logins: string[] = []
  return {
    admin,
    logins,
    open(database) {
      const sql = connect(database, { max: 2, ...(opts.bare ? {} : { connection: { search_path: 'pg_catalog' } }) })
      pools.push(sql)
      return sql
    },
    login(database, user, password) {
      logins.push(user)
      const sql = connectAs(database, user, password, { connection: { search_path: 'pg_catalog' } })
      pools.push(sql)
      return sql
    },
    async close() {
      await Promise.all([admin, ...pools].map((s) => s.end({ timeout: 5 }).catch(() => {})))
    },
  }
}

const NOW = new Date('2026-10-27T03:00:00.000Z')
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000)
const hex = (id: string) => id.replaceAll('-', '')

describe('runPurge (TRD-144/145)', () => {
  let server: ReturnType<typeof kernelServer>
  let platform: Sql
  const T = uuidv7()
  const U = uuidv7() // a second customer: aged too, purged by ITS purger role
  const pw = randomBytes(24).toString('base64url')
  const run = (extra: Partial<PurgeDeps> = {}) => runPurge({ platform, server, now: () => NOW, ...extra })
  // the test's own pools (the default search_path: the seeds name tables unqualified)
  const seedPools: Sql[] = []
  const db = (t: string) => {
    const sql = connect(kernelDbName(t), { max: 2 })
    seedPools.push(sql)
    return sql
  }
  const count = async (t: string, sql: string) => (await db(t).unsafe(sql))[0]!.n as number

  async function seed(tenant: string) {
    const { owner } = kernelRoles(tenant)
    await db(tenant).begin(async (tx) => {
      await tx.unsafe(`SET LOCAL ROLE ${owner}`)
      // the columns of gremion-ui/migrations 0040 / 0001 / the audit log; purge.test.ts checks the real DDL
      await tx.unsafe(`
        CREATE TABLE public.event_consumption (consumer text NOT NULL, event_id uuid NOT NULL, consumed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (consumer, event_id));
        CREATE TABLE public.scheduled_notifications (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), type text NOT NULL, role_assignment_id uuid NOT NULL DEFAULT gen_random_uuid(),
          recipient_keycloak_id text NOT NULL DEFAULT 'u', scheduled_for timestamptz NOT NULL, sent_at timestamptz, failed_at timestamptz, failure_reason text);
        CREATE TABLE public.audit_log (id bigserial PRIMARY KEY, created_at timestamptz NOT NULL);`)
    })
    // the tenant init path, after the kernel chain (customer-adapters migrate)
    expect(await ensureKernelPurgeGrants(server, tenant)).toEqual({ granted: ['event_consumption', 'scheduled_notifications'], absent: [] })
    const d = db(tenant)
    // category 1: aged (8 d, 30 d) and young (6 d)
    for (const [c, age] of [['old-1', 8], ['old-2', 30], ['young', 6]] as const) {
      await d`INSERT INTO event_consumption (consumer, event_id, consumed_at) VALUES (${c}, ${uuidv7()}, ${daysAgo(age)})`
    }
    // category 2: done (sent / failed) 8 d ago go, done 6 d ago stays, still pending (due 30 d ago) stays
    await d`INSERT INTO scheduled_notifications (type, scheduled_for, sent_at) VALUES ('term_reminder', ${daysAgo(9)}, ${daysAgo(8)})`
    await d`INSERT INTO scheduled_notifications (type, scheduled_for, failed_at) VALUES ('grace_start', ${daysAgo(9)}, ${daysAgo(8)})`
    await d`INSERT INTO scheduled_notifications (type, scheduled_for, sent_at) VALUES ('grace_expiry', ${daysAgo(7)}, ${daysAgo(6)})`
    await d`INSERT INTO scheduled_notifications (type, scheduled_for) VALUES ('term_reminder', ${daysAgo(30)})`
    // another class, far past any window here: no rule, never touched
    await d`INSERT INTO audit_log (created_at) VALUES (${daysAgo(400)})`
  }

  beforeAll(async () => {
    server = kernelServer()
    platform = platformDb()
    await ensureKernelDatabase(server, T, pw)
    await ensureKernelDatabase(server, U, pw)
    await seed(T)
    await seed(U)
    // platform category: job runs past 30 d go, a 29 d one stays
    const [fp] = await platform<{ id: string }[]>`SELECT scheduled_job_id::text AS id FROM plt.scheduled_job WHERE job_kind = 'footprint_measurement'`
    for (const age of [31, 45, 29]) {
      await platform`INSERT INTO plt.job_run (scheduled_job_id, scope, scheduled_for, started_at, finished_at, status)
        VALUES (${fp!.id}, 'platform', ${daysAgo(age)}, ${daysAgo(age)}, ${daysAgo(age)}, 'succeeded')`
    }
  })

  afterAll(async () => {
    await platform`DELETE FROM plt.job_run WHERE scheduled_for >= ${daysAgo(60)} AND scheduled_for < ${daysAgo(20)}`
    await platform`DELETE FROM plt.job_run WHERE scheduled_job_id IN (SELECT scheduled_job_id FROM plt.scheduled_job WHERE job_kind = 'purge_run')`
    await dropKernelDatabase(server, T).catch((e: unknown) => console.error('[purge] teardown', e))
    await dropKernelDatabase(server, U).catch((e: unknown) => console.error('[purge] teardown', e))
    await platform.end()
    await Promise.all(seedPools.map((s) => s.end({ timeout: 5 }).catch(() => {})))
    await server.close()
  })

  it('deletes aged rows of both kernel categories and the platform job log; keeps younger rows, other classes and pending work', async () => {
    const r = await run()
    expect(r.status).toBe('succeeded')
    expect(r.errors).toEqual([])
    for (const t of [T, U]) {
      expect(await count(t, `SELECT count(*)::int AS n FROM event_consumption WHERE consumer LIKE 'old%'`)).toBe(0)
      expect(await count(t, `SELECT count(*)::int AS n FROM event_consumption WHERE consumer = 'young'`)).toBe(1)
      expect(await count(t, `SELECT count(*)::int AS n FROM scheduled_notifications`)).toBe(2) // done 6 d ago + pending
      expect(await count(t, `SELECT count(*)::int AS n FROM scheduled_notifications WHERE sent_at IS NULL AND failed_at IS NULL`)).toBe(1)
      expect(await count(t, `SELECT count(*)::int AS n FROM audit_log`)).toBe(1)
    }
    expect(r.categories['RC-K1-PLUMB/event_consumption']).toBe(4)
    expect(r.categories['RC-K1-PLUMB/scheduled_notifications']).toBe(4)
    expect(r.categories['RC-OPS-RUN/plt.job_run']).toBe(2)
    const [left] = await platform<{ n: number }[]>`SELECT count(*)::int AS n FROM plt.job_run WHERE finished_at >= ${daysAgo(35)} AND finished_at < ${daysAgo(25)}`
    expect(left!.n).toBe(1)
  })

  it('writes one plt.job_run row for the run: platform scope, succeeded, counts per category and errors in detail', async () => {
    const rows = await platform<{ status: string; scope: string; customer_id: string | null; detail_ref: string; detail: any; started_at: Date; finished_at: Date }[]>`
      SELECT r.status, r.scope, r.customer_id, r.detail_ref, r.detail, r.started_at, r.finished_at
        FROM plt.job_run r JOIN plt.scheduled_job j USING (scheduled_job_id) WHERE j.job_kind = 'purge_run'`
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row).toMatchObject({ status: 'succeeded', scope: 'platform', customer_id: null })
    expect(row.detail_ref).toMatch(/^purge\/2026-10-27/)
    expect(row.detail.categories).toMatchObject({ 'RC-K1-PLUMB/event_consumption': 4, 'RC-K1-PLUMB/scheduled_notifications': 4, 'RC-OPS-RUN/plt.job_run': 2 })
    expect(row.detail.errors).toEqual([])
    expect(row.detail.tenants_scanned).toBeGreaterThanOrEqual(2)
    expect(row.finished_at.getTime()).toBeGreaterThanOrEqual(row.started_at.getTime())
  })

  it('a second run deletes 0 everywhere and still logs its own row', async () => {
    const r = await run()
    expect(r.status).toBe('succeeded')
    expect(Object.keys(r.categories).sort()).toEqual(['RC-K1-PLUMB/event_consumption', 'RC-K1-PLUMB/scheduled_notifications', 'RC-OPS-RUN/plt.job_run'])
    expect(Object.values(r.categories).every((n) => n === 0)).toBe(true)
    const [n] = await platform<{ n: number }[]>`SELECT count(*)::int AS n FROM plt.job_run r JOIN plt.scheduled_job j USING (scheduled_job_id) WHERE j.job_kind = 'purge_run'`
    expect(n!.n).toBe(2)
    expect(await count(T, `SELECT count(*)::int AS n FROM event_consumption`)).toBe(1)
  })

  it('acts as the purger role: DELETE on exactly the mapped tables, nothing on audit_log; the purger is not the owner', async () => {
    const { purger, owner } = kernelRoles(T)
    const [q] = await db(T)<Record<string, boolean>[]>`
      SELECT has_table_privilege(${purger}, 'public.event_consumption', 'DELETE') AS ec,
             has_table_privilege(${purger}, 'public.scheduled_notifications', 'DELETE') AS sn,
             has_table_privilege(${purger}, 'public.audit_log', 'DELETE') AS al,
             has_table_privilege(${purger}, 'public.audit_log', 'SELECT') AS al_sel,
             pg_has_role(${purger}, ${owner}, 'MEMBER') AS is_owner`
    expect(q).toEqual({ ec: true, sn: true, al: false, al_sel: false, is_owner: false })
  })

  it('a customer database that lacks a mapped table is skipped for that rule (recorded, not an error)', async () => {
    const V = uuidv7()
    await ensureKernelDatabase(server, V, pw) // empty: the kernel chain has not run
    try {
      const r = await run()
      expect(r.status).toBe('succeeded')
      expect(r.skipped.filter((s) => s.tenant === hex(V)).map((s) => s.rule).sort()).toEqual(['RC-K1-PLUMB/event_consumption', 'RC-K1-PLUMB/scheduled_notifications'])
    } finally {
      await dropKernelDatabase(server, V)
    }
  })

  it('an error in one customer is recorded, the run is failed, and the other customer is still purged', async () => {
    const aged = `INSERT INTO event_consumption (consumer, event_id, consumed_at) VALUES ('old-3', gen_random_uuid(), '${daysAgo(9).toISOString()}')`
    await db(T).unsafe(aged)
    await db(U).unsafe(aged)
    const { owner } = kernelRoles(T)
    await db(T).begin(async (tx) => {
      await tx.unsafe(`SET LOCAL ROLE ${owner}`)
      await tx.unsafe(`CREATE FUNCTION public.refuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused'; END $$;
        CREATE TRIGGER refuse BEFORE DELETE ON public.event_consumption FOR EACH ROW EXECUTE FUNCTION public.refuse()`)
    })
    const r = await run()
    expect(r.status).toBe('failed')
    expect(r.errors.map((e) => e.tenant)).toEqual([hex(T)])
    expect(await count(U, `SELECT count(*)::int AS n FROM event_consumption WHERE consumer = 'old-3'`)).toBe(0)
    expect(await count(T, `SELECT count(*)::int AS n FROM event_consumption WHERE consumer = 'old-3'`)).toBe(1)
    const [row] = await platform<{ status: string; detail: any }[]>`
      SELECT r.status, r.detail FROM plt.job_run r JOIN plt.scheduled_job j USING (scheduled_job_id)
       WHERE j.job_kind = 'purge_run' ORDER BY r.finished_at DESC LIMIT 1`
    expect(row!.status).toBe('failed')
    expect(row!.detail.errors[0]).toMatchObject({ rule: 'RC-K1-PLUMB/event_consumption' })
    expect(String(row!.detail.errors[0].message)).toMatch(/refused/)
  })

  it('CRIT: a tenant BEFORE DELETE trigger that does RESET ROLE cannot reach a superuser; the table is refused and recorded', async () => {
    const W = uuidv7()
    await ensureKernelDatabase(server, W, pw)
    try {
      await seed(W)
      const { owner, app } = kernelRoles(W)
      // what the tenant (the app role, a member of the owner) can do in its own database
      await db(W).begin(async (tx) => {
        await tx.unsafe(`SET LOCAL ROLE ${owner}`)
        await tx.unsafe(`CREATE FUNCTION public.esc() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN RESET ROLE; EXECUTE format('ALTER ROLE %I SUPERUSER', '${app}'); RETURN OLD; END $$;
          CREATE TRIGGER esc BEFORE DELETE ON public.event_consumption FOR EACH ROW EXECUTE FUNCTION public.esc()`)
      })
      const r = await run()
      const [su] = await server.admin<{ s: boolean }[]>`SELECT rolsuper AS s FROM pg_roles WHERE rolname = ${app}`
      expect(su!.s).toBe(false)
      expect(r.status).toBe('failed')
      const mine = r.errors.filter((e) => e.tenant === hex(W))
      expect(mine.map((e) => e.rule)).toEqual(['RC-K1-PLUMB/event_consumption'])
      expect(mine[0]!.message).toMatch(/refused.*trigger esc/)
      // refused, so nothing deleted there; the other rule of the same customer still ran
      expect(await count(W, `SELECT count(*)::int AS n FROM event_consumption WHERE consumer LIKE 'old%'`)).toBe(2)
      expect(await count(W, `SELECT count(*)::int AS n FROM scheduled_notifications`)).toBe(2)
    } finally {
      await dropKernelDatabase(server, W)
    }
  })

  it('CRIT: a tenant ALTER DATABASE SET search_path + planted public.format / current_database / pg_roles cannot escalate through ensureKernelDatabase or ensureKernelPurgeGrants', async () => {
    const Z = uuidv7()
    const bare = kernelServer({ bare: true })
    await ensureKernelDatabase(server, Z, pw)
    try {
      await seed(Z)
      const { owner, app } = kernelRoles(Z)
      const esc = `EXECUTE pg_catalog.format('ALTER ROLE %I SUPERUSER', '${app}')`
      // what the tenant (the app role, a member of the owner) can do in its own database
      await db(Z).begin(async (tx) => {
        await tx.unsafe(`SET LOCAL ROLE ${owner}`)
        await tx.unsafe(`
          CREATE FUNCTION public.format(t text, a text) RETURNS text LANGUAGE plpgsql AS $$ BEGIN ${esc}; RETURN pg_catalog.format(t, a); END $$;
          CREATE FUNCTION public.format(t text, a text, b text) RETURNS text LANGUAGE plpgsql AS $$ BEGIN ${esc}; RETURN pg_catalog.format(t, a, b); END $$;
          CREATE FUNCTION public.current_database() RETURNS name LANGUAGE plpgsql AS $$ BEGIN ${esc}; RETURN pg_catalog.current_database(); END $$;
          CREATE FUNCTION public.esc_roles() RETURNS SETOF pg_catalog.pg_roles LANGUAGE plpgsql AS $$ BEGIN ${esc}; RETURN QUERY SELECT * FROM pg_catalog.pg_roles; END $$;
          CREATE VIEW public.pg_roles AS SELECT * FROM public.esc_roles();
          ALTER DATABASE ${kernelDbName(Z)} SET search_path = public, pg_catalog;`)
      })
      const isSuper = async () => (await server.admin<{ s: boolean }[]>`SELECT rolsuper AS s FROM pg_roles WHERE rolname = ${app}`)[0]!.s
      for (const [label, s] of [['startup search_path', server], ['bare server', bare]] as const) {
        await ensureKernelDatabase(s, Z, pw)
        expect(await isSuper(), `${label}: ensureKernelDatabase`).toBe(false)
        expect(await ensureKernelPurgeGrants(s, Z)).toEqual({ granted: ['event_consumption', 'scheduled_notifications'], absent: [] })
        expect(await isSuper(), `${label}: ensureKernelPurgeGrants`).toBe(false)
      }
    } finally {
      await server.admin.unsafe(`ALTER ROLE ${kernelRoles(Z).app} NOSUPERUSER`).catch(() => {})
      await dropKernelDatabase(server, Z)
      await bare.close()
    }
  })

  it('logs in AS the purger (no SET ROLE in an admin session): RESET ROLE stays the purger, which cannot ALTER ROLE; at rest it is NOLOGIN with no password', async () => {
    const { purger, app } = kernelRoles(T)
    expect(server.logins).toContain(purger)
    const s = await openPurgerSession(server, hex(T), new Date(Date.now() + 60_000))
    try {
      const [who] = await s.db<{ su: string; cu: string }[]>`SELECT session_user::text AS su, current_user::text AS cu`
      expect(who).toEqual({ su: purger, cu: purger })
      await expect(s.db.unsafe(`RESET ROLE; ALTER ROLE ${app} SUPERUSER`)).rejects.toMatchObject({ code: '42501' })
      const after = await s.db.reserve()
      try {
        await after.unsafe('RESET ROLE')
        const [w] = await after<{ su: string; cu: string }[]>`SELECT session_user::text AS su, current_user::text AS cu`
        expect(w).toEqual({ su: purger, cu: purger })
      } finally {
        after.release()
      }
    } finally {
      await s.close()
    }
    const [r] = await server.admin<{ login: boolean; pw: boolean; members: number }[]>`
      SELECT a.rolcanlogin AS login, a.rolpassword IS NOT NULL AS pw,
             (SELECT count(*)::int FROM pg_auth_members m WHERE m.member = a.oid) AS members
        FROM pg_authid a WHERE a.rolname = ${purger}`
    expect(r).toEqual({ login: false, pw: false, members: 0 })
  })

  it('a mapped table the purger was not granted (ensureKernelPurgeGrants not run) is refused and recorded; the run never grants', async () => {
    const X = uuidv7()
    await ensureKernelDatabase(server, X, pw)
    try {
      const { owner, purger } = kernelRoles(X)
      await db(X).begin(async (tx) => {
        await tx.unsafe(`SET LOCAL ROLE ${owner}`)
        await tx.unsafe(`CREATE TABLE public.event_consumption (consumer text NOT NULL, event_id uuid NOT NULL, consumed_at timestamptz NOT NULL, PRIMARY KEY (consumer, event_id))`)
      })
      await db(X)`INSERT INTO event_consumption VALUES ('old', ${uuidv7()}, ${daysAgo(30)})`
      const r = await run()
      const mine = r.errors.filter((e) => e.tenant === hex(X))
      expect(mine.map((e) => e.rule)).toEqual(['RC-K1-PLUMB/event_consumption'])
      expect(mine[0]!.message).toMatch(/refused: the purger lacks SELECT, DELETE on event_consumption/)
      expect(await count(X, `SELECT count(*)::int AS n FROM event_consumption`)).toBe(1)
      const [g] = await db(X)<{ d: boolean }[]>`SELECT has_table_privilege(${purger}, 'public.event_consumption', 'DELETE') AS d`
      expect(g!.d).toBe(false)
    } finally {
      await dropKernelDatabase(server, X)
    }
  })

  it('a rewrite rule, row-level security or a foreign key into a purge table is refused too', async () => {
    const Y = uuidv7()
    await ensureKernelDatabase(server, Y, pw)
    try {
      await seed(Y)
      const { owner } = kernelRoles(Y)
      await db(Y).begin(async (tx) => {
        await tx.unsafe(`SET LOCAL ROLE ${owner}`)
        await tx.unsafe(`CREATE TABLE public.sink (n int);
          CREATE RULE r_sink AS ON DELETE TO public.event_consumption DO ALSO INSERT INTO public.sink VALUES (1);
          ALTER TABLE public.scheduled_notifications ENABLE ROW LEVEL SECURITY;`)
      })
      const r = await run()
      const mine = r.errors.filter((e) => e.tenant === hex(Y)).map((e) => `${e.rule} ${e.message}`)
      expect(mine).toEqual([
        expect.stringMatching(/^RC-K1-PLUMB\/event_consumption refused: .*rewrite rule r_sink/),
        expect.stringMatching(/^RC-K1-PLUMB\/scheduled_notifications refused: .*row-level security/),
      ])
    } finally {
      await dropKernelDatabase(server, Y)
    }
  })

  it('MED: a run that reaches its deadline stops, deletes nothing more, and still records a partial (failed) job_run row', async () => {
    await db(U).unsafe(`INSERT INTO event_consumption (consumer, event_id, consumed_at) VALUES ('old-dl', gen_random_uuid(), '${daysAgo(9).toISOString()}')`)
    const r = await run({ deadlineMs: 1 })
    expect(r.status).toBe('failed')
    expect(r.partial).toBe('deadline')
    expect(r.errors).toEqual([])
    expect(await count(U, `SELECT count(*)::int AS n FROM event_consumption WHERE consumer = 'old-dl'`)).toBe(1)
    const [row] = await platform<{ status: string; detail: any }[]>`SELECT status, detail FROM plt.job_run WHERE job_run_id = ${r.jobRunId}::uuid`
    expect(row!.status).toBe('failed')
    expect(row!.detail).toMatchObject({ partial: 'deadline', deadline_ms: 1 })
    await db(U).unsafe(`DELETE FROM event_consumption WHERE consumer = 'old-dl'`)
  })

  it('HIGH: a deadline that stops a rule after committed batches records the rows those batches deleted', async () => {
    const ec = 'RC-K1-PLUMB/event_consumption'
    for (const c of ['dl-1', 'dl-2', 'dl-hold']) {
      await db(U).unsafe(`INSERT INTO event_consumption (consumer, event_id, consumed_at) VALUES ('${c}', gen_random_uuid(), '${daysAgo(9).toISOString()}')`)
    }
    // batch 1 and 2 commit (one row each); batch 3 waits on the held row lock until the deadline
    let r: Awaited<ReturnType<typeof run>> | undefined
    try {
      await db(U).begin(async (tx) => {
        await tx`SELECT 1 FROM event_consumption WHERE consumer = 'dl-hold' FOR UPDATE`
        r = await run({ batchSize: 1, deadlineMs: 3000 })
      })
      const removed = 3 - (await count(U, `SELECT count(*)::int AS n FROM event_consumption WHERE consumer LIKE 'dl-%'`))
      expect(removed).toBe(2)
      expect(r!.partial).toBe('deadline')
      expect(r!.categories[ec]).toBe(removed)
      const [row] = await platform<{ detail: any }[]>`SELECT detail FROM plt.job_run WHERE job_run_id = ${r!.jobRunId}::uuid`
      expect(row!.detail.categories[ec]).toBe(removed)
    } finally {
      await db(U).unsafe(`DELETE FROM event_consumption WHERE consumer LIKE 'dl-%'`)
    }
  })

  it('MED: a rule cut at the batch cap is recorded in detail.batch_limit_hits (rows may remain)', async () => {
    for (const c of ['cap-1', 'cap-2', 'cap-3']) {
      await db(U).unsafe(`INSERT INTO event_consumption (consumer, event_id, consumed_at) VALUES ('${c}', gen_random_uuid(), '${daysAgo(9).toISOString()}')`)
    }
    const r = await run({ batchSize: 1, maxBatches: 2 })
    expect(r.status).toBe('failed')
    expect(r.batchLimitHits).toContainEqual({ tenant: hex(U), rule: 'RC-K1-PLUMB/event_consumption', batches: 2 })
    expect(await count(U, `SELECT count(*)::int AS n FROM event_consumption WHERE consumer LIKE 'cap-%'`)).toBe(1)
    const [row] = await platform<{ detail: any }[]>`SELECT detail FROM plt.job_run WHERE job_run_id = ${r.jobRunId}::uuid`
    expect(row!.detail.batch_limit_hits).toContainEqual({ tenant: hex(U), rule: 'RC-K1-PLUMB/event_consumption', batches: 2 })
    await db(U).unsafe(`DELETE FROM event_consumption WHERE consumer LIKE 'cap-%'`)
  })

  it('deletes nothing when the purge_run definition is disabled (a purge with no record is not run)', async () => {
    await platform`UPDATE plt.scheduled_job SET enabled = false WHERE job_kind = 'purge_run'`
    try {
      await db(U).unsafe(`INSERT INTO event_consumption (consumer, event_id, consumed_at) VALUES ('old-4', gen_random_uuid(), '${daysAgo(9).toISOString()}')`)
      await expect(run()).rejects.toThrow(/purge_run/)
      expect(await count(U, `SELECT count(*)::int AS n FROM event_consumption WHERE consumer = 'old-4'`)).toBe(1)
    } finally {
      await platform`UPDATE plt.scheduled_job SET enabled = true WHERE job_kind = 'purge_run'`
    }
  })
})
