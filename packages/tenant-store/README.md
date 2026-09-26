# @gremion/tenant-store

The only way into a tenant database, and the one migration runner for it.

Under D13 every (tenant, module) pair has its own database,
`t_<tenant uuid as 32 hex>__<module>`, on that module's Postgres 18 server
(D14). This package opens those databases (TRD-426: nothing else may), and
migrates them with one runner (DL-001) that replaces the per-leaf ledgers.

```ts
import { openMigrationDb, openTenantDb, runMigrations, schemaGate } from '@gremion/tenant-store'

// runtime: a pooled, pooler-safe (prepare:false) connection per (tenant, module)
const sql = await openTenantDb(tenantId, 'calendar')

// deploy time, NOT at boot or on a request: a DIRECT connection
const direct = await openMigrationDb(tenantId, 'calendar') // GREMION_CALENDAR_PG_DIRECT_URL
try {
  await runMigrations({ sql: direct, dir: '/app/migrations', hooks: { preApply } })
} finally {
  await direct.end()
}

// in front of every tenant route: 503 for a tenant whose database is behind
const gate = schemaGate({ dir: '/app/migrations', openDb: (t) => openTenantDb(t, 'calendar') })
if (!(await gate.guard(tenantId, res))) return
```

## What it exports

| export | what |
| --- | --- |
| `openTenantDb(tenant, module)` | a pool from a process-wide LRU over `@gremion/db`'s `createDb`, keyed on the (tenant, module) **pair**; `createTenantStore(options)` builds a store with its own resolver / limits. An evicted pool is ended only after `evictGraceMs` (default 30 s), since a caller may still hold it |
| `openMigrationDb(tenant, module)` | a direct, unpooled connection for the runner (`GREMION_<MODULE>_PG_DIRECT_URL`); the caller ends it |
| `tenantModuleDbName(tenant, module)` | the database name; the one name TASK-021 uses to create databases |
| `envResolveTarget(env)` | the default resolver (below) |
| `runMigrations({ sql, dir, hooks })` | the runner |
| `checkSchemaCurrent({ sql, dir })`, `schemaGate(options)` | the read-only runtime check, and the 503 gate on top of it |
| `stripOuterTransaction(text)` | the whole-file wrapper rule |
| `ADVISORY_LOCKS`, `ADVISORY_LOCK_CLASS_ID` | the advisory-lock registry |

This package never creates or drops a database: that is TASK-021's
provisioner.

## Names and targets (Q2)

The tenant id must be a canonical lowercase **UUIDv7** (the control registry
issues `uuidv7()` ids since TASK-019). A module id matches
`[a-z][a-z0-9]*(_[a-z0-9]+)*` — no `__`, so the separator is unambiguous —
and the whole name stays inside `[a-z0-9_]` and 63 bytes (27 bytes of module
id at most); anything else throws before a resolver or a database sees it.

A target is resolved by an injected `resolveTarget(tenantId, moduleId) ->
{ url }`. The default reads `GREMION_<MODULE>_PG_URL` (the module server as
runtime pools reach it, a pooler allowed) — or, for `openMigrationDb`,
`GREMION_<MODULE>_PG_DIRECT_URL`, with no fallback — and replaces its
database with the name. The control-registry lookup arrives with TASK-077.
Whatever the resolver, its answer must name exactly that database, name its
host and user (no `PGHOST`/`PGUSER`/`PGPASSWORD` fallback), carry no
fragment, and may carry only `sslmode=require|verify-ca|verify-full`,
`sslrootcert=system`, `target_session_attrs=read-write|primary` and a plain
`application_name` in its query: postgres-js forwards any other query
parameter as a startup parameter, and `database=`, `role=`, `options=` or
`search_path=` would move the connection.

## The runner

One reserved connection (`sql.reserve()`) for the whole run, from a pool of
at least two (the second is how the runner terminates the first if it can
never release its lock; `openMigrationDb` opens such a pool):

1. refuse a pooler (below);
2. `pg_advisory_lock(ADVISORY_LOCKS.migration)` — **before** the ledger is read.
   The wait is bounded (`lockWaitTimeoutMs`, default 10 minutes, then
   `LOCK_TIMEOUT`) and logs who holds the lock;
3. verify the **whole** manifest: every `*.sql` file has an entry, every
   entry has a file, every sha256 matches; prepare every pending body;
4. read `public.schema_migrations` without DDL, and check it against the
   manifest: a ledger row whose file is gone, or whose recorded sha256 no
   longer matches the file (tamper after apply), aborts;
5. refuse a pending file that sorts below the highest applied one (Q4);
6. per pending file: `hooks.preApply(file, ctx)` under the lock and outside a
   transaction, then one transaction holding the file's body and its ledger
   row (G-078); the lock is re-proved inside the transaction before that row
   is written. The ledger table is created inside the first file's
   transaction, so a run with nothing pending executes no DDL at all.
   `ddlLockTimeoutMs` sets a `LOCAL lock_timeout` per file. Session state a
   body sets (`SET ROLE`, `search_path`, …) is reset after its COMMIT, and
   whatever `preApply` set is reset before release, even when it threw
   (temp tables, `LISTEN`, prepared statements and held cursors are not
   session settings and are not reset: a migration must not leave them);
7. `pg_advisory_unlock` in `finally`, then release the connection — unless
   the unlock or a ROLLBACK failed: then the backend is terminated from
   another connection, so a connection still holding the lock never goes
   back to the pool.

Nothing in steps 1–5 executes DDL. Every failure is a `MigrationManifestError`
(with a code per problem) or a `MigrationRunnerError` with a `code` and the
files concerned.

**Manifest (TRD-353, unchanged).** `<dir>/manifest.json` is
`{ "<file>.sql": "<sha256 hex of the bytes>" }`, as
`gremion-ui/scripts/build-migration-manifest.mjs` writes it.

