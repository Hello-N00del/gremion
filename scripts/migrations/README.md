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

A chain with no file must keep `highWater` 0 and no locked file.

## Known limits (residuals)

- The kernel-data chain spans two directories and `kernel-api` four; a runner
  that reads the union of `dirs[]` ordered by number is TASK-075/077's.
  `chainPreApply` already treats the chain as that union.
- gremion-ui's own ledger (`db.ts`) has no sha256 column, so the kernel data
  plane checks file = manifest for every file at boot (G5) but not
  applied row = manifest; that half lands with the move onto tenant-store.
