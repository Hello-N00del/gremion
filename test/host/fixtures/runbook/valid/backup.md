# Backup (fixture)

- Version: 1.0.0
- Wall-clock budget: one working day (PRD-PLAT-005)

R15-1: installed, verified once, then disabled. The pre-migration dump (R18-4)
lives in [upgrade](upgrade.md).

## Preconditions

- The backup job is installed.

## Steps

1. **Run the verification once.**

```bash
systemctl start gremion-backup.service
```

## Post-condition

```bash
jq -e '.ok == true' /opt/gremion/runtime/last-backup.json
systemctl is-enabled gremion-backup.timer    # disabled
```

## Changelog

- 1.0.0 (2026-09-27): first version.
