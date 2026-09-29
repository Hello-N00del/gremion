#!/usr/bin/env bats
# Tests for infra/host/bin/gremion-validate-env, the one-reader guard, and the
# PLATFORM_DOMAIN binding of the production render (TASK-028; spec B section 6,
# B15 tasks 3, 4 and the single-reader rule).
# Run: bats test/host/validate-env.bats
#
# Unit, except the render tests at the bottom: those need a docker CLI (never a
# running container -- `config` and `--dry-run` only) and skip loudly without one.

load 'test_helper/host'

setup() {
    setup_host_root
    VALIDATE="${HOST_SRC}/bin/gremion-validate-env"
    ENV_DIR="${GREMION_ROOT}/etc/env"
    RELEASE="${GREMION_ROOT}/releases/r1"
    mkdir -p "$RELEASE"
}

teardown() {
    teardown_host_root
}

# A real render with every operator key filled by an obvious fake, and a
# release tree holding every file the COMPOSE_FILE lists name.
render_filled() {
    "${HOST_SRC}/bin/gremion-init-secrets" --root "$GREMION_ROOT" --stack teststack >/dev/null
    local f
    for f in "$ENV_DIR"/*.env; do
        sed -i -E 's/^([A-Za-z_][A-Za-z0-9_]*)=CHANGE_ME_OPERATOR_[a-z0-9_]+$/\1=fake-operator-value/' "$f"
        sed -i 's/^GREMION_PRODUCTION_STACK=.*/GREMION_PRODUCTION_STACK=none/' "$f"
        ! grep -qE '^[A-Za-z_][A-Za-z0-9_]*=.*CHANGE_ME_' "$f" || { echo "sentinel left in $f"; return 1; }
    done
    touch "$RELEASE"/docker-compose.yml "$RELEASE"/docker-compose.prod.yml \
          "$RELEASE"/docker-compose.pins.yml "$RELEASE"/docker-compose.app.yml \
          "$RELEASE"/docker-compose.state-pins.yml
}

value_of() {
    sed -n "s/^$2=//p" "$1"
}

# Every generated secret in a file: the values the validator must never print.
secret_values() {
    local tmpl="$1" file="$2" k
    while IFS= read -r k; do
        value_of "$file" "$k"
    done < <(grep -E '^[A-Za-z_][A-Za-z0-9_]*=CHANGE_ME_GEN_' "$tmpl" | sed 's/=.*//')
}

refute_secrets_printed() {
    local tmpl="$1" file="$2" v
    while IFS= read -r v; do
        [[ -n "$v" ]] || continue
        [[ "$output" != *"$v"* ]] || { echo "a secret value was printed"; return 1; }
    done < <(secret_values "$tmpl" "$file")
}

# ---------------------------------------------------------------------------
# gremion-validate-env
# ---------------------------------------------------------------------------

@test "gremion-validate-env exists, is executable, and has strict mode on line 2" {
    [ -x "$VALIDATE" ]
    [ "$(sed -n 2p "$VALIDATE")" = "set -euo pipefail" ]
}

@test "--help prints usage and exits 0; no --env-file exits 2" {
    run "$VALIDATE" --help
    [ "$status" -eq 0 ]
    [[ "$output" == *"usage: gremion-validate-env"* ]]
    run "$VALIDATE"
    [ "$status" -eq 2 ]
    run "$VALIDATE" --env-file
    [ "$status" -eq 2 ]
    run "$VALIDATE" --bogus
    [ "$status" -eq 2 ]
}

@test "an ABSENT env file exits 2 with a setup-first line, not a validation failure (TRD-099)" {
    run "$VALIDATE" --env-file "${ENV_DIR}/state.env" --release "$RELEASE"
    [ "$status" -eq 2 ]
    [[ "$output" == *"run setup first"* ]]
    [[ "$output" == *"gremion-init-secrets"* ]]
    [[ "$output" != *"drift"* ]]
    [[ "$output" != *"COMPOSE_FILE"* ]]
}

@test "a complete render validates: state.env and both colours exit 0" {
    render_filled
    local f
    for f in state app-blue app-green; do
        run "$VALIDATE" --env-file "${ENV_DIR}/${f}.env" --release "$RELEASE"
        [ "$status" -eq 0 ] || { echo "${f}: $output"; return 1; }
        [[ "$output" == *"VALIDATE-ENV: ok"* ]]
    done
}

