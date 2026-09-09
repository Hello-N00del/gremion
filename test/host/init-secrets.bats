#!/usr/bin/env bats
# Tests for infra/host/bin/gremion-init-secrets and templates/env/*.env.tmpl.
# Run: bats test/host/init-secrets.bats
#
# Unit only. gremion-init-secrets touches no daemon: it reads four templates,
# generates secrets with openssl, and writes five files.
#
# NOTE ON HOST LITERALS: this file scans nothing for them. Tree-wide host-literal
# scanning belongs to Task 14's test/host/no-host-literals.bats, which fragments
# its own patterns so the guard file never becomes the leak it is looking for.

load 'test_helper/host'

setup() {
    setup_host_root
    INIT="${HOST_SRC}/bin/gremion-init-secrets"
    ENV_DIR="${GREMION_ROOT}/etc/env"
}

teardown() {
    teardown_host_root
}

# Render once with the real templates.
render() {
    run "$INIT" --root "$GREMION_ROOT" --stack gremion "$@"
}

# value_of <file> <key>
value_of() {
    sed -n "s/^$2=//p" "$1" | head -n1
}

# A private copy of infra/host that a test may mutate.
copy_host_src() {
    cp -r "$HOST_SRC" "${GREMION_ROOT}/host-src"
    COPY_INIT="${GREMION_ROOT}/host-src/bin/gremion-init-secrets"
    COPY_TMPL="${GREMION_ROOT}/host-src/templates/env"
}

# ---------------------------------------------------------------------------
# Shape and usage
# ---------------------------------------------------------------------------

@test "gremion-init-secrets exists and is executable" {
    [[ -f "$INIT" ]]
    [[ -x "$INIT" ]]
}

@test "refuses to guess a stack name (exit 2)" {
    run env -u STACK "$INIT" --root "$GREMION_ROOT"
    [ "$status" -eq 2 ]
    [[ "$output" == *"--stack"* ]]
}

@test "renders exactly the five project env files" {
    render
    [ "$status" -eq 0 ]
    local f
    for f in state.env app-blue.env app-green.env mail.env ops.env; do
        [[ -f "${ENV_DIR}/${f}" ]] || { echo "not rendered: ${f}"; return 1; }
    done
    [ "$(find "$ENV_DIR" -maxdepth 1 -type f | wc -l)" -eq 5 ]
}

@test "prints the INIT-SECRETS proof line" {
    render
    [[ "$output" =~ INIT-SECRETS:\ files=5\ generated=[0-9]+\ operator-pending=[0-9]+ ]]
}

# ---------------------------------------------------------------------------
# Composition contract (N20, section E)
# ---------------------------------------------------------------------------

@test "each rendered file carries its own project name, COMPOSE_FILE and profiles" {
    render
    [ "$(value_of "${ENV_DIR}/state.env"     COMPOSE_PROJECT_NAME)" = "gremion-state" ]
    [ "$(value_of "${ENV_DIR}/app-blue.env"  COMPOSE_PROJECT_NAME)" = "gremion-app-blue" ]
    [ "$(value_of "${ENV_DIR}/app-green.env" COMPOSE_PROJECT_NAME)" = "gremion-app-green" ]
    [ "$(value_of "${ENV_DIR}/mail.env"      COMPOSE_PROJECT_NAME)" = "gremion-mail" ]
    [ "$(value_of "${ENV_DIR}/ops.env"       COMPOSE_PROJECT_NAME)" = "gremion-ops" ]
    local f
    for f in state app-blue app-green mail ops; do
        grep -q '^COMPOSE_FILE=' "${ENV_DIR}/${f}.env" \
            || { echo "${f}.env has no COMPOSE_FILE"; return 1; }
        grep -q '^COMPOSE_PROFILES=' "${ENV_DIR}/${f}.env" \
            || { echo "${f}.env has no COMPOSE_PROFILES"; return 1; }
    done
    [ "$(value_of "${ENV_DIR}/app-blue.env" COMPOSE_FILE)" = "docker-compose.app.yml:docker-compose.pins.yml" ]
}

@test "no rendered env file leaves an unsubstituted render placeholder" {
    render
    ! grep -rn '\${' "$ENV_DIR"
}

