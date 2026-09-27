# Install (fixture)

- Version: 1.0.0
- Wall-clock budget: one working day (PRD-PLAT-005)

The TRD-042 from-zero bring-up: volumes, DNS and certificates re-created, the
TRD-004 guard set re-run, a TRD-340 snapshot taken.

## Preconditions

- The release tag exists.

## Steps

1. **Rebuild the server.** MANUAL: at the provider panel, rebuild the server
   from zero.

2. **Validate the env file.**

```bash
/opt/gremion/bin/gremion-validate-env --env-file /opt/gremion/etc/env/state.env
```

3. **Disable the backup timer.**

```bash
systemctl disable --now gremion-backup.timer
```

## Post-condition

```bash
systemctl is-enabled gremion-backup.timer    # disabled
systemctl is-active gremion-backup.timer     # inactive
jq -e '.ok == true' /opt/gremion/runtime/last-verify.json
```

## Known gaps

- `bootstrap.sh timers` (`stage_timers`) runs `enable --now`; owner TASK-040.

## Changelog

- 1.0.0 (2026-09-27): first version.
