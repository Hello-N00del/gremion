# `${STACK}-ops` — on-box observability

Prometheus, Alertmanager, node-exporter, cAdvisor and a blackbox exporter, in
one compose project. Started, always and only, as:

    docker compose --env-file /opt/gremion/etc/env/ops.env up -d

`COMPOSE_FILE` in `ops.env` is a relative name, so run that from
`/opt/gremion/current/infra/host/ops`, or set `COMPOSE_FILE` to the absolute
path of this directory's `docker-compose.yml`.

Nothing here binds a wildcard address: Prometheus and Alertmanager publish on
`${OPS_BIND_IP}` (loopback), so an operator reaches them through an SSH tunnel:

    ssh -N -L 9090:127.0.0.1:9090 <deploy-user>@<host>

## What is host-owned

Prometheus does not read the environment, so the host renders what it needs:

    /opt/gremion/current/infra/host/ops/render-ops.sh

writes `runtime/ops/targets/*.yml` (file service discovery — watched, no reload
needed), `runtime/ops/alertmanager.yml`, and the two credential files under
`etc/secrets/ops/`. Re-run it after every tenant host change. It prints
`OPS-RENDER: files=… targets=… email=… stalwart-key=…`.

The keys it reads live in `ops.env`, not `state.env`: `PLATFORM_DOMAIN`,
`EDGE_BIND_IP`, `EDGE_BIND_IP6`, `OPS_BIND_IP`, `OPS_UID`, `OPS_GID`,
`GREMION_ROOT_DIR`, `PROM_RETENTION_TIME`, `ALERT_WEBHOOK_URL`,
`ALERT_EMAIL_TO`, `ALERT_EMAIL_FROM`, `ALERT_SMTP_USER`, `ALERT_SMTP_PASSWORD`,
`STALWART_API_KEY`, `OPS_TENANT_HOSTS_FILE`. `ALERT_SMTP_PASSWORD` is the
Stalwart app password of §I and shares its generated value with `mail.env`;
with `ALERT_EMAIL_TO` set to a real address and that password still a
`CHANGE_ME_` sentinel, `render-ops.sh` exits 3 rather than rendering an
Alertmanager that cannot send. While `ALERT_EMAIL_TO` itself is still its
operator sentinel, e-mail alerting is simply **off** and the renderer says so
(`email=off`): not configured is not the same as configured wrongly.

`OPS_UID`/`OPS_GID` are filled on the host with `id -u <deploy-user>` /
`id -g <deploy-user>`; `render-ops.sh` refuses to render until they match the
uid it actually runs as, and names the observed value in the refusal.

`gremion-metrics.timer` runs `metrics-textfile.sh` every minute and writes
`runtime/textfile/gremion.prom`: backup age, container health, Postgres
connection use. node-exporter serves it. Every one of those metrics is
**absent** rather than zero when it cannot be measured, which is what makes the
matching `absent()` clause fire.

## The eight rules

`DiskAbove70`, `MemoryPressure`, `ContainerUnhealthy2m`, `CertExpiresUnder20d`,
`BackupOlderThan26h`, `MailQueueOldest1h`, `PostgresConnections80pct`,
`EdgePort80Down`. Every one carries an `absent(...)` clause: a rule whose input
stops arriving fires. A silent dashboard and a healthy host must never look the
same. Adding a ninth rule is a reviewed change.

`MailQueueOldest1h` names a Stalwart series that has not yet been read off a
live endpoint — it is marked unverified in `alerts.yml` and confirmed by the
S4 spike during the mail bring-up. Because the rule is fail-closed, a wrong
series name makes it fire, never fall silent.

Check the rules before shipping a change:

    OPS_RENDERED_AM=<root>/runtime/ops/alertmanager.yml \
        test/host/integration/ops-check-configs.sh

which runs `promtool check config`, `promtool check rules`, `promtool test
rules` (a healthy world where nothing may fire and a blind world where
everything must) and `amtool check-config` from the pinned images. It needs a
root that `render-ops.sh` has already written, because `prometheus.yml` names
the file-SD lists and the Stalwart credential by absolute path and promtool
refuses a config whose credentials file is missing.

Image versions are bumped through `pin-images.sh`, never by editing a tag:
every reference in the committed compose file carries an `@sha256:` digest and
the unit test refuses one that does not.

## The reboot gate

`gremion-verify.service` runs `gremion-verify --reboot` after `docker.service`
on every boot. It waits for the Docker daemon, verifies once, and on failure
restarts the active colour **exactly once**, verifies again, and reports either
way to `ALERT_WEBHOOK_URL` (read from `ops.env` when the environment does not
already carry it — systemd passes only `GREMION_ROOT`). It prints
`REBOOT-GATE: verify=<pass|fail> restarted=<0|1>` into
`/opt/gremion/logs/reboot-gate.log`.

`GREMION_IN_REBOOT_GATE` stops it nesting inside itself (exit 2).
`REBOOT_GATE_SETTLE_SECONDS` (default 30), `REBOOT_GATE_DOCKER_TRIES` (60) and
`REBOOT_GATE_DOCKER_WAIT` (2) are the knobs.

## The off-box probe (operator, N15)

Everything above dies with the host. One probe must live somewhere else — a
free tier of any uptime service, or a one-line cron on a machine you already
own. Configure four checks, five-minute interval, alerting to a channel that
is **not** this host's mail:

| Check | Target | Expect |
|---|---|---|
| apex | `https://example.org/` | 200 |
| tenant | `https://pilot.example.org/` | 200 |
| control | `https://control.example.org/` | 200 or 403 |
| mail | TCP `mail.example.org:25` and `:993` | connect |

Replace `example.org` with the platform domain. Port 25 is deliberately
measured only from off-box: §B drops egress TCP/25 for every source but the
mail subnet, so the on-box `blackbox-smtp25` job is recorded, never alerted.

Prove the channel by breaking it on purpose once (§L gate item 6): stop the
edge, watch the alert arrive, start it again.
