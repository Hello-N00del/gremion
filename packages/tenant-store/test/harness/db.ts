// packages/tenant-store/test/harness/db.ts — connection helpers for the
// integration specs. Every url goes through assertNonProductionDbUrl.
import { readFileSync } from 'node:fs'
import postgres from 'postgres'

export interface StackState {
  sha8: string
  port: number
  /** PgBouncer (transaction mode) in front of the same server. */
  poolerPort: number
  user: string
  password: string
  db: string
  /** TASK-021 G2: the module server `pgm` (label module:<moduleId>). */
  modulePort: number
  moduleContainer: string
  moduleId: string
  /** The generated compose file (the lifecycle specs read its labels). */
  composeFile: string
}

let cached: StackState | undefined

export function stack(): StackState {
  if (cached) return cached
  const path = process.env.T020_STATE
  if (!path) throw new Error('T020_STATE is unset: run the integration suite through `pnpm test:integration` (test/harness/stack.mjs)')
  const s = JSON.parse(readFileSync(path, 'utf8')) as StackState
  if (s.sha8 !== process.env.T020_SCRATCH) throw new Error('the scratch-stack state does not belong to this run')
  cached = s
  return s
}

/**
 * Fail closed unless `url` is this run's scratch server: 127.0.0.1, a port
 * the harness published (the server, or its PgBouncer), the harness's
 * throwaway user. Nothing else — not a
 * developer's local Postgres, not the kernel stack — is ever connected to.
 */
export function assertNonProductionDbUrl(url: string): void {
  const s = stack()
  let u: URL
  try {
    u = new URL(url)
  } catch {
    throw new Error('[t020] refusing an unparseable database url')
  }
  const ok =
    (u.protocol === 'postgres:' || u.protocol === 'postgresql:') &&
    u.hostname === '127.0.0.1' &&
    (u.port === String(s.port) || u.port === String(s.poolerPort) || u.port === String(s.modulePort)) &&
    decodeURIComponent(u.username) === s.user
  if (!ok) throw new Error(`[t020] refusing a database url that is not this run's scratch server (${u.hostname}:${u.port})`)
}

export function serverUrl(): string {
  const s = stack()
  return `postgres://${s.user}:${encodeURIComponent(s.password)}@127.0.0.1:${s.port}/${s.db}`
}

export function dbUrl(db: string): string {
  const u = new URL(serverUrl())
  u.pathname = `/${db}`
  const url = u.toString()
  assertNonProductionDbUrl(url)
  return url
}

/** The same database through the scratch PgBouncer (transaction pooling). */
export function poolerUrl(db: string): string {
  const u = new URL(dbUrl(db))
  u.port = String(stack().poolerPort)
  const url = u.toString()
  assertNonProductionDbUrl(url)
  return url
}

// postgres-js prefers these options over the url, which would slip past the check.
const TARGET_OPTIONS = ['host', 'hostname', 'port', 'path', 'database', 'db', 'user', 'username', 'socket'] as const

export function connect(db: string, opts: postgres.Options<{}> = {}) {
  const override = TARGET_OPTIONS.filter((k) => k in opts)
  if (override.length) throw new Error(`[t020] connect() refuses target overrides: ${override.join(', ')}`)
  return postgres(dbUrl(db), { max: 2, onnotice: () => {}, ...opts })
}

/** TASK-021 G2: `db` on the module server `pgm`, as the harness superuser. */
export function moduleDbUrl(db: string): string {
  const u = new URL(dbUrl(db))
  u.port = String(stack().modulePort)
  const url = u.toString()
  assertNonProductionDbUrl(url)
  return url
}

/** A connection to `db` on the module server; `role` sets the startup role (options=-c role=<role>). */
export function connectModule(db: string, opts: postgres.Options<{}> & { role?: string } = {}) {
  const { role, ...rest } = opts
  const override = TARGET_OPTIONS.filter((k) => k in rest)
  if (override.length) throw new Error(`[t020] connectModule() refuses target overrides: ${override.join(', ')}`)
  if (role !== undefined && !/^[a-z][a-z0-9_]{0,62}$/.test(role)) throw new Error(`[t020] refusing role ${JSON.stringify(role)}`)
  return postgres(moduleDbUrl(db), {
    max: 2,
    onnotice: () => {},
    ...rest,
    ...(role ? { connection: { ...rest.connection, options: `-c role=${role}` } } : {}),
  })
}

/** A LOGIN role's own connection to `db` on the module server (roles tests). */
export function connectModuleAs(db: string, user: string, password: string) {
  const u = new URL(moduleDbUrl(db))
  u.username = user
  u.password = encodeURIComponent(password)
  const url = u.toString()
  return postgres(url, { max: 1, onnotice: () => {}, connect_timeout: 5 })
}

/** The ledger's filenames; [] only when the table does not exist (42P01), any other error is thrown. */
export async function ledgerFiles(sql: postgres.Sql): Promise<string[]> {
  try {
    return (await sql<{ filename: string }[]>`SELECT filename FROM public.schema_migrations ORDER BY filename`).map((r) => r.filename)
  } catch (err) {
    if ((err as { code?: string }).code === '42P01') return []
    throw err
  }
}

/** Rows the DDL probe (a ddl_command_start event trigger) has logged — committed DDL only. */
export async function ddlLog(sql: postgres.Sql): Promise<{ tag: string }[]> {
  return sql<{ tag: string }[]>`SELECT tag FROM t020_probe.ddl_log ORDER BY id`
}

/**
 * Every DDL command the probe has SEEN, rolled back or not: the trigger also
 * draws from a sequence, and nextval() is never rolled back. So a runner that
 * ran DDL inside a transaction and then rolled it back still moves this.
 */
export async function ddlAttempts(sql: postgres.Sql): Promise<number> {
  const [r] = await sql<{ n: string }[]>`SELECT CASE WHEN is_called THEN last_value ELSE 0 END AS n FROM t020_probe.ddl_seq`
  return Number(r!.n)
}

/**
 * Returns `db` to an empty public schema, then (re)installs the probe: an
 * event trigger on ddl_command_start that logs every DDL command's tag into
 * t020_probe.ddl_log. Test-side DDL; the probe itself is created before its
 * trigger exists, so the log starts empty.
 */
export async function resetWithProbe(db: string): Promise<void> {
  const sql = connect(db, { max: 1 })
  try {
    await sql.unsafe(`
      DROP EVENT TRIGGER IF EXISTS t020_ddl_probe;
      DROP SCHEMA IF EXISTS t020_probe CASCADE;
      DROP SCHEMA public CASCADE;
      CREATE SCHEMA public;
      CREATE SCHEMA t020_probe;
      CREATE TABLE t020_probe.ddl_log (
        id bigserial PRIMARY KEY,
        tag text NOT NULL,
        pid int NOT NULL DEFAULT pg_backend_pid(),
        at timestamptz NOT NULL DEFAULT clock_timestamp()
      );
      CREATE SEQUENCE t020_probe.ddl_seq;
      CREATE FUNCTION t020_probe.log_ddl() RETURNS event_trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM nextval('t020_probe.ddl_seq');
        INSERT INTO t020_probe.ddl_log (tag) VALUES (tg_tag);
      END
      $$;
      CREATE EVENT TRIGGER t020_ddl_probe ON ddl_command_start EXECUTE FUNCTION t020_probe.log_ddl();
    `)
  } finally {
    await sql.end()
  }
}
