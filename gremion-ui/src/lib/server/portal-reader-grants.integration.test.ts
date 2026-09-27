/**
 * B4a Task 3, adapted to TASK-054's result (TASK-028): the anonymous portal's
 * reader role holds SELECT on EXACTLY what the portal reads, proven in a real
 * Postgres, one scratch database per case -- created and dropped by this file.
 *
 *   1. content-OFF (the kernel chain alone) completes, and gremion_public_reader
 *      holds SELECT on exactly {org_units, protocols}: none of calendar_events,
 *      event_recurrence, protocol_resolutions, resolution_challenges (catalog
 *      AND a live SET ROLE probe);
 *   2. 058 still ABORTS on a missing required table;
 *   3. content-ON (the chain plus modules/content 1200) gives a news_posts the
 *      reader can actually SELECT.
 *
 * DESTRUCTIVE: it CREATEs and DROPs databases on the server DATABASE_URL names.
 * So, like every truncating or dropping harness, it runs the no-truncate guard
 * itself at import -- before any connection, not relying on setupFiles -- and
 * again on every URL it derives (spec B section 6). Run it with:
 *   GREMION_PRODUCTION_STACK=none pnpm vitest run --config vitest.integration.config.ts \
 *     src/lib/server/portal-reader-grants.integration.test.ts
 *
 * PORTAL_GRANT_PROOF_058 replaces 058's bytes with another file -- only for the
 * watched-RED drill against the pre-TASK-054 058 (`git show fa99132:...`).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import postgres from 'postgres'
import { assertNonProductionDbUrl } from '../../../tests/integration/assert-safe-test-db-url'

assertNonProductionDbUrl(process.env.DATABASE_URL ?? '', 'DATABASE_URL')

const UI_ROOT = path.resolve(__dirname, '..', '..', '..')
const MIGRATIONS = path.join(UI_ROOT, 'migrations')
const CONTENT_1200 = path.resolve(UI_ROOT, '..', 'modules', 'content', 'migrations', '1200_content_news_posts.sql')
const READER = 'gremion_public_reader'
const EXACT_READ_SET = ['org_units', 'protocols']
const MUST_NOT_READ = ['calendar_events', 'event_recurrence', 'protocol_resolutions', 'resolution_challenges']

/** The same server and user as the (guarded) DATABASE_URL, another database. */
function sameServer(db: string): string {
  const u = new URL(process.env.DATABASE_URL as string)
  u.pathname = `/${db}`
  return u.toString()
}

/** A scratch database URL -- guarded again, and its name carries "test". */
function urlFor(db: string): string {
  const url = sameServer(db)
  assertNonProductionDbUrl(url, `DATABASE_URL (database ${db})`)
  return url
}

/**
 * The maintenance connection that CREATEs and DROPs the scratch databases. Not
 * re-guarded on purpose: it is the server and credentials of DATABASE_URL,
 * which the guard judged at import, and only the database name differs. The
 * loopback test-name convention is about which database a harness TRUNCATES;
 * run through it, `postgres` (the maintenance database) would refuse the
 * documented fixture. This connection only ever drops the databases this file
 * created, by the names it recorded.
 */
function adminUrl(): string {
  return sameServer('postgres')
}

/** The kernel chain, sorted, seeds skipped -- what db.ts runs with seeds off. */
function kernelChain(): Array<{ name: string; sql: string }> {
  const override = process.env.PORTAL_GRANT_PROOF_058
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('_seed.sql'))
    .sort()
    .map((name) => ({
      name,
      sql: readFileSync(
        name === '058_public_reader_grants.sql' && override ? override : path.join(MIGRATIONS, name),
        'utf8',
      ),
    }))
}

const RUN = `${process.pid}_${Math.random().toString(36).slice(2, 8)}`
const created: string[] = []
let admin: postgres.Sql
let createdRole = false

async function scratchDb(label: string): Promise<postgres.Sql> {
  const name = `portal_grants_test_${label}_${RUN}`
  await admin.unsafe(`CREATE DATABASE ${name}`)
  created.push(name)
  return postgres(urlFor(name), { max: 1, onnotice: () => {} })
}

