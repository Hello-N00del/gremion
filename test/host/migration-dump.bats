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

# docker: `ps` answers the state postgres (and, by service label, the module
# servers), `exec … psql` the version/size/owner/ACL, `exec … pg_dump` writes a
# fake archive naming its database, and `exec -i … pg_restore --list` reads it
# back. The shim enforces the roles as the real servers do: the main
# server `pgc` has the superuser `postgres` only, the module server `fpgc` has
# `finance` only and `npgc` has `newsletter` only, so `-U postgres` against a
# module server fails with `role "postgres" does not exist`.
# A tiny ACL model lives in $SHIM_DIR/acl.state ("<grantee> <PRIV> <t|f>" per
# line, absent = the default ACL of a fresh database): DROP DATABASE resets it,
# REVOKE and GRANT edit it, and the privilege query reads it.
stub_docker() {
    shim docker "$(cat <<'SHIM'
ST="${SHIM_DIR}/acl.state"
materialize() {
    [ -f "$ST" ] || printf 'PUBLIC CONNECT f\nPUBLIC TEMPORARY f\ngremion CONNECT f\ngremion CREATE f\ngremion TEMPORARY f\n' > "$ST"
}
case "$1" in
  ps)
      case "$*" in
        *"service=finance-postgres"*)    printf "fpgc\n"; [ -z "${PS_MULTI:-}" ] || printf "fpgc2\n" ;;
        *"service=newsletter-postgres"*) printf "npgc\n" ;;
        *"service=postgres"*)            printf "pgc\n"; [ -z "${PS_MULTI:-}" ] || printf "pgc2\n" ;;
      esac
      exit 0 ;;
  exec)
      args="$*"
      if [ "$2" = "-i" ]; then c="$3"; else c="$2"; fi
      prev=""; role=""
      for a in "$@"; do [ "$prev" = "-U" ] && role="$a"; prev="$a"; done
      if [ -n "$role" ]; then
          case "$c" in pgc|pgc2) want=postgres ;; fpgc|fpgc2) want=finance ;; npgc) want=newsletter ;; *) want="$role" ;; esac
          if [ "$role" != "$want" ]; then
              printf 'psql: error: FATAL:  role "%s" does not exist\n' "$role" >&2
              exit 2
          fi
      fi
      case "$args" in
        *"pg_dump --version"*) printf "pg_dump (PostgreSQL) %s.1\n" "${PGDUMP_MAJOR:-18}"; exit 0 ;;
        *" pg_dump -Fc"*)
            [ "${PGDUMP_EXIT:-0}" = "0" ] || { printf "partial"; exit "$PGDUMP_EXIT"; }
            printf "PGDMP fake archive dbname=%s\n" "${*: -1}"; exit 0 ;;
        *"pg_restore --list"*)
            db="$(sed -nE "s/.*dbname=([A-Za-z0-9_.-]+).*/\1/p")"
            printf ";\n; Archive created at 2026-09-29 03:00:00 UTC\n;     dbname: %s\n" "$db"; exit 0 ;;
        *" pg_restore "*) cat >/dev/null; exit "${RESTORE_EXIT:-0}" ;;
        *"has_database_privilege"*)
            # the effective answers for PUBLIC and each role named in ARRAY[...]
            pub="CONNECT,TEMPORARY"; pc=true; pt=true
            if [ -f "$ST" ]; then
                pc=false; pt=false; pub=""
                grep -q '^PUBLIC CONNECT ' "$ST" && { pc=true; pub="CONNECT"; }
                if grep -q '^PUBLIC TEMPORARY ' "$ST"; then pt=true; pub="${pub:+$pub,}TEMPORARY"; fi
            fi
            printf "PUBLIC|%s\n" "$pub"
            for r in $(printf "%s" "$args" | grep -o "ARRAY\[[^]]*\]" | tr -d "ARRAY[]'" | tr "," " "); do
                rc=$pc; rt=$pt
                [ -f "$ST" ] && grep -q "^$r CONNECT " "$ST" && rc=true
                [ -f "$ST" ] && grep -q "^$r TEMPORARY " "$ST" && rt=true
                printf "%s|%s,%s\n" "$r" "$rc" "$rt"
            done
            exit 0 ;;
        *"datacl IS NULL"*)
            if [ ! -f "$ST" ]; then printf "null\n"; exit 0; fi
            jq -Rn '[inputs | split(" ") | {g: (if .[0] == "PUBLIC" then null else .[0] end), p: .[1], o: (.[2] == "t")}]' < "$ST"
            exit 0 ;;
        *"server_version_num"*) printf "18\n"; exit 0 ;;
        *"pg_database_size"*)   printf "%s\n" "${DB_BYTES:-1000}"; exit 0 ;;
        *"pg_get_userbyid"*)    printf "gremion\n"; exit 0 ;;
        *"DROP DATABASE"*)      rm -f "$ST"; exit 0 ;;
        *"REVOKE "*|*"GRANT "*)
            [ -z "${ACL_REPLAY_NOOP:-}" ] || exit 0
            if [ -n "${ACL_GRANT_FAIL:-}" ]; then case "$args" in *"GRANT "*) printf "ERROR:  role does not exist
