#!/usr/bin/env bash
# ============================================================
# The pooled stack's RUNNING proof (TASK-040; TRD-440, TRD-038, TRD-177,
# TRD-045). The static half is scripts/check-pooled-stack.mjs.
#
#   bash test/host/integration/pooled-stack-proof.sh all        # scratch stack, then teardown
#   bash test/host/integration/pooled-stack-proof.sh <phase>... # one phase per call
#
# Phases, in order (each is its own call so no single step outlives a
# supervisor's time box; state lives in the ledger directory):
#   prepare      env files, scratch root, externals, the proof overlays
#   names        every rendered name is under ${STACK}; state-up refuses without it
#   state-up     the state project (production profile)
#   state-wait   postgres + keycloak healthy, pgbouncer auth staged; records
#                the state snapshot (container IDs, volume CreatedAt)
#   app-up C     migrate one-shot (run --rm) then `up` of app-C
#   app-wait C   app-C healthy, /healthz reports "colour":"C", isolation
#   aux-up       the non-council ops and mail projects
#   limits       HostConfig.Memory and NanoCpus > 0 on every container
#   rss          idle RSS below 80 % of the limit on every container
#   isolation    project classification, network membership
#   probes       TCP probes: positive control from _state, then each non-council net
#   tenant-before / tenant / tenant-after
#                TRD-440: a second tenant adds no container and no project
#   switch       blue -> green: state IDs and volume CreatedAt unchanged
#   cold-state   restart the state tier; the app colour is healthy after it
#   teardown     docker rm -f / network rm / volume rm, by the ${STACK} prefix
#
# Scratch safety (TASK-040 brief §5): STACK=t040-<sha8> names every project,
# network and volume; the env files are unique and gitignored (under
# .scratch/); every host port is 127.0.0.1 and freshly allocated. This script
# NEVER runs `docker compose down`, never prunes, and never touches a
# resource outside the ${STACK} prefix. Teardown removes containers by the
# compose project label, then networks and volumes by name prefix.
#
# On the live host (TASK-038, after the re-init) run ONLY the check phases
# against the real env files, and never prepare/up/teardown:
#   POOLED_STACK=<stack> POOLED_ENV_DIR=/opt/gremion/etc/env POOLED_SCOPE=host \
#     bash test/host/integration/pooled-stack-proof.sh limits rss isolation probes
# POOLED_SCOPE=host classifies EVERY compose project on the host (the R26-1
# sales site included); the scratch default classifies the ${STACK}-* ones.
#
# Every assertion reads a post-condition (docker inspect, docker stats, a TCP
# connect, a database row), never an exit code alone. Zero containers, zero
# probe targets, a failed positive control, an unclassified project or an
# empty ledger file is a FAILURE, never a vacuous pass.
#
# Guard-efficacy runs (a stray unlimited container, a starved Keycloak limit)
# write their RED ledger under their own POOLED_OUT, never over the green
# ledger that records TRD-177/045/440/038. run.log names the phases each run
# executed and its RED verdict.
# ============================================================
set -euo pipefail
export MSYS_NO_PATHCONV=1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
host_path() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }
ROOT_H="$(host_path "$ROOT")"
# git only when the stack name is derived (the shim tests and the live host
# name it, and a bats container cannot read a Windows worktree's .git file).
if [[ -n "${POOLED_STACK:-}" ]]; then STACK="$POOLED_STACK"
else STACK="t040-$(git -C "$ROOT_H" rev-parse --short=8 HEAD)"; fi
SCOPE="${POOLED_SCOPE:-stack}"
IMAGE_TAG_PROOF="${POOLED_IMAGE_TAG:-t040-proof}"
OUT_REL=".scratch/pooled-stack-proof/${STACK}"
OUT="${POOLED_OUT:-${ROOT}/${OUT_REL}}"
ENV_DIR="${POOLED_ENV_DIR:-${OUT}/env}"
SROOT="${OUT}/root"              # the scratch GREMION_ROOT
PROBE_IMAGE="postgres:18-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873"
TENANT_SLUG="${POOLED_TENANT_SLUG:-t040-b}"   # its config is always the t040-b fixture

RED=0
FAILS=0   # a counter, so a phase can tell whether ITS checks failed
ok()   { printf '  ok   %s\n' "$*"; }
# bad() must run in the proof's own shell: inside a command substitution
# ($(...)) or a pipeline it only sets a subshell's RED and the run stays GREEN.
bad()  { printf '  FAIL %s\n' "$*" >&2; RED=1; FAILS=$(( FAILS + 1 )); }
die()  { printf 'FATAL: %s\n' "$*" >&2; exit 2; }
info() { printf '[pooled-proof] %s\n' "$*"; }
now()  { date -u +%Y-%m-%dT%H:%M:%SZ; }
ledger() { # <file> -- appends stdin to the dated ledger file
    mkdir -p "$OUT/ledger"
    cat >> "$OUT/ledger/$1"
}

command -v docker >/dev/null || die "docker not on PATH"
command -v jq >/dev/null || die "jq not on PATH"

is_scratch() { [[ "$STACK" == t040-* ]]; }
require_scratch() { is_scratch || die "phase '$1' brings resources up or down and runs only on a t040-* scratch stack (STACK=$STACK)"; }

# compose <project-suffix> <args...> -- the host's own command shape:
# `docker compose --env-file <project>.env <verb>` from the project's directory.
compose() {
    local p="$1"; shift
    local dir="$ROOT"
    case "$p" in ops) dir="$ROOT/infra/host/ops" ;; mail) dir="$ROOT/infra/host/mail" ;; esac
    ( cd "$dir" && docker compose --env-file "$(host_path "$ENV_DIR/${p}.env")" "$@" )
}

# Every container of this stack's five projects, by the compose label.
stack_containers() {
    local p
    for p in state app-blue app-green ops mail; do
        docker ps -q --filter "label=com.docker.compose.project=${STACK}-${p}"
    done | sed '/^$/d'
}

free_port() {
    local c
    for _ in $(seq 1 200); do
        c=$(( 20000 + RANDOM % 10000 ))
        if ! (exec 3<>"/dev/tcp/127.0.0.1/$c") 2>/dev/null \
           && ! docker ps --format '{{.Ports}}' | grep -q ":$c->"; then
            printf '%s' "$c"; return 0
        fi
    done
    die "no free port in 20000-29999"
}
gen() { od -An -N16 -tx1 /dev/urandom | tr -d ' \n'; }

