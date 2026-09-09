import { describe, it, expect, vi, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// NOTE: the old env-singleton getDb tests (describe('getDb') and
// describe('getDb (G-008)')) moved out of this file in P2.1a: per-client pool
// construction now lives in createDb (packages/db/src/client.test.ts) and the
// per-tenant getDb accessor in src/lib/server/db.tenant.test.ts. With them gone
// the file no longer needs the postgres / $env/dynamic/private mocks.

afterEach(() => {
  vi.resetModules()
})

describe('waitForDbReady budget', () => {
  it('defaults to 60 attempts before giving up', async () => {
    const { waitForDbReady } = await import('./db')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let calls = 0
    const ping = vi.fn(async () => { calls++; const e: NodeJS.ErrnoException = new Error('ECONNREFUSED'); e.code = 'ECONNREFUSED'; throw e })
    const sleep = vi.fn(async () => {})
    await expect(waitForDbReady({ ping, sleep })).rejects.toThrow(/not ready after 60 attempts/)
    expect(calls).toBe(60)
    warn.mockRestore()
  })
})

describe('verifyMigrationIntegrity (G-012)', () => {
  // Pure helper — no DB, no postgres mock interaction needed. Re-importing
  // here is still fine because the prior vi.mock('postgres') stays
  // registered across test files.

  it('(a) returns without throwing when text matches the manifest entry', async () => {
    const { verifyMigrationIntegrity } = await import('./db')
    const text = '-- harmless migration\nSELECT 1;\n'
    const hash = createHash('sha256').update(text).digest('hex')
    expect(() =>
      verifyMigrationIntegrity('001_test.sql', text, { '001_test.sql': hash }),
    ).not.toThrow()
  })

  it('(b) throws "tampered" when the text hash differs from the manifest entry', async () => {
    const { verifyMigrationIntegrity } = await import('./db')
    const original = '-- original migration\nSELECT 1;\n'
    const tampered = '-- malicious migration\nDROP TABLE users;\n'
    const hash = createHash('sha256').update(original).digest('hex')
    expect(() =>
      verifyMigrationIntegrity('001_test.sql', tampered, { '001_test.sql': hash }),
    ).toThrow(/tampered/)
  })

  it('(c) throws "missing from manifest" when filename has no manifest entry', async () => {
    const { verifyMigrationIntegrity } = await import('./db')
    expect(() =>
      verifyMigrationIntegrity('999_rogue.sql', 'SELECT 1;', { '001_test.sql': 'deadbeef' }),
    ).toThrow(/missing from manifest/)
  })
})

describe('applyMigrationFile transaction wrapping (G-078)', () => {
  // G-078: the per-file body must be atomic — both the DDL and the
  // schema_migrations bookkeeping INSERT live inside one sql.begin block.
  // If the DDL throws, the bookkeeping INSERT must NOT take effect; the
  // next boot retries the migration cleanly instead of skipping it and
  // re-failing on a half-applied schema.

  type TxCall = { kind: 'unsafe' | 'insert'; text: string }

  /**
   * Hand-rolled sql.begin mock. The callback receives a `tx` object whose
   * shape mirrors postgres-js (tagged-template-callable + .unsafe). Calls
   * made inside the callback are recorded into a per-transaction buffer;
   * the buffer is "committed" into `applied` only if the callback resolves.
   * If it throws, the buffer is discarded — same semantics as postgres-js
   * sql.begin rollback.
   */
  function buildSql(opts: { unsafeShouldThrow?: boolean } = {}) {
    const applied: string[] = []

    type SqlTxHandle = ((strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>) & {
      unsafe: (text: string) => Promise<unknown>
    }

    return {
      applied,
      begin: async (cb: (tx: SqlTxHandle) => Promise<void>) => {
        const buffer: TxCall[] = []
        const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
          // Only the runner's INSERT INTO schema_migrations shape is
          // expected on the tagged-template handle in production.
          const text = strings.join('?')
          if (text.includes('INSERT INTO schema_migrations')) {
            buffer.push({ kind: 'insert', text: values[0] as string })
          }
          return Promise.resolve([])
        }) as SqlTxHandle
        tx.unsafe = (text: string) => {
          buffer.push({ kind: 'unsafe', text: text.slice(0, 60) })
          if (opts.unsafeShouldThrow) {
            return Promise.reject(new Error('simulated DDL failure'))
          }
          return Promise.resolve([])
        }
        try {
          await cb(tx)
        } catch (err) {
          // Discard buffered effects — equivalent to ROLLBACK.
          throw err
        }
        // Commit: only INSERT calls land in the persistent applied[] list,
        // mirroring the only side-effect schema_migrations cares about.
        for (const call of buffer) {
          if (call.kind === 'insert') applied.push(call.text)
        }
      },
    }
  }

  it('records the bookkeeping row when the migration body succeeds', async () => {
    const { applyMigrationFile } = await import('./db')
    const sql = buildSql({ unsafeShouldThrow: false })
    // sql is a duck-typed stand-in — postgres-js's full Sql<{}> type carries
    // dozens of methods we don't exercise here.
    await applyMigrationFile(sql as unknown as Parameters<typeof applyMigrationFile>[0], 'A.sql', 'CREATE TABLE foo (id int);')
    expect(sql.applied).toEqual(['A.sql'])
  })

  it('does NOT record the bookkeeping row when the migration body throws', async () => {
    const { applyMigrationFile } = await import('./db')
    type SqlArg = Parameters<typeof applyMigrationFile>[0]
    const okSql = buildSql({ unsafeShouldThrow: false })
    await applyMigrationFile(okSql as unknown as SqlArg, 'A.sql', 'CREATE TABLE foo (id int);')
    expect(okSql.applied).toEqual(['A.sql'])

    // Second migration deliberately fails inside tx.unsafe. The
    // INSERT INTO schema_migrations issued AFTER tx.unsafe must therefore
    // never be observable, even though it appears in the function body.
    const failSql = buildSql({ unsafeShouldThrow: true })
    await expect(
      applyMigrationFile(failSql as unknown as SqlArg, 'B.sql', 'CREATE TABLE bar (id int);'),
    ).rejects.toThrow(/simulated DDL failure/)
    expect(failSql.applied).toEqual([])
  })
})

