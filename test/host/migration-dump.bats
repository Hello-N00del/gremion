#!/usr/bin/env bats
# Unit tests for infra/host/bin/gremion-migration-dump (TASK-075, TRD-206).
# docker and logger are recording shims; the POSIX mode/owner checks are real,
# so this file runs in the Linux bats runner (make test-host-docker) or CI.
# Run: bats test/host/migration-dump.bats

load 'test_helper/host'

PROJECT_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
TOOL="${PROJECT_ROOT}/infra/host/bin/gremion-migration-dump"

setup() {
    setup_host_root
    DUMPS="${GREMION_ROOT}/migration-dumps"
    export DUMPS
    cat > "${GREMION_ROOT}/etc/env/state.env" <<EOF
STACK=teststack
POSTGRES_USER=postgres
GREMION_DB_NAME=gremion
CONTROL_DB_NAME=control
GREMION_MIGRATION_DUMP_DIR=${DUMPS}
EOF
    seed_release_tree dist-v1.0.0
    seed_release_tree dist-v1.1.0
    ln -s "${GREMION_ROOT}/releases/dist-v1.0.0" "${GREMION_ROOT}/current"
    stub_docker
    shim logger 'exit 0'
}

teardown() {
    teardown_host_root
}

# A release tree with the two register files and the kernel-data chain's dir.
seed_release_tree() { # <tag>
    local d="${GREMION_ROOT}/releases/$1"
    mkdir -p "$d/scripts/migrations/runner" "$d/gremion-ui/migrations" "$d/gremion-ui/migrations-control" "$d/packages/p"
    cat > "$d/scripts/migrations/runner/chain-runners.json" <<'EOF'
{"chains":{"kernel-data":"legacy-boot","control":"legacy-boot","platform":"tenant-store","mail":"unadopted"}}
EOF
    cat > "$d/scripts/migrations/ranges.json" <<'EOF'
{"chains":[
 {"id":"kernel-data","database":"kernel","dirs":["gremion-ui/migrations","modules/content/app/migrations"]},
 {"id":"control","database":"control","dirs":["gremion-ui/migrations-control"]},
 {"id":"platform","database":"gremion_platform","dirs":["packages/p"]},
 {"id":"mail","database":"service:mail","dirs":["services/mail/migrations"]}]}
EOF
    printf 'SELECT 1;\n' > "$d/gremion-ui/migrations/0058_public_reader_grants.sql"
    printf 'SELECT 1;\n' > "$d/gremion-ui/migrations-control/006_boundary_ids_uuidv7.sql"
}

new_kernel_file() { # <tag>
    printf -- '-- gremion:phase expand\nSET lock_timeout = 5000;\n' \
        > "${GREMION_ROOT}/releases/$1/gremion-ui/migrations/0059_new.sql"
}

make_dump_dir() {
    mkdir -p "$DUMPS"
    chmod 700 "$DUMPS"
}

# docker: `ps` answers the state postgres, `exec … psql` the version/size/owner,
# `exec … pg_dump` writes a fake archive naming its database, and
# `exec -i … pg_restore --list` reads it back.
stub_docker() {
    shim docker '
case "$1" in
  ps) printf "pgc\n"; exit 0 ;;
  exec)
      args="$*"
      case "$args" in
        *"pg_dump --version"*) printf "pg_dump (PostgreSQL) %s.1\n" "${PGDUMP_MAJOR:-18}"; exit 0 ;;
        *" pg_dump -Fc"*)
            [ "${PGDUMP_EXIT:-0}" = "0" ] || { printf "partial"; exit "$PGDUMP_EXIT"; }
            printf "PGDMP fake archive dbname=%s\n" "${*: -1}"; exit 0 ;;
        *"pg_restore --list"*)
            db="$(sed -nE "s/.*dbname=([A-Za-z0-9_]+).*/\1/p")"
            printf ";\n; Archive created at 2026-09-29 03:00:00 UTC\n;     dbname: %s\n" "$db"; exit 0 ;;
        *" pg_restore "*) cat >/dev/null; exit "${RESTORE_EXIT:-0}" ;;
        *"server_version_num"*) printf "18\n"; exit 0 ;;
        *"pg_database_size"*)   printf "%s\n" "${DB_BYTES:-1000}"; exit 0 ;;
        *"pg_get_userbyid"*)    printf "gremion\n"; exit 0 ;;
        *"DROP DATABASE"*)      exit 0 ;;
      esac
      exit 0 ;;
esac
exit 0
'
}

ledger_events() { jq -r '.event' "${DUMPS}/ledger.jsonl" | tr '\n' ' '; }