@test "no rendered env file declares a key twice (load_env refuses duplicates)" {
    # Cross-task guard. Task 11 consumes ALERT_SMTP_USER, ALERT_SMTP_PASSWORD
    # and STALWART_API_KEY from ops.env; if it ALSO appends its own copy of one,
    # load_env exits 2 and every ops.env consumer dies at once. This catches that
    # the moment the template gains the second spelling.
    render
    local f dupes
    for f in state app-blue app-green mail ops; do
        dupes="$(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "${ENV_DIR}/${f}.env" \
                 | sed 's/=.*//' | sort | uniq -d)"
        [ -z "$dupes" ] || { echo "${f}.env declares twice: ${dupes}"; return 1; }
    done
}

@test "every leaf URL in an app env file names its own colour" {
    render
    local leaf key url
    for leaf in content finance files votes messages newsletter calendar board vault; do
        key="$(printf '%s' "$leaf" | tr '[:lower:]' '[:upper:]')_SERVICE_URL"
        url="$(value_of "${ENV_DIR}/app-blue.env" "$key")"
        [ "$url" = "http://${leaf}-service-blue:8080" ] \
            || { echo "app-blue ${key}=${url}"; return 1; }
        url="$(value_of "${ENV_DIR}/app-green.env" "$key")"
        [ "$url" = "http://${leaf}-service-green:8080" ] \
            || { echo "app-green ${key}=${url}"; return 1; }
    done
    [ "$(value_of "${ENV_DIR}/app-blue.env"  INTERNAL_BASE_URL)" = "http://gremion-ui-blue:3000" ]
    [ "$(value_of "${ENV_DIR}/app-green.env" KERNEL_BASE_URL)"   = "http://gremion-ui-green:3000" ]
}

@test "no app-tier env value names a first-party service without a colour suffix" {
    render
    local f
    for f in app-blue app-green ops mail state; do
        ! grep -nE '=http://(gremion-ui|gremion-public|[a-z]+-service)(:|/)' "${ENV_DIR}/${f}.env" \
            || { echo "${f}.env names a colourless first-party service"; return 1; }
    done
}

@test "app env subnets are read back out of the rendered state.env" {
    render
    [ "$(value_of "${ENV_DIR}/app-blue.env"  APP_V4_SUBNET)" \
      = "$(value_of "${ENV_DIR}/state.env" APP_BLUE_V4_SUBNET)" ]
    [ "$(value_of "${ENV_DIR}/app-green.env" APP_V6_SUBNET)" \
      = "$(value_of "${ENV_DIR}/state.env" APP_GREEN_V6_SUBNET)" ]
    [ -n "$(value_of "${ENV_DIR}/app-blue.env" APP_V4_SUBNET)" ]
}

@test "a missing state key aborts the render instead of writing an empty subnet" {
    # Regression guard: state_value() calls die, and die inside $( ) would only
    # kill the substitution subshell. render() must therefore assign to a local
    # and check the status BEFORE substituting, or the placeholder silently
    # becomes empty and the colour project comes up with no pinned subnet.
    copy_host_src
    sed -i '/^APP_GREEN_V6_SUBNET=/d' "${COPY_TMPL}/state.env.tmpl"
    run "$COPY_INIT" --root "$GREMION_ROOT" --stack gremion
    [ "$status" -eq 1 ]
    [[ "$output" == *"state.env does not define APP_GREEN_V6_SUBNET"* ]]
    [[ ! -f "${ENV_DIR}/app-green.env" ]]
}

# ---------------------------------------------------------------------------
# Secret generation (section G)
# ---------------------------------------------------------------------------

@test "no CHANGE_ME_GEN_ sentinel survives in any rendered file" {
    render
    ! grep -rn 'CHANGE_ME_GEN_' "$ENV_DIR"
}

@test "every CHANGE_ME_OPERATOR_ sentinel survives and is listed on stdout" {
    render
    grep -q 'CHANGE_ME_OPERATOR_platform_domain' "${ENV_DIR}/state.env"
    [[ "$output" == *"state.env: PLATFORM_DOMAIN"* ]]
    [[ "$output" == *"state.env: EDGE_BIND_IP"* ]]
}

@test "hex32 groups render 64 hex characters and alnum32 groups 32 alnum characters" {
    render
    local v
    v="$(value_of "${ENV_DIR}/state.env" AUTH_SECRET)"
    [[ "$v" =~ ^[0-9a-f]{64}$ ]] || { echo "AUTH_SECRET=${v}"; return 1; }
    v="$(value_of "${ENV_DIR}/state.env" POSTGRES_PASSWORD)"
    [[ "$v" =~ ^[A-Za-z0-9]{32}$ ]] || { echo "POSTGRES_PASSWORD=${v}"; return 1; }
}

