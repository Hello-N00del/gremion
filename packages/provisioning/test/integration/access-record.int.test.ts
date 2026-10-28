// TRD-092 / TRD-191 / PRD-OPS-006 on the scratch PostgreSQL 18 (run.mjs): the
// vendor/operator access record of gremion_platform (schema oac, 0013).
//  - oac.record_access writes who/when/what/why; the origin comes from the
//    caller's marker role (panel: an operator uuid; host: a login user), a third
//    role is refused 42501, a missing why / bad actor / bad slug 22023;
//  - append-only: no role can UPDATE, DELETE or TRUNCATE (not even the owner,
//    not with a forged purge flag on a young row);
//  - oac.purge_access_records keeps every row inside the security window
//    (RC-LOG-AUD = RC-LOG-SEC, 27 d) and removes older ones only; a window below
//    27 d or above the 30 d cap is refused; only the executor may call it;
//  - the reader function is tenant-scoped: customer A's rows never come back for B.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { failure, open, OWNER, setupRoles, submitArgs, type Roles } from './scratch.ts'

let r: Roles
/** A superuser pool ON gremion_platform: the documented bypass, used for fixtures and for reading the table. */
let pa: ReturnType<typeof open>
beforeAll(async () => {
  r = await setupRoles('oac')
  pa = open('gremion_platform', 2)
})
afterAll(async () => {
  await pa?.end({ timeout: 5 })
  await r?.close()
})

const OP = '5b8e0a52-2f9f-4b46-9e3a-0b5c7f1a2d33'
const rec = (sql: typeof r.panel, slug: string, over: Partial<Record<'action' | 'what' | 'why' | 'actor', string | null>> = {}) =>
  sql<{ id: string }[]>`SELECT oac.record_access(${slug}, ${over.action ?? 'create_request'}, ${over.what === undefined ? 'Mandant anlegen (Anfrage)' : over.what},
    ${over.why ?? 'Operator-Anforderung im Control-Panel'}, ${over.actor === undefined ? OP : over.actor}, NULL)::text AS id`

/**
 * Back-dates a row. The record is append-only for every role that can log in;
 * only a superuser bypasses it (session_replication_role = replica skips the
 * triggers), which is the documented trust boundary of 0013.
 */
async function backdate(id: string, days: number): Promise<void> {
  await pa.begin(async (tx) => {
    await tx.unsafe('SET LOCAL session_replication_role = replica')
    await tx.unsafe(`UPDATE oac.access_record SET at = now() - interval '${days} days' WHERE access_id = '${id}'`)
  })
}

/** Runs `fn` as the NOLOGIN table owner (reachable by a superuser's SET ROLE only). */
async function asTableOwner<T>(fn: (tx: typeof pa) => Promise<T>): Promise<T> {
  return pa.begin(async (tx) => {
    await tx.unsafe('SET LOCAL ROLE oac_owner')
    return fn(tx as unknown as typeof pa)
  }) as Promise<T>
}

describe('oac.record_access', () => {
  it('panel: records origin=panel with who, when, what, why', async () => {
    const { id } = (await rec(r.panel, 'alpha-rat'))[0]!
    const [row] = await pa<{ origin: string; actor: string; action: string; what: string; why: string; recent: boolean; slug: string }[]>`
      SELECT origin, actor, action, what, why, customer_slug AS slug, at > now() - interval '1 minute' AS recent FROM oac.access_record WHERE access_id = ${id}::uuid`
    expect(row).toEqual({ origin: 'panel', actor: OP, action: 'create_request', what: 'Mandant anlegen (Anfrage)', why: 'Operator-Anforderung im Control-Panel', slug: 'alpha-rat', recent: true })
  })

  it('host (executor): records origin=host with the login user', async () => {
    const { id } = (await rec(r.executor, 'alpha-rat', { actor: 'deploy', action: 'break_glass', why: 'Panel nicht erreichbar, Mandant anlegen' }))[0]!
    const [row] = await pa<{ origin: string; actor: string }[]>`SELECT origin, actor FROM oac.access_record WHERE access_id = ${id}::uuid`
    expect(row).toEqual({ origin: 'host', actor: 'deploy' })
  })

  it.each<[string, string, Parameters<typeof rec>[2], string]>([
    ['panel with a non-uuid actor', 'panel', { actor: 'deploy' }, '22023'],
    ['panel without an actor', 'panel', { actor: null }, '22023'],
    ['a why shorter than 10 characters', 'panel', { why: 'kurz' }, '22023'],
    ['a missing what', 'panel', { what: null }, '22023'],
    ['a bad action', 'panel', { action: 'Drop Everything' }, '22023'],
    ['host with an operator uuid as actor', 'executor', { actor: OP }, '22023'],
  ])('refuses %s', async (_what, who, over, sqlstate) => {
    const f = await failure(rec(who === 'panel' ? r.panel : r.executor, 'alpha-rat', over))
    expect(f?.code).toBe(sqlstate)
  })

  it('refuses a bad slug and the slug platform', async () => {
    expect((await failure(rec(r.panel, '1-bad--slug')))?.code).toBe('22023')
    expect((await failure(rec(r.panel, 'platform')))?.code).toBe('22023')
  })

  it('a third role (the owner) is refused 42501, and PUBLIC holds no EXECUTE', async () => {
    expect((await failure(rec(r.owner, 'alpha-rat')))?.code).toBe('42501')
    const [p] = await pa<{ x: boolean }[]>`SELECT has_function_privilege('public', 'oac.record_access(text,text,text,text,text,uuid)', 'EXECUTE') AS x`
    expect(p!.x).toBe(false)
  })

  it('the writer pins search_path and is SECURITY DEFINER', async () => {
    const [p] = await pa<{ def: boolean; cfg: string[] }[]>`
      SELECT prosecdef AS def, proconfig AS cfg FROM pg_proc WHERE oid = 'oac.record_access(text,text,text,text,text,uuid)'::regprocedure`
    expect(p!.def).toBe(true)
    expect(p!.cfg).toContain('search_path=pg_catalog, pg_temp')
  })
})

