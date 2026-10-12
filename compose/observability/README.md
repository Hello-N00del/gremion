# `${STACK}-ops` — the operator-only observability stack (TASK-039)

PRD-OPS-007, PRD-DEP-002 (operator half); TRD-197, TRD-181, TRD-182, TRD-111,
TRD-199, TRD-203, TRD-224; FLOW-OPS-009. One compose project on the ops side,
non-council, started always and only from this directory:

    cd /opt/gremion/current/compose/observability
    docker compose --env-file /opt/gremion/etc/env/ops.env up -d

`COMPOSE_FILE` in `ops.env` is the relative name `docker-compose.yml`, and the
compose file names its configs relative to this directory
(`./prometheus/`, `./blackbox.yml`, `../../docker/{loki,tempo,alloy}/`).
Before the first `up`, and after every tenant or alert-sink change, run
`infra/host/ops/render-ops.sh` as the deploy user (it writes the probe lists,
the Grafana provisioning tree and the credential files under `etc/secrets/ops`).

## Services

| Service | Role | Host port |
|---|---|---|
| `grafana` | the one entry point; Grafana-managed alerting [D R17-23] | `${OPS_BIND_IP}:3000` (loopback) |
| `prometheus` | metrics store; recording rules `gremion:cond:*` | none |
| `loki` | log store, single binary, per-class retention | none |
| `tempo` | trace store, 7-day retention | none |
| `alloy` | collector and receive-only OTLP ingest | `${OPS_INGEST_BIND_IP}:4317/4318` |
| `blackbox` | probes from the file-SD lists | none |

Every image is digest-pinned (`infra/host/ops/pin-images.sh`), every service is
limited and carries a probing healthcheck. Loki, Tempo and Alloy ship
distroless images; their healthchecks run a pinned static busybox mounted
read-only from its image at `/probe`.

## Access (TRD-111, Q4/Q5)

Grafana listens on loopback only. Reach it through an SSH tunnel:

    ssh -N -L 3000:127.0.0.1:3000 <deploy-user>@<host>

and open `http://127.0.0.1:3000/`. There is no login form, no basic auth, no
anonymous access and no local admin (`GF_SECURITY_DISABLE_INITIAL_ADMIN_CREATION`).
The sole sign-in is the `platform` realm by its public URL
(`https://<PLATFORM_DOMAIN>/auth/realms/platform`), client `grafana`
(`docker/keycloak/realm-export.ops.json`): confidential, PKCE, default and
minimum ACR `loa2`, the `acr` and realm-role claims mapped into the ID token.
The gate is
`contains(realm_access.roles[*], 'operator') && acr == 'loa2' && 'Admin' || ''`
with `role_attribute_strict`: a council realm's token, a user without the
`operator` role, and an `operator` without the second factor are all refused.
No network is shared with Keycloak; the public route stays the panel's
[D R29-I11]. The client secret is `etc/secrets/grafana/client_secret` (0600);
until it exists Grafana starts and nobody can sign in (`render-ops.sh` prints
`grafana-sso=pending`). Who writes it depends on how the ops realm was made:

| How the `platform` realm was created | Who writes `etc/secrets/grafana/client_secret` |
|---|---|
| `gremion-tenant init --realm-only --keycloak-container <kc>` | `gremion-tenant` itself, 0600, after the realm read-back |
| `gremion-tenant init` on the pooled stack (the default: `tenant-create` creates the realm, Keycloak generates the secret) | nobody yet: read it once, **A** below (`gremion-tenant init` prints a NOTE) |
| before TASK-039 (no `grafana` client; `gremion-tenant init` refuses the changed template, by design) | add the client, **B** below, then **A** |

Each block runs as the deploy user, with the Keycloak admin password handed to
kcadm by name (never on a command line); open the session first and close it
after:

    kc="$(cd /opt/gremion/current && docker compose --env-file /opt/gremion/etc/env/state.env ps -q keycloak)"
    KC_CLI_PASSWORD="$KEYCLOAK_ADMIN_PASSWORD" docker exec -e KC_CLI_PASSWORD "$kc" /opt/keycloak/bin/kcadm.sh \
      config credentials --server http://127.0.0.1:8080/auth --realm master --user "$KEYCLOAK_ADMIN"
    # ... B and/or A ...
    docker exec "$kc" rm -f /opt/keycloak/.keycloak/kcadm.config

