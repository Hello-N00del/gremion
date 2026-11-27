#!/usr/bin/env node
// modules/calendar/scripts/move-to-lifecycle-db.mjs
//
// Operator script: move the calendar data of each existing customer from the earlier per-customer database
// calendar_<slug> into the database the module lifecycle owns, t_<tenant uuid as 32 hex>__calendar.
//
// Why. The calendar leaf used to keep each customer in calendar_<slug>, a database it created itself, while the
// platform lifecycle (enable, export, disable, Karenz block, purge) acts on t_<tenant>__calendar, which stayed
// empty. The leaf now opens the lifecycle database as the module app role (src/tenant-store.ts). A customer that
// already has data needs it copied once; this script does that and nothing else.
//
// What it does, per customer of the catalogue (calendar_control.tenant_catalog):
//   - reads the source (calendar_<slug>) and the target (t_<hex32>__calendar) and refuses, by name of the
//     problem, when the target does not exist (the lifecycle creates it: enable the module first; this script
//     NEVER creates a database), when the two schemas differ, or when the target holds data that is not the
//     source's;
//   - --apply only: takes a pg_dump -Fc backup of the source into --backup-dir FIRST and checks that
//     pg_restore reads it, then copies every table in ONE transaction (the seeded system event types of the
//     target are replaced by the source's, whose ids the events reference) and compares, inside that
//     transaction, the row count and a checksum of every table with the source's: any difference rolls the
//     whole copy back;
//   - then marks the source retired with a database comment the script itself reads on the next run, and
//     records the lifecycle name in the catalogue row. It never drops, renames or empties a database.
// Dry run is the default: it reads, prints the plan, and changes nothing (no backup, no copy, no mark).
//
// Idempotent. A customer whose source carries the retired mark is skipped (the target has been in use since, so
// its counts are no longer the source's). A target that already equals the source but has no mark (a run that
// stopped between the copy and the mark) is only marked. Running it twice is the same as running it once.
//
// Order of an upgrade (docs/ops/pilot-services.md): stop calendar-service, run this script (dry run, then
// --apply), start the release that carries the new leaf. The leaf must not write to the old database while this
// runs, and the new leaf must not write to the target before it (the check refuses a target with other data).
//
// How it reaches Postgres: through `docker exec` into the module's database container (the server is on the
// state network only, not on the host), as the server's admin login over the container's local socket, so no
// password is handled here. Node and the docker CLI are all the host needs.
//
// Usage:
//   node modules/calendar/scripts/move-to-lifecycle-db.mjs --container <postgres container> [--admin-user calendar]
//        [--backup-dir <dir>] [--apply] [--db-prefix calendar_]
// Exit codes: 0 everything moved, already moved, or (dry run) ready; 1 at least one customer was refused or a
// verification failed (the others are still processed; nothing refused was changed); 2 usage or a database
// that cannot be reached.

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const MARK_PREFIX = 'gremion-retired: moved to '
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SLUG = /^[a-z0-9]([a-z0-9-]{0,28}[a-z0-9])?$/
const IDENT = /^[a-z_][a-z0-9_]{0,62}$/
const CONTAINER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/
const DB_NAME = /^[a-z0-9_][a-z0-9_-]{0,62}$/
const ADMIN_USER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/

/** t_<hex32>__calendar: the same name packages/tenant-store tenantModuleDbName builds for (tenant, 'calendar'). */
export function lifecycleDbName(tenantId) {
  if (!UUID_V7.test(tenantId)) throw new Error('the tenant id is not a canonical lowercase UUIDv7')
  return `t_${tenantId.replaceAll('-', '')}__calendar`
}

function sqlLiteral(text) {
  return `'${String(text).replaceAll("'", "''")}'`
}