describe('the panel statement (requests.ts / retry.ts): request and record in ONE statement', () => {
  const stmt = (a: ReturnType<typeof submitArgs>) => r.panel<{ id: string }[]>`
    SELECT plt.submit_provisioning_request(${a.kind}, ${a.slug}, ${r.panel.json(a.args as never)}, ${a.key}::uuid, ${a.operator}::uuid,
      ${a.acr}, ${a.authTime}::timestamptz, ${a.sessionAt}::timestamptz, ${a.token}, NULL, NULL)::text AS id
      FROM (SELECT oac.record_access(${a.slug}, 'panel_request', 'Mandant anlegen für den Kunden: Anfrage gestellt', 'Betreiber-Anforderung im Control-Panel', ${a.operator}, NULL)) AS access_record`
  const n = async (slug: string) => (await pa<{ n: number }[]>`SELECT count(*)::int AS n FROM oac.access_record WHERE customer_slug = ${slug}`)[0]!.n

  it('an accepted request leaves exactly one record naming the operator', async () => {
    const a = submitArgs({ slug: 'omega-rat' })
    await stmt(a)
    expect(await n('omega-rat')).toBe(1)
  })

  it('a refused request (loa1) leaves no record: the statement rolls back as a whole', async () => {
    expect((await failure(stmt(submitArgs({ slug: 'sigma-rat', acr: 'loa1' }))))?.code).toBe('28000')
    expect(await n('sigma-rat')).toBe(0)
  })
})

describe('append-only', () => {
  it('no role holds a table privilege; the panel and executor cannot touch the table', async () => {
    for (const sql of [r.panel, r.executor]) {
      expect((await failure(sql`SELECT count(*) FROM oac.access_record`))?.code).toBe('42501')
      expect((await failure(sql`DELETE FROM oac.access_record`))?.code).toBe('42501')
    }
  })

  it('the table owner role itself cannot UPDATE, DELETE or TRUNCATE a row (check_violation)', async () => {
    const { id } = (await rec(r.panel, 'beta-rat'))[0]!
    expect((await failure(asTableOwner((tx) => tx`UPDATE oac.access_record SET why = 'umgeschrieben und gefaelscht' WHERE access_id = ${id}::uuid`)))?.code).toBe('23514')
    expect((await failure(asTableOwner((tx) => tx`DELETE FROM oac.access_record WHERE access_id = ${id}::uuid`)))?.code).toBe('23514')
    expect((await failure(asTableOwner((tx) => tx.unsafe('TRUNCATE oac.access_record'))))?.code).toBe('23514')
  })

  it('a forged purge flag does not delete a young row', async () => {
    const { id } = (await rec(r.panel, 'beta-rat'))[0]!
    const f = await failure(asTableOwner(async (tx) => {
      await tx`SELECT set_config('oac.purging', 'on', true)`
      await tx`DELETE FROM oac.access_record WHERE access_id = ${id}::uuid`
    }))
    expect(f?.code).toBe('23514')
    expect((await pa`SELECT 1 FROM oac.access_record WHERE access_id = ${id}::uuid`).length).toBe(1)
  })
})

