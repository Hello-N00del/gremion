#!/usr/bin/env bats
# Tests for the compose bind-mount source preflight and the bootstrap that
# generates the two untracked sources (internal-ca.pem, pgbouncer userlist.txt).
#   scripts/check-bind-sources.sh        -- fails loudly BEFORE `compose up`
#   scripts/render-pgbouncer-userlist.sh -- dev/bootstrap twin of gremion-render
# Run: bats test/bind-sources.bats

load 'host/test_helper/host'

PROJECT_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
CHECK="${PROJECT_ROOT}/scripts/check-bind-sources.sh"
RENDER="${PROJECT_ROOT}/scripts/render-pgbouncer-userlist.sh"

setup() {
    T="$(mktemp -d)"
}

teardown() {
    rm -rf "$T"
}

# A throwaway tree: the real compose files and tracked sources, none of the
# generated ones (gitignored files are not copied).
make_tree() {
    cd "$PROJECT_ROOT"
    git ls-files -z -- 'docker-compose*.yml' compose docker modules/messaging | xargs -0 -I{} cp --parents {} "$T"
}

@test "preflight: a fresh tree names internal-ca.pem and its generator, and exits non-zero" {
    make_tree
    run "$CHECK" --root "$T"
    [ "$status" -eq 1 ]
    [[ "$output" == *"docker/keycloak/certs/internal-ca.pem"* ]]
    [[ "$output" == *"gen-internal-ca.sh"* ]]
}

@test "preflight: with --all it also names the pgbouncer userlist and its renderer" {
    make_tree
    run "$CHECK" --root "$T" --all
    [ "$status" -eq 1 ]
    [[ "$output" == *"docker/pgbouncer/userlist.txt"* ]]
    [[ "$output" == *"render-pgbouncer-userlist.sh"* ]]
}

@test "preflight: the only missing sources in a fresh checkout are the two generated ones" {
    make_tree
    run "$CHECK" --root "$T" --all
    [ "$status" -eq 1 ]
    local n
    n="$(printf '%s\n' "$output" | grep -c '^MISSING ')"
    [ "$n" -eq 2 ] || { echo "$output"; return 1; }
}

@test "preflight: a tree with every source present passes" {
    make_tree
    echo ca > "$T/docker/keycloak/certs/internal-ca.pem"
    echo u > "$T/docker/pgbouncer/userlist.txt"
    run "$CHECK" --root "$T" --all
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
}

@test "preflight: a directory where a file belongs (compose-created) fails" {
    make_tree
    mkdir -p "$T/docker/keycloak/certs/internal-ca.pem"
    run "$CHECK" --root "$T"
    [ "$status" -eq 1 ]
    [[ "$output" == *"is a directory"* ]]
    [[ "$output" == *"internal-ca.pem"* ]]
}

@test "preflight: an unknown missing source is reported as having NO generator" {
    cat > "$T/docker-compose.yml" <<'YML'
services:
  x:
    image: busybox
    volumes:
      - ./docker/mystery.conf:/etc/mystery.conf:ro
YML
    run "$CHECK" --root "$T" docker-compose.yml
    [ "$status" -eq 1 ]
    [[ "$output" == *"docker/mystery.conf"* ]]
    [[ "$output" == *"no generator"* ]]
}

@test "preflight: sources are resolved against the compose file's own directory" {
    mkdir -p "$T/compose/sub"
    cat > "$T/compose/sub/docker-compose.yml" <<'YML'
services:
  x:
    image: busybox
    volumes:
      - "../../docker/a.yaml:/a:ro"
      - ./b.yml:/b:ro
YML
    run "$CHECK" --root "$T" compose/sub/docker-compose.yml
    [ "$status" -eq 1 ]
    [[ "$output" == *"docker/a.yaml"* ]]
    [[ "$output" == *"compose/sub/b.yml"* ]]
}

@test "preflight: named volumes, variable sources and absolute paths are not judged" {
    cat > "$T/docker-compose.yml" <<'YML'
services:
  x:
    image: busybox
    volumes:
      - data:/data
      - ${SOMEWHERE:-./secrets/tenants}:/t:ro
      - /var/run/docker.sock:/s
YML
    run "$CHECK" --root "$T" docker-compose.yml
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
}

@test "preflight: every source the real compose files mount is tracked or has a generator" {
    [ -x "$CHECK" ]
    run "$CHECK" --root "$PROJECT_ROOT" --all
    [[ "$output" == *"MISSING"* || "$status" -eq 0 ]]
    [[ "$output" != *"no generator"* ]] || { echo "$output"; return 1; }
}