/** A runner of one docker exec into the database container. Replaceable in tests. */
export function dockerRunner(container, adminUser) {
  const base = ['exec', '-i', container]
  const psql = (db, sql, { input } = {}) => {
    const r = spawnSync('docker', [...base, 'psql', '-X', '-q', '-U', adminUser, '-d', db, '-v', 'ON_ERROR_STOP=1', '-At', '-F', '\t', '-c', sql], {
      encoding: 'utf8',
      input,
      maxBuffer: 256 * 1024 * 1024,
    })
    if (r.status !== 0) {
      const err = new Error(`psql on ${db} failed: ${(r.stderr || r.error?.message || '').trim().split('\n')[0]}`)
      err.sqlstate = /database ".*" does not exist/.test(r.stderr || '') ? '3D000' : undefined
      throw err
    }
    return r.stdout
  }
  return { container, adminUser, base, psql }
}

/** Rows of one query as arrays of tab-separated cells. */
function rows(runner, db, sql) {
  const out = runner.psql(db, sql)
  return out.split('\n').filter((l) => l !== '').map((l) => l.split('\t'))
}

function databaseExists(runner, name) {
  return rows(runner, 'postgres', `SELECT 1 FROM pg_database WHERE datname = ${sqlLiteral(name)}`).length === 1
}

function databaseComment(runner, name) {
  const r = rows(runner, 'postgres', `SELECT coalesce(shobj_description(oid, 'pg_database'), '') FROM pg_database WHERE datname = ${sqlLiteral(name)}`)
  return r[0]?.[0] ?? ''
}

/** Per table of the public schema (the ledger excluded): its column list, so two schemas compare as text. */
function schemaOf(runner, db) {
  const r = rows(
    runner,
    db,
    `SELECT c.table_name, string_agg(c.column_name || ':' || c.data_type, ',' ORDER BY c.ordinal_position)
       FROM information_schema.columns c JOIN information_schema.tables t USING (table_schema, table_name)
      WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE' AND c.table_name <> 'schema_migrations'
      GROUP BY c.table_name ORDER BY c.table_name`,
  )
  const out = new Map()
  for (const [table, columns] of r) {
    if (!IDENT.test(table)) throw new Error('a table name is outside [a-z0-9_]')
    out.set(table, columns)
  }
  return out
}

/** Row count and a checksum of the sorted row texts, per table. */
function fingerprint(runner, db, tables) {
  const out = new Map()
  for (const t of tables) {
    const [row] = rows(runner, db, `SELECT count(*), coalesce(md5(string_agg(x::text, '|' ORDER BY x::text)), '') FROM public."${t}" x`)
    out.set(t, { count: Number(row[0]), md5: row[1] })
  }
  return out
}

function sameFingerprint(a, b) {
  for (const [t, f] of a) {
    const g = b.get(t)
    if (!g || g.count !== f.count || g.md5 !== f.md5) return false
  }
  return a.size === b.size
}

const total = (fp) => [...fp.values()].reduce((n, f) => n + f.count, 0)

/** Is the target the lifecycle's fresh one: no row anywhere, but the system event types its migration seeds? */
function targetIsFresh(runner, db, tables) {
  for (const t of tables) {
    const [row] = rows(
      runner,
      db,
      t === 'event_types' ? `SELECT count(*) FROM public.event_types WHERE is_system = false` : `SELECT count(*) FROM public."${t}"`,
    )
    if (Number(row[0]) > 0) return false
  }
  return true
}

/**
 * Plan one customer. Returns { action, reason, ... } where action is one of
 *   retired   the source carries the mark: nothing to do
 *   absent    there is no source database: nothing to move
 *   same      source and target are one database (the new leaf claimed the row): nothing to do
 *   refused   something is wrong; reason says what; nothing is changed
 *   mark      the target already equals the source, only the mark is missing
 *   copy      the target is the lifecycle's fresh database: the data is copied
 */
