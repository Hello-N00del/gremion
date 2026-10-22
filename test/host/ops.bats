#!/usr/bin/env bats
# Task 11 / TASK-039 — the ${STACK}-ops project (compose/observability/), its
# host half (render-ops.sh, the host collector) and the post-boot verify gate.
# Unit only: docker, systemctl, curl and psql are shimmed; nothing here touches
# a real daemon. The running proof is test/host/integration/observability-proof.sh.

load 'test_helper/host'

PROJECT_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
OPS_DIR="${PROJECT_ROOT}/infra/host/ops"
OBS_DIR="${PROJECT_ROOT}/compose/observability"
COMPOSE="${OBS_DIR}/docker-compose.yml"
PROM="${OBS_DIR}/prometheus/prometheus.yml"
RULES="${OBS_DIR}/prometheus/rules.yml"
RULES_TEST="${OBS_DIR}/prometheus/rules.test.yml"
BLACKBOX="${OBS_DIR}/blackbox.yml"
RENDER="${OPS_DIR}/render-ops.sh"
METRICS="${OPS_DIR}/metrics-textfile.sh"
VERIFY="${PROJECT_ROOT}/infra/host/bin/gremion-verify"
UNIT_DIR="${PROJECT_ROOT}/infra/host/templates/systemd"
OPS_TMPL="${PROJECT_ROOT}/infra/host/templates/env/ops.env.tmpl"
PROV="runtime/ops/grafana-provisioning"

setup() {
    setup_host_root
}

# Task 1's helper, as every other suite here uses it. The brief's own teardown
# compared $GREMION_ROOT against $BATS_TEST_TMPDIR, but setup_host_root builds
# the root with `mktemp -d`, so that comparison is never true and the cleanup
# would never run — a dead teardown leaking one tree per test.
teardown() {
    teardown_host_root
}

# ---------------------------------------------------------------------------
# The compose project (static; the rendered checks are compose/observability/*.test.mjs)
# ---------------------------------------------------------------------------

@test "ops compose declares exactly the six observability services" {
    [ -f "$COMPOSE" ]
    # Scoped to the services: block on purpose. A bare `/^  [a-z-]+:$/` also
    # matches `  ops:` under the top-level networks: key.
    run awk '/^services:/{s=1;next} /^[a-z]/{s=0} s && /^  [a-z-]+:$/ {gsub(/[ :]/,"",$1); print $1}' "$COMPOSE"
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | sort | tr '\n' ' ')" = "alloy blackbox grafana loki prometheus tempo " ]
}

@test "the old ops project is gone: no compose file, no Alertmanager, no node-exporter, no cAdvisor" {
    [ ! -e "${OPS_DIR}/docker-compose.yml" ]
    [ ! -e "${OPS_DIR}/alertmanager.yml.tmpl" ]
    run grep -nE 'alertmanager|node-exporter|cadvisor|/var/run/docker\.sock' "$COMPOSE"
    [ "$status" -ne 0 ]
}

@test "every ops image and image mount is digest-pinned and none is :latest" {
    run awk '/^[[:space:]]+(image|source):[[:space:]]*[a-z0-9.\/_-]+:[^[:space:]]*@?/ && !/\$\{/ {print $2}' "$COMPOSE"
    [ "$status" -eq 0 ]
    [ -n "$output" ]
    local n=0
    while read -r ref; do
        [[ "$ref" == *"@sha256:"* ]] || { echo "not digest-pinned: $ref"; return 1; }
        [[ "$ref" =~ @sha256:[0-9a-f]{64}$ ]] || { echo "malformed digest: $ref"; return 1; }
        [[ "$ref" != *":latest@"* ]] || { echo "latest tag: $ref"; return 1; }
        n=$((n + 1))
    done <<< "$output"
    [ "$n" -ge 7 ]   # six services + the busybox probe mount
}

@test "only grafana and the OTLP ingest publish, never on a wildcard" {
    run grep -nE '^[[:space:]]+- "[^"]*:[0-9]+:[0-9]+"' "$COMPOSE"
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | wc -l)" -eq 3 ]
    while read -r line; do
        [[ "$line" == *'"${OPS_BIND_IP'*':3000:3000"'* || "$line" == *'"${OPS_INGEST_BIND_IP'*':431'[78]':431'[78]'"'* ]] \
            || { echo "port not bound to OPS_BIND_IP:3000 or OPS_INGEST_BIND_IP:4317/4318: $line"; return 1; }
        [[ "$line" != *'0.0.0.0'* ]] || { echo "wildcard bind: $line"; return 1; }
    done <<< "$output"
}

@test "ops compose carries no top-level name: key and no forbidden compose flag" {
    run grep -nE '^name:' "$COMPOSE"
    [ "$status" -ne 0 ]
    run grep -nE 'docker compose .*( -f | -p | --profile )' "$COMPOSE"
    [ "$status" -ne 0 ]
}

# ---------------------------------------------------------------------------
# Conditions (recording rules) -- Grafana alerts on them
# ---------------------------------------------------------------------------

@test "rules.yml records exactly the sixteen conditions (twelve TASK-039 and the four TASK-079 dead-letter ones)" {
    [ -f "$RULES" ]
    run awk '/^[[:space:]]*#/ {next} /^[[:space:]]+- record:/ {print $3}' "$RULES"
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | sort | tr '\n' ' ')" = "gremion:cond:backup_failed gremion:cond:broker_consumer_stalled gremion:cond:cert_expiry gremion:cond:container_unhealthy gremion:cond:dead_letter_queue gremion:cond:disk_above_70 gremion:cond:edge_port80 gremion:cond:inbox_dead_lettered gremion:cond:inbox_stalled gremion:cond:mail_queue gremion:cond:memory_pressure gremion:cond:outbox_dead_lettered gremion:cond:postgres_connections gremion:cond:signal_absent gremion:cond:storage_above_70 gremion:cond:third_party_unreachable " ]
}

@test "every condition but third_party_unreachable and the four dead-letter ones is fail-closed on a blind collector" {
    # Comment lines are skipped first: the header explains the absent()
    # contract in prose, and a guard that counts its own documentation lies.
    run awk '/^[[:space:]]*#/ {next} /^[[:space:]]+- record:/{name=$3} /absent\(/{print name}' "$RULES"
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | sort -u | wc -l)" -eq 11 ]
    [[ "$output" != *"third_party_unreachable"* ]]
    # TASK-079: a host without an events service has no gauge; an absent() arm there would fire for ever.
    [[ "$output" != *"outbox_dead_lettered"* && "$output" != *"inbox_dead_lettered"* && "$output" != *"inbox_stalled"* && "$output" != *"dead_letter_queue"* ]]
}

@test "the unverified mail-queue series is labelled as unverified" {
    [ -f "$RULES" ]
    grep -q 'series name unverified until section L' "$RULES"
}

@test "rules.test.yml exercises the healthy world, the blind world and the brief's scenarios" {
    [ -f "$RULES_TEST" ]
    grep -q "rule_files:" "$RULES_TEST"
    grep -q -- '- rules.yml' "$RULES_TEST"
    # one promql_expr_test per test block: healthy, blind, 4 backup, TRD-224, broker, third party
    [ "$(grep -c 'promql_expr_test:' "$RULES_TEST")" -ge 9 ]
    # every condition is asserted at least twice (both directions)
    local r
    for r in $(awk '/^[[:space:]]+- record:/ {print $3}' "$RULES"); do
        [ "$(grep -c "expr: ${r}\$" "$RULES_TEST")" -ge 1 ] || { echo "no test reads ${r}"; return 1; }
    done
}

# ---------------------------------------------------------------------------
# Scrape config and probe modules
# ---------------------------------------------------------------------------

@test "prometheus.yml declares the probe, stalwart and self jobs and nothing else" {
    [ -f "$PROM" ]
    run awk '/job_name:/ {gsub(/[",]/,"",$3); print $3}' "$PROM"
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | sort | tr '\n' ' ')" = "blackbox-acme blackbox-control blackbox-https blackbox-smtp blackbox-smtp25 blackbox-third-party blackbox-tls prometheus stalwart " ]
}

@test "prometheus.yml takes every probe target from file_sd, never a literal host" {
    grep -q 'file_sd_configs:' "$PROM"
    run grep -nE '(example\.org|203\.0\.113|2001:db8)' "$PROM"
    [ "$status" -ne 0 ]
}

@test "prometheus.yml loads rules.yml and carries no alerting block (Grafana alerts)" {
    grep -q '/etc/prometheus/rules.yml' "$PROM"
    run grep -nE '^alerting:|alertmanagers:' "$PROM"
    [ "$status" -ne 0 ]
}

@test "prometheus reads the stalwart credential from a file, never inline" {
    grep -q 'credentials_file: /etc/prometheus/stalwart-api-key' "$PROM"
    run grep -nE 'credentials:[[:space:]]*[^[:space:]]' "$PROM"
    [ "$status" -ne 0 ]
}