" >&2; exit 1 ;; esac; fi
            for a in "$@"; do
                case "$a" in
                  "REVOKE ALL ON DATABASE "*" FROM PUBLIC") materialize; grep -v '^PUBLIC ' "$ST" > "$ST.n" || true; mv "$ST.n" "$ST" ;;
                  "GRANT "*)
                      materialize
                      privs="${a#GRANT }"; privs="${privs%% ON DATABASE*}"
                      who="${a##* TO }"; who="${who% WITH GRANT OPTION}"; who="${who//\"/}"
                      for p in ${privs//,/ }; do printf "%s %s f\n" "$who" "$p" >> "$ST"; done ;;
                esac
            done
            exit 0 ;;
      esac
      exit 0 ;;
esac
exit 0
SHIM
)"
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

# ---------------------------------------------------------------------------
# take (TASK-031: the member import's one dump before its first write)
# ---------------------------------------------------------------------------

@test "take --release R --db D: ONE checked dump of D, recorded, logged, TAKE-OK; a rerun reuses it" {
    make_dump_dir
    run "$TOOL" take --release import-0a1b2c3d --db gremion
    [ "$status" -eq 0 ]
    [[ "$output" == *"TAKE-OK release=import-0a1b2c3d db=gremion"* ]]
    assert_recorded docker "exec pgc pg_dump -Fc --no-owner -U postgres gremion"
    [ "$(ledger_events)" = "created " ]
    [ "$(jq -r '.release' "${DUMPS}/ledger.jsonl")" = "import-0a1b2c3d" ]
    : > "$SHIM_LOG"
    run "$TOOL" take --release import-0a1b2c3d --db gremion
    [ "$status" -eq 0 ]
    refute_recorded docker "pg_dump -Fc"
    [ "$(ledger_events)" = "created " ]
}

@test "take refuses another release's live dump (never a series) before any pg_dump" {
    seed_live_dump dist-v1.1.0
    : > "$SHIM_LOG"
    run "$TOOL" take --release import-0a1b2c3d --db gremion
    [ "$status" -eq 1 ]
    [[ "$output" == *"DUMP_SERIES: live pre-migration dump"*"of release dist-v1.1.0"* ]]
    refute_recorded docker "pg_dump"
}

@test "take needs --release and --db, and a valid database name (usage, exit 2)" {
    make_dump_dir
    run "$TOOL" take --release import-0a1b2c3d
    [ "$status" -eq 2 ]
    run "$TOOL" take --db gremion
    [ "$status" -eq 2 ]
    run "$TOOL" take --release import-0a1b2c3d --db 'a;b'
    [ "$status" -eq 2 ]
    refute_recorded docker "pg_dump"
}

@test "a taken dump is deleted with a logged reason by discard (the import's exit once the rerun proved the apply)" {
    make_dump_dir
    run "$TOOL" take --release import-0a1b2c3d --db gremion
    [ "$status" -eq 0 ]
    run "$TOOL" discard --release import-0a1b2c3d --reason "member import verified"
    [ "$status" -eq 0 ]
    [ "$(ledger_events)" = "created deleted " ]
    [ "$(jq -rs '.[1].reason' "${DUMPS}/ledger.jsonl")" = "member import verified" ]
}