**B. Add the `grafana` client to an ops realm made before TASK-039** (on a realm
that already has it, `create clients` answers 409: skip to A):

    jq '.clients[] | select(.clientId == "grafana")' /opt/gremion/current/docker/keycloak/realm-export.ops.json \
      | docker exec -i "$kc" /opt/keycloak/bin/kcadm.sh create clients -r platform -f -
    id="$(docker exec "$kc" /opt/keycloak/bin/kcadm.sh get clients -r platform -q clientId=grafana --fields id | jq -r '.[0].id')"
    docker exec "$kc" /opt/keycloak/bin/kcadm.sh get roles/operator -r platform | jq -c '[.]' \
      | docker exec -i "$kc" /opt/keycloak/bin/kcadm.sh create "clients/${id}/scope-mappings/realm" -r platform -f -

**A. Write the secret Keycloak holds for the `grafana` client** (reads it, never
rotates it; the value goes from kcadm straight into the 0600 file):

    id="$(docker exec "$kc" /opt/keycloak/bin/kcadm.sh get clients -r platform -q clientId=grafana --fields id | jq -r '.[0].id')"
    [ -n "$id" ] && [ "$id" != null ] || echo "no grafana client in realm platform: run B first"
    install -d -m 700 /opt/gremion/etc/secrets/grafana
    docker exec "$kc" /opt/keycloak/bin/kcadm.sh get "clients/${id}/client-secret" -r platform \
      | jq -r .value | (umask 077; cat > /opt/gremion/etc/secrets/grafana/client_secret)
    test -s /opt/gremion/etc/secrets/grafana/client_secret && stat -c '%a' /opt/gremion/etc/secrets/grafana/client_secret   # 600

then re-run `render-ops.sh` (it prints `grafana-sso=ready`) and restart Grafana.
Writing the file from `tenant-create` on the pooled path is a named residual,
handed to TASK-043d (the control panel's host-side executor replaces
`gremion-tenant` as the operator surface; `docs/ops/host-tooling.md` keeps the
three cases in one place).

## Collection [A, Q3 / Q11 provisional]

TRD-203 leaves the ops side no route to NATS or Postgres, and Vector runs with
`network_mode: none`. So, provisional until the operator answers Q3/Q11:

- the **host collector** (`infra/host/ops/metrics-textfile.sh`, every minute,
  as the deploy user) carries every signal the ops containers may not read:
  the broker's `jsz` (read with `docker exec` inside the broker container,
  whose monitor listens on its loopback), Postgres connections, container
  health, memory and writable-layer bytes, filesystem bytes, the TRD-224
  storage components, and the backup record and timer state (Q8);
- **Alloy reads Vector's output volume read-only** and ships the pseudonymised
  security log to Loki as `class=security`; Vector stays networkless;
- Alloy reads procfs and sysfs read-only (memory, CPU, load) and the host
  collector's textfile, and remote-writes both to Prometheus.

No ops container holds the Docker API: a socket proxy with `CONTAINERS=1`
would hand `/containers/{id}/json`, every injected council secret, to whatever
sits beside it (H21). This replaces the brief's ops-local socket proxy (Q6)
[A, named deviation]. The blackbox exporter stays a container of its own,
because its targets are file-SD lists the host renders [A].

## Ingest (Q15, TRD-197)

Alloy's OTLP receiver (gRPC 4317, HTTP 4318) is published on
`OPS_INGEST_BIND_IP`, the `${STACK}_state` bridge's gateway address, so a
council container reaches it through the host while no ops service joins a
council network. Every request presents `Authorization: Bearer
<OTLP_INGEST_TOKEN>`; `render-ops.sh` refuses an empty or sentinel token.
Spans go to Tempo, metrics to Prometheus, logs to Loki as `class=application`.
Senders push; ops dials nothing on `_state`. TASK-116 builds the senders;
TASK-079 (DLQ gauges) and TASK-150 (latency) push through the same path.

## Alerting (TRD-181, TRD-182, FLOW-OPS-009)

Recording rules in `prometheus/rules.yml` compute one 0/1 condition per alert,
labelled by `component`, each with an `absent()` arm (fail-closed);
`prometheus/rules.test.yml` proves both directions under `promtool`. Grafana
rules (`grafana/provisioning/alerting/rules.yaml`) fire on `> 0`; no data and
evaluation errors alert too.