wait_health() { # <container id> <seconds>
    local cid="$1" max="$2" s=0 h
    while (( s < max )); do
        h="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || echo gone)"
        [[ "$h" == healthy ]] && return 0
        [[ "$h" == gone || "$h" == exited || "$h" == dead ]] && return 1
        sleep 3; s=$(( s + 3 ))
    done
    return 1
}
svc_cid() { # <project suffix> <service>
    docker ps -q --filter "label=com.docker.compose.project=${STACK}-$1" --filter "label=com.docker.compose.service=$2" | head -n1
}

# The app images run as uid 1000 (node); a fresh external volume is root-owned.
chmod_app_volumes() {
    docker run --rm --name "${STACK}-chown" -v "${STACK}_config_data:/c" -v "${STACK}_tenant_config_data:/d"         --entrypoint sh "$PROBE_IMAGE" -c 'chown -R 1000:1000 /c /d'
}

# ── prepare ────────────────────────────────────────────────────────────────
phase_prepare() {
    require_scratch prepare
    mkdir -p "$ENV_DIR" "$SROOT/etc/edge" "$SROOT/secrets/tenants" "$OUT/ledger"
    local SROOT_H; SROOT_H="$(host_path "$SROOT")"

    # Subnets: a dedicated 10.231.0.0/16 and fd5a:231::/48, refused if taken.
    local taken
    # shellcheck disable=SC2046  # one argument per network id, on purpose
    taken="$(docker network inspect $(docker network ls -q) --format '{{.Name}} {{range .IPAM.Config}}{{.Subnet}} {{end}}' 2>/dev/null | grep -E ' 10\.231\.' | grep -v "^${STACK}" || true)"
    [[ -z "$taken" ]] || die "10.231.0.0/16 already in use on this engine: $taken"

    local pw_pg pw_kcdb pw_kc pw_gr pw_ctl pw_pub pw_bnc sec_proxy sec_auth sec_push
    pw_pg="$(gen)"; pw_kcdb="$(gen)"; pw_kc="$(gen)"; pw_gr="$(gen)"; pw_ctl="$(gen)"; pw_pub="$(gen)"
    pw_bnc="$(gen)"; sec_proxy="$(gen)"; sec_auth="$(gen)"; sec_push="$(gen)"
    local p_http p_https p_api p_it
    p_http="$(free_port)"; p_https="$(free_port)"; p_api="$(free_port)"; p_it="$(free_port)"

    cat > "$ENV_DIR/state.env" <<EOF
COMPOSE_PROJECT_NAME=${STACK}-state
COMPOSE_FILE=docker-compose.yml:docker-compose.prod.yml:test/host/fixtures/pooled-stack/docker-compose.pins.yml:${OUT_REL}/state.proof.yml
COMPOSE_PATH_SEPARATOR=:
COMPOSE_PROFILES=production
STACK=${STACK}
GREMION_ROOT=${SROOT_H}
PLATFORM_DOMAIN=proof.example.org
DOMAIN=proof.example.org
IMAGE_TAG=${IMAGE_TAG_PROOF}
EDGE_BIND_IP=127.0.0.1
EDGE_BIND_IP6=::1
EDGE_HTTP_PORT=${p_http}
EDGE_HTTPS_PORT=${p_https}
TRAEFIK_API_PORT=${p_api}
INTERNALTEST_PORT=${p_it}
EDGE_V4_SUBNET=10.231.0.0/24
EDGE_V6_SUBNET=fd5a:231:0::/64
STATE_V4_SUBNET=10.231.1.0/24
STATE_V6_SUBNET=fd5a:231:1::/64
ACME_EMAIL=acme@proof.example.org
ACME_CA_SERVER=https://127.0.0.1:1/directory
TRAEFIK_CERT_RESOLVER=le-http
POSTGRES_USER=postgres
POSTGRES_PASSWORD=${pw_pg}
KEYCLOAK_DB_PASSWORD=${pw_kcdb}
KEYCLOAK_ADMIN=admin
KEYCLOAK_ADMIN_PASSWORD=${pw_kc}
GREMION_DB_PASSWORD=${pw_gr}
CONTROL_DB_PASSWORD=${pw_ctl}
PUBLIC_DB_PASSWORD=${pw_pub}
PGBOUNCER_AUTH_PASSWORD=${pw_bnc}
TENANT_PROXY_SHARED_SECRET=${sec_proxy}
EOF
    local c v4 v6 n=2
    for c in blue green; do
        v4="10.231.${n}.0/24"; v6="fd5a:231:${n}::/64"; n=$(( n + 1 ))
        cat > "$ENV_DIR/app-${c}.env" <<EOF
STACK=${STACK}
COLOUR=${c}
COMPOSE_PROJECT_NAME=${STACK}-app-${c}
COMPOSE_FILE=docker-compose.app.yml:test/host/fixtures/pooled-stack/docker-compose.pins.yml
COMPOSE_PATH_SEPARATOR=:
COMPOSE_PROFILES=production
APP_V4_SUBNET=${v4}
APP_V6_SUBNET=${v6}
PLATFORM_DOMAIN=proof.example.org
IMAGE_TAG=${IMAGE_TAG_PROOF}
GREMION_DB_PASSWORD=${pw_gr}
CONTROL_DB_PASSWORD=${pw_ctl}
PUBLIC_DB_PASSWORD=${pw_pub}
AUTH_SECRET=${sec_auth}
AUTH_KEYCLOAK_SECRET=$(gen)
KEYCLOAK_ADMIN_CLIENT_SECRET=$(gen)
INTERNAL_PUSH_SECRET=${sec_push}
TENANT_PROXY_SHARED_SECRET=${sec_proxy}
TENANT_SECRETS_DIR=${SROOT_H}/secrets/tenants
# not yet in app.env.tmpl (TASK-028 wait): migrate and gremion-ui need it
AUTH_KEYCLOAK_ISSUER=https://proof.example.org/auth/realms/gremion
EOF
    done
    cat > "$ENV_DIR/ops.env" <<EOF
STACK=${STACK}
COMPOSE_PROJECT_NAME=${STACK}-ops
COMPOSE_FILE=docker-compose.yml:../../../${OUT_REL}/ops.proof.yml
COMPOSE_PATH_SEPARATOR=:
COMPOSE_PROFILES=production
OPS_V4_SUBNET=10.231.8.0/24
OPS_V6_SUBNET=fd5a:231:8::/64
GREMION_ROOT_DIR=${SROOT_H}
OPS_BIND_IP=127.0.0.1
OPS_UID=65534
OPS_GID=65534
PROM_RETENTION_TIME=1d
EOF
    cat > "$ENV_DIR/mail.env" <<EOF
STACK=${STACK}
GREMION_ROOT=${SROOT_H}
COMPOSE_PROJECT_NAME=${STACK}-mail
COMPOSE_FILE=docker-compose.yml:../../../${OUT_REL}/mail.proof.yml
COMPOSE_PATH_SEPARATOR=:
COMPOSE_PROFILES=mail
PLATFORM_DOMAIN=proof.example.org
MAIL_BIND_IP=127.0.0.1
MAIL_BIND_IP6=::1
MAIL_V4_SUBNET=10.231.9.0/24
MAIL_V6_SUBNET=fd5a:231:9::/64
MAIL_LOG_RETENTION_DAYS=2
STALWART_IMAGE=stalwartlabs/stalwart:v0.16.21
EOF

    # The proof overlays: loopback-only, freshly allocated host ports (the
    # host's edge/mail binds and ops' fixed ports would collide on a dev box).
    # They change ports only -- never a network, a volume, a limit or a
    # service -- and publish NOTHING on a ${STACK}_state service: measured on
    # Docker 29, a published postgres answered from the ops network.
    cat > "$OUT/state.proof.yml" <<'EOF'
services:
  traefik:
    ports: !override
      - "127.0.0.1:${EDGE_HTTP_PORT}:80"
      - "127.0.0.1:${EDGE_HTTPS_PORT}:443"
      - "127.0.0.1:${TRAEFIK_API_PORT}:8080"
      - "127.0.0.1:${INTERNALTEST_PORT}:8081"
  legal:
    ports: !reset []
EOF
    cat > "$OUT/ops.proof.yml" <<'EOF'
services:
  prometheus:
    ports: !reset []
  alertmanager:
    ports: !reset []
EOF
    cat > "$OUT/mail.proof.yml" <<'EOF'
services:
  stalwart:
    ports: !reset []
EOF

    # Files the renders bind-mount (all gitignored or under the scratch root).
    [[ -f "$ROOT/legal/legal.env" ]] || { mkdir -p "$ROOT/legal"; cp "$ROOT/legal/legal.env.example" "$ROOT/legal/legal.env"; }
    [[ -f "$ROOT/secrets/ipcrypt_key.txt" ]] || { gen > "$ROOT/secrets/ipcrypt_key.txt"; touch "$OUT/.created-ipcrypt"; }
    [[ -f "$ROOT/docker/keycloak/certs/keycloak.crt" ]] || bash "$ROOT/docker/keycloak/certs/gen-internal-ca.sh" >/dev/null
    [[ -f "$ROOT/docker/keycloak/certs/internal-ca.pem" ]] || cp "$ROOT/docker/keycloak/certs/internal-ca.crt" "$ROOT/docker/keycloak/certs/internal-ca.pem"
    if [[ ! -f "$ROOT/docker/pgbouncer/userlist.txt" ]]; then
        printf '"pgbouncer_auth" "%s"\n' "$pw_bnc" > "$ROOT/docker/pgbouncer/userlist.txt"
        touch "$OUT/.created-userlist"
    else
        # reuse: the auth password is whatever the existing userlist carries
        sed -i "s/^PGBOUNCER_AUTH_PASSWORD=.*/PGBOUNCER_AUTH_PASSWORD=$(sed -n 's/^"pgbouncer_auth" "\(.*\)"$/\1/p' "$ROOT/docker/pgbouncer/userlist.txt")/" "$ENV_DIR/state.env"
    fi
    # ops: the files render-ops.sh would place under the release tree
    mkdir -p "$SROOT/current/infra/host/ops" "$SROOT/runtime/ops/targets" "$SROOT/runtime/ops/prometheus-data" \
             "$SROOT/runtime/ops/alertmanager-data" "$SROOT/runtime/textfile" "$SROOT/etc/secrets/ops" \
             "$SROOT/etc/mail" "$SROOT/etc/secrets/mail"
    cp "$ROOT/infra/host/ops/prometheus.yml" "$ROOT/infra/host/ops/alerts.yml" "$ROOT/infra/host/ops/blackbox.yml" "$SROOT/current/infra/host/ops/"
    gen > "$SROOT/etc/secrets/ops/stalwart-api-key"; gen > "$SROOT/etc/secrets/ops/smtp-password"
    PLATFORM_DOMAIN=proof.example.org ALERT_EMAIL_FROM=alerts@proof.example.org ALERT_SMTP_USER=alerts \
        ALERT_WEBHOOK_URL=http://127.0.0.1:9/none \
        envsubst '${PLATFORM_DOMAIN} ${ALERT_EMAIL_FROM} ${ALERT_SMTP_USER} ${ALERT_WEBHOOK_URL}' \
        < "$ROOT/infra/host/ops/alertmanager.yml.tmpl" | tr -d '\r' > "$SROOT/runtime/ops/alertmanager.yml"
    chmod -R a+rwX "$SROOT/runtime" 2>/dev/null || true
    PLATFORM_DOMAIN=proof.example.org ACME_EMAIL=acme@proof.example.org DKIM_SELECTOR_A=a DKIM_SELECTOR_B=b \
        MAIL_HOSTNAME=mail.proof.example.org MAIL_LOG_RETENTION_DAYS=2 MAIL_RATE_LIMIT_RCPT=10 \
        STALWART_ADMIN_USER=admin STALWART_ADMIN_PASSWORD="$(gen)" \
        envsubst < "$ROOT/infra/host/mail/config.toml.tmpl" | tr -d '\r' > "$SROOT/etc/mail/config.toml"

    # The stack-scoped externals (bootstrap.sh stage_networks' set).
    docker network inspect "${STACK}_edge" >/dev/null 2>&1 \
        || docker network create --ipv6 --subnet 10.231.0.0/24 --subnet fd5a:231:0::/64 "${STACK}_edge" >/dev/null
    docker network inspect "${STACK}_state" >/dev/null 2>&1 \
        || docker network create --ipv6 --subnet 10.231.1.0/24 --subnet fd5a:231:1::/64 "${STACK}_state" >/dev/null
    info "externals: networks ready"
    local vol
    for vol in traefik_acme config_data tenant_config_data tenant_secrets mail_data; do
        docker volume inspect "${STACK}_${vol}" >/dev/null 2>&1 || docker volume create "${STACK}_${vol}" >/dev/null
    done
    info "externals: volumes ready"
    # The default tenant's config (CONFIG_PATH on the external config volume).
    # A real host carries the operator's; migrate's fleet refuses a config
    # without a brand identity (assertBrandIdentityComplete).
    printf '%s' '{"brand":{"product":"Gremion","org_short":"T040"},"deployment":{"mode":"multi"}}'         | docker run --rm -i --name "${STACK}-seed-config" -v "${STACK}_config_data:/c" --entrypoint sh "$PROBE_IMAGE"             -c 'cat > /c/config.json && chmod 666 /c/config.json'
    chmod_app_volumes

    ok "prepared ${STACK}: env files, externals, overlays (run the names phase before any up)"
    printf '%s prepared %s\n' "$(now)" "$STACK" | ledger run.log
}