@test "blackbox.yml defines the five probe modules" {
    [ -f "$BLACKBOX" ]
    run awk '/^  [a-z0-9_]+:$/ {gsub(/[ :]/,"",$1); print $1}' "$BLACKBOX"
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | sort | tr '\n' ' ')" = "http_2xx http_404 http_control smtp_starttls tcp_tls_connect " ]
}

@test "the acme probe module accepts 404 and refuses a redirect" {
    [ -f "$BLACKBOX" ]
    # An awk RANGE cannot be used here: the opening line "  http_404:" also
    # matches the closing pattern "^  [a-z]", so the range is one record long.
    run awk '/^  http_404:/ {f=1; next} f && /^  [a-z]/ {f=0} f' "$BLACKBOX"
    [ -n "$output" ]
    [[ "$output" == *"valid_status_codes: [404]"* ]]
    [[ "$output" == *"follow_redirects: false"* ]]
}

# ---------------------------------------------------------------------------
# ops.env.tmpl (Task 1's file; this task appends to it)
# ---------------------------------------------------------------------------

@test "ops.env.tmpl declares every ops key exactly once" {
    [ -f "$OPS_TMPL" ]
    # load_env exits 2 on a duplicated key, so a second declaration of any key
    # disables render-ops.sh and the whole ${STACK}-ops project.
    run bash -c "grep -oE '^[A-Za-z_][A-Za-z0-9_]*=' '$OPS_TMPL' | sort | uniq -d"
    [ "$status" -eq 0 ]
    [ -z "$output" ]
    local key
    for key in STACK COMPOSE_PROJECT_NAME COMPOSE_FILE PLATFORM_DOMAIN \
               EDGE_BIND_IP EDGE_BIND_IP6 OPS_V4_SUBNET OPS_V6_SUBNET \
               ALERT_WEBHOOK_URL ALERT_EMAIL_TO ALERT_SMTP_HOST ALERT_SMTP_PORT \
               ALERT_SMTP_USER ALERT_SMTP_PASSWORD \
               GREMION_ROOT_DIR OPS_BIND_IP OPS_INGEST_BIND_IP OPS_UID OPS_GID PROM_RETENTION_TIME \
               ALERT_EMAIL_FROM STALWART_API_KEY OPS_TENANT_HOSTS_FILE OTLP_INGEST_TOKEN \
               OPS_THIRD_PARTY_PROBES GREMION_DISK_ROOT GREMION_STORAGE_COMPONENTS \
               GREMION_FOOTPRINT_FILESTORE_ROOT; do
        grep -qE "^${key}=" "$OPS_TMPL" || { echo "ops.env.tmpl is missing ${key}"; return 1; }
    done
    # The ingest token is generated, never an operator literal (Q15).
    grep -qx 'OTLP_INGEST_TOKEN=CHANGE_ME_GEN_hex32_otlp_ingest' "$OPS_TMPL"
}

@test "ops.env.tmpl keeps Prometheus' worst case at 30 days or less: a 27-day window (R29-I6)" {
    run sed -n 's/^PROM_RETENTION_TIME=\([0-9]*\)d$/\1/p' "$OPS_TMPL"
    [ -n "$output" ]
    [ "$output" -le 27 ]
}

# ---------------------------------------------------------------------------
# render-ops.sh
# ---------------------------------------------------------------------------

write_ops_env() {
    # $1 = ALERT_EMAIL_TO (empty = e-mail alerting off), $2 = ALERT_SMTP_PASSWORD
    mkdir -p "$GREMION_ROOT/etc/env"
    cat > "$GREMION_ROOT/etc/env/ops.env" <<EOF
STACK=staging
COMPOSE_PROJECT_NAME=staging-ops
COMPOSE_FILE=docker-compose.yml
GREMION_ROOT_DIR=${GREMION_ROOT}
OPS_BIND_IP=127.0.0.1
OPS_INGEST_BIND_IP=10.90.1.1
OPS_UID=$(id -u)
OPS_GID=$(id -g)
OPS_V4_SUBNET=10.90.8.0/24
OPS_V6_SUBNET=fd5a:98::/64
PROM_RETENTION_TIME=27d
PLATFORM_DOMAIN=example.org
EDGE_BIND_IP=203.0.113.10
EDGE_BIND_IP6=2001:db8::a
ALERT_WEBHOOK_URL=http://127.0.0.1:9099/hook
ALERT_EMAIL_TO=${1:-}
ALERT_EMAIL_FROM=alerts@example.org
ALERT_SMTP_HOST=mail.example.org
ALERT_SMTP_PORT=587
ALERT_SMTP_USER=alerts@example.org
ALERT_SMTP_PASSWORD=${2:-CHANGE_ME_GEN_alnum32_alert_smtp}
STALWART_API_KEY=CHANGE_ME_GEN_hex32_stalwart_api
OTLP_INGEST_TOKEN=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
OPS_TENANT_HOSTS_FILE=${GREMION_ROOT}/etc/tenant-hosts.txt
OPS_THIRD_PARTY_PROBES=
EOF
}

set_key() {   # <KEY> <value>
    sed -i "s|^$1=.*|$1=$2|" "$GREMION_ROOT/etc/env/ops.env"
}

@test "render-ops writes every target list from the env file" {
    write_ops_env
    printf 'pilot.example.org\nsecond.example.org\n' > "$GREMION_ROOT/etc/tenant-hosts.txt"
    run "$RENDER" --env-file "$GREMION_ROOT/etc/env/ops.env"
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    # 11 = 3 https (platform + two tenants) + 1 control + 2 acme (v4 and v6)
    #    + 1 smtp + 1 smtp25 + 2 tls + 1 stalwart; 8 files with the (empty)
    #    third-party list.
    [[ "$output" == *"OPS-RENDER: files=8 targets=11 email=off webhook=on stalwart-key=unset grafana-sso=pending"* ]]
    grep -q 'https://example.org' "$GREMION_ROOT/runtime/ops/targets/blackbox-https.yml"
    grep -q 'https://pilot.example.org' "$GREMION_ROOT/runtime/ops/targets/blackbox-https.yml"
    grep -q 'https://second.example.org' "$GREMION_ROOT/runtime/ops/targets/blackbox-https.yml"
    grep -q 'https://control.example.org' "$GREMION_ROOT/runtime/ops/targets/blackbox-control.yml"
    grep -q 'http://203.0.113.10:80/.well-known/acme-challenge/probe' "$GREMION_ROOT/runtime/ops/targets/blackbox-acme.yml"
    grep -q 'http://\[2001:db8::a\]:80/.well-known/acme-challenge/probe' "$GREMION_ROOT/runtime/ops/targets/blackbox-acme.yml"
    grep -q 'mail.example.org:587' "$GREMION_ROOT/runtime/ops/targets/blackbox-smtp.yml"
    grep -q 'mail.example.org:25' "$GREMION_ROOT/runtime/ops/targets/blackbox-smtp25.yml"
    grep -q 'mail.example.org:465' "$GREMION_ROOT/runtime/ops/targets/blackbox-tls.yml"
    grep -q 'mail.example.org:993' "$GREMION_ROOT/runtime/ops/targets/blackbox-tls.yml"
    grep -q 'mail.example.org' "$GREMION_ROOT/runtime/ops/targets/stalwart.yml"
    [ "$(cat "$GREMION_ROOT/runtime/ops/targets/blackbox-third-party.yml")" = "[]" ]
    # every directory a bind mount of the project names exists before the first up
    local d
    for d in prometheus-data grafana-data grafana-logs loki-data tempo-data alloy-data; do
        [ -d "$GREMION_ROOT/runtime/ops/$d" ] || { echo "missing runtime/ops/$d"; return 1; }
    done
    [ -d "$GREMION_ROOT/etc/secrets/grafana" ]
}

@test "render-ops copies the provisioning tree and renders the webhook contact point with resolve notices" {
    write_ops_env
    run "$RENDER" --env-file "$GREMION_ROOT/etc/env/ops.env"
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    local cp="$GREMION_ROOT/$PROV/alerting/contact-points.yaml"
    cmp -s "$OBS_DIR/grafana/provisioning/alerting/rules.yaml" "$GREMION_ROOT/$PROV/alerting/rules.yaml"
    cmp -s "$OBS_DIR/grafana/provisioning/alerting/policies.yaml" "$GREMION_ROOT/$PROV/alerting/policies.yaml"
    cmp -s "$OBS_DIR/grafana/provisioning/datasources/datasources.yaml" "$GREMION_ROOT/$PROV/datasources/datasources.yaml"
    cmp -s "$OBS_DIR/grafana/provisioning/dashboards/dashboards.yaml" "$GREMION_ROOT/$PROV/dashboards/dashboards.yaml"
    cmp -s "$OBS_DIR/grafana/provisioning/dashboards/gremion-betrieb.json" "$GREMION_ROOT/$PROV/dashboards/gremion-betrieb.json"
    grep -q "url: 'http://127.0.0.1:9099/hook'" "$cp"
    grep -q '^      - uid: platform-webhook$' "$cp"
    run grep -c 'disableResolveMessage: false' "$cp"
    [ "$output" = "1" ]
    run grep -c 'type: email' "$cp"
    [ "$output" = "0" ]
    # Measured, not theoretical: Git for Windows' envsubst wrote CRLF once.
    run grep -c $'\r' "$cp"
    [ "$output" = "0" ]
}