| Alert | Condition | for |
|---|---|---|
| `DiskAbove70` | `/` above 70 % (host df) | 15m |
| `MemoryPressure` | under 10 % memory available | 10m |
| `ContainerUnhealthy2m` | a container unhealthy, or vector not running | 2m |
| `CertExpiresUnder20d` | a served certificate expires in < 20 days | 1h |
| `BackupFailedOrOverdue` | last backup failed, or timer on and > 26 h old (Q8) | 10m |
| `MailQueueOldest1h` | oldest queued mail > 1 h (series unverified, S4) | 5m |
| `PostgresConnections80pct` | connections > 80 % of max | 10m |
| `EdgePort80Down` | :80 not answering the ACME probe | 5m |
| `BrokerConsumerStalled` | work outstanding, ack floor still for 10 min | 5m |
| `StorageComponentAbove70pct` | a component > 70 % of the provisioned disk (TRD-224) | 15m |
| `ThirdPartyUnreachable` | a third-party service not answering (PRD-DEP-002) | 5m |
| `SignalAbsent` | a signal stopped arriving (TRD-181) | 5m |

The policy (`grafana/provisioning/alerting/policies.yaml`) groups by
`[alertname, component]`, `group_wait 30s`, `group_interval 5m`,
`repeat_interval 8760h`, and the contact point sends a resolve notice: one
e-mail per breached component, none for a second breach of the same component
while it fires, one when it clears. Grafana's embedded Alertmanager keeps its
notification log for a bounded period (about five days), so a condition that
stays open longer can be notified again once its log entry has expired: a
named deviation from "never repeated" for the operator [A, Q7, R16-6].

The contact point `platform` is rendered by `render-ops.sh` from
`ALERT_EMAIL_TO` (e-mail through `ALERT_SMTP_HOST:ALERT_SMTP_PORT` as
`alerts@`) and `ALERT_WEBHOOK_URL` (a second integration, off while a
sentinel, Q12). With neither set, no contact point and no policy are rendered:
the rules evaluate and show, nothing is sent.

## Retention (R29-I6: 30 days at most, worst case)

| Store | Window | Worst case | Where |
|---|---|---|---|
| Loki `class=access` | 14 d | 15 d 2 h 10 min | `docker/loki/loki.yaml` |
| Loki `class=security`, `finance`, `audit` | 27 d | 28 d 2 h 10 min | idem |
| Loki `class=application` | 28 d [A] | 29 d 2 h 10 min | idem |
| Loki, no class | 14 d | 15 d 2 h 10 min | idem |
| Tempo | 7 d (RC-LOG-TRC 7 / 14) | under 14 d | `docker/tempo/tempo.yaml` |
| Prometheus | `PROM_RETENTION_TIME=27d` | 29 d 19 h (window + a block of up to 10 % + the 2-hourly compaction) | `ops.env`, refused above 27 d |
| Grafana's request log on disk | 7 days | 7 d | `GF_LOG_FILE_MAX_DAYS` |

`retention.test.mjs` fails on any window whose worst case exceeds 30 days.

## Checks

    node --test "compose/observability/*.test.mjs"     # static: render, mounts, access, alerting, retention, TRD-199
    OPS_ROOT=<rendered root> test/host/integration/ops-check-configs.sh   # promtool, Loki, Alloy, blackbox, from the pinned images
    test/host/integration/observability-proof.sh       # the running proof (scratch stack t039-<sha8>)

`node scripts/verify/verify.mjs --only observability` runs the static half as a
required verify suite.

## Open operator questions (provisional [A] defaults applied)

- Q3 / Q11: collection by the host collector and a read-only view of Vector's
  volume, instead of R15-3's Postgres metrics in Alloy, a NATS exporter and
  Vector shipping to Loki (none has a route under TRD-203).
- Q6: no ops-local Docker socket proxy (H21, see Collection); per-container
  memory, CPU and disk come from the host collector.
- Q7: Grafana's notification-log period on the pinned image (one repeat of an
  open condition after about five days).

## Footprint (TRD-223)

Three components fill silently and are written down once per ISO week, so a
growth curve exists: the Synapse database (`pg_database_size('synapse')` in
`messaging-postgres`), the per-council file store (`du -sb` of every
`<root>/<tenant uuid>/` directory under `GREMION_FOOTPRINT_FILESTORE_ROOT`),
and the pseudonymised-log volume (the Vector volume, as the daemon sizes it).
The six ops containers are counted apart (`platform_overhead`, TRD-203): they
carry the label `gremion.footprint: platform_overhead`, which `footprint.sh`
reads with `docker ps --all --size --filter label=...`.