@test "a missing COMPOSE_FILE entry exits 1 and names the file" {
    render_filled
    rm "$RELEASE/docker-compose.state-pins.yml"
    run "$VALIDATE" --env-file "${ENV_DIR}/state.env" --release "$RELEASE"
    [ "$status" -eq 1 ]
    [[ "$output" == *"docker-compose.state-pins.yml"* ]]
}

@test "an env file without COMPOSE_FILE exits 1 (it must name its composition, N20)" {
    render_filled
    sed -i '/^COMPOSE_FILE=/d' "${ENV_DIR}/state.env"
    run "$VALIDATE" --env-file "${ENV_DIR}/state.env" --release "$RELEASE"
    [ "$status" -eq 1 ]
    [[ "$output" == *"COMPOSE_FILE"* ]]
}

@test "COMPOSE_PATH_SEPARATOR is honoured when splitting COMPOSE_FILE" {
    render_filled
    sed -i 's/^COMPOSE_FILE=.*/COMPOSE_FILE=docker-compose.yml;docker-compose.nope.yml/' "${ENV_DIR}/state.env"
    printf 'COMPOSE_PATH_SEPARATOR=;\n' >> "${ENV_DIR}/state.env"
    run "$VALIDATE" --env-file "${ENV_DIR}/state.env" --release "$RELEASE"
    [ "$status" -eq 1 ]
    [[ "$output" == *"docker-compose.nope.yml"* ]]
    [[ "$output" != *"docker-compose.yml;"* ]]
}

@test "a missing release tree exits 2" {
    render_filled
    run "$VALIDATE" --env-file "${ENV_DIR}/state.env" --release "${GREMION_ROOT}/releases/none"
    [ "$status" -eq 2 ]
}

@test "alias drift between the two halves of an OIDC secret pair exits 1, naming both keys" {
    render_filled
    local f="${ENV_DIR}/state.env"
    sed -i "s/^GREMION_UI_OIDC_CLIENT_SECRET=.*/GREMION_UI_OIDC_CLIENT_SECRET=$(printf '0%.0s' {1..64})/" "$f"
    run "$VALIDATE" --env-file "$f" --release "$RELEASE"
    [ "$status" -eq 1 ]
    [[ "$output" == *"drift"* ]]
    [[ "$output" == *"AUTH_KEYCLOAK_SECRET"* ]]
    [[ "$output" == *"GREMION_UI_OIDC_CLIENT_SECRET"* ]]
    refute_secrets_printed "${HOST_SRC}/templates/env/state.env.tmpl" "$f"
}

@test "drift of the password embedded in GREMION_PUBLIC_DB_URL exits 1" {
    render_filled
    local f="${ENV_DIR}/app-green.env"
    sed -i 's|^GREMION_PUBLIC_DB_URL=.*|GREMION_PUBLIC_DB_URL=postgresql://gremion_public_reader:fake-other@postgres:5432/gremion|' "$f"
    run "$VALIDATE" --env-file "$f" --release "$RELEASE"
    [ "$status" -eq 1 ]
    [[ "$output" == *"GREMION_PUBLIC_DB_URL"* ]]
    [[ "$output" == *"PUBLIC_DB_PASSWORD"* ]]
    refute_secrets_printed "${HOST_SRC}/templates/env/app.env.tmpl" "$f"
}

@test "load_env's refusals pass through with exit 2 (an operator sentinel left in place)" {
    render_filled
    sed -i 's/^ACME_EMAIL=.*/ACME_EMAIL=CHANGE_ME_OPERATOR_acme_email/' "${ENV_DIR}/state.env"
    run "$VALIDATE" --env-file "${ENV_DIR}/state.env" --release "$RELEASE"
    [ "$status" -eq 2 ]
    [[ "$output" == *"ACME_EMAIL"* ]]
}

@test "an env-file key cannot overwrite the validator's own state (review finding MEDIUM)" {
    render_filled
    local f="${ENV_DIR}/state.env" k
    sed -i "s/^GREMION_UI_OIDC_CLIENT_SECRET=.*/GREMION_UI_OIDC_CLIENT_SECRET=$(printf '0%.0s' {1..64})/" "$f"
    for k in TEMPLATE RELEASE_DIR FAILURES ENV_FILE; do
        cp "$f" "${f}.bak"
        printf '%s=/dev/null\n' "$k" >> "$f"
        run "$VALIDATE" --env-file "$f" --release "$RELEASE"
        [ "$status" -ne 0 ] || { echo "${k}= in the env file turned drift into: $output"; return 1; }
        [[ "$output" != *"VALIDATE-ENV: ok"* ]]
        mv "${f}.bak" "$f"
    done
}