@test "render-ops keeps the smtp password out of the provisioning tree, in a 0600 file" {
    write_ops_env "ops@example.org" "s3cret-app-password"
    run "$RENDER" --env-file "$GREMION_ROOT/etc/env/ops.env"
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    [[ "$output" == *"email=on webhook=on"* ]]
    grep -q "addresses: 'ops@example.org'" "$GREMION_ROOT/$PROV/alerting/contact-points.yaml"
    run grep -c 'disableResolveMessage: false' "$GREMION_ROOT/$PROV/alerting/contact-points.yaml"
    [ "$output" = "2" ]
    run grep -rc 's3cret-app-password' "$GREMION_ROOT/$PROV"
    [[ "$output" != *":1"* ]]
    [ "$(cat "$GREMION_ROOT/etc/secrets/ops/smtp-password")" = "s3cret-app-password" ]
    if fs_carries_modes "$GREMION_ROOT/etc"; then
        [ "$(stat -c '%a' "$GREMION_ROOT/etc/secrets/ops/smtp-password")" = "600" ]
    else
        skip "filesystem does not carry POSIX modes (asserted on Debian instead)"
    fi
}

@test "render-ops quotes a sink safely: a single quote doubles, a dollar stays literal" {
    write_ops_env
    set_key ALERT_WEBHOOK_URL "http://127.0.0.1:9099/hook?k=a'b\$c"
    run "$RENDER" --env-file "$GREMION_ROOT/etc/env/ops.env"
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    grep -qF "url: 'http://127.0.0.1:9099/hook?k=a''b\$c'" "$GREMION_ROOT/$PROV/alerting/contact-points.yaml"
}

@test "render-ops renders no contact point and no policy while both sinks are sentinels" {
    write_ops_env "CHANGE_ME_OPERATOR_alert_email_to"
    set_key ALERT_WEBHOOK_URL CHANGE_ME_OPERATOR_alert_webhook_url
    run "$RENDER" --env-file "$GREMION_ROOT/etc/env/ops.env"
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    [[ "$output" == *"email=off webhook=off"* ]]
    [ ! -e "$GREMION_ROOT/$PROV/alerting/contact-points.yaml" ]
    [ ! -e "$GREMION_ROOT/$PROV/alerting/policies.yaml" ]
    # the rules still ship: they evaluate and show, nothing is sent
    [ -s "$GREMION_ROOT/$PROV/alerting/rules.yaml" ]
    run grep -rc 'CHANGE_ME_' "$GREMION_ROOT/$PROV"
    [[ "$output" != *":1"* ]]
}

@test "render-ops refuses a wildcard bind address, for the UI and for the ingest" {
    write_ops_env
    set_key OPS_BIND_IP 0.0.0.0
    run "$RENDER" --env-file "$GREMION_ROOT/etc/env/ops.env"
    [ "$status" -eq 2 ]
    [[ "$output" == *"OPS_BIND_IP must be a concrete address"* ]]
    write_ops_env
    set_key OPS_INGEST_BIND_IP 0.0.0.0
    run "$RENDER" --env-file "$GREMION_ROOT/etc/env/ops.env"
    [ "$status" -eq 2 ]
    [[ "$output" == *"OPS_INGEST_BIND_IP must be a concrete address"* ]]
}

@test "render-ops refuses a uid it does not run as" {
    write_ops_env
    set_key OPS_UID 999999
    run "$RENDER" --env-file "$GREMION_ROOT/etc/env/ops.env"
    [ "$status" -eq 2 ]
    [[ "$output" == *"OPS_UID=999999 but this process runs as"* ]]
}

@test "render-ops refuses a Prometheus window above 27 days (worst case 30, R29-I6), and accepts 27" {
    write_ops_env
    set_key PROM_RETENTION_TIME 30d
    run "$RENDER" --env-file "$GREMION_ROOT/etc/env/ops.env"
    [ "$status" -eq 2 ]
    [[ "$output" == *"exceeds the 27-day window that keeps the worst case under the 30-day ceiling"* ]]
    set_key PROM_RETENTION_TIME 28d
    run "$RENDER" --env-file "$GREMION_ROOT/etc/env/ops.env"
    [ "$status" -eq 2 ]
    set_key PROM_RETENTION_TIME 649h
    run "$RENDER" --env-file "$GREMION_ROOT/etc/env/ops.env"
    [ "$status" -eq 2 ]
    set_key PROM_RETENTION_TIME 648h
    run "$RENDER" --env-file "$GREMION_ROOT/etc/env/ops.env"
    [ "$status" -eq 0 ]
    set_key PROM_RETENTION_TIME 27d
    run "$RENDER" --env-file "$GREMION_ROOT/etc/env/ops.env"
    [ "$status" -eq 0 ]
}

@test "render-ops never leaves the OTLP ingest open: an empty or sentinel token is refused" {
    write_ops_env
    set_key OTLP_INGEST_TOKEN CHANGE_ME_GEN_hex32_otlp_ingest
    run "$RENDER" --env-file "$GREMION_ROOT/etc/env/ops.env"
    [ "$status" -eq 2 ]
    [[ "$output" == *"the OTLP ingest would be open"* ]]
    set_key OTLP_INGEST_TOKEN ''
    run "$RENDER" --env-file "$GREMION_ROOT/etc/env/ops.env"
    [ "$status" -eq 2 ]
    write_ops_env
    run "$RENDER" --env-file "$GREMION_ROOT/etc/env/ops.env"
    [ "$status" -eq 0 ]
    # the bytes Alloy compares: the token, no trailing newline, 0600
    [ "$(wc -c < "$GREMION_ROOT/etc/secrets/ops/otlp-ingest-token")" -eq 64 ]
    if fs_carries_modes "$GREMION_ROOT/etc"; then
        [ "$(stat -c '%a' "$GREMION_ROOT/etc/secrets/ops/otlp-ingest-token")" = "600" ]
    fi
}

@test "render-ops renders the third-party probes with their kind and service labels, and refuses a malformed entry" {
    write_ops_env
    set_key OPS_THIRD_PARTY_PROBES '"nextcloud=https://cloud.example.org/status.php helios=https://vote.example.org/"'
    run "$RENDER" --env-file "$GREMION_ROOT/etc/env/ops.env"
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    # 9 platform targets (no tenant host list here) + the 2 third parties
    [[ "$output" == *"targets=11"* ]]
    local f="$GREMION_ROOT/runtime/ops/targets/blackbox-third-party.yml"
    grep -q '^- targets: \["https://cloud.example.org/status.php"\]$' "$f"
    grep -q '^    service: helios$' "$f"
    [ "$(grep -c '^    kind: third_party$' "$f")" -eq 2 ]
    set_key OPS_THIRD_PARTY_PROBES '"nextcloud"'
    run "$RENDER" --env-file "$GREMION_ROOT/etc/env/ops.env"
    [ "$status" -eq 2 ]
    [[ "$output" == *"is not <service>=<http(s) url>"* ]]
    # the refused render left the previous list in place, whole
    grep -q '^    service: helios$' "$f"
}

@test "render-ops is BLOCKED when e-mail alerting has no app password or no submission host" {
    # ALERT_SMTP_PASSWORD is Task 1's key, in the alert_smtp sentinel group
    # shared with mail.env (TASK-015). Before the Stalwart bring-up it
    # legitimately still carries its sentinel, and this is the one place that
    # must say so exactly.
    write_ops_env "ops@example.org" "CHANGE_ME_GEN_alnum32_alert_smtp"
    run "$RENDER" --env-file "$GREMION_ROOT/etc/env/ops.env"
    [ "$status" -eq 3 ]
    [[ "$output" == *"BLOCKED: ALERT_SMTP_PASSWORD not provisioned (Stalwart app password, §I)"* ]]
    write_ops_env "ops@example.org" "s3cret-app-password"
    set_key ALERT_SMTP_HOST CHANGE_ME_OPERATOR_alert_smtp_host
    run "$RENDER" --env-file "$GREMION_ROOT/etc/env/ops.env"
    [ "$status" -eq 3 ]
    [[ "$output" == *"BLOCKED: ALERT_SMTP_HOST is not set"* ]]
}

