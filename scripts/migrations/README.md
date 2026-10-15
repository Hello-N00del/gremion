# The migration register (TASK-029)

One numbering sequence per **database chain** (PRD-REC-005, TRD-344). Every
`*.sql` file in the repository is either in exactly one chain's `dirs[]` or a
declared `nonMigration[]` entry; `make lint-migration-register` (part of
`make lint`, and of verify's carve-lint) refuses anything else.

| File | What it holds |
|---|---|
| `ranges.json` | the register: per chain `id`, `database`, `dirs[]`, `manifestDirs[]`, `padWidth`, `highWater`, `legacyFloor`, `legacy[]`, optional `blocks[]` |
| `applied.lock.json` | every chain file's sha256, frozen: `{frozenAt, chains: {<id>: {legacyFloor, legacy, files: {<file>: sha256}}}}` |
| `stura-only-slugs.json` | the 29 StuRa-tree migration slugs that may not enter a kernel-database chain |
| `pad3-references.allow.json` | where a pre-renumber (pad 3) kernel name may still appear, with reasons |
| `register.mjs` | `check`, `claim`, `freeze` |
| `pre-apply.mjs` | `chainPreApply`: the TASK-020 `hooks.preApply` refusing a run before any DDL |
| `verify-applied.mjs` | `verifyApplied`: the boot check, applied row sha256 = manifest = file |

## Adding a migration

```sh
node scripts/migrations/register.mjs claim --chain kernel-data --name my_change
#   -> gremion-ui/migrations/0059_my_change.sql   (highWater 58 -> 59)
# write the file, regenerate the chain's manifest, then
node scripts/migrations/register.mjs freeze --chain kernel-data
node scripts/migrations/register.mjs check
```

A block of a multi-directory chain is claimed with `--dir`
(`--chain kernel-data --dir modules/content/app/migrations` -> `1202_...`).

**Standing grant (after TASK-029 merges):** the `highWater` lines of
`ranges.json` and the entries of `applied.lock.json` are shared-append for
every migration task (TASK-080/081/084/092/204/132/035, modules), and only
through `claim` and `freeze`. The `highWater` line is the mutex: two branches
claiming the same number edit the same line and collide in review, not in a
database. `legacyFloor` / `legacy[]` are written once and never edited
(`check` compares them with the lock).

## What `check` refuses

- a `*.sql` in no chain and no `nonMigration` row; a `nonMigration` row matching nothing; zero files;
- a wrong pad width; filename order differing from numeric order; a duplicate number;
- a gap above the legacy floor (a block: above its `lo`); `highWater` != the highest file;
- a file at or below `legacyFloor` that is not in `legacy[]`; a file outside its block;
- a locked file renamed, renumbered, edited or deleted; a chain file missing from the lock; an absent or malformed lock (never read as `{}`);
- a chain file whose `.gitattributes` `eol` is not `lf` (the lock hash would depend on the checkout);
- a StuRa-only slug in a chain of the **kernel** database (any number), and any
  migration-shaped file numbered 1000-1199 or 1300-2099 (the StuRa module blocks).
  Module leaf chains run in their own databases: the finance leaf legitimately
  carries `money_running_no_fiscal_year_idx` / `money_fk_indexes`.

## Chains at the freeze (2026-09-28)

| Chain | Database | Dirs | Pad | Files |
|---|---|---|---|---|
| `kernel-data` | kernel | `gremion-ui/migrations` + block `modules/content/app/migrations` [1200, 1299] | 4 | 31 legacy (<= 0058) + 1200, 1201 |
| `control` | control | `gremion-ui/migrations-control` | 3 | 5 legacy (<= 006, gap at 005) |
| `module-<id>` | module:<id> | `modules/<id>/migrations` (board, calendar, content, finance, publishing, vault) | 3 | 15, numbers kept |
| `kernel-api` | service:kernel-api | `services/kernel-api/migrations/{bodies,authz,roles,erasure}` | 4 | none yet |
| `governance`, `mail` | service:<id> | `services/<id>/migrations` | 4 | none yet |
| `platform` | gremion_platform | `packages/tenant-store/src/lifecycle/platform-migrations` (TASK-021) | 4 | 3 legacy (<= 0003) |

A chain with no file must keep `highWater` 0 and no locked file. The rule is
read **per chain**: an empty lock entry (`files: {}`) counts as "no lock
entry", and a declared directory of a chain that already has files elsewhere
may still be absent. `kernel-api`'s four subdirectories fill one at a time
(TASK-080/081/204/132), so refusing an absent sibling would refuse the first
claim into any of them.

## Deviations from the brief (recorded for the ledger)

- **Lock format (Q6).** The brief names `applied.lock.json` as
  `{chain: {file: sha256}}`; the lock is
  `{frozenAt, hash, chains: {<chain>: {legacyFloor, legacy, files: {<file>: sha256}}}}`,
  so the write-once `legacyFloor` / `legacy[]` are frozen next to the hashes
  and `check` can refuse an edit to them (`LEGACY_EDITED`). The hash is
  sha256 of the working bytes; `check` asserts `eol=lf` per file, which makes
  them the git index blob.
- **StuRa-slug rule scope (§1).** The brief says a listed slug fails "at any
  number". It fails at any number in a chain of the **kernel** database only.
  The module-finance leaf chain runs in its own database and legitimately
  carries `money_running_no_fiscal_year_idx` and `money_fk_indexes`; applying
  the rule there would refuse TASK-200's measured tree. The number-range rule
  (1000-1199, 1300-2099) still applies to every tracked file.
- **B7 reuse.** The PLAN names B7 Tasks 1-4 and 6-11. This unit took only
  what the brief's section 4 lists (order/pad and coverage guards, the
  baseline check as the lock check, a pure `git mv` renumber with manifest
  regeneration, the `CROSS_CUTTING_MIGRATIONS` keys) and dropped the
  ownership harvest, `NEXT_FREE_MIGRATION_NUMBER`, T5, T12 and the Linux-only
  capture (B7 .6/.7).

