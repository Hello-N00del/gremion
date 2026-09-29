# Fixture runbook (valid)

The positive control for `test/host/runbook.bats`: every check must pass on
this directory. Each sibling fixture directory overlays one file that breaks
exactly one rule. Procedures: [install](install.md), [upgrade](upgrade.md),
[backup](backup.md), [restore](restore.md), [run record](run-record.md).

It cites `infra/host/bootstrap.sh` and `docs/ops/host-tooling.md`.

## Manual steps

- `install.md` step 1 — rebuild the server at the provider panel.
- `restore.md` arm A step 1 — restore the host backup at the provider panel.