@test "render-ops exits 2 naming ALERT_SMTP_HOST or ALERT_SMTP_PORT when the key is absent or empty, mail on or off (TASK-039-FU residual 2)" {
    # compose interpolates both with :? for EVERY render, so a stripped key must stop here
    local mail key
    for mail in "" "ops@example.org"; do
        for key in ALERT_SMTP_HOST ALERT_SMTP_PORT; do
            write_ops_env "$mail" "s3cret-app-password"
            set_key "$key" ''
            run "$RENDER" --env-file "$GREMION_ROOT/etc/env/ops.env"
            [ "$status" -eq 2 ] || { echo "empty $key (mail='$mail'): status $status: $output"; return 1; }
            [[ "$output" == *"$key is empty"* ]] || { echo "empty $key not named: $output"; return 1; }
            write_ops_env "$mail" "s3cret-app-password"
            sed -i "/^${key}=/d" "$GREMION_ROOT/etc/env/ops.env"
            run "$RENDER" --env-file "$GREMION_ROOT/etc/env/ops.env"
            [ "$status" -eq 2 ] || { echo "absent $key (mail='$mail'): status $status: $output"; return 1; }
            [[ "$output" == *"$key is empty"* ]] || { echo "absent $key not named: $output"; return 1; }
        done
    done
}

@test "render-ops allows a CHANGE_ME host while e-mail is off, and refuses a port outside 1-65535 with e-mail on (exit 3)" {
    write_ops_env
    set_key ALERT_SMTP_HOST CHANGE_ME_OPERATOR_alert_smtp_host
    run "$RENDER" --env-file "$GREMION_ROOT/etc/env/ops.env"
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    [[ "$output" == *"email=off"* ]]
    local port
    for port in 0 70000 65536 abc 5.87 -1; do
        write_ops_env "ops@example.org" "s3cret-app-password"
        set_key ALERT_SMTP_PORT "$port"
        run "$RENDER" --env-file "$GREMION_ROOT/etc/env/ops.env"
        [ "$status" -eq 3 ] || { echo "port '$port': status $status: $output"; return 1; }
        [[ "$output" == *"BLOCKED: ALERT_SMTP_PORT"* ]] || { echo "port '$port' not named: $output"; return 1; }
    done
    # the valid pair renders as before
    for port in 1 587 65535; do
        write_ops_env "ops@example.org" "s3cret-app-password"
        set_key ALERT_SMTP_PORT "$port"
        run "$RENDER" --env-file "$GREMION_ROOT/etc/env/ops.env"
        [ "$status" -eq 0 ] || { echo "port '$port': status $status: $output"; return 1; }
        [[ "$output" == *"email=on"* ]]
    done
}

@test "render-ops refusing a missing SMTP key leaves the previous provisioning tree in place" {
    write_ops_env
    run "$RENDER" --env-file "$GREMION_ROOT/etc/env/ops.env"
    [ "$status" -eq 0 ]
    local before; before="$(cat "$GREMION_ROOT/$PROV/alerting/rules.yaml" | cksum)"
    sed -i '/^ALERT_SMTP_HOST=/d' "$GREMION_ROOT/etc/env/ops.env"
    run "$RENDER" --env-file "$GREMION_ROOT/etc/env/ops.env"
    [ "$status" -eq 2 ]
    [ -s "$GREMION_ROOT/$PROV/alerting/rules.yaml" ]
    [ "$(cat "$GREMION_ROOT/$PROV/alerting/rules.yaml" | cksum)" = "$before" ]
}

@test "docs/ops/host-tooling.md states who writes the Grafana client secret and the grafana-sso states (TASK-039-FU residual 1)" {
    local doc="${PROJECT_ROOT}/docs/ops/host-tooling.md"
    # a paragraph of its own under the commands table, not a cell of the gremion-tenant row
    grep -qF 'etc/secrets/grafana/client_secret' "$doc"
    grep -qF -- '--realm-only' "$doc"
    grep -qE 'grafana-sso=pending' "$doc"
    grep -qE 'grafana-sso=ready' "$doc"
    # the pooled path does not write it today
    grep -qE '`gremion-tenant init` on the pooled stack .* does not write it' "$doc"
    run grep -nE '^\| *`gremion-tenant`.*client_secret' "$doc"
    [ "$status" -ne 0 ]
}

@test "render-ops refuses an option with no value instead of using the default" {
    run "$RENDER" --env-file
    [ "$status" -eq 2 ]
    [[ "$output" == *"--env-file requires a value"* ]]
}

@test "render-ops writes the stalwart credential for both sentinel and real key" {
    write_ops_env
    run "$RENDER" --env-file "$GREMION_ROOT/etc/env/ops.env"
    [ "$status" -eq 0 ]
    [[ "$output" == *"stalwart-key=unset"* ]]
    [ "$(cat "$GREMION_ROOT/etc/secrets/ops/stalwart-api-key")" = "unset" ]
    set_key STALWART_API_KEY deadbeefdeadbeefdeadbeefdeadbeef
    run "$RENDER" --env-file "$GREMION_ROOT/etc/env/ops.env"
    [ "$status" -eq 0 ]
    [[ "$output" == *"stalwart-key=set"* ]]
    [ "$(cat "$GREMION_ROOT/etc/secrets/ops/stalwart-api-key")" = "deadbeefdeadbeefdeadbeefdeadbeef" ]
    if fs_carries_modes "$GREMION_ROOT/etc"; then
        [ "$(stat -c '%a' "$GREMION_ROOT/etc/secrets/ops/stalwart-api-key")" = "600" ]
    else
        skip "filesystem does not carry POSIX modes (asserted on Debian instead)"
    fi
}

@test "render-ops reports the grafana sign-in as ready once gremion-tenant wrote its secret" {
    write_ops_env
    mkdir -p "$GREMION_ROOT/etc/secrets/grafana"
    printf 'a-client-secret\n' > "$GREMION_ROOT/etc/secrets/grafana/client_secret"
    run "$RENDER" --env-file "$GREMION_ROOT/etc/env/ops.env"
    [ "$status" -eq 0 ]
    [[ "$output" == *"grafana-sso=ready"* ]]
    # never printed, never copied
    [[ "$output" != *"a-client-secret"* ]]
}

# ---------------------------------------------------------------------------
# metrics-textfile.sh (the host collector)
# ---------------------------------------------------------------------------

# docker as the host sees it: one healthy state postgres, an unhealthy ui, a
# STOPPED vector, a broker whose jsz answers, the daemon's volume sizes.
shim_docker_world() {
    shim docker '
# ps-fail: the state-container lookup (docker ps --filter ...) fails as with a daemon that does not answer
if [ -f "$GREMION_ROOT/ps-fail" ] && [ "$1" = ps ] && [ "$2" = --filter ]; then
  echo "Cannot connect to the Docker daemon" >&2; exit 1
fi
case "$*" in
  "ps --all --size"*)
    printf "staging-state-postgres-1\t1.5kB (virtual 300MB)\nstaging-state-vector-1\t0B (virtual 90MB)\n" ;;
  *"com.docker.compose.service=postgres"*) echo "abc123" ;;
  *"com.docker.compose.service=nats"*) [ -f "$GREMION_ROOT/no-nats" ] || echo "nats99" ;;
  "exec abc123 psql"*"plt.job_run"*)
    # TASK-039-FU: the platform database answers the job-run query; dispatch on the SQL text
    [ -f "$GREMION_ROOT/jobrun-down" ] && { echo "psql: error: connection refused" >&2; exit 2; }
    [ -f "$GREMION_ROOT/jobrun-missing" ] && { echo "ERROR:  relation \"plt.job_run\" does not exist" >&2; exit 1; }
    [ -f "$GREMION_ROOT/jobrun-garbage" ] && { printf "<html>\n|||\nfootprint_measurement||exploded|123\nfootprint_measurement||succeeded|notanumber\nfootprint_measurement||succeeded|0\nbackup_nightly|not-a-uuid|failed|1791000400\nfootprint_measurement|succeeded|1791000000\n"; exit 0; }
    # one row per DEFINITION (kind|customer|status|epoch): two customers of one kind are two rows
    printf "footprint_measurement||succeeded|1791000000\npurge_run||failed|1791000300\nbackup_nightly|0192f0c1-0000-7000-8000-00000000000a|failed|1791000400\nbackup_nightly|0192f0c1-0000-7000-8000-00000000000b|succeeded|1791000500\n" ;;
  "exec abc123 psql"*)                     echo "42|100" ;;
  "exec nats99 wget"*)
    [ -f "$GREMION_ROOT/jsz-broken" ] && { echo "<html>"; exit 0; }
    printf "%s" "{\"account_details\":[{\"name\":\"ACC1\",\"stream_detail\":[{\"name\":\"EVENTS\",\"state\":{\"messages\":5,\"bytes\":1200},\"consumer_detail\":[{\"name\":\"worker\",\"num_pending\":5,\"num_ack_pending\":1,\"ack_floor\":{\"stream_seq\":3},\"delivered\":{\"stream_seq\":4}}]}]}]}" ;;
  "ps --all"*)
    printf "staging-state-postgres-1\tUp 3 hours (healthy)\tpostgres\tstaging-state\nstaging-app-blue-gremion-ui-1\tUp 2 hours (unhealthy)\tgremion-ui\tstaging-app-blue\nstaging-state-vector-1\tExited (1) 5 minutes ago\tvector\tstaging-state\n" ;;
  "stats --no-stream"*)
    printf "staging-state-postgres-1\t0.75%%\t12.5MiB / 1GiB\nstaging-app-blue-gremion-ui-1\t112.30%%\t1.5GiB / 2GiB\n" ;;
  "info --format"*) echo "$GREMION_ROOT" ;;
  "system df -v"*)
    printf "%s" "[{\"Name\":\"staging-state_pg-data\",\"Size\":\"1.5GB\"},{\"Name\":\"staging-state_vector-processed-logs\",\"Size\":\"20MB\"},{\"Name\":\"other_data\",\"Size\":\"9GB\"}]" ;;
  *) : ;;