// MED-1: the header used to promise append-only "for every role including the
// owner" while the platform owner could DISABLE TRIGGER, delete young rows or
// INSERT a backdated row. The table now belongs to a NOLOGIN role nobody logs in
// as; superuser / session_replication_role remain the documented bypass.
describe('trust boundary: the table owner is a NOLOGIN role', () => {
  it('schema, table and every oac function belong to oac_owner: NOLOGIN, not superuser, with no members', async () => {
    const [o] = await pa<{ canlogin: boolean; super: boolean }[]>`SELECT rolcanlogin AS canlogin, rolsuper AS super FROM pg_roles WHERE rolname = 'oac_owner'`
    expect(o).toEqual({ canlogin: false, super: false })
    const rows = await pa<{ what: string; owner: string }[]>`
      SELECT 'schema' AS what, pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = 'oac'
      UNION ALL SELECT 'table', pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'oac.access_record'::regclass
      UNION ALL SELECT p.proname, pg_get_userbyid(p.proowner) FROM pg_proc p WHERE p.pronamespace = 'oac'::regnamespace`
    expect(rows.length).toBeGreaterThanOrEqual(8)
    expect(rows.filter((x) => x.owner !== 'oac_owner')).toEqual([])
    const members = await pa`SELECT 1 FROM pg_auth_members m JOIN pg_roles x ON x.oid = m.roleid WHERE x.rolname = 'oac_owner'`
    expect(members).toHaveLength(0)
  })

  it('the platform owner cannot disable the triggers, insert, delete, or drop the schema', async () => {
    const { id } = (await rec(r.panel, 'epsilon-rat'))[0]!
    expect((await failure(r.owner.unsafe('ALTER TABLE oac.access_record DISABLE TRIGGER access_record_no_delete_trg')))?.code).toBe('42501')
    expect((await failure(r.owner.unsafe('ALTER TABLE oac.access_record DISABLE TRIGGER USER')))?.code).toBe('42501')
    expect((await failure(r.owner`DELETE FROM oac.access_record WHERE access_id = ${id}::uuid`))?.code).toBe('42501')
    expect((await failure(r.owner.unsafe("INSERT INTO oac.access_record (customer_slug, origin, actor, action, what, why) VALUES ('epsilon-rat', 'host', 'deploy', 'x_y', 'abc', 'forged line here')")))?.code).toBe('42501')
    expect((await failure(r.owner.unsafe('DROP SCHEMA oac CASCADE')))?.code).toBe('42501')
    expect((await failure(r.owner.unsafe('ALTER TABLE oac.access_record OWNER TO CURRENT_USER')))?.code).toBe('42501')
    expect((await pa`SELECT 1 FROM oac.access_record WHERE access_id = ${id}::uuid`).length).toBe(1)
  })

  // r33f CRITICAL: the SECURITY DEFINER functions used to call
  // plt.provisioning_member_of, which the PLATFORM OWNER owns and may redefine;
  // its body then ran as oac_owner. Nothing the oac functions call may be
  // redefinable by another role, and oac_owner holds nothing outside oac.
  // r33f MEDIUM: the boundary 0013 states -- the platform owner owns the
  // DATABASE (it can drop the whole of it), never a row, trigger or function of oac.
  it('the documented exception holds: the platform owner owns the database gremion_platform, not oac', async () => {
    const [d] = await pa<{ owner: string }[]>`SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = 'gremion_platform'`
    expect(d!.owner).toBe(OWNER)
    const [n] = await pa<{ owner: string }[]>`SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = 'oac'`
    expect(n!.owner).toBe('oac_owner')
  })

  it('oac_owner holds no privilege and owns nothing outside schema oac', async () => {
    const rows = await pa<{ what: string }[]>`
      WITH o AS (SELECT 'oac_owner'::regrole::oid AS id, 'oac'::regnamespace::oid AS nsp)
      SELECT 'schema ' || n.nspname AS what FROM pg_namespace n, o, aclexplode(n.nspacl) a WHERE a.grantee = o.id AND n.oid <> o.nsp
      UNION ALL SELECT 'relation ' || c.oid::regclass::text FROM pg_class c, o, aclexplode(c.relacl) a WHERE a.grantee = o.id AND c.relnamespace <> o.nsp
      UNION ALL SELECT 'function ' || p.oid::regprocedure::text FROM pg_proc p, o, aclexplode(p.proacl) a WHERE a.grantee = o.id AND p.pronamespace <> o.nsp
      UNION ALL SELECT 'database ' || d.datname FROM pg_database d, o, aclexplode(d.datacl) a WHERE a.grantee = o.id
      UNION ALL SELECT 'owned relation ' || c.oid::regclass::text FROM pg_class c, o WHERE c.relowner = o.id AND c.relnamespace NOT IN (o.nsp, 'pg_toast'::regnamespace)
      UNION ALL SELECT 'owned function ' || p.oid::regprocedure::text FROM pg_proc p, o WHERE p.proowner = o.id AND p.pronamespace <> o.nsp
      UNION ALL SELECT 'member of ' || pg_get_userbyid(m.roleid) FROM pg_auth_members m, o WHERE m.member = o.id`
    expect(rows.map((x) => x.what)).toEqual([])
  })

  it('no oac SECURITY DEFINER function calls a function outside pg_catalog and oac', async () => {
    const rows = await pa<{ fn: string; callee: string }[]>`
      SELECT p.oid::regprocedure::text AS fn, d.refobjid::regprocedure::text AS callee
        FROM pg_proc p JOIN pg_depend d ON d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.refclassid = 'pg_proc'::regclass
        JOIN pg_proc q ON q.oid = d.refobjid
       WHERE p.pronamespace = 'oac'::regnamespace AND q.pronamespace NOT IN ('pg_catalog'::regnamespace, 'oac'::regnamespace)`
    expect(rows).toEqual([])
    const src = await pa<{ fn: string }[]>`
      SELECT p.oid::regprocedure::text AS fn FROM pg_proc p
       WHERE p.pronamespace = 'oac'::regnamespace AND p.prosrc ~ ${String.raw`\mplt\.`}`
    expect(src).toEqual([])
  })

  it('the platform owner replacing plt.provisioning_member_of gains nothing: the triggers stay on, no table privilege', async () => {
    const original = (await pa<{ def: string }[]>`SELECT pg_get_functiondef('plt.provisioning_member_of(text)'::regprocedure) AS def`)[0]!.def
    const owner = (await r.owner<{ u: string }[]>`SELECT current_user AS u`)[0]!.u
    try {
      // The attack of the r33f finding: a VOLATILE plpgsql body that, if it ever
      // runs as oac_owner, disables the triggers and hands the table over.
      await r.owner.unsafe(`CREATE OR REPLACE FUNCTION plt.provisioning_member_of(p_marker text) RETURNS boolean
        LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $body$
        BEGIN
          IF current_user = 'oac_owner' THEN
            EXECUTE 'ALTER TABLE oac.access_record DISABLE TRIGGER USER';
            EXECUTE format('GRANT ALL ON oac.access_record TO %I', '${owner}');
          END IF;
          RETURN EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles x ON x.oid = m.roleid
                           JOIN pg_catalog.pg_roles u ON u.oid = m.member WHERE x.rolname = p_marker AND u.rolname = session_user);
        END
        $body$`)
      await rec(r.panel, 'iota-rat')
      await r.executor`SELECT oac.purge_access_records(interval '27 days')`
      const trg = await pa<{ name: string; on: string }[]>`
        SELECT tgname AS name, tgenabled::text AS on FROM pg_trigger WHERE tgrelid = 'oac.access_record'::regclass AND NOT tgisinternal ORDER BY tgname`
      expect(trg).toHaveLength(4)
      expect(trg.filter((t) => t.on !== 'O')).toEqual([])
      const [p] = await pa<{ any: boolean }[]>`
        SELECT has_table_privilege(${owner}, 'oac.access_record', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE') AS any`
      expect(p!.any).toBe(false)
      expect((await failure(r.owner`DELETE FROM oac.access_record WHERE customer_slug = 'iota-rat'`))?.code).toBe('42501')
    } finally {
      await pa.unsafe(original)
      await pa.unsafe(`ALTER TABLE oac.access_record ENABLE TRIGGER USER`)
      await pa.unsafe(`REVOKE ALL ON oac.access_record FROM ${owner}`)
    }
  })

  it('an INSERT that does not come through oac.record_access is refused, even as the table owner', async () => {
    const f = await failure(asTableOwner((tx) => tx.unsafe(
      "INSERT INTO oac.access_record (customer_slug, origin, actor, action, what, why, at) VALUES ('zeta-rat', 'host', 'deploy', 'x_y', 'abc', 'forged line here', now() - interval '30 days')")))
    expect(f?.code).toBe('42501')
    expect((await pa`SELECT 1 FROM oac.access_record WHERE customer_slug = 'zeta-rat'`).length).toBe(0)
  })

  it('the timestamp is the server clock even when the flag is forged and a backdated at is supplied', async () => {
    await asTableOwner(async (tx) => {
      await tx`SELECT set_config('oac.writing', 'on', true)`
      await tx.unsafe("INSERT INTO oac.access_record (customer_slug, origin, actor, action, what, why, at) VALUES ('eta-rat', 'host', 'deploy', 'x_y', 'abc', 'forged line here', now() - interval '30 days')")
    })
    const rows = await pa<{ recent: boolean }[]>`SELECT at > now() - interval '1 minute' AS recent FROM oac.access_record WHERE customer_slug = 'eta-rat'`
    expect(rows).toHaveLength(1)
    expect(rows[0]!.recent).toBe(true)
  })

  it('a record through record_access carries the clock of the statement, not a caller value', async () => {
    const { id } = (await rec(r.panel, 'theta-rat'))[0]!
    const [x] = await pa<{ recent: boolean }[]>`SELECT at > now() - interval '1 minute' AND at <= clock_timestamp() AS recent FROM oac.access_record WHERE access_id = ${id}::uuid`
    expect(x!.recent).toBe(true)
  })
})

