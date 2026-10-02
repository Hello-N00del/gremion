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

3. **Render, then start the state project.**

```bash
sudo -u gremion /opt/gremion/bin/gremion-render --release "$REL"
sudo -u gremion ln /opt/gremion/etc/secrets/ipcrypt_key.txt "$REL/secrets/ipcrypt_key.txt"
docker compose --env-file /opt/gremion/etc/env/state.env up -d
```

4. **Disable the backup timer.**

```bash
systemctl disable --now gremion-backup.timer
```

## Post-condition

```bash
systemctl is-enabled gremion-backup.timer    # disabled
systemctl is-active gremion-backup.timer     # inactive
jq -e '.ok == true' /opt/gremion/runtime/last-verify.json
stat -c '%U %a %n' /opt/gremion/etc/env/*.env   # gremion 600, every file
kc="$(docker compose --env-file /opt/gremion/etc/env/state.env ps -q keycloak)"
KC_CLI_PASSWORD="$KEYCLOAK_ADMIN_PASSWORD" docker exec -e KC_CLI_PASSWORD "$kc" /opt/keycloak/bin/kcadm.sh config credentials --server http://127.0.0.1:8080/auth --realm master --user "$KEYCLOAK_ADMIN"
docker exec "$kc" /opt/keycloak/bin/kcadm.sh get events -r example -q type=LOGIN -q max=1
docker exec "$kc" rm -f /opt/keycloak/.keycloak/kcadm.config
```

## Known gaps

- `bootstrap.sh timers` (`stage_timers`) runs `enable --now`; owner TASK-040.

## Changelog

- 1.0.0 (2026-09-27): first version.