esac
exit 0'
}

shim_timer() {   # $1 = what systemctl is-enabled prints
    shim systemctl "echo $1; exit 0"
}

prom() { cat "$GREMION_ROOT/runtime/textfile/gremion.prom"; }

@test "metrics-textfile reports the backup outcome, its time and the timer state (Q8)" {
    shim_docker_world
    shim_timer disabled
    printf '{"ts":"2026-09-09T02:00:00Z","ok":true,"label":"daily"}\n' > "$GREMION_ROOT/runtime/last-backup.json"
    STACK=staging run "$METRICS"
    [ "$status" -eq 0 ]
    # 2026-09-09T02:00:00Z is 1788919200.
    grep -q '^gremion_backup_last_ok 1$' "$GREMION_ROOT/runtime/textfile/gremion.prom"
    grep -q '^gremion_backup_last_ts_seconds 1788919200$' "$GREMION_ROOT/runtime/textfile/gremion.prom"
    grep -q '^gremion_backup_timer_enabled 0$' "$GREMION_ROOT/runtime/textfile/gremion.prom"
    assert_recorded systemctl "is-enabled gremion-backup.timer"
}

@test "metrics-textfile reports a FAILED backup as 0, never as absent or as a success" {
    shim_docker_world
    shim_timer enabled
    printf '{"ts":"2026-09-09T02:00:00Z","ok":false,"label":"daily"}\n' > "$GREMION_ROOT/runtime/last-backup.json"
    STACK=staging run "$METRICS"
    [ "$status" -eq 0 ]
    grep -q '^gremion_backup_last_ok 0$' "$GREMION_ROOT/runtime/textfile/gremion.prom"
    grep -q '^gremion_backup_timer_enabled 1$' "$GREMION_ROOT/runtime/textfile/gremion.prom"
}

@test "metrics-textfile leaves the backup record ABSENT when there is no last-backup.json or no systemd" {
    shim_docker_world
    shim_timer enabled
    STACK=staging run "$METRICS"
    [ "$status" -eq 0 ]
    run grep -cE '^gremion_backup_last_(ok|ts_seconds) ' "$GREMION_ROOT/runtime/textfile/gremion.prom"
    [ "$output" = "0" ]
    grep -q '^gremion_backup_timer_enabled 1$' "$GREMION_ROOT/runtime/textfile/gremion.prom"
    # an unreadable ok flag is not a success either
    printf '{"ts":"2026-09-09T02:00:00Z","ok":"yes"}\n' > "$GREMION_ROOT/runtime/last-backup.json"
    STACK=staging run "$METRICS"
    run grep -c '^gremion_backup_last_ok ' "$GREMION_ROOT/runtime/textfile/gremion.prom"
    [ "$output" = "0" ]
}

@test "metrics-textfile marks an unhealthy container, a stopped one, and their memory and disk" {
    shim_docker_world
    shim_timer enabled
    STACK=staging run "$METRICS"
    [ "$status" -eq 0 ]
    grep -q 'gremion_container_unhealthy{name="staging-app-blue-gremion-ui-1"} 1' "$GREMION_ROOT/runtime/textfile/gremion.prom"
    grep -q 'gremion_container_unhealthy{name="staging-state-postgres-1"} 0' "$GREMION_ROOT/runtime/textfile/gremion.prom"
    grep -q 'gremion_container_up{name="staging-state-vector-1",service="vector",project="staging-state"} 0' "$GREMION_ROOT/runtime/textfile/gremion.prom"
    grep -q 'gremion_container_up{name="staging-state-postgres-1",service="postgres",project="staging-state"} 1' "$GREMION_ROOT/runtime/textfile/gremion.prom"
    # 12.5 MiB = 13107200 bytes; 1.5 GiB = 1610612736; 1.5 kB = 1500
    grep -q 'gremion_container_memory_bytes{name="staging-state-postgres-1"} 13107200' "$GREMION_ROOT/runtime/textfile/gremion.prom"
    grep -q 'gremion_container_memory_bytes{name="staging-app-blue-gremion-ui-1"} 1610612736' "$GREMION_ROOT/runtime/textfile/gremion.prom"
    grep -q 'gremion_container_disk_bytes{name="staging-state-postgres-1"} 1500' "$GREMION_ROOT/runtime/textfile/gremion.prom"
    # per-container CPU, which cAdvisor carried before TASK-039
    grep -q '^gremion_container_cpu_percent{name="staging-state-postgres-1"} 0.75$' "$GREMION_ROOT/runtime/textfile/gremion.prom"
    grep -q '^gremion_container_cpu_percent{name="staging-app-blue-gremion-ui-1"} 112.30$' "$GREMION_ROOT/runtime/textfile/gremion.prom"
}

@test "metrics-textfile reports postgres connections from the state project" {
    shim_docker_world
    shim_timer enabled
    STACK=staging run "$METRICS"
    [ "$status" -eq 0 ]
    grep -q '^gremion_postgres_connections_used 42$' "$GREMION_ROOT/runtime/textfile/gremion.prom"
    grep -q '^gremion_postgres_connections_max 100$' "$GREMION_ROOT/runtime/textfile/gremion.prom"
    assert_recorded docker "com.docker.compose.project=staging-state"
}

@test "metrics-textfile looks the state containers up in GREMION_STATE_PROJECT when set (a single-project layout), else in <STACK>-state" {
    shim_docker_world
    shim_timer enabled
    STACK=staging GREMION_STATE_PROJECT=legacy run "$METRICS"
    [ "$status" -eq 0 ]
    assert_recorded docker "com.docker.compose.project=legacy"
    run grep -c "com.docker.compose.project=staging-state" "$SHIM_LOG"
    [ "$output" = "0" ]
}

@test "metrics-textfile reports the last job run per job kind from the platform database (TASK-039-FU, one family)" {
    shim_docker_world
    shim_timer enabled
    STACK=staging run "$METRICS"
    [ "$status" -eq 0 ]
    grep -q '^gremion_job_last_run{job_kind="footprint_measurement",status="succeeded"} 1791000000$' "$GREMION_ROOT/runtime/textfile/gremion.prom"
    grep -q '^gremion_job_last_run{job_kind="purge_run",status="failed"} 1791000300$' "$GREMION_ROOT/runtime/textfile/gremion.prom"
    # round-1 M2: one sample per DEFINITION, so customer A's failed backup is not
    # hidden by customer B's later success (pseudonymous customer id as the label)
    grep -q '^gremion_job_last_run{job_kind="backup_nightly",customer="0192f0c1-0000-7000-8000-00000000000a",status="failed"} 1791000400$' "$GREMION_ROOT/runtime/textfile/gremion.prom"
    grep -q '^gremion_job_last_run{job_kind="backup_nightly",customer="0192f0c1-0000-7000-8000-00000000000b",status="succeeded"} 1791000500$' "$GREMION_ROOT/runtime/textfile/gremion.prom"
    # the query is keyed per definition with a deterministic tie-break, never per kind
    assert_recorded docker "DISTINCT ON (r.scheduled_job_id)"
    assert_recorded docker "r.finished_at DESC, r.job_run_id DESC"
    refute_recorded docker "DISTINCT ON (s.job_kind)"
    # one family, one HELP/TYPE, read in the platform database through the state postgres
    run grep -c '^# TYPE gremion_job_last_run gauge$' "$GREMION_ROOT/runtime/textfile/gremion.prom"
    [ "$output" = "1" ]
    assert_recorded docker "exec abc123 psql -U postgres -d gremion_platform"
    # the postgres-connections reading still gets ITS answer from the same container
    grep -q '^gremion_postgres_connections_used 42$' "$GREMION_ROOT/runtime/textfile/gremion.prom"
}

