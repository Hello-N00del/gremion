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
    stub_dump_status
    # A started-directly rollback takes runtime/hostd.lock. The default here is
    # a free lock (flock succeeds), so Git Bash, which carries no util-linux
    # flock, runs the suite too; the lock tests below replace this shim, or
    # remove it to use the real flock.
    shim flock 'exit 0'
}

teardown() {
    teardown_host_root
}

write_release_json() { # <migrations json array>
    printf '{"tag":"dist-v1.2.3","overlap":true,"migrations":%s,"distManifestDigest":"sha256:0f9a1c2d3e4b5a69788796a5b4c3d2e1f00112233445566a78899aabbccddeef"}\n' \
        "$1" > "${GREMION_ROOT}/releases/dist-v1.2.3/release.json"
}

# TASK-075: gremion-migration-dump status answers LIVE_DUMPS live dump(s) of
# dist-v1.2.3 (default none: the switch succeeded and deleted it).
stub_dump_status() {
    shim gremion-migration-dump '
[ "$1" = status ] || exit 0
n="${LIVE_DUMPS:-0}"
i=0
while [ "$i" -lt "$n" ]; do
  printf "LIVE 0192f0c1-2b3c-7d4e-8f00-00000000000%s release=dist-v1.2.3 db=gremion taken=t bytes=1 file=dist-v1.2.3/gremion.x.dump\n" "$i"
  i=$((i + 1))
done
printf "STATUS: %s live dump(s)\n" "$n"
exit "${DUMP_STATUS_EXIT:-0}"
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

@test "TASK-075: rollback no longer needs restic or RESTIC_REPOSITORY (step 5 takes no restic snapshot)" {
    stub_docker_colour_up blue; stub_switch
    sed -i '/^RESTIC_/d' "${GREMION_ROOT}/etc/env/state.env"
    shim restic 'exit 1'
    printf 'dist-v1.0.0\n' > "${GREMION_ROOT}/runtime/colour-blue-tag"
    run "$ROLLBACK"
    [ "$status" -eq 0 ]
    assert_absent '^restic' "$SHIM_LOG" 'rollback still calls restic'
}

@test "class (a): the old colour still holds the target tag — switch only" {
    stub_docker_colour_up blue
    stub_switch
    shim gremion-deploy 'exit 0'
    printf 'dist-v1.0.0\n' > "${GREMION_ROOT}/runtime/colour-blue-tag"
    run "$ROLLBACK"
    [ "$status" -eq 0 ]
    assert_recorded gremion-switch "blue"
    assert_absent '^gremion-deploy' "$SHIM_LOG" \
        'class (a) is switch-only: it must not re-invoke gremion-deploy'
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

@test "class (b) says the rolled-back tag's migrations are not reverted, and that no dump exists after its succeeded switch" {
    stub_docker_colour_up none
    stub_switch
    shim gremion-deploy 'exit 0'
    run "$ROLLBACK"
    [[ "$output" == *"MIGRATIONS-NOT-REVERTED: dist-v1.2.3 applied 1 migration(s)"* ]]
    [[ "$output" == *"NO-DUMP: no pre-migration dump of dist-v1.2.3 exists"* ]]
    [[ "$output" != *"restic"* ]]
}

@test "class (b) prints no not-reverted line when the rolled-back tag had no migrations" {
    stub_docker_colour_up none
    stub_switch
    shim gremion-deploy 'exit 0'
    write_release_json '[]'
    run "$ROLLBACK"
    [[ "$output" != *"MIGRATIONS-NOT-REVERTED"* ]]
}

@test "class (b) with a LIVE pre-migration dump exits 3 naming status, restore and discard, before any redeploy" {
    stub_docker_colour_up none
    stub_switch
    shim gremion-deploy 'exit 0'
    export LIVE_DUMPS=1
    run "$ROLLBACK"
    [ "$status" -eq 3 ]
    [[ "$output" == *"BLOCKED: 1 live pre-migration dump(s)"* ]]
    [[ "$output" == *"gremion-migration-dump status"* ]]
    [[ "$output" == *"gremion-migration-dump restore --release <R> --db <D> --accept-loss-since <time>"* ]]
    [[ "$output" == *"gremion-migration-dump discard --release <R> --reason <text>"* ]]
    assert_absent '^gremion-deploy' "$SHIM_LOG" 'class (b) redeployed over a live dump'
}

@test "an unreadable dump status is a refusal, never read as no dump" {
    stub_docker_colour_up none
    stub_switch
    shim gremion-deploy 'exit 0'
    export DUMP_STATUS_EXIT=1
    run "$ROLLBACK"
    [ "$status" -eq 1 ]
    [[ "$output" == *"gremion-migration-dump status failed"* ]]
    assert_absent '^gremion-deploy' "$SHIM_LOG" 'rollback redeployed without knowing the dump state'
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

@test "class (a) after a succeeded switch says no dump exists (TRD 6, R18-4) and deletes nothing" {
    stub_docker_colour_up blue
    stub_switch
    printf 'dist-v1.0.0\n' > "${GREMION_ROOT}/runtime/colour-blue-tag"
    run "$ROLLBACK"
    [ "$status" -eq 0 ]
    assert_recorded gremion-migration-dump "status --release dist-v1.2.3"
    [[ "$output" == *"NO-DUMP: no pre-migration dump of dist-v1.2.3 exists — it was deleted when its switch succeeded"* ]]
    assert_absent 'gremion-migration-dump (switched|discard)' "$SHIM_LOG" 'rollback deleted a dump'
}

@test "class (a) with a live dump of the abandoned release names it and the restore/discard exit" {
    stub_docker_colour_up blue
    stub_switch
    export LIVE_DUMPS=1
    printf 'dist-v1.0.0\n' > "${GREMION_ROOT}/runtime/colour-blue-tag"
    run "$ROLLBACK"
    [ "$status" -eq 0 ]
    [[ "$output" == *"DUMP-LIVE: 1 live pre-migration dump(s) of dist-v1.2.3"* ]]
    [[ "$output" == *"gremion-migration-dump restore --release dist-v1.2.3 --db <D> --accept-loss-since <time>, then discard --release dist-v1.2.3 --reason <text>"* ]]
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

# ---------------------------------------------------------------------------
# One host operation at a time (kernel #62 follow-up). gremion-hostd takes
# runtime/hostd.lock for its mutating verbs; a rollback started directly (an
# operator at the host, not through the daemon) takes the same lock itself and
# fails closed when it is held, as gremion-deploy and gremion-backup do.
# ---------------------------------------------------------------------------

@test "a rollback started directly while another host operation holds the lock is busy (exit 3) and touches nothing" {
    stub_docker_colour_up none; stub_switch
    shim gremion-deploy 'exit 0'
    shim flock 'exit 1'
    run "$ROLLBACK"
    [ "$status" -eq 3 ]
    [[ "$output" == *"busy: another host operation is running"* ]]
    [[ "$output" == *"runtime/hostd.lock"* ]]
    assert_recorded flock "-n 9"
    assert_absent '^(gremion-deploy|gremion-switch|gremion-migration-dump|docker) ' "$SHIM_LOG" \
        'a rollback that lost the lock still acted on the host'
    [ "$(cat "${GREMION_ROOT}/runtime/current-tag")" = "dist-v1.2.3" ]
    [ "$(cat "${GREMION_ROOT}/runtime/active-colour")" = "green" ]
}

@test "a rollback started by gremion-hostd (lock already held by its parent) does not take the lock again" {
    stub_docker_colour_up none; stub_switch
    shim flock 'exit 1'
    # it got past the lock stage: the next precondition is what stopped it
    GREMION_HOST_LOCK_HELD=1 run "$ROLLBACK" --to-tag dist-v1.2.3
    [ "$status" -eq 2 ]
    [[ "$output" == *"already running dist-v1.2.3"* ]]
    [[ "$output" != *"busy"* ]]
    assert_absent '^flock ' "$SHIM_LOG" 'a rollback queued behind its own parent'
}

@test "a rollback that took the lock tells the deploy it starts that it is held (it must not queue behind its parent)" {
    stub_docker_colour_up none; stub_switch
    # the deploy stub records what it saw and then answers exit 2 (no token),
    # which ends the run right there with the documented message
    shim gremion-deploy 'printf "%s\n" "${GREMION_HOST_LOCK_HELD-unset}" > "$GREMION_ROOT/deploy-saw-lock"; exit 2'
    unset GREMION_HOST_LOCK_HELD
    run "$ROLLBACK"
    [ "$status" -eq 2 ]
    [[ "$output" == *"class (b) rollback needs the registry token on stdin"* ]]
    assert_recorded flock "-n 9"
    [ "$(cat "${GREMION_ROOT}/deploy-saw-lock")" = "1" ]
}

@test "a rollback started directly takes the real host lock: a held lock refuses it" {
    rm -f "${SHIM_DIR}/flock"   # the real flock or none: the setup's shim must not answer the check below
    command -v flock >/dev/null 2>&1 || skip "flock (util-linux) is not installed"
    stub_docker_colour_up blue; stub_switch
    printf 'dist-v1.0.0\n' > "${GREMION_ROOT}/runtime/colour-blue-tag"
    unset GREMION_HOST_LOCK_HELD
    hold_host_lock 20
    run "$ROLLBACK"
    release_host_lock
    [ "$status" -eq 3 ]
    [[ "$output" == *"busy"* ]]
    assert_absent '^gremion-switch ' "$SHIM_LOG" 'the switch ran without the host lock'
}

@test "a rollback holds the host lock while it runs and releases it when it ends" {
    rm -f "${SHIM_DIR}/flock"   # the real flock or none: the setup's shim must not answer the check below
    command -v flock >/dev/null 2>&1 || skip "flock (util-linux) is not installed"
    stub_docker_colour_up blue
    printf 'dist-v1.0.0\n' > "${GREMION_ROOT}/runtime/colour-blue-tag"
    # the switch runs mid-rollback: it tries the lock from a fresh process and
    # records whether it could take it (it must NOT be able to, while the
    # rollback holds it)
    shim gremion-switch 'printf "%s\n" "$1" > "$GREMION_ROOT/runtime/active-colour"
        if flock -n "$GREMION_ROOT/runtime/hostd.lock" true; then echo free; else echo held; fi > "$GREMION_ROOT/lock-during"
        exit 0'
    unset GREMION_HOST_LOCK_HELD
    run "$ROLLBACK"
    [ "$status" -eq 0 ]
    [ "$(cat "${GREMION_ROOT}/lock-during")" = "held" ]
    # and once it has ended nothing keeps the lock
    run flock -n "${GREMION_ROOT}/runtime/hostd.lock" true
    [ "$status" -eq 0 ]
}
