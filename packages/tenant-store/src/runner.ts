// NAIVE STUB (pre-implementation): read the ledger, then apply. No lock.
import type { Sql } from '@gremion/db'
import { readVerifiedMigrations } from './manifest.js'
import { stripOuterTransaction } from './strip-outer-transaction.js'
export interface RunMigrationsOptions { sql: Sql; dir: string; log?: (l: string) => void; hooks?: { preApply?: (file: string, ctx: unknown) => unknown } }
export async function runMigrations({ sql, dir, hooks }: RunMigrationsOptions) {
  await sql`CREATE TABLE IF NOT EXISTS public.schema_migrations (filename text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())`
  const migrations = readVerifiedMigrations(dir)
  const applied = new Set((await sql<{ filename: string }[]>`SELECT filename FROM public.schema_migrations`).map((r) => r.filename))
  const done: string[] = []
  for (const m of migrations) {
    if (applied.has(m.file)) continue
    await hooks?.preApply?.(m.file, {})
    await sql.begin(async (tx) => { await tx.unsafe(stripOuterTransaction(m.text)); await tx`INSERT INTO public.schema_migrations (filename, sha256) VALUES (${m.file}, ${m.sha256})` })
    done.push(m.file)
  }
  return { applied: done }
}