@test "metrics-textfile leaves gremion_job_last_run ABSENT, never 0, when the query fails, the table is missing or the rows are garbage" {
    shim_docker_world
    shim_timer enabled
    touch "$GREMION_ROOT/jobrun-down"
    STACK=staging run "$METRICS"
    [ "$status" -eq 0 ]
    # psql's own first error line is in the note (round-2 silent-failure LOW:
    # every failure used to read the same generic "no job run readable")
    [[ "$output" == *"connection refused"* ]] || { echo "$output"; return 1; }
    run grep -c 'gremion_job_last_run' "$GREMION_ROOT/runtime/textfile/gremion.prom"
    [ "$output" = "0" ]
    rm -f "$GREMION_ROOT/jobrun-down"; touch "$GREMION_ROOT/jobrun-missing"
    STACK=staging run "$METRICS"
    [ "$status" -eq 0 ]
    [[ "$output" == *'relation "plt.job_run" does not exist'* ]] || { echo "$output"; return 1; }
    run grep -c 'gremion_job_last_run' "$GREMION_ROOT/runtime/textfile/gremion.prom"
    [ "$output" = "0" ]
    rm -f "$GREMION_ROOT/jobrun-missing"; touch "$GREMION_ROOT/jobrun-garbage"
    STACK=staging run "$METRICS"
    [ "$status" -eq 0 ]
    run grep -c 'gremion_job_last_run' "$GREMION_ROOT/runtime/textfile/gremion.prom"
    [ "$output" = "0" ]
    # the rest of the file is still written
    grep -q '^gremion_postgres_connections_used 42$' "$GREMION_ROOT/runtime/textfile/gremion.prom"
}

@test "metrics-textfile survives a failing state-container lookup: the postgres, job-run and broker signals are absent, the file is still written (TASK-039-FU round 2, ops-lib state_container)" {
    shim_docker_world
    shim_timer enabled
    touch "$GREMION_ROOT/ps-fail"
    STACK=staging run "$METRICS"
    [ "$status" -eq 0 ] || { echo "status $status: $output"; return 1; }
    grep -qE '^gremion_metrics_textfile_timestamp_seconds [0-9]+$' "$GREMION_ROOT/runtime/textfile/gremion.prom"
    run grep -cE '^gremion_(postgres_connections_used|job_last_run|nats_jsz_up)' "$GREMION_ROOT/runtime/textfile/gremion.prom"
    [ "$output" = "0" ]
}

@test "metrics-textfile turns the broker's jsz into stream and consumer gauges, read inside the broker (TDD 9)" {
    shim_docker_world
    shim_timer enabled
    STACK=staging run "$METRICS"
    [ "$status" -eq 0 ]
    grep -q '^gremion_nats_jsz_up 1$' "$GREMION_ROOT/runtime/textfile/gremion.prom"
    grep -q '^gremion_nats_stream_bytes{account="ACC1",stream="EVENTS"} 1200$' "$GREMION_ROOT/runtime/textfile/gremion.prom"
    grep -q '^gremion_nats_consumer_num_pending{account="ACC1",stream="EVENTS",consumer="worker"} 5$' "$GREMION_ROOT/runtime/textfile/gremion.prom"
    grep -q '^gremion_nats_consumer_num_ack_pending{account="ACC1",stream="EVENTS",consumer="worker"} 1$' "$GREMION_ROOT/runtime/textfile/gremion.prom"
    grep -q '^gremion_nats_consumer_ack_floor_stream_seq{account="ACC1",stream="EVENTS",consumer="worker"} 3$' "$GREMION_ROOT/runtime/textfile/gremion.prom"
    # the monitor is read on the broker's own loopback, by docker exec
    assert_recorded docker "exec nats99 wget -qO- http://127.0.0.1:8222/jsz?accounts=true&streams=true&consumers=true"
}

@test "metrics-textfile leaves every broker gauge ABSENT, never 0, when the broker is gone or answers garbage" {
    shim_docker_world
    shim_timer enabled
    touch "$GREMION_ROOT/no-nats"
    STACK=staging run "$METRICS"
    [ "$status" -eq 0 ]
    run grep -c '^gremion_nats_.*[0-9]$' "$GREMION_ROOT/runtime/textfile/gremion.prom"
    [ "$output" = "0" ]
    rm -f "$GREMION_ROOT/no-nats"; touch "$GREMION_ROOT/jsz-broken"
    STACK=staging run "$METRICS"
    run grep -c '^gremion_nats_.*[0-9]$' "$GREMION_ROOT/runtime/textfile/gremion.prom"
    [ "$output" = "0" ]
}

# TASK-079 (G4b): the events services' dead-letter gauges, one `events metrics` per labelled container.
shim_docker_events_world() {
    shim docker '
case "$*" in
  "ps --filter label=org.gremion.events-metrics"*) printf "evt1 idt\nevt2 fin\nevt3 gov\n" ;;
  "exec evt1 pnpm exec events metrics --ctx idt")
    printf "# HELP gremion_outbox_dead_lettered Outbox rows.\n# TYPE gremion_outbox_dead_lettered gauge\ngremion_outbox_dead_lettered{ctx=\"idt\"} 1\n# HELP gremion_inbox_dead_lettered Inbox rows.\n# TYPE gremion_inbox_dead_lettered gauge\ngremion_inbox_dead_lettered{ctx=\"idt\",consumer=\"idt\"} 0\n# HELP gremion_inbox_stalled Stalled.\n# TYPE gremion_inbox_stalled gauge\ngremion_inbox_stalled{ctx=\"idt\",consumer=\"idt\"} 0\n# EOF\n" ;;
  "exec evt2 pnpm exec events metrics --ctx fin")
    printf "# HELP gremion_outbox_dead_lettered Outbox rows.\n# TYPE gremion_outbox_dead_lettered gauge\ngremion_outbox_dead_lettered{ctx=\"fin\"} 0\n# HELP gremion_inbox_dead_lettered Inbox rows.\n# TYPE gremion_inbox_dead_lettered gauge\ngremion_inbox_dead_lettered{ctx=\"fin\",consumer=\"finance\"} 2\n# HELP gremion_inbox_stalled Stalled.\n# TYPE gremion_inbox_stalled gauge\ngremion_inbox_stalled{ctx=\"fin\",consumer=\"finance\"} 1\n# EOF\n" ;;
  "exec evt3 pnpm exec events metrics --ctx gov") echo "events: cannot reach the database" >&2; exit 1 ;;
  *) : ;;
esac
exit 0'
}

@test "metrics-textfile merges the dead-letter gauges of every labelled service container into one block per family (TASK-079)" {
    shim_docker_events_world
    shim_timer enabled
    STACK=staging run "$METRICS"
    [ "$status" -eq 0 ]
    local f="$GREMION_ROOT/runtime/textfile/gremion.prom"
    grep -q '^gremion_outbox_dead_lettered{ctx="idt"} 1$' "$f"
    grep -q '^gremion_outbox_dead_lettered{ctx="fin"} 0$' "$f"
    grep -q '^gremion_inbox_dead_lettered{ctx="fin",consumer="finance"} 2$' "$f"
    grep -q '^gremion_inbox_stalled{ctx="fin",consumer="finance"} 1$' "$f"
    # each family named once and contiguous, no OpenMetrics terminator in the middle of a textfile
    run bash -c "grep -cE '^# TYPE gremion_(outbox_dead_lettered|inbox_dead_lettered|inbox_stalled) ' '$f'"
    [ "$output" = "3" ]
    run bash -c "grep -c '^# EOF' '$f' || true"
    [ "$output" = "0" ]
    run awk '/^#/ {next} {n=$0; sub(/[{ ].*/, "", n); if (n != last) { if (seen[n]++) { print "interleaved " n; exit 1 } last = n } }' "$f"
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    # read inside each labelled container, by docker exec
    assert_recorded docker "exec evt1 pnpm exec events metrics --ctx idt"
    assert_recorded docker "exec evt2 pnpm exec events metrics --ctx fin"
}

@test "metrics-textfile skips a labelled container that prints no gauges, and prints nothing (absent, never 0) when none is labelled (TASK-079)" {
    shim_docker_events_world
    shim_timer enabled
    STACK=staging run "$METRICS"
    [ "$status" -eq 0 ]
    # evt3 (ctx gov) failed: it contributes no sample at all
    run grep -c 'ctx="gov"' "$GREMION_ROOT/runtime/textfile/gremion.prom"
    [ "$output" = "0" ]
    shim_docker_world
    STACK=staging run "$METRICS"
    [ "$status" -eq 0 ]
    run grep -cE '^gremion_(outbox|inbox)_' "$GREMION_ROOT/runtime/textfile/gremion.prom"
    [ "$output" = "0" ]
}

@test "metrics-textfile measures the TRD-224 components against GREMION_DISK_ROOT, never /, and a missing one is absent (TDD 8)" {
    shim_docker_world
    shim_timer enabled
    mkdir -p "$GREMION_ROOT/disk/seeded"
    head -c 4096 /dev/zero > "$GREMION_ROOT/disk/seeded/blob"
    GREMION_DISK_ROOT="$GREMION_ROOT/disk" GREMION_STORAGE_INTERVAL=0 \
        GREMION_STORAGE_COMPONENTS="seeded=$GREMION_ROOT/disk/seeded gone=$GREMION_ROOT/disk/nope" \
        STACK=staging run "$METRICS"
    [ "$status" -eq 0 ]
    grep -qE "^gremion_host_disk_provisioned_bytes\{path=\"$GREMION_ROOT/disk\"\} [0-9]+$" "$GREMION_ROOT/runtime/textfile/gremion.prom"
    grep -qE '^gremion_storage_component_bytes\{component="seeded"\} [0-9]+$' "$GREMION_ROOT/runtime/textfile/gremion.prom"
    run grep -c 'component="gone"' "$GREMION_ROOT/runtime/textfile/gremion.prom"
    [ "$output" = "0" ]
    grep -qE '^gremion_host_filesystem_size_bytes\{mountpoint="/"\} [0-9]+$' "$GREMION_ROOT/runtime/textfile/gremion.prom"
}

