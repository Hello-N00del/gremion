// The kernel API against a scratch PostgreSQL 18 (brief s.1 / TDD 5-9, 11,
// 13, 18; lane note A1, A3, A7): the REAL wiring (wire.ts: reader-role pools,
// the per-customer gate, the real token verifier against local issuers), the
// REAL migrate command, the REAL catalogue rows (loadCatalogueRows over
// modules/*), customers made from the libraries (C3). Sequential: each step
// builds on the one before.
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { ADVISORY_LOCKS, createTenantStore } from '@gremion/tenant-store'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app/build.ts'
import { readConfig } from '../../src/app/config.ts'
import { wireDeps, type Wired } from '../../src/app/wire.ts'
import { KERNEL_API_MIGRATION_DIRS } from '../../src/migrate/chain.ts'
import { runMigrateCli } from '../../src/migrate/cli.ts'
import { platformRegistryStore } from '../../src/registry/store.ts'
import { loadDeclarations } from '../../src/registry/declarations.ts'
import { createSecretResolver } from '../../src/tenancy/secrets.ts'
import { controlTenancyStore } from '../../src/tenancy/store.ts'
import { kernelDatabaseOf, kernelTargetResolver } from '../../src/tenancy/target.ts'
import { startIssuers, type Issuers } from '../harness/issuers.ts'
import { recordingSql, scopeProblems, type RecordedQuery } from '../harness/query-recorder.ts'
import { buildWorld, connect, createCustomer, enableModule, KERNEL_ROOT, realModules, SERVICE_ROOT, stack, url, type Customer, type ScratchWorld } from '../harness/scratch.ts'

const PROXY = 'proxy-secret-for-the-scratch-stack-0123'
const APEX = 'example.org'
const DIRS = KERNEL_API_MIGRATION_DIRS.map((d) => join(SERVICE_ROOT, d))
const DUMPS = join(KERNEL_ROOT, '.scratch', 't077-dumps', String(process.pid))
// Windows has no uid: the dump dir's 0700/owner check is tenant-store's (unit-tested there with the same fake).
const dumpFs = { statDir: () => ({ isDirectory: true, mode: 0o700, uid: 1000 }), freeBytes: () => 1e12, uid: 1000 }

let world: ScratchWorld
let iss: Issuers
let wired: Wired
let app: FastifyInstance
let A: Customer
let B: Customer
const others: Customer[] = []

const edge = (host: string, token?: string) => ({ host, 'x-forwarded-host': host, 'x-proxy-trust': PROXY, ...(token ? { authorization: `Bearer ${token}` } : {}) })

/** HOST/PORT only (directUrlFor refuses userinfo since 4f2a30ee): each customer's db_conn_ref carries the credentials. */
const directBase = (o: { pooler?: boolean } = {}) => {
  const u = new URL(url('postgres', o))
  u.username = ''
  u.password = ''
  return u.toString()
}

async function migrate(args: string[], env: Record<string, string> = {}) {
  const lines: string[] = []
  const code = await runMigrateCli(
    ['migrate', ...args],
    {
      ...world.env,
      KERNEL_API_CONTROL_DB_URL: world.readerControlUrl,
      GREMION_KERNEL_PG_DIRECT_URL: directBase(),
      GREMION_RELEASE_REF: 'dist-v1.0.0',
      GREMION_MIGRATION_DUMP_DIR: DUMPS,
      KERNEL_API_PG_DUMP_CONTAINER: stack().container,
      ...env,
    },
    { out: (l) => lines.push(l), err: (l) => lines.push(l) },
    { dirs: DIRS, kernelRoot: KERNEL_ROOT },
    { options: { dumpFs } },
  )
  return { code, lines }
}

async function ledgerOf(c: Customer): Promise<Array<{ filename: string; sha256: string }> | null> {
  const sql = connect(kernelDatabaseOf(c.id), { max: 1 })
  try {
    const [t] = await sql<{ t: string | null }[]>`SELECT to_regclass('idt.schema_migration')::text AS t`
    if (!t?.t) return null
    return await sql<{ filename: string; sha256: string }[]>`SELECT filename, sha256 FROM idt.schema_migration ORDER BY filename`
  } finally {
    await sql.end()
  }
}