# Names on `config` BEFORE any `up`: every rendered network and volume is
# under ${STACK}, and every project is ${STACK}-<suffix>.
phase_names() {
    local p names
    for p in state app-blue app-green ops mail; do
        names="$(COMPOSE_PROFILES='*' compose "$p" config --format json 2>/dev/null \
                 | jq -r '.name, (.networks // {} | to_entries[] | (.value.name // .key)), (.volumes // {} | to_entries[] | (.value.name // .key))')"
        [[ -n "$names" ]] || die "$p renders nothing"
        while IFS= read -r n; do
            [[ "$n" == "${STACK}"* || "$n" == "default" ]] || die "$p renders a name outside ${STACK}: $n"
        done <<< "$names"
    done
    ok "names: every rendered project, network and volume of the five projects is under ${STACK}"
    : > "$OUT/.names-ok"
}

# ── state ──────────────────────────────────────────────────────────────────
phase_state_up() {
    require_scratch state-up
    [[ -f "$OUT/.names-ok" ]] || die "run the names phase first: no up before every rendered name is asserted"
    compose state up -d --pull never >/dev/null
    ok "state project up ($(docker ps -q --filter "label=com.docker.compose.project=${STACK}-state" | grep -c .) container(s))"
}

phase_state_wait() {
    local cid s
    for s in postgres keycloak; do
        cid="$(svc_cid state "$s")"; [[ -n "$cid" ]] || die "state/$s has no container"
        wait_health "$cid" 200 || die "state/$s did not become healthy"
    done
    # pgbouncer's auth_query role (docs/runbooks/pgbouncer.md), per database.
    # shellcheck disable=SC1090
    . "$ENV_DIR/state.env"
    cid="$(svc_cid state postgres)"
    docker exec -i "$cid" psql -v ON_ERROR_STOP=1 -qU postgres -d postgres >/dev/null <<EOF
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'pgbouncer_auth') THEN
    CREATE ROLE pgbouncer_auth LOGIN PASSWORD '${PGBOUNCER_AUTH_PASSWORD}';
  END IF;