@test "keys sharing a sentinel group render the same value (OIDC alias equality)" {
    render
    [ "$(value_of "${ENV_DIR}/state.env" AUTH_KEYCLOAK_SECRET)" \
      = "$(value_of "${ENV_DIR}/state.env" GREMION_UI_OIDC_CLIENT_SECRET)" ]
    [ "$(value_of "${ENV_DIR}/state.env" KEYCLOAK_ADMIN_CLIENT_SECRET)" \
      = "$(value_of "${ENV_DIR}/state.env" GREMION_ADMIN_OIDC_CLIENT_SECRET)" ]
    [ -n "$(value_of "${ENV_DIR}/state.env" AUTH_KEYCLOAK_SECRET)" ]
}

@test "the reader password embedded in GREMION_PUBLIC_DB_URL matches PUBLIC_DB_PASSWORD" {
    render
    local pw url
    pw="$(value_of "${ENV_DIR}/state.env" PUBLIC_DB_PASSWORD)"
    url="$(value_of "${ENV_DIR}/state.env" GREMION_PUBLIC_DB_URL)"
    [ -n "$pw" ]
    [[ "$url" == *":${pw}@"* ]] || { echo "url=${url}"; return 1; }
}

@test "mail.env and ops.env reuse the platform SMTP password and the Stalwart API key" {
    render
    local pw key
    pw="$(value_of "${ENV_DIR}/state.env" PLATFORM_SMTP_PASSWORD)"
    key="$(value_of "${ENV_DIR}/state.env" STALWART_API_KEY)"
    [ -n "$pw" ] && [ -n "$key" ]
    [ "$(value_of "${ENV_DIR}/mail.env"     PLATFORM_SMTP_PASSWORD)" = "$pw" ]
    [ "$(value_of "${ENV_DIR}/ops.env"      ALERT_SMTP_PASSWORD)" = "$pw" ]
    [ "$(value_of "${ENV_DIR}/app-blue.env" PLATFORM_SMTP_PASSWORD)" = "$pw" ]
    [ "$(value_of "${ENV_DIR}/mail.env"     STALWART_API_KEY)" = "$key" ]
    [ "$(value_of "${ENV_DIR}/ops.env"      STALWART_API_KEY)" = "$key" ]
    # Task 11's render-ops.sh reads ALERT_SMTP_PASSWORD from ops.env and
    # appends no copy of it (load_env would refuse the duplicate with exit 2).
    [ "$(grep -c '^ALERT_SMTP_PASSWORD=' "${ENV_DIR}/ops.env")" = 1 ]
}

@test "two roots receive different secrets" {
    render
    local a b other
    a="$(value_of "${ENV_DIR}/state.env" AUTH_SECRET)"
    other="$(mktemp -d)"
    run "$INIT" --root "$other" --stack staging
    [ "$status" -eq 0 ]
    b="$(value_of "${other}/etc/env/state.env" AUTH_SECRET)"
    rm -rf "$other"
    [ -n "$a" ] && [ -n "$b" ] && [ "$a" != "$b" ]
}

# ---------------------------------------------------------------------------
# Overwrite refusal
# ---------------------------------------------------------------------------

@test "refuses to overwrite an existing env file (exit 2); --force replaces it" {
    render
    [ "$status" -eq 0 ]
    local first; first="$(value_of "${ENV_DIR}/state.env" AUTH_SECRET)"

    render
    [ "$status" -eq 2 ]
    [[ "$output" == *"refusing to overwrite"* ]]
    [[ "$output" == *"state.env"* ]]
    [ "$(value_of "${ENV_DIR}/state.env" AUTH_SECRET)" = "$first" ]

    render --force
    [ "$status" -eq 0 ]
    [ "$(value_of "${ENV_DIR}/state.env" AUTH_SECRET)" != "$first" ]
}

# ---------------------------------------------------------------------------
# Sentinel-grammar guards
# ---------------------------------------------------------------------------

