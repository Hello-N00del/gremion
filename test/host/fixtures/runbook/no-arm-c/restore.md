# Restore (fixture)

- Version: 1.0.0

TRD-174 and TRD-180; the reboot measurement's runner is TASK-123.

## Arm A — provider host-backup restore (TRD-174)

Performed by the operator (R21-26).

- Wall-clock budget: one working day (TRD-175)

### Preconditions

- A provider-side host backup exists.

### Steps

1. **Restore the host backup.** MANUAL: at the provider panel, restore the
   host backup onto the same server.

### Post-condition

```bash
jq -e '.ok == true' /opt/gremion/runtime/last-verify.json
```

## Arm B — platform dump into a non-production stack

- Wall-clock budget: one working day (PRD-PLAT-005)

### Preconditions

- A non-production unit exists.

### Steps

1. **Restore into the staging stack.**

```bash
/opt/gremion/bin/gremion-restore-into --stack staging --snapshot latest --rto \
  --proof-file "${file}:${sha}" --proof-row db=gremion sql="$sql" want="$want"
```

### Post-condition

```bash
jq -e '.ok == true' /opt/gremion/runtime/last-restore.json
```

## Changelog

- 1.0.0 (2026-09-27): first version.