beforeAll(async () => {
  mkdirSync(DUMPS, { recursive: true })
  world = await buildWorld()
  iss = await startIssuers(['realm-a', 'realm-b', 'realm-c'])
  const realm = (n: string) => ({ realm: n, issuer: iss.realms.get(n)!.issuer, kcInternal: iss.realms.get(n)!.kcInternal })
  A = await createCustomer(world, 'cust-a', 'a.example.org', realm('realm-a'))
  B = await createCustomer(world, 'cust-b', 'council-b.example', realm('realm-b'))
  others.push(await createCustomer(world, 'cust-d', 'd.example.org', { status: 'deleting' }))
  others.push(await createCustomer(world, 'cust-e', 'e.example.org', { status: 'deleted' }))
  const config = readConfig(
    { TENANT_PROXY_SHARED_SECRET: PROXY, PLATFORM_DOMAIN: APEX, KERNEL_API_CONTROL_DB_URL: world.readerControlUrl, KERNEL_API_PLATFORM_DB_URL: world.readerPlatformUrl, GREMION_RELEASE_REF: 'dist-v1.0.0' },
    { modulesRoot: join(KERNEL_ROOT, 'modules'), kernelRoot: KERNEL_ROOT },
  )
  wired = wireDeps(config, { dirs: DIRS, env: world.env, log: { info: () => {}, warn: () => {}, error: () => {} } })
  app = buildApp({}, wired.deps)
}, 120_000)

afterAll(async () => {
  await app?.close()
  await wired?.close()
  await iss?.close()
  await world?.close()
  rmSync(DUMPS, { recursive: true, force: true })
})

