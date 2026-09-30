// TASK-043 TDD 5 on the scratch stack: ensureKernelDatabase makes exactly
// t_<hex>__kernel on the kernel server with its three roles, locked down, UTC,
// no CREATE on public for anyone but the owner, pgbouncer.get_auth installed --
// and leaves it EMPTY (no schema_migrations: the kernel chain is gremion-ui's
// runner's, Q3). Objects created under SET ROLE owner are owned by the owner.
import { randomBytes } from 'node:crypto'
import type { Sql } from '@gremion/db'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { dropKernelDatabase, ensureKernelDatabase, kernelDbName, kernelRoles } from '../../src/lifecycle/index.js'
import type { ModuleServer } from '../../src/lifecycle/index.js'
import { tenantModuleDbName } from '../../src/names.js'
import { connect, dbUrl } from '../harness/db.js'
import { uuidv7 } from '../harness/lifecycle.js'

function kernelServer(): ModuleServer & { close(): Promise<void> } {
  const admin = connect('t020_test_admin', { max: 2 })
  const pools: Sql[] = []
  return {
    admin,
    open(database) {
      const sql = connect(database, { max: 2 })
      pools.push(sql)
      return sql
    },
    async close() {
      await Promise.all([admin, ...pools].map((s) => s.end({ timeout: 5 }).catch(() => {})))
    },
  }
}

function as(db: string, user: string, password: string): Sql {
  const u = new URL(dbUrl(db))
  u.username = user
  u.password = encodeURIComponent(password)
  return postgres(u.toString(), { max: 1, onnotice: () => {}, connect_timeout: 5 })
}

async function code(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p
  } catch (err) {
    return (err as { code?: string }).code
  }
  return undefined
}