async function applyAll(sql: postgres.Sql, files: Array<{ name: string; sql: string }>): Promise<void> {
  for (const f of files) {
    try {
      await sql.unsafe(f.sql)
    } catch (e) {
      throw new Error(`${f.name}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}

/** Every relation in `public` the reader may SELECT, sorted. */
async function readable(sql: postgres.Sql): Promise<string[]> {
  const rows = await sql<{ relname: string }[]>`
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r','v','m','p')
      AND has_table_privilege(${READER}, c.oid, 'SELECT')
    ORDER BY c.relname`
  return rows.map((r) => r.relname)
}

/** Runs a SELECT as the reader; resolves to the error message, or null. */
async function selectAsReader(sql: postgres.Sql, table: string): Promise<string | null> {
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL ROLE ${READER}`)
      await tx.unsafe(`SELECT 1 FROM public.${table} LIMIT 1`)
    })
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

beforeAll(async () => {
  admin = postgres(adminUrl(), { max: 1, onnotice: () => {} })
  const [{ exists }] = await admin<{ exists: boolean }[]>`
    SELECT EXISTS (SELECT FROM pg_roles WHERE rolname = ${READER}) AS exists`
  if (!exists) {
    // Mirrors docker/postgres/init-databases.sh: the role the portal logs in as.
    await admin.unsafe(`CREATE ROLE ${READER} NOLOGIN`)
    createdRole = true
  }
})

afterAll(async () => {
  if (!admin) return
  // Every step is attempted even when an earlier one fails; the first error is
  // re-thrown at the end so a failed cleanup is never silent.
  const errors: unknown[] = []
  for (const name of created) {
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
    } catch (e) {
      errors.push(e)
    }
  }
  try {
    if (createdRole) {
      // Only when THIS file created the role: every grant it holds was made
      // here. 008 grants CONNECT on a database by fixed name (`gremion`), i.e.
      // outside the scratch database, and a database-level grant blocks DROP ROLE.
      const dbs = await admin<{ datname: string }[]>`
      SELECT datname FROM pg_database WHERE datacl::text LIKE ${'%' + READER + '=%'}`
      for (const { datname } of dbs) {
        await admin.unsafe(`REVOKE ALL ON DATABASE "${datname.replace(/"/g, '""')}" FROM ${READER}`)
      }
      await admin.unsafe(`DROP ROLE IF EXISTS ${READER}`)
    }
  } catch (e) {
    errors.push(e)
  }
  await admin.end()
  if (errors.length > 0) throw errors[0]
})

describe('portal reader grants (B4a Task 3 on the TASK-054 result)', () => {
  it('content-OFF: the kernel chain completes and the reader reads exactly {org_units, protocols}', async () => {
    const sql = await scratchDb('off')
    try {
      const chain = kernelChain()
      expect(chain.length).toBeGreaterThanOrEqual(28) // vacuity floor (fresh-init-proof.sh)
      await applyAll(sql, chain)
      expect(await readable(sql)).toEqual(EXACT_READ_SET)
      for (const t of MUST_NOT_READ) {
        const [{ exists }] = await sql<
          { exists: boolean }[]
        >`SELECT to_regclass(${'public.' + t}) IS NOT NULL AS exists`
        expect(exists, `${t} exists (else the negative below is vacuous)`).toBe(true)
        expect(await selectAsReader(sql, t), t).toMatch(/permission denied/)
      }
      for (const t of EXACT_READ_SET) expect(await selectAsReader(sql, t), t).toBeNull()
      const [{ n }] = await sql<
        { n: number }[]
      >`SELECT count(*)::int AS n FROM to_regclass('public.news_posts') r WHERE r IS NOT NULL`
      expect(n, 'content-OFF creates no news_posts').toBe(0)
    } finally {
      await sql.end()
    }
  }, 120_000)

  it('058 still aborts when a table it requires is missing', async () => {
    const sql = await scratchDb('missing')
    try {
      await sql.unsafe('CREATE TABLE protocols (id int)') // org_units deliberately absent
      const m058 = kernelChain().find((f) => f.name === '058_public_reader_grants.sql')
      expect(m058).toBeDefined()
      await expect(applyAll(sql, [m058!])).rejects.toThrow(/do not exist: org_units/)
      expect(await readable(sql)).toEqual([])
    } finally {
      await sql.end()
    }
  }, 60_000)

  it('content-ON: 1200 after the kernel chain gives a news_posts the reader can SELECT', async () => {
    const sql = await scratchDb('on')
    try {
      await applyAll(sql, [
        ...kernelChain(),
        {
          name: '1200_content_news_posts.sql',
          sql: readFileSync(CONTENT_1200, 'utf8'),
        },
      ])
      expect(await readable(sql)).toEqual([...EXACT_READ_SET, 'news_posts'].sort())
      expect(await selectAsReader(sql, 'news_posts')).toBeNull()
    } finally {
      await sql.end()
    }
  }, 120_000)
})
