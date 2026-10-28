// TRD-149/150/151 on Postgres 18 (the scratch stack): seeded kernel and module
// tables -> CSV + JSON per table, manifest.json with sha256 and row counts,
// excluded systems with reasons, and a completeness check that fails naming
// the file when one is deleted, emptied or altered before the check.
import { existsSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connectExportReader, ensureExportReader, exportTenant, ExportError, KERNEL_EXPORT_TABLES, retireExportReader, type ExportReaderCredentials } from '../../src/export/index.js'
import { runVerify } from '../../src/export/cli.js'
import { verifyExport } from '../../src/export/verify.js'
import { connect, connectAs, dbUrl, stack } from '../harness/db.js'

const SCRATCH = join(fileURLToPath(new URL('../../../../', import.meta.url)), '.scratch', `trd149-${process.pid}`)
const KERNEL_DB = 'trd149_kernel'
const MOD_DB = 'trd149_finance'
/** A scratch tenant database whose owner planted a cast (HIGH-1). */
const EVIL_DB = 'trd149_evil'
/** A module database whose migrations created no table (HIGH-2: must fail, not pass as exported). */
const EMPTY_DB = 'trd149_empty'
/** A tenant database whose owner set ALTER DATABASE ... SET search_path and planted public.=(oid,oid) (HIGH-1: reader hijack). */
const PLANT_DB = 'trd149_planted'
/** Databases with PUBLIC's CONNECT revoked, as the tenant databases are: only an explicit grant lets the reader in. */
const RUN_DB = 'trd149_run'
const OTHER_DB = 'trd149_other'
const SPARE_ROLE = 'trd149_spare_reader'
const TENANT_OWNER = 'trd149_tenant_owner'
const MARKER = `/tmp/trd149-pwned-${process.pid}`
let kernel: ReturnType<typeof connect>
let fin: ReturnType<typeof connect>
let reader: ExportReaderCredentials
const opened: postgres.Sql[] = []

/** `db` as the export reader (a NOSUPERUSER LOGIN role; the export refuses a superuser). */
function asReader(db: string) {
  const u = new URL(dbUrl(db))
  u.username = reader.user
  u.password = encodeURIComponent(reader.password)
  const s = connectExportReader(u.toString(), { max: 2 })
  opened.push(s)
  return s as unknown as ReturnType<typeof connect>
}
let n = 0
const fresh = () => join(SCRATCH, `out-${++n}`)

const modules = () => [
  { id: 'finance', runtimeExport: { kind: 'pg_dump', retentionProfile: 'rp-fin-module-data' }, enabled: true, sql: fin },
  { id: 'files', runtimeExport: null, enabled: false },
  { id: 'messaging', runtimeExport: null, enabled: false, platformServer: { postgresService: 'messaging-postgres', databases: ['synapse'] } },
  { id: 'board', runtimeExport: { kind: 'pg_dump', retentionProfile: 'rp-brd-module-data' }, enabled: false },
]

