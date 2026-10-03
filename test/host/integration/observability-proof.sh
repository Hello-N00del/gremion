#!/usr/bin/env bash
# test/host/integration/observability-proof.sh -- TASK-039: the running proof of
# the operator-only observability stack (compose/observability) on a scratch
# stack. Every phase is one invocation under 4 minutes; state lives in $OUT.
#
# usage: observability-proof.sh <phase>
#   refresh     re-render the provisioning tree and the override from the existing env
#   prepare     scratch _state slice (PG18, NATS 2.12 with JetStream, one
#               <id>-postgres, a vector stand-in), Vector's output volume, the
#               ops env + render-ops.sh, Mailpit, Keycloak 26.6.1, the collector
#   up          the ops project as ${STACK}-ops: six services healthy by their
#               own healthchecks, ports, mounts, networks
#   signals     every TRD-181 signal fresh in its store (host collector run)
#   absent      a stopped collector: the signals go absent and SignalAbsent mails
#   red-base    RED first: the same breaches on the base rules (before TASK-039) fire nothing
#   alert       a stalled consumer: exactly one e-mail
#   alert-hold  a second breach in the group while firing: no e-mail in 3 x group_interval
#   alert-resolve  clearing: exactly one resolve e-mail
#   storage-red 69/100 MiB: silent   ·  storage  71/100 MiB: one e-mail (TRD-224)
#   ingest-red  receiver unpublished: the push fails  ·  ingest  span + metric land (Q15)
#   access-red  RED first: an operator at loa1 gets in once the acr gate is gone
#   access      TRD-111: operator+MFA in; role-less, loa1 and a council realm out;
#               Grafana reads Prometheus and Tempo; its requests reach Loki as class=audit
#   reach-red   RED: ops joined to _state reaches postgres  ·  reach  TRD-203 by IP
#   down        teardown by name, verified
#
# Proof deviations, each measured on the workstation (Docker Desktop):
#   - the OTLP ingest is published on 127.0.0.1 and the _state sender reaches it
#     through host-gateway: Docker Desktop refuses a bind on a bridge gateway
#     address ("can't bind on the specified endpoint", measured 2026-10-02);
#   - the host collector runs in a container (test/host/fixtures/observability/
#     collector.Dockerfile) against the engine's socket, with a real 100 MiB
#     tmpfs as GREMION_DISK_ROOT and a systemctl shim for the timer state: the
#     engine runs in a VM, so the Windows host has neither;
#   - Mailpit (the alerts@ sink) joins the ops network as `mailpit`;
#   - Grafana's issuer is the scratch Keycloak on 127.0.0.1 (http), reached
#     server-side through host-gateway, instead of the public HTTPS URL;
#   - alert timings are the brief's proof values: evaluation and for 10s,
#     group_wait 10s, group_interval 60s.
# Prints `[obs-proof] N passing (minimum M)` per phase; exit 0 only when every
# check of the phase passed and N >= M.
#
# SC2317 (shellcheck < 0.10) and SC2329 (>= 0.10): the probe helpers run
# through wait_until, so shellcheck sees them as never invoked. SC2015: every
# `check && ok ... || bad ...` line is deliberate -- ok() always succeeds.
# shellcheck disable=SC2317,SC2329,SC2015
set -euo pipefail
export MSYS_NO_PATHCONV=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
PHASE="${1:-}"

# A host-form path for docker -v / compose (C:/... on Git Bash, unchanged on Linux).
hp() { (cd "$1" && (pwd -W 2>/dev/null || pwd)); }
hpf() { printf '%s/%s' "$(hp "$(dirname "$1")")" "$(basename "$1")"; }

SHA8="$(git -C "$(hp "$ROOT")" rev-parse --short=8 HEAD)"
STACK="${OBS_PROOF_STACK:-t039-${SHA8}-obs}"
OUT="${OBS_PROOF_OUT:-$ROOT/.scratch/obs-proof}"
SROOT="$OUT/root"
ENV_FILE="$SROOT/etc/env/ops.env"
OVERRIDE="$OUT/ops.proof.yml"
OPS="${STACK}-ops"

GRAFANA_PORT="${OBS_GRAFANA_PORT:-13030}"
KC_PORT="${OBS_KC_PORT:-18480}"
INGEST_PORT="${OBS_INGEST_PORT:-14318}"
INGEST_GRPC_PORT="${OBS_INGEST_GRPC_PORT:-14317}"
MAILPIT_PORT="${OBS_MAILPIT_PORT:-18025}"
STATE_SUBNET="${OBS_STATE_SUBNET:-10.239.1.0/24}"
STATE_GATEWAY="${STATE_SUBNET%.*}.1"

# Pinned images (the same digests the kernel pins elsewhere).
PG_IMAGE="postgres:18-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873"
NATS_IMAGE="nats:2.12.15-alpine@sha256:b270f5e2428354c0335612694d7dd2fb588148e567a5757fdff325ef9c9332e6"
NATSBOX_IMAGE="natsio/nats-box:0.18.1@sha256:abb33f930d25425dce3472039a0ffac7427344f7c0b7ef9849b9fe45bb8895fe"
BUSYBOX_IMAGE="busybox:1.37.0-musl@sha256:5cec3fc171c87218698e85a52af7087de727372aae264a787b8112901a5b0092"
MAILPIT_IMAGE="axllent/mailpit:v1.30.1@sha256:3bd7c2f2696deb35a4780d152b404dceec99cb041b942c0877b3b22384714f85"
KC_IMAGE="quay.io/keycloak/keycloak:26.6.1@sha256:dea26401d06341095cc4ea9d66896200b55de5ca1daa1d2fcbe58493afa6e0ad"
COLLECTOR_IMAGE="t039-collector:${SHA8}"

NET_STATE="${STACK}_state"
VOL_VECTOR="${STACK}-state_vector-processed-logs"
VOL_NATSCONF="${STACK}-state_nats-conf"
C_PG="${STACK}-state-postgres-1"
C_BOARD="${STACK}-state-board-postgres-1"
C_NATS="${STACK}-state-nats-1"
C_VECTOR="${STACK}-state-vector-1"
C_MAIL="${STACK}-mailpit"
C_KC="${STACK}-keycloak"
C_COLL="${STACK}-collector"
OPS_SERVICES=(alloy blackbox grafana loki prometheus tempo)

PASS=0
FAILS=0
ok()   { printf '  ok   %s\n' "$*"; PASS=$((PASS + 1)); }
bad()  { printf '  FAIL %s\n' "$*" >&2; FAILS=$((FAILS + 1)); }
die()  { printf 'FATAL: %s\n' "$*" >&2; exit 2; }
now()  { date -u +%Y-%m-%dT%H:%M:%SZ; }
gen()  { od -An -N24 -tx1 /dev/urandom | tr -d ' \n'; }

finish() {   # <minimum passing>
    local min="$1"
    mkdir -p "$OUT"
    printf '%s phase=%s stack=%s passing=%s minimum=%s failing=%s\n' "$(now)" "$PHASE" "$STACK" "$PASS" "$min" "$FAILS" >> "$OUT/ledger.log"
    printf '[obs-proof] %s passing (minimum %s), %s failing -- phase %s\n' "$PASS" "$min" "$FAILS" "$PHASE"
    (( FAILS == 0 && PASS >= min )) || exit 1
    exit 0
}

