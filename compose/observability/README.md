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
[D R29-I11]. The client secret is `etc/secrets/grafana/client_secret` (0600),
written by `gremion-tenant init --realm-only --keycloak-container <kc>`; until it
exists Grafana starts and nobody can sign in (`render-ops.sh` prints
`grafana-sso=pending`).

**An ops realm created before TASK-039** has no `grafana` client, and its stored
template fingerprint no longer matches, so `gremion-tenant init` refuses it (by
design: an ops realm is never overwritten). Add the client once with kcadm, as
the deploy user, with the Keycloak admin password handed by name (never on a
command line):

    kc="$(cd /opt/gremion/current && docker compose --env-file /opt/gremion/etc/env/state.env ps -q keycloak)"
    KC_CLI_PASSWORD="$KEYCLOAK_ADMIN_PASSWORD" docker exec -e KC_CLI_PASSWORD "$kc" /opt/keycloak/bin/kcadm.sh \
      config credentials --server http://127.0.0.1:8080/auth --realm master --user "$KEYCLOAK_ADMIN"
    jq '.clients[] | select(.clientId == "grafana")' /opt/gremion/current/docker/keycloak/realm-export.ops.json \
      | docker exec -i "$kc" /opt/keycloak/bin/kcadm.sh create clients -r platform -f -
    id="$(docker exec "$kc" /opt/keycloak/bin/kcadm.sh get clients -r platform -q clientId=grafana --fields id | jq -r '.[0].id')"
    docker exec "$kc" /opt/keycloak/bin/kcadm.sh get roles/operator -r platform | jq -c '[.]' \
      | docker exec -i "$kc" /opt/keycloak/bin/kcadm.sh create "clients/${id}/scope-mappings/realm" -r platform -f -
    install -d -m 700 /opt/gremion/etc/secrets/grafana
    docker exec "$kc" /opt/keycloak/bin/kcadm.sh get "clients/${id}/client-secret" -r platform \
      | jq -r .value | (umask 077; cat > /opt/gremion/etc/secrets/grafana/client_secret)
    docker exec "$kc" rm -f /opt/keycloak/.keycloak/kcadm.config

then re-run `render-ops.sh` (it prints `grafana-sso=ready`) and restart Grafana.

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

## Deferred (named)

- TRD-223 (weekly footprint of the three silent-fill components) and the
  `plt.scheduled_job` / `plt.job_run` tables: TASK-039-FU.
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