describe('the kernel API on PG18 (scratch stack)', () => {
  it('A1: the catalogue rows are one plt.module + one draft plt.module_version per modules/<dir>, startup wrote none', async () => {
    const n = realModules().length
    expect(world.catalogueSize).toBe(n)
    const [m] = await world.platform<{ modules: number; versions: number; drafts: number }[]>`
      SELECT (SELECT count(*)::int FROM plt.module) AS modules, (SELECT count(*)::int FROM plt.module_version) AS versions,
             (SELECT count(*)::int FROM plt.module_version WHERE status = 'draft') AS drafts`
    expect(m).toEqual({ modules: n, versions: n, drafts: n })
    const before = await world.platform<{ v: number }[]>`SELECT sum(row_version)::int AS v FROM plt.module`
    expect(loadDeclarations(join(KERNEL_ROOT, 'modules')).size).toBe(n)
    expect(await world.platform<{ v: number }[]>`SELECT sum(row_version)::int AS v FROM plt.module`).toEqual(before)
  })

  it('a customer whose kernel database the migrate job has not reached is 503 (behind), never served', async () => {
    const res = await app.inject({ url: '/api/v1/tenancy/self', headers: edge(A.host, await iss.mint('realm-a')) })
    expect(res.statusCode).toBe(503)
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0)
    expect(await ledgerOf(A)).toBeNull()
  })

  it('migrate --customer A: one created dump line BEFORE the first apply, pg_dump 18 = server 18, ledger idt.schema_migration, objects owned by k_<hex>_owner', async () => {
    const { code, lines } = await migrate(['--customer', A.id])
    expect(code, lines.join('\n')).toBe(0)
    const created = lines.filter((l) => l.startsWith('premigration-dump created '))
    expect(created).toHaveLength(1)
    expect(created[0]).toContain(`db=${kernelDatabaseOf(A.id)}`)
    expect(lines.findIndex((l) => l.startsWith('premigration-dump created'))).toBeLessThan(lines.findIndex((l) => /applied 0001_idt_setup\.sql/.test(l)))
    // the chain is core 0001 (077) + the two bodies files (080-a)
    expect(lines).toContain(`MIGRATE-RESULT customer=${A.id} applied=3 already=0`)
    expect((await ledgerOf(A))!.map((r) => r.filename)).toEqual(['0001_idt_setup.sql', '0002_idt_plumbing_structure.sql', '0003_idt_person_membership_tenure.sql'])
    const sql = connect(kernelDatabaseOf(A.id), { max: 1 })
    try {
      const [o] = await sql<{ schema_owner: string; fn_owner: string; server: number; legacy: string | null }[]>`
        SELECT (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'idt') AS schema_owner,
               (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE proname = 'refuse_update' AND pronamespace = 'idt'::regnamespace) AS fn_owner,
               current_setting('server_version_num')::int / 10000 AS server,
               to_regclass('public.schema_migrations')::text AS legacy`
      const owner = `k_${A.id.replaceAll('-', '')}_owner`
      expect(o).toEqual({ schema_owner: owner, fn_owner: owner, server: 18, legacy: null })
    } finally {
      await sql.end()
    }
    // the dump: pg_dump inside the PG18 container
    const r = (await import('node:child_process')).spawnSync('docker', ['exec', stack().container, 'pg_dump', '--version'], { encoding: 'utf8' })
    expect(r.stdout).toMatch(/\(PostgreSQL\) 18\./)
  })

  it("A is served on the very next request; B (one file behind) is 503 with Retry-After, B's ledger untouched", async () => {
    const a = await app.inject({ url: '/api/v1/tenancy/self', headers: edge(A.host, await iss.mint('realm-a')) })
    expect(a.statusCode).toBe(200)
    expect(a.json()).toEqual({ customerId: A.id, slug: 'cust-a', realm: 'realm-a' })
    const b = await app.inject({ url: '/api/v1/tenancy/self', headers: edge(B.host, await iss.mint('realm-b')) })
    expect(b.statusCode).toBe(503)
    expect(b.headers['retry-after']).toBe('30')
    expect(await ledgerOf(B)).toBeNull()
  })

  it("cross-realm: B's token on A's host is 401", async () => {
    const res = await app.inject({ url: '/api/v1/tenancy/self', headers: edge(A.host, await iss.mint('realm-b')) })
    expect(res.statusCode).toBe(401)
    expect(res.headers['content-type']).toMatch(/problem\+json/)
  })

  it('migrate (all): B migrated, A already current, deleting/deleted skipped; then B is served', async () => {
    const { code, lines } = await migrate([])
    expect(code, lines.join('\n')).toBe(0)
    expect(lines).toContain(`MIGRATE-RESULT customer=${B.id} applied=3 already=0`)
    expect(lines).toContain(`MIGRATE-RESULT customer=${A.id} applied=0 already=3 dump=none`)
    expect(lines).toEqual(expect.arrayContaining([`MIGRATE-SKIPPED customer=${others[0]!.id} status=deleting`, `MIGRATE-SKIPPED customer=${others[1]!.id} status=deleted`]))
    expect((await app.inject({ url: '/api/v1/tenancy/self', headers: edge(B.host, await iss.mint('realm-b')) })).statusCode).toBe(200)
  })

  it('registry: GET /api/v1/modules returns exactly the customer\'s enabled rows with the image\'s runtime blocks', async () => {
    await enableModule(world, A.id, 'calendar')
    await enableModule(world, A.id, 'votes')
    await enableModule(world, A.id, 'vault', 'disabled')
    await enableModule(world, B.id, 'files')
    const decls = loadDeclarations(join(KERNEL_ROOT, 'modules'))
    const a = await app.inject({ url: '/api/v1/modules', headers: edge(A.host, await iss.mint('realm-a')) })
    expect(a.statusCode).toBe(200)
    expect(a.json()).toEqual({
      customerId: A.id,
      modules: [
        { moduleKey: 'calendar', semver: decls.get('calendar')!.version, runtime: decls.get('calendar') },
        { moduleKey: 'votes', semver: decls.get('votes')!.version, runtime: decls.get('votes') },
      ],
    })
    const b = await app.inject({ url: '/api/v1/modules', headers: edge(B.host, await iss.mint('realm-b')) })
    expect(b.json().modules.map((m: { moduleKey: string }) => m.moduleKey)).toEqual(['files'])
  })

  it("B's database down -> B only (503); A still 200; restored -> B served again (nothing cached)", async () => {
    const db = kernelDatabaseOf(B.id)
    await world.admin.unsafe(`ALTER DATABASE ${db} ALLOW_CONNECTIONS false`)
    await world.admin`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${db}`
    try {
      expect((await app.inject({ url: '/api/v1/tenancy/self', headers: edge(B.host, await iss.mint('realm-b')) })).statusCode).toBe(503)
      expect((await app.inject({ url: '/api/v1/tenancy/self', headers: edge(A.host, await iss.mint('realm-a')) })).statusCode).toBe(200)
    } finally {
      await world.admin.unsafe(`ALTER DATABASE ${db} ALLOW_CONNECTIONS true`)
    }
    let status = 0
    for (let i = 0; i < 5 && status !== 200; i++) status = (await app.inject({ url: '/api/v1/tenancy/self', headers: edge(B.host, await iss.mint('realm-b')) })).statusCode
    expect(status).toBe(200)
  })

  it('a customer created after the migrate job is 503 until `migrate --customer <id>`, then 200 on the very next request (Q10)', async () => {
    const C = await createCustomer(world, 'cust-c', 'c.example.org', { realm: 'realm-c', issuer: iss.realms.get('realm-c')!.issuer, kcInternal: iss.realms.get('realm-c')!.kcInternal })
    others.push(C)
    // a fresh wiring sees C's secret (the env the resolver reads is the boot environment)
    const fresh = wireDeps(readConfig({ TENANT_PROXY_SHARED_SECRET: PROXY, PLATFORM_DOMAIN: APEX, KERNEL_API_CONTROL_DB_URL: world.readerControlUrl, KERNEL_API_PLATFORM_DB_URL: world.readerPlatformUrl }, { modulesRoot: join(KERNEL_ROOT, 'modules'), kernelRoot: KERNEL_ROOT }), { dirs: DIRS, env: world.env, log: { info: () => {}, warn: () => {}, error: () => {} } })
    const app2 = buildApp({}, fresh.deps)
    try {
      expect((await app2.inject({ url: '/api/v1/tenancy/self', headers: edge(C.host, await iss.mint('realm-c')) })).statusCode).toBe(503)
      const { code, lines } = await migrate(['--customer', C.id])
      expect(code, lines.join('\n')).toBe(0)
      expect((await app2.inject({ url: '/api/v1/tenancy/self', headers: edge(C.host, await iss.mint('realm-c')) })).statusCode).toBe(200)
    } finally {
      await app2.close()
      await fresh.close()
    }
  })

  it("TRD-353: B's applied sha256 altered -> B 503 (diverged), A 200; the migrate job refuses B; restored -> B 200", async () => {
    const sql = connect(kernelDatabaseOf(B.id), { max: 1 })
    const [{ sha256 }] = (await sql<{ sha256: string }[]>`SELECT sha256 FROM idt.schema_migration WHERE filename = '0001_idt_setup.sql'`) as unknown as [{ sha256: string }]
    try {
      await sql`UPDATE idt.schema_migration SET sha256 = ${'0'.repeat(64)} WHERE filename = '0001_idt_setup.sql'`
      expect((await app.inject({ url: '/api/v1/tenancy/self', headers: edge(B.host, await iss.mint('realm-b')) })).statusCode).toBe(503)
      expect((await app.inject({ url: '/api/v1/tenancy/self', headers: edge(A.host, await iss.mint('realm-a')) })).statusCode).toBe(200)
      const { code, lines } = await migrate(['--customer', B.id])
      expect(code).toBe(1)
      expect(lines.join('\n')).toMatch(new RegExp(`MIGRATE-FAILED customer=${B.id} .*LEDGER_HASH_MISMATCH|MIGRATE-FAILED customer=${B.id} .*no longer match`))
    } finally {
      await sql`UPDATE idt.schema_migration SET sha256 = ${sha256} WHERE filename = '0001_idt_setup.sql'`
      await sql.end()
    }
    expect((await app.inject({ url: '/api/v1/tenancy/self', headers: edge(B.host, await iss.mint('realm-b')) })).statusCode).toBe(200)
  })

  it('migrate (all) with one of three failing: the others are migrated, the run exits non-zero naming the failed one', async () => {
    const C = others.find((c) => c.slug === 'cust-c')!
    const envName = C.ref.slice('env:'.length)
    const good = world.env[envName]!
    try {
      const { code, lines } = await migrate([], { [envName]: good.replace(/:[^:@]+@/, ':wrong-password@') })
      expect(code).toBe(1)
      expect(lines.filter((l) => l.startsWith('MIGRATE-RESULT')).map((l) => l.split(' ')[1])).toEqual(expect.arrayContaining([`customer=${A.id}`, `customer=${B.id}`]))
      expect(lines.join('\n')).toMatch(new RegExp(`MIGRATE-FAILED customer=${C.id}`))
      expect(lines.join('\n')).toMatch(new RegExp(`customer\\(s\\) failed: ${C.id}`))
    } finally {
      world.env[envName] = good
    }
  })

  it('a pgbouncer url is refused by the migrate job (POOLER_TARGET), nothing applied', async () => {
    const P = await createCustomer(world, 'cust-p', 'p.example.org')
    others.push(P)
    // its secret names the harness admin (the scratch PgBouncer authenticates only that user) on P's database
    world.env[P.ref.slice(4)] = url(kernelDatabaseOf(P.id))
    const { code, lines } = await migrate(['--customer', P.id], { GREMION_KERNEL_PG_DIRECT_URL: directBase({ pooler: true }) })
    expect(code).toBe(1)
    // the runner's POOLER_TARGET refusal reaches the operator by its message
    expect(lines.join('\n')).toMatch(new RegExp(`MIGRATE-FAILED customer=${P.id} .*not a direct Postgres connection`))
    expect(await ledgerOf(P)).toBeNull()
  })

  it('a customer whose migration lock is held elsewhere fails FAST (bounded lock wait, KERNEL_API_MIGRATE_LOCK_WAIT_MS) and the job continues with the next customer', async () => {
    const L = await createCustomer(world, 'cust-l', 'l.example.org')
    const M = await createCustomer(world, 'cust-m', 'm.example.org')
    others.push(L, M)
    const holder = connect(kernelDatabaseOf(L.id), { max: 1 })
    try {
      await holder`SELECT pg_advisory_lock(${ADVISORY_LOCKS.migration.classid}::int4, ${ADVISORY_LOCKS.migration.objid}::int4)`
      const t0 = Date.now()
      const { code, lines } = await migrate([], { KERNEL_API_MIGRATE_LOCK_WAIT_MS: '1500' })
      const text = lines.join('\n')
      expect(Date.now() - t0).toBeLessThan(45_000)
      expect(code).toBe(1)
      expect(text).toMatch(new RegExp(`MIGRATE-FAILED customer=${L.id} .*not granted within 1500 ms`))
      expect(text).toMatch(new RegExp(`MIGRATE-RESULT customer=${M.id} applied=[1-9]`))
      expect(await ledgerOf(L)).toBeNull()
      expect((await ledgerOf(M))?.length).toBeGreaterThan(0)
    } finally {
      await holder.end()
    }
  }, 90_000)

  it('a migration DDL stuck behind another transaction fails by lock_timeout (KERNEL_API_MIGRATE_DDL_LOCK_TIMEOUT_MS), nothing applied; then a clean rerun migrates', async () => {
    const N = await createCustomer(world, 'cust-n', 'n.example.org')
    others.push(N)
    const blocker = connect(kernelDatabaseOf(N.id), { max: 1 })
    try {
      // an uncommitted CREATE SCHEMA idt: the ledger's own CREATE SCHEMA waits on that transaction
      await blocker.unsafe('BEGIN; CREATE SCHEMA idt')
      const t0 = Date.now()
      const { code, lines } = await migrate(['--customer', N.id], { KERNEL_API_MIGRATE_DDL_LOCK_TIMEOUT_MS: '1000' })
      expect(Date.now() - t0).toBeLessThan(45_000)
      expect(code).toBe(1)
      expect(lines.join('\n')).toMatch(new RegExp(`MIGRATE-FAILED customer=${N.id} .*lock timeout`))
    } finally {
      await blocker.unsafe('ROLLBACK').catch(() => {})
      await blocker.end()
    }
    expect(await ledgerOf(N)).toBeNull()
    expect((await migrate(['--customer', N.id])).code).toBe(0)
  }, 90_000)

  it('a malformed bound is refused before anything is migrated', async () => {
    const { code, lines } = await migrate([], { KERNEL_API_MIGRATE_LOCK_WAIT_MS: 'soon' })
    expect(code).toBe(1)
    expect(lines.join('\n')).toMatch(/KERNEL_API_MIGRATE_LOCK_WAIT_MS="soon" is not a whole number/)
  })
})

