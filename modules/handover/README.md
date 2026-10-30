# handover

Placeholder for the handover module (handing an organisation's records to its successors).
Status: **manifest only** ([docs/modules.md](../../docs/modules.md)). The directory holds
`module.json` and `package.json` and nothing else: no routes, no migrations, no service, no
tests.

| | |
|---|---|
| Directory / `module.json` id | `handover` |
| Manifest id (`config.modules` key) | none in this tree |
| Package | `handover-module` (no scripts, no dependencies) |
| Leaf service | none |

## What `module.json` declares

Schema version 1, runtime version `0.1.0`, no database, no export, no timed jobs and no
platform server (`database`, `export` and `platformServer` are `null`). The `package.json`
description says the directory is a placeholder until an `app/` half is added.

## Routes, migrations, configuration, external services

None. Any statement beyond the two files would not be derived from code.

## Enabling and disabling

- Build: not in `modules/disabled.json`, and there is no `app/` half to overlay, so the
  module contributes nothing to a build.
- Per customer: the pilot create request does not name it
  ([pilot/module-defaults.md](../../docs/pilot/module-defaults.md)). What enabling it would do
  is not defined by anything in this directory.

## Tests

None. The repository-wide module checks (`scripts/check-module-source-scan.mjs`,
`scripts/check-pilot-module-defaults.mjs`, `scripts/check-module-docs.mjs`) read this
directory's files.

## Not established from the code

- The planned scope of the module. Other documents in the repository mention handover in a
  list of modules; none of them is a specification, and none was relied on here.