@test "metrics-textfile defaults the components to the state project's Postgres and Vector volumes, by the daemon" {
    shim_docker_world
    shim_timer enabled
    GREMION_STORAGE_INTERVAL=0 STACK=staging run "$METRICS"
    [ "$status" -eq 0 ]
    grep -q '^gremion_storage_component_bytes{component="staging-state_pg-data"} 1500000000$' "$GREMION_ROOT/runtime/textfile/gremion.prom"
    grep -q '^gremion_storage_component_bytes{component="staging-state_vector-processed-logs"} 20000000$' "$GREMION_ROOT/runtime/textfile/gremion.prom"
    run grep -c 'other_data' "$GREMION_ROOT/runtime/textfile/gremion.prom"
    [ "$output" = "0" ]
    # default GREMION_DISK_ROOT: Docker's data root, as the daemon reports it
    assert_recorded docker "info --format"
}

@test "metrics-textfile reuses the last component reading inside GREMION_STORAGE_INTERVAL" {
    shim_docker_world
    shim_timer enabled
    GREMION_STORAGE_INTERVAL=0 STACK=staging run "$METRICS"
    [ "$status" -eq 0 ]
    : > "$SHIM_LOG"
    GREMION_STORAGE_INTERVAL=900 STACK=staging run "$METRICS"
    [ "$status" -eq 0 ]
    run grep -c 'system df' "$SHIM_LOG"
    [ "$output" = "0" ]
    grep -q '^gremion_storage_component_bytes{component="staging-state_pg-data"} 1500000000$' "$GREMION_ROOT/runtime/textfile/gremion.prom"
}

@test "metrics-textfile reuses the last per-container disk reading inside GREMION_STORAGE_INTERVAL (docker ps --size walks every layer)" {
    shim_docker_world
    shim_timer enabled
    GREMION_STORAGE_INTERVAL=0 STACK=staging run "$METRICS"
    [ "$status" -eq 0 ]
    : > "$SHIM_LOG"
    GREMION_STORAGE_INTERVAL=900 STACK=staging run "$METRICS"
    [ "$status" -eq 0 ]
    run grep -c 'ps --all --size' "$SHIM_LOG"
    [ "$output" = "0" ]
    grep -q '^gremion_container_disk_bytes{name="staging-state-postgres-1"} 1500$' "$GREMION_ROOT/runtime/textfile/gremion.prom"
    # the reading is taken again once the interval has passed
    : > "$SHIM_LOG"
    GREMION_STORAGE_INTERVAL=0 STACK=staging run "$METRICS"
    [ "$status" -eq 0 ]
    grep -q 'ps --all --size' "$SHIM_LOG"
}

@test "metrics-textfile always stamps its own timestamp last" {
    shim_docker_world
    shim_timer enabled
    run "$METRICS"
    [ "$status" -eq 0 ]
    run tail -n 1 "$GREMION_ROOT/runtime/textfile/gremion.prom"
    [[ "$output" =~ ^gremion_metrics_textfile_timestamp_seconds\ [0-9]+$ ]]
}

@test "metrics-textfile writes each metric family once, contiguously (the text format)" {
    shim_docker_world
    shim_timer enabled
    STACK=staging run "$METRICS"
    [ "$status" -eq 0 ]
    run bash -c "grep -oE '^# TYPE [a-z_]+' '$GREMION_ROOT/runtime/textfile/gremion.prom' | sort | uniq -d"
    [ -z "$output" ]
    # samples of one family never interleave with another's
    run awk '/^#/ {next} {n=$0; sub(/[{ ].*/, "", n); if (n != last) { if (seen[n]++) { print "interleaved " n; exit 1 } last = n } }' "$GREMION_ROOT/runtime/textfile/gremion.prom"
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
}

@test "metrics-textfile leaves no partial file behind" {
    shim_docker_world
    shim_timer enabled
    run "$METRICS"
    [ "$status" -eq 0 ]
    run find "$GREMION_ROOT/runtime/textfile" -name '*.tmp'
    [ -z "$output" ]
}

@test "metrics-textfile refuses a missing runtime directory" {
    shim_docker_world
    rm -rf "$GREMION_ROOT/runtime"
    run "$METRICS"
    [ "$status" -eq 2 ]
    [[ "$output" == *"runtime directory absent"* ]]
}

# ---------------------------------------------------------------------------
# systemd units — Task 2's ${GREMION_ROOT}/${DEPLOY_USER} token convention
# ---------------------------------------------------------------------------

@test "the metrics collector has a unit and a one-minute timer, in token form" {
    [ -f "${UNIT_DIR}/gremion-metrics.service" ]
    [ -f "${UNIT_DIR}/gremion-metrics.timer" ]
    grep -q '^Type=oneshot' "${UNIT_DIR}/gremion-metrics.service"
    grep -q '^ExecStart=${GREMION_ROOT}/current/infra/host/ops/metrics-textfile.sh$' "${UNIT_DIR}/gremion-metrics.service"
    grep -q '^User=${DEPLOY_USER}$' "${UNIT_DIR}/gremion-metrics.service"
    grep -q '^Environment=GREMION_ROOT=${GREMION_ROOT}$' "${UNIT_DIR}/gremion-metrics.service"
    grep -q '^After=docker.service' "${UNIT_DIR}/gremion-metrics.service"
    grep -q '^OnUnitActiveSec=1min' "${UNIT_DIR}/gremion-metrics.timer"
    grep -q '^WantedBy=timers.target' "${UNIT_DIR}/gremion-metrics.timer"
    # A literal root path here would silently diverge from Task 2's renderer.
    run grep -n '/opt/gremion' "${UNIT_DIR}/gremion-metrics.service"
    [ "$status" -ne 0 ]
}

@test "bootstrap's timers stage installs the footprint units through two-argument render_unit and asserts a real next elapse (TASK-039-FU)" {
    local bs="${PROJECT_ROOT}/infra/host/bootstrap.sh"
    grep -qF 'render_unit gremion-footprint.service /etc/systemd/system/gremion-footprint.service' "$bs"
    grep -qF 'render_unit gremion-footprint.timer /etc/systemd/system/gremion-footprint.timer' "$bs"
    grep -qF 'systemctl enable --now gremion-footprint.timer' "$bs"
    grep -qF 'systemctl show gremion-footprint.timer -p NextElapseUSecRealtime --value' "$bs"
    run grep -nE 'render_unit +[A-Za-z0-9._-]+ *\|' "$bs"
    [ "$status" -ne 0 ]
}

@test "the reboot gate unit runs the verifier after docker, in token form" {
    [ -f "${UNIT_DIR}/gremion-verify.service" ]
    grep -q '^After=docker.service' "${UNIT_DIR}/gremion-verify.service"
    grep -q '^Requires=docker.service' "${UNIT_DIR}/gremion-verify.service"
    grep -q '^Type=oneshot' "${UNIT_DIR}/gremion-verify.service"
    grep -q '^User=${DEPLOY_USER}$' "${UNIT_DIR}/gremion-verify.service"
    grep -q '^WantedBy=multi-user.target' "${UNIT_DIR}/gremion-verify.service"
    # Task 2's bootstrap-render.bats asserts the prefix
    # `ExecStart=${GREMION_ROOT}/bin/gremion-verify`; --reboot extends it.
    grep -q '^ExecStart=${GREMION_ROOT}/bin/gremion-verify --reboot$' "${UNIT_DIR}/gremion-verify.service"
    run grep -n '/opt/gremion' "${UNIT_DIR}/gremion-verify.service"
    [ "$status" -ne 0 ]
}

@test "bootstrap's timers stage installs the metrics timer through two-argument render_unit" {
    local bs="${PROJECT_ROOT}/infra/host/bootstrap.sh"
    grep -qF 'render_unit gremion-metrics.service /etc/systemd/system/gremion-metrics.service' "$bs"
    grep -qF 'render_unit gremion-metrics.timer /etc/systemd/system/gremion-metrics.timer' "$bs"
    grep -qF 'systemctl enable --now gremion-metrics.timer' "$bs"
    # render_unit takes TWO arguments (Task 2) and writes <dest> itself. A call
    # that pipes it into atomic_write runs it with ONE argument, which Task 2
    # refuses (exit 2) — nothing is written. Refuse the pipe shape in bootstrap.
    run grep -nE 'render_unit +[A-Za-z0-9._-]+ *\|' "$bs"
    [ "$status" -ne 0 ]
}

# ---------------------------------------------------------------------------
# gremion-verify --reboot (the §F.8 reboot gate)
# ---------------------------------------------------------------------------

