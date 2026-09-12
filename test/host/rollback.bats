#!/usr/bin/env bats
# Unit tests for infra/host/bin/gremion-rollback (spec A §F.5).
# Run: bats test/host/rollback.bats

load 'test_helper/host'

PROJECT_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
ROLLBACK="${PROJECT_ROOT}/infra/host/bin/gremion-rollback"

setup() {
    setup_host_root
    mkdir -p "${GREMION_ROOT}/etc/env" "${GREMION_ROOT}/runtime" \
             "${GREMION_ROOT}/releases/dist-v1.2.3" "${GREMION_ROOT}/releases/dist-v1.0.0"
    cat > "${GREMION_ROOT}/etc/env/state.env" <<'EOF'
STACK=teststack
COMPOSE_PROJECT_NAME=teststack-state
COMPOSE_FILE=docker-compose.yml
PLATFORM_DOMAIN=example.org
SOAK_MINUTES=0
RESTIC_REPOSITORY=/opt/gremion/backups/repo
RESTIC_PASSWORD=fixture-restic-password
EOF
    local c
    for c in blue green; do
        printf 'STACK=teststack\nCOLOUR=%s\nCOMPOSE_PROJECT_NAME=teststack-app-%s\nCOMPOSE_FILE=docker-compose.app.yml\n' \
            "$c" "$c" > "${GREMION_ROOT}/etc/env/app-${c}.env"
    done
    printf 'green\n'       > "${GREMION_ROOT}/runtime/active-colour"
    printf 'dist-v1.2.3\n' > "${GREMION_ROOT}/runtime/current-tag"
    printf 'dist-v1.0.0\n' > "${GREMION_ROOT}/runtime/previous-tag"
    write_release_json '["0201_x"]'
    stub_restic
}

write_release_json() { # <migrations json array>
    printf '{"tag":"dist-v1.2.3","overlap":true,"migrations":%s,"distManifestDigest":"sha256:0f9a1c2d3e4b5a69788796a5b4c3d2e1f00112233445566a78899aabbccddeef"}\n' \
        "$1" > "${GREMION_ROOT}/releases/dist-v1.2.3/release.json"
}

stub_restic() {
    shim restic '
case "$1" in
  forget)    exit 0 ;;
  snapshots) printf "[]\n"; exit 0 ;;
esac
exit 0
'
}

stub_docker_colour_up() { # <colour|none>
    export UP_COLOUR="$1"
    shim docker '
case "$1" in
  compose)
      case "$*" in
        *" ps -q"*)
            case "$*" in
              *"app-$UP_COLOUR.env"*) printf "c1\n" ;;
            esac
            exit 0 ;;
      esac
      exit 0 ;;
esac
exit 0
'
}

stub_switch() {
    shim gremion-switch 'printf "%s\n" "$1" > "$GREMION_ROOT/runtime/active-colour"; exit 0'
}

@test "gremion-rollback exists, is executable and sets strict mode" {
    [[ -x "$ROLLBACK" ]]
    grep -q '^set -euo pipefail$' "$ROLLBACK"
}

@test "gremion-rollback invokes compose only with --env-file (N20)" {
    ! grep -nE 'docker compose[^\n]*( -f | --profile | -p )' "$ROLLBACK"
}

@test "gremion-rollback carries the shellcheck source directive" {
    grep -q '^# shellcheck source=../lib/common.sh$' "$ROLLBACK"
}

@test "no active colour is a precondition failure" {
    stub_docker_colour_up none; stub_switch
    printf 'none\n' > "${GREMION_ROOT}/runtime/active-colour"
    run "$ROLLBACK"
    [ "$status" -eq 2 ]
    [[ "$output" == *"no active colour to roll back from"* ]]
}

@test "no previous tag and no --to-tag is a precondition failure" {
    stub_docker_colour_up none; stub_switch
    printf 'none\n' > "${GREMION_ROOT}/runtime/previous-tag"
    run "$ROLLBACK"
    [ "$status" -eq 2 ]
    [[ "$output" == *"no previous tag recorded"* ]]
}

@test "rolling back to the tag already running is a precondition failure" {
    stub_docker_colour_up none; stub_switch
    run "$ROLLBACK" --to-tag dist-v1.2.3
    [ "$status" -eq 2 ]
    [[ "$output" == *"already running dist-v1.2.3"* ]]
}

@test "a state.env without RESTIC_REPOSITORY is a precondition failure" {
    stub_docker_colour_up blue; stub_switch
    sed -i '/^RESTIC_REPOSITORY=/d' "${GREMION_ROOT}/etc/env/state.env"
    printf 'dist-v1.0.0\n' > "${GREMION_ROOT}/runtime/colour-blue-tag"
    run "$ROLLBACK"
    [ "$status" -eq 2 ]
    [[ "$output" == *"RESTIC_REPOSITORY absent from state.env"* ]]
}

@test "class (a): the old colour still holds the target tag — switch only" {
    stub_docker_colour_up blue
    stub_switch
    shim gremion-deploy 'exit 0'
    printf 'dist-v1.0.0\n' > "${GREMION_ROOT}/runtime/colour-blue-tag"
    run "$ROLLBACK"
    [ "$status" -eq 0 ]
    assert_recorded gremion-switch "blue"
    ! grep -q '^gremion-deploy' "$SHIM_LOG"
    [[ "$output" == *"ROLLBACK-RESULT: class=a from=dist-v1.2.3 to=dist-v1.0.0 colour=blue"* ]]
    [ "$(cat "${GREMION_ROOT}/runtime/current-tag")" = "dist-v1.0.0" ]
    [ "$(cat "${GREMION_ROOT}/runtime/previous-tag")" = "dist-v1.2.3" ]
}

