// packages/tenant-store/test/fixtures/read-then-apply.ts
//
// The WRONG runner, kept as the concurrency test's RED guard (B21): it reads
// schema_migrations, then applies what it found pending, with no lock
// between the read and the apply. Two of these against one database both see
// the same pending set and both apply it.
import type postgres from 'postgres'
import { readVerifiedMigrations } from '../../src/manifest.js'
import { stripOuterTransaction } from '../../src/strip-outer-transaction.js'

export async function readThenApply({ sql, dir, holdMs = 0 }: { sql: postgres.Sql; dir: string; holdMs?: number }) {
  const migrations = readVerifiedMigrations(dir)
  await sql`CREATE TABLE IF NOT EXISTS public.schema_migrations (
    filename text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())`
  const applied = new Set((await sql<{ filename: string }[]>`SELECT filename FROM public.schema_migrations`).map((r) => r.filename))
  await new Promise((r) => setTimeout(r, holdMs))
  const done: string[] = []
  for (const m of migrations) {
    if (applied.has(m.file)) continue
    await sql.begin(async (tx) => {
      await tx.unsafe(stripOuterTransaction(m.text))
      await tx`INSERT INTO public.schema_migrations (filename, sha256) VALUES (${m.file}, ${m.sha256})`
    })
    done.push(m.file)
  }
  return { applied: done }
}