# ---------------------------------------------------------------------------
# structure
# ---------------------------------------------------------------------------

@test "gremion-migration-dump exists, is executable, sets strict mode and the shellcheck source directive" {
    [[ -x "$TOOL" ]]
    grep -q '^set -euo pipefail$' "$TOOL"
    grep -q '^# shellcheck source=../lib/common.sh$' "$TOOL"
}

@test "no command, or an unknown one, is usage (exit 2)" {
    run "$TOOL"
    [ "$status" -eq 2 ]
    run "$TOOL" frobnicate --release dist-v1.1.0
    [ "$status" -eq 2 ]
}

# ---------------------------------------------------------------------------
# preflight: the host-side dump for legacy-boot chains (Q11)
# ---------------------------------------------------------------------------

@test "preflight on a fresh host (no current release) takes no dump and creates the dir 0700" {
    rm -f "${GREMION_ROOT}/current"
    new_kernel_file dist-v1.1.0
    run "$TOOL" preflight --release dist-v1.1.0
    [ "$status" -eq 0 ]
    [[ "$output" == *"PREFLIGHT-OK release=dist-v1.1.0"* ]]
    refute_recorded docker "pg_dump -Fc"
    [ "$(stat -c '%a' "$DUMPS")" = "700" ]
}

@test "a new legacy-boot file: ONE host dump via docker exec pg_dump -Fc --no-owner, recorded and logged" {
    make_dump_dir
    new_kernel_file dist-v1.1.0
    run "$TOOL" preflight --release dist-v1.1.0
    [ "$status" -eq 0 ]
    assert_recorded docker "exec pgc pg_dump -Fc --no-owner -U postgres gremion"
    [ "$(grep -c 'pg_dump -Fc' "$SHIM_LOG")" -eq 1 ]
    [ "$(ledger_events)" = "created " ]
    local f; f="${DUMPS}/$(jq -r '.file' "${DUMPS}/ledger.jsonl")"
    [ -f "$f" ]
    [ "$(stat -c '%a' "$f")" = "600" ]
    [ "$(stat -c '%a' "${DUMPS}/dist-v1.1.0")" = "700" ]
    [ "$(jq -r '.sha256' "${DUMPS}/ledger.jsonl")" = "$(sha256sum "$f" | cut -d' ' -f1)" ]
    [ "$(jq -r '.bytes' "${DUMPS}/ledger.jsonl")" = "$(stat -c '%s' "$f")" ]
    [[ "$(jq -r '.migration_dump_id' "${DUMPS}/ledger.jsonl")" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]]
    [[ "$output" == *"premigration-dump created id="*"release=dist-v1.1.0 db=gremion sha256="* ]]
    assert_recorded logger "-t premigration-dump -- premigration-dump created"
    # the control chain gained nothing: no dump of it
    refute_recorded docker "pg_dump -Fc --no-owner -U postgres control"
}

@test "no new legacy-boot file: no dump at all" {
    make_dump_dir
    run "$TOOL" preflight --release dist-v1.1.0
    [ "$status" -eq 0 ]
    refute_recorded docker "pg_dump -Fc"
    [ ! -e "${DUMPS}/ledger.jsonl" ]
}

@test "the same tag's retry reuses its live dump (no second pg_dump, no second line)" {
    make_dump_dir
    new_kernel_file dist-v1.1.0
    run "$TOOL" preflight --release dist-v1.1.0
    [ "$status" -eq 0 ]
    run "$TOOL" preflight --release dist-v1.1.0
    [ "$status" -eq 0 ]
    [[ "$output" == *"premigration-dump reused id="* ]]
    [ "$(grep -c 'pg_dump -Fc' "$SHIM_LOG")" -eq 1 ]
    [ "$(ledger_events)" = "created " ]
}

@test "never a series: another release's live dump refuses, printing restore and discard, before any pg_dump" {
    make_dump_dir
    new_kernel_file dist-v1.1.0
    run "$TOOL" preflight --release dist-v1.1.0
    [ "$status" -eq 0 ]
    : > "$SHIM_LOG"
    seed_release_tree dist-v1.2.0
    new_kernel_file dist-v1.2.0
    run "$TOOL" preflight --release dist-v1.2.0
    [ "$status" -eq 1 ]
    [[ "$output" == *"DUMP_SERIES: live pre-migration dump"*"of release dist-v1.1.0 for database gremion"* ]]
    [[ "$output" == *"gremion-migration-dump restore --release dist-v1.1.0 --db gremion --accept-loss-since <time>"* ]]
    [[ "$output" == *"gremion-migration-dump discard --release dist-v1.1.0 --reason <text>"* ]]
    refute_recorded docker "pg_dump"
}