# ---------------------------------------------------------------------------
# take --pg-service / --pg-user (module servers), the leak rule (a module
# database name can carry a customer slug), the gate-database scope and the ACL
# that survives a restore
# ---------------------------------------------------------------------------

SCOPE_FIXTURE="${PROJECT_ROOT}/test/host/fixtures/cd/dump-options/scope-names.json"
SLUG_DB="calendar_some-slug"
GATE_DB="t_0123456789abcdef0123456789abcdef__finance"

# no docker call at all was made (the shim logs every `docker ...` line)
no_docker_calls() {
    [ -z "$(grep '^docker ' "$SHIM_LOG" || true)" ]
}

take_module() { # <release> <db> [service] [role]
    "$TOOL" take --release "$1" --db "$2" --pg-service "${3:-finance-postgres}" --pg-user "${4:-finance}"
}

@test "take --pg-service/--pg-user: psql and pg_dump run in the labelled module container as the given role" {
    make_dump_dir
    run take_module r-mod "$SLUG_DB"
    [ "$status" -eq 0 ]
    assert_recorded docker "ps -q --filter label=com.docker.compose.project=teststack-state --filter label=com.docker.compose.service=finance-postgres"
    assert_recorded docker "exec fpgc psql -X -U finance -d ${SLUG_DB} -tAq -v ON_ERROR_STOP=1 -c"
    assert_recorded docker "exec fpgc pg_dump -Fc --no-owner -U finance ${SLUG_DB}"
    refute_recorded docker "-U postgres"
    run take_module r-news news_db newsletter-postgres newsletter
    [ "$status" -eq 1 ]   # another release's live dump is live: never a series
    [[ "$output" == *"DUMP_SERIES"* ]]
}

@test "the role is its own variable parsed AFTER load_env: state.env's POSTGRES_USER never wins" {
    make_dump_dir
    grep -q '^POSTGRES_USER=postgres$' "${GREMION_ROOT}/etc/env/state.env"
    run take_module r-mod "$SLUG_DB"
    [ "$status" -eq 0 ]
    refute_recorded docker "exec fpgc pg_dump -Fc --no-owner -U postgres"
    assert_recorded docker "exec fpgc pg_dump -Fc --no-owner -U finance"
}

@test "without the options nothing changes: the postgres service and POSTGRES_USER" {
    make_dump_dir
    run "$TOOL" take --release r-main --db gremion
    [ "$status" -eq 0 ]
    assert_recorded docker "service=postgres"
    assert_recorded docker "exec pgc pg_dump -Fc --no-owner -U postgres gremion"
    [ "$(jq -r 'has("pg_service") or has("pg_user")' "${DUMPS}/ledger.jsonl")" = "false" ]
    [[ "$output" == *"db=gremion"* ]]
    [[ "$output" == *"TAKE-OK release=r-main db=gremion"* ]]
}

@test "the two options come together or not at all, and only take accepts them (exit 2, nothing runs)" {
    make_dump_dir
    run "$TOOL" take --release r-mod --db "$SLUG_DB" --pg-service finance-postgres
    [ "$status" -eq 2 ]
    [[ "$output" == *"come together or not at all"* ]]
    run "$TOOL" take --release r-mod --db "$SLUG_DB" --pg-user finance
    [ "$status" -eq 2 ]
    [[ "$output" == *"come together or not at all"* ]]
    run "$TOOL" restore --release r-mod --db "$SLUG_DB" --accept-loss-since t --pg-service finance-postgres --pg-user finance
    [ "$status" -eq 2 ]
    [[ "$output" == *"belong to take only"* ]]
    run "$TOOL" switched --release r-mod --pg-service finance-postgres --pg-user finance
    [ "$status" -eq 2 ]
    [[ "$output" == *"belong to take only"* ]]
    no_docker_calls
    [ ! -e "${DUMPS}/ledger.jsonl" ]
}