describe('migration manifest on disk (G-012 smoke)', () => {
  // (d) Optional integration smoke — confirms that the committed manifest.json
  // matches the *.sql files that actually live in gremion-ui/migrations/. The
  // prebuild script generates this file, so any drift between the .sql files
  // and the manifest would surface here (and would refuse to boot in prod).
  it('manifest covers every *.sql file in migrations/ and every hash matches', () => {
    // process.cwd() during `pnpm test:unit` is the gremion-ui package root,
    // which is the same anchor runMigrations uses (`join(process.cwd(), 'migrations')`).
    const dir = join(process.cwd(), 'migrations')
    const sqlFiles = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort()
    const manifest = JSON.parse(
      readFileSync(join(dir, 'manifest.json'), 'utf-8'),
    ) as Record<string, string>

    expect(Object.keys(manifest).sort()).toEqual(sqlFiles)

    for (const file of sqlFiles) {
      const bytes = readFileSync(join(dir, file))
      const actual = createHash('sha256').update(bytes).digest('hex')
      expect(manifest[file]).toBe(actual)
    }
  })
})

describe('migrations reference no renamed tables (post-010 org_units rename)', () => {
  // Regression guard for the #235 / migration-041 incident: migration 010
  // renamed the `committees` table to `org_units`, but 041 was authored months
  // later with a FK `REFERENCES committees(id)` — a table that no longer exists
  // past 010. It failed on EVERY DB beyond migration 010 (fresh boots and
  // existing tenants alike), 503'd gremion-ui per affected tenant, and slipped in
  // only because CI was paused when #235 merged. This pure, DB-less check fails
  // the moment any migration ORDERED AFTER the rename references the dropped
  // table name in executable SQL (comments are ignored).
  const RENAMES = [{ table: 'committees', renamedTo: 'org_units', afterMigration: 10 }]

  const dir = join(process.cwd(), 'migrations')
  const sqlFiles = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()

  // Strip block comments then line comments so prose that legitimately MENTIONS
  // the old name (e.g. "committees were renamed to org_units in 010", as 018
  // does) never trips the guard — only executable SQL is scanned.
  const stripComments = (sql: string): string =>
    sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '')

  const prefixNum = (file: string): number => Number.parseInt(file.slice(0, 3), 10)

  for (const { table, renamedTo, afterMigration } of RENAMES) {
    // `\bcommittees\b` matches the standalone table name but NOT `committee_*`
    // (singular) or `event_committees` (the `_` before it suppresses the word
    // boundary), so only a real reference to the dropped table is flagged.
    const ref = new RegExp(`\\b${table}\\b`, 'i')

    for (const file of sqlFiles) {
      const n = prefixNum(file)
      if (Number.isNaN(n) || n <= afterMigration) continue
      it(`${file} does not reference the renamed table "${table}" (use "${renamedTo}")`, () => {
        const body = stripComments(readFileSync(join(dir, file), 'utf-8'))
        expect(body).not.toMatch(ref)
      })
    }
  }
})