[[ "$STACK" == t039-* ]] || die "the proof runs only on a t039-* scratch stack (STACK=$STACK)"
command -v docker >/dev/null || die "docker not on PATH"
command -v jq >/dev/null || die "jq not on PATH"
command -v curl >/dev/null || die "curl not on PATH"

PY="$(command -v python3 || command -v python || true)"

compose_ops() {   # [extra override file] -- <compose args>
    local extra=()
    if [[ "${1:-}" != "--" ]]; then extra=(-f "$(hpf "$1")"); shift; fi
    shift
    ( cd "$ROOT/compose/observability" \
        && docker compose -p "$OPS" --env-file "$(hpf "$ENV_FILE")" -f docker-compose.yml -f "$(hpf "$OVERRIDE")" "${extra[@]}" "$@" )
}

container_of() { printf '%s-%s-1' "$OPS" "$1"; }

wait_healthy() {   # <seconds> <container...>
    local deadline=$(( $(date +%s) + $1 )) c s all; shift
    while :; do
        all=1
        for c in "$@"; do
            s="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$c" 2>/dev/null || echo missing)"
            [[ "$s" == healthy ]] || all=0
        done
        (( all )) && return 0
        (( $(date +%s) < deadline )) || return 1
        sleep 5
    done
}

promq() {   # <promql> -- the JSON answer of Prometheus, read inside its container
    local enc
    enc="$(jq -rn --arg q "$1" '$q|@uri')"
    docker exec "$(container_of prometheus)" wget -qO- "http://127.0.0.1:9090/api/v1/query?query=${enc}" 2>/dev/null || echo '{}'
}
prom_count() { promq "$1" | jq -r '.data.result | length' 2>/dev/null || echo 0; }
prom_value() { promq "$1" | jq -r '.data.result[0].value[1] // empty' 2>/dev/null || true; }

wait_until() {   # <seconds> <command...> -- poll every 5 s
    local deadline=$(( $(date +%s) + $1 )); shift
    while ! "$@"; do
        (( $(date +%s) < deadline )) || return 1
        sleep 5
    done
}
has_series() { [[ "$(prom_count "$1")" -gt 0 ]]; }
value_is() { [[ "$(prom_value "$1")" == "$2" ]]; }

lokiq() {   # <logql> -- matching lines of the last hour, read inside the Loki container
    local enc start
    enc="$(jq -rn --arg q "$1" '$q|@uri')"
    start="$(( $(date +%s) - 3600 ))000000000"
    docker exec "$(container_of loki)" /probe/bin/busybox wget -qO- "http://127.0.0.1:3100/loki/api/v1/query_range?query=${enc}&start=${start}&limit=1000" 2>/dev/null \
        | jq -r '[.data.result[]?.values[]?[1]] | .[]' 2>/dev/null || true
}
loki_has() { lokiq "$1" | grep -qF -- "$2"; }

# Mailpit, the alerts@ sink: subjects of every message received.
mail_subjects() { curl -fsS "http://127.0.0.1:${MAILPIT_PORT}/api/v1/messages?limit=500" 2>/dev/null | jq -r '.messages[]?.Subject' 2>/dev/null || true; }
mail_count() {   # <FIRING|RESOLVED> <alertname> <component substring>
    mail_subjects | grep -F "[$1" | grep -F -- "$2" | grep -cF -- "$3" || true
}
mail_at_least() { [[ "$(mail_count "$1" "$2" "$3")" -ge "$4" ]]; }

# The host collector, run for real inside its container (see the header).
collect() {
    docker exec -e GREMION_ROOT=/g -e STACK="$STACK" -e GREMION_DISK_ROOT=/disk \
        -e GREMION_STORAGE_COMPONENTS="seeded=/disk/seeded" -e GREMION_STORAGE_INTERVAL=0 \
        "$C_COLL" bash /src/infra/host/ops/metrics-textfile.sh >/dev/null 2>&1
}

natsbox() { docker run --rm --network "$NET_STATE" "$NATSBOX_IMAGE" nats -s "nats://${C_NATS}:4222" "$@"; }

# The proof realms, created in the RUNNING scratch Keycloak through its admin
# REST API (POST /admin/realms). The admin password goes to curl from its file,
# never on a command line.
kc_master_ready() { curl -fsS "http://127.0.0.1:${KC_PORT}/auth/realms/master/.well-known/openid-configuration" >/dev/null 2>&1; }
kc_create_realms() {
    local base="http://127.0.0.1:${KC_PORT}/auth" tok f code
    # curl's own -o /dev/null fails under MSYS_NO_PATHCONV (Git for Windows'
    # curl cannot open that path); the shell's redirect works everywhere.
    wait_until 150 kc_master_ready || return 1
    tok="$(curl -fsS -d grant_type=password -d client_id=admin-cli -d username=admin \
        --data-urlencode "password@$(hpf "$OUT/kc-admin-password")" \
        "${base}/realms/master/protocol/openid-connect/token" | jq -r '.access_token // empty')"
    [[ -n "$tok" ]] || return 1
    for f in platform-realm.json council-proof-realm.json; do
        code="$(curl -sS -o "$(hpf "$OUT/.kc-body")" -w '%{http_code}' -X POST \
            -H "Authorization: Bearer ${tok}" -H 'Content-Type: application/json' \
            --data-binary "@$(hpf "$OUT/kc-realms/$f")" "${base}/admin/realms")"
        [[ "$code" == 201 ]] || { printf 'realm %s: HTTP %s %s\n' "$f" "$code" "$(cat "$OUT/.kc-body")" >&2; return 1; }
    done
}

# The rendered half: render-ops.sh for real, then the proof timings.
render_and_time() {
    GREMION_ROOT="$SROOT" bash "$ROOT/infra/host/ops/render-ops.sh" --env-file "$ENV_FILE" > "$OUT/render.log" 2>&1 \
        || { cat "$OUT/render.log" >&2; die "render-ops.sh failed"; }
    grep -q 'OPS-RENDER: .*email=on webhook=off' "$OUT/render.log" && ok "render-ops.sh: $(grep -o 'OPS-RENDER:.*' "$OUT/render.log")" \
        || bad "render-ops.sh did not render the e-mail contact point"
    # The brief's proof timings (TASK-079 reuses them): evaluation, for and
    # group_wait 10s, group_interval 60s. The committed values are pinned by
    # compose/observability/alerting.test.mjs.
    local prov="$SROOT/runtime/ops/grafana-provisioning/alerting"
    sed -i -E 's/^    interval: 1m$/    interval: 10s/; s/^        for: [0-9]+[smh]$/        for: 10s/' "$prov/rules.yaml"
    sed -i -E 's/^    group_wait: 30s$/    group_wait: 10s/; s/^    group_interval: 5m$/    group_interval: 60s/' "$prov/policies.yaml"
    grep -q '^    interval: 10s$' "$prov/rules.yaml" && grep -q '^    group_interval: 60s$' "$prov/policies.yaml" \
        && ok "proof timings set in the rendered provisioning tree" || bad "proof timings not set"

}