END \$\$;
EOF
    local db
    for db in postgres gremion control; do
        docker exec -i "$cid" psql -v ON_ERROR_STOP=1 -qU postgres -d "$db" >/dev/null < "$ROOT/docker/pgbouncer/pgbouncer-auth.sql"
    done
    # TRD-038 baseline: the state tier's container IDs and volume CreatedAt.
    { docker ps -q --no-trunc --filter "label=com.docker.compose.project=${STACK}-state" | sort
      docker volume ls -q --filter "name=^${STACK}" | sort | while read -r v; do
          printf '%s %s\n' "$v" "$(docker volume inspect -f '{{.CreatedAt}}' "$v")"; done
    } > "$OUT/state-snapshot.txt"
    [[ -s "$OUT/state-snapshot.txt" ]] || die "empty state snapshot"
    ok "state healthy; snapshot of $(grep -c . "$OUT/state-snapshot.txt") state ID/volume line(s) taken"
}

# ── app colours ────────────────────────────────────────────────────────────
phase_app_up() {
    require_scratch app-up
    local c="$1"
    compose "app-$c" run --rm --pull never migrate > "$OUT/ledger/migrate-$c.log" 2>&1 \
        || { tail -20 "$OUT/ledger/migrate-$c.log" >&2; die "migrate failed on app-$c"; }
    local left
    left="$(docker ps -aq --filter "label=com.docker.compose.project=${STACK}-app-$c" --filter "label=com.docker.compose.service=migrate" | grep -c . || true)"
    [[ "$left" == 0 ]] || bad "migrate left $left container(s) behind (--rm)"
    compose "app-$c" up -d --pull never >/dev/null
    ok "app-$c: migrate ran and left nothing; up"
}

# The same checks gremion-deploy's assert_stack_isolation makes, on the real
# containers: mounts and networks under ${STACK}, and the <svc>-<colour>
# alias on both shared networks. Call it directly, never as $(...): its bad()
# calls must reach the proof's RED. The container count lands in ISO_SEEN.
ISO_SEEN=0
isolation_of_colour() {
    local c="$1" cid name mounts nets svc eps n al t seen=0
    local allowed=" ${STACK}_edge ${STACK}_state ${STACK}-app-${c}_app "
    for cid in $(docker ps -q --filter "label=com.docker.compose.project=${STACK}-app-$c"); do
        seen=$(( seen + 1 ))
        name="$(docker inspect -f '{{.Name}}' "$cid")"
        mounts="$(docker inspect -f '{{range .Mounts}}{{.Name}} {{end}}' "$cid")"
        for n in $mounts; do
            [[ "$n" == "${STACK}"_* || "$n" == "${STACK}-app-${c}"_* ]] || bad "$name mounts foreign volume $n"
        done
        nets="$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$cid")"
        svc="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$cid")"
        eps="$(docker inspect -f '{{range $net, $ep := .NetworkSettings.Networks}}{{$net}}={{range $ep.Aliases}}{{.}},{{end}} {{end}}' "$cid")"
        for n in $nets; do
            [[ "$allowed" == *" $n "* ]] || bad "$name on foreign network $n"
            [[ "$n" == "${STACK}_edge" || "$n" == "${STACK}_state" ]] || continue
            al=""; for t in $eps; do [[ "$t" == "${n}="* ]] && al="${t#*=}"; done
            [[ ",$al" == *",${svc}-${c},"* ]] || bad "$name on $n carries no ${svc}-${c} alias (has: $al)"
        done
    done
    (( seen > 0 )) || bad "app-$c runs no container"
    ISO_SEEN="$seen"
}

