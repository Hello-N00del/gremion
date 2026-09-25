#!/usr/bin/env bats
# Tests for infra/host/bin/gremion-validate-env, the one-reader guard, and the
# PLATFORM_DOMAIN binding of the production render (TASK-028; spec B section 6,
# B15 tasks 3, 4 and the single-reader rule).
# Run: bats test/host/validate-env.bats
#
# Unit only.

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
        ! grep -qE '^[A-Za-z_][A-Za-z0-9_]*=.*CHANGE_ME_' "$f" || { echo "sentinel left in $f"; return 1; }
    done
    touch "$RELEASE"/docker-compose.yml "$RELEASE"/docker-compose.prod.yml \
          "$RELEASE"/docker-compose.pins.yml "$RELEASE"/docker-compose.app.yml
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
    rm "$RELEASE/docker-compose.pins.yml"
    run "$VALIDATE" --env-file "${ENV_DIR}/state.env" --release "$RELEASE"
    [ "$status" -eq 1 ]
    [[ "$output" == *"docker-compose.pins.yml"* ]]
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

# second_readers <dir> -> every line under <dir> that reads an env file some
# other way than load_env: `set -a` (the source-everything idiom), sourcing or
# dotting a *.env file, or `export $(cat|grep|sed ...)`.
second_readers() {
    grep -rnE \
        -e '(^|[;&|[:space:]])set[[:space:]]+-a([[:space:]]|;|$)' \
        -e '(^|[;&|[:space:]])(source|\.)[[:space:]]+[^;&|#]*\.env([^A-Za-z0-9_.]|$)' \
        -e 'export[[:space:]]+"?\$\((cat|grep|sed|xargs|awk)' \
        "$1" \
        | grep -vE '^[^:]+:[0-9]+:[[:space:]]*#' || true
}

@test "load_env is the only env reader under infra/host/" {
    run second_readers "$HOST_SRC"
    [ "$status" -eq 0 ]
    [ -z "$output" ] || { echo "second env reader(s):"; echo "$output"; return 1; }
}

@test "the one-reader guard is RED on a seeded 'set -a; .', 'source x.env' and 'export \$(cat ...)'" {
    local copy="${GREMION_ROOT}/host-src"
    cp -r "$HOST_SRC" "$copy"
    printf '#!/usr/bin/env bash\nset -a; . "$ENV_FILE"; set +a\n' > "$copy/bin/gremion-seeded-1"
    printf '#!/usr/bin/env bash\nsource /opt/gremion/etc/env/state.env\n' > "$copy/bin/gremion-seeded-2"
    printf '#!/usr/bin/env bash\nexport $(cat /opt/gremion/etc/env/app-blue.env | xargs)\n' > "$copy/ops/seeded-3.sh"
    run second_readers "$copy"
    [[ "$output" == *"gremion-seeded-1"* ]]
    [[ "$output" == *"gremion-seeded-2"* ]]
    [[ "$output" == *"seeded-3.sh"* ]]
    # and a commented mention is not a reader
    printf '#!/usr/bin/env bash\n# never: set -a; . state.env\n' > "$copy/bin/gremion-seeded-4"
    run second_readers "$copy"
    [[ "$output" != *"gremion-seeded-4"* ]]
}
