# Restore: three arms

- Version: 2.0.0
- Implements: TRD-200 (restore), TRD-174 and TRD-175 (the provider drill), TRD-170's timed restore, TRD-180 (the reboot measurement), FLOW-OPS-005

Three separately testable arms, each with its own preconditions, steps and
post-condition:

| Arm | What is restored | Where | Run by | Gate |
|---|---|---|---|---|
| A | the hosting provider's host backup | onto this same host | the operator (R21-26), TASK-089 | re-init |
| B | the platform's own backup (the one verification run) | into a neutered non-production stack, never the live one | TASK-089 | re-init |
| C | nothing: the host is rebooted and the recovery measured | this host | TASK-123 | before the first paid offer |

Arm A is the one sanctioned same-host restore. `gremion-restore-into` never
restores into the production stack and never into `etc/`: it refuses a stack
whose env names a public certificate resolver, and it re-reads a digest of
`etc/` after the restore.

## Arm A — provider host-backup restore onto the same host (TRD-174)

This drill is performed by the operator (R21-26); R12-11 rules out the council's
own IT deputy for server-side work. It is the one verification of the provider's
backup product; once it passes, that product is switched off for the pilot
([backup.md](backup.md), step 5, R13-4, R15-1).

- Wall-clock budget: one working day from the start of the restore to the host answering (TRD-175); a miss is recorded with its cause.

### Preconditions

- [install.md](install.md) passed and the provider's backup product is on.
- The operator holds the provider panel login.
- One row and one uploaded file are chosen whose content will prove the restore
  (E12): a database, a query with a one-value answer, and the container path of
  one real uploaded file in the compose service that stores it.

### Steps

1. **Record the expected data**, just before the provider backup is taken. The
   file `/root/drill-expected.txt` is part of that backup, so the restored host
   carries the values it is compared with. `pg` is the state project's server
   that holds the database: `postgres` for the kernel's databases, `<id>-postgres`
   for a module's (the pooled layout, [pooled-stack-layout.md](../pooled-stack-layout.md)).
   Write the values down: the post-condition types them again in a new shell.

```bash
. /opt/gremion/lib/common.sh && load_env /opt/gremion/etc/env/state.env
cd /opt/gremion/current
env_file="/opt/gremion/etc/env/<project>.env"; svc="<service>"; file="<container path>"
pg="postgres"; db="<database>"; sql="<query with a one-value answer>"
docker compose --env-file "$env_file" exec -T "$svc" sha256sum "$file" | tee /root/drill-expected.txt
docker compose --env-file /opt/gremion/etc/env/state.env exec -T "$pg" \
  psql -U postgres -d "$db" -tAc "$sql" | tee -a /root/drill-expected.txt
```

2. **Take the host backup.** MANUAL: at the provider panel, take a host backup
   of this server (or select the one taken after step 1). Record its timestamp.

3. **Restore it onto the same server.** MANUAL: at the provider panel, restore
   that backup onto this same server. Record the time the restore starts: it is
   the start of the measured interval.

4. **Record when the host is available again**, from the first root shell after
   the restore: the end of the measured interval.

```bash
date -u +%Y-%m-%dT%H:%M:%SZ
journalctl --list-boots | tail -n 2
```

### Post-condition

The restored host holds the expected data, and the reboot gate passed on it.
The restore replaced the shell of step 1, so the same values are typed again
here and the fresh readings are compared with the recorded ones:

```bash
. /opt/gremion/lib/common.sh && load_env /opt/gremion/etc/env/state.env
cd /opt/gremion/current
env_file="/opt/gremion/etc/env/<project>.env"; svc="<service>"; file="<container path>"   # as in step 1
pg="postgres"; db="<database>"; sql="<query with a one-value answer>"                      # as in step 1
{ docker compose --env-file "$env_file" exec -T "$svc" sha256sum "$file"
  docker compose --env-file /opt/gremion/etc/env/state.env exec -T "$pg" \
    psql -U postgres -d "$db" -tAc "$sql"; } | diff /root/drill-expected.txt -   # no output: file and row unchanged
test -s /root/drill-expected.txt && wc -l < /root/drill-expected.txt             # 2: the comparison had something to compare
systemctl show gremion-verify.service -p Result --value                          # success
jq -r '.ts, .ok' /opt/gremion/runtime/last-verify.json                           # after the restore, true
host="$(grep -vE '^[[:space:]]*(#|$)' /opt/gremion/etc/tenant-hosts.txt | head -n 1)"
curl -s -o /dev/null -w '%{http_code}\n' "https://${host}/api/health"            # 200
```

