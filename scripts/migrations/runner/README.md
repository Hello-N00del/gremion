# scripts/migrations/runner: expand/contract and the pre-migration dump (TASK-075)

Two guarantees, TRD-361 and TRD-206:

1. **The serving colour survives the next release's migrations.** During a
   blue/green release the new colour's migrations run while the old colour
   still serves. A migration that would break the old colour is refused before
   merge by the required `expand-contract` verify suite
   (`node scripts/verify/verify.mjs --only expand-contract`). verify runs it
   as its own process (`suite-cli.mjs`, last stdout line
   `EXPAND-CONTRACT-SUITE <json>`), never by importing `suite.mjs`: a copy of
   `scripts/verify` must load alone.
2. **One dump before DDL, deleted after the switch.** Before a schema migration
   is applied, one dump of the database it alters is taken. It is deleted, and
   the deletion logged, only once the blue/green switch shipping the migration
   has succeeded.

## The phase header

The first line of every new migration file:

```sql
-- gremion:phase expand            -- additive only; the old colour keeps working
-- gremion:phase migrate           -- data moves, after the tenant context is set
-- gremion:phase contract          -- removes what an older release still read
-- gremion:contract-after dist-vX.Y.Z   (contract only)
-- gremion:manual-dump <runbook step>   (unadopted chains only, see below)
```

Files locked before the header existed are never re-hashed to gain one: their
phase comes from `expand-contract-baseline.json` (written once at the TASK-075
merge; its digest is pinned in `suite.mjs`, like `legacyFloor`; every entry
must still hash to `applied.lock.json`, else `LOCKED_FILE_CHANGED`). A file
with neither a header nor a baseline entry is `PHASE_MISSING`: the runner
refuses it before any hook, dump or DDL.

## What each phase may contain (`lint.mjs`)

A dependency-free, fail-closed allow-list (Q6, TRD-444). Anything it cannot
parse fails, naming the file, the statement number and the rule.

- **expand** (bounded by SCHEMA section 0.10): `CREATE TABLE` / `SCHEMA`;
  `CREATE INDEX` (not `CONCURRENTLY`, Q5), `CREATE TRIGGER`,
  `ENABLE|FORCE ROW LEVEL SECURITY`, `CREATE POLICY`, `INSERT` only on a table
  the same file creates; `CREATE FUNCTION` / `VIEW` of a new name (no
  `OR REPLACE`); `ADD COLUMN` nullable, or with a literal, `now()` or
  `CURRENT_TIMESTAMP` default; `ADD CONSTRAINT .. CHECK (..) NOT VALID`
  (a `FOREIGN KEY` is refused); `VALIDATE CONSTRAINT`; `COMMENT`; `GRANT`;
  `SET [LOCAL] lock_timeout`. Every file sets `lock_timeout` (SCHEMA:4784).
- **migrate**: `UPDATE` / `INSERT` only after a statement that sets the tenant
  context (`set_config(.., true)` or `SET LOCAL` of the tenant-store GUC).
  Whether a migrate file is **batched** is a database-lens review item: the
  lint does not claim it.
- **contract**: passes only with `-- gremion:contract-after dist-vX.Y.Z` naming
  the NEWEST `dist-v*` tag reachable from HEAD, a tag that does not contain the
  file, and with no `git grep -w` hit for any dropped or tightened identifier in
  that tag's tree outside migration dirs and fixtures. **There is no `dist-v*`
  tag yet, so every contract file fails until the first release is tagged.**

## Which runner takes the dump (`chain-runners.json`)

It covers `ranges.json` exactly (the suite fails on a gap, an extra chain or an
unknown class). Three classes:

| class | chains | who dumps |
|---|---|---|
| `tenant-store` | `platform` | `packages/tenant-store/src/dump/cli.ts migrate --chain <id> --release <R>`: `composePreApply(chainPreApply, dumpHook)` |
| `legacy-boot` | `kernel-data`, `control` | `gremion-migration-dump preflight --release <T>` (gremion-deploy step 5) takes the host-side dump when a chain's `dirs[]` gains a file (Q11) |
| `unadopted` | `module-*`, `kernel-api`, `governance`, `mail` | nobody yet: a new file must carry `-- gremion:manual-dump <runbook step>` |