@test "a longer sentinel group containing a shorter one is substituted correctly" {
    copy_host_src
    printf 'PROBE_SHORT=CHANGE_ME_GEN_hex32_pg\nPROBE_LONG=CHANGE_ME_GEN_hex32_pg_root\n' \
        >> "${COPY_TMPL}/state.env.tmpl"
    run "$COPY_INIT" --root "$GREMION_ROOT" --stack gremion
    [ "$status" -eq 0 ]
    local s l
    s="$(value_of "${ENV_DIR}/state.env" PROBE_SHORT)"
    l="$(value_of "${ENV_DIR}/state.env" PROBE_LONG)"
    [[ "$s" =~ ^[0-9a-f]{64}$ ]] || { echo "PROBE_SHORT=${s}"; return 1; }
    [[ "$l" =~ ^[0-9a-f]{64}$ ]] || { echo "PROBE_LONG=${l}"; return 1; }
    [ "$s" != "$l" ]
}

@test "exits 2 when one group is declared with two different kinds" {
    copy_host_src
    printf 'PROBE_A=CHANGE_ME_GEN_hex32_probe\nPROBE_B=CHANGE_ME_GEN_alnum32_probe\n' \
        >> "${COPY_TMPL}/state.env.tmpl"
    run "$COPY_INIT" --root "$GREMION_ROOT" --stack gremion
    [ "$status" -eq 2 ]
    [[ "$output" == *"probe"* ]]
    [[ "$output" == *"hex32"* ]]
    [[ "$output" == *"alnum32"* ]]
}

# ---------------------------------------------------------------------------
# Parity with the kernel .env.example, and the load_env gate
# ---------------------------------------------------------------------------

@test "state.env.tmpl declares every CHANGE_ME_ key of the kernel .env.example" {
    # Parity guard in the spirit of test/backup.bats: a secret key added to the
    # kernel's .env.example must not silently miss the host env contract, which
    # is how a service reaches production with an empty credential.
    local example="${KERNEL_ROOT}/.env.example"
    local tmpl="${HOST_SRC}/templates/env/state.env.tmpl"
    [[ -f "$example" && -f "$tmpl" ]]
    local keys key
    keys="$(grep -E '^[A-Za-z_][A-Za-z0-9_]*=.*CHANGE_ME_' "$example" | sed 's/=.*//' | sort -u)"
    [[ -n "$keys" ]]
    for key in $keys; do
        grep -qE "^${key}=" "$tmpl" \
            || { echo "state.env.tmpl is missing kernel secret key: ${key}"; return 1; }
    done
}

@test "state.env.tmpl declares the seven secrets that ship empty in the kernel" {
    local tmpl="${HOST_SRC}/templates/env/state.env.tmpl"
    local key
    for key in AUTH_SECRET AUTH_KEYCLOAK_SECRET KEYCLOAK_ADMIN_CLIENT_SECRET \
               SYNAPSE_REGISTRATION_SHARED_SECRET SYNAPSE_ADMIN_TOKEN \
               HELIOS_SECRET_KEY HELIOS_KEYCLOAK_CLIENT_SECRET FINTS_PASSWORD_KEY; do
        grep -qE "^${key}=CHANGE_ME_GEN_" "$tmpl" \
            || { echo "not covered by a generated sentinel: ${key}"; return 1; }
    done
}

@test "a freshly rendered state.env loads only with ALLOW_SENTINELS=1" {
    render
    run bash -c 'set -euo pipefail; . "$0"; load_env "$1"' \
        "${HOST_SRC}/lib/common.sh" "${ENV_DIR}/state.env"
    [ "$status" -eq 2 ]
    [[ "$output" == *"CHANGE_ME_OPERATOR_"* ]]

    run bash -c 'set -euo pipefail; . "$0"; ALLOW_SENTINELS=1 load_env "$1"; echo "STACK=$STACK"' \
        "${HOST_SRC}/lib/common.sh" "${ENV_DIR}/state.env"
    [ "$status" -eq 0 ]
    [[ "$output" == *"STACK=gremion"* ]]
}

@test "rendered files carry mode 600 when the filesystem carries modes" {
    render
    if ! fs_carries_modes "$ENV_DIR"; then
        skip "filesystem does not carry POSIX modes (proven on the host instead)"
    fi
    local f
    for f in state.env app-blue.env app-green.env mail.env ops.env; do
        [ "$(stat -c '%a' "${ENV_DIR}/${f}")" = "600" ] \
            || { echo "${f} is $(stat -c '%a' "${ENV_DIR}/${f}"), not 600"; return 1; }
    done
    [ "$(stat -c '%a' "${GREMION_ROOT}/etc")" = "700" ]
}