@test "--pg-service must be postgres or <name>-postgres, --pg-user a lower-case role name (exit 2, nothing runs)" {
    make_dump_dir
    local svc usr
    for svc in Postgres finance_postgres 'fin;ance-postgres' '-postgres' 'a-b-postgres' 'finance-postgres-x' 'finance' '1x-postgres'; do
        run "$TOOL" take --release r-mod --db "$SLUG_DB" --pg-service "$svc" --pg-user finance
        [ "$status" -eq 2 ]
    done
    for usr in Finance 1abc a-b 'a;b' 'a b' "$(printf 'a%.0s' $(seq 1 64))"; do
        run "$TOOL" take --release r-mod --db "$SLUG_DB" --pg-service finance-postgres --pg-user "$usr"
        [ "$status" -eq 2 ]
    done
    no_docker_calls
    # 63 characters is the longest role name that is accepted; it fails at the
    # server (the shim knows no such role), not in the option check
    run "$TOOL" take --release r-mod --db "$SLUG_DB" --pg-service postgres --pg-user "$(printf 'a%.0s' $(seq 1 63))"
    [ "$status" -eq 1 ]
    assert_recorded docker "service=postgres"
}

@test "exactly one running container must match the service, else exit 1 and no file" {
    make_dump_dir
    PS_MULTI=1 run take_module r-mod "$SLUG_DB"
    [ "$status" -eq 1 ]
    [[ "$output" == *"expected exactly one running finance-postgres"* ]]
    run take_module r-mod "$SLUG_DB" ghost-postgres finance
    [ "$status" -eq 1 ]
    refute_recorded docker "pg_dump -Fc"
    [ -z "$(find "$DUMPS" -name '*.dump')" ]
}

@test "GREMION_MIGRATION_DUMP_PG_CONTAINER with either option is exit 2 and nothing runs (env or state.env)" {
    make_dump_dir
    GREMION_MIGRATION_DUMP_PG_CONTAINER=scratch run take_module r-mod "$SLUG_DB"
    [ "$status" -eq 2 ]
    [[ "$output" == *"GREMION_MIGRATION_DUMP_PG_CONTAINER"* ]]
    printf 'GREMION_MIGRATION_DUMP_PG_CONTAINER=scratch\n' >> "${GREMION_ROOT}/etc/env/state.env"
    run take_module r-mod "$SLUG_DB"
    [ "$status" -eq 2 ]
    no_docker_calls
    # without the options the override still names the container, as before
    run "$TOOL" take --release r-main --db gremion
    [ "$status" -eq 0 ]
    assert_recorded docker "exec scratch pg_dump -Fc"
}

@test "the shim enforces roles: a wrong service/role pair fails, leaves no file and no ledger line" {
    make_dump_dir
    run take_module r-mod "$SLUG_DB" finance-postgres postgres
    [ "$status" -eq 1 ]
    [[ "$output" == *"role \"postgres\" does not exist"* ]]
    run take_module r-mod "$SLUG_DB" postgres finance
    [ "$status" -eq 1 ]
    refute_recorded docker "pg_dump -Fc"
    [ -z "$(find "$DUMPS" -name '*.dump')" ]
    [ ! -s "${DUMPS}/ledger.jsonl" ]
}

@test "the created line carries pg_service and pg_user, stays one JSON object, and reuse needs the same server" {
    make_dump_dir
    run take_module r-mod "$SLUG_DB"
    [ "$status" -eq 0 ]
    jq -e '.event == "created" and .pg_service == "finance-postgres" and .pg_user == "finance" and .database == "calendar_some-slug"' "${DUMPS}/ledger.jsonl"
    [ "$(wc -l < "${DUMPS}/ledger.jsonl")" -eq 1 ]
    : > "$SHIM_LOG"
    run take_module r-mod "$SLUG_DB"
    [ "$status" -eq 0 ]
    [[ "$output" == *"premigration-dump reused id="* ]]
    refute_recorded docker "pg_dump -Fc"
    [ "$(ledger_events)" = "created " ]
    # the same name on another server (or none) is a refusal, never a reuse of the wrong dump
    run "$TOOL" take --release r-mod --db "$SLUG_DB"
    [ "$status" -eq 1 ]
    [[ "$output" == *"DUMP_SERVER_MISMATCH"* ]]
    run take_module r-mod "$SLUG_DB" finance-postgres other
    [ "$status" -eq 1 ]
    refute_recorded docker "pg_dump -Fc"
    run "$TOOL" status --release r-mod
    [[ "$output" == *"db=calendar_some-slug"* ]]
}