@test "a COMPOSE_FILE exported by the caller does not stand in for the file's (review finding)" {
    render_filled
    sed -i '/^COMPOSE_FILE=/d' "${ENV_DIR}/state.env"
    COMPOSE_FILE=docker-compose.yml run "$VALIDATE" --env-file "${ENV_DIR}/state.env" --release "$RELEASE"
    [ "$status" -eq 1 ]
    [[ "$output" == *"COMPOSE_FILE is not set"* ]]
}

@test "a key under the reserved __gve_ prefix is refused" {
    render_filled
    printf '__gve_failures=0\n' >> "${ENV_DIR}/state.env"
    run "$VALIDATE" --env-file "${ENV_DIR}/state.env" --release "$RELEASE"
    [ "$status" -eq 2 ]
    [[ "$output" == *"__gve_"* ]]
}

@test "ALLOW_SENTINELS exported by the caller does not waive the validator's sentinel refusal" {
    render_filled
    sed -i 's/^ACME_EMAIL=.*/ACME_EMAIL=CHANGE_ME_OPERATOR_acme_email/' "${ENV_DIR}/state.env"
    ALLOW_SENTINELS=1 run "$VALIDATE" --env-file "${ENV_DIR}/state.env" --release "$RELEASE"
    [ "$status" -eq 2 ]
    [[ "$output" == *"ACME_EMAIL"* ]]
}

@test "a key the template declares but the file lacks exits 1, naming it (review finding)" {
    render_filled
    local k
    for k in GREMION_PRODUCTION_STACK PLATFORM_DOMAIN; do
        cp "${ENV_DIR}/state.env" "${ENV_DIR}/state.env.bak"
        sed -i "/^${k}=/d" "${ENV_DIR}/state.env"
        run "$VALIDATE" --env-file "${ENV_DIR}/state.env" --release "$RELEASE"
        [ "$status" -eq 1 ] || { echo "$k missing: $output"; return 1; }
        [[ "$output" == *"$k"* ]]
        mv "${ENV_DIR}/state.env.bak" "${ENV_DIR}/state.env"
    done
}

@test "an operator key left empty or blank exits 1 (review finding)" {
    render_filled
    local v
    for v in '' '"  "'; do
        cp "${ENV_DIR}/state.env" "${ENV_DIR}/state.env.bak"
        sed -i "s/^GREMION_PRODUCTION_STACK=.*/GREMION_PRODUCTION_STACK=${v}/" "${ENV_DIR}/state.env"
        run "$VALIDATE" --env-file "${ENV_DIR}/state.env" --release "$RELEASE"
        [ "$status" -eq 1 ] || { echo "value [$v]: $output"; return 1; }
        [[ "$output" == *"GREMION_PRODUCTION_STACK"* ]]
        mv "${ENV_DIR}/state.env.bak" "${ENV_DIR}/state.env"
    done
}

@test "no generated secret value is printed on success or on any failure" {
    render_filled
    local f="${ENV_DIR}/state.env" tmpl="${HOST_SRC}/templates/env/state.env.tmpl"
    run "$VALIDATE" --env-file "$f" --release "$RELEASE"
    [ "$status" -eq 0 ]
    refute_secrets_printed "$tmpl" "$f"
    rm "$RELEASE/docker-compose.prod.yml"
    run "$VALIDATE" --env-file "$f" --release "$RELEASE"
    [ "$status" -eq 1 ]
    refute_secrets_printed "$tmpl" "$f"
}

@test "GREMION_PRODUCTION_STACK and GREMION_STACK are declared in state.env.tmpl and app.env.tmpl, no default" {
    local t
    for t in state app; do
        t="${HOST_SRC}/templates/env/${t}.env.tmpl"
        [ "$(grep -c '^GREMION_PRODUCTION_STACK=' "$t")" -eq 1 ]
        grep -q '^GREMION_PRODUCTION_STACK=CHANGE_ME_OPERATOR_' "$t" \
            || { echo "$t: GREMION_PRODUCTION_STACK must be an operator sentinel (no default)"; return 1; }
        [ "$(grep -c '^GREMION_STACK=${STACK}$' "$t")" -eq 1 ]
    done
}

# ---------------------------------------------------------------------------
# One env reader under infra/host/ (TRD-039, spec B section 6)
# ---------------------------------------------------------------------------