`gremion-footprint.timer` fires `infra/host/ops/footprint.sh` Monday 03:00 UTC
(`OnCalendar=Mon *-*-* 03:00:00 UTC`, `Persistent=true`: the same moment as the
seeded `plt.scheduled_job` cron `0 3 * * 1`; `weekly` would fire at 00:00 local
and disagree with it [A, named deviation from the TASK-039 brief]). Each run
writes, in this order, each atomically:

| Artefact | Content |
|---|---|
| `runtime/footprint/<ISO-week>.json` | `{schema, week, scheduled_for, measured_at, outcome: {status, measured_of_three, incomplete, errored}, components: [{component, council?, bytes\|null, status: measured\|absent, absent_reason?: not_present\|error, source}]}`; kept as measurements (about 1 KB a week), not logs: the 30-day cap of R29-I6 does not apply |
| `runtime/textfile/gremion-footprint.prom` | its own textfile (the per-minute collector never overwrites it): `gremion_footprint_component_bytes{component[,council]}` for measured entries only, plus `gremion_footprint_timestamp_seconds`, written only by a `succeeded` run; Alloy reads the directory, no Alloy change |
| one `plt.job_run` row | `job_kind footprint_measurement`, `detail_ref footprint/<ISO-week>.json` (plus `#incomplete=<c>[,<c>]` when one of the three was not fully measured), one row per week (`UNIQUE (scheduled_job_id, scheduled_for)`, `ON CONFLICT DO NOTHING`), except a retry row (below) |

A component that cannot be measured is `absent` (`bytes: null`, no gauge line),
never `0`, and the record says why. `not_present`: there is nothing to measure
(no `messaging-postgres` container, `GREMION_FOOTPRINT_FILESTORE_ROOT` unset --
no compose file mounts the storage root yet: the app-compose owner mounts it,
then sets the key -- or no Vector volume); that does not fail the run.
`error`: the source is there and did not answer (the size query failed, `du`
could not read a council directory, `docker system df` failed, the configured
root is not a directory); that fails the run. A council directory `du` cannot
fully read (its files belong to the app container's uid, the unit runs as the
deploy user) is absent with its `council` id: a partial `du` total would
undercount, so it is never recorded as a number.

The run is `failed` (exit 1) when none of the three components was measured or
one of them errored, `succeeded` otherwise; a disabled `footprint_measurement`
definition gets a `skipped` row. `plt.job_run` is append-only, so a week whose
only rows are `failed` gets a **retry row** when a later run in the same week
succeeds: keyed on that run's `measured_at`, the failed row stays as history and
the newest row is the success (`job_run=retried`). A rerun after a success, or a
failed rerun, writes nothing (`job_run=exists`, naming what the week holds).

The collector additionally emits `gremion_job_last_run{job_kind[,customer],status}`:
the newest `plt.job_run` finish time per job DEFINITION (Unix seconds, one
family). A customer-scoped definition (one per customer, e.g. `backup_nightly`)
carries the pseudonymous customer uuid, so one customer's failure is never
hidden by another's later success; a platform definition has no `customer`
label. It is absent while the database or the table is unreachable. A run that
fails shows three ways: the unit's state, a missing or old
`gremion_footprint_timestamp_seconds`, and a `failed` row. Exit 0 = record,
gauge and row done; 1 = record and gauge written but the row failed (database
down, the seed row missing, a platform chain below 0005, each named with psql's
own error) or the run is `failed`; 2 = missing runtime directory or tool. No
rule or alert consumes these series here (the twelve conditions are pinned); the
roll-up and an "older than 8 days or failed" alert are TASK-099 / TASK-123.

## Deferred (named)

- TRD-226 / TRD-198 roll-up, idle baseline and dashboards: TASK-099, TASK-123
  (before the first paid offer, P3). This task supplies the per-container
  series.
- Council container stdout/stderr: no route without the Docker API or the
  Docker data root (Q16); the application log classes arrive by OTLP (TASK-116)
  and TASK-033's shipper.
- Needs the host/operator (TASK-038): the MFA sign-in recorded in Keycloak's
  events, TRD-199's live half, the first real alert via `alerts@`, TRD-197's
  cross-service trace (TASK-116), Q7's notification-log period on the pinned
  Grafana.