An adopter flips its chain's class. `module-*` upgrades run in the leaf
runner; enabling a module for a customer creates a fresh database, which has
nothing to lose, so `enableModule` passes no dump hook there (an existing
database, a resumed enable or an upgrade, runs `deps.upgradeHooks`).

## The dump

- `cli.ts migrate` composes the runner's one `preApply` slot as TASK-029's
  `chainPreApply` over `chainFileNames(id)` **first**, then the dump hook. Both
  act once per run, on the first pending file, under the migration lock and
  before the first `BEGIN`. A chain refusal (`LEDGER_NAME_NOT_IN_CHAIN`,
  `BELOW_HIGH_WATER`) therefore takes no dump; nothing pending, no dump.
- `takeDump` writes `<dir>/<release>/<db>.<uuidv7>.dump` with TASK-021's
  `pgDumpExporter` (`pg_dump -Fc --no-owner`), 0600 in a 0700 directory owned
  by the running uid (no encryption, Q4: that disk holds the live database in
  clear). It fsyncs the file and both directories, checks bytes > 0 and that
  `pg_restore --list` names the database, and appends one `created` line with
  sha256 and bytes to `<dir>/ledger.jsonl`.
- **Never a series.** Refused before any DDL: another release's live dump for
  that database (`DUMP_SERIES`, printing the `restore`/`discard` commands); a
  pg_dump that exits non-zero; the dir unset, not 0700 or not owned by the uid;
  free space < 1.2 x `pg_database_size`; pg_dump older than the server. The
  same release reuses its live dump.
- The ledger (`ledger.jsonl`, append-only, fsynced, ids only) maps 1:1 onto
  DB-OPS-MIGRATION-DUMP; TASK-086 imports it. Both writers (node and
  `infra/host/bin/gremion-migration-dump`) take `ledger.lock` with O_EXCL; a
  stale lock refuses and is never broken automatically.
- `gremion-migration-dump switched --release R` (gremion-deploy, after step 11
  passes, before the soak; Q2) deletes every live dump of R: unlink, fsync the
  directory, re-stat, then one `deleted` line, one stdout audit line and one
  `logger -t premigration-dump` line. An unwritable ledger exits non-zero and
  keeps the file. A failure makes gremion-deploy exit 1 with `DUMP-NOT-DELETED`.
- A release that fails before its switch: `restore --release R --db D
  --accept-loss-since <time>` then `discard --release R --reason <text>` (Q9),
  both logged. `gremion-rollback` refuses a class (b) redeploy while a dump is
  live (exit 3) and, after a succeeded switch, says that no dump exists.

## Data jobs (TASK-031's member import)

```sh
GREMION_MIGRATE_URL=... GREMION_MIGRATION_DUMP_DIR=... \
  tsx packages/tenant-store/src/dump/cli.ts take --release import-<job> --db <D>
# ... run the import, re-run its check ...
gremion-migration-dump discard --release import-<job> --reason import-verified
```

Same checks, same ledger: exactly one `created` and one `deleted` line (Q10,
GDPR Art. 5(1)(e)).

## Not here (residuals)

- `CREATE INDEX CONCURRENTLY` is refused (one transaction per file, G-078; Q5).
- The union runner for multi-dir chains and the content app's `manifest.json`
  are TASK-077's; this unit only lints those files.
- The `gremion-migrate` image carries no dump mount, tenant-store or pg_dump 18
  yet (TASK-077 / TASK-084); `db.ts` ledger columns and kernel-data-plane
  `chainPreApply` wiring: TASK-084 / TASK-038.
- `ops.migration_dump` import and `migrationdump.*.v1` events: TASK-086.
- `contract_after` is an [A] deviation from SCHEMA 148-160 (Q8), filed for a
  doc patch.