# second_readers <dir> -> every line of a shell file under <dir> (bin/*,
# *.sh) that reads an env file some other way than load_env:
#   - allexport: `set -a`, `set -ea`, `set -o allexport`;
#   - sourcing / dotting anything that is not a *.sh library, at COMMAND
#     position (a bare `.` elsewhere is `grep -c .` or `jq -e .`): a *.env
#     path, a variable path ("$STATE_ENV"), a process substitution;
#   - `export|declare -x|eval|env` fed by $(cat|grep|sed|awk|xargs ...),
#     and `eval "$(...)"` in general;
#   - a dynamic `export "$k=$v"` (a hand-rolled read loop) -- except load_env's
#     own line in lib/common.sh.
# Allow-listed, by exact line: `. /etc/os-release` in bootstrap.sh (the OS's
# identity file, not a gremion env file). Per-key readers (`sed -n
# "s/^KEY=//p"`) are not whole-file readers and are out of this guard's scope.
second_readers() {
    local -a files=()
    mapfile -t files < <(find "$1" -type f \( -name '*.sh' -o -path '*/bin/*' \) | sort)
    [[ ${#files[@]} -gt 0 ]] || { echo "VACUOUS: no shell files under $1"; return 0; }
    grep -nHE \
        -e '(^|[;&|{([:space:]])set[[:space:]]+(-[A-Za-z]*a[A-Za-z]*|-o[[:space:]]+allexport)([[:space:];]|$)' \
        -e '(^[[:space:]]*|[;&|{][[:space:]]*|(then|do|else)[[:space:]]+)(source|\.)[[:space:]]+[^[:space:];&|]' \
        -e '(^|[^A-Za-z_])(export|declare[[:space:]]+-[A-Za-z]*x[A-Za-z]*|eval|env)[[:space:]]+"?\$\((cat|grep|sed|awk|xargs)' \
        -e '(^|[^A-Za-z_])eval[[:space:]]+"?\$\(' \
        -e 'export[[:space:]]+"?\$\{?[A-Za-z_][A-Za-z0-9_]*\}?=' \
        "${files[@]}" \
        | grep -vE '^[^:]+:[0-9]+:[[:space:]]*#' \
        | grep -vE '(source|\.)[[:space:]]+"?[^[:space:]";&|]*\.sh"?([[:space:];)]|$)' \
        | grep -vE '^[^:]*/lib/common\.sh:[0-9]+:[[:space:]]+export "\$\{key\}=\$\{value\}"$' \
        | grep -vE '^[^:]*/bootstrap\.sh:[0-9]+:[[:space:]]+\. /etc/os-release$' \
        || true
}

@test "load_env is the only env reader under infra/host/" {
    run second_readers "$HOST_SRC"
    [ "$status" -eq 0 ]
    [ -z "$output" ] || { echo "second env reader(s):"; echo "$output"; return 1; }
}

@test "the one-reader guard is RED on every seeded second-reader form, and quiet on the legitimate ones" {
    local copy="${GREMION_ROOT}/host-src" i=0 form
    cp -r "$HOST_SRC" "$copy"
    local -a forms=(
        'set -a; . "$ENV_FILE"; set +a'
        'source /opt/gremion/etc/env/state.env'
        'export $(cat /opt/gremion/etc/env/app-blue.env | xargs)'
        '. "$STATE_ENV"'
        'source "$f" # load env'
        'set -o allexport'
        'set -ea'
        "while IFS='=' read -r k v; do export \"\$k=\$v\"; done < \"\$f\""
        'eval "$(cat /opt/gremion/etc/env/state.env)"'
        "eval \$(sed 's/^/export /' state.env)"
        'declare -x $(cat state.env)'
        "source <(grep -v '^#' state.env)"
        'env $(cat state.env | xargs) cmd'
        'if true; then . state.env; fi'
        'foo; source state.env'
    )
    for form in "${forms[@]}"; do
        i=$((i + 1))
        printf '#!/usr/bin/env bash\n%s\n' "$form" > "$copy/bin/gremion-seeded-$i"
    done
    run second_readers "$copy"
    for ((i = 1; i <= ${#forms[@]}; i++)); do
        [[ "$output" == *"gremion-seeded-${i}:"* ]] || { echo "missed form ${i}: ${forms[$((i - 1))]}"; return 1; }
    done
    # legitimate lines stay quiet
    rm -f "$copy"/bin/gremion-seeded-*
    printf '#!/usr/bin/env bash\n# never: set -a; . state.env\n. "$SCRIPT_DIR/../lib/common.sh"\nn="$(grep -c . f)"\njq -e . f\nset -euo pipefail\n' \
        > "$copy/bin/gremion-legit"
    run second_readers "$copy"
    [[ "$output" != *"gremion-legit"* ]] || { echo "false positive:"; echo "$output"; return 1; }
}

# ---------------------------------------------------------------------------
# PLATFORM_DOMAIN: bound once, required by the production render (B15 task 4)
# ---------------------------------------------------------------------------

DOMAIN_BINDING='DOMAIN: ${PLATFORM_DOMAIN:?PLATFORM_DOMAIN required}'
GUARDED_READ='${PLATFORM_DOMAIN:?PLATFORM_DOMAIN required}'

# TASK-040 (pooled stack) split the production render: the state project is
# docker-compose.yml + docker-compose.prod.yml, the app tier (gremion-ui and
# the tenant-create one-shot, both of which read DOMAIN) is
# docker-compose.app.yml. TASK-028's "bound once, nothing else reads it" rule
# existed to forbid an UNGUARDED second read; across three files the rule is:
# every DOMAIN binding is the guarded one, and every read of PLATFORM_DOMAIN
# carries `:?`, so no read of it can ever render empty. (Retargeted under the
# TASK-040 round-3 grant, verify-r2 HIGH 1.)
PRODUCTION_COMPOSE_FILES=(docker-compose.yml docker-compose.prod.yml docker-compose.app.yml)

production_compose_text() {
    local f
    for f in "${PRODUCTION_COMPOSE_FILES[@]}"; do
        [[ -f "${KERNEL_ROOT}/$f" ]] || { echo "missing ${f}" >&2; return 1; }
        grep -vE '^[[:space:]]*#' "${KERNEL_ROOT}/$f"
    done
}

@test "DOMAIN is bound only from PLATFORM_DOMAIN across the compose files, and every PLATFORM_DOMAIN read is guarded" {
    local text bindings bad n rest
    text="$(production_compose_text)"
    bindings="$(printf '%s\n' "$text" | grep -E '^[[:space:]]+DOMAIN:' || true)"
    [ -n "$bindings" ] || { echo "no DOMAIN binding in any compose file"; return 1; }
    bad="$(printf '%s\n' "$bindings" | grep -vF "$DOMAIN_BINDING" || true)"
    [ -z "$bad" ] || { echo "DOMAIN bound otherwise:"; echo "$bad"; return 1; }
    n="$(printf '%s\n' "$text" | grep -cF "$GUARDED_READ" || true)"
    [ "$n" -ge 1 ] || { echo "vacuous: no guarded PLATFORM_DOMAIN read"; return 1; }
    rest="$(printf '%s\n' "$text" | awk -v g="$GUARDED_READ" '{ while ((i = index($0, g)) > 0) $0 = substr($0, 1, i - 1) substr($0, i + length(g)); print }' \
        | grep -n 'PLATFORM_DOMAIN' || true)"
    [ -z "$rest" ] || { echo "unguarded PLATFORM_DOMAIN read(s):"; echo "$rest"; return 1; }
}

@test "a GREMION_PRODUCTION_STACK that is neither none nor a stack name exits 1" {
    render_filled
    sed -i 's/^GREMION_PRODUCTION_STACK=.*/GREMION_PRODUCTION_STACK=Not-A-Stack/' "${ENV_DIR}/state.env"
    run "$VALIDATE" --env-file "${ENV_DIR}/state.env" --release "$RELEASE"
    [ "$status" -eq 1 ]
    [[ "$output" == *"GREMION_PRODUCTION_STACK"* ]]
}

# A private project directory holding the three compose files and an EMPTY
# legal/legal.env, rendered with ONLY the edge fixture as input: no .env, no
# caller environment beyond what docker needs to find its daemon.
prod_render() {
    local proj="${GREMION_ROOT}/proj" envf="${GREMION_ROOT}/render.env"
    mkdir -p "$proj/legal"
    : > "$proj/legal/legal.env"
    cp "${KERNEL_ROOT}"/docker-compose.yml "${KERNEL_ROOT}"/docker-compose.prod.yml "$proj/"
    grep -v '^COMPOSE_FILE=\|^COMPOSE_PROFILES=\|^COMPOSE_PATH_SEPARATOR=' \
        "${KERNEL_ROOT}/test/host/fixtures/edge-render/state.env" > "$envf"
    if [[ "${1:-}" == "--without-platform-domain" ]]; then
        sed -i '/^PLATFORM_DOMAIN=/d' "$envf"
        shift
    fi
    # The host env templates carry no DOMAIN (TASK-040): render as a host does.
    if [[ "${1:-}" == "--without-domain" ]]; then
        sed -i '/^DOMAIN=/d' "$envf"
        shift
    fi
    run env -i PATH="$PATH" HOME="${HOME:-/root}" ${DOCKER_HOST:+DOCKER_HOST="$DOCKER_HOST"} \
        docker compose --project-directory "$proj" --env-file "$envf" \
        -f "$proj/docker-compose.yml" -f "$proj/docker-compose.prod.yml" --profile production "$@"
}

# The app tier's render (TASK-040): docker-compose.app.yml alone, from the
# pooled-stack app-blue fixture, every profile on so the one-shots render too.
app_render() {
    local proj="${GREMION_ROOT}/app-proj" envf="${GREMION_ROOT}/app-render.env"
    mkdir -p "$proj"
    cp "${KERNEL_ROOT}/docker-compose.app.yml" "$proj/"
    grep -v '^COMPOSE_FILE=\|^COMPOSE_PROFILES=\|^COMPOSE_PATH_SEPARATOR=\|^COMPOSE_PROJECT_NAME=' \
        "${KERNEL_ROOT}/test/host/fixtures/pooled-stack/app-blue.env" > "$envf"
    if [[ "${1:-}" == "--without-platform-domain" ]]; then
        sed -i '/^PLATFORM_DOMAIN=/d' "$envf"
        shift
    fi
    run env -i PATH="$PATH" HOME="${HOME:-/root}" ${DOCKER_HOST:+DOCKER_HOST="$DOCKER_HOST"} \
        docker compose --project-directory "$proj" --env-file "$envf" \
        -f "$proj/docker-compose.app.yml" --profile migrate --profile tenant-create "$@"
}

need_docker_cli() {
    command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1 \
        || skip "docker compose CLI unavailable -- the render tests did NOT run"
}

@test "the production render with PLATFORM_DOMAIN unset aborts with 'PLATFORM_DOMAIN required'" {
    need_docker_cli
    prod_render --without-platform-domain config
    [ "$status" -ne 0 ] || { echo "state render exited 0 without PLATFORM_DOMAIN"; return 1; }
    [[ "$output" == *"PLATFORM_DOMAIN required"* ]]
    app_render --without-platform-domain config
    [ "$status" -ne 0 ] || { echo "app render exited 0 without PLATFORM_DOMAIN"; return 1; }
    [[ "$output" == *"PLATFORM_DOMAIN required"* ]]
}

@test "the production render with PLATFORM_DOMAIN set binds gremion-ui's DOMAIN to it" {
    need_docker_cli
    app_render config --format json
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    local json got
    json="$(printf '%s' "$output" | sed -n '/^{/,$p')"
    for svc in gremion-ui tenant-create; do
        got="$(printf '%s' "$json" | jq -r --arg s "$svc" '.services[$s].environment.DOMAIN')"
        [ "$got" = "guard.example.org" ] || { echo "${svc} DOMAIN=${got}"; return 1; }
    done
    # ...and the state render's Host rules name the same apex from
    # PLATFORM_DOMAIN alone (a bare ${DOMAIN} renders Host(``) on a host)
    prod_render --without-domain config --format json
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    json="$(printf '%s' "$output" | sed -n '/^{/,$p')"
    for svc in keycloak fallback; do
        got="$(printf '%s' "$json" | jq -r --arg s "$svc" '.services[$s].labels["traefik.http.routers.\($s).rule"]')"
        [[ "$got" == *'Host(`guard.example.org`)'* ]] || { echo "${svc} rule: ${got}"; return 1; }
    done
}

@test "':?' aborts an 'up' before any container is created (compose --dry-run)" {
    need_docker_cli
    docker info >/dev/null 2>&1 || skip "docker daemon unavailable -- the dry-run test did NOT run"
    local project="task028-dryrun-$$"
    prod_render --without-platform-domain -p "$project" --dry-run up -d
    [ "$status" -ne 0 ]
    [[ "$output" == *"PLATFORM_DOMAIN required"* ]]
    run docker ps -aq --filter "label=com.docker.compose.project=${project}"
    [ -z "$output" ]
}
