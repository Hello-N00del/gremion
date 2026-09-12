#!/usr/bin/env bats
# Task 11 — the ${STACK}-ops project, the textfile collector and the post-boot verify gate.
# Unit only: docker, curl and psql are shimmed; nothing here touches a real daemon.

load 'test_helper/host'

PROJECT_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
OPS_DIR="${PROJECT_ROOT}/infra/host/ops"
COMPOSE="${OPS_DIR}/docker-compose.yml"
PROM="${OPS_DIR}/prometheus.yml"
ALERTS="${OPS_DIR}/alerts.yml"
BLACKBOX="${OPS_DIR}/blackbox.yml"
RENDER="${OPS_DIR}/render-ops.sh"
METRICS="${OPS_DIR}/metrics-textfile.sh"
VERIFY="${PROJECT_ROOT}/infra/host/bin/gremion-verify"
UNIT_DIR="${PROJECT_ROOT}/infra/host/templates/systemd"
OPS_TMPL="${PROJECT_ROOT}/infra/host/templates/env/ops.env.tmpl"

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
# The compose project
# ---------------------------------------------------------------------------

@test "ops compose declares exactly the five ops services" {
    [ -f "$COMPOSE" ]
    # Scoped to the services: block on purpose. A bare `/^  [a-z-]+:$/` also
    # matches `  ops:` under the top-level networks: key, so the unscoped form
    # counts the project network as a sixth service and can never pass.
    run awk '/^services:/{s=1;next} /^[a-z]/{s=0} s && /^  [a-z-]+:$/ {gsub(/[ :]/,"",$1); print $1}' "$COMPOSE"
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | sort | tr '\n' ' ')" = "alertmanager blackbox cadvisor node-exporter prometheus " ]
}

@test "every ops image is digest-pinned and none is :latest" {
    run awk '/^[[:space:]]+image:/ {print $2}' "$COMPOSE"
    [ "$status" -eq 0 ]
    [ -n "$output" ]
    while read -r ref; do
        [[ "$ref" == *"@sha256:"* ]] || { echo "not digest-pinned: $ref"; return 1; }
        [[ "$ref" =~ @sha256:[0-9a-f]{64}$ ]] || { echo "malformed digest: $ref"; return 1; }
        [[ "$ref" != *":latest@"* ]] || { echo "latest tag: $ref"; return 1; }
    done <<< "$output"
}

@test "no ops port binds a wildcard address" {
    run grep -nE '^[[:space:]]+- "[^"]*:[0-9]+:[0-9]+"' "$COMPOSE"
    [ "$status" -eq 0 ]
    while read -r line; do
        [[ "$line" == *'"${OPS_BIND_IP'* ]] || { echo "port not bound to OPS_BIND_IP: $line"; return 1; }
        [[ "$line" != *'0.0.0.0'* ]] || { echo "wildcard bind: $line"; return 1; }
    done <<< "$output"
}

@test "ops compose carries no name: key and no forbidden compose flag" {
    run grep -nE '^[[:space:]]*name:' "$COMPOSE"
    [ "$status" -ne 0 ]
    run grep -nE 'docker compose .*( -f | -p | --profile )' "$COMPOSE"
    [ "$status" -ne 0 ]
}

# ---------------------------------------------------------------------------
# Alert rules
# ---------------------------------------------------------------------------

@test "alerts.yml declares exactly the eight rules of the spec" {
    [ -f "$ALERTS" ]
    run awk '/^[[:space:]]+- alert:/ {print $3}' "$ALERTS"
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | sort | tr '\n' ' ')" = "BackupOlderThan26h CertExpiresUnder20d ContainerUnhealthy2m DiskAbove70 EdgePort80Down MailQueueOldest1h MemoryPressure PostgresConnections80pct " ]
}

@test "every alert rule is fail-closed on a blind collector" {
    # A rule whose input series simply vanishes must fire, not go quiet: that is
    # the difference between a guard and a guard that lies.
    #
    # Comment lines are skipped first. The file's own header explains the
    # absent() contract in prose; counted, that prose would print an empty rule
    # name and make the "8 distinct rules" assertion pass on 7 real rules plus a
    # comment — the guard matching its own documentation.
    run awk '/^[[:space:]]*#/ {next} /^[[:space:]]+- alert:/{name=$3} /absent\(/{print name}' "$ALERTS"
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | sort -u | wc -l)" -eq 8 ]
}

@test "alert annotations are static — no templating promtool cannot compare" {
    # A "must not contain" grep is vacuously true on a file that is not there.
    [ -f "$ALERTS" ]
    run grep -nE '\{\{' "$ALERTS"
    [ "$status" -ne 0 ]
}