write_override() {
    # The proof override: ports on fresh loopback numbers, the scratch issuer,
    # Mailpit without STARTTLS. It changes no network, volume, limit or mount.
    cat > "$OVERRIDE" <<EOF
services:
  grafana:
    environment:
      GF_SERVER_ROOT_URL: "http://127.0.0.1:${GRAFANA_PORT}/"
      GF_SMTP_STARTTLS_POLICY: NoStartTLS
      # Go's SMTP client refuses PLAIN auth on an unencrypted connection
      # (measured: "unencrypted connection"); Mailpit takes mail unauthenticated.
      GF_SMTP_USER: ""
      GF_AUTH_GENERIC_OAUTH_AUTH_URL: "http://127.0.0.1:${KC_PORT}/auth/realms/platform/protocol/openid-connect/auth"
      GF_AUTH_GENERIC_OAUTH_TOKEN_URL: "http://host.docker.internal:${KC_PORT}/auth/realms/platform/protocol/openid-connect/token"
      GF_AUTH_GENERIC_OAUTH_API_URL: "http://host.docker.internal:${KC_PORT}/auth/realms/platform/protocol/openid-connect/userinfo"
    extra_hosts:
      - "host.docker.internal:host-gateway"
    ports: !override
      - "127.0.0.1:${GRAFANA_PORT}:3000"
  alloy:
    ports: !override
      - "127.0.0.1:${INGEST_GRPC_PORT}:4317"
      - "127.0.0.1:${INGEST_PORT}:4318"
EOF
}

# ---------------------------------------------------------------------------
phase_prepare() {
    mkdir -p "$OUT" "$SROOT/etc/env" "$SROOT/runtime" "$OUT/kc-realms"
    # Grafana binds its users to the Keycloak user ids of the realms created
    # below, which are new on every prepare; a grafana-data left by an earlier
    # prepare refuses every sign-in ("unable to create user: user not found",
    # measured 2026-10-03). So it starts empty, and never under a running Grafana.
    if docker inspect "$(container_of grafana)" >/dev/null 2>&1; then
        die "the ops project is up: run down before prepare (or refresh to re-render)"
    fi
    rm -rf "$SROOT/runtime/ops/grafana-data"
    local taken
    # shellcheck disable=SC2046  # one argument per network id
    taken="$(docker network inspect $(docker network ls -q) --format '{{.Name}} {{range .IPAM.Config}}{{.Subnet}} {{end}}' 2>/dev/null \
        | grep -F " ${STATE_SUBNET} " | grep -v "^${NET_STATE} " || true)"
    [[ -z "$taken" ]] || die "${STATE_SUBNET} already in use: $taken"

    docker build -q -t "$COLLECTOR_IMAGE" -f "$(hpf "$ROOT/test/host/fixtures/observability/collector.Dockerfile")" \
        "$(hp "$ROOT/test/host/fixtures/observability")" >/dev/null || die "the collector image did not build"
    ok "collector image $COLLECTOR_IMAGE built"

    docker network inspect "$NET_STATE" >/dev/null 2>&1 \
        || docker network create --subnet "$STATE_SUBNET" "$NET_STATE" >/dev/null
    docker volume inspect "$VOL_VECTOR" >/dev/null 2>&1 || docker volume create "$VOL_VECTOR" >/dev/null
    docker volume inspect "$VOL_NATSCONF" >/dev/null 2>&1 || docker volume create "$VOL_NATSCONF" >/dev/null
    docker run --rm -v "${VOL_NATSCONF}:/c" "$BUSYBOX_IMAGE" sh -c \
        'printf "listen: 0.0.0.0:4222\nhttp: 127.0.0.1:8222\njetstream { store_dir: /data }\n" > /c/nats.conf'
    docker run --rm -v "${VOL_VECTOR}:/logs" "$BUSYBOX_IMAGE" sh -c \
        'echo "{\"RequestReceivedAt\":\"prepare\",\"RequestPath\":\"/auth/proof\"}" >> /logs/security.log; chmod 644 /logs/security.log'
    ok "scratch network $NET_STATE and volumes $VOL_VECTOR, $VOL_NATSCONF"

    local labels=(--label "com.docker.compose.project=${STACK}-state")
    docker inspect "$C_PG" >/dev/null 2>&1 || docker run -d --name "$C_PG" --network "$NET_STATE" "${labels[@]}" \
        --label com.docker.compose.service=postgres -e POSTGRES_PASSWORD="$(gen)" "$PG_IMAGE" >/dev/null
    docker inspect "$C_BOARD" >/dev/null 2>&1 || docker run -d --name "$C_BOARD" --network "$NET_STATE" "${labels[@]}" \
        --label com.docker.compose.service=board-postgres -e POSTGRES_PASSWORD="$(gen)" "$PG_IMAGE" >/dev/null
    docker inspect "$C_NATS" >/dev/null 2>&1 || docker run -d --name "$C_NATS" --network "$NET_STATE" "${labels[@]}" \
        --label com.docker.compose.service=nats -v "${VOL_NATSCONF}:/c:ro" "$NATS_IMAGE" -c /c/nats.conf >/dev/null
    docker inspect "$C_VECTOR" >/dev/null 2>&1 || docker run -d --name "$C_VECTOR" --network none "${labels[@]}" \
        --label com.docker.compose.service=vector "$BUSYBOX_IMAGE" sleep 86400 >/dev/null
    ok "scratch _state slice: postgres, board-postgres, nats (JetStream, monitor on its loopback), vector stand-in"

    # The ops env, rendered by the real render-ops.sh.
    local token smtp kcpw
    token="$(gen)$(gen)"; smtp="$(gen)"; kcpw="$(gen)"
    printf '%s' "$kcpw" > "$OUT/kc-admin-password"
    cat > "$ENV_FILE" <<EOF
STACK=${STACK}
COMPOSE_PROJECT_NAME=${OPS}
COMPOSE_FILE=docker-compose.yml
OPS_V4_SUBNET=10.239.8.0/24
OPS_V6_SUBNET=fd5a:239:8::/64
GREMION_ROOT_DIR=$(hp "$SROOT")
OPS_BIND_IP=127.0.0.1
OPS_INGEST_BIND_IP=127.0.0.1
OPS_UID=$(id -u)
OPS_GID=$(id -g)
PROM_RETENTION_TIME=1d
PLATFORM_DOMAIN=example.org
EDGE_BIND_IP=203.0.113.10
ALERT_WEBHOOK_URL=CHANGE_ME_OPERATOR_alert_webhook_url
ALERT_EMAIL_TO=ops@proof.invalid
ALERT_EMAIL_FROM=alerts@proof.invalid
ALERT_SMTP_HOST=mailpit
ALERT_SMTP_PORT=1025
ALERT_SMTP_USER=alerts@proof.invalid
ALERT_SMTP_PASSWORD=${smtp}
STALWART_API_KEY=CHANGE_ME_GEN_hex32_stalwart_api
OTLP_INGEST_TOKEN=${token}
OPS_TENANT_HOSTS_FILE=$SROOT/etc/tenant-hosts.txt
OPS_THIRD_PARTY_PROBES=nextcloud=http://${STACK}-gone.invalid/status.php
EOF
    render_and_time

    # Keycloak: the platform realm from docker/keycloak/realm-export.ops.json,
    # secrets generated here (as gremion-tenant's kcadm path does), the grafana
    # redirect on the proof port, a weakened twin client for the RED phase, and
    # the proof users; plus one council realm.
    local gsecret otp
    gsecret="$(gen)"; otp="$(gen | cut -c1-20)"
    printf '%s' "$otp" > "$OUT/otp-secret"
    mkdir -p "$SROOT/etc/secrets/grafana"
    printf '%s\n' "$gsecret" > "$SROOT/etc/secrets/grafana/client_secret"
    local pw; pw="$(gen)"; printf '%s' "$pw" > "$OUT/user-password"
    OTP="$otp" PW="$pw" GS="$gsecret" CP="$(gen)" jq --arg port "$GRAFANA_PORT" '
        def creds($otp): [{type: "password", value: $ENV.PW, temporary: false}]
          + (if $otp then [{type: "otp", secretData: ({value: $ENV.OTP} | tojson),
               credentialData: ({subType: "totp", digits: 6, counter: 0, period: 30, algorithm: "HmacSHA1"} | tojson)}] else [] end);
        def user($n; $roles; $otp): {username: $n, enabled: true, email: ($n + "@proof.invalid"), emailVerified: true,
          firstName: "Proof", lastName: $n, realmRoles: $roles, credentials: creds($otp)};
        (.clients[] | select(.clientId == "control-panel")).secret = $ENV.CP
        | (.clients[] | select(.clientId == "grafana")) |= (.secret = $ENV.GS
            | .redirectUris = ["http://127.0.0.1:" + $port + "/login/generic_oauth"]
            | .webOrigins = ["http://127.0.0.1:" + $port])
        | .clients += [(.clients[] | select(.clientId == "grafana")
            | .clientId = "grafana-weak" | .name = "proof only: no ACR floor"
            | .attributes |= del(.["default.acr.values"], .["minimum.acr.value"]))]
        | .scopeMappings += [{client: "grafana-weak", roles: ["operator"]}]
        | .users = [user("op-mfa"; ["operator"]; true), user("op-loa1"; ["operator"]; false), user("norole"; []; true)]
        ' "$(hpf "$ROOT/docker/keycloak/realm-export.ops.json")" > "$OUT/kc-realms/platform-realm.json" \
        || die "could not build the proof realm"
    PW="$pw" jq -n '{realm: "council-proof", enabled: true, roles: {realm: [{name: "operator"}]},
        users: [{username: "council-user", enabled: true, email: "council-user@proof.invalid", emailVerified: true,
                 firstName: "Council", lastName: "User", realmRoles: ["operator"],
                 credentials: [{type: "password", value: $ENV.PW, temporary: false}]}]}' > "$OUT/kc-realms/council-proof-realm.json"
    # Recreated on every prepare: the realm above carries this run's secrets.
    # The kernel has no boot-time realm loading (B-01), so neither has the
    # proof: the two realms are created through the running Keycloak's admin
    # REST API, as an operator would.
    docker rm -f "$C_KC" >/dev/null 2>&1 || true
    docker run -d --name "$C_KC" -p "127.0.0.1:${KC_PORT}:8080" \
        -e KC_BOOTSTRAP_ADMIN_USERNAME=admin -e KC_BOOTSTRAP_ADMIN_PASSWORD="$kcpw" \
        -e KC_HTTP_RELATIVE_PATH=/auth -e KC_HOSTNAME="http://127.0.0.1:${KC_PORT}/auth" \
        -e KC_HOSTNAME_BACKCHANNEL_DYNAMIC=true "$KC_IMAGE" start-dev >/dev/null
    write_override
    ok "Keycloak 26.6.1 started outside ops on 127.0.0.1:${KC_PORT}"
    kc_create_realms && ok "the platform realm and a council realm created through the admin API" \
        || bad "the proof realms could not be created through the admin API"

    docker inspect "$C_MAIL" >/dev/null 2>&1 || docker run -d --name "$C_MAIL" -p "127.0.0.1:${MAILPIT_PORT}:8025" \
        -e MP_SMTP_AUTH_ACCEPT_ANY=1 -e MP_SMTP_AUTH_ALLOW_INSECURE=1 "$MAILPIT_IMAGE" >/dev/null
    docker inspect "$C_COLL" >/dev/null 2>&1 || docker run -d --name "$C_COLL" --network none \
        -v //var/run/docker.sock:/var/run/docker.sock -v "$(hp "$ROOT"):/src:ro" -v "$(hp "$SROOT"):/g" \
        --tmpfs /disk:size=100m --entrypoint sh "$COLLECTOR_IMAGE" -c \
        'printf "#!/bin/sh\ncat /g/proof-timer-state 2>/dev/null || echo disabled\n" > /usr/local/bin/systemctl && chmod +x /usr/local/bin/systemctl && mkdir -p /disk/seeded && exec sleep 86400' >/dev/null
    printf 'enabled\n' > "$SROOT/proof-timer-state"
    ok "Mailpit (127.0.0.1:${MAILPIT_PORT}) and the collector container (100 MiB tmpfs at /disk)"
    finish 8
}