phase_app_wait() {
    local c="$1" s cid body
    for s in gremion-ui gremion-public; do
        cid="$(svc_cid "app-$c" "$s")"; [[ -n "$cid" ]] || { bad "app-$c/$s has no container"; continue; }
        wait_health "$cid" 180 || { bad "app-$c/$s did not become healthy"; docker logs --tail 30 "$cid" >&2 || true; }
    done
    cid="$(svc_cid "app-$c" gremion-ui)"
    body="$(docker exec "$cid" wget -qO- http://127.0.0.1:3000/healthz 2>/dev/null || true)"
    printf '%s app-%s gremion-ui /healthz %s\n' "$(now)" "$c" "$body" | ledger healthz.log
    [[ "$body" == *"\"colour\":\"$c\""* ]] && ok "app-$c gremion-ui /healthz reports colour $c" \
        || bad "app-$c gremion-ui /healthz does not report colour $c: $body"
    local before="$FAILS"
    isolation_of_colour "$c"
    (( FAILS == before )) \
        && ok "app-$c: $ISO_SEEN container(s), every mount/network under ${STACK}, every shared-network alias <svc>-$c" \
        || bad "app-$c: isolation of $ISO_SEEN container(s) failed (see above)"
}

# ── the non-council projects ───────────────────────────────────────────────
phase_aux_up() {
    require_scratch aux-up
    compose ops up -d --pull never >/dev/null 2>"$OUT/ledger/ops-up.err" || { cat "$OUT/ledger/ops-up.err" >&2; bad "ops up failed"; }
    compose mail up -d --pull never >/dev/null 2>"$OUT/ledger/mail-up.err" || { cat "$OUT/ledger/mail-up.err" >&2; bad "mail up failed"; }
    sleep 20
    local p cid st
    for p in ops mail; do
        for cid in $(docker ps -aq --filter "label=com.docker.compose.project=${STACK}-$p"); do
            st="$(docker inspect -f '{{.Name}} {{.State.Status}} restarts={{.RestartCount}}' "$cid")"
            printf '%s %s %s\n' "$(now)" "$p" "$st" | ledger aux.log
            [[ "$st" == *" running restarts=0" ]] || bad "$p container not steadily running: $st"
        done
    done
    ok "ops ($(docker ps -q --filter "label=com.docker.compose.project=${STACK}-ops" | grep -c .)) and mail ($(docker ps -q --filter "label=com.docker.compose.project=${STACK}-mail" | grep -c .)) running"
}

# ── TRD-177 ────────────────────────────────────────────────────────────────
phase_limits() {
    local cid n=0 line mem cpu name
    : > "$OUT/ledger/limits.tsv"
    printf 'container\tmemory_bytes\tnano_cpus\n' >> "$OUT/ledger/limits.tsv"
    while IFS= read -r cid; do
        [[ -n "$cid" ]] || continue
        n=$(( n + 1 ))
        line="$(docker inspect -f '{{.Name}} {{.HostConfig.Memory}} {{.HostConfig.NanoCpus}}' "$cid")"
        read -r name mem cpu <<< "$line"
        printf '%s\t%s\t%s\n' "${name#/}" "$mem" "$cpu" >> "$OUT/ledger/limits.tsv"
        [[ "$mem" =~ ^[0-9]+$ && "$mem" -gt 0 ]] || bad "${name#/}: HostConfig.Memory=$mem (no memory limit)"
        [[ "$cpu" =~ ^[0-9]+$ && "$cpu" -gt 0 ]] || bad "${name#/}: HostConfig.NanoCpus=$cpu (no CPU limit)"
    done < <(limit_scope_containers)
    (( n > 0 )) || { bad "limits: zero containers inspected -- refusing a vacuous pass"; return; }
    ok "limits: $n container(s) inspected (ledger/limits.tsv)"
}
# Scratch: every container whose compose project starts with ${STACK}- (so a
# stray ${STACK}-unlimited project is caught too). Host: every container.
limit_scope_containers() {
    if [[ "$SCOPE" == host ]]; then docker ps -q
    else docker ps --format '{{.ID}} {{.Label "com.docker.compose.project"}}' | awk -v p="${STACK}-" 'index($2, p) == 1 {print $1}'
    fi
}

phase_rss() {
    local want names stats rows n over
    # One `docker stats` over every running container, filtered by name, and
    # ONE awk for the arithmetic: measured on a loaded Docker Desktop host, a
    # stats call naming 16 containers stalls, and a per-row subshell pipeline
    # costs seconds per row.
    names="$(limit_scope_containers | xargs -r docker inspect -f '{{.Name}}' | sed 's#^/##' | tr -d '\r')"
    want="$(printf '%s\n' "$names" | grep -c . || true)"
    (( want > 0 )) || { bad "rss: zero containers"; return; }
    stats="$(docker stats --no-stream --format '{{.Name}}|{{.MemUsage}}' | tr -d '\r')"
    rows="$(awk -F'|' -v names="$names" '
        function bytes(s,   n, u, m) { gsub(/ /, "", s); n = s; sub(/[A-Za-z]+$/, "", n); u = s; sub(/^[0-9.]+/, "", u)
            m = 1; if (u == "KiB") m = 1024; else if (u == "MiB") m = 1048576; else if (u == "GiB") m = 1073741824
            else if (u == "kB") m = 1000; else if (u == "MB") m = 1000000; else if (u == "GB") m = 1000000000
            return n * m }
        BEGIN { k = split(names, a, "\n"); for (i = 1; i <= k; i++) if (a[i] != "") want[a[i]] = 1 }
        ($1 in want) { split($2, p, " / "); u = bytes(p[1]); l = bytes(p[2])
            pct = (l > 0) ? int(u * 100 / l) : -1
            printf "%s\t%s\t%s\t%d\n", $1, p[1], p[2], pct }' <<< "$stats")"
    { printf 'container\tusage\tlimit\tpercent_of_limit\n'; printf '%s\n' "$rows"; } > "$OUT/ledger/rss.tsv"
    n="$(printf '%s\n' "$rows" | grep -c . || true)"
    over="$(printf '%s\n' "$rows" | awk -F'\t' 'NF == 4 && ($4 < 0 || $4 >= 80) {print $1 " at " $4 "% of " $3}')"
    [[ -z "$over" ]] || bad "rss: idle RSS at or above 80 % of the limit (or no limit): $(printf '%s' "$over" | tr '\n' ';')"
    (( n == want )) || bad "rss: measured $n of $want container(s)"
    (( n > 0 )) || { bad "rss: docker stats returned nothing"; return; }
    ok "rss: $n of $want container(s) measured (ledger/rss.tsv)"
}