@test "the unverified mail-queue series is labelled as unverified" {
    # MailQueueOldest1h names a Stalwart series nobody has scraped yet. It stays
    # in the file (it is fail-closed, so a wrong name alerts) but it must never
    # read as confirmed. Task 8's S4 spike table owns the confirmation.
    [ -f "$ALERTS" ]
    grep -q '# series name unverified until §L step 7; see S4' "$ALERTS"
}

@test "alerts.test.yml exercises both directions of every rule" {
    [ -f "${OPS_DIR}/alerts.test.yml" ]
    grep -q "rule_files:" "${OPS_DIR}/alerts.test.yml"
    # Comment lines are skipped: the file documents its own key order, and a
    # guard that counts its documentation counts 17 where 16 are expected.
    run awk '/^[[:space:]]*#/ {next} /alertname:/ {print $3}' "${OPS_DIR}/alerts.test.yml"
    [ "$status" -eq 0 ]
    # eight healthy expectations + eight blind expectations
    [ "$(echo "$output" | wc -l)" -eq 16 ]
}

# ---------------------------------------------------------------------------
# Scrape config and probe modules
# ---------------------------------------------------------------------------

@test "prometheus.yml declares every job the rules reference" {
    [ -f "$PROM" ]
    run awk '/job_name:/ {gsub(/[",]/,"",$3); print $3}' "$PROM"
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | sort | tr '\n' ' ')" = "blackbox-acme blackbox-control blackbox-https blackbox-smtp blackbox-smtp25 blackbox-tls cadvisor node prometheus stalwart " ]
}

@test "prometheus.yml takes every probe target from file_sd, never a literal host" {
    grep -q 'file_sd_configs:' "$PROM"
    run grep -nE '(example\.org|203\.0\.113|2001:db8)' "$PROM"
    [ "$status" -ne 0 ]
}

@test "prometheus.yml loads the rules and points at the alertmanager service" {
    grep -q '/etc/prometheus/alerts.yml' "$PROM"
    grep -q 'alertmanager:9093' "$PROM"
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
    # matches the closing pattern "^  [a-z]", so the range is one record long
    # and the body of the module is never printed. Flag, not range.
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
               ALERT_WEBHOOK_URL ALERT_EMAIL_TO ALERT_SMTP_USER ALERT_SMTP_PASSWORD \
               GREMION_ROOT_DIR OPS_BIND_IP OPS_UID OPS_GID PROM_RETENTION_TIME \
               ALERT_EMAIL_FROM STALWART_API_KEY OPS_TENANT_HOSTS_FILE; do
        grep -qE "^${key}=" "$OPS_TMPL" || { echo "ops.env.tmpl is missing ${key}"; return 1; }
    done
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
COMPOSE_FILE=${GREMION_ROOT}/current/infra/host/ops/docker-compose.yml
GREMION_ROOT_DIR=${GREMION_ROOT}
OPS_BIND_IP=127.0.0.1
OPS_UID=$(id -u)
OPS_GID=$(id -g)
OPS_V4_SUBNET=10.90.8.0/24
OPS_V6_SUBNET=fd5a:98::/64
PROM_RETENTION_TIME=30d
PLATFORM_DOMAIN=example.org
EDGE_BIND_IP=203.0.113.10
EDGE_BIND_IP6=2001:db8::a
ALERT_WEBHOOK_URL=http://127.0.0.1:9099/hook
ALERT_EMAIL_TO=${1:-}
ALERT_EMAIL_FROM=alerts@example.org
ALERT_SMTP_USER=alerts@example.org
ALERT_SMTP_PASSWORD=${2:-CHANGE_ME_GEN_alnum32_platform_smtp}
STALWART_API_KEY=CHANGE_ME_GEN_hex32_stalwart_api
OPS_TENANT_HOSTS_FILE=${GREMION_ROOT}/etc/tenant-hosts.txt
EOF
}

@test "render-ops writes every target list from the env file" {
    write_ops_env
    printf 'pilot.example.org\nsecond.example.org\n' > "$GREMION_ROOT/etc/tenant-hosts.txt"
    run "$RENDER" --env-file "$GREMION_ROOT/etc/env/ops.env"
    [ "$status" -eq 0 ]
    # 11 = 3 https (platform + two tenants) + 1 control + 2 acme (v4 and v6)
    #    + 1 smtp + 1 smtp25 + 2 tls + 1 stalwart. Both ACME probes are asserted
    #    individually below, so the total cannot be 10 as the brief's draft said.
    [[ "$output" == *"OPS-RENDER: files=7 targets=11 email=off stalwart-key=unset"* ]]
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
}