@test "pg_dump exiting non-zero: PG_DUMP_FAILED, the partial file removed, no ledger line" {
    make_dump_dir
    new_kernel_file dist-v1.1.0
    PGDUMP_EXIT=1 run "$TOOL" preflight --release dist-v1.1.0
    [ "$status" -eq 1 ]
    [[ "$output" == *"PG_DUMP_FAILED"* ]]
    [ ! -s "${DUMPS}/ledger.jsonl" ]
    [ -z "$(find "$DUMPS" -name '*.dump')" ]
}

@test "the dump dir: unset is exit 2; 0755 is DUMP_DIR_MODE; both before any pg_dump" {
    new_kernel_file dist-v1.1.0
    sed -i '/^GREMION_MIGRATION_DUMP_DIR=/d' "${GREMION_ROOT}/etc/env/state.env"
    run "$TOOL" preflight --release dist-v1.1.0
    [ "$status" -eq 2 ]
    [[ "$output" == *"DUMP_DIR_UNSET"* ]]
    printf 'GREMION_MIGRATION_DUMP_DIR=%s\n' "$DUMPS" >> "${GREMION_ROOT}/etc/env/state.env"
    mkdir -p "$DUMPS"; chmod 755 "$DUMPS"
    run "$TOOL" preflight --release dist-v1.1.0
    [ "$status" -eq 1 ]
    [[ "$output" == *"DUMP_DIR_MODE"* ]]
    refute_recorded docker "pg_dump -Fc"
}

@test "pg_dump 17 against a server 18 is PG_DUMP_VERSION; too little space is DUMP_SPACE" {
    make_dump_dir
    new_kernel_file dist-v1.1.0
    PGDUMP_MAJOR=17 run "$TOOL" preflight --release dist-v1.1.0
    [ "$status" -eq 1 ]
    [[ "$output" == *"PG_DUMP_VERSION: pg_dump 17 is older than the server (18)"* ]]
    DB_BYTES=999999999999999 run "$TOOL" preflight --release dist-v1.1.0
    [ "$status" -eq 1 ]
    [[ "$output" == *"DUMP_SPACE"* ]]
    refute_recorded docker "pg_dump -Fc"
}

@test "a stale ledger.lock refuses and is left in place" {
    make_dump_dir
    printf '4242 then\n' > "${DUMPS}/ledger.lock"
    run "$TOOL" status
    [ "$status" -eq 0 ]
    run "$TOOL" switched --release dist-v1.1.0
    [ "$status" -eq 1 ]
    [[ "$output" == *"LEDGER_LOCKED"* ]]
    [ -f "${DUMPS}/ledger.lock" ]
}

@test "the postgres container is found by the state project's labels" {
    make_dump_dir
    new_kernel_file dist-v1.1.0
    run "$TOOL" preflight --release dist-v1.1.0
    [ "$status" -eq 0 ]
    assert_recorded docker "ps -q --filter label=com.docker.compose.project=teststack-state --filter label=com.docker.compose.service=postgres"
}

# ---------------------------------------------------------------------------
# switched / discard (TDD 8, 9)
# ---------------------------------------------------------------------------

seed_live_dump() { # <tag>
    make_dump_dir
    seed_release_tree "$1"
    new_kernel_file "$1"
    run "$TOOL" preflight --release "$1"
    [ "$status" -eq 0 ]
}

@test "switched deletes every live dump of R, one deleted line each, a stdout audit line and a logger line; nothing of R remains" {
    seed_live_dump dist-v1.1.0
    local f; f="${DUMPS}/$(jq -r '.file' "${DUMPS}/ledger.jsonl")"
    : > "$SHIM_LOG"
    run "$TOOL" switched --release dist-v1.1.0
    [ "$status" -eq 0 ]
    [ ! -e "$f" ]
    [ ! -e "${DUMPS}/dist-v1.1.0" ]
    [ "$(ledger_events)" = "created deleted " ]
    [ "$(jq -rs '.[1].reason' "${DUMPS}/ledger.jsonl")" = "switched" ]
    [ "$(jq -rs '.[1].migration_dump_id == .[0].migration_dump_id' "${DUMPS}/ledger.jsonl")" = "true" ]
    [[ "$output" == *"premigration-dump deleted id="*"reason=\"switched\""* ]]
    [[ "$output" == *"SWITCHED-OK release=dist-v1.1.0 deleted=1"* ]]
    assert_recorded logger "-t premigration-dump -- premigration-dump deleted"
    run "$TOOL" status --release dist-v1.1.0
    [[ "$output" == *"STATUS: 0 live dump(s)"* ]]
}