describe('isolation on PG18 (Q3, TDD 5, TDD 13)', () => {
  it("A's resolved connection reads A's sentinel only; A's ref aimed at B's database is refused; _app's owner membership recorded (TASK-192)", async () => {
    for (const c of [A, B]) {
      const sql = connect(kernelDatabaseOf(c.id), { max: 1 })
      await sql.unsafe(`CREATE TABLE IF NOT EXISTS public.t077_sentinel (v text); TRUNCATE public.t077_sentinel; INSERT INTO public.t077_sentinel VALUES ('${c.slug}'); GRANT SELECT ON public.t077_sentinel TO k_${c.id.replaceAll('-', '')}_app`)
      await sql.end()
    }
    const refs = new Map([
      [A.id, A.ref],
      [B.id, B.ref],
    ])
    const store = createTenantStore({ resolveTarget: kernelTargetResolver({ refOf: (id) => refs.get(id), resolveSecret: createSecretResolver({ env: world.env, allowEnvRefs: true }) }), prepare: false })
    try {
      const a = await store.openTenantDb(A.id, 'kernel')
      expect(await a`SELECT v FROM public.t077_sentinel`).toEqual([{ v: 'cust-a' }])
      const b = await store.openTenantDb(B.id, 'kernel')
      expect(await b`SELECT v FROM public.t077_sentinel`).toEqual([{ v: 'cust-b' }])
      refs.set(A.id, B.ref)
      const fresh = createTenantStore({ resolveTarget: kernelTargetResolver({ refOf: (id) => refs.get(id), resolveSecret: createSecretResolver({ env: world.env, allowEnvRefs: true }) }) })
      await expect(fresh.openTenantDb(A.id, 'kernel')).rejects.toThrow(/does not name database/)
      await fresh.close()
    } finally {
      await store.close()
    }
    const hex = A.id.replaceAll('-', '')
    const [m] = await world.admin<{ member: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM pg_auth_members x JOIN pg_roles o ON o.oid = x.roleid JOIN pg_roles a ON a.oid = x.member
                     WHERE o.rolname = ${`k_${hex}_owner`} AND a.rolname = ${`k_${hex}_app`}) AS member`
    // Q3 named deviation (TASK-192): the runtime role still inherits the owner.
    expect(m).toEqual({ member: true })
  })

  it('TRD-082 on PG18: every query a request round issues through the reader pools is customer-scoped or pinned exemption 1', async () => {
    const records: RecordedQuery[] = []
    const control = recordingSql(records, connect('t077_control', { user: 't077_kernel_api_reader', password: new URL(world.readerControlUrl).password ? decodeURIComponent(new URL(world.readerControlUrl).password) : '' }))
    const platform = recordingSql(records, connect('gremion_platform', { user: 't077_kernel_api_reader', password: decodeURIComponent(new URL(world.readerPlatformUrl).password) }))
    const recApp = buildApp({}, { ...wired.deps, tenancy: controlTenancyStore(control), registry: platformRegistryStore(platform) })
    try {
      for (const [c, realm] of [
        [A, 'realm-a'],
        [B, 'realm-b'],
      ] as const) {
        expect((await recApp.inject({ url: '/api/v1/modules', headers: edge(c.host, await iss.mint(realm)) })).statusCode).toBe(200)
      }
      expect((await recApp.inject({ url: '/api/v1/tenancy/self', headers: edge('unbound.example', await iss.mint('realm-a')) })).statusCode).toBe(404)
    } finally {
      await recApp.close()
      await (control as unknown as { end(): Promise<void> }).end()
      await (platform as unknown as { end(): Promise<void> }).end()
    }
    // exemption 3 belongs to the migrate job (unit-tested); here only 1 is in play
    expect(scopeProblems(records, [A.id, B.id], [{ id: '1', pattern: /WHERE d\.host = \$1$/ }])).toEqual([])
    expect(records.length).toBeGreaterThanOrEqual(5)
  })
})