phase_refresh() {
    [[ -f "$ENV_FILE" ]] || die "run prepare first"
    render_and_time
    write_override
    ok "override rewritten"
    if docker inspect "$(container_of grafana)" >/dev/null 2>&1; then
        # A changed provisioning tree is read at start only.
        compose_ops -- up -d > "$OUT/refresh.log" 2>&1 || die "compose up failed"
        docker restart "$(container_of grafana)" >/dev/null
        wait_healthy 150 "$(container_of grafana)" && ok "grafana restarted on the re-rendered tree" || bad "grafana not healthy after refresh"
    fi
    finish 3
}

phase_up() {
    local c svc pub
    compose_ops -- up -d > "$OUT/up.log" 2>&1 || { tail -n 20 "$OUT/up.log" >&2; die "compose up failed"; }
    docker network connect --alias mailpit "${OPS}_ops" "$C_MAIL" 2>/dev/null || true
    local cs=()
    for svc in "${OPS_SERVICES[@]}"; do cs+=("$(container_of "$svc")"); done
    if wait_healthy 150 "${cs[@]}"; then ok "all six ops services healthy by their own healthchecks"; else
        for c in "${cs[@]}"; do bad "$c: $(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$c" 2>/dev/null)"; done
    fi
    [[ "$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$(container_of grafana)")" == "$OPS" ]] \
        && ok "project ${OPS}" || bad "project label is not ${OPS}"
    for svc in "${OPS_SERVICES[@]}"; do
        pub="$(docker port "$(container_of "$svc")" 2>/dev/null | sort | tr '\n' ' ')"
        case "$svc" in
            grafana) [[ "$pub" == "3000/tcp -> 127.0.0.1:${GRAFANA_PORT} " ]] && ok "grafana publishes only 127.0.0.1:${GRAFANA_PORT}" || bad "grafana publishes '$pub'" ;;
            alloy)   [[ "$pub" == *"127.0.0.1:${INGEST_PORT}"* && "$pub" != *"0.0.0.0"* ]] && ok "alloy publishes only the ingest on 127.0.0.1" || bad "alloy publishes '$pub'" ;;
            *)       [[ -z "$pub" ]] && ok "$svc publishes no host port" || bad "$svc publishes '$pub'" ;;
        esac
        local nets
        nets="$(docker inspect --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$(container_of "$svc")")"
        [[ "$nets" == "${OPS}_ops " ]] && ok "$svc is on ${OPS}_ops only" || bad "$svc networks: $nets"
    done
    local mounts
    # Image mounts (the busybox probe) are skipped: their source is the image's
    # own read-only layer, not a host path.
    mounts="$(docker inspect --format '{{range .Mounts}}{{if ne .Type "image"}}{{.Source}}|{{.Destination}}|{{.RW}};{{end}}{{end}}' "$(container_of alloy)")"
    [[ "$mounts" != *"|/rootfs|"* && "$mounts" != *"/var/lib/docker"* && "$mounts" != *"docker.sock"* ]] \
        && [[ "$mounts" == *"|/host/proc|false;"* && "$mounts" == *"|/host/sys|false;"* && "$mounts" == *"|/vector-logs|false;"* ]] \
        && ok "alloy: /proc, /sys, Vector's volume read-only; no /, no Docker data root, no socket" || bad "alloy mounts: $mounts"
    curl -fsS "http://127.0.0.1:${GRAFANA_PORT}/api/health" | grep -q '"database": *"ok"' \
        && ok "grafana /api/health database ok on the loopback port" || bad "grafana /api/health"
    local login_page
    login_page="$(curl -s -o "$(hpf "$OUT/.curl-body")" -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
        -d '{"user":"admin","password":"admin"}' "http://127.0.0.1:${GRAFANA_PORT}/login")"
    [[ "$login_page" != 200 ]] && ok "the login form refuses a local admin (HTTP $login_page)" || bad "a local login answered 200"
    [[ "$(curl -s -o "$(hpf "$OUT/.curl-body")" -w '%{http_code}' "http://127.0.0.1:${GRAFANA_PORT}/api/datasources")" == 401 ]] \
        && ok "no anonymous access (/api/datasources 401)" || bad "anonymous access to /api/datasources"
    finish 18
}

phase_signals() {
    printf '{"ts":"%s","ok":true,"label":"proof","class":"daily","artefacts":[],"offsite":false,"bytes":0}\n' "$(now)" > "$SROOT/runtime/last-backup.json"
    natsbox stream add SIG --subjects 'sig.>' --storage file --defaults >/dev/null 2>&1 || true
    natsbox consumer add SIG sig-c --pull --ack explicit --defaults >/dev/null 2>&1 || true
    natsbox pub sig.one hello >/dev/null 2>&1 || true
    natsbox consumer next SIG sig-c --count 1 --ack >/dev/null 2>&1 || true
    collect || bad "the collector run failed"
    docker run --rm -v "${VOL_VECTOR}:/logs" "$BUSYBOX_IMAGE" sh -c \
        "echo '{\"RequestReceivedAt\":\"$(now)\",\"RequestPath\":\"/auth/signals-${SHA8}\"}' >> /logs/security.log"
    local q
    local -a signals=(
        'node_memory_MemAvailable_bytes|host memory (procfs via Alloy)'
        'gremion_host_filesystem_size_bytes{mountpoint="/"}|host disk (df)'
        "gremion_container_memory_bytes{name=\"${C_PG}\"}|per-container memory"
        "gremion_container_disk_bytes{name=\"${C_PG}\"}|per-container disk"
        'probe_ssl_earliest_cert_expiry{job="blackbox-https"}|TLS expiry'
        'gremion_nats_jsz_up|broker reading'
        'gremion_nats_consumer_num_pending{consumer="sig-c"}|broker lag / pending count'
        'gremion_nats_stream_bytes{stream="SIG"}|stream storage'
        'gremion_postgres_connections_used|Postgres connections'
        'gremion_backup_last_ok|backup outcome'
        'gremion_backup_timer_enabled|backup timer state'
        'gremion_storage_component_bytes{component="seeded"}|TRD-224 component bytes'
        'gremion_host_disk_provisioned_bytes|TRD-224 denominator'
        'probe_success{kind="third_party"}|third-party probe (PRD-DEP-002)'
        "gremion_container_up{name=\"${C_VECTOR}\"}|vector running"
    )
    for q in "${signals[@]}"; do
        if wait_until 100 has_series "max(time() - timestamp(${q%%|*})) < 120"; then ok "fresh: ${q#*|}"; else bad "not fresh in Prometheus: ${q%%|*}"; fi
    done
    wait_until 60 loki_has '{class="security", source="edge"}' "/auth/signals-${SHA8}" \
        && ok "Vector's output reached Loki as class=security (read-only volume)" || bad "Vector's line not in Loki"
    finish 16
}

phase_absent() {
    # The e-mail must be caused by THIS phase: a SignalAbsent{host-collector}
    # notice from the start-up window (before the first collector run) would
    # satisfy a plain count. So the phase starts from a collected, healthy
    # state with every earlier notice resolved, and counts only new FIRING mail.
    local f0 r0
    collect || bad "the collector run failed"
    wait_until 60 value_is 'max(gremion:cond:signal_absent{component="host-collector"})' 0 \
        || die "signal_absent{component=host-collector} is not 0 before the phase: the start state is not healthy"
    f0="$(mail_count FIRING SignalAbsent host-collector)"
    r0="$(mail_count RESOLVED SignalAbsent host-collector)"
    if (( f0 > r0 )); then
        wait_until 100 mail_at_least RESOLVED SignalAbsent host-collector "$f0" \
            || die "an earlier SignalAbsent{host-collector} notice is still open (${f0} FIRING, ${r0} RESOLVED); re-run once it resolved"
    fi
    ok "start: collector healthy, ${f0} earlier SignalAbsent{host-collector} notice(s), all resolved"
    # The collector stops and its file goes: every textfile signal is absent.
    rm -f "$SROOT/runtime/textfile/gremion.prom"
    wait_until 90 value_is 'absent(gremion_metrics_textfile_timestamp_seconds)' 1 \
        && ok "a stopped collector: its signals are ABSENT, not 0" || bad "textfile series still present"
    wait_until 60 value_is 'max(gremion:cond:signal_absent{component="host-collector"})' 1 \
        && ok "signal_absent{component=host-collector} is 1" || bad "signal_absent did not turn 1"
    wait_until 120 mail_at_least FIRING SignalAbsent host-collector $(( f0 + 1 )) \
        && ok "absence alerts: one NEW SignalAbsent e-mail naming host-collector (was ${f0})" || bad "no new SignalAbsent e-mail (still ${f0})"
    collect || bad "collector restart failed"
    wait_until 60 has_series 'gremion_metrics_textfile_timestamp_seconds' && ok "collector back" || bad "collector not back"
    finish 5
}

phase_red_base() {
    # RED first: the rules of the base (the commit TASK-039 started from) see
    # neither breach. The breach world: a consumer with 5 pending whose ack
    # floor never moves, and a storage component at 71 of 100 provisioned
    # bytes, everything else healthy. promtool asserts NO base rule fires.
    local base dir
    base="${OBS_PROOF_BASE:-660a3215}"
    dir="$OUT/red-base"; rm -rf "$dir"; mkdir -p "$dir"
    git -C "$(hp "$ROOT")" show "${base}:infra/host/ops/alerts.yml" > "$dir/alerts.yml" || die "no base alerts.yml at $base"
    cat > "$dir/breach.test.yml" <<'EOF'
rule_files: [alerts.yml]
evaluation_interval: 1m
tests:
  - interval: 1m
    input_series:
      - {series: 'node_filesystem_avail_bytes{mountpoint="/",fstype="ext4"}', values: '900+0x90'}
      - {series: 'node_filesystem_size_bytes{mountpoint="/",fstype="ext4"}', values: '1000+0x90'}
      - {series: 'node_memory_MemAvailable_bytes', values: '800+0x90'}
      - {series: 'node_memory_MemTotal_bytes', values: '1000+0x90'}
      - {series: 'gremion_container_unhealthy{name="a"}', values: '0+0x90'}
      - {series: 'gremion_metrics_textfile_timestamp_seconds', values: '0+60x90'}
      - {series: 'probe_ssl_earliest_cert_expiry{job="blackbox-https",instance="https://example.org"}', values: '5184000+0x90'}
      - {series: 'gremion_backup_last_success_timestamp_seconds', values: '0+60x90'}
      - {series: 'stalwart_queue_oldest_message_seconds', values: '10+0x90'}
      - {series: 'gremion_postgres_connections_used', values: '10+0x90'}
      - {series: 'gremion_postgres_connections_max', values: '100+0x90'}
      - {series: 'probe_success{job="blackbox-acme",instance="http://203.0.113.10:80/"}', values: '1+0x90'}
      - {series: 'gremion_nats_jsz_up', values: '1+0x90'}
      - {series: 'gremion_nats_consumer_num_pending{account="A",stream="PROOF",consumer="stalled"}', values: '5+0x90'}
      - {series: 'gremion_nats_consumer_num_ack_pending{account="A",stream="PROOF",consumer="stalled"}', values: '0+0x90'}
      - {series: 'gremion_nats_consumer_ack_floor_stream_seq{account="A",stream="PROOF",consumer="stalled"}', values: '0+0x90'}
      - {series: 'gremion_storage_component_bytes{component="seeded"}', values: '71+0x90'}
      - {series: 'gremion_host_disk_provisioned_bytes{path="/disk"}', values: '100+0x90'}
    alert_rule_test:
      - {alertname: DiskAbove70, eval_time: 70m, exp_alerts: []}
      - {alertname: MemoryPressure, eval_time: 70m, exp_alerts: []}
      - {alertname: ContainerUnhealthy2m, eval_time: 70m, exp_alerts: []}
      - {alertname: CertExpiresUnder20d, eval_time: 70m, exp_alerts: []}
      - {alertname: BackupOlderThan26h, eval_time: 70m, exp_alerts: []}
      - {alertname: MailQueueOldest1h, eval_time: 70m, exp_alerts: []}
      - {alertname: PostgresConnections80pct, eval_time: 70m, exp_alerts: []}
      - {alertname: EdgePort80Down, eval_time: 70m, exp_alerts: []}
EOF
    local prom_image
    prom_image="$(awk '/^  prometheus:$/ {f=1; next} f && /^[[:space:]]+image:/ {print $2; exit}' "$ROOT/compose/observability/docker-compose.yml")"
    if docker run --rm --entrypoint promtool -v "$(hp "$dir"):/t:ro" -w /t "$prom_image" test rules breach.test.yml > "$dir/promtool.log" 2>&1; then
        ok "RED on the base: neither the stalled consumer nor the 71/100 component fires any of its eight rules (BackupOlderThan26h, DiskAbove70 on / only)"
    else
        bad "the base fired on the breach world: $(tail -n 5 "$dir/promtool.log")"
    fi
    grep -c 'alert:' "$dir/alerts.yml" | grep -qx 8 && ok "the base carries exactly its eight rules (no broker, no TRD-224 rule)" || bad "base rule count"
    finish 2
}

phase_alert() {
    natsbox stream add PROOF --subjects 'proof.>' --storage file --defaults >/dev/null 2>&1 || true
    natsbox consumer add PROOF stalled --pull --ack explicit --defaults >/dev/null 2>&1 || true
    natsbox pub proof.x breach --count 5 >/dev/null 2>&1 || bad "could not publish to PROOF"
    collect || bad "collector run failed"
    date +%s > "$OUT/alert-start"
    wait_until 60 value_is 'max(gremion:cond:broker_consumer_stalled{consumer="stalled"})' 1 \
        && ok "broker_consumer_stalled{consumer=stalled} is 1" || bad "the stalled consumer is not seen"
    local t0; t0="$(cat "$OUT/alert-start")"
    if wait_until 150 mail_at_least FIRING BrokerConsumerStalled "PROOF/stalled" 1; then
        ok "one FIRING e-mail for the stalled consumer after $(( $(date +%s) - t0 )) s (for 10s + group_wait 10s + evaluations)"
    else
        bad "no FIRING e-mail for BrokerConsumerStalled"
    fi
    sleep 15
    [[ "$(mail_count FIRING BrokerConsumerStalled "PROOF/stalled")" == 1 ]] && ok "exactly one" || bad "$(mail_count FIRING BrokerConsumerStalled "PROOF/stalled") FIRING e-mails"
    finish 3
}

phase_alert_hold() {
    # A second breach in the same group (more work on the same stalled
    # consumer) while it fires: no new e-mail within 3 x group_interval.
    natsbox pub proof.x more --count 3 >/dev/null 2>&1 || bad "could not publish to PROOF"
    local end=$(( $(date +%s) + 185 ))
    while (( $(date +%s) < end )); do collect || true; sleep 20; done
    [[ "$(prom_value 'max(gremion_nats_consumer_num_pending{consumer="stalled"})')" == 8 ]] \
        && ok "the breach grew (8 pending) while firing" || bad "pending is not 8"
    [[ "$(mail_count FIRING BrokerConsumerStalled "PROOF/stalled")" == 1 ]] \
        && ok "still exactly one FIRING e-mail after 3 x group_interval" || bad "$(mail_count FIRING BrokerConsumerStalled "PROOF/stalled") FIRING e-mails"
    finish 2
}

phase_alert_resolve() {
    natsbox consumer next PROOF stalled --count 8 --ack >/dev/null 2>&1 || bad "could not drain PROOF/stalled"
    collect || bad "collector run failed"
    wait_until 60 value_is 'max(gremion:cond:broker_consumer_stalled{consumer="stalled"})' 0 \
        && ok "the condition cleared" || bad "the condition did not clear"
    local end=$(( $(date +%s) + 150 ))
    while (( $(date +%s) < end )) && ! mail_at_least RESOLVED BrokerConsumerStalled "PROOF/stalled" 1; do collect || true; sleep 10; done
    [[ "$(mail_count RESOLVED BrokerConsumerStalled "PROOF/stalled")" == 1 ]] \
        && ok "exactly one RESOLVED e-mail" || bad "$(mail_count RESOLVED BrokerConsumerStalled "PROOF/stalled") RESOLVED e-mails"
    finish 2
}

fill_disk() {   # <MiB>
    docker exec "$C_COLL" sh -c "rm -f /disk/seeded/blob && dd if=/dev/zero of=/disk/seeded/blob bs=1048576 count=$1 2>/dev/null"
}

phase_storage_red() {
    fill_disk 69
    collect || bad "collector run failed"
    wait_until 60 value_is 'max(gremion:cond:storage_above_70{component="seeded"})' 0 \
        && ok "69/100: the component condition is present and 0" || bad "69/100: condition not 0"
    sleep 50
    [[ "$(mail_count FIRING StorageComponentAbove70pct seeded)" == 0 ]] && ok "69/100: no e-mail" || bad "69/100 mailed"
    finish 2
}

phase_storage() {
    fill_disk 71
    collect || bad "collector run failed"
    wait_until 60 value_is 'max(gremion:cond:storage_above_70{component="seeded"})' 1 \
        && ok "71/100: the component condition is 1 (denominator GREMION_DISK_ROOT, a 100 MiB tmpfs)" || bad "71/100: condition not 1"
    [[ "$(prom_value 'max(gremion:cond:disk_above_70)')" == 0 ]] && ok "the root-filesystem rule stays silent (the breach is not on /)" || bad "disk_above_70 not 0"
    wait_until 120 mail_at_least FIRING StorageComponentAbove70pct seeded 1 \
        && ok "71/100: one StorageComponentAbove70pct e-mail" || bad "71/100: no e-mail"
    sleep 15
    [[ "$(mail_count FIRING StorageComponentAbove70pct seeded)" == 1 ]] && ok "exactly one" || bad "$(mail_count FIRING StorageComponentAbove70pct seeded) e-mails"
    finish 4
}

TRACE_ID_FILE="$OUT/trace-id"
send_otlp() {   # <path> <json> [token] -- from a scratch _state container, through the host
    local hdr=()
    [[ -n "${3:-}" ]] && hdr=(--header "Authorization: Bearer $3")
    docker run --rm --network "$NET_STATE" --add-host host.docker.internal:host-gateway "$BUSYBOX_IMAGE" \
        wget -q -O /dev/null -T 5 --header 'Content-Type: application/json' "${hdr[@]}" \
        --post-data "$2" "http://host.docker.internal:${INGEST_PORT}$1" >/dev/null 2>&1
}
otlp_metric() {
    printf '{"resourceMetrics":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"obs-proof"}}]},"scopeMetrics":[{"scope":{"name":"proof"},"metrics":[{"name":"obs_proof_ingest","gauge":{"dataPoints":[{"asDouble":42,"timeUnixNano":"%s000000000"}]}}]}]}]}' "$(date +%s)"
}
otlp_span() {   # <trace id>
    local t; t="$(date +%s)"
    printf '{"resourceSpans":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"obs-proof"}}]},"scopeSpans":[{"scope":{"name":"proof"},"spans":[{"traceId":"%s","spanId":"%s","name":"obs-proof-span","kind":1,"startTimeUnixNano":"%s000000000","endTimeUnixNano":"%s500000000"}]}]}]}' \
        "$1" "${1:0:16}" "$t" "$t"
}

phase_ingest_red() {
    cat > "$OUT/ops.unpublished.yml" <<'EOF'
services:
  alloy:
    ports: !reset []
EOF
    compose_ops "$OUT/ops.unpublished.yml" -- up -d alloy > "$OUT/ingest-red.log" 2>&1 || die "compose up alloy (unpublished) failed"
    wait_healthy 120 "$(container_of alloy)" || bad "alloy not healthy"
    local token; token="$(cat "$SROOT/etc/secrets/ops/otlp-ingest-token")"
    if send_otlp /v1/metrics "$(otlp_metric)" "$token"; then bad "a push reached an unpublished receiver"; else ok "RED: receiver unpublished, the push from _state fails"; fi
    compose_ops -- up -d alloy >> "$OUT/ingest-red.log" 2>&1 || die "compose up alloy failed"
    wait_healthy 120 "$(container_of alloy)" && ok "receiver published again" || bad "alloy not healthy after restore"
    finish 2
}

phase_ingest() {
    local token trace
    token="$(cat "$SROOT/etc/secrets/ops/otlp-ingest-token")"
    trace="$(gen | cut -c1-32)"; printf '%s' "$trace" > "$TRACE_ID_FILE"
    if send_otlp /v1/traces "$(otlp_span "$trace")"; then bad "a push WITHOUT the bearer token was accepted"; else ok "a push without the bearer token is refused"; fi
    if send_otlp /v1/traces "$(otlp_span "$trace")" bad-token; then bad "a push with a wrong token was accepted"; else ok "a push with a wrong token is refused"; fi
    send_otlp /v1/traces "$(otlp_span "$trace")" "$token" && ok "one OTLP span pushed from a _state container" || bad "the span push failed"
    send_otlp /v1/metrics "$(otlp_metric)" "$token" && ok "one OTLP metric pushed from a _state container" || bad "the metric push failed"
    wait_until 90 has_series 'obs_proof_ingest' && ok "the metric is in Prometheus" || bad "obs_proof_ingest not in Prometheus"
    tempo_has() { docker exec "$(container_of tempo)" /probe/bin/busybox wget -qO- --header 'Accept: application/json' "http://127.0.0.1:3200/api/traces/${trace}" 2>/dev/null | grep -q 'obs-proof-span'; }
    wait_until 90 tempo_has && ok "the span is in Tempo (trace ${trace})" || bad "trace not in Tempo"
    finish 6
}

sso() {   # <user> <otp secret or ""> [--get path]...
    local user="$1" otp="$2"; shift 2
    [[ -n "$PY" ]] || die "python3 is required for the sign-in driver"
    "$PY" "$(hpf "$ROOT/test/host/fixtures/observability/sso_login.py")" "http://127.0.0.1:${GRAFANA_PORT}" "$user" "$(cat "$OUT/user-password")" "$otp" "$@"
}

kc_ready() { curl -fsS "http://127.0.0.1:${KC_PORT}/auth/realms/platform/.well-known/openid-configuration" >/dev/null 2>&1; }

grafana_with() {   # <override file|none> -- recreate grafana and wait healthy
    if [[ "$1" == none ]]; then compose_ops -- up -d grafana > "$OUT/grafana-recreate.log" 2>&1
    else compose_ops "$1" -- up -d grafana > "$OUT/grafana-recreate.log" 2>&1; fi
    wait_healthy 150 "$(container_of grafana)"
}

phase_access_red() {
    wait_until 120 kc_ready || die "Keycloak is not answering"
    cat > "$OUT/grafana.weak.yml" <<'EOF'
services:
  grafana:
    environment:
      GF_AUTH_GENERIC_OAUTH_CLIENT_ID: grafana-weak
      GF_AUTH_GENERIC_OAUTH_ROLE_ATTRIBUTE_PATH: "contains(realm_access.roles[*], 'operator') && 'Admin' || ''"
EOF
    grafana_with "$OUT/grafana.weak.yml" || die "grafana (weak) not healthy"
    local r; r="$(sso op-loa1 "")"
    [[ "$(jq -r .session <<< "$r")" == true ]] \
        && ok "RED: with no ACR floor on the client and no acr clause, an operator WITHOUT a second factor gets in ($(jq -c '{stage,role}' <<< "$r"))" \
        || bad "RED did not reproduce: $(jq -c . <<< "$r")"
    cat > "$OUT/grafana.weak-client.yml" <<'EOF'
services:
  grafana:
    environment:
      GF_AUTH_GENERIC_OAUTH_CLIENT_ID: grafana-weak
EOF
    grafana_with "$OUT/grafana.weak-client.yml" || die "grafana (weak client) not healthy"
    r="$(sso op-loa1 "")"
    [[ "$(jq -r .session <<< "$r")" == false ]] \
        && ok "Grafana's own acr == 'loa2' clause refuses the loa1 operator even on a client without an ACR floor ($(jq -r .stage <<< "$r"))" \
        || bad "the acr clause let a loa1 operator in: $(jq -c . <<< "$r")"
    finish 2
}

phase_access() {
    wait_until 120 kc_ready || die "Keycloak is not answering"
    grafana_with none || die "grafana not healthy"
    local otp trace r
    # A fresh sample, so the instant query below is inside Prometheus' lookback.
    send_otlp /v1/metrics "$(otlp_metric)" "$(cat "$SROOT/etc/secrets/ops/otlp-ingest-token")" || bad "the metric push failed"
    wait_until 60 has_series 'obs_proof_ingest' || bad "obs_proof_ingest not fresh in Prometheus"
    otp="$(cat "$OUT/otp-secret")"
    trace="$(cat "$TRACE_ID_FILE" 2>/dev/null || echo none)"
    r="$(sso op-mfa "$otp" --get '/api/datasources/proxy/uid/prometheus/api/v1/query?query=obs_proof_ingest' --get "/api/datasources/proxy/uid/tempo/api/traces/${trace}")"
    printf '%s\n' "$r" > "$OUT/access-op-mfa.json"
    [[ "$(jq -r '.session and .role == "Admin"' <<< "$r")" == true ]] \
        && ok "operator with password + OTP (acr loa2) signs in as Admin" || bad "op-mfa: $(jq -c '{session,role,stage,detail}' <<< "$r")"
    [[ "$(jq -r '.gets["/api/datasources/proxy/uid/prometheus/api/v1/query?query=obs_proof_ingest"][1]' <<< "$r")" == *'obs_proof_ingest'* ]] \
        && ok "Grafana reads the pushed metric from Prometheus" || bad "Grafana did not read obs_proof_ingest"
    [[ "$(jq -r --arg p "/api/datasources/proxy/uid/tempo/api/traces/${trace}" '.gets[$p][1]' <<< "$r")" == *'obs-proof-span'* ]] \
        && ok "Grafana reads the pushed span from Tempo" || bad "Grafana did not read the trace"
    r="$(sso norole "$otp")"
    [[ "$(jq -r .session <<< "$r")" == false ]] && ok "a user without the operator role is refused ($(jq -r .stage <<< "$r"))" || bad "norole got a session"
    r="$(sso op-loa1 "")"
    [[ "$(jq -r .session <<< "$r")" == false ]] && ok "an operator without a second factor (loa1) is refused ($(jq -r .stage <<< "$r"))" || bad "op-loa1 got a session"
    r="$(sso council-user "")"
    [[ "$(jq -r .session <<< "$r")" == false ]] && ok "a council realm's user is refused by the platform realm ($(jq -r .stage <<< "$r"))" || bad "council-user got a session"
    wait_until 90 loki_has '{class="audit", source="grafana"}' '/api/user' \
        && ok "Grafana's requests reach Loki as class=audit" || bad "no Grafana request line in Loki class=audit"
    finish 7
}

# TRD-203: nc by IP from inside each ops container's network namespace.
probe_from() {   # <container> <ip> <port>
    docker run --rm --network "container:$1" "$BUSYBOX_IMAGE" nc -z -w 2 "$2" "$3" >/dev/null 2>&1
}
state_ip() { docker inspect --format "{{(index .NetworkSettings.Networks \"${NET_STATE}\").IPAddress}}" "$1"; }

reach_check() {   # prints one line per reachable target; returns 0 when none is reachable
    local svc c t hits=0
    local targets=("$(state_ip "$C_PG"):5432" "$(state_ip "$C_NATS"):4222" "$(state_ip "$C_BOARD"):5432" "${STATE_GATEWAY}:5432" "${STATE_GATEWAY}:4222")
    for svc in "${OPS_SERVICES[@]}"; do
        c="$(container_of "$svc")"
        for t in "${targets[@]}"; do
            if probe_from "$c" "${t%:*}" "${t##*:}"; then echo "reachable: $svc -> $t"; hits=$((hits + 1)); fi
        done
    done
    (( hits == 0 ))
}

phase_reach_red() {
    docker network connect "$NET_STATE" "$(container_of alloy)" || die "could not join alloy to $NET_STATE"
    local out
    if out="$(reach_check)"; then bad "RED did not reproduce: alloy on $NET_STATE reached nothing"; else ok "RED: alloy joined to _state reaches the stores ($(head -n 1 <<< "$out"))"; fi
    docker network disconnect "$NET_STATE" "$(container_of alloy)" || bad "could not leave $NET_STATE"
    finish 1
}

phase_reach() {
    # Positive control first: the same IP:port answers from a _state container.
    local t ctl=0
    for t in "$(state_ip "$C_PG"):5432" "$(state_ip "$C_NATS"):4222" "$(state_ip "$C_BOARD"):5432"; do
        if docker run --rm --network "$NET_STATE" "$BUSYBOX_IMAGE" nc -z -w 2 "${t%:*}" "${t##*:}" >/dev/null 2>&1; then
            ok "control: $t answers from a _state container"; ctl=$((ctl + 1))
        else
            bad "control failed for $t -- the run is void"
        fi
    done
    (( ctl == 3 )) || finish 4
    local out
    if out="$(reach_check)"; then
        ok "from every ops netns (6 services x 5 targets, by IP): postgres:5432, nats:4222, board-postgres:5432 and the _state gateway on 5432/4222 all fail"
    else
        bad "an ops container reaches the state side: $out"
    fi
    finish 4
}

phase_down() {
    local svc
    compose_ops -- down --remove-orphans > "$OUT/down.log" 2>&1 || true
    for c in "$C_PG" "$C_BOARD" "$C_NATS" "$C_VECTOR" "$C_MAIL" "$C_KC" "$C_COLL"; do docker rm -f "$c" >/dev/null 2>&1 || true; done
    for svc in "${OPS_SERVICES[@]}"; do docker rm -f "$(container_of "$svc")" >/dev/null 2>&1 || true; done
    docker network rm "$NET_STATE" "${OPS}_ops" >/dev/null 2>&1 || true
    docker volume rm "$VOL_VECTOR" "$VOL_NATSCONF" >/dev/null 2>&1 || true
    local left
    left="$(docker ps -a --format '{{.Names}}' | grep -F "$STACK" || true)$(docker volume ls --format '{{.Name}}' | grep -F "$STACK" || true)$(docker network ls --format '{{.Name}}' | grep -F "$STACK" || true)"
    [[ -z "$left" ]] && ok "nothing named ${STACK}* is left (containers, volumes, networks)" || bad "left behind: $left"
    finish 1
}

case "$PHASE" in
    prepare) phase_prepare ;;
    refresh) phase_refresh ;;
    up) phase_up ;;
    signals) phase_signals ;;
    absent) phase_absent ;;
    red-base) phase_red_base ;;
    alert) phase_alert ;;
    alert-hold) phase_alert_hold ;;
    alert-resolve) phase_alert_resolve ;;
    storage-red) phase_storage_red ;;
    storage) phase_storage ;;
    ingest-red) phase_ingest_red ;;
    ingest) phase_ingest ;;
    access-red) phase_access_red ;;
    access) phase_access ;;
    reach-red) phase_reach_red ;;
    reach) phase_reach ;;
    down) phase_down ;;
    *) sed -n '2,40p' "$0" >&2; exit 2 ;;
esac
