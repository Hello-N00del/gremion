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
sudo -u gremion /opt/gremion/bin/gremion-restore-into --stack staging --snapshot latest --rto \
  --proof-file "${file}:${sha}" --proof-row db=gremion sql="$sql" want="$want"
```

### Post-condition

```bash
jq -e '.ok == true' /opt/gremion/runtime/last-restore.json
docker ps --format '{{.Label "com.docker.compose.project"}} {{.Names}}' | awk '$1 ~ /^staging-/' | wc -l
for c in $(docker ps --format '{{.Label "com.docker.compose.project"}} {{.Names}}' | awk '$1 ~ /^staging-/ {print $2}'); do
  v="$(docker exec "$c" sh -c 'printenv SMTP_HOST || true' 2>&1)" || v="EXEC-FAILED ${v}"; printf '%s SMTP_HOST=%s\n' "$c" "${v:-<unset>}"
done
```

## Arm C — reboot measurement (TRD-180)

- Wall-clock budget: one working day (PRD-PLAT-005)

### Preconditions

- An off-host probe is running.

### Steps

1. **Reboot the host.**

```bash
systemctl reboot
```

### Post-condition

```bash
grep -E 'REBOOT-GATE: verify=pass restarted=[01]' /opt/gremion/logs/reboot-gate.log | tail -n 1
curl -fsS -o /dev/null -w '%{http_code}\n' "https://example.org/api/health"
```

The first member sign-in and the off-host probe log are recorded.

## Changelog

- 1.0.0 (2026-09-27): first version.