@test "render-ops leaves no unsubstituted variable in alertmanager.yml" {
    write_ops_env
    run "$RENDER" --env-file "$GREMION_ROOT/etc/env/ops.env"
    [ "$status" -eq 0 ]
    grep -q "smtp_smarthost: 'mail.example.org:587'" "$GREMION_ROOT/runtime/ops/alertmanager.yml"
    grep -q "url: 'http://127.0.0.1:9099/hook'" "$GREMION_ROOT/runtime/ops/alertmanager.yml"
    grep -q "smtp_auth_password_file: '/etc/alertmanager/smtp-password'" "$GREMION_ROOT/runtime/ops/alertmanager.yml"
    run grep -c '\${' "$GREMION_ROOT/runtime/ops/alertmanager.yml"
    [ "$output" = "0" ]
    # Measured, not theoretical: Git for Windows' /mingw64/bin/envsubst writes
    # CRLF, and amtool rejected the rendered file with "did not find expected
    # '-' indicator". A carriage return lands inside the YAML value.
    run grep -c $'\r' "$GREMION_ROOT/runtime/ops/alertmanager.yml"
    [ "$output" = "0" ]
}

@test "render-ops keeps the smtp password out of alertmanager.yml" {
    write_ops_env "ops@example.org" "s3cret-app-password"
    run "$RENDER" --env-file "$GREMION_ROOT/etc/env/ops.env"
    [ "$status" -eq 0 ]
    [[ "$output" == *"email=on"* ]]
    grep -q "to: 'ops@example.org'" "$GREMION_ROOT/runtime/ops/alertmanager.yml"
    # email_configs is a KEY OF THE RECEIVER, a sibling of webhook_configs: four
    # spaces. At six, amtool refused the file with "did not find expected '-'
    # indicator" and nothing on this box would have noticed without it.
    grep -q '^    email_configs:$' "$GREMION_ROOT/runtime/ops/alertmanager.yml"
    run grep -c 's3cret-app-password' "$GREMION_ROOT/runtime/ops/alertmanager.yml"
    [ "$output" = "0" ]
    [ "$(cat "$GREMION_ROOT/etc/secrets/ops/smtp-password")" = "s3cret-app-password" ]
    if fs_carries_modes "$GREMION_ROOT/etc"; then
        [ "$(stat -c '%a' "$GREMION_ROOT/etc/secrets/ops/smtp-password")" = "600" ]
    else
        skip "filesystem does not carry POSIX modes (asserted on Debian instead)"
    fi
}

@test "render-ops refuses a wildcard bind address" {
    write_ops_env
    sed -i 's|^OPS_BIND_IP=.*|OPS_BIND_IP=0.0.0.0|' "$GREMION_ROOT/etc/env/ops.env"
    run "$RENDER" --env-file "$GREMION_ROOT/etc/env/ops.env"
    [ "$status" -eq 2 ]
    [[ "$output" == *"OPS_BIND_IP must be a concrete address"* ]]
}

@test "render-ops refuses a uid it does not run as" {
    write_ops_env
    sed -i 's|^OPS_UID=.*|OPS_UID=999999|' "$GREMION_ROOT/etc/env/ops.env"
    run "$RENDER" --env-file "$GREMION_ROOT/etc/env/ops.env"
    [ "$status" -eq 2 ]
    [[ "$output" == *"OPS_UID=999999 but this process runs as"* ]]
}

@test "render-ops is BLOCKED when e-mail alerting has no app password" {
    # ALERT_SMTP_PASSWORD is Task 1's key, in the platform_smtp sentinel group
    # shared with mail.env. Before the Stalwart bring-up it legitimately still
    # carries its sentinel, and this is the one place that must say so exactly.
    write_ops_env "ops@example.org" "CHANGE_ME_GEN_alnum32_platform_smtp"
    run "$RENDER" --env-file "$GREMION_ROOT/etc/env/ops.env"
    [ "$status" -eq 3 ]
    [[ "$output" == *"BLOCKED: ALERT_SMTP_PASSWORD not provisioned (Stalwart app password, §I)"* ]]
}

@test "render-ops treats a CHANGE_ME_ recipient as e-mail alerting off" {
    # A freshly rendered ops.env carries ALERT_EMAIL_TO=CHANGE_ME_OPERATOR_...
    # Reading that as a real recipient would render `to: 'CHANGE_ME_...'` or,
    # with the password still a sentinel, block the whole render on a step the
    # operator never asked for. Not configured is not the same as misconfigured.
    write_ops_env "CHANGE_ME_OPERATOR_alert_email_to"
    run "$RENDER" --env-file "$GREMION_ROOT/etc/env/ops.env"
    [ "$status" -eq 0 ]
    [[ "$output" == *"email=off"* ]]
    run grep -c 'CHANGE_ME_' "$GREMION_ROOT/runtime/ops/alertmanager.yml"
    [ "$output" = "0" ]
}