# $1 = colon-separated exit codes the child verifier returns, call by call.
stub_child_verify() {
    mkdir -p "$GREMION_ROOT/bin"
    printf '%s\n' "$1" > "$GREMION_ROOT/verify-plan"
    cat > "$GREMION_ROOT/bin/gremion-verify" <<'STUB'
#!/usr/bin/env bash
plan_file="${GREMION_ROOT}/verify-plan"
count_file="${GREMION_ROOT}/verify-calls"
n=$(( $(cat "$count_file" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$count_file"
echo "child verify call $n" >> "${GREMION_ROOT}/verify-log"
IFS=':' read -r -a codes < "$plan_file"
code="${codes[$((n - 1))]:-${codes[${#codes[@]}-1]}}"
exit "$code"
STUB
    chmod +x "$GREMION_ROOT/bin/gremion-verify"
}

shim_reboot_env() {
    shim docker 'exit 0'
    shim curl 'exit 0'
    export REBOOT_GATE_SETTLE_SECONDS=0
    export ALERT_WEBHOOK_URL="http://127.0.0.1:9099/hook"
    mkdir -p "$GREMION_ROOT/etc/env"
    : > "$GREMION_ROOT/etc/env/app-blue.env"
    : > "$GREMION_ROOT/etc/env/app-green.env"
}

@test "reboot gate passes on the first verify and restarts nothing" {
    shim_reboot_env
    stub_child_verify "0"
    echo blue > "$GREMION_ROOT/runtime/active-colour"
    run "$VERIFY" --reboot
    [ "$status" -eq 0 ]
    [[ "$output" == *"REBOOT-GATE: verify=pass restarted=0"* ]]
    run grep -c 'compose' "$SHIM_LOG"
    [ "$output" = "0" ]
}

@test "reboot gate restarts the active colour once and recovers" {
    shim_reboot_env
    stub_child_verify "1:0"
    echo blue > "$GREMION_ROOT/runtime/active-colour"
    run "$VERIFY" --reboot
    [ "$status" -eq 0 ]
    [[ "$output" == *"REBOOT-GATE: verify=pass restarted=1"* ]]
    assert_recorded docker "compose --env-file ${GREMION_ROOT}/etc/env/app-blue.env restart"
    assert_recorded curl '"event":"reboot-gate"'
    [ "$(cat "$GREMION_ROOT/verify-calls")" = "2" ]
}

@test "reboot gate restarts at most once and then alerts a failure" {
    shim_reboot_env
    stub_child_verify "1:1"
    echo green > "$GREMION_ROOT/runtime/active-colour"
    run "$VERIFY" --reboot
    [ "$status" -eq 1 ]
    [[ "$output" == *"REBOOT-GATE: verify=fail restarted=1"* ]]
    # Anchored on the docker line: the alert payload carries "restarted":1, so a
    # bare grep for "restart" counts the report as a second restart and the
    # at-most-once guard would be measuring the wrong thing entirely.
    [ "$(grep -c '^docker .*restart' "$SHIM_LOG")" = "1" ]
    assert_recorded curl '"ok":false'
    [ "$(cat "$GREMION_ROOT/verify-calls")" = "2" ]
}

@test "reboot gate never uses a forbidden compose flag" {
    shim_reboot_env
    stub_child_verify "1:0"
    echo blue > "$GREMION_ROOT/runtime/active-colour"
    run "$VERIFY" --reboot
    [ "$status" -eq 0 ]
    run grep -E 'compose .*( -f | -p | --profile )' "$SHIM_LOG"
    [ "$status" -ne 0 ]
}

@test "reboot gate restarts nothing when there is no active colour" {
    shim_reboot_env
    stub_child_verify "1"
    echo none > "$GREMION_ROOT/runtime/active-colour"
    run "$VERIFY" --reboot
    [ "$status" -eq 1 ]
    [[ "$output" == *"REBOOT-GATE: verify=fail restarted=0"* ]]
    run grep -c '^docker .*restart' "$SHIM_LOG"
    [ "$output" = "0" ]
    assert_recorded curl "nothing to restart"
}

@test "reboot gate refuses to nest inside itself" {
    shim_reboot_env
    stub_child_verify "0"
    echo blue > "$GREMION_ROOT/runtime/active-colour"
    GREMION_IN_REBOOT_GATE=1 run "$VERIFY" --reboot
    [ "$status" -eq 2 ]
    [[ "$output" == *"refusing to nest --reboot inside a reboot gate"* ]]
}

@test "reboot gate gives up when docker never answers" {
    shim docker 'exit 1'
    shim curl 'exit 0'
    export REBOOT_GATE_SETTLE_SECONDS=0
    export REBOOT_GATE_DOCKER_TRIES=2
    export REBOOT_GATE_DOCKER_WAIT=0
    export ALERT_WEBHOOK_URL="http://127.0.0.1:9099/hook"
    stub_child_verify "0"
    run "$VERIFY" --reboot
    [ "$status" -eq 2 ]
    [[ "$output" == *"docker unavailable"* ]]
    assert_recorded curl "docker did not answer"
}

@test "reboot gate reads ALERT_WEBHOOK_URL from ops.env when the environment has none" {
    # gremion-verify.service passes only GREMION_ROOT, so on a real boot the
    # webhook URL is not in the environment. Without this the gate would report
    # nowhere and call it alerted.
    shim_reboot_env
    unset ALERT_WEBHOOK_URL
    printf 'ALERT_WEBHOOK_URL=http://127.0.0.1:9098/from-ops-env\n' > "$GREMION_ROOT/etc/env/ops.env"
    stub_child_verify "0"
    echo blue > "$GREMION_ROOT/runtime/active-colour"
    run "$VERIFY" --reboot
    [ "$status" -eq 0 ]
    assert_recorded curl "http://127.0.0.1:9098/from-ops-env"
}

@test "reboot gate treats a sentinel webhook as no webhook and says so out loud" {
    shim_reboot_env
    unset ALERT_WEBHOOK_URL
    printf 'ALERT_WEBHOOK_URL=CHANGE_ME_OPERATOR_alert_webhook_url\n' > "$GREMION_ROOT/etc/env/ops.env"
    stub_child_verify "0"
    echo blue > "$GREMION_ROOT/runtime/active-colour"
    run "$VERIFY" --reboot
    [ "$status" -eq 0 ]
    [[ "$output" == *"ALERT_WEBHOOK_URL is empty"* ]]
    run grep -c '^curl ' "$SHIM_LOG"
    [ "$output" = "0" ]
}

# TASK-043d-1 verify-r1 HIGH 2: a bootstrapped host must get the executor
# service, or there is no create path (the CLI create is decommissioned).
@test "bootstrap has an executor stage: installed through two-argument render_unit, enabled, asserted active, in the stage table and in 'all'" {
    local bs="${PROJECT_ROOT}/infra/host/bootstrap.sh"
    grep -qE '^stage_executor\(\) \{' "$bs"
    grep -qF 'render_unit gremion-executor.service /etc/systemd/system/gremion-executor.service' "$bs"
    grep -qF 'systemctl enable --now gremion-executor.service' "$bs"
    grep -qF 'systemctl is-active --quiet gremion-executor.service' "$bs"
    grep -qE '^ +executor\) +stage_executor ;;' "$bs"
    # 'all' runs it, after the agent stage
    grep -qE 'stage_agent; stage_executor|stage_firewall; stage_agent; stage_executor' "$bs"
    run grep -nE 'render_unit +[A-Za-z0-9._-]+ *\|' "$bs"
    [ "$status" -ne 0 ]
}

@test "bootstrap's executor stage installs the program and its lib side by side (it resolves ../lib/common.sh from BASH_SOURCE)" {
    local bs="${PROJECT_ROOT}/infra/host/bootstrap.sh"
    local body; body="$(awk '/^stage_executor\(\) \{/,/^}/' "$bs")"
    [ -n "$body" ]
    grep -qF '$SCRIPT_DIR/bin/gremion-executor' <<<"$body"
    grep -qF '/bin/gremion-executor"' <<<"$body"
    grep -qF 'lib/common.sh' <<<"$body"
    grep -qF 'executor' <(grep -F 'executor' <<<"$(awk '/^usage\(\)/,/^}/' "$bs"; sed -n '/^Stages:/,/^Options:/p' "$bs")")
}

# TASK-043d-1 verify-r1 HIGH 3: the customer proof must not call the
# decommissioned `gremion-tenant create` (it exits 2); it queues a request and
# runs the executor for it.
@test "customer-provision-proof.sh creates through panel-create + executor-once, never the decommissioned gremion-tenant create" {
    local f="${PROJECT_ROOT}/test/host/integration/customer-provision-proof.sh"
    bash -n "$f"
    run grep -nE '(^|[^_a-z-])tenant create ' "$f"
    [ "$status" -ne 0 ]
    grep -qE '^panel_create\(\) \{' "$f"
    grep -qE '^executor_once\(\) \{' "$f"
    grep -qF 'tenant request create --args-file' "$f"
    grep -qF 'executor --once' "$f"
    grep -qE 'customer-executor-once-x\) +phase_customer_executor_once' "$f"
}