beforeAll(async () => {
  stack()
  mkdirSync(SCRATCH, { recursive: true })
  const admin = connect('t020_test_admin', { max: 1 })
  try {
    for (const db of [KERNEL_DB, MOD_DB, EVIL_DB, EMPTY_DB, PLANT_DB, RUN_DB, OTHER_DB]) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`)
      await admin.unsafe(`CREATE DATABASE ${db}`)
    }
    for (const db of [RUN_DB, OTHER_DB]) await admin.unsafe(`REVOKE CONNECT ON DATABASE ${db} FROM PUBLIC`)
    await admin.unsafe(`DROP ROLE IF EXISTS ${TENANT_OWNER}`)
    await admin.unsafe(`CREATE ROLE ${TENANT_OWNER} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE`)
    reader = await ensureExportReader(admin, { databases: [KERNEL_DB, MOD_DB, EVIL_DB, EMPTY_DB, PLANT_DB] })
  } finally {
    await admin.end()
  }
  // The tenant's owner role (k_app reaches it through membership) owns its
  // type, so it may CREATE CAST (mood AS text) WITH FUNCTION evil(): an export
  // that casts every column to text runs evil() as whoever is connected.
  const evil = connect(EVIL_DB, { max: 1 })
  try {
    await evil.unsafe(`
      GRANT CREATE ON SCHEMA public TO ${TENANT_OWNER};
      SET ROLE ${TENANT_OWNER};
      CREATE TABLE notes (id int PRIMARY KEY, body text);
      CREATE TYPE mood AS ENUM ('calm', 'loud');
      CREATE FUNCTION evil(m mood) RETURNS text LANGUAGE plpgsql AS $f$
      BEGIN
        COPY (SELECT 1) TO PROGRAM 'touch ${MARKER}';
        RETURN m::name::text;
      END
      $f$;
      CREATE CAST (mood AS text) WITH FUNCTION evil(mood);
      ALTER TABLE notes ADD COLUMN m mood;
      INSERT INTO notes VALUES (1, 'a', 'calm'), (2, 'b', 'loud');
      -- MED-1: names the tenant chose that are not file names.
      CREATE TABLE "../../../escaped" (id int PRIMARY KEY);
      INSERT INTO "../../../escaped" VALUES (1);
      CREATE TABLE "Members" ("Name" text PRIMARY KEY);
      INSERT INTO "Members" VALUES ('Ada');
      RESET ROLE;
    `)
  } finally {
    await evil.end()
  }
  // HIGH-1 (reader hijack): the owner sets the database's search_path to put public first and
  // plants public.=(oid,oid), the operator postgres-js's own type-fetch query (b.oid = a.typelem)
  // resolves. Run as the reader, it would set the reader's password to a value the tenant knows.
  const plant = connect(PLANT_DB, { max: 1 })
  try {
    await plant.unsafe(`
      GRANT CREATE ON SCHEMA public TO ${TENANT_OWNER};
      SET ROLE ${TENANT_OWNER};
      CREATE TABLE notes (id int PRIMARY KEY, body text);
      INSERT INTO notes VALUES (1, 'a');
      CREATE FUNCTION public.plant_oid_eq(a oid, b oid) RETURNS boolean LANGUAGE plpgsql AS $f$
      BEGIN
        IF current_setting('trd149.done', true) IS NULL THEN
          PERFORM set_config('trd149.done', '1', false);
          EXECUTE format('ALTER ROLE %I PASSWORD %L', current_user, 'known-to-the-tenant');
        END IF;
        RETURN pg_catalog.oideq(a, b);
      END
      $f$;
      CREATE OPERATOR public.= (LEFTARG = oid, RIGHTARG = oid, FUNCTION = public.plant_oid_eq);
      -- the role-name comparisons of the export's own pre-checks
      CREATE FUNCTION public.plant_name_eq(a name, b name) RETURNS boolean LANGUAGE plpgsql AS $f$
      BEGIN
        IF current_setting('trd149.done', true) IS NULL THEN
          PERFORM set_config('trd149.done', '1', false);
          EXECUTE format('ALTER ROLE %I PASSWORD %L', current_user, 'known-to-the-tenant');
        END IF;
        RETURN pg_catalog.nameeq(a, b);
      END
      $f$;
      CREATE OPERATOR public.= (LEFTARG = name, RIGHTARG = name, FUNCTION = public.plant_name_eq);
      CREATE FUNCTION public.plant_name_text_eq(a name, b text) RETURNS boolean LANGUAGE plpgsql AS $f$
      BEGIN
        IF current_setting('trd149.done', true) IS NULL THEN
          PERFORM set_config('trd149.done', '1', false);
          EXECUTE format('ALTER ROLE %I PASSWORD %L', current_user, 'known-to-the-tenant');
        END IF;
        RETURN pg_catalog.nameeqtext(a, b);
      END
      $f$;
      CREATE OPERATOR public.= (LEFTARG = name, RIGHTARG = text, FUNCTION = public.plant_name_text_eq);
      RESET ROLE;
    `)
    await plant.unsafe(`ALTER DATABASE ${PLANT_DB} SET search_path = public, pg_catalog`)
  } finally {
    await plant.end()
  }
  const seedKernel = connect(KERNEL_DB, { max: 1 })
  const seedFin = connect(MOD_DB, { max: 1 })
  await seedKernel.unsafe(`
    CREATE TABLE org_units (id int PRIMARY KEY, name text NOT NULL, note text);
    CREATE TABLE role_assignments (id int PRIMARY KEY, org_unit_id int, member text, since timestamptz, meta jsonb);
    CREATE TABLE protocols (id int PRIMARY KEY, title text);
    CREATE TABLE protocol_resolutions (id int PRIMARY KEY, protocol_id int, text text);
    CREATE TABLE config_store (k text PRIMARY KEY, v text);
    -- MED: tenant data in the kernel database that is in neither the export list nor the excluded list.
    CREATE TABLE calendar_events (id int PRIMARY KEY, title text);
    INSERT INTO calendar_events VALUES (1, 'Sitzung');
    CREATE TABLE schema_migrations (filename text PRIMARY KEY);
    CREATE SCHEMA extra;
    CREATE TABLE extra.board (id int PRIMARY KEY);
    INSERT INTO org_units VALUES (1, 'Vorstand', 'comma, "quote"' ), (2, 'Kasse', E'multi\nline'), (3, 'Leer', NULL);
    INSERT INTO role_assignments VALUES (1, 1, 'ada', '2026-01-02T03:04:05Z', '{"a":[1,2]}');
    INSERT INTO protocols VALUES (1, 'Sitzung 1');
    INSERT INTO protocol_resolutions VALUES (1, 1, 'Beschluss A'), (2, 1, 'Beschluss B');
    INSERT INTO config_store VALUES ('smtp_password', 'hunter2');
  `)
  await seedFin.unsafe(`
    CREATE TABLE schema_migrations (filename text PRIMARY KEY);
    CREATE TABLE invoices (id int PRIMARY KEY, amount numeric(12,2), payload bytea);
    CREATE TABLE empty_ledger (id int PRIMARY KEY);
    INSERT INTO schema_migrations VALUES ('0001.sql');
    INSERT INTO invoices VALUES (1, 12.50, '\\xdeadbeef'), (2, 99.00, NULL);
    -- HIGH-2: finance and content keep their tables in their own schema.
    CREATE SCHEMA finance;
    CREATE TABLE finance.receipt (id int PRIMARY KEY, amount numeric(12,2));
    INSERT INTO finance.receipt VALUES (1, 3.00), (2, 4.00);
  `)
  await seedKernel.end()
  await seedFin.end()
  kernel = asReader(KERNEL_DB)
  fin = asReader(MOD_DB)
})

afterAll(async () => {
  await Promise.all(opened.map((s) => s.end()))
  const admin = connect('t020_test_admin', { max: 1 })
  try {
    await retireExportReader(admin)
    await retireExportReader(admin, SPARE_ROLE)
    await admin.unsafe(`DROP OWNED BY ${SPARE_ROLE}`).catch(() => undefined)
    await admin.unsafe(`DROP ROLE IF EXISTS ${SPARE_ROLE}`)
  } finally {
    await admin.end()
  }
  rmSync(SCRATCH, { recursive: true, force: true })
})

const run = (outDir: string) =>
  exportTenant({ slug: 'acme', outDir, kernel, modules: modules(), kernelTables: ['org_units', 'role_assignments', 'protocols', 'protocol_resolutions'], now: () => new Date('2026-10-27T10:00:00Z') })

/** Whether the planted function ran: its marker file inside the kernel scratch server's container. */
function markerPresent(): boolean {
  const r = spawnSync('docker', ['exec', `t020-${stack().sha8}-pg`, 'test', '-e', MARKER])
  if (r.status !== 0 && r.status !== 1) throw new Error(`docker exec failed: ${r.stderr.toString()}`)
  return r.status === 0
}

describe('tenant export (TRD-149/150/151)', () => {
  it('HIGH-1: a cast planted by the tenant owner on its own type never runs (the export casts nothing and is never a superuser)', async () => {
    // As the server's superuser: refused before any tenant table is read.
    const su = connect(EVIL_DB, { max: 1 })
    try {
      await expect(exportTenant({ slug: 'acme', outDir: fresh(), kernel: su, modules: [], kernelTables: ['notes'] })).rejects.toThrow(/superuser/)
    } finally {
      await su.end()
    }
    expect(markerPresent()).toBe(false)
    // As the export reader: complete, the enum rendered by the server, evil() never called.
    const dir = fresh()
    const { verify } = await exportTenant({ slug: 'acme', outDir: dir, kernel: asReader(EVIL_DB), modules: [], kernelTables: ['notes'] })
    expect(verify.ok).toBe(true)
    expect(markerPresent()).toBe(false)
    expect(readFileSync(join(dir, 'kernel/notes.csv'), 'utf8')).toBe('id,body,m\r\n1,a,calm\r\n2,b,loud\r\n')
  })

  it('HIGH-1: a tenant that plants public.=(oid,oid) and ALTER DATABASE SET search_path never runs code as the reader (the reader pool pins search_path and fetches no types)', async () => {
    const admin = connect('t020_test_admin', { max: 1 })
    const verifier = async () => (await admin<{ v: string | null }[]>`SELECT rolpassword AS v FROM pg_authid WHERE rolname = ${reader.user}`)[0]!.v
    try {
      const before = await verifier()
      expect(before).toMatch(/^SCRAM-SHA-256[$]/)
      const dir = fresh()
      const { verify } = await exportTenant({ slug: 'acme', outDir: dir, kernel: asReader(PLANT_DB), modules: [], kernelTables: ['notes'] })
      expect(verify.ok).toBe(true)
      expect(readFileSync(join(dir, 'kernel/notes.csv'), 'utf8')).toBe('id,body\r\n1,a\r\n')
      // Post-condition: the planted function did not run (it would have replaced the verifier) and left no role setting.
      expect(await verifier()).toBe(before)
      const [cfg] = await admin<{ c: string[] | null }[]>`SELECT rolconfig AS c FROM pg_roles WHERE rolname = ${reader.user}`
      expect(cfg!.c).toBeNull()
    } finally {
      await admin.end()
    }
  })

  it('HIGH-1: even a caller that forgot to pin search_path (fetch_types off) cannot be hijacked: the export sets it before its first query', async () => {
    const admin = connect('t020_test_admin', { max: 1 })
    const verifier = async () => (await admin<{ v: string | null }[]>`SELECT rolpassword AS v FROM pg_authid WHERE rolname = ${reader.user}`)[0]!.v
    const u = new URL(dbUrl(PLANT_DB))
    u.username = reader.user
    u.password = encodeURIComponent(reader.password)
    const unpinned = postgres(u.toString(), { max: 1, onnotice: () => {}, connect_timeout: 5, fetch_types: false, connection: { search_path: 'public, pg_catalog' } })
    opened.push(unpinned)
    try {
      const before = await verifier()
      const { verify } = await exportTenant({ slug: 'acme', outDir: fresh(), kernel: unpinned as unknown as ReturnType<typeof connect>, modules: [], kernelTables: ['notes'] })
      expect(verify.ok).toBe(true)
      expect(await verifier()).toBe(before)
    } finally {
      await admin.end()
    }
  })

  it('HIGH-1: ensure revokes CONNECT it granted before and resets role settings; retire revokes CONNECT, resets settings and ends the reader sessions', async () => {
    const admin = connect('t020_test_admin', { max: 1 })
    const can = async (db: string) => (await admin<{ ok: boolean }[]>`SELECT has_database_privilege(${SPARE_ROLE}, ${db}, 'CONNECT') AS ok`)[0]!.ok
    const cfg = async () => (await admin<{ c: string[] | null }[]>`SELECT rolconfig AS c FROM pg_roles WHERE rolname = ${SPARE_ROLE}`)[0]!.c
    try {
      // A previous run left CONNECT on OTHER_DB and a role setting behind.
      await ensureExportReader(admin, { databases: [OTHER_DB], role: SPARE_ROLE })
      expect(await can(OTHER_DB)).toBe(true)
      await admin.unsafe(`ALTER ROLE ${SPARE_ROLE} SET search_path = public`)
      await admin.unsafe(`ALTER ROLE ${SPARE_ROLE} IN DATABASE ${OTHER_DB} SET search_path = public`)
      // This run covers RUN_DB only: OTHER_DB is no longer reachable, the settings are gone.
      const creds = await ensureExportReader(admin, { databases: [RUN_DB], role: SPARE_ROLE })
      expect(await can(OTHER_DB)).toBe(false)
      expect(await can(RUN_DB)).toBe(true)
      expect(await cfg()).toBeNull()
      expect(await admin`SELECT 1 FROM pg_db_role_setting s JOIN pg_roles r ON r.oid = s.setrole WHERE r.rolname = ${SPARE_ROLE}`).toHaveLength(0)
      // A live session of the reader, with a setting the tenant (as the reader) made.
      const live = connectAs(RUN_DB, creds.user, creds.password)
      try {
        await live.unsafe(`ALTER ROLE ${SPARE_ROLE} SET search_path = public`)
        expect(await live`SELECT 1 AS one`).toHaveLength(1)
        await retireExportReader(admin, SPARE_ROLE)
        expect(await can(RUN_DB)).toBe(false)
        expect(await can(OTHER_DB)).toBe(false)
        expect(await cfg()).toBeNull()
        let left = 1
        for (let i = 0; i < 40 && left > 0; i++) {
          left = (await admin<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = ${SPARE_ROLE}`)[0]!.n
          if (left > 0) await new Promise((r) => setTimeout(r, 100))
        }
        expect(left).toBe(0)
      } finally {
        await live.end({ timeout: 1 }).catch(() => undefined)
      }
      const [pw] = await admin<{ v: string | null }[]>`SELECT rolpassword AS v FROM pg_authid WHERE rolname = ${SPARE_ROLE}`
      expect(pw!.v).toBeNull()
    } finally {
      await admin.end()
    }
  })

  it('HIGH-1: the export reader is LOGIN NOSUPERUSER and cannot become a superuser', async () => {
    const admin = connect('t020_test_admin', { max: 1 })
    try {
      const [r] = await admin<{ rolsuper: boolean; rolcreaterole: boolean; rolcanlogin: boolean; rolbypassrls: boolean; supermember: boolean }[]>`
        SELECT rolsuper, rolcreaterole, rolcanlogin, rolbypassrls,
               EXISTS (SELECT 1 FROM pg_roles s WHERE s.rolsuper AND pg_has_role(r.oid, s.oid, 'MEMBER')) AS supermember
          FROM pg_roles r WHERE rolname = ${reader.user}`
      expect(r).toEqual({ rolsuper: false, rolcreaterole: false, rolcanlogin: true, rolbypassrls: true, supermember: false })
    } finally {
      await admin.end()
    }
  })

  it('writes CSV and JSON per table, and a manifest whose sha256 and row counts match the bytes on disk', async () => {
    const dir = fresh()
    const { manifest, verify } = await run(dir)
    expect(verify).toMatchObject({ ok: true, problems: [] })
    expect(manifest).toMatchObject({ schema_version: 1, tenant: { slug: 'acme' }, generated_at: '2026-10-27T10:00:00.000Z' })
    const paths = manifest.files.map((f) => f.path)
    expect(paths).toEqual([
      'finance/empty_ledger.csv', 'finance/empty_ledger.json', 'finance/finance.receipt.csv', 'finance/finance.receipt.json', 'finance/invoices.csv', 'finance/invoices.json',
      'kernel/org_units.csv', 'kernel/org_units.json', 'kernel/protocol_resolutions.csv', 'kernel/protocol_resolutions.json',
      'kernel/protocols.csv', 'kernel/protocols.json', 'kernel/role_assignments.csv', 'kernel/role_assignments.json',
    ])
    for (const f of manifest.files) {
      const buf = readFileSync(join(dir, f.path))
      expect(createHash('sha256').update(buf).digest('hex')).toBe(f.sha256)
      expect(buf.length).toBe(f.bytes)
      expect(statSync(join(dir, f.path)).mode & 0o777).toBe(0o600)
    }
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(statSync(join(dir, 'manifest.json')).mode & 0o777).toBe(0o600)
    expect(manifest.files.find((f) => f.path === 'kernel/org_units.json')!.rows).toBe(3)
    expect(manifest.csv_formula_guard).toMatch(/apostrophe/)
    expect(manifest.files.find((f) => f.path === 'finance/empty_ledger.csv')!.rows).toBe(0)
    // RFC 4180 quoting; null is an empty field; timestamps are ISO; bytea base64
    expect(readFileSync(join(dir, 'kernel/org_units.csv'), 'utf8')).toBe(
      'id,name,note\r\n1,Vorstand,"comma, ""quote"""\r\n2,Kasse,"multi\nline"\r\n3,Leer,\r\n',
    )
    expect(JSON.parse(readFileSync(join(dir, 'kernel/role_assignments.json'), 'utf8'))).toEqual([
      { id: 1, org_unit_id: 1, member: 'ada', since: '2026-01-02T03:04:05.000Z', meta: { a: [1, 2] } },
    ])
    expect(readFileSync(join(dir, 'finance/invoices.csv'), 'utf8')).toContain('1,12.50,3q2+7w==')
    // the on-disk manifest is the one that was verified
    expect(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))).toEqual(manifest)
  })

  it('lists modules without export (or not enabled), Nextcloud and Matrix, and withheld tables, each with a reason', async () => {
    const { manifest } = await run(fresh())
    const mod = (id: string) => manifest.modules.find((m) => m.id === id)!
    expect(mod('finance')).toEqual({ id: 'finance', status: 'exported' })
    expect(mod('files')).toMatchObject({ status: 'excluded', reason: expect.stringContaining('no runtime.export') })
    expect(mod('board')).toMatchObject({ status: 'excluded', reason: expect.stringContaining('not enabled') })
    const systems = manifest.excluded_systems.map((s) => s.system)
    expect(systems).toEqual(expect.arrayContaining(['nextcloud-files', 'matrix-history', 'messaging:messaging-postgres/synapse']))
    for (const s of manifest.excluded_systems) expect(s.reason.length).toBeGreaterThan(10)
    expect(manifest.excluded_tables).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: 'kernel', table: 'config_store' }),
        expect.objectContaining({ scope: 'finance', table: 'schema_migrations' }),
      ]),
    )
    expect(JSON.stringify(manifest)).not.toContain('hunter2')
  })

  it('MED: every kernel table that is not exported is named in excluded_tables with a reason (none is dropped silently)', async () => {
    const dir = fresh()
    const { manifest, verify } = await run(dir)
    expect(verify.ok).toBe(true)
    const kernelExcluded = manifest.excluded_tables.filter((e) => e.scope === 'kernel')
    const key = (e: { schema?: string; table: string }) => `${e.schema}.${e.table}`
    // the seeded kernel tables are 4 exported + config_store + calendar_events + extra.board + the migration ledger
    expect(kernelExcluded.map(key).sort()).toEqual(['extra.board', 'public.calendar_events', 'public.config_store', 'public.schema_migrations'])
    for (const e of kernelExcluded) expect(e.reason.length).toBeGreaterThan(10)
    expect(kernelExcluded.find((e) => e.table === 'calendar_events')!.reason).toMatch(/not exported|not in the/)
    // no table is both exported and excluded
    const exported = new Set(manifest.files.filter((f) => f.scope === 'kernel').map((f) => `${f.schema ?? 'public'}.${f.table}`))
    for (const e of kernelExcluded) expect(exported.has(key(e))).toBe(false)
    // and the data of an excluded table is not in the files
    expect(manifest.files.some((f) => f.table === 'calendar_events')).toBe(false)
  })

  it('the check fails, naming the file, when a written file is deleted before it', async () => {
    const dir = fresh()
    await run(dir)
    rmSync(join(dir, 'kernel/protocols.json'))
    const r = verifyExport(dir)
    expect(r.ok).toBe(false)
    expect(r.problems).toEqual([{ path: 'kernel/protocols.json', code: 'MISSING', detail: expect.any(String) }])
    const err: string[] = []
    expect(runVerify(['verify', dir], { out: () => {}, err: (l) => err.push(l) })).toBe(1)
    expect(err.join('\n')).toContain('kernel/protocols.json')
  })

  it('the check fails on an emptied, altered, or unlisted file', async () => {
    const dir = fresh()
    await run(dir)
    truncateSync(join(dir, 'kernel/org_units.csv'), 0)
    writeFileSync(join(dir, 'finance/invoices.json'), '[]\n')
    writeFileSync(join(dir, 'finance/stray.csv'), 'x')
    const codes = (path: string) => verifyExport(dir).problems.filter((p) => p.path === path).map((p) => p.code)
    expect(codes('kernel/org_units.csv')).toContain('EMPTY')
    expect(codes('finance/invoices.json')).toEqual(expect.arrayContaining(['SIZE_MISMATCH', 'SHA_MISMATCH']))
    expect(codes('finance/stray.csv')).toEqual(['UNLISTED'])
  })

  it('fails when manifest.json is gone, and refuses a non-empty output directory', async () => {
    const dir = fresh()
    await run(dir)
    await expect(run(dir)).rejects.toBeInstanceOf(ExportError)
    rmSync(join(dir, 'manifest.json'))
    expect(verifyExport(dir).problems[0]).toMatchObject({ path: 'manifest.json', code: 'MANIFEST_MISSING' })
    expect(existsSync(join(dir, 'kernel/org_units.csv'))).toBe(true)
  })

  it('HIGH-2: tables in a module\'s own schema are exported (schema-qualified files), and a module that yields no table fails the export', async () => {
    const dir = fresh()
    const { manifest } = await run(dir)
    const receipt = manifest.files.find((f) => f.path === 'finance/finance.receipt.json')!
    expect(receipt).toMatchObject({ scope: 'finance', schema: 'finance', table: 'receipt', rows: 2 })
    expect(readFileSync(join(dir, 'finance/finance.receipt.csv'), 'utf8')).toBe('id,amount\r\n1,3.00\r\n2,4.00\r\n')
    const empty = { id: 'content', runtimeExport: { kind: 'pg_dump', retentionProfile: 'rp-pub-module-data' }, enabled: true, sql: asReader(EMPTY_DB) }
    await expect(exportTenant({ slug: 'acme', outDir: fresh(), kernel, modules: [empty], kernelTables: ['org_units'] })).rejects.toThrow(/content.*no table/)
  })

  it('MED-1: a table name is never a path: ../ and capitals become file-safe names inside --out, the export completes', async () => {
    const escaped = join(SCRATCH, '..', 'escaped.csv')
    rmSync(escaped, { force: true })
    rmSync(join(SCRATCH, '..', 'escaped.json'), { force: true })
    const dir = fresh()
    const board = { id: 'board', runtimeExport: { kind: 'pg_dump', retentionProfile: 'rp-brd-module-data' }, enabled: true, sql: asReader(EVIL_DB) }
    const { manifest, verify } = await exportTenant({ slug: 'acme', outDir: dir, kernel, modules: [board], kernelTables: ['org_units'] })
    expect(existsSync(escaped)).toBe(false)
    expect(verify).toMatchObject({ ok: true, problems: [] })
    const byTable = (t: string) => manifest.files.filter((f) => f.scope === 'board' && f.table === t).map((f) => f.path)
    expect(byTable('../../../escaped')).toEqual(['board/-2e-2e-2f-2e-2e-2f-2e-2e-2fescaped.csv', 'board/-2e-2e-2f-2e-2e-2f-2e-2e-2fescaped.json'])
    expect(byTable('Members')).toEqual(['board/-4dembers.csv', 'board/-4dembers.json'])
    expect(readFileSync(join(dir, 'board/-4dembers.csv'), 'utf8')).toBe('Name\r\nAda\r\n')
  })

  it('MED-3: a module\'s withhold declaration keeps tables and columns out of the files and lists them in the manifest', async () => {
    const dir = fresh()
    const fin2 = { id: 'finance', runtimeExport: { kind: 'pg_dump', retentionProfile: 'rp-fin-module-data', withhold: ['public.empty_ledger', 'public.invoices.payload'] }, enabled: true, sql: fin }
    const { manifest, verify } = await exportTenant({ slug: 'acme', outDir: dir, kernel, modules: [fin2], kernelTables: ['org_units'] })
    expect(verify.ok).toBe(true)
    const paths = manifest.files.map((f) => f.path)
    expect(paths).not.toContain('finance/empty_ledger.csv')
    expect(readFileSync(join(dir, 'finance/invoices.csv'), 'utf8')).toBe('id,amount\r\n1,12.50\r\n2,99.00\r\n')
    expect(readFileSync(join(dir, 'finance/invoices.json'), 'utf8')).not.toContain('payload')
    expect(manifest.excluded_tables).toEqual(expect.arrayContaining([expect.objectContaining({ scope: 'finance', schema: 'public', table: 'empty_ledger', reason: expect.stringContaining('withhold') })]))
    expect(manifest.excluded_columns).toEqual([expect.objectContaining({ scope: 'finance', schema: 'public', table: 'invoices', column: 'payload', reason: expect.stringContaining('withhold') })])
    // a declaration that names nothing fails visibly (a renamed secret column must not slip out)
    const typo = { ...fin2, runtimeExport: { ...fin2.runtimeExport, withhold: ['public.invoices.paylod'] } }
    await expect(exportTenant({ slug: 'acme', outDir: fresh(), kernel, modules: [typo], kernelTables: ['org_units'] })).rejects.toThrow(/paylod/)
  })

  it('a declared kernel table that does not exist fails the export visibly', async () => {
    await expect(exportTenant({ slug: 'acme', outDir: fresh(), kernel, modules: [], kernelTables: ['org_units', 'no_such_table'] })).rejects.toThrow(/no_such_table/)
  })

  it('the default kernel list is only names this package may quote', () => {
    for (const t of KERNEL_EXPORT_TABLES) expect(t).toMatch(/^[a-z][a-z0-9_]*$/)
  })
})