# every line the program let out: stdout, the audited commands' output, the
# logger shim, and the names of the files on disk
leak_free() { # <needle> <accumulated output>
    local needle="$1" out="$2"
    [[ "$out" != *"$needle"* ]] || { echo "LEAK in output: $needle" >&2; return 1; }
    [ -z "$(grep '^logger ' "$SHIM_LOG" | grep -F -- "$needle" || true)" ] || { echo "LEAK in logger" >&2; return 1; }
    [ -z "$(find "$DUMPS" -name "*${needle}*")" ] || { echo "LEAK in file name" >&2; return 1; }
}

@test "leak rule: a module database name reaches no journal line, no stdout line and no dump file name, through take, reuse, restore, switched and discard" {
    make_dump_dir
    local all="" id
    run take_module r-leak "$SLUG_DB"; [ "$status" -eq 0 ]; all+="$output"
    leak_free "$SLUG_DB" "$all"
    [[ "$output" == *"premigration-dump created id="*"release=r-leak svc=finance-postgres"* ]]
    [[ "$output" == *"TAKE-OK release=r-leak svc=finance-postgres id="* ]]
    id="$(jq -r '.migration_dump_id' "${DUMPS}/ledger.jsonl")"
    [ -f "${DUMPS}/r-leak/finance-postgres.${id}.dump" ]
    run take_module r-leak "$SLUG_DB"; [ "$status" -eq 0 ]; all+="$output"
    [[ "$output" == *"premigration-dump reused id=${id} release=r-leak svc=finance-postgres"* ]]
    run "$TOOL" restore --release r-leak --db "$SLUG_DB" --accept-loss-since t0; [ "$status" -eq 0 ]; all+="$output"
    [[ "$output" == *"RESTORE-OK release=r-leak svc=finance-postgres id=${id}"* ]]
    [[ "$output" == *"restoring svc=finance-postgres id=${id}"* ]]
    run "$TOOL" switched --release r-leak; [ "$status" -eq 0 ]; all+="$output"
    [[ "$output" == *"premigration-dump deleted id=${id} release=r-leak svc=finance-postgres"* ]]
    run take_module r-leak2 "$SLUG_DB"; [ "$status" -eq 0 ]; all+="$output"
    run "$TOOL" discard --release r-leak2 --reason "checked"; [ "$status" -eq 0 ]; all+="$output"
    leak_free "$SLUG_DB" "$all"
    [ -n "$(grep '^logger ' "$SHIM_LOG" | grep -F 'svc=finance-postgres' || true)" ]
    # the ledger itself keeps the name (it lives in the 0700 directory)
    jq -e -s 'map(select(.event == "created")) | length == 2 and all(.[]; .database == "calendar_some-slug")' "${DUMPS}/ledger.jsonl"
}

@test "leak rule: the refusal messages on stderr may name the database (stderr is not the journal)" {
    make_dump_dir
    run take_module r-a "$SLUG_DB"; [ "$status" -eq 0 ]
    run take_module r-b "$SLUG_DB"
    [ "$status" -eq 1 ]
    [[ "$output" == *"DUMP_SERIES"*"$SLUG_DB"* ]]
}

@test "a main-server database prints db= in every line as before" {
    make_dump_dir
    run "$TOOL" take --release r-main --db gremion; [ "$status" -eq 0 ]
    [[ "$output" == *"release=r-main db=gremion"* ]]
    local id; id="$(jq -r '.migration_dump_id' "${DUMPS}/ledger.jsonl")"
    [ -f "${DUMPS}/r-main/gremion.${id}.dump" ]
    run "$TOOL" switched --release r-main; [ "$status" -eq 0 ]
    [[ "$output" == *"deleted id=${id} release=r-main db=gremion"* ]]
}

@test "scope: a gate database gets customer scope and both ids, as scopeOf answers; every other name keeps platform" {
    make_dump_dir
    local n i db
    n="$(jq '.cases | length' "$SCOPE_FIXTURE")"
    [ "$n" -ge 8 ]
    for (( i = 0; i < n; i++ )); do
        db="$(jq -r --argjson i "$i" '.cases[$i].database' "$SCOPE_FIXTURE")"
        : > "${DUMPS}/ledger.jsonl"
        rm -rf "${DUMPS}/r-scope"
        run take_module r-scope "$db"
        [ "$status" -eq 0 ]
        jq -e --slurpfile f "$SCOPE_FIXTURE" --argjson i "$i" '
            ($f[0].cases[$i]) as $c
            | .database == $c.database and .scope == $c.scope
              and .customer_id == $c.customer_id and .module_id == $c.module_id' "${DUMPS}/ledger.jsonl"
    done
}