@test "class (b): the old colour is gone — redeploy with --no-switch, then switch" {
    stub_docker_colour_up none
    stub_switch
    shim gremion-deploy 'printf "dist-v1.0.0\n" > "$GREMION_ROOT/runtime/colour-blue-tag"; exit 0'
    run "$ROLLBACK"
    [ "$status" -eq 0 ]
    assert_recorded gremion-deploy "dist-v1.0.0 --no-switch --soak-minutes 0"
    assert_recorded gremion-switch "blue"
    [[ "$output" == *"ROLLBACK-RESULT: class=b from=dist-v1.2.3 to=dist-v1.0.0 colour=blue"* ]]
}

@test "class (b) prints the snapshot-restore instruction when the rolled-back tag had migrations" {
    stub_docker_colour_up none
    stub_switch
    shim gremion-deploy 'exit 0'
    run "$ROLLBACK"
    [[ "$output" == *"SNAPSHOT-RESTORE-REQUIRED: dist-v1.2.3 applied 1 migration(s)"* ]]
    [[ "$output" == *"restic tag label=dist-v1.2.3 class=snapshot"* ]]
}

@test "class (b) prints no restore instruction when the rolled-back tag had no migrations" {
    stub_docker_colour_up none
    stub_switch
    shim gremion-deploy 'exit 0'
    write_release_json '[]'
    run "$ROLLBACK"
    [[ "$output" != *"SNAPSHOT-RESTORE-REQUIRED"* ]]
}

@test "class (b) without a registry token explains what to pipe in" {
    stub_docker_colour_up none
    stub_switch
    shim gremion-deploy 'exit 2'
    run "$ROLLBACK"
    [ "$status" -eq 2 ]
    [[ "$output" == *"class (b) rollback needs the registry token on stdin"* ]]
}

@test "a switch that does not take effect fails the rollback" {
    stub_docker_colour_up blue
    shim gremion-switch 'exit 0'
    printf 'dist-v1.0.0\n' > "${GREMION_ROOT}/runtime/colour-blue-tag"
    run "$ROLLBACK"
    [ "$status" -eq 1 ]
    [[ "$output" == *"runtime/active-colour is 'green' after switching to blue"* ]]
}

@test "the abandoned release's snapshot is forgotten when it applied no migrations" {
    stub_docker_colour_up blue
    stub_switch
    write_release_json '[]'
    printf 'dist-v1.0.0\n' > "${GREMION_ROOT}/runtime/colour-blue-tag"
    run "$ROLLBACK"
    [ "$status" -eq 0 ]
    assert_recorded restic "forget --tag class=snapshot --tag label=dist-v1.2.3"
    [[ "$output" == *"forgot the pre-release snapshot label=dist-v1.2.3"* ]]
}

@test "the abandoned release's snapshot is KEPT when it applied migrations, with the manual command" {
    stub_docker_colour_up blue
    stub_switch
    printf 'dist-v1.0.0\n' > "${GREMION_ROOT}/runtime/colour-blue-tag"
    run "$ROLLBACK"
    [ "$status" -eq 0 ]
    ! grep -q '^restic forget' "$SHIM_LOG"
    [[ "$output" == *"SNAPSHOT-RETAINED: restic tag label=dist-v1.2.3 class=snapshot"* ]]
    [[ "$output" == *"restic -r \${RESTIC_REPOSITORY} forget --tag class=snapshot --tag label=dist-v1.2.3"* ]]
}

# The colour_is_up half of the class discriminator has its own test: a STALE
# runtime/colour-<other>-tag naming the target tag while that colour's project
# holds no containers. Without this case the tag comparison alone decides, and a
# rollback would switch the public edge to a colour that is not running.
@test "a stale colour tag whose containers are gone is class (b), not a switch to nothing" {
    stub_docker_colour_up none
    stub_switch
    shim gremion-deploy 'printf "dist-v1.0.0\n" > "$GREMION_ROOT/runtime/colour-blue-tag"; exit 0'
    printf 'dist-v1.0.0\n' > "${GREMION_ROOT}/runtime/colour-blue-tag"
    run "$ROLLBACK"
    [ "$status" -eq 0 ]
    assert_recorded gremion-deploy "dist-v1.0.0 --no-switch --soak-minutes 0"
    [[ "$output" == *"ROLLBACK-RESULT: class=b from=dist-v1.2.3 to=dist-v1.0.0 colour=blue"* ]]
}

# And the tag half: the other colour IS up, but it holds some other release.
# Without the tag comparison the rollback would "succeed" by switching the
# public edge to a colour serving the wrong tag.
@test "a running colour holding a DIFFERENT tag is class (b), not a switch to the wrong release" {
    stub_docker_colour_up blue
    stub_switch
    shim gremion-deploy 'printf "dist-v1.0.0\n" > "$GREMION_ROOT/runtime/colour-blue-tag"; exit 0'
    printf 'dist-v0.9.9\n' > "${GREMION_ROOT}/runtime/colour-blue-tag"
    run "$ROLLBACK"
    [ "$status" -eq 0 ]
    assert_recorded gremion-deploy "dist-v1.0.0 --no-switch --soak-minutes 0"
    [[ "$output" == *"ROLLBACK-RESULT: class=b from=dist-v1.2.3 to=dist-v1.0.0 colour=blue"* ]]
}

@test "a dangling --to-tag exits 2 and names the option" {
    run "$ROLLBACK" --to-tag
    [ "$status" -eq 2 ]
    [[ "$output" == *"option --to-tag needs a value"* ]]
}