@test "a corrupt ledger fails switched (exit 1, LEDGER_CORRUPT), never reads as no-dump" {
    seed_live_dump dist-v1.1.0
    printf 'not json\n' >> "${DUMPS}/ledger.jsonl"
    run "$TOOL" switched --release dist-v1.1.0
    [ "$status" -eq 1 ]
    [[ "$output" == *"LEDGER_CORRUPT"* ]]
    [[ "$output" != *"no-dump"* ]]
    [ -n "$(find "$DUMPS" -name '*.dump')" ]
}

@test "switched with no dump of R is exit 0, no-dump R" {
    make_dump_dir
    run "$TOOL" switched --release dist-v1.1.0
    [ "$status" -eq 0 ]
    [[ "$output" == *"no-dump dist-v1.1.0"* ]]
    rm -rf "$DUMPS"
    run "$TOOL" switched --release dist-v1.1.0
    [ "$status" -eq 0 ]
    [[ "$output" == *"no-dump dist-v1.1.0"* ]]
}

@test "switched with an unwritable ledger exits non-zero and KEEPS the dump" {
    seed_live_dump dist-v1.1.0
    local f; f="${DUMPS}/$(jq -r '.file' "${DUMPS}/ledger.jsonl")"
    chmod 444 "${DUMPS}/ledger.jsonl"
    if [[ "$(id -u)" -eq 0 ]]; then
        # root writes through 0444: run the tool as nobody over a tree nobody can read
        chmod -R a+rX "$GREMION_ROOT"; chmod 777 "$DUMPS"
        run setpriv --reuid=65534 --regid=65534 --clear-groups env PATH="$PATH" GREMION_ROOT="$GREMION_ROOT" SHIM_LOG=/dev/null "$TOOL" switched --release dist-v1.1.0
    else
        run "$TOOL" switched --release dist-v1.1.0
    fi
    [ "$status" -eq 1 ]
    [[ "$output" == *"LEDGER_UNWRITABLE"*"KEPT"* ]]
    [ -f "$f" ]
    [ "$(ledger_events)" = "created " ]
}

@test "discard needs a reason; the deleted line carries it and the operator kind" {
    seed_live_dump dist-v1.1.0
    run "$TOOL" discard --release dist-v1.1.0
    [ "$status" -eq 2 ]
    run "$TOOL" discard --release dist-v1.1.0 --reason "   "
    [ "$status" -eq 2 ]
    run "$TOOL" discard --release dist-v1.1.0 --reason "import-verified"
    [ "$status" -eq 0 ]
    [ "$(jq -rs '.[1].reason + " " + .[1].by_kind' "${DUMPS}/ledger.jsonl")" = "import-verified operator" ]
    [[ "$output" == *"DISCARD-OK release=dist-v1.1.0 deleted=1"* ]]
}

# ---------------------------------------------------------------------------
# restore (TDD 9)
# ---------------------------------------------------------------------------

@test "restore refuses without --accept-loss-since, then recreates the database from the dump and logs restored; the dump stays live" {
    seed_live_dump dist-v1.1.0
    run "$TOOL" restore --release dist-v1.1.0 --db gremion
    [ "$status" -eq 2 ]
    [[ "$output" == *"--accept-loss-since"* ]]
    : > "$SHIM_LOG"
    run "$TOOL" restore --release dist-v1.1.0 --db gremion --accept-loss-since 2026-09-29T03:00Z
    [ "$status" -eq 0 ]
    assert_recorded docker 'DROP DATABASE "gremion" WITH (FORCE)'
    assert_recorded docker 'CREATE DATABASE "gremion" OWNER "gremion"'
    assert_recorded docker "exec -i pgc pg_restore --no-owner --role=gremion --exit-on-error --single-transaction -U postgres -d gremion"
    [ "$(ledger_events)" = "created restored " ]
    [ "$(jq -rs '.[1].reason' "${DUMPS}/ledger.jsonl")" = "accept-loss-since 2026-09-29T03:00Z" ]
    assert_recorded logger "premigration-dump restored"
    run "$TOOL" status
    [[ "$output" == *"STATUS: 1 live dump(s)"* ]]
}

@test "restore of a dump whose bytes changed is refused (sha256)" {
    seed_live_dump dist-v1.1.0
    local f; f="${DUMPS}/$(jq -r '.file' "${DUMPS}/ledger.jsonl")"
    printf 'tampered' >> "$f"
    run "$TOOL" restore --release dist-v1.1.0 --db gremion --accept-loss-since t
    [ "$status" -eq 1 ]
    [[ "$output" == *"DUMP_UNVERIFIED"* ]]
    refute_recorded docker "DROP DATABASE"
}