@test "scope: the deleted and restored lines copy scope, ids and the server fields" {
    make_dump_dir
    run take_module r-scope "$GATE_DB"; [ "$status" -eq 0 ]
    run "$TOOL" restore --release r-scope --db "$GATE_DB" --accept-loss-since t0; [ "$status" -eq 0 ]
    run "$TOOL" switched --release r-scope; [ "$status" -eq 0 ]
    [ "$(ledger_events)" = "created restored deleted " ]
    jq -e -s 'all(.[]; .scope == "customer" and .module_id == "finance"
                      and .customer_id == "01234567-89ab-cdef-0123-456789abcdef"
                      and .pg_service == "finance-postgres" and .pg_user == "finance")' "${DUMPS}/ledger.jsonl"
}

# ---------------------------------------------------------------------------
# restore: server and role from the ledger line, ACL put back
# ---------------------------------------------------------------------------

@test "restore of a module line uses its container and role for owner, ACL read, DROP, CREATE and pg_restore" {
    make_dump_dir
    run take_module r-mod "$GATE_DB"; [ "$status" -eq 0 ]
    : > "$SHIM_LOG"
    run "$TOOL" restore --release r-mod --db "$GATE_DB" --accept-loss-since t0
    [ "$status" -eq 0 ]
    assert_recorded docker "service=finance-postgres"
    assert_recorded docker "exec fpgc psql -X -U finance -d postgres -tAq -v ON_ERROR_STOP=1 -c SELECT pg_catalog.pg_get_userbyid(datdba)"
    assert_recorded docker "exec fpgc psql -X -U finance -d postgres -v ON_ERROR_STOP=1 -q -c DROP DATABASE \"${GATE_DB}\" WITH (FORCE) -c CREATE DATABASE \"${GATE_DB}\" OWNER \"gremion\""
    assert_recorded docker "exec -i fpgc pg_restore --no-owner --role=gremion --exit-on-error --single-transaction -U finance -d ${GATE_DB}"
    refute_recorded docker "-U postgres"
    jq -e -s 'map(select(.event == "restored")) | length == 1 and .[0].pg_service == "finance-postgres" and .[0].pg_user == "finance"' "${DUMPS}/ledger.jsonl"
    [[ "$output" != *"$GATE_DB"* ]]
}

@test "restore on a line with a pg_service and the container override set is exit 2 and nothing is dropped" {
    make_dump_dir
    run take_module r-mod "$GATE_DB"; [ "$status" -eq 0 ]
    : > "$SHIM_LOG"
    GREMION_MIGRATION_DUMP_PG_CONTAINER=scratch run "$TOOL" restore --release r-mod --db "$GATE_DB" --accept-loss-since t0
    [ "$status" -eq 2 ]
    no_docker_calls
}

@test "restore replays a database whose PUBLIC was revoked and whose app role was granted, and it ends as it was" {
    make_dump_dir
    run take_module r-mod "$GATE_DB"; [ "$status" -eq 0 ]
    printf 'gremion CONNECT f\ngremion CREATE f\ngremion TEMPORARY f\nm_app CONNECT f\n' > "${SHIM_DIR}/acl.state"
    run "$TOOL" restore --release r-mod --db "$GATE_DB" --accept-loss-since t0
    [ "$status" -eq 0 ]
    assert_recorded docker "REVOKE ALL ON DATABASE \"${GATE_DB}\" FROM PUBLIC"
    assert_recorded docker "GRANT CONNECT ON DATABASE \"${GATE_DB}\" TO \"m_app\""
    assert_present '^m_app CONNECT ' "${SHIM_DIR}/acl.state"
    assert_absent '^PUBLIC ' "${SHIM_DIR}/acl.state" "PUBLIC must stay revoked"
    [ "$(ledger_events)" = "created restored " ]
}