@test "render-pgbouncer-userlist: writes a 0600 userlist carrying only pgbouncer_auth" {
    mkdir -p "$T/docker/pgbouncer"
    printf 'PGBOUNCER_AUTH_PASSWORD=s3cretvalue123\nOTHER=x\n' > "$T/.env"
    run "$RENDER" --root "$T"
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    [ -f "$T/docker/pgbouncer/userlist.txt" ]
    [ "$(stat -c %a "$T/docker/pgbouncer/userlist.txt")" = "600" ]
    [ "$(cat "$T/docker/pgbouncer/userlist.txt")" = '"pgbouncer_auth" "s3cretvalue123"' ]
    [[ "$output" != *"s3cretvalue123"* ]]
}

@test "render-pgbouncer-userlist: refuses a CHANGE_ME sentinel and writes nothing" {
    mkdir -p "$T/docker/pgbouncer"
    printf 'PGBOUNCER_AUTH_PASSWORD=CHANGE_ME_pgbouncer_auth\n' > "$T/.env"
    [ -x "$RENDER" ]
    run "$RENDER" --root "$T"
    [ "$status" -ne 0 ]
    [[ "$output" == *"CHANGE_ME"* ]]
    [ ! -e "$T/docker/pgbouncer/userlist.txt" ]
}

@test "render-pgbouncer-userlist: refuses a missing or empty key" {
    mkdir -p "$T/docker/pgbouncer"
    printf 'A=b\n' > "$T/.env"
    [ -x "$RENDER" ]
    run "$RENDER" --root "$T"
    [ "$status" -ne 0 ]
    [[ "$output" == *"PGBOUNCER_AUTH_PASSWORD"* ]]
    printf 'PGBOUNCER_AUTH_PASSWORD=\n' > "$T/.env"
    run "$RENDER" --root "$T"
    [ "$status" -ne 0 ]
    [ ! -e "$T/docker/pgbouncer/userlist.txt" ]
}

@test "render-pgbouncer-userlist: rewrites when the password rotated, keeps 0600" {
    mkdir -p "$T/docker/pgbouncer"
    printf 'PGBOUNCER_AUTH_PASSWORD=first1\n' > "$T/.env"
    "$RENDER" --root "$T" >/dev/null
    printf 'PGBOUNCER_AUTH_PASSWORD=second2\n' > "$T/.env"
    "$RENDER" --root "$T" >/dev/null
    [ "$(cat "$T/docker/pgbouncer/userlist.txt")" = '"pgbouncer_auth" "second2"' ]
    [ "$(stat -c %a "$T/docker/pgbouncer/userlist.txt")" = "600" ]
}

@test "bootstrap wiring: setup.sh generates both sources and runs the preflight" {
    assert_present 'gen-internal-ca\.sh' "${PROJECT_ROOT}/scripts/setup.sh"
    assert_present 'render-pgbouncer-userlist\.sh' "${PROJECT_ROOT}/scripts/setup.sh"
    assert_present 'check-bind-sources\.sh' "${PROJECT_ROOT}/scripts/setup.sh"
}

@test "bootstrap wiring: make up and rebuild depend on the preflight" {
    assert_present '^preflight:' "${PROJECT_ROOT}/Makefile"
    assert_present '^up: .*preflight' "${PROJECT_ROOT}/Makefile"
    assert_present '^rebuild: .*preflight' "${PROJECT_ROOT}/Makefile"
}

@test "docs: DEVELOPMENT.md and the pgbouncer runbook name the preflight and the generators" {
    assert_present 'check-bind-sources' "${PROJECT_ROOT}/docs/DEVELOPMENT.md"
    assert_present 'render-pgbouncer-userlist' "${PROJECT_ROOT}/docs/DEVELOPMENT.md"
    assert_present 'check-bind-sources' "${PROJECT_ROOT}/docs/runbooks/pgbouncer.md"
}

@test "the real userlist stays gitignored and the committed example stays a placeholder" {
    assert_present '^docker/pgbouncer/userlist\.txt$' "${PROJECT_ROOT}/.gitignore"
    assert_absent 'pgbouncer_auth" "[A-Za-z0-9]{20,}' "${PROJECT_ROOT}/docker/pgbouncer/userlist.txt.example"
}
