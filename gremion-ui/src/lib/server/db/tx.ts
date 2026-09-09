// Neutral DB transaction utilities. Domain modules (finance, governance, …)
// must depend on THIS, never on each other's tx helpers. Relocated from
// finance/repositories/tx.ts to remove the governance→finance reverse-import
// (Pillar-1 P0.1). The fallback pool is supplied as a LAZY factory so it is
// only resolved when no tx is passed — preserving the original
// `tx ?? getPool()` short-circuit. (A pool getter throws when DATABASE_URL is
// unset, e.g. in unit tests that pass a synthetic tx; eager resolution would
// break that isolation.)
import type { Sql, TransactionSql } from 'postgres'

/** The postgres-js handle inside db.begin(async (tx) => ...). */
export type PgTransaction = TransactionSql<{}>

/** Either the caller's tx, or the domain's own pool. */
export type SqlRunner = Sql<{}> | TransactionSql<{}>

/** Select the SQL runner: caller-supplied tx, or the domain pool (resolved lazily). */
export function getRunner(tx: PgTransaction | undefined, fallback: () => SqlRunner): SqlRunner {
  return tx ?? fallback()
}

/**
 * Split the `(tx?, data)` overload arguments of a `create*`-style repository
 * write. A leading FUNCTION arg is the postgres-js tx (mirrors getRunner's
 * `typeof … === 'function'` tx-detection); otherwise the first arg is the data
 * payload and there is no tx. Shared by the governance repositories (was
 * duplicated verbatim in org-units-db / sub-org-types-db).
 */
export function unpackTxArgs<D>(
  txOrData: PgTransaction | D,
  maybeData: D | undefined,
): { tx: PgTransaction | undefined; data: D } {
  if (typeof txOrData === 'function') {
    return { tx: txOrData as PgTransaction, data: maybeData as D }
  }
  return { tx: undefined, data: txOrData as D }
}