**Ledger.** `public.schema_migrations (filename text PRIMARY KEY, sha256 text
NOT NULL, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())`. It is a
new ledger per (tenant, module) database; D13 re-initialises from zero, so
there is no older ledger to convert (one without the sha256 column is refused
as `LEDGER_FORMAT`).

**`hooks.preApply`** (TASK-029, TASK-075) receives the lock-holding
connection, the directory, and the applied and pending sets. If it throws,
the run aborts with `PRE_APPLY_FAILED`: that file and every later one are
not applied; files this run applied before it stay applied (each file is
its own transaction). A throw on the first pending file therefore applies
nothing.

**Whole-file wrapper (B22).** A file that carries its own `BEGIN; … COMMIT;`
(finance, calendar's `001_init.sql`, kernel 041/043) would end the runner's
transaction early, so the wrapper is removed: only the first and the last
top-level statement of the whole file can be it. The file is scanned into
statements with comments, strings, quoted identifiers, dollar quotes and
`BEGIN ATOMIC … END` bodies skipped, so a plpgsql `BEGIN` inside `DO $$ … $$`
is never touched (B22's `/im` regex did touch it). Any other top-level
transaction control (`COMMIT`, `ROLLBACK`, `SAVEPOINT`, `SET TRANSACTION`, …)
is refused, and the runner also compares the transaction id after each body.

**Poolers (Q3).** A session advisory lock does not survive PgBouncer
transaction pooling, so the runner connects directly to Postgres and refuses
a pooler. How it tells: the backend pid the server announced in the
protocol handshake (BackendKeyData, `result.state.pid` in postgres-js) must
equal `pg_backend_pid()` — a pooler answers the handshake itself, so they
differ (measured on PgBouncer 1.25.2, transaction mode: 1380295466 vs 72).
`SHOW pool_mode` answering is refused too, but is **not** a sufficient
signal on its own: PgBouncer forwards it to the server on an ordinary
connection, which answers 42704 exactly like direct Postgres (measured).
As defence in depth the runner re-proves, before and inside every file's
transaction, that the same backend still holds the lock. Runtime pools
(`openTenantDb`) may sit behind the pooler: they use `prepare: false`. The
integration suite proves both halves against a real PgBouncer.

**Out-of-order files (Q4).** The old back-fill notice is now a refusal: a
pending file that sorts below the highest applied file aborts
(`OUT_OF_ORDER`) naming every such file. Number the change after it.

**`moduleReenableCatchup` is dropped (2026-09-24).** Under D13 a module's
data lives in its own database; re-enabling a module creates a fresh
database, which the runner migrates from zero like any other. There is no
OFF→ON catch-up to plan inside a shared database any more.

## The runtime path

`checkSchemaCurrent` runs in a `READ ONLY` transaction: it cannot execute DDL
or write the ledger. It reports `current`, `behind` (files pending) or
`diverged` (the ledger disagrees with the manifest). `schemaGate` loads the
manifest once, caches a verdict per tenant within its module (a failed check
is never cached and is a 503 too), and answers `503` with `Retry-After` and a
body naming no file and no other tenant. A service never migrates at boot or
on a request; the runner, run at deploy time, brings a database current.

## The access scan (TRD-426)

`node packages/tenant-store/scripts/check-tenant-db-access.mjs` fails on
`postgres(`, `createDb(`, `new Pool(`, `new Client(` — and on a value import of
a driver (`postgres`, `pg`, `pg-pool`, `pg-native`, any subpath) or of
`createDb` from `@gremion/db` (renamed, namespace, default, re-export,
dynamic), so an alias is caught too — anywhere outside this package, in
`.ts .tsx .mts .cts .js .jsx .mjs .cjs .svelte`. Comments are stripped by a
scanner that knows strings and regex literals, so neither a comment nor a
`/*` or `//` inside a string or a regex hides code. Not scanned:
`node_modules` anywhere; `dist`, `build`, `coverage` only at a package root;
dot-directories (no tracked source sits under one, measured 2026-09-25). The existing
sites are on `scripts/tenant-db-access.allow.json`, one dated row per file
with its exact call and import counts and the task that adopts it (TASK-021,
TASK-077, TASK-084); a new site in a listed file, a stale row, a malformed
row, or a scan of zero files fails. The `@gremion/db` factory is allowed by
rule.

## Tests

```sh
pnpm --filter @gremion/tenant-store test               # unit, no database
pnpm --filter @gremion/tenant-store test:integration   # the scratch stack
```

`test:integration` runs `test/harness/stack.mjs`: a checkout-unique, gitignored
`docker-compose.local-testdb.yml` (project `t020-<sha8>`) with one Postgres 18
service on the kernel's `x-module-postgres` image pin, and a digest-pinned
PgBouncer (transaction mode) in front of it for the Q3 spec; container,
volume and network named `t020-<sha8>-*`, published on loopback only on
free ports, asserted on `docker compose config` before `up`. It holds `control` (the kernel control
migrations, applied by this runner), two registered tenants, and
`t_<A>__fixture` / `t_<B>__fixture`. Teardown removes the container, volume and
network by name from a trap; it never runs `docker compose down` and never
prunes, and fails the run if anything is left behind (`T020_KEEP_STACK=1`
keeps them). DDL is observed through a `ddl_command_start` event trigger
that logs committed DDL and also counts through a sequence (never rolled
back), so DDL that ran and was rolled back is seen too; every spec has a
positive control.

Nothing runs these suites or the scan automatically yet: the Makefile lint
line is TASK-045's, and no CI workflow covers the package.

## Status

`0.1.0`, the contract is not frozen (see `@gremion/db`). AGPL-3.0-only.
