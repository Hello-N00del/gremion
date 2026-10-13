# `infra/host/ops/` — the host half of `${STACK}-ops`

The ops compose project itself lives in
[`compose/observability/`](../../../compose/observability/README.md) (TASK-039).
This directory keeps only what runs on the HOST:

| File | What it does |
|---|---|
| `render-ops.sh` | renders `runtime/ops/targets/*.yml` (probe lists), `runtime/ops/grafana-provisioning/` (datasources, alert rules, policy, and the contact point from `ALERT_EMAIL_TO` / `ALERT_WEBHOOK_URL`) and the credential files under `etc/secrets/ops/`; prints `OPS-RENDER: files=… targets=… email=… webhook=… stalwart-key=… grafana-sso=…` |
| `metrics-textfile.sh` | the host collector, run by `gremion-metrics.timer` every minute: backup record and timer state, container health, memory and disk, Postgres connections, the newest `plt.job_run` per job definition (`gremion_job_last_run`), the broker's `jsz` gauges, filesystem bytes and the TRD-224 storage components, into `runtime/textfile/gremion.prom` |
| `footprint.sh` | the weekly footprint record (TRD-223), run by `gremion-footprint.timer` Monday 03:00 UTC: `runtime/footprint/<ISO-week>.json`, its own textfile `runtime/textfile/gremion-footprint.prom` and one `plt.job_run` row per week (a retry row when a failed week is rerun successfully); a component it cannot measure is `absent` with its reason (`not_present` or `error`), never 0 (see [the Footprint section](../../../compose/observability/README.md#footprint-trd-223)) |
| `ops-lib.sh` | sourced by `metrics-textfile.sh` and `footprint.sh`: `ops_key` (the environment, else `ops.env`), `esc`, `to_bytes` and `state_container` (never fatal: a failing `docker ps` is "no container"), one copy |
| `pin-images.sh` | rewrites every `image:` without a digest to `<ref>@sha256:<digest>` (default: `compose/observability/docker-compose.yml`) |

`render-ops.sh` runs as the deploy user: it refuses to render unless `OPS_UID`
and `OPS_GID` in `ops.env` are the ids it runs as, and names the observed value
in the refusal. With `ALERT_EMAIL_TO` set to a real address and
`ALERT_SMTP_PASSWORD` (the `alerts@` app password, sentinel group
`alert_smtp`, TASK-015) or `ALERT_SMTP_HOST` still a sentinel, it exits 3
rather than rendering a contact point that cannot send. While `ALERT_EMAIL_TO`
is still its operator sentinel, e-mail alerting is simply **off** and the
renderer says so (`email=off`): not configured is not the same as configured
wrongly. The same holds for the webhook (`webhook=off`, Q12). It exits 2 naming
`ALERT_SMTP_HOST` or `ALERT_SMTP_PORT` when either key is absent or empty, mail
on or off (compose interpolates both on every render; a `CHANGE_ME_` host stays
allowed while e-mail is off), and exits 3 for a port outside 1 to 65535 once
e-mail is on. It refuses a
`PROM_RETENTION_TIME` above 30 days [D R29-I6] and an empty or sentinel
`OTLP_INGEST_TOKEN` (the OTLP ingest is never open, Q15).

Every metric the collector writes is **absent** rather than zero when it cannot
be measured, which is what makes the matching `absent()` arm of
`compose/observability/prometheus/rules.yml` fire.

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

Everything on this host dies with the host. One probe must live somewhere
else — a free tier of any uptime service, or a one-line cron on a machine you
already own. Configure four checks, five-minute interval, alerting to a channel
that is **not** this host's mail:

| Check | Target | Expect |
|---|---|---|
| apex | `https://example.org/` | 200 |
| tenant | `https://pilot.example.org/` | 200 |
| control | `https://control.example.org/` | 200 or 403 |
| mail | TCP `mail.example.org:25` and `:993` | connect |

Replace `example.org` with the platform domain. Port 25 is deliberately
measured only from off-box: section B drops egress TCP/25 for every source but
the mail subnet, so the on-box `blackbox-smtp25` job is recorded, never
alerted.

Prove the channel by breaking it on purpose once (go-live gate G6): stop the
edge, watch the alert arrive, start it again.