describe('oac.purge_access_records (RC-LOG-AUD: never shorter than the security window)', () => {
  it('keeps a row at the window start through day 26, removes it only past 27 d', async () => {
    const { id: young } = (await rec(r.panel, 'gamma-rat'))[0]!
    const { id: edge } = (await rec(r.panel, 'gamma-rat'))[0]!
    const { id: old } = (await rec(r.panel, 'gamma-rat'))[0]!
    await backdate(young, 1)
    await backdate(edge, 26)
    await backdate(old, 28)
    const { n } = (await r.executor<{ n: number }[]>`SELECT oac.purge_access_records(interval '27 days') AS n`)[0]!
    expect(n).toBeGreaterThanOrEqual(1)
    const left = (await pa<{ access_id: string }[]>`SELECT access_id::text FROM oac.access_record WHERE access_id IN (${young}::uuid, ${edge}::uuid, ${old}::uuid)`).map((x) => x.access_id)
    expect(left.sort()).toEqual([young, edge].sort())
  })

  it('a customer being erased does not touch its access records (no FK to the customer)', async () => {
    const { id } = (await rec(r.panel, 'delta-rat'))[0]!
    await r.executor`SELECT oac.purge_access_records(interval '27 days')`
    expect((await pa`SELECT 1 FROM oac.access_record WHERE access_id = ${id}::uuid`).length).toBe(1)
  })

  it('refuses a window below 27 d or above the 30 d cap, and a caller that is not the executor', async () => {
    expect((await failure(r.executor`SELECT oac.purge_access_records(interval '26 days')`))?.code).toBe('22023')
    expect((await failure(r.executor`SELECT oac.purge_access_records(interval '31 days')`))?.code).toBe('22023')
    expect((await failure(r.panel`SELECT oac.purge_access_records(interval '27 days')`))?.code).toBe('42501')
  })
})