## Known limits (residuals)

- The kernel-data chain spans two directories and `kernel-api` four; a runner
  that reads the union of `dirs[]` ordered by number is TASK-075/077's.
  `chainPreApply` already treats the chain as that union.
- gremion-ui's own ledger (`db.ts`) has no sha256 column, so the kernel data
  plane checks file = manifest for every file at boot (G5) but not
  applied row = manifest; that half lands with the move onto tenant-store
  (owner named by the maintainer; TASK-038 re-asserts).
- Nothing in the kernel data plane refuses a **pre-renumber (pad-3) ledger**.
  `db.ts` compares ledger names only through `applied.has(file)`, so on a
  database whose `schema_migrations` still records the 31 pad-3 names it
  treats all 31 pad-4 files as pending and fails only by accident, on the
  first `CREATE TABLE ... already exists`, without naming the cause. **A
  re-init is mandatory** for every kernel database created before the
  renumber; the StuRaOS gitlink bump that picks up TASK-029 must say so.
  `chainPreApply` refuses such a ledger before any DDL
  (`LEDGER_NAME_NOT_IN_CHAIN`, proven in `runtime.test.mjs`); wiring it into
  the kernel data plane belongs to the same owner as the ledger hash (a
  `db.ts` change beyond G5 is outside this unit).
- `modules/content/app/migrations` (1200, 1201; kernel database) has no
  `manifest.json` and so no `manifestDirs` entry: neither verify's
  migration-hash suite nor `verifyApplied` covers it, and `verifyApplied`
  would refuse those rows as `NOT_IN_MANIFEST` once a union runner uses it
  for kernel-data. The manifest for that directory lives in a module tree
  this unit does not own: TASK-075/077.