@test "restore of a blocked database (app role has no CONNECT) leaves it blocked" {
    make_dump_dir
    run take_module r-mod "$GATE_DB"; [ "$status" -eq 0 ]
    printf 'gremion CONNECT f\ngremion CREATE f\ngremion TEMPORARY f\n' > "${SHIM_DIR}/acl.state"
    run "$TOOL" restore --release r-mod --db "$GATE_DB" --accept-loss-since t0
    [ "$status" -eq 0 ]
    refute_recorded docker "TO \"m_app\""
    assert_absent '^m_app ' "${SHIM_DIR}/acl.state" "the app role must not regain CONNECT"
    assert_absent '^PUBLIC ' "${SHIM_DIR}/acl.state" "PUBLIC must stay revoked"
}

@test "restore of a database with the default ACL runs no GRANT, REVOKE or privilege query" {
    make_dump_dir
    run take_module r-mod "$GATE_DB"; [ "$status" -eq 0 ]
    rm -f "${SHIM_DIR}/acl.state"
    run "$TOOL" restore --release r-mod --db "$GATE_DB" --accept-loss-since t0
    [ "$status" -eq 0 ]
    refute_recorded docker "GRANT "
    refute_recorded docker "REVOKE "
    refute_recorded docker "has_database_privilege"
}

@test "a replay that does not take is RESTORE_ACL_MISMATCH and no restored line is written" {
    make_dump_dir
    run take_module r-mod "$GATE_DB"; [ "$status" -eq 0 ]
    printf 'gremion CONNECT f\ngremion CREATE f\ngremion TEMPORARY f\nm_app CONNECT f\n' > "${SHIM_DIR}/acl.state"
    ACL_REPLAY_NOOP=1 run "$TOOL" restore --release r-mod --db "$GATE_DB" --accept-loss-since t0
    [ "$status" -eq 1 ]
    [[ "$output" == *"RESTORE_ACL_MISMATCH"* ]]
    [ "$(ledger_events)" = "created " ]
}

@test "a failing GRANT replay is RESTORE_ACL_FAILED, PUBLIC is closed best-effort and no restored line is written" {
    make_dump_dir
    run take_module r-mod "$GATE_DB"; [ "$status" -eq 0 ]
    printf 'gremion CONNECT f
gremion CREATE f
gremion TEMPORARY f
m_app CONNECT f
' > "${SHIM_DIR}/acl.state"
    ACL_GRANT_FAIL=1 run "$TOOL" restore --release r-mod --db "$GATE_DB" --accept-loss-since t0
    [ "$status" -eq 1 ]
    [[ "$output" == *"RESTORE_ACL_FAILED"* ]]
    [ "$(ledger_events)" = "created " ]
    [ "$(grep -c 'REVOKE ALL ON DATABASE' "$SHIM_LOG")" -eq 2 ]
}

@test "a grantee name the replay cannot quote safely is refused BEFORE the database is dropped" {
    make_dump_dir
    run take_module r-mod "$GATE_DB"; [ "$status" -eq 0 ]
    printf 'evil;role CONNECT f\n' > "${SHIM_DIR}/acl.state"
    : > "$SHIM_LOG"
    run "$TOOL" restore --release r-mod --db "$GATE_DB" --accept-loss-since t0
    [ "$status" -eq 1 ]
    refute_recorded docker "DROP DATABASE"
}

@test "the main-server restore is unchanged: no ACL query, no GRANT, defaults for container and role" {
    make_dump_dir
    run "$TOOL" take --release r-main --db gremion; [ "$status" -eq 0 ]
    : > "$SHIM_LOG"
    run "$TOOL" restore --release r-main --db gremion --accept-loss-since t0
    [ "$status" -eq 0 ]
    refute_recorded docker "datacl"
    refute_recorded docker "GRANT "
    assert_recorded docker "exec -i pgc pg_restore --no-owner --role=gremion --exit-on-error --single-transaction -U postgres -d gremion"
}

@test "the usage text names the two options and is exit 2" {
    run "$TOOL" --help
    [ "$status" -eq 2 ]
    [[ "$output" == *"take      --release R --db D [--pg-service SVC --pg-user ROLE]"* ]]
}