@test "render-ops refuses an option with no value instead of using the default" {
    # "--env-file" as the last argument used to leave ENV_FILE empty and fall
    # back to the default file, which renders something plausible from an env
    # the operator did not name.
    run "$RENDER" --env-file
    [ "$status" -eq 2 ]
    [[ "$output" == *"--env-file requires a value"* ]]
}

@test "render-ops writes the stalwart credential for both sentinel and real key" {
    write_ops_env
    run "$RENDER" --env-file "$GREMION_ROOT/etc/env/ops.env"
    [ "$status" -eq 0 ]
    [[ "$output" == *"stalwart-key=unset"* ]]
    [ -s "$GREMION_ROOT/etc/secrets/ops/stalwart-api-key" ]
    [ "$(cat "$GREMION_ROOT/etc/secrets/ops/stalwart-api-key")" = "unset" ]
    sed -i 's|^STALWART_API_KEY=.*|STALWART_API_KEY=deadbeefdeadbeefdeadbeefdeadbeef|' "$GREMION_ROOT/etc/env/ops.env"
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

# ---------------------------------------------------------------------------
# metrics-textfile.sh
# ---------------------------------------------------------------------------

shim_docker_healthy() {
    shim docker '
case "$*" in
  *"com.docker.compose.service=postgres"*) echo "abc123" ;;
  "exec abc123 psql"*)                     echo "42|100" ;;
  "ps --all"*)
    printf "staging-state-postgres-1\tUp 3 hours (healthy)\nstaging-app-blue-gremion-ui-1\tUp 2 hours (unhealthy)\n" ;;
  *) : ;;
esac
exit 0'
}

@test "metrics-textfile writes the backup age from last-backup.json" {
    shim_docker_healthy
    printf '{"ts":"2026-09-09T02:00:00Z","ok":true,"label":"daily"}\n' > "$GREMION_ROOT/runtime/last-backup.json"
    run "$METRICS"
    [ "$status" -eq 0 ]
    # 2026-09-09T02:00:00Z is 1788919200, not the 1788739200 of the brief's
    # draft (which is 2026-09-06T22:40:00Z — two days out).
    grep -q '^gremion_backup_last_success_timestamp_seconds 1788919200$' "$GREMION_ROOT/runtime/textfile/gremion.prom"
}

@test "metrics-textfile emits nothing for a failed backup, so the rule fires" {
    shim_docker_healthy
    printf '{"ts":"2026-09-09T02:00:00Z","ok":false,"label":"daily"}\n' > "$GREMION_ROOT/runtime/last-backup.json"
    run "$METRICS"
    [ "$status" -eq 0 ]
    run grep -c 'gremion_backup_last_success_timestamp_seconds ' "$GREMION_ROOT/runtime/textfile/gremion.prom"
    [ "$output" = "0" ]
}

@test "metrics-textfile marks an unhealthy container and clears a healthy one" {
    shim_docker_healthy
    run "$METRICS"
    [ "$status" -eq 0 ]
    grep -q 'gremion_container_unhealthy{name="staging-app-blue-gremion-ui-1"} 1' "$GREMION_ROOT/runtime/textfile/gremion.prom"
    grep -q 'gremion_container_unhealthy{name="staging-state-postgres-1"} 0' "$GREMION_ROOT/runtime/textfile/gremion.prom"
}

@test "metrics-textfile reports postgres connections from the state project" {
    shim_docker_healthy
    STACK=staging run "$METRICS"
    [ "$status" -eq 0 ]
    grep -q '^gremion_postgres_connections_used 42$' "$GREMION_ROOT/runtime/textfile/gremion.prom"
    grep -q '^gremion_postgres_connections_max 100$' "$GREMION_ROOT/runtime/textfile/gremion.prom"
    assert_recorded docker "com.docker.compose.project=staging-state"
}

@test "metrics-textfile always stamps its own timestamp last" {
    shim_docker_healthy
    run "$METRICS"
    [ "$status" -eq 0 ]
    run tail -n 1 "$GREMION_ROOT/runtime/textfile/gremion.prom"
    [[ "$output" =~ ^gremion_metrics_textfile_timestamp_seconds\ [0-9]+$ ]]
}

@test "metrics-textfile leaves no partial file behind" {
    shim_docker_healthy
    run "$METRICS"
    [ "$status" -eq 0 ]
    run find "$GREMION_ROOT/runtime/textfile" -name '*.tmp'
    [ -z "$output" ]
}

@test "metrics-textfile refuses a missing runtime directory" {
    shim_docker_healthy
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