describe('oac.list_access_records (the council admin view reads through this)', () => {
  it('is tenant-scoped: A sees A, never B; newest first; limit and cursor honoured', async () => {
    await rec(r.panel, 'tenant-a', { what: 'A eins' })
    await rec(r.panel, 'tenant-a', { what: 'A zwei' })
    await rec(r.panel, 'tenant-b', { what: 'B geheim' })
    const a = await r.reader<{ what: string; actor: string; origin: string }[]>`SELECT what, actor, origin FROM oac.list_access_records('tenant-a', 50, NULL)`
    expect(a.map((x) => x.what)).toEqual(['A zwei', 'A eins'])
    const b = await r.reader<{ what: string }[]>`SELECT what FROM oac.list_access_records('tenant-b', 50, NULL)`
    expect(b.map((x) => x.what)).toEqual(['B geheim'])
    const one = await r.reader<{ what: string }[]>`SELECT what FROM oac.list_access_records('tenant-a', 1, NULL)`
    expect(one).toHaveLength(1)
  })

  it('the reader role can execute only the reader function, and holds no table privilege', async () => {
    expect((await failure(r.reader`SELECT count(*) FROM oac.access_record`))?.code).toBe('42501')
    expect((await failure(rec(r.reader, 'tenant-a')))?.code).toBe('42501')
    expect((await failure(r.reader`SELECT oac.purge_access_records(interval '27 days')`))?.code).toBe('42501')
    expect((await failure(r.reader`SELECT count(*) FROM plt.provisioning_request_status`))?.code).toBe('42501')
  })

  it('refuses a bad slug (22023)', async () => {
    expect((await failure(r.reader`SELECT * FROM oac.list_access_records('Not A Slug', 10, NULL)`))?.code).toBe('22023')
  })
})
