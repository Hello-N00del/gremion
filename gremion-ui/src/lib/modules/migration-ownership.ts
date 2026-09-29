// The three kernel-block migrations that create or alter a MODULE-owned table
// and stay kernel-applied by written rule (spec B, migrations chapter §4).
// A vertical that runs calendar, elections or board OFF still gets these files:
// later ungated kernel DDL (0010_org_units.sql's ALTER of committee_elections)
// and gremion-ui/scripts/fresh-init-proof.sh's existence assertions depend on
// them existing. (0058_public_reader_grants.sql no longer names calendar_events
// among its own dependencies as of R-E13: it grants only the tables the
// anonymous portal reads, org_units and protocols.)
export const CROSS_CUTTING_MODULE_TABLES = [
  'calendar_events',
  'committee_elections',
  'deck_board',
] as const

// `deck_board` is the board module's OWNERSHIP KEY, not a relation name:
// 0034_deck_board.sql:8,16,23 creates `board`, `stack` and `card`. Measured
// against a real Postgres by gremion-ui/scripts/fresh-init-proof.sh, which
// asserts those three relations. Kept as written because the cross-unit
// contract binds this literal — B7-renumber-ranges-baseline consumes it as
// ranges.json's `kernel.crossCuttingModuleTables`.
/** kernel-block migration basename -> the module table it owns. */
export const CROSS_CUTTING_MIGRATIONS: Readonly<Record<string, string>> = {
  '0003_calendar_schema.sql': 'calendar_events',
  '0004_committee_elections.sql': 'committee_elections',
  '0034_deck_board.sql': 'deck_board',
}

/**
 * The diagnosis for a migration numbered into a gap BELOW what a database has
 * already applied.
 *
 * `runMigrations()` applies in filename order but skips what
 * `schema_migrations` already holds, so a file back-filled into a gap is picked
 * up out of order on the next boot of an already-initialised database. The
 * 2026-09-15 port-back did exactly that with `0003_calendar_schema.sql` and
 * `0034_deck_board.sql`, which sort below `0048_resolution_decided_at.sql`. `003`
 * REFERENCES `committees`, renamed to `org_units` by `010`, so on such a
 * database it aborts — and because `applyMigrationFile` is atomic, nothing is
 * recorded and every later boot repeats the same abort, quoting a table nobody
 * removed. The run is doomed either way; this is the line that says why, and it
 * is printed before the apply loop reaches the file.
 *
 * @param applied     what `schema_migrations` already holds for this database.
 * @param candidates  the files this run would apply (seed and module skips
 *                    already removed — a skipped file is absent by design, not
 *                    back-filled).
 * @param expected    files a module OFF->ON catch-up already accounts for:
 *                    those legitimately sit in gaps (README §P0.2) and are not
 *                    a back-fill.
 */
export function backFillNotice(input: {
  applied: ReadonlySet<string>
  candidates: readonly string[]
  expected?: ReadonlySet<string>
}): string | null {
  const { applied, candidates, expected } = input
  // A fresh database has no high-water mark: sort order applies everything in
  // order, which is what gremion-ui/scripts/fresh-init-proof.sh measures.
  if (applied.size === 0) return null
  let highWater = ''
  for (const f of applied) if (f > highWater) highWater = f
  const backFilled = candidates
    .filter((f) => !applied.has(f) && f < highWater && !expected?.has(f))
    .sort()
  if (backFilled.length === 0) return null
  return (
    `[migrations] ${backFilled.length} unapplied migration(s) sort BELOW this database's ` +
    `high-water mark ${highWater}: ${backFilled.join(', ')}. The chain was extended below ` +
    'what this database has already applied, which is not an upgrade path: a back-filled ' +
    'file that references a since-renamed table aborts the run here, and the abort names ' +
    'that table rather than this cause. Re-initialise the database (docker compose down -v) ' +
    'or restore it from a dump taken on the newer chain — see ' +
    'docs/ops/migration-portback-2026-09-15.md.'
  )
}