export function planTenant(runner, row) {
  let target
  try {
    target = lifecycleDbName(row.tenantId)
  } catch (err) {
    return { action: 'refused', reason: `catalogue row: ${err.message}` }
  }
  if (!SLUG.test(row.slug)) return { action: 'refused', reason: 'catalogue row: the slug is outside the slug grammar' }
  const source = row.dbName
  if (source === target) return { action: 'same', source, target, reason: 'the catalogue already names the lifecycle database' }
  if (!DB_NAME.test(source) || source !== `${row.prefix}${row.slug}`) {
    return { action: 'refused', reason: 'catalogue row: db_name is not <prefix><slug>' }
  }
  if (!databaseExists(runner, source)) return { action: 'absent', source, target, reason: 'there is no source database' }
  if (databaseComment(runner, source).startsWith(MARK_PREFIX)) return { action: 'retired', source, target, reason: 'the source carries the retired mark' }
  if (!databaseExists(runner, target)) {
    return { action: 'refused', source, target, reason: 'the lifecycle database does not exist: enable the calendar module for this customer first (this script never creates a database)' }
  }
  const sourceSchema = schemaOf(runner, source)
  const targetSchema = schemaOf(runner, target)
  const sameTables = JSON.stringify([...sourceSchema]) === JSON.stringify([...targetSchema])
  if (!sameTables || targetSchema.size === 0) {
    return { action: 'refused', source, target, reason: 'the schemas of source and target differ (tables or columns): upgrade the lifecycle database to this release first' }
  }
  const tables = [...targetSchema.keys()]
  const sourceFp = fingerprint(runner, source, tables)
  const targetFp = fingerprint(runner, target, tables)
  if (sameFingerprint(sourceFp, targetFp)) return { action: 'mark', source, target, tables, sourceFp, targetFp, reason: 'the target already equals the source' }
  if (!targetIsFresh(runner, target, tables)) {
    return { action: 'refused', source, target, reason: 'the target holds data that is not the source\'s: nothing is copied over it' }
  }
  return { action: 'copy', source, target, tables, sourceFp, targetFp, reason: `${total(sourceFp)} row(s) in ${tables.length} table(s)` }
}

function describeFp(fp) {
  return [...fp].map(([t, f]) => `${t}=${f.count}`).join(' ')
}

/** pg_dump -Fc of the source into a file under dir; checks that pg_restore --list reads it. Returns { file, bytes, sha256 }. */
async function backup(runner, source, dir, tenantId, stamp) {
  const file = join(dir, `calendar-${tenantId.replaceAll('-', '')}-${stamp}.dump`)
  const hash = createHash('sha256')
  let bytes = 0
  const dump = spawn('docker', [...runner.base, 'pg_dump', '-U', runner.adminUser, '-Fc', '-d', source], { stdio: ['ignore', 'pipe', 'pipe'] })
  const out = createWriteStream(file, { flags: 'wx', mode: 0o600 })
  let stderr = ''
  dump.stderr.on('data', (c) => (stderr += c))
  dump.stdout.on('data', (c) => {
    bytes += c.length
    hash.update(c)
  })
  dump.stdout.pipe(out)
  const written = new Promise((resolveDone, reject) => {
    out.on('finish', resolveDone)
    out.on('error', reject)
  })
  const exited = new Promise((resolveDone, reject) => {
    dump.on('error', reject)
    dump.on('close', (code) => (code === 0 ? resolveDone() : reject(new Error(`pg_dump failed: ${stderr.trim().split('\n')[0]}`))))
  })
  await Promise.all([written, exited])
  if (bytes === 0) throw new Error('the backup is empty')
  const list = spawnSync('docker', [...runner.base, 'pg_restore', '--list'], { input: readFileSync(file), maxBuffer: 256 * 1024 * 1024 })
  if (list.status !== 0 || !String(list.stdout).includes('TABLE DATA')) throw new Error('pg_restore cannot read the backup')
  return { file, bytes, sha256: hash.digest('hex') }
}

/**
 * The copy: one psql transaction on the target. The seeded system event types are replaced by the source's; the
 * data comes from pg_dump --data-only --disable-triggers (the tables in any order, sequences set); the last
 * statement raises unless every table's count and checksum equal what the source had. A failed dump aborts it.
 */