# ── TRD-045 ────────────────────────────────────────────────────────────────
# The listening port of each service that may sit on ${STACK}_state.
state_port() {
    case "$1" in
        postgres|*-postgres) echo 5432 ;;
        pgbouncer) echo 6432 ;;
        keycloak) echo 8080 ;;
        gremion-ui|gremion-public) echo 3000 ;;
        mailpit) echo 1025 ;;
        *) echo "" ;;
    esac
}
is_ipv4() { [[ "$1" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; }
# probe_all <network> <targets file> -- ONE probe container on <network>
# connects to every "svc ip port" line and prints "svc ip:port OPEN|CLOSED".
# A target MUST be an IP literal: a service name would not resolve from a
# foreign network, and the negative probe would pass for the wrong reason.
probe_all() {
    local net="$1" file="$2" svc ip port script=""
    while read -r svc ip port; do
        [[ -n "$svc" ]] || continue
        is_ipv4 "$ip" || { bad "probe target '$ip' ($svc) is not an IP literal (a name-based probe proves nothing)"; return 2; }
        [[ "$port" =~ ^[0-9]+$ ]] || { bad "probe target $svc has no numeric port"; return 2; }
        script+="if nc -w 3 $ip $port </dev/null >/dev/null 2>&1; then echo '$svc $ip:$port OPEN'; else echo '$svc $ip:$port CLOSED'; fi; "
    done < "$file"
    [[ -n "$script" ]] || { bad "probe: empty target list"; return 2; }
    docker run --rm --name "${STACK}-probe-$RANDOM" --network "$net" --entrypoint sh "$PROBE_IMAGE" -c "$script" | tr -d '\r'
}
phase_isolation() {
    local stamp; stamp="$(now)"
    : > "$OUT/ledger/isolation.txt"
    printf '# TRD-045 isolation proof, %s, STACK=%s, scope=%s\n' "$stamp" "$STACK" "$SCOPE" >> "$OUT/ledger/isolation.txt"
    # 1. every compose project, enumerated by label, is classified
    local projects p nonc=() council=" ${STACK}-state ${STACK}-app-blue ${STACK}-app-green "
    projects="$(docker ps -a --format '{{.Label "com.docker.compose.project"}}' | tr -d '\r' | sed '/^$/d' | sort -u)"
    [[ "$SCOPE" == host ]] || projects="$(printf '%s\n' "$projects" | awk -v p="${STACK}-" 'index($0, p) == 1')"
    [[ -n "$projects" ]] || { bad "isolation: no compose project found"; return; }
    while IFS= read -r p; do
        if [[ "$council" == *" $p "* ]]; then printf 'project %s council\n' "$p" >> "$OUT/ledger/isolation.txt"
        elif [[ "$p" == "${STACK}-ops" || "$p" == "${STACK}-mail" || "$SCOPE" == host ]]; then
            nonc+=("$p"); printf 'project %s non-council\n' "$p" >> "$OUT/ledger/isolation.txt"
        else bad "project $p is not classified (placement table: state, app-blue, app-green council; ops, mail non-council)"; fi
    done <<< "$projects"
    (( ${#nonc[@]} > 0 )) || bad "isolation: no non-council project is running -- nothing to prove"
    # 2. no non-council network shares a container with ${STACK}_state
    local statemembers net nets=() m
    statemembers=" $(docker network inspect "${STACK}_state" -f '{{range $id, $c := .Containers}}{{$id}} {{end}}') "
    for p in "${nonc[@]}"; do
        for net in $(docker ps -q --filter "label=com.docker.compose.project=$p" | xargs -r docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' | tr ' ' '\n' | sed '/^$/d' | sort -u); do
            [[ "$net" == "${STACK}_state" ]] && { bad "$p is ON ${STACK}_state"; continue; }
            nets+=("$net")
            for m in $(docker network inspect "$net" -f '{{range $id, $c := .Containers}}{{$id}} {{end}}'); do
                [[ "$statemembers" == *" $m "* ]] && bad "network $net ($p) shares container ${m:0:12} with ${STACK}_state"
            done
            printf 'network %s (%s): no shared member with %s_state\n' "$net" "$p" "$STACK" >> "$OUT/ledger/isolation.txt"
        done
    done
    (( ${#nets[@]} > 0 )) || bad "isolation: the non-council projects are on no network"
    printf '%s\n' "${nets[@]}" > "$OUT/noncouncil-nets.txt"
    ok "isolation: ${#nonc[@]} non-council project(s) on ${#nets[@]} network(s), none sharing a member with ${STACK}_state (ledger/isolation.txt)"
}

# The TCP half of TRD-045, its own phase so each stays inside a time box.
phase_probes() {
    local nets=() net cid svc ip port
    [[ -s "$OUT/noncouncil-nets.txt" ]] || die "run the isolation phase first (no non-council network list)"
    mapfile -t nets < <(sed '/^$/d' "$OUT/noncouncil-nets.txt")
    printf '# TRD-045 probes, %s, STACK=%s\n' "$(now)" "$STACK" >> "$OUT/ledger/isolation.txt"
    # 3. TCP probes: positive control from _state, then every non-council network
    local targets=()
    for cid in $(docker network inspect "${STACK}_state" -f '{{range $id, $c := .Containers}}{{$id}} {{end}}'); do
        svc="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$cid" 2>/dev/null || true)"
        [[ -n "$svc" ]] || continue   # a probe container of this run
        ip="$(docker network inspect "${STACK}_state" -f "{{with index .Containers \"$cid\"}}{{.IPv4Address}}{{end}}")"; ip="${ip%%/*}"
        port="$(state_port "$svc")"
        [[ -n "$port" ]] || { bad "state-network container $svc has no known listening port (unclassified target)"; continue; }
        targets+=("$svc $ip $port")
    done
    (( ${#targets[@]} > 0 )) || { bad "isolation: the target list is empty"; return; }
    local pubs
    for cid in $(docker network inspect "${STACK}_state" -f '{{range $id, $c := .Containers}}{{$id}} {{end}}'); do
        pubs="$(docker inspect -f '{{range $p, $b := .NetworkSettings.Ports}}{{range $b}}{{.HostIp}}:{{.HostPort}}->{{$p}} {{end}}{{end}}' "$cid" 2>/dev/null || true)"
        [[ -z "${pubs// /}" ]] || bad "state-network container ${cid:0:12} publishes host port(s) $pubs -- a route from every other bridge network"
    done
    printf '%s\n' "${targets[@]}" > "$OUT/ledger/probe-targets.txt"
    local res line open closed
    # positive control: every target answers from ${STACK}_state
    res="$(probe_all "${STACK}_state" "$OUT/ledger/probe-targets.txt")" || { bad "positive control could not run"; return; }
    printf '%s\n' "$res" | sed "s/^/positive ${STACK}_state -> /" >> "$OUT/ledger/isolation.txt"
    open="$(printf '%s\n' "$res" | grep -c ' OPEN$' || true)"
    [[ "$open" == "${#targets[@]}" ]] || bad "positive control: only $open of ${#targets[@]} target(s) connected from ${STACK}_state (the probe cannot tell open from closed): $(printf '%s' "$res" | grep ' CLOSED$' | tr '\n' ';')"
    # negative: no target answers from any non-council network
    for net in "${nets[@]}"; do
        res="$(probe_all "$net" "$OUT/ledger/probe-targets.txt")" || { bad "negative probe on $net could not run"; continue; }
        printf '%s\n' "$res" | sed "s/^/negative $net -> /" >> "$OUT/ledger/isolation.txt"
        closed="$(printf '%s\n' "$res" | grep -c ' CLOSED$' || true)"
        [[ "$closed" == "${#targets[@]}" ]] || bad "non-council network $net REACHES: $(printf '%s' "$res" | grep ' OPEN$' | tr '\n' ';')"
    done
    [[ -s "$OUT/ledger/isolation.txt" ]] || bad "probes: empty ledger"
    ok "probes: ${#targets[@]} target(s), positive control from ${STACK}_state, ${#nets[@]} non-council network(s) (ledger/isolation.txt)"
}

# ── TRD-440 ────────────────────────────────────────────────────────────────
counts() {
    local p
    for p in state app-blue app-green ops mail; do
        printf '%s services=%s running=%s\n' "$p" \
            "$(compose "$p" config --services 2>/dev/null | grep -c .)" \
            "$(docker ps -q --filter "label=com.docker.compose.project=${STACK}-$p" | grep -c .)"
    done
    printf 'compose-ls %s\n' "$(docker compose ls -a --format json | jq -r --arg p "${STACK}-" '[.[] | select(.Name | startswith($p)) | .Name] | sort | join(",")')"
    # Stack-scoped: every container whose compose project or name carries the
    # ${STACK} prefix (the whole engine's count moves with unrelated work).
    printf 'stack-containers %s\n' "$(docker ps -a --format '{{.Names}} {{.Label "com.docker.compose.project"}}' | tr -d '\r' | awk -v p="${STACK}" 'index($1, p) == 1 || index($2, p) == 1' | grep -c .)"
}
phase_tenant() {
    require_scratch tenant
    # shellcheck disable=SC1090
    . "$ENV_DIR/state.env"
    [[ -s "$OUT/ledger/trd440-before.txt" ]] || die "run tenant-before first"
    # The provisioner runs as the product's own tenant-create one-shot (app
    # project, run --rm) on ${STACK}_state/_edge -- not from the host, because
    # reaching postgres from the host needs a published port, and a published
    # port on a _state service is itself an isolation breach (see isolation).
    local -a run=(run --rm --pull never
        -e "KEYCLOAK_ADMIN=${KEYCLOAK_ADMIN}" -e "KEYCLOAK_ADMIN_PASSWORD=${KEYCLOAK_ADMIN_PASSWORD}"
        -e "ADMIN_DATABASE_URL=postgresql://postgres:${POSTGRES_PASSWORD}@postgres-${STACK}:5432/postgres"
        -e "PLATFORM_DOMAIN=proof.example.org" -e "PLATFORM_SMTP_PASSWORD=$(gen)"
        -e "TENANT_PROVISIONER_SECRET_FILE=/run/secrets/tenants/.proof-provisioner"
        -v "$(host_path "$ROOT/test/host/fixtures/pooled-stack"):/fixture:ro"
        tenant-create)
    compose app-blue "${run[@]}" bootstrap-provisioner > "$OUT/ledger/trd440-bootstrap.log" 2>&1 \
        || { tail -15 "$OUT/ledger/trd440-bootstrap.log" >&2; bad "bootstrap-provisioner failed"; return; }
    compose app-blue "${run[@]}" provision "$TENANT_SLUG" --config "/fixture/tenant-t040-b.json" \
        > "$OUT/ledger/trd440-provision.log" 2>&1 \
        || { tail -25 "$OUT/ledger/trd440-provision.log" >&2; bad "provision $TENANT_SLUG failed"; return; }
    # The operator's step after provision (runbook tenant-lifecycle): the
    # tenant's own config at /data/<slug>/config.json on the external
    # tenant-config-data volume. The fleet (migrate) asserts its brand identity.
    docker run --rm -i --name "${STACK}-seed-tenant" -v "${STACK}_tenant_config_data:/d" --entrypoint sh "$PROBE_IMAGE"         -c "mkdir -p /d/${TENANT_SLUG} && cat > /d/${TENANT_SLUG}/config.json && chown -R 1000:1000 /d/${TENANT_SLUG}"         < "$ROOT/test/host/fixtures/pooled-stack/tenant-t040-b.json"
    ok "tenant: bootstrap-provisioner and provision $TENANT_SLUG ran; its config is in place (ledger/trd440-*.log)"
}

# Split so no call outlives a time box: each compose render is ~10 s here.
phase_tenant_before() {
    counts > "$OUT/ledger/trd440-before.txt"
    [[ -s "$OUT/ledger/trd440-before.txt" ]] || die "empty TRD-440 baseline"
    ok "tenant-before: baseline recorded"
}
phase_tenant_after() {
    # shellcheck disable=SC1090
    . "$ENV_DIR/state.env"
    local before after
    before="$(cat "$OUT/ledger/trd440-before.txt")"
    after="$(counts)"
    printf '%s\n' "$after" > "$OUT/ledger/trd440-after.txt"
    [[ "$before" == "$after" ]] && ok "TRD-440: services, running containers and compose projects unchanged by the tenant-add" \
        || bad "TRD-440: the tenant-add changed the stack: $(diff <(printf '%s\n' "$before") <(printf '%s\n' "$after") | tr '\n' ' ')"
    local cid db realm
    cid="$(svc_cid state postgres)"
    db="$(docker exec "$cid" psql -tAqU postgres -c "SELECT datname FROM pg_database WHERE datname IN ('t_${TENANT_SLUG//-/_}', 't_${TENANT_SLUG}')" | tr -d '\r')"
    [[ -n "$db" ]] && ok "TRD-440: tenant database $db exists" || bad "TRD-440: no tenant database for $TENANT_SLUG"
    realm="$(docker exec "$(svc_cid state keycloak)" sh -c "/opt/keycloak/bin/kcadm.sh config credentials --server http://127.0.0.1:8080/auth --realm master --user '${KEYCLOAK_ADMIN}' --password '${KEYCLOAK_ADMIN_PASSWORD}' >/dev/null 2>&1 && /opt/keycloak/bin/kcadm.sh get realms/${TENANT_SLUG} --fields realm" 2>/dev/null | tr -d '\r' || true)"
    [[ "$realm" == *"\"${TENANT_SLUG}\""* ]] && ok "TRD-440: realm $TENANT_SLUG exists" || bad "TRD-440: realm $TENANT_SLUG absent"
    printf '%s db=%s realm=%s\n' "$(now)" "${db:-none}" "$(echo "$realm" | tr -d ' \n')" | ledger trd440.log
}

# ── TRD-038 ────────────────────────────────────────────────────────────────
phase_switch() {
    require_scratch switch
    [[ -s "$OUT/state-snapshot.txt" ]] || die "no state snapshot (run state-wait first)"
    # green must already be up and healthy (app-up green, app-wait green)
    local g; g="$(svc_cid app-green gremion-ui)"
    [[ -n "$g" ]] && wait_health "$g" 30 || die "app-green is not up and healthy -- run app-up green and app-wait green first"
    # blue leaves: removal by label, never `compose down`
    docker ps -aq --filter "label=com.docker.compose.project=${STACK}-app-blue" | xargs -r docker rm -f >/dev/null
    local now_snap
    now_snap="$( { docker ps -q --no-trunc --filter "label=com.docker.compose.project=${STACK}-state" | sort
      docker volume ls -q --filter "name=^${STACK}" | sort | while read -r v; do
          printf '%s %s\n' "$v" "$(docker volume inspect -f '{{.CreatedAt}}' "$v")"; done; } )"
    printf '%s\n' "$now_snap" > "$OUT/ledger/state-after-switch.txt"
    cp "$OUT/state-snapshot.txt" "$OUT/ledger/state-before-switch.txt"
    if [[ "$now_snap" == "$(cat "$OUT/state-snapshot.txt")" ]]; then
        ok "TRD-038: blue -> green left every state container ID and volume CreatedAt unchanged"
    else
        bad "TRD-038: the switch changed the state tier: $(diff "$OUT/state-snapshot.txt" "$OUT/ledger/state-after-switch.txt" | tr '\n' ' ')"
    fi
}

phase_cold_state() {
    require_scratch cold-state
    docker ps -q --filter "label=com.docker.compose.project=${STACK}-state" | xargs -r docker restart -t 5 >/dev/null
    local cid c body
    for c in green blue; do cid="$(svc_cid "app-$c" gremion-ui)"; [[ -n "$cid" ]] && break; done
    [[ -n "$cid" ]] || { bad "cold-state: no app colour running"; return; }
    sleep 20
    wait_health "$cid" 180 || bad "cold-state: app-$c gremion-ui unhealthy after the state restart"
    body="$(docker exec "$cid" wget -qO- http://127.0.0.1:3000/healthz 2>/dev/null || true)"
    [[ "$body" == *'"ok":true'* ]] && ok "cold-state: app-$c healthy after a cold state start ($body)" || bad "cold-state: /healthz after restart: $body"
}

phase_teardown() {
    require_scratch teardown
    local p
    for p in app-blue app-green state ops mail; do
        docker ps -aq --filter "label=com.docker.compose.project=${STACK}-$p" | xargs -r docker rm -f >/dev/null
    done
    docker ps -aq --filter "name=^${STACK}-" | xargs -r docker rm -f >/dev/null
    docker network ls -q --filter "name=^${STACK}" | xargs -r docker network rm >/dev/null
    docker volume ls -q --filter "name=^${STACK}" | xargs -r docker volume rm >/dev/null
    [[ -f "$OUT/.created-userlist" ]] && rm -f "$ROOT/docker/pgbouncer/userlist.txt" "$OUT/.created-userlist"
    [[ -f "$OUT/.created-ipcrypt" ]] && rm -f "$ROOT/secrets/ipcrypt_key.txt" "$OUT/.created-ipcrypt"
    local left
    left="$(docker ps -aq --filter "name=^${STACK}" | grep -c . || true)$(docker network ls -q --filter "name=^${STACK}" | grep -c . || true)$(docker volume ls -q --filter "name=^${STACK}" | grep -c . || true)"
    [[ "$left" == 000 ]] && ok "teardown: no container, network or volume under ${STACK} remains" || bad "teardown left resources (containers/networks/volumes: $left)"
}

run_phase() {
    case "$1" in
        prepare) phase_prepare ;;
        names) phase_names ;;
        state-up) phase_state_up ;;
        state-wait) phase_state_wait ;;
        app-up) phase_app_up "$2" ;;
        app-wait) phase_app_wait "$2" ;;
        aux-up) phase_aux_up ;;
        limits) phase_limits ;;
        rss) phase_rss ;;
        isolation) phase_isolation ;;
        probes) phase_probes ;;
        tenant-before) phase_tenant_before ;;
        tenant) phase_tenant ;;
        tenant-after) phase_tenant_after ;;
        switch) phase_switch ;;
        cold-state) phase_cold_state ;;
        teardown) phase_teardown ;;
        *) die "unknown phase '$1'" ;;
    esac
}

[[ $# -gt 0 ]] || set -- all
PHASES="$*"   # recorded before the loop below shifts the arguments away
info "STACK=${STACK} scope=${SCOPE} ledger=${OUT}/ledger"
if [[ "$1" == all ]]; then
    require_scratch all
    trap 'phase_teardown || true' EXIT
    for ph in prepare names state-up state-wait "app-up blue" "app-wait blue" aux-up limits rss isolation probes tenant-before tenant tenant-after "app-up green" "app-wait green" switch cold-state limits; do
        # shellcheck disable=SC2086
        run_phase $ph
    done
else
    while [[ $# -gt 0 ]]; do
        case "$1" in
            app-up|app-wait) run_phase "$1" "${2:?colour}"; shift 2 ;;
            *) run_phase "$1"; shift ;;
        esac
    done
fi
printf '%s phases [%s] RED=%s\n' "$(now)" "$PHASES" "$RED" | ledger run.log
if (( RED )); then echo "[pooled-proof] RED" >&2; exit 1; fi
echo "[pooled-proof] GREEN"