The dated result, with the wall-clock time from step 3 to step 4, is published
(TRD-174) and recorded as described in [run-record.md](run-record.md).

## Arm B — the platform backup into a non-production stack

This is the timed-restore half of the one backup verification (TRD-170,
[backup.md](backup.md) step 4). `gremion-restore-into` restores the databases,
volumes and buckets of a restic snapshot into a different stack, neuters it
(every SMTP host pointed at a null sink, the publish tokens blanked) and proves
the restore by content: one real uploaded file by checksum and one database row
by value (E12). It prints `RESTORE-PROOF:` and, with `--rto`, `RTO-SECONDS=`.

- Wall-clock budget: one working day from step 1 to the asserted post-condition (PRD-PLAT-005)

### Preconditions

- A non-production unit: a host (or a second root) whose
  `/opt/gremion/etc/env/state.env` has `STACK=staging`, an empty
  `TRAEFIK_CERT_RESOLVER` and `GREMION_PRODUCTION_STACK=none`; the program
  refuses anything else.
- Its `RESTIC_REPOSITORY` and `RESTIC_PASSWORD` reach the repository that holds
  the verification snapshot of [backup.md](backup.md), step 2.
- Its `/opt/gremion/current` is the release tree of the same tag.
- The proof values were recorded on the production host at backup time. The
  proof row is a kernel database on the state project's `postgres`:
  `gremion-restore-into` proves rows there only, and stops with `BLOCKED:` on a
  dump of a module's own `<id>-postgres` server until the release's restore
  script can target a second server (PENDING TASK-089, `scripts/backup/`).

### Steps

1. **Record the proof values on the production host**, before backup.md's step 2.

```bash
cd /opt/gremion/current
env_file="/opt/gremion/etc/env/<project>.env"; svc="<service>"; file="<container path>"
db="<database>"; sql="<query with a one-value answer>"
docker compose --env-file "$env_file" exec -T "$svc" sha256sum "$file"
docker compose --env-file /opt/gremion/etc/env/state.env exec -T postgres psql -U postgres -d "$db" -tAc "$sql"
```

2. **Restore into the non-production stack, timed**, on the non-production unit,
   with the two values printed in step 1 as `sha` and `want`.

```bash
sudo -u gremion /opt/gremion/bin/gremion-restore-into --stack staging --snapshot latest --rto \
  --proof-file "${file}:${sha}" --proof-row "db=${db}" "sql=${sql}" "want=${want}" \
  --proof-file-service "$svc"
```

### Post-condition

On the non-production unit: the restore proved itself by content, it was timed,
and the restored stack sends no mail. The mail reading is scoped to the restored
stack (`staging`, the `STACK` of the precondition; its compose projects are
`staging-<project>`), so a production container on a shared host is never
listed. It is counted, so an empty list is not a pass, and an exec that fails
prints `EXEC-FAILED` instead of vanishing:

```bash
jq -e '.ok == true and .stack == "staging" and .proofs.files >= 1 and .proofs.rows >= 1 and .proofs.acme == true' \
  /opt/gremion/runtime/last-restore.json
jq -r '.rtoSeconds' /opt/gremion/runtime/last-restore.json                       # the timed restore, in seconds
docker ps --format '{{.Label "com.docker.compose.project"}} {{.Names}}' | awk '$1 ~ /^staging-/' | wc -l   # > 0: the restored stack runs
for c in $(docker ps --format '{{.Label "com.docker.compose.project"}} {{.Names}}' | awk '$1 ~ /^staging-/ {print $2}'); do
  v="$(docker exec "$c" sh -c 'printenv SMTP_HOST || true' 2>&1)" || v="EXEC-FAILED ${v}"; printf '%s SMTP_HOST=%s\n' "$c" "${v:-<unset>}"
done   # one line per staging container; every mail-capable service shows the null sink; no line says EXEC-FAILED
```

## Arm C — the reboot measurement (TRD-180)

After a full host reboot: the time from boot to every always-on service healthy,
and to a member signing in, measured and published before the first paid
offer. The runner is TASK-123. With no backup running in the pilot this is the
only recovery figure a council can weigh (R15-1).

- Wall-clock budget: one working day for the session; the figure itself is measured and recorded, not bounded.

### Preconditions

- [install.md](install.md) passed; `gremion-verify.service` (the reboot gate) is
  enabled, and its output goes to `logs/reboot-gate.log`.
- A machine outside the hosting provider runs the off-host probe.
- A member of the pilot customer is ready to sign in when asked.
- [A] TRD-180 also wants the operator's fallback page shown throughout. While
  the host itself reboots, nothing on it can serve that page; where it is served
  from is TASK-123's to settle. Until then this arm records what can be
  observed: the boot, the gate's pass, the first sign-in and the off-host probe.

