// TASK-084-a Task 3: ensureGovernanceDatabase / dropGovernanceDatabase on the
// one scratch server (it plays the governance-postgres server).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Sql } from '@gremion/db'
import {
  dropGovernanceDatabase,
  ensureGovernanceDatabase,
  GOVERNANCE_GROUP_ROLES,
  governanceDbName,
  governanceRoles,
} from '../../src/lifecycle/governance.js'
import { assertLifecycleModuleId, LifecycleError } from '../../src/lifecycle/guards.js'
import type { ModuleServer } from '../../src/lifecycle/types.js'
import { admin as openAdmin, adminOn, connectAs, genPassword, uuidv7 } from '../harness/t084.js'

type Err = { code?: string; message?: string }
async function failure(p: PromiseLike<unknown>): Promise<Err | null> {
  try {
    await p
    return null
  } catch (e) {
    return e as Err
  }
}

describe('ensureGovernanceDatabase / dropGovernanceDatabase', () => {
  let a: Sql
  const pools: Sql[] = []
  const created: string[] = []
  const server = (): ModuleServer => ({
    admin: a,
    open: (db, o) => {
      const p = adminOn(db, o?.role ? { role: o.role } : {})
      pools.push(p)
      return p
    },
  })
  const X = uuidv7()
  const Y = uuidv7()
  const pwX = genPassword()
  const pwY = genPassword()
  const track = (id: string) => (created.push(id), id)

  beforeAll(async () => {
    a = openAdmin(4)
    track(X)
    track(Y)
  })

  afterAll(async () => {
    for (const id of created) {
      try {
        await dropGovernanceDatabase(server(), id)
      } catch (e) {
        console.error(`[t084] drop ${id} failed`, e)
      }
    }
    await Promise.all(pools.map((p) => p.end({ timeout: 5 }).catch(() => {})))
    await a.end({ timeout: 5 }).catch(() => {})
  })

  it('creates exactly t_<hex>__governance with the three customer roles and the two group roles', async () => {
    const before = (await a<{ datname: string }[]>`SELECT datname FROM pg_database`).map((r) => r.datname)
    const res = await ensureGovernanceDatabase(server(), X, pwX)
    const after = (await a<{ datname: string }[]>`SELECT datname FROM pg_database`).map((r) => r.datname)
    await ensureGovernanceDatabase(server(), Y, pwY)
    expect(res.created).toBe(true)
    expect(res.dbName).toBe(governanceDbName(X))
    expect(after.filter((d) => !before.includes(d))).toEqual([governanceDbName(X)])
    const r = governanceRoles(X)
    const rows = await a<Record<string, unknown>[]>`
      SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolpassword IS NULL AS nopw
        FROM pg_authid WHERE rolname = ANY(${[r.owner, r.app, r.purger, 'gov_app', 'gov_purger']}) ORDER BY rolname`
    const by = Object.fromEntries(rows.map((x) => [x.rolname as string, x]))
    const flags = { rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false }
    expect(by[r.owner]).toMatchObject({ rolcanlogin: false, ...flags })
    expect(by[r.app]).toMatchObject({ rolcanlogin: true, ...flags })
    expect(by[r.purger]).toMatchObject({ rolcanlogin: false, nopw: true, ...flags })
    expect(by[GOVERNANCE_GROUP_ROLES.app]).toMatchObject({ rolcanlogin: false, ...flags })
    expect(by[GOVERNANCE_GROUP_ROLES.purger]).toMatchObject({ rolcanlogin: false, ...flags })
    const [own] = await a<{ o: string }[]>`SELECT r.rolname AS o FROM pg_database d JOIN pg_roles r ON r.oid = d.datdba WHERE d.datname = ${res.dbName}`
    expect(own?.o).toBe(r.owner)
  })

  it('memberships: g_X_app inherits gov_app but cannot SET it, and is not in g_X_owner', async () => {
    const r = governanceRoles(X)
    const m = await a<{ grp: string; member: string; inherit_option: boolean; set_option: boolean; admin_option: boolean }[]>`
      SELECT g.rolname AS grp, mm.rolname AS member, am.inherit_option, am.set_option, am.admin_option
        FROM pg_auth_members am JOIN pg_roles g ON g.oid = am.roleid JOIN pg_roles mm ON mm.oid = am.member
       WHERE mm.rolname = ANY(${[r.owner, r.app, r.purger]}) ORDER BY 1, 2`
    expect(m).toEqual([
      { grp: 'gov_app', member: r.app, inherit_option: true, set_option: false, admin_option: false },
      { grp: 'gov_purger', member: r.purger, inherit_option: true, set_option: false, admin_option: false },
    ])
  })

  it('datacl: CONNECT only for the customer roles, PUBLIC none, group roles none', async () => {
    const r = governanceRoles(X)
    const acl = await a<{ datname: string; grantee: string; privilege_type: string }[]>`
      SELECT d.datname, CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE g.rolname END AS grantee, x.privilege_type
        FROM pg_database d CROSS JOIN LATERAL aclexplode(d.datacl) x LEFT JOIN pg_roles g ON g.oid = x.grantee`
    const mine = acl.filter((x) => x.datname === governanceDbName(X))
    expect(mine.filter((x) => x.privilege_type === 'CONNECT').map((x) => x.grantee).sort()).toEqual([r.owner, r.app, r.purger].sort())
    expect(mine.filter((x) => x.grantee === 'PUBLIC')).toEqual([])
    expect(acl.filter((x) => x.grantee === 'gov_app' || x.grantee === 'gov_purger')).toEqual([])
  })

  it('A4 cross-tenant: g_Y_app cannot connect to X and g_X_app cannot connect to Y', async () => {
    const msgs: string[] = []
    for (const [who, pw, target] of [[Y, pwY, X], [X, pwX, Y]] as const) {
      const sql = connectAs(governanceDbName(target), governanceRoles(who).app, pw)
      try {
        const e = await failure(sql`SELECT 1`)
        expect(e?.message).toMatch(/permission denied for database/)
        msgs.push(e!.message!)
      } finally {
        await sql.end({ timeout: 5 }).catch(() => {})
      }
    }
    console.info(`[t084] A4 refusals: ${msgs.join(' | ')}`)
    // and each can connect to its own database
    const own = connectAs(governanceDbName(X), governanceRoles(X).app, pwX)
    try {
      expect((await own<{ u: string }[]>`SELECT current_user AS u`)[0]?.u).toBe(governanceRoles(X).app)
    } finally {
      await own.end({ timeout: 5 }).catch(() => {})
    }
  })

  it('a login as a kernel-style role that does not exist on this server is refused (28P01)', async () => {
    const kernelApp = `k_${X.replaceAll('-', '')}_app`
    const sql = connectAs(governanceDbName(X), kernelApp, genPassword())
    try {
      const e = await failure(sql`SELECT 1`)
      expect(e?.code).toBe('28P01')
      console.info(`[t084] absent kernel role refusal: ${e?.message}`)
    } finally {
      await sql.end({ timeout: 5 }).catch(() => {})
    }
  })

  it('timezone is UTC and PUBLIC cannot CREATE in schema public', async () => {
    const db = adminOn(governanceDbName(X))
    pools.push(db)
    expect((await db<{ tz: string }[]>`SELECT current_setting('timezone') AS tz`)[0]?.tz).toBe('UTC')
    expect((await db<{ ok: boolean }[]>`SELECT has_schema_privilege('public', 'public', 'CREATE') AS ok`)[0]?.ok).toBe(false)
  })

  it('a second call writes nothing but the re-asserted password', async () => {
    const seen: string[] = []
    const rec = new Proxy(a, {
      get(t, p) {
        if (p === 'unsafe') return (q: string, ...rest: never[]) => (seen.push(q), t.unsafe(q, ...rest))
        const v = Reflect.get(t, p, t)
        return typeof v === 'function' ? v.bind(t) : v
      },
      apply: (t, _this, args) => Reflect.apply(t, t, args as never),
    }) as Sql
    const res = await ensureGovernanceDatabase({ admin: rec, open: server().open }, X, pwX)
    expect(res.created).toBe(false)
    const ddl = seen.filter((q) => /^(CREATE|ALTER|DROP|GRANT|REVOKE)/i.test(q.trim()))
    expect(ddl.filter((q) => !/^ALTER ROLE .* PASSWORD /i.test(q.trim()))).toEqual([])
    expect(ddl.length).toBeGreaterThan(0) // the password verifier is re-asserted
  })

  it('refuses a database of that name owned by someone else; nothing in it is touched', async () => {
    const Z = track(uuidv7())
    await a.unsafe('CREATE ROLE t084_probe NOLOGIN')
    try {
      await a.unsafe(`CREATE DATABASE ${governanceDbName(Z)} OWNER t084_probe`)
      const e = await failure(ensureGovernanceDatabase(server(), Z, genPassword()))
      expect(e).toBeInstanceOf(LifecycleError)
      expect((e as unknown as LifecycleError).code).toBe('DATABASE_FOREIGN_OWNER')
      const [own] = await a<{ o: string }[]>`SELECT r.rolname AS o FROM pg_database d JOIN pg_roles r ON r.oid = d.datdba WHERE d.datname = ${governanceDbName(Z)}`
      expect(own?.o).toBe('t084_probe')
    } finally {
      await a.unsafe(`DROP DATABASE IF EXISTS ${governanceDbName(Z)} WITH (FORCE)`)
      await a.unsafe('DROP ROLE IF EXISTS t084_probe')
      created.splice(created.indexOf(Z), 1)
      for (const role of Object.values(governanceRoles(Z))) await a.unsafe(`DROP ROLE IF EXISTS ${role}`)
    }
  })

  it('two customers created concurrently both succeed (ten repetitions)', async () => {
    for (let i = 0; i < 10; i++) {
      const p = track(uuidv7())
      const q = track(uuidv7())
      const res = await Promise.allSettled([ensureGovernanceDatabase(server(), p, genPassword()), ensureGovernanceDatabase(server(), q, genPassword())])
      expect(res.map((r) => r.status === 'rejected' ? String((r.reason as Error).message) : 'ok')).toEqual(['ok', 'ok'])
    }
  })

  it('the password sets the verifier: the new one logs in, the old one fails 28P01', async () => {
    const id = track(uuidv7())
    const pwA = genPassword()
    const pwB = genPassword()
    await ensureGovernanceDatabase(server(), id, pwA)
    await ensureGovernanceDatabase(server(), id, pwB)
    const ok = connectAs(governanceDbName(id), governanceRoles(id).app, pwB)
    const old = connectAs(governanceDbName(id), governanceRoles(id).app, pwA)
    try {
      expect((await ok`SELECT 1 AS one`)[0]?.one).toBe(1)
      expect((await failure(old`SELECT 1`))?.code).toBe('28P01')
    } finally {
      await ok.end({ timeout: 5 }).catch(() => {})
      await old.end({ timeout: 5 }).catch(() => {})
    }
  })

  it('rejects an app password under 16 chars or with control characters', async () => {
    for (const bad of ['short', 'x'.repeat(15), `${'x'.repeat(20)}\n`, `${'x'.repeat(20)}\u0000`, 'x'.repeat(257)]) {
      const e = await failure(ensureGovernanceDatabase(server(), uuidv7(), bad))
      expect(e).toBeInstanceOf(LifecycleError)
      expect((e as unknown as LifecycleError).code).toBe('INVALID_INPUT')
    }
  })

  it('governance is a reserved module id: enableModule cannot target the governance database', () => {
    expect(() => assertLifecycleModuleId('governance')).toThrow(/reserved/)
  })

  it('drop removes the database and the three roles, keeps the group roles, is idempotent', async () => {
    const id = track(uuidv7())
    await ensureGovernanceDatabase(server(), id, genPassword())
    const first = await dropGovernanceDatabase(server(), id)
    expect(first).toEqual({ dbName: governanceDbName(id), dropped: true })
    const r = governanceRoles(id)
    expect((await a`SELECT 1 FROM pg_database WHERE datname = ${first.dbName}`).length).toBe(0)
    expect((await a`SELECT 1 FROM pg_roles WHERE rolname = ANY(${[r.owner, r.app, r.purger]})`).length).toBe(0)
    expect((await a`SELECT 1 FROM pg_roles WHERE rolname = ANY(${['gov_app', 'gov_purger']})`).length).toBe(2)
    expect(await dropGovernanceDatabase(server(), id)).toEqual({ dbName: first.dbName, dropped: false })
  })
})