describe('ensureKernelDatabase (TDD 5)', () => {
  let server: ReturnType<typeof kernelServer>
  const X = uuidv7()
  const Y = uuidv7()
  const pwX = randomBytes(24).toString('base64url')
  const pwY = randomBytes(24).toString('base64url')

  beforeAll(() => {
    server = kernelServer()
  })

  afterAll(async () => {
    // logged, never swallowed: a leftover kernel db or role on the shared harness server must be visible (review B1 LOW, r2)
    await dropKernelDatabase(server, X).catch((e: unknown) => console.error('[t043] teardown left the kernel db of', X, e))
    await dropKernelDatabase(server, Y).catch((e: unknown) => console.error('[t043] teardown left the kernel db of', Y, e))
    await server.admin.unsafe('DROP ROLE IF EXISTS t043_probe')
    await server.close()
  })

  it('creates exactly t_<hex>__kernel with owner NOLOGIN, app LOGIN NOBYPASSRLS NOCREATEDB, purger outside the owner', async () => {
    const before = (await server.admin<{ datname: string }[]>`SELECT datname FROM pg_database`).map((r) => r.datname)
    const r = await ensureKernelDatabase(server, X, pwX)
    const after = (await server.admin<{ datname: string }[]>`SELECT datname FROM pg_database`).map((r) => r.datname)
    expect(after.filter((d) => !before.includes(d))).toEqual([tenantModuleDbName(X, 'kernel')])
    expect(r.dbName).toBe(kernelDbName(X))
    expect(r.created).toBe(true)
    const roles = kernelRoles(X)
    expect(r).toMatchObject(roles)
    const attrs = await server.admin<{ rolname: string; login: boolean; su: boolean; createdb: boolean; createrole: boolean; bypass: boolean }[]>`
      SELECT rolname, rolcanlogin AS login, rolsuper AS su, rolcreatedb AS createdb, rolcreaterole AS createrole, rolbypassrls AS bypass
        FROM pg_roles WHERE rolname = ANY(${[roles.owner, roles.app, roles.purger]}) ORDER BY rolname`
    const by = Object.fromEntries(attrs.map((a) => [a.rolname, a]))
    expect(by[roles.owner]).toMatchObject({ login: false, su: false, createdb: false, createrole: false, bypass: false })
    expect(by[roles.app]).toMatchObject({ login: true, su: false, createdb: false, createrole: false, bypass: false })
    expect(by[roles.purger]).toMatchObject({ login: false, su: false, bypass: false })
    const members = await server.admin<{ member: string }[]>`
      SELECT p.rolname AS member FROM pg_auth_members m JOIN pg_roles o ON o.oid = m.roleid JOIN pg_roles p ON p.oid = m.member
       WHERE o.rolname = ${roles.owner} ORDER BY 1`
    expect(members.map((m) => m.member)).toEqual([roles.app])
    const [db] = await server.admin<{ owner: string; public_connect: boolean; app_connect: boolean }[]>`
      SELECT pg_get_userbyid(datdba) AS owner,
             has_database_privilege('public', datname, 'CONNECT') AS public_connect,
             has_database_privilege(${roles.app}, datname, 'CONNECT') AS app_connect
        FROM pg_database WHERE datname = ${r.dbName}`
    expect(db).toEqual({ owner: roles.owner, public_connect: false, app_connect: true })
  })

  it('UTC, pgbouncer.get_auth present, and the database is EMPTY (no schema_migrations, no tables)', async () => {
    const app = as(kernelDbName(X), kernelRoles(X).app, pwX)
    try {
      const [tz] = await app<{ tz: string }[]>`SELECT current_setting('TimeZone') AS tz`
      expect(tz?.tz).toBe('UTC')
      const [fn] = await app<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'pgbouncer' AND p.proname = 'get_auth'`
      expect(fn?.n).toBe(1)
      const [ledger] = await app<{ present: boolean }[]>`SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present`
      expect(ledger?.present).toBe(false)
      const [tables] = await app<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'`
      expect(tables?.n).toBe(0)
    } finally {
      await app.end()
    }
  })

  it('what the migration creates under SET ROLE owner is owned by the owner', async () => {
    const roles = kernelRoles(X)
    const app = as(kernelDbName(X), roles.app, pwX)
    try {
      await app.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL ROLE ${roles.owner}`)
        await tx.unsafe('CREATE TABLE public.t043_probe (id int)')
      })
      const [t] = await app<{ owner: string }[]>`SELECT tableowner AS owner FROM pg_tables WHERE tablename = 't043_probe'`
      expect(t?.owner).toBe(roles.owner)
      await app.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL ROLE ${roles.owner}`)
        await tx.unsafe('DROP TABLE public.t043_probe')
      })
    } finally {
      await app.end()
    }
  })

  it('a role that may CONNECT but is not the owner cannot CREATE on public; another customer\'s app cannot CONNECT', async () => {
    await ensureKernelDatabase(server, Y, pwY)
    const pw = randomBytes(18).toString('base64url')
    await server.admin.unsafe('DROP ROLE IF EXISTS t043_probe')
    const [q] = await server.admin<{ stmt: string }[]>`SELECT format('CREATE ROLE t043_probe LOGIN PASSWORD %L', ${pw}::text) AS stmt`
    await server.admin.unsafe(q!.stmt)
    const [g] = await server.admin<{ stmt: string }[]>`SELECT format('GRANT CONNECT ON DATABASE %I TO t043_probe', ${kernelDbName(X)}::text) AS stmt`
    await server.admin.unsafe(g!.stmt)
    const probe = as(kernelDbName(X), 't043_probe', pw)
    try {
      expect(await code(probe.unsafe('CREATE TABLE public.nope (id int)'))).toBe('42501')
    } finally {
      await probe.end({ timeout: 1 }).catch(() => {})
    }
    const [r] = await server.admin<{ stmt: string }[]>`SELECT format('REVOKE CONNECT ON DATABASE %I FROM t043_probe', ${kernelDbName(X)}::text) AS stmt`
    await server.admin.unsafe(r!.stmt)
    const foreign = as(kernelDbName(X), kernelRoles(Y).app, pwY)
    try {
      expect(await code(foreign`SELECT 1`)).toBe('42501')
    } finally {
      await foreign.end({ timeout: 1 }).catch(() => {})
    }
  })

  it('a rerun re-asserts and creates nothing; a database of that name with a foreign owner is refused', async () => {
    const before = (await server.admin<{ datname: string }[]>`SELECT datname FROM pg_database`).length
    const r = await ensureKernelDatabase(server, X, pwX)
    expect(r.created).toBe(false)
    expect((await server.admin<{ datname: string }[]>`SELECT datname FROM pg_database`).length).toBe(before)
    const Z = uuidv7()
    const name = kernelDbName(Z)
    await server.admin.unsafe(`CREATE DATABASE ${name}`)
    try {
      await expect(ensureKernelDatabase(server, Z, pwX)).rejects.toMatchObject({ code: 'DATABASE_FOREIGN_OWNER' })
    } finally {
      await server.admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
      for (const role of Object.values(kernelRoles(Z))) await server.admin.unsafe(`DROP ROLE IF EXISTS ${role}`)
    }
  })

  it('reports the PgBouncer grant: skipped without a pgbouncer_auth role, applied (EXECUTE on get_auth) with one (review B1, r2)', async () => {
    const V = uuidv7()
    const had = (await server.admin`SELECT 1 FROM pg_roles WHERE rolname = 'pgbouncer_auth'`).length === 1
    try {
      if (!had) {
        expect((await ensureKernelDatabase(server, V, pwX)).pgbouncerGrant).toBe('skipped-no-role')
        await server.admin.unsafe('CREATE ROLE pgbouncer_auth NOLOGIN')
      }
      const r = await ensureKernelDatabase(server, V, pwX)
      expect(r.pgbouncerGrant).toBe('applied')
      const db = await server.open(kernelDbName(V))
      try {
        const [p] = await db<{ ok: boolean }[]>`SELECT has_function_privilege('pgbouncer_auth', 'pgbouncer.get_auth(text)', 'EXECUTE') AS ok`
        expect(p?.ok).toBe(true)
      } finally {
        await db.end({ timeout: 5 })
      }
    } finally {
      await dropKernelDatabase(server, V).catch((e: unknown) => console.error('[t043] teardown left the kernel db of', V, e))
      if (!had) await server.admin.unsafe('DROP ROLE IF EXISTS pgbouncer_auth')
    }
  })

  it('dropKernelDatabase removes the database and all three roles; a second call is a no-op', async () => {
    const W = uuidv7()
    await ensureKernelDatabase(server, W, pwX)
    expect(await dropKernelDatabase(server, W)).toEqual({ dbName: kernelDbName(W), dropped: true })
    expect((await server.admin`SELECT 1 FROM pg_database WHERE datname = ${kernelDbName(W)}`).length).toBe(0)
    expect((await server.admin`SELECT 1 FROM pg_roles WHERE rolname = ANY(${Object.values(kernelRoles(W))})`).length).toBe(0)
    expect(await dropKernelDatabase(server, W)).toEqual({ dbName: kernelDbName(W), dropped: false })
  })
})