### Steps

1. **Start the off-host probe**, on the machine outside the provider: one line
   every 5 seconds, until step 5.

```bash
host="<tenant host>"
while :; do
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    "$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 "https://${host}/api/health")"
  sleep 5
done >> probe.log
```

2. **Reboot the host**, recording the boot it leaves and the time.

```bash
journalctl --list-boots | tail -n 1
date -u +%Y-%m-%dT%H:%M:%SZ
systemctl reboot
```

3. **Read the boot and the gate's pass**, from the first root shell after the
   reboot.

```bash
journalctl --list-boots | tail -n 2                  # a new boot
uptime -s                                            # the boot time
systemctl show gremion-verify.service -p ExecMainExitTimestamp -p Result
grep -E 'REBOOT-GATE: verify=pass restarted=[01]' /opt/gremion/logs/reboot-gate.log | tail -n 1
```

4. **Have a member sign in**, in a browser, then read the sign-in from the
   identity provider.

```bash
. /opt/gremion/lib/common.sh && load_env /opt/gremion/etc/env/state.env
kc="$(cd /opt/gremion/current && docker compose --env-file /opt/gremion/etc/env/state.env ps -q keycloak)"
KC_CLI_PASSWORD="$KEYCLOAK_ADMIN_PASSWORD" docker exec -e KC_CLI_PASSWORD "$kc" /opt/keycloak/bin/kcadm.sh config credentials \
  --server http://127.0.0.1:8080/auth --realm master --user "$KEYCLOAK_ADMIN"
docker exec "$kc" /opt/keycloak/bin/kcadm.sh get events -r "<customer realm>" -q type=LOGIN -q max=1
docker exec "$kc" rm -f /opt/keycloak/.keycloak/kcadm.config
```

The password reaches kcadm through `KC_CLI_PASSWORD`, handed to `docker exec` by
name, so no command line carries it; the `--server` URL ends in Keycloak's
relative path `/auth`, and the last command removes the token kcadm cached in
the container.

5. **Stop the probe** and read its first answer after the reboot, on the
   off-host machine.

```bash
awk '$2 != 200' probe.log | head -n 1                # the first failed probe: the outage begins
awk -v t="<reboot time>" '$1 > t && $2 == 200' probe.log | head -n 1    # the first good probe after it
```

### Post-condition

The host came back on its own, the reboot gate (not a person) re-verified it,
and the three figures (boot to gate pass, boot to the first good probe, boot to
the first sign-in) are recorded:

```bash
boot="$(date -d "$(uptime -s)" +%s)"
jq -e --argjson boot "$boot" '.ok == true and ((.ts | fromdateiso8601) > $boot)' \
  /opt/gremion/runtime/last-verify.json
grep -E 'REBOOT-GATE: verify=pass restarted=[01]' /opt/gremion/logs/reboot-gate.log | tail -n 1
host="$(grep -vE '^[[:space:]]*(#|$)' /opt/gremion/etc/tenant-hosts.txt | head -n 1)"
curl -s -o /dev/null -w '%{http_code}\n' "https://${host}/api/health"            # 200
docker inspect --format '{{.Name}} {{.State.StartedAt}} {{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' \
  $(docker ps -q)                                                              # every line: started after the boot, healthy
```

A `last-verify.json` older than the boot means the gate did not run, however
green the file reads.

## Pending: tenant-export restore on a clean host

PENDING TASK-119 (`services/kernel-api/export/`): restoring one customer's tenant export on a clean host, by a person who is not the vendor, once per release (PRD-OPS-001, FLOW-OPS-006).

The export unit is the customer with all its bodies, never a single body
(R18-1). The mechanism does not exist yet and is gated at the first paid offer
(R22-13); this arm is written when it lands. Until then no council holds an
export of its data, and both Beschluss texts say so.

## Changelog

- 2.0.0 (2026-09-30): R29-MAIN-DEFECTS (R29-MD-A). Arm B's post-condition lists only the restored stack's (`staging-*`) containers, counts them, and prints one `SMTP_HOST` line per container with `EXEC-FAILED` for an exec that failed, instead of an unscoped loop whose silenced errors let an empty or failing list pass. Arm C's sign-in read passes the Keycloak admin password as `KC_CLI_PASSWORD` by name (no `--password` on a command line), uses `--server` with the `/auth` relative path and removes kcadm's cached token. Major: post-conditions and a step changed (Q9).
- 1.0.0 (2026-09-27): first version (TASK-037).