async function copyData(runner, plan) {
  const expected = [...plan.sourceFp].map(([t, f]) => `(${sqlLiteral(t)}, ${f.count}, ${sqlLiteral(f.md5)})`).join(', ')
  const checks = plan.tables
    .map(
      (t) => `
  SELECT count(*), coalesce(md5(string_agg(x::text, '|' ORDER BY x::text)), '') INTO c, m FROM public."${t}" x;
  IF c <> (SELECT n FROM expected WHERE t = ${sqlLiteral(t)}) OR m <> (SELECT s FROM expected WHERE t = ${sqlLiteral(t)}) THEN
    RAISE EXCEPTION 'verification failed for table %', ${sqlLiteral(t)};
  END IF;`,
    )
    .join('')
  const verify = `
DO $verify$
DECLARE c bigint; m text;
BEGIN
  CREATE TEMP TABLE expected (t text, n bigint, s text) ON COMMIT DROP;
  INSERT INTO expected VALUES ${expected};${checks}
END
$verify$;
`
  await new Promise((resolveDone, reject) => {
    const psql = spawn('docker', [...runner.base, 'psql', '-X', '-q', '-U', runner.adminUser, '-d', plan.target, '-v', 'ON_ERROR_STOP=1', '-1'], { stdio: ['pipe', 'ignore', 'pipe'] })
    const dump = spawn('docker', [...runner.base, 'pg_dump', '-U', runner.adminUser, '-a', '--disable-triggers', '-Fp', '--exclude-table=schema_migrations', '-d', plan.source], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let psqlErr = ''
    let dumpErr = ''
    psql.stderr.on('data', (c) => (psqlErr += c))
    dump.stderr.on('data', (c) => (dumpErr += c))
    psql.on('error', reject)
    dump.on('error', reject)
    psql.stdin.write('DELETE FROM public.event_types WHERE is_system = true;\n')
    dump.stdout.pipe(psql.stdin, { end: false })
    let dumpCode
    dump.on('close', (code) => {
      dumpCode = code
      // A dump that did not end cleanly must not be committed: an error statement aborts the transaction.
      psql.stdin.end(code === 0 ? verify : 'SELECT 1/0;\n')
    })
    psql.on('close', (code) => {
      if (code === 0 && dumpCode === 0) return resolveDone()
      reject(new Error(`the copy was rolled back: ${(dumpCode !== 0 ? `pg_dump: ${dumpErr}` : psqlErr).trim().split('\n').slice(-1)[0]}`))
    })
  })
}

function recordInCatalogue(runner, controlDb, tenantId, target) {
  runner.psql(controlDb, `UPDATE tenant_catalog SET db_name = ${sqlLiteral(target)} WHERE tenant_id = ${sqlLiteral(tenantId)}::uuid AND db_name <> ${sqlLiteral(target)}`)
}

/** The mark first, the catalogue second: a run that stops between them is finished by the next one. */
function markRetired(runner, plan, tenantId, controlDb) {
  const note = `${MARK_PREFIX}${plan.target} at ${new Date().toISOString()}`
  runner.psql('postgres', `COMMENT ON DATABASE "${plan.source}" IS ${sqlLiteral(note)}`)
  recordInCatalogue(runner, controlDb, tenantId, plan.target)
}

/** Run the whole move. `log` receives one line per fact. Returns the exit code. */
export async function moveAll({ runner, prefix = 'calendar_', apply = false, backupDir, log = console.log, now = () => new Date() }) {
  const controlDb = `${prefix}control`
  if (!databaseExists(runner, controlDb)) {
    log(`nothing to move: there is no catalogue database ${controlDb}`)
    return 0
  }
  const catalogue = rows(runner, controlDb, 'SELECT tenant_id::text, slug, db_name FROM tenant_catalog ORDER BY created_at, tenant_id').map(([tenantId, slug, dbName]) => ({ tenantId, slug, dbName, prefix }))
  log(`${apply ? 'APPLY' : 'DRY RUN'}: ${catalogue.length} customer(s) in the catalogue`)
  const stamp = now().toISOString().replaceAll(/[:.]/g, '-')
  let refused = 0
  let moved = 0
  for (const row of catalogue) {
    const label = `customer ${row.tenantId}`
    let plan
    try {
      plan = planTenant(runner, row)
    } catch (err) {
      log(`${label}: REFUSED (${err.message})`)
      refused++
      continue
    }
    if (plan.action === 'refused') {
      log(`${label}: REFUSED (${plan.reason})`)
      refused++
    } else if (plan.action === 'retired' || plan.action === 'absent' || plan.action === 'same') {
      log(`${label}: nothing to do (${plan.reason})`)
      if (apply && plan.action === 'retired') {
        // a run that stopped after the mark and before the catalogue update: finish that one statement
        recordInCatalogue(runner, controlDb, row.tenantId, plan.target)
      }
    } else if (!apply) {
      log(`${label}: WOULD ${plan.action === 'copy' ? 'COPY' : 'MARK'} ${plan.source} -> ${plan.target} (${plan.reason}; ${describeFp(plan.sourceFp)})`)
    } else {
      try {
        if (plan.action === 'copy') {
          const b = await backup(runner, plan.source, backupDir, row.tenantId, stamp)
          log(`${label}: backup ${b.file} (${b.bytes} bytes, sha256 ${b.sha256})`)
          await copyData(runner, plan)
          const after = fingerprint(runner, plan.target, plan.tables)
          if (!sameFingerprint(plan.sourceFp, after)) throw new Error('the counts or checksums differ after the copy')
          log(`${label}: copied ${plan.source} -> ${plan.target}; counts equal (${describeFp(after)})`)
        }
        markRetired(runner, plan, row.tenantId, controlDb)
        log(`${label}: ${plan.source} marked retired (kept, never dropped)`)
        moved++
      } catch (err) {
        log(`${label}: FAILED (${err.message})`)
        refused++
      }
    }
  }
  log(`${apply ? 'moved' : 'ready'}: ${apply ? moved : catalogue.length - refused} customer(s), refused or failed: ${refused}`)
  return refused === 0 ? 0 : 1
}

function parseArgs(argv) {
  const out = { apply: false, adminUser: 'calendar', prefix: 'calendar_' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--apply') out.apply = true
    else if (a === '--container') out.container = argv[++i]
    else if (a === '--admin-user') out.adminUser = argv[++i]
    else if (a === '--backup-dir') out.backupDir = argv[++i]
    else if (a === '--db-prefix') out.prefix = argv[++i]
    else throw new Error(`unknown argument ${a}`)
  }
  return out
}

const USAGE = 'usage: node move-to-lifecycle-db.mjs --container <postgres container> [--admin-user calendar] [--backup-dir <dir>] [--db-prefix calendar_] [--apply]'

async function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(`${err.message}\n${USAGE}`)
    return 2
  }
  if (!args.container || !CONTAINER.test(args.container) || !ADMIN_USER.test(args.adminUser) || !/^[a-z_]+_$/.test(args.prefix)) {
    console.error(USAGE)
    return 2
  }
  if (args.apply) {
    if (!args.backupDir) {
      console.error('--apply needs --backup-dir (the pg_dump of every source is taken there first)')
      return 2
    }
    const dir = resolve(args.backupDir)
    if (existsSync(dir) && (!statSync(dir).isDirectory() || readdirSync(dir).length > 0)) {
      console.error('--backup-dir must be an empty directory or not exist yet')
      return 2
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    args.backupDir = dir
  }
  const runner = dockerRunner(args.container, args.adminUser)
  try {
    runner.psql('postgres', 'SELECT 1')
  } catch (err) {
    console.error(`cannot reach the database in container ${args.container}: ${err.message}`)
    return 2
  }
  return moveAll({ runner, prefix: args.prefix, apply: args.apply, backupDir: args.backupDir })
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(await main())
}
