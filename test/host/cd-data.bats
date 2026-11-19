#!/usr/bin/env bats
# Unit tests for infra/host/lib/cd/data.sh (continuous deployment, unit cd-data): the timer
# guard, the dump set (main server and module servers), the migrate stage and the live signal.
#
# The libraries core.sh, data.sh and docker.sh are the REAL ones, in the dispatcher's order
# (data.sh before docker.sh); the units after this one are the helper's stubs. Nothing touches
# a real docker, systemd or a host: a docker shim that enforces the roles of every server as
# the real servers do (`-U postgres` against a module server fails with `role "postgres" does
# not exist`, and no test uses a shim that accepts any -U), a stand-in for the host's
# gremion-migration-dump that is as hostile as the real one (its status prints the database
# name, its refusals name it), and a systemctl shim. The snippets run WITHOUT errexit, as a
# driver that calls a stage as `fn || rc=$?`.

bats_require_minimum_version 1.5.0
load 'test_helper/host'
load 'test_helper/cd'

FIX="${BATS_TEST_DIRNAME}/fixtures/cd/data"
TAG="pilot-cccccccccccc"
RID="cccccccccccc-1"
SLUG_DB="calendar_some-slug"

# The ids of the fixture customers (32 hex digits each).
H1="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
H2="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
H3="cccccccccccccccccccccccccccccccc"
H4="dddddddddddddddddddddddddddddddd"
H5="eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
H6="ffffffffffffffffffffffffffffffff"

# The docker shim body. State lives in $DK:
#   cid.<project>.<service>   the running container of a service (ps by label)
#   ctr.<cid>                 the service a container belongs to
#   srv.<service>.role        the only superuser role of that server
#   srv.<service>.dbs         the databases of that server, "name|bytes" per line
#   rows.module_database      "db_name|state" lines of plt.module_database
#   tenants.active            the hex ids of the active customers
#   psql.fail.<service>       a query on that server fails
#   pgb.stdin.<db>, pgb.fail  what `psql -f -` read on stdin in that database (pgb.stdin: the
#                             postgres one) / make every such call fail (pgb.fail.<db>: one)
#   ref, config.json, config.fail   what `compose config --format json` answers
#   run.<service>.rc/.out/.leave    a one-shot: exit code, its output, a container that
#                             outlives a timeout (label gremion.cd, removed by `docker rm`)
#   labelled, rm.stuck        the containers that carry a gremion.cd label; rm does not work
#   exec.log, run.log, ps.log one line per call
docker_shim_body() {
    cat <<'SHIM_EOF'
case "$1" in
  compose)
    envf=''; prev=''; verb=''
    for a in "$@"; do
        [ "$prev" = --env-file ] && envf="$a"
        prev="$a"
    done
    for a in "$@"; do
        case "$a" in config|run|build|pull|up|down) verb="$a"; break ;; esac
    done
    col="$(basename "$envf" .env)"
    case "$verb" in
      config)
        [ -f "$DK/config.fail" ] && exit 1
        if [ -f "$DK/config.json" ]; then cat "$DK/config.json"; exit 0; fi
        printf '{"services":{"kernel-api-migrate":{"environment":{"GREMION_RELEASE_REF":"%s","SECRET_MARKER":"resolved-secret-marker"}}}}\n' "$(cat "$DK/ref")"
        exit 0 ;;
      run)
        last=''
        for a in "$@"; do last="$a"; done
        printf 'run %s svc=%s cwd=%s args=%s\n' "$col" "$last" "$PWD" "$*" >>"$DK/run.log"
        [ -f "$DK/run.$last.out" ] && cat "$DK/run.$last.out"
        rc="$(cat "$DK/run.$last.rc" 2>/dev/null || echo 0)"
        if [ "$rc" = 124 ] && [ -f "$DK/run.$last.leave" ]; then echo c-leftover >"$DK/labelled"; fi
        exit "$rc" ;;
    esac
    exit 0 ;;
  ps)
    [ -f "$DK/ps.fail" ] && exit 1
    proj=''; svc=''; lab=''
    for a in "$@"; do
        case "$a" in
          label=com.docker.compose.project=*) proj="${a#label=com.docker.compose.project=}" ;;
          label=com.docker.compose.service=*) svc="${a#label=com.docker.compose.service=}" ;;
          label=gremion.cd=*) lab="${a#label=gremion.cd=}" ;;
        esac
    done
    if [ -n "$lab" ]; then
        printf 'ps %s\n' "${*:2}" >>"$DK/ps.log"
        [ -f "$DK/labelled" ] && cat "$DK/labelled"
        exit 0
    fi
    [ -f "$DK/cid.$proj.$svc" ] && cat "$DK/cid.$proj.$svc"
    exit 0 ;;
  rm)
    printf 'rm %s\n' "${*:2}" >>"$DK/ps.log"
    [ -f "$DK/rm.stuck" ] || rm -f "$DK/labelled"
    exit 0 ;;
  exec)
    shift
    [ "$1" = -i ] && shift
    cid="$1"; shift
    svc="$(cat "$DK/ctr.$cid" 2>/dev/null)" || exit 1
    [ "$1" = psql ] || exit 1
    shift
    role=''; db=''; sql=''; file=''
    while [ $# -gt 0 ]; do
        case "$1" in
          -U) role="$2"; shift ;;
          -d) db="$2"; shift ;;
          -c) sql="$2"; shift ;;
          -f) file="$2"; shift ;;
        esac
        shift
    done
    printf 'exec svc=%s role=%s db=%s\n' "$svc" "$role" "$db" >>"$DK/exec.log"
    want="$(cat "$DK/srv.$svc.role")"
    if [ "$role" != "$want" ]; then
        echo "psql: error: connection failed: FATAL:  role \"$role\" does not exist" >&2
        exit 2
    fi
    [ -f "$DK/psql.fail.$svc" ] && { echo "psql: error: something is wrong with $db" >&2; exit 1; }
    if [ -n "$file" ]; then
        cat >"$DK/pgb.stdin.$db"
        [ "$db" = postgres ] && cp "$DK/pgb.stdin.$db" "$DK/pgb.stdin"
        [ -f "$DK/pgb.fail" ] && exit 1
        [ -f "$DK/pgb.fail.$db" ] && exit 1
        exit 0
    fi
    case "$sql" in
      *"from pg_database"*)
        excl="$(printf '%s' "$sql" | grep -o "'[^']*'" | tr -d "'")"
        while IFS='|' read -r n b; do
            [ -n "$n" ] || continue
            skip=0
            for e in $excl; do [ "$e" = "$n" ] && skip=1; done
            [ "$skip" = 1 ] && continue
            case "$sql" in *"|| '|' ||"*) echo "$n|$b" ;; *) echo "$n" ;; esac
        done <"$DK/srv.$svc.dbs" ;;
      *"plt.module_database"*) cat "$DK/rows.module_database" ;;
      *"from tenant where status = 'active'"*) cat "$DK/tenants.active" ;;
      *) exit 1 ;;
    esac
    exit 0 ;;
esac
exit 0
SHIM_EOF
}

# The stand-in for the installed gremion-migration-dump. It is as hostile as the real one:
# status prints db=<name>, a take prints a debug line and a refusal that name the database. Its
# journal lines (the logger shim) are masked for a module database, as the program's are.
dump_prog_body() {
    cat <<'DUMP_EOF'
#!/usr/bin/env bash
cmd="${1:-}"
shift
rel=''; db=''; svc=''; usr=''; reason=''
while [ $# -gt 0 ]; do
    case "$1" in
      --release) rel="$2"; shift ;;
      --db) db="$2"; shift ;;
      --pg-service) svc="$2"; shift ;;
      --pg-user) usr="$2"; shift ;;
      --reason) reason="$2"; shift ;;
    esac
    shift
done
printf '%s rel=%s db=%s svc=%s usr=%s\n' "$cmd" "$rel" "$db" "$svc" "$usr" >>"$DK/dump.log"
live="$DK/live.tsv"
touch "$live"
case "$cmd" in
  take)
    if { [ -n "$svc" ] && [ -z "$usr" ]; } || { [ -z "$svc" ] && [ -n "$usr" ]; }; then
        echo "--pg-service and --pg-user come together or not at all" >&2
        exit 2
    fi
    srv="${svc:-postgres}"
    want="$(cat "$DK/srv.$srv.role")"
    have="${usr:-postgres}"
    if [ "$have" != "$want" ]; then
        echo "PG_DUMP_FAILED: pg_dump of $db failed (role $have)" >&2
        exit 1
    fi
    if [ -f "$DK/take.fail" ] && grep -qxF "$db" "$DK/take.fail"; then
        echo "PG_DUMP_FAILED: pg_dump of $db failed; nothing was migrated" >&2
        exit 1
    fi
    if [ -n "$(awk -F'\t' -v r="$rel" '$2 != r' "$live" | head -n 1)" ]; then
        echo "DUMP_SERIES: a live dump of another release exists (database $db)" >&2
        exit 1
    fi
    if awk -F'\t' -v r="$rel" -v d="$db" '$2 == r && $3 == d { f = 1 } END { exit !f }' "$live"; then
        echo "premigration-dump reused release=$rel db=$db"
        exit 0
    fi
    n="$(cat "$DK/idseq" 2>/dev/null || echo 0)"
    id=$((n + 1))
    echo "$id" >"$DK/idseq"
    if [ -n "$svc" ]; then file="$rel/$svc.$id.dump"; else file="$rel/$db.$id.dump"; fi
    mkdir -p "$DUMPDIR/$rel"
    : >"$DUMPDIR/$file"
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$id" "$rel" "$db" "$svc" "$usr" "$file" >>"$live"
    if [ -n "$svc" ]; then name="svc=$svc"; else name="db=$db"; fi
    logger -t premigration-dump -- "created id=$id release=$rel $name"
    echo "premigration-dump created id=$id release=$rel $name"
    echo "debug: dumped database $db"
    if [ -n "$svc" ]; then echo "TAKE-OK release=$rel svc=$svc id=$id"; else echo "TAKE-OK release=$rel db=$db"; fi
    ;;
  status)
    [ -f "$DK/status.fail" ] && exit 1
    if [ -f "$DK/status.garbage" ]; then echo "nonsense"; exit 0; fi
    hide="$(cat "$DK/status.hide" 2>/dev/null)"
    awk -F'\t' -v r="$rel" -v h="$hide" '(r == "" || $2 == r) && $3 != h { printf "LIVE %s release=%s db=%s taken=2026-11-17T00:00:00Z bytes=100 file=%s\n", $1, $2, $3, $6 }' "$live"
    n="$(awk -F'\t' -v r="$rel" -v h="$hide" '(r == "" || $2 == r) && $3 != h { c++ } END { print c + 0 }' "$live")"
    [ -f "$DK/status.lie" ] && n=$((n + 1))
    printf 'STATUS: %s live dump(s)\n' "$n"
    ;;
  switched | discard)
    if [ "$cmd" = discard ] && [ -z "$reason" ]; then echo "discard needs --reason" >&2; exit 2; fi
    [ -f "$DK/switch.fail" ] && exit 1
    awk -F'\t' -v r="$rel" '$2 != r' "$live" >"$live.new"
    mv -f "$live.new" "$live"
    rm -rf "${DUMPDIR:?}/${rel:?}"
    if [ -f "$DK/switched.leave" ]; then
        printf '99\t%s\tleftover\t\t\t%s/leftover.99.dump\n' "$rel" "$rel" >>"$live"
    fi
    logger -t premigration-dump -- "deleted release=$rel reason=$reason"
    echo "$(printf '%s' "$cmd" | tr '[:lower:]' '[:upper:]')-OK release=$rel"
    ;;
  *) exit 2 ;;
esac
exit 0
DUMP_EOF
}

# a gate-database fixture tree: one module.json per module, declaration-driven
mk_module() { # ID SERVICE|null
    local d="${TREE}/modules/$1"
    mkdir -p "$d"
    if [ "$2" = null ]; then
        printf '{"id":"%s","runtime":{"database":null}}\n' "$1" >"$d/module.json"
    else
        printf '{"id":"%s","runtime":{"database":{"postgresService":"%s","migrations":"migrations"}}}\n' "$1" "$2" >"$d/module.json"
    fi
}

# a server of the shim: SERVICE ROLE running(0|1), its databases on stdin
mk_server() {
    local svc="$1" role="$2" up="$3"
    echo "$role" >"$DK/srv.${svc}.role"
    cat >"$DK/srv.${svc}.dbs"
    echo "${svc}" >"$DK/ctr.c-${svc}"
    if [ "$up" = 1 ]; then echo "c-${svc}" >"$DK/cid.teststack-state.${svc}"; fi
}

setup() {
    cd_setup
    export STACK=teststack TZ=UTC
    DK="${SHIM_DIR}/dk"
    DUMPDIR="${GREMION_ROOT}/migration-dumps"
    TREE="${GREMION_ROOT}/releases/cccccccccccc"
    export DK DUMPDIR TREE
    mkdir -p "$DK" "${TREE}" "${GREMION_ROOT}/runtime" "${TREE}/docker/pgbouncer"
    printf -- '-- fixture of the auth_query function\nCREATE SCHEMA IF NOT EXISTS pgbouncer;\n' >"${TREE}/docker/pgbouncer/pgbouncer-auth.sql"
    mkdir -m 700 "$DUMPDIR"
    : >"$DK/dump.log"
    : >"$DK/exec.log"
    : >"$DK/run.log"
    : >"$DK/ps.log"
    cp "${FIX}/state.env" "${FIX}/app-blue.env" "${FIX}/app-green.env" "${GREMION_ROOT}/etc/env/"
    # made-up values are generated, never committed
    PW="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    export PW
    {
        printf 'GREMION_MIGRATION_DUMP_DIR=%s\n' "$DUMPDIR"
        printf 'PGBOUNCER_AUTH_PASSWORD=%s\n' "$PW"
    } >>"${GREMION_ROOT}/etc/env/state.env"
    echo "$TAG" >"$DK/ref"
    shim docker "$(docker_shim_body)"
    shim logger
    # timeout logs its argv, then runs the command: the cap of a call is visible, not enforced
    shim timeout 'if [ "$1" = -k ]; then shift 2; fi; shift; exec "$@"'
    shim systemctl 'cat "$DK/timers.json" 2>/dev/null || exit 1; [ -f "$DK/timers.json" ] || exit 1'
    shim df 'printf "Filesystem 1024-blocks Used Available Capacity Mounted\nx 1 1 %s 1%% /\n" "$(cat "$DK/df" 2>/dev/null || echo 99999999)"'
    dump_prog_body >"${GREMION_ROOT}/bin/gremion-migration-dump"
    chmod +x "${GREMION_ROOT}/bin/gremion-migration-dump"
    # the main server
    mk_server postgres postgres 1 <<EOF
control|1000
gremion|2000
gremion_platform|3000
keycloak|4000
postgres|100
t_${H1}__kernel|5000
t_${H2}__kernel|6000
gremion_kernel_api|700
EOF
    # the module servers: calendar, content and publishing (newsletter) run, finance and vault do not
    mk_server calendar-postgres calendar 1 <<EOF
postgres|100
t_${H1}__calendar|1000
t_${H3}__calendar|1100
t_${H4}__calendar|1200
${SLUG_DB}|1300
calendar_control|1400
EOF
    mk_server content-postgres content 1 <<EOF
postgres|100
t_${H1}__content|1000
t_${H5}__content|1100
t_${H6}__content|1200
content_some-slug|1300
content_control|1400
EOF
    mk_server newsletter-postgres newsletter 1 <<EOF
postgres|100
t_${H1}__publishing|1000
newsletter_some-slug|1300
newsletter_control|1400
EOF
    mk_server finance-postgres finance 0 </dev/null
    mk_server vault-postgres vault 0 </dev/null
    # servers the set must never enter (they answer, so a call would show in exec.log)
    mk_server messaging-postgres messaging 1 </dev/null
    mk_server governance-postgres governance 1 </dev/null
    mk_server nextcloud-postgres nextcloud 1 </dev/null
    printf '%s\n%s\n' "$H1" "$H2" >"$DK/tenants.active"
    cat >"$DK/rows.module_database" <<EOF
t_${H1}__calendar|enabled
t_${H3}__calendar|blocked
t_${H4}__calendar|dropped
t_${H1}__content|enabled
t_${H5}__content|enabling
t_${H1}__publishing|enabled
EOF
    # the release tree: declaration-driven
    mk_module calendar calendar-postgres
    mk_module content content-postgres
    mk_module publishing newsletter-postgres
    mk_module finance finance-postgres
    mk_module vault vault-postgres
    mk_module board null
    export CLASS_EMPTY='{"v":1,"app_only":true,"state_tier":[],"holds":[],"hold":null,"compose":"checked","migrations":{"total":0,"chains":{}},"host":{"changed":0,"groups":{}},"ci_changed":false}'
    LIVE_JSON="$(jq -n --arg t "${GREMION_ROOT}/releases/aaaaaaaaaaaa" \
        '{sha:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", sha12:"aaaaaaaaaaaa", tag:"pilot-aaaaaaaaaaaa", colour:"blue", tree:$t, since:"2026-11-01T00:00:00Z", proof:false, modules:null, leaves:null, reconcile:null}')"
    export LIVE_JSON
    seed_state
}

teardown() {
    cd_teardown
}

# ---------------------------------------------------------------- helpers

# dat 'snippet' -- the real libraries in the dispatcher's order (data.sh before docker.sh),
# then the stubs; the cd lock held (state writes need it); no errexit.
dat() {
    local snippet="$1"
    shift
    bash -c "set -uo pipefail
. \"\${HOST_SRC}/lib/common.sh\"
. \"\${HOST_SRC}/lib/cd/core.sh\"
. \"\${HOST_SRC}/lib/cd/data.sh\"
. \"\${HOST_SRC}/lib/cd/docker.sh\"
. \"\${GREMION_CD_STUBS_DIR}/cd-stubs.sh\"
cd_cfg_load || exit 99
cd_lock_take || exit 98
${snippet}" dat "$@"
}

# seed_state [JQ] -- a releasing state: live blue, the release record of tag cccccccccccc
# going to green, then the filter.
seed_state() {
    local rel
    rel="$(jq -n --arg t "$TREE" --argjson c "$CLASS_EMPTY" \
        '{id:"cccccccccccc-1", sha:"cccccccccccccccccccccccccccccccccccccccc", sha12:"cccccccccccc", tag:"pilot-cccccccccccc", colour:"green", tree:$t, mode:"auto", stage:"snapshot", stage_status:"started", class:$c, rollback_target:null}')"
    cd_seed_state ".phase = \"releasing\" | .live = ${LIVE_JSON} | .release = ${rel} | ${1:-.}"
}

# the lines of the dump program's own log that are takes of a database
takes() { grep '^take ' "$DK/dump.log" || true; }

timers_json() { # BACKUP_EPOCH PURGE_EPOCH
    jq -cn --argjson b "$1" --argjson p "$2" '
        [{unit:"gremion-cd.timer", next:(($b + 5) * 1000000), activates:"gremion-cd.service"},
         {unit:"gremion-backup.timer", next:($b * 1000000), activates:"gremion-backup.service"},
         {unit:"gremion-purge.timer", next:($p * 1000000), activates:"gremion-purge.service"}]' >"$DK/timers.json"
}

# every stream and file a leak could reach, concatenated: the captured streams, the state
# file, the history, the outbox, the logger shim's lines and the dump file names
leak_haystack() {
    cat "$@" 2>/dev/null || true
    cat "${GREMION_ROOT}/data/cd/state.json" "${GREMION_ROOT}/data/cd/history.jsonl" 2>/dev/null || true
    cat "${GREMION_ROOT}"/data/cd/outbox/* 2>/dev/null || true
    grep '^logger ' "$SHIM_LOG" 2>/dev/null || true
    find "$DUMPDIR" 2>/dev/null || true
}

# ---------------------------------------------------------------- the role-enforcing shim

@test "shim: -U postgres against a module server fails with role does not exist and exit 2; the module's own role works" {
    run docker exec c-calendar-postgres psql -X -U postgres -d postgres -Atq -c "select 1 from pg_database"
    [ "$status" -eq 2 ]
    [[ "$output" == *'role "postgres" does not exist'* ]]
    run docker exec c-calendar-postgres psql -X -U calendar -d postgres -Atq -c "select datname || '|' || pg_database_size(datname) from pg_database"
    [ "$status" -eq 0 ]
    run docker exec c-postgres psql -X -U calendar -d postgres -Atq -c "select 1 from pg_database"
    [ "$status" -eq 2 ]
    run "${GREMION_ROOT}/bin/gremion-migration-dump" take --release x --db y --pg-service calendar-postgres --pg-user postgres
    [ "$status" -eq 1 ]
    run "${GREMION_ROOT}/bin/gremion-migration-dump" take --release x --db y --pg-service calendar-postgres
    [ "$status" -eq 2 ]
}

# ---------------------------------------------------------------- cd_data_kernel_db_ids

@test "kernel_db_ids: fills the caller's array with the ids of the t_<hex32>__kernel databases and prints nothing" {
    run --separate-stderr dat 'declare -a ids=(old); cd_data_kernel_db_ids ids; echo "rc=$? n=${#ids[@]} first=${ids[0]} last=${ids[1]}"'
    [ "$status" -eq 0 ]
    [ "$output" = "rc=0 n=2 first=${H1} last=${H2}" ]
    [ -z "$stderr" ]
    run --separate-stderr dat 'cd_data_kernel_db_ids ids >/tmp/kdi.out 2>&1; rc=$?; [ ! -s /tmp/kdi.out ] && echo "silent rc=$rc"'
    [ "$output" = "silent rc=0" ]
    # a caller array that is named like a local of the function still gets the ids
    local name
    for name in rows line pguser out found arg; do
        run --separate-stderr dat "declare -a ${name}=(old); cd_data_kernel_db_ids ${name}; echo \"rc=\$? n=\${#${name}[@]} first=\${${name}[0]}\""
        [ "$output" = "rc=0 n=2 first=${H1}" ]
    done
    # a name that the function reserves is refused
    run --separate-stderr dat 'declare -a _cd_out=(old); cd_data_kernel_db_ids _cd_out; echo "rc=$?"'
    [ "$output" = "rc=2" ]
}

@test "kernel_db_ids: an empty listing and a failed listing are errors, never an empty array" {
    : >"$DK/srv.postgres.dbs"
    run --separate-stderr dat 'declare -a ids=(keep); cd_data_kernel_db_ids ids; echo "rc=$? n=${#ids[@]}"'
    [ "$output" = "rc=2 n=1" ]
    printf 'control|1\n' >"$DK/srv.postgres.dbs"
    touch "$DK/psql.fail.postgres"
    run --separate-stderr dat 'declare -a ids=(keep); cd_data_kernel_db_ids ids; echo "rc=$? n=${#ids[@]}"'
    [ "$output" = "rc=4 n=1" ]
    rm -f "$DK/psql.fail.postgres"
    run --separate-stderr dat 'declare -a ids=(keep); cd_data_kernel_db_ids ids; echo "rc=$? n=${#ids[@]}"'
    [ "$output" = "rc=0 n=0" ]
}

# ---------------------------------------------------------------- the dump set

@test "set: the main-server part is the allow-list: control, gremion, gremion_platform, every kernel database and a kernel-api service database, and neither postgres nor the Keycloak database" {
    run --separate-stderr dat "cd_data_dumpset_take ${TAG} app; echo rc=\$?"
    [ "$status" -eq 0 ]
    [[ "$output" == *"rc=0"* ]]
    local main
    main="$(takes | grep -v -- '--pg-service' | sed -E 's/^take rel=.*//; s/^take --release [^ ]+ --db ([^ ]+).*/\1/')" || true
    main="$(grep '^take rel=' "$DK/dump.log" | grep 'svc= ' | sed -E 's/.* db=([^ ]+) .*/\1/' | sort | tr '\n' ' ')"
    [ "$main" = "control gremion gremion_kernel_api gremion_platform t_${H1}__kernel t_${H2}__kernel " ]
    [ "$(grep -c 'db=keycloak' "$DK/dump.log")" -eq 0 ]
    [ "$(grep -c 'db=postgres ' "$DK/dump.log")" -eq 0 ]
}

@test "set: the module part takes every non-template database of a running module server with --pg-service and --pg-user together, the role read from state.env by name" {
    run --separate-stderr dat "cd_data_dumpset_take ${TAG} app; echo rc=\$?"
    [[ "$output" == *"rc=0"* ]]
    # calendar: the gate database, the leaf database and the leaf catalogue; blocked and dropped are not
    grep -q "^take rel=${TAG} db=t_${H1}__calendar svc=calendar-postgres usr=calendar$" "$DK/dump.log"
    grep -q "^take rel=${TAG} db=${SLUG_DB} svc=calendar-postgres usr=calendar$" "$DK/dump.log"
    grep -q "^take rel=${TAG} db=calendar_control svc=calendar-postgres usr=calendar$" "$DK/dump.log"
    grep -q "^take rel=${TAG} db=content_some-slug svc=content-postgres usr=content$" "$DK/dump.log"
    grep -q "^take rel=${TAG} db=newsletter_control svc=newsletter-postgres usr=newsletter$" "$DK/dump.log"
    grep -q "^take rel=${TAG} db=t_${H1}__publishing svc=newsletter-postgres usr=newsletter$" "$DK/dump.log"
    # a gate database in enabling and one with no row are taken (conservative)
    grep -q "^take rel=${TAG} db=t_${H5}__content svc=content-postgres usr=content$" "$DK/dump.log"
    grep -q "^take rel=${TAG} db=t_${H6}__content svc=content-postgres usr=content$" "$DK/dump.log"
    # blocked (Karenz) and dropped: no take names them
    [ "$(grep -c "t_${H3}__calendar" "$DK/dump.log")" -eq 0 ]
    [ "$(grep -c "t_${H4}__calendar" "$DK/dump.log")" -eq 0 ]
    # the options always come together (the stand-in refuses one without the other, so a take would have failed)
    [ "$(grep '^take ' "$DK/dump.log" | grep -c 'svc=calendar-postgres usr=calendar$')" -eq 3 ]
    [ "$(grep '^take ' "$DK/dump.log" | grep -c ' svc=[a-z]*-postgres usr=$')" -eq 0 ]
    # the counts of what was skipped are in the history, by state, and carry no name
    grep -q '"event":"dumpset_taken"' "${GREMION_ROOT}/data/cd/history.jsonl"
    [ "$(jq -r 'select(.event == "dumpset_taken") | .blocked_skipped' "${GREMION_ROOT}/data/cd/history.jsonl")" = 1 ]
    [ "$(jq -r 'select(.event == "dumpset_taken") | .dropped_skipped' "${GREMION_ROOT}/data/cd/history.jsonl")" = 1 ]
    [ "$(jq -r 'select(.event == "dumpset_taken") | .servers_skipped' "${GREMION_ROOT}/data/cd/history.jsonl")" = 2 ]
}

@test "set: no call of the set uses a role on a server that does not have it (the postgres role only on the main server)" {
    run --separate-stderr dat "cd_data_dumpset_take ${TAG} app; echo rc=\$?"
    [[ "$output" == *"rc=0"* ]]
    # every exec of the shim carries the role of its own server, and every one of the four
    # running servers was entered (a check that collected nothing fails)
    [ "$(takes | wc -l)" -gt 0 ]
    while read -r svc role; do
        [ "$(grep -c "^exec svc=${svc} " "$DK/exec.log")" -gt 0 ]
        [ "$(grep "^exec svc=${svc} " "$DK/exec.log" | grep -vc "role=${role} ")" -eq 0 ]
    done <<EOF
postgres postgres
calendar-postgres calendar
content-postgres content
newsletter-postgres newsletter
EOF
}

@test "set: the servers of messaging, governance and Nextcloud and the Keycloak server are never entered" {
    run --separate-stderr dat "cd_data_dumpset_take ${TAG} app; echo rc=\$?"
    [[ "$output" == *"rc=0"* ]]
    # the set did run: the main server and the running module servers were entered, and
    # databases were taken (a check that collected nothing fails)
    [ "$(grep -c '^exec svc=postgres ' "$DK/exec.log")" -gt 0 ]
    [ "$(grep -c '^exec svc=calendar-postgres ' "$DK/exec.log")" -gt 0 ]
    [ "$(takes | wc -l)" -gt 0 ]
    [ "$(grep -c 'svc=messaging-postgres\|svc=governance-postgres\|svc=nextcloud-postgres\|svc=keycloak' "$DK/exec.log")" -eq 0 ]
    [ "$(grep -c 'c-messaging\|c-governance\|c-nextcloud' "$SHIM_LOG")" -eq 0 ]
}

@test "set: a module server that is not running is skipped and counted; with an enabled row it is a refusal" {
    rm -f "$DK/cid.teststack-state.newsletter-postgres"
    run --separate-stderr dat "cd_data_dumpset_take ${TAG} app; echo rc=\$?"
    [[ "$output" == *"rc=2"* ]]
    [[ "$stderr" == *"newsletter-postgres"*"not running"* ]]
    [ "$(grep -c '^take ' "$DK/dump.log" || true)" -eq 0 ]
    # the same server with no enabled row is skipped and counted (a fresh ledger, a fresh log)
    grep -v '__publishing' "$DK/rows.module_database" >"$DK/rows.new"
    mv "$DK/rows.new" "$DK/rows.module_database"
    run --separate-stderr dat "cd_data_dumpset_take ${TAG} app; echo rc=\$?"
    [[ "$output" == *"rc=0"* ]]
    [ "$(jq -r 'select(.event == "dumpset_taken") | .servers_skipped' "${GREMION_ROOT}/data/cd/history.jsonl")" = 3 ]
}

@test "set: a module whose module.json says database null is never entered (declaration-driven)" {
    mk_module calendar null
    run --separate-stderr dat "cd_data_dumpset_take ${TAG} app; echo rc=\$?"
    # calendar still has an enabled row, whose database is then not in the set: a refusal
    [[ "$output" == *"rc=2"* ]]
    grep -v '__calendar' "$DK/rows.module_database" >"$DK/rows.new"
    mv "$DK/rows.new" "$DK/rows.module_database"
    : >"$DK/exec.log"
    run --separate-stderr dat "cd_data_dumpset_take ${TAG} app; echo rc=\$?"
    [[ "$output" == *"rc=0"* ]]
    [ "$(grep -c 'svc=calendar-postgres' "$DK/exec.log")" -eq 0 ]
    [ "$(grep -c 'svc=calendar-postgres' "$DK/dump.log")" -eq 0 ]
    [ "$(grep -c 'svc=content-postgres' "$DK/dump.log")" -gt 0 ]
}

@test "set: board is entered if and only if its module.json declares a database (the expectation is read from the real file)" {
    cp "${KERNEL_ROOT}/modules/board/module.json" "${TREE}/modules/board/module.json"
    mk_server board-postgres board 1 <<EOF
postgres|100
t_${H1}__board|1000
EOF
    printf 't_%s__board|enabled\n' "$H1" >>"$DK/rows.module_database"
    run --separate-stderr dat "cd_data_dumpset_take ${TAG} app; echo rc=\$?"
    local declared
    declared="$(jq -r '.runtime.database != null' "${KERNEL_ROOT}/modules/board/module.json")"
    if [ "$declared" = true ]; then
        [ "$(grep -c 'svc=board-postgres' "$DK/dump.log")" -gt 0 ]
        [[ "$output" == *"rc=0"* ]]
    else
        [ "$(grep -c 'svc=board-postgres' "$DK/exec.log")" -eq 0 ]
        # the enabled row of a module that declares no database is then not in the set: a refusal
        [[ "$output" == *"rc=2"* ]]
    fi
}

@test "set: the same database name on two servers is a refusal" {
    printf '%s|1\n' "$SLUG_DB" >>"$DK/srv.content-postgres.dbs"
    run --separate-stderr dat "cd_data_dumpset_take ${TAG} app; echo rc=\$?"
    [[ "$output" == *"rc=2"* ]]
    [[ "$stderr" == *"two servers"* ]]
    [[ "$stderr" != *"$SLUG_DB"* ]]
    [ "$(grep -c '^take ' "$DK/dump.log" || true)" -eq 0 ]
}

@test "set: a gate database that the registry lists as blocked is not taken by any call, and a taken one in the same server is (guard: watched red by taking a blocked one)" {
    run --separate-stderr dat "cd_data_dumpset_take ${TAG} app; echo rc=\$?"
    [[ "$output" == *"rc=0"* ]]
    [ "$(grep -c "t_${H3}__calendar" "$DK/dump.log")" -eq 0 ]
    [ "$(grep -c "t_${H1}__calendar" "$DK/dump.log")" -eq 1 ]
}

@test "set cross-check: an active customer with no kernel database in the set is a refusal" {
    printf '%s\n' "dddddddddddddddddddddddddddd1234" >>"$DK/tenants.active"
    run --separate-stderr dat "cd_data_dumpset_take ${TAG} app; echo rc=\$?"
    [[ "$output" == *"rc=2"* ]]
    [[ "$stderr" == *"active customer"* ]]
    [ "$(grep -c '^take ' "$DK/dump.log" || true)" -eq 0 ]
}

@test "set cross-check: a listing without control, gremion or gremion_platform, or an empty listing, is a refusal" {
    local keep n
    cp "$DK/srv.postgres.dbs" "$DK/keep.dbs"
    for n in control gremion gremion_platform; do
        grep -v "^${n}|" "$DK/keep.dbs" >"$DK/srv.postgres.dbs"
        run --separate-stderr dat "cd_data_dumpset_take ${TAG} app; echo rc=\$?"
        [[ "$output" == *"rc=2"* ]]
    done
    printf 'postgres|1\n' >"$DK/srv.postgres.dbs"
    run --separate-stderr dat "cd_data_dumpset_take ${TAG} app; echo rc=\$?"
    [[ "$output" == *"rc=2"* ]]
    : >"$DK/srv.postgres.dbs"
    run --separate-stderr dat "cd_data_dumpset_take ${TAG} app; echo rc=\$?"
    [[ "$output" == *"rc=2"* ]]
    [ "$(grep -c '^take ' "$DK/dump.log" || true)" -eq 0 ]
    : "$keep"
}

@test "set cross-check: a plt.module_database row in state enabled whose database is not on its server is a refusal" {
    printf 't_%s__calendar|enabled\n' "$H2" >>"$DK/rows.module_database"
    run --separate-stderr dat "cd_data_dumpset_take ${TAG} app; echo rc=\$?"
    [[ "$output" == *"rc=2"* ]]
    [[ "$stderr" == *"not in the set"* ]]
    [ "$(grep -c '^take ' "$DK/dump.log" || true)" -eq 0 ]
}

@test "set: a row in a state outside the five known ones, or a row that is no gate name, is a refusal" {
    printf 't_%s__calendar|weird\n' "$H2" >>"$DK/rows.module_database"
    run --separate-stderr dat "cd_data_dumpset_take ${TAG} app; echo rc=\$?"
    [[ "$output" == *"rc=2"* ]]
}

@test "set: a failing listing of a running module server is code 4 (infrastructure) and nothing is taken" {
    touch "$DK/psql.fail.content-postgres"
    run --separate-stderr dat "cd_data_dumpset_take ${TAG} app; echo rc=\$?"
    [[ "$output" == *"rc=4"* ]]
    [ "$(grep -c '^take ' "$DK/dump.log" || true)" -eq 0 ]
}

@test "state set: adds the Keycloak database, uses the label state-<tag> and takes no module server" {
    run --separate-stderr dat "cd_data_dumpset_take state-${TAG} state; echo rc=\$?"
    [[ "$output" == *"rc=0"* ]]
    grep -q "^take rel=state-${TAG} db=keycloak svc= usr=$" "$DK/dump.log"
    grep -q "^take rel=state-${TAG} db=control svc= usr=$" "$DK/dump.log"
    [ "$(grep -c 'svc=[a-z]*-postgres' "$DK/dump.log")" -eq 0 ]
    [ "$(grep -c 'svc=calendar\|svc=content\|svc=newsletter' "$DK/exec.log")" -eq 0 ]
    # the app set never adds Keycloak and takes the module part
    run --separate-stderr dat "cd_data_dumpset_discard state-${TAG} 'state test over'; echo rc=\$?"
    [[ "$output" == *"rc=0"* ]]
    : >"$DK/dump.log"
    run --separate-stderr dat "cd_data_dumpset_take ${TAG} app; echo rc=\$?"
    [[ "$output" == *"rc=0"* ]]
    [ "$(grep -c 'db=keycloak' "$DK/dump.log")" -eq 0 ]
    [ "$(grep -c 'svc=calendar-postgres' "$DK/dump.log")" -gt 0 ]
    run --separate-stderr dat "cd_data_dumpset_take wrong-label state; echo rc=\$?"
    [[ "$output" == *"rc=2"* ]]
}

@test "set: a bad kind and a bad label are refused before anything runs" {
    run --separate-stderr dat "cd_data_dumpset_take ${TAG} nonsense; echo rc=\$?"
    [[ "$output" == *"rc=2"* ]]
    run --separate-stderr dat "cd_data_dumpset_take 'a b' app; echo rc=\$?"
    [[ "$output" == *"rc=2"* ]]
    run --separate-stderr dat "cd_data_dumpset_take '' app; echo rc=\$?"
    [[ "$output" == *"rc=2"* ]]
    [ ! -s "$DK/dump.log" ]
}

# ---------------------------------------------------------------- policy

@test "policy: always takes both parts for an empty lock diff" {
    run --separate-stderr dat "cd_data_dumpset_take ${TAG} app; echo rc=\$?"
    [[ "$output" == *"rc=0"* ]]
    [ "$(grep -c ' svc= usr=$' "$DK/dump.log")" -gt 0 ]
    [ "$(grep -c 'svc=calendar-postgres' "$DK/dump.log")" -gt 0 ]
}

@test "policy: migration skips both parts for an empty diff, takes the main part for any diff and the module part only when a module-upgrade chain gained a file" {
    local empty='{"migrations":{"total":0,"chains":{}}}'
    local kernel='{"migrations":{"total":1,"chains":{"kernel-data":{"class":"legacy-boot","expand":1,"migrate":0,"contract":0}}}}'
    local module='{"migrations":{"total":1,"chains":{"module-calendar":{"class":"module-upgrade","expand":1,"migrate":0,"contract":0}}}}'
    local idle='{"migrations":{"total":2,"chains":{"module-calendar":{"class":"module-upgrade","expand":0,"migrate":0,"contract":0}}}}'
    run --separate-stderr dat "_cd_data_parts migration '${empty}'"
    [ "$output" = "0 0" ]
    run --separate-stderr dat "_cd_data_parts migration '${kernel}'"
    [ "$output" = "1 0" ]
    run --separate-stderr dat "_cd_data_parts migration '${module}'"
    [ "$output" = "1 1" ]
    run --separate-stderr dat "_cd_data_parts migration '${idle}'"
    [ "$output" = "1 0" ]
    run --separate-stderr dat "_cd_data_parts always '${empty}'"
    [ "$output" = "1 1" ]
    # an unreadable or missing class is not an empty diff: both parts
    run --separate-stderr dat "_cd_data_parts migration ''"
    [ "$output" = "1 1" ]
    run --separate-stderr dat "_cd_data_parts migration '{\"migrations\":null}'"
    [ "$output" = "1 1" ]
    run --separate-stderr dat "_cd_data_parts nonsense '${empty}'; echo rc=\$?"
    [[ "$output" == *"rc=2"* ]]
}

@test "policy: migration with an empty lock diff takes nothing and still succeeds; migrate then needs no dump" {
    run --separate-stderr dat "CD_CFG[CD_DUMP_POLICY]=migration; cd_data_dumpset_take ${TAG} app; echo rc=\$?"
    [[ "$output" == *"rc=0"* ]]
    [ ! -s "$DK/dump.log" ]
    # the take itself ran and recorded an empty set (a stub that returns 0 records nothing)
    grep -q 'dumpset_taken' "${GREMION_ROOT}/data/cd/history.jsonl"
}

# ---------------------------------------------------------------- precheck

@test "precheck: passes on a healthy fixture" {
    run --separate-stderr dat 'cd_data_precheck; echo rc=$?'
    [ "$output" = "rc=0" ]
    # it read the ledger and sized the set from the servers (a stub that returns 0 does neither)
    grep -q '^status ' "$DK/dump.log"
    [ "$(grep -c '^exec svc=postgres ' "$DK/exec.log")" -gt 0 ]
}

@test "precheck: creates the dump directory 0700 when it is absent and refuses a directory with another mode" {
    rmdir "$DUMPDIR"
    run --separate-stderr dat 'cd_data_precheck; echo rc=$?'
    [ "$output" = "rc=0" ]
    [ "$(stat -c %a "$DUMPDIR")" = 700 ]
    chmod 755 "$DUMPDIR"
    run --separate-stderr dat 'cd_data_precheck; echo rc=$?'
    [ "$output" = "rc=2" ]
    [[ "$stderr" == *"mode 755"* ]]
}

@test "precheck: refuses a dump directory that is owned by another uid (the id shim names another)" {
    shim id 'echo 424242'
    run --separate-stderr dat 'cd_data_precheck; echo rc=$?'
    [ "$output" = "rc=2" ]
    [[ "$stderr" == *"owned by uid"* ]]
}

@test "precheck: a dump directory that is a symlink or a file is refused" {
    rmdir "$DUMPDIR"
    : >"${DUMPDIR}"
    run --separate-stderr dat 'cd_data_precheck; echo rc=$?'
    [ "$output" = "rc=2" ]
}

@test "precheck: a live dump of another label is a refusal that names the label; the own label's live set is not" {
    printf '1\tpilot-bbbbbbbbbbbb\tgremion\t\t\tpilot-bbbbbbbbbbbb/gremion.1.dump\n' >"$DK/live.tsv"
    run --separate-stderr dat 'cd_data_precheck; echo rc=$?'
    [ "$output" = "rc=2" ]
    [[ "$stderr" == *"pilot-bbbbbbbbbbbb"* ]]
    printf '1\t%s\tgremion\t\t\t%s/gremion.1.dump\n' "$TAG" "$TAG" >"$DK/live.tsv"
    run --separate-stderr dat 'cd_data_precheck; echo rc=$?'
    [ "$output" = "rc=0" ]
    # the program refuses every label but one: a state-tier set of the same release is another label
    printf '1\tstate-%s\tgremion\t\t\tstate-%s/gremion.1.dump\n' "$TAG" "$TAG" >"$DK/live.tsv"
    run --separate-stderr dat 'cd_data_precheck; echo rc=$?'
    [ "$output" = "rc=2" ]
    [[ "$stderr" == *"state-${TAG}"* ]]
}

@test "precheck: a ledger lock file is a refusal with the documented command" {
    : >"${DUMPDIR}/ledger.lock"
    run --separate-stderr dat 'cd_data_precheck; echo rc=$?'
    [ "$output" = "rc=2" ]
    [[ "$stderr" == *"ledger lock"* ]]
    [[ "$stderr" == *"remove ledger.lock"* ]]
}

@test "precheck: free space below twice the sum of the sizes is a refusal; at twice the sum it passes" {
    # the fixture's set: main 1000+2000+3000+5000+6000+700 = 17700, modules 1000+1100+1200+1300+1400 (calendar, without blocked/dropped: 1000+1300+1400) ...
    local sum
    sum=$(( 1000 + 2000 + 3000 + 5000 + 6000 + 700 + (1000 + 1300 + 1400) + (1000 + 1100 + 1200 + 1300 + 1400) + (1000 + 1300 + 1400) ))
    # df shim answers KB: 2 x sum bytes needs ceil(2*sum/1024) KB
    echo $(( (2 * sum) / 1024 )) >"$DK/df"
    run --separate-stderr dat 'cd_data_precheck; echo rc=$?'
    # a refusal (2), not a failure that a retry could clear
    [ "$output" = "rc=2" ]
    [[ "$stderr" == *"free"* ]]
    # a free space that cannot be read is the infrastructure code
    echo "not-a-number" >"$DK/df"
    run --separate-stderr dat 'cd_data_precheck; echo rc=$?'
    [ "$output" = "rc=4" ]
    echo $(( (2 * sum) / 1024 )) >"$DK/df"
    echo $(( (2 * sum) / 1024 + 1 )) >"$DK/df"
    run --separate-stderr dat 'cd_data_precheck; echo rc=$?'
    [ "$output" = "rc=0" ]
}

@test "precheck: a container override of the dump program (environment or state.env) is a refusal" {
    run --separate-stderr env GREMION_MIGRATION_DUMP_PG_CONTAINER=c-x bash -c "$(declare -f dat); dat 'cd_data_precheck; echo rc=\$?'"
    [[ "$output" == *"rc=2"* ]]
    printf 'GREMION_MIGRATION_DUMP_PG_CONTAINER=c-x\n' >>"${GREMION_ROOT}/etc/env/state.env"
    run --separate-stderr dat 'cd_data_precheck; echo rc=$?'
    [ "$output" = "rc=2" ]
    [[ "$stderr" == *"state.env"* ]]
}

@test "precheck: the dump program must be installed" {
    rm -f "${GREMION_ROOT}/bin/gremion-migration-dump"
    run --separate-stderr dat 'cd_data_precheck; echo rc=$?'
    [ "$output" = "rc=2" ]
}

# ---------------------------------------------------------------- lock span floor

@test "lock span: the default of CD_LOCK_SPAN_MAX_MIN is no less than the sum of the stage caps plus the allowance (it passes the precheck with the default config)" {
    run --separate-stderr dat 'cd_data_lock_span_floor; cd_cfg CD_LOCK_SPAN_MAX_MIN'
    [ "${lines[0]}" -le "${lines[1]}" ]
    # the arithmetic: module step 900 + three leaf runs 3 x 600 + the two kernel one-shots
    # 2 x 600 + six kill confirmations 6 x 60 = 4260 s = 71 min, + watch 20 + pause 15 + commit 30
    # + the allowance 30
    [ "${lines[0]}" -eq 166 ]
}

@test "lock span: the floor counts the cap of each kernel one-shot and a kill confirmation for each (guard: watched red when only the module and leaf caps were summed)" {
    # a longer one-shot cap raises the floor by two caps (2 x 600 s = 20 min); a second one-shot
    # more would raise it by one cap and one confirmation (11 min)
    run --separate-stderr dat '_CD_DATA_ONESHOT_TIMEOUT_S=1200; cd_data_lock_span_floor'
    [ "$output" -eq 186 ]
    run --separate-stderr dat '_CD_DATA_ONESHOTS=3; cd_data_lock_span_floor'
    [ "$output" -eq 177 ]
    # the default passes the precheck only because it covers them: a default one cap short refuses
    cd_write_cfg CD_LOCK_SPAN_MAX_MIN=165
    run --separate-stderr dat 'cd_data_precheck; echo rc=$?'
    [ "$output" = "rc=2" ]
    [[ "$stderr" == *"166"* ]]
    cd_write_cfg CD_LOCK_SPAN_MAX_MIN=166
    run --separate-stderr dat 'cd_data_precheck; echo rc=$?'
    [ "$output" = "rc=0" ]
}

@test "lock span: no environment variable changes the cap of a one-shot or of a query (the floor sums the constants)" {
    run --separate-stderr env CD_DATA_ONESHOT_TIMEOUT_S=7200 CD_DATA_QUERY_TIMEOUT_S=7200 bash -c "$(declare -f dat); dat 'cd_data_lock_span_floor; cd_data_precheck; echo rc=\$?'"
    [ "${lines[0]}" -eq 166 ]
    [ "${lines[1]}" = "rc=0" ]
    run --separate-stderr env TAG="$TAG" CD_DATA_ONESHOT_TIMEOUT_S=7200 bash -c "$(declare -f dat mig); mig"
    [[ "$output" == *"rc=0"* ]]
    grep -qE "^timeout -k 10 600 docker compose .* migrate\$" "$SHIM_LOG"
    [ "$(grep -c "^timeout -k 10 7200 " "$SHIM_LOG")" -eq 0 ]
}

@test "lock span: a raised cap without a raised default is refused (guard: watched red by setting CD_LEAF_MIGRATE_TIMEOUT_S to 1800)" {
    cd_write_cfg CD_LEAF_MIGRATE_TIMEOUT_S=1800
    run --separate-stderr dat 'cd_data_precheck; echo rc=$?'
    [ "$output" = "rc=2" ]
    [[ "$stderr" == *"CD_LOCK_SPAN_MAX_MIN"* ]]
    cd_write_cfg CD_LEAF_MIGRATE_TIMEOUT_S=1800 CD_LOCK_SPAN_MAX_MIN=300
    run --separate-stderr dat 'cd_data_precheck; echo rc=$?'
    [ "$output" = "rc=0" ]
    # every other cap is in the sum
    local k
    for k in CD_MODULE_UPGRADE_TIMEOUT_S=3000 CD_WATCH_MINUTES=60 CD_PAUSE_MAX_MIN=60 CD_COMMIT_MAX_MIN=90; do
        cd_write_cfg "$k"
        run --separate-stderr dat 'cd_data_precheck; echo rc=$?'
        [ "$output" = "rc=2" ]
    done
}

# ---------------------------------------------------------------- the label

@test "label: the label passed to take must equal GREMION_RELEASE_REF of kernel-api-migrate from compose config (guard: watched red by x-<tag>)" {
    run --separate-stderr dat "cd_data_dumpset_take x-${TAG} app; echo rc=\$?"
    [[ "$output" == *"rc=2"* ]]
    [[ "$stderr" == *"release ref"* ]]
    [ ! -s "$DK/dump.log" ]
    run --separate-stderr dat "cd_data_dumpset_take ${TAG} app; echo rc=\$?"
    [[ "$output" == *"rc=0"* ]]
    # compose was asked as the one compose shape: the target colour's env file, the profile star, no -f and no -p
    grep -qE '^docker compose --env-file .*app-green.env --profile \* config --format json$' "$SHIM_LOG"
}

@test "label: a ref that differs from the label, a missing ref and a failing compose are refusals (4 for compose)" {
    echo "pilot-dddddddddddd" >"$DK/ref"
    run --separate-stderr dat "cd_data_dumpset_take ${TAG} app; echo rc=\$?"
    [[ "$output" == *"rc=2"* ]]
    echo '{"services":{"kernel-api-migrate":{"environment":{}}}}' >"$DK/config.json"
    run --separate-stderr dat "cd_data_dumpset_take ${TAG} app; echo rc=\$?"
    [[ "$output" == *"rc=2"* ]]
    rm -f "$DK/config.json"
    touch "$DK/config.fail"
    run --separate-stderr dat "cd_data_dumpset_take ${TAG} app; echo rc=\$?"
    [[ "$output" == *"rc=4"* ]]
    [ ! -s "$DK/dump.log" ]
}

@test "label: the resolved compose document (it holds secrets) reaches no stream" {
    run --separate-stderr dat "cd_data_dumpset_take ${TAG} app; echo rc=\$?"
    # compose was asked for the document (and the take ran on it), so the absence below means something
    [[ "$output" == *"rc=0"* ]]
    grep -qE '^docker compose .* config ' "$SHIM_LOG"
    [ "$(takes | wc -l)" -gt 0 ]
    [[ "$output" != *"resolved-secret-marker"* ]]
    [[ "$stderr" != *"resolved-secret-marker"* ]]
}

# ---------------------------------------------------------------- retire, discard, live

@test "retire: calls switched and asserts no live dump of the label remains" {
    run --separate-stderr dat "cd_data_dumpset_take ${TAG} app; cd_data_dumpset_retire ${TAG}; echo rc=\$?"
    [[ "$output" == *"rc=0"* ]]
    grep -q "^switched rel=${TAG} " "$DK/dump.log"
    [ ! -s "$DK/live.tsv" ]
}

@test "retire: a live dump of the label that survives switched (a line the one-shot wrote under the same label) is code 1" {
    run --separate-stderr dat "cd_data_dumpset_take ${TAG} app; echo rc=\$?"
    touch "$DK/switched.leave"
    run --separate-stderr dat "cd_data_dumpset_retire ${TAG}; echo rc=\$?"
    [ "$output" = "rc=1" ]
    [[ "$stderr" == *"left"* ]]
}

@test "retire: lines written by kernel-api-migrate under the same label are removed with the rest" {
    printf '7\t%s\tgremion\t\t\t%s/kernel-api.7.dump\n' "$TAG" "$TAG" >>"$DK/live.tsv"
    run --separate-stderr dat "cd_data_dumpset_retire ${TAG}; echo rc=\$?"
    [ "$output" = "rc=0" ]
    [ ! -s "$DK/live.tsv" ]
}

@test "retire: a program that fails is code 4, and a status that cannot be read is not 'none left'" {
    touch "$DK/switch.fail"
    run --separate-stderr dat "cd_data_dumpset_retire ${TAG}; echo rc=\$?"
    [ "$output" = "rc=4" ]
    rm -f "$DK/switch.fail"
    touch "$DK/status.fail"
    run --separate-stderr dat "cd_data_dumpset_retire ${TAG}; echo rc=\$?"
    [ "$output" = "rc=1" ]
    rm -f "$DK/status.fail"
    touch "$DK/status.garbage"
    run --separate-stderr dat "cd_data_dumpset_retire ${TAG}; echo rc=\$?"
    [ "$output" = "rc=1" ]
    rm -f "$DK/status.garbage"
    touch "$DK/status.lie"
    run --separate-stderr dat "cd_data_dumpset_retire ${TAG}; echo rc=\$?"
    [ "$output" = "rc=1" ]
}

@test "discard: requires a reason, passes it to the program and asserts nothing is left" {
    run --separate-stderr dat "cd_data_dumpset_take ${TAG} app; echo rc=\$?"
    run --separate-stderr dat "cd_data_dumpset_discard ${TAG} ''; echo rc=\$?"
    [ "$output" = "rc=2" ]
    run --separate-stderr dat "cd_data_dumpset_discard ${TAG} '   '; echo rc=\$?"
    [ "$output" = "rc=2" ]
    [ -s "$DK/live.tsv" ]
    run --separate-stderr dat "cd_data_dumpset_discard ${TAG} 'operator discarded the failed release'; echo rc=\$?"
    [ "$output" = "rc=0" ]
    grep -q "^discard rel=${TAG} " "$DK/dump.log"
    [ ! -s "$DK/live.tsv" ]
}

@test "live: prints the labels of the live dump sets, and nothing for none; a status that cannot be read is an error" {
    run --separate-stderr dat 'cd_data_dumpset_live; echo rc=$?'
    [ "$output" = "rc=0" ]
    run --separate-stderr dat "cd_data_dumpset_take ${TAG} app; cd_data_dumpset_live; echo rc=\$?"
    [[ "$output" == *"${TAG}"* ]]
    [[ "$output" == *"rc=0"* ]]
    [ "$(printf '%s\n' "$output" | grep -c "^${TAG}\$")" -eq 1 ]
    # a status that cannot be read is not "nothing is live"
    touch "$DK/status.fail"
    run --separate-stderr dat 'cd_data_dumpset_live; echo rc=$?'
    [ "$output" = "rc=1" ]
    # and it reads no state and takes no lock: it works with no state file and no cd lock
    rm -f "$DK/status.fail" "${GREMION_ROOT}/data/cd/state.json"
    run bash -c '. "${HOST_SRC}/lib/common.sh"; . "${HOST_SRC}/lib/cd/core.sh"; . "${HOST_SRC}/lib/cd/data.sh"; . "${HOST_SRC}/lib/cd/docker.sh"; cd_cfg_load; cd_data_dumpset_live; echo rc=$?'
    [[ "$output" == *"rc=0"* ]]
}

# ---------------------------------------------------------------- leaks

@test "leak: a module database name that carries a slug reaches no stream, state, history, outbox, journal line or file name of CD across take, reuse, retire, discard and the status read" {
    local o="${GREMION_ROOT}/.o" e="${GREMION_ROOT}/.e"
    dat "cd_data_dumpset_take ${TAG} app; cd_data_dumpset_take ${TAG} app; find \"\$DUMPDIR\" -type f >\"${GREMION_ROOT}/.names\"; cd_data_dumpset_live; cd_data_dumpset_retire ${TAG}; cd_data_dumpset_take ${TAG} app; cd_data_dumpset_discard ${TAG} 'discarded in a test'; cd_data_precheck; echo done" >"$o" 2>"$e"
    # the hostile stand-in did print the name: it went into the 0600 log, and only there
    grep -q "$SLUG_DB" "${GREMION_ROOT}/logs/cd-data-dump.log"
    [ "$(stat -c %a "${GREMION_ROOT}/logs/cd-data-dump.log")" = 600 ]
    # the dump files that existed after the take are named after the service and the id
    grep -q 'calendar-postgres' "${GREMION_ROOT}/.names"
    local hay
    hay="$(leak_haystack "$o" "$e" "${GREMION_ROOT}/.names")"
    [[ "$hay" != *"$SLUG_DB"* ]]
    [[ "$hay" != *"some-slug"* ]]
    # the journal lines of the program for a module database say svc=
    grep -q '^logger .*svc=calendar-postgres' "$SHIM_LOG"
    # no dump file is named after the database
    [ "$(find "$DUMPDIR" -name '*some-slug*' | wc -l)" -eq 0 ]
}

@test "leak: the dump program's stdout and stderr of every call are in a 0600 file, never on CD's own streams" {
    run --separate-stderr dat "cd_data_dumpset_take ${TAG} app; echo rc=\$?"
    [ "$output" = "rc=0" ]
    # the program ran and its words are in the file (a stub prints nothing anywhere)
    [ "$(takes | wc -l)" -gt 0 ]
    grep -q 'TAKE-OK' "${GREMION_ROOT}/logs/cd-data-dump.log"
    [ "$(stat -c %a "${GREMION_ROOT}/logs/cd-data-dump.log")" = 600 ]
    [[ "$output" != *"TAKE-OK"* ]]
    [[ "$output" != *"premigration-dump"* ]]
    [[ "$stderr" != *"TAKE-OK"* ]]
    [[ "$stderr" != *"debug:"* ]]
}

@test "leak: a failed take names the service and a count on stderr, never the database; its own text is in the 0600 file" {
    printf '%s\n' "$SLUG_DB" >"$DK/take.fail"
    run --separate-stderr dat "cd_data_dumpset_take ${TAG} app; echo rc=\$?"
    [[ "$output" == *"rc=4"* ]]
    [[ "$stderr" == *"take failed"* ]]
    [[ "$stderr" == *"calendar-postgres"* ]]
    [[ "$stderr" != *"$SLUG_DB"* ]]
    grep -q "PG_DUMP_FAILED" "${GREMION_ROOT}/logs/cd-data-dump.log"
    [ "$(stat -c %a "${GREMION_ROOT}/logs/cd-data-dump.log")" = 600 ]
}

# ---------------------------------------------------------------- dump failure

@test "dump failure: a failing take returns 4 and nothing proceeds: migrate is refused for the missing dumps and runs no one-shot" {
    printf 'gremion\n' >"$DK/take.fail"
    run --separate-stderr dat "cd_data_dumpset_take ${TAG} app; echo rc=\$?"
    [[ "$output" == *"rc=4"* ]]
    # the failing take did run, so the refusal below is about the missing dump and not about nothing having happened
    grep -q "^take rel=${TAG} db=gremion " "$DK/dump.log"
    run --separate-stderr dat "cd_data_migrate ${TREE} green; echo rc=\$?"
    [[ "$output" == *"rc=2"* ]]
    [[ "$stderr" == *"no live dump"* ]]
    [ ! -s "$DK/run.log" ]
    [ ! -s "$DK/pgb.stdin" ]
    [ "$(grep -c '^stub cd_modules_upgrade' "$SHIM_LOG")" -eq 0 ]
}

@test "dump failure: a refusal that no retry can change (a live dump of another release) is code 2" {
    printf '1\tpilot-bbbbbbbbbbbb\tgremion\t\t\tpilot-bbbbbbbbbbbb/gremion.1.dump\n' >"$DK/live.tsv"
    run --separate-stderr dat "cd_data_dumpset_take ${TAG} app; echo rc=\$?"
    [[ "$output" == *"rc=2"* ]]
}

@test "dump failure: a ledger that cannot be read back after the take is code 4, not success (the post-condition is read, not the exit code)" {
    touch "$DK/status.lie"
    run --separate-stderr dat "cd_data_dumpset_take ${TAG} app; echo rc=\$?"
    [[ "$output" == *"rc=4"* ]]
}

@test "dump failure: a ledger that holds fewer live dumps than planned, or lacks a planned database, is code 4 and never 1 (the code of a fault of the commit; a ledger or tool fault must not block a good sha)" {
    # a planned database the ledger does not show: fewer lines than planned
    printf 'gremion\n' >"$DK/status.hide"
    run --separate-stderr dat "cd_data_dumpset_take ${TAG} app; echo rc=\$?"
    [[ "$output" == *"rc=4"* ]]
    [[ "$stderr" == *"were planned"* ]]
    # every take ran, so the verdict is about the read-back and not about nothing having happened
    grep -q "^take rel=${TAG} db=gremion " "$DK/dump.log"
    # as many lines as planned, but one of them is no planned database (an extra live line of
    # the label stands in for the hidden one)
    : >"$DK/dump.log"
    rm -f "$DK/live.tsv" "$DK/idseq"
    printf '99\t%s\tunplanned_extra\t\t\t%s/unplanned_extra.99.dump\n' "$TAG" "$TAG" >"$DK/live.tsv"
    run --separate-stderr dat "cd_data_dumpset_take ${TAG} app; echo rc=\$?"
    [[ "$output" == *"rc=4"* ]]
    [[ "$stderr" == *"no live dump of ${TAG}"* ]]
    [ "$(takes | wc -l)" -gt 0 ]
}

# ---------------------------------------------------------------- timer guard

@test "timer guard: the backup timer's next elapse inside [now, now + span + backup max run] is code 3 and takes no lock; just outside it fits" {
    cd_need_flock
    local now=1700000000
    # the span 150 + the longest backup run 90 = 240 minutes: the boundary
    timers_json $((now + 240 * 60)) $((now + 100000))
    run --separate-stderr dat 'cd_data_timer_guard 150; echo rc=$?'
    [[ "$output" == *"rc=3"* ]]
    [[ "$stderr" == *"overlaps"* ]]
    timers_json $((now + 240 * 60 + 60)) $((now + 100000))
    run --separate-stderr dat 'cd_data_timer_guard 150; echo rc=$?'
    [[ "$output" == *"rc=0"* ]]
    # no lock was taken: another process takes the host lock right away
    run --separate-stderr dat 'cd_data_timer_guard 150 >/dev/null; ( exec 9>>"${GREMION_ROOT}/runtime/hostd.lock"; flock -n 9 ) && echo free'
    [[ "$output" == *"free"* ]]
}

@test "timer guard: the purge timer likewise, with its own longest run" {
    cd_need_flock
    local now=1700000000
    timers_json $((now + 100000)) $((now + (150 + 5) * 60))
    run --separate-stderr dat 'cd_data_timer_guard 150; echo rc=$?'
    [[ "$output" == *"rc=3"* ]]
    timers_json $((now + 100000)) $((now + (150 + 5) * 60 + 60))
    run --separate-stderr dat 'cd_data_timer_guard 150; echo rc=$?'
    [[ "$output" == *"rc=0"* ]]
}

@test "timer guard: a small span is checked the same way (one reconcile child's cap plus a minute)" {
    cd_need_flock
    local now=1700000000
    timers_json $((now + (6 + 90) * 60)) $((now + 100000))
    run --separate-stderr dat 'cd_data_timer_guard 6; echo rc=$?'
    [[ "$output" == *"rc=3"* ]]
    timers_json $((now + (6 + 90) * 60 + 60)) $((now + 100000))
    run --separate-stderr dat 'cd_data_timer_guard 6; echo rc=$?'
    [[ "$output" == *"rc=0"* ]]
}

@test "timer guard: a timer that has just elapsed (its run is starting) overlaps, one far in the past is no data" {
    cd_need_flock
    local now=1700000000
    timers_json $((now - 60)) $((now + 100000))
    run --separate-stderr dat 'cd_data_timer_guard 30; echo rc=$?'
    [[ "$output" == *"rc=3"* ]]
    timers_json $((now - 86400)) $((now + 100000))
    run --separate-stderr dat 'cd_data_timer_guard 30; echo rc=$?'
    [[ "$output" == *"rc=2"* ]]
}

@test "timer guard: a backup or purge that is running (the host lock is held) is code 3" {
    cd_need_flock
    local now=1700000000
    timers_json $((now + 100000)) $((now + 100000))
    hold_host_lock 20
    run --separate-stderr dat 'cd_data_timer_guard 30; echo rc=$?'
    [[ "$output" == *"rc=3"* ]]
    release_host_lock
    run --separate-stderr dat 'cd_data_timer_guard 30; echo rc=$?'
    [[ "$output" == *"rc=0"* ]]
}

@test "timer guard: the host lock is probed only when no timer overlaps (a probe takes the lock for an instant, and a backup that starts then exits busy and skips the night; guard: watched red when the probe ran first)" {
    local now=1700000000
    : >"${GREMION_ROOT}/runtime/hostd.lock"
    shim flock 'exit 0'
    # a backup elapses inside the span: the verdict is 3 and the lock was never probed
    timers_json $((now + 600)) $((now + 100000))
    run --separate-stderr dat 'cd_data_timer_guard 30; echo rc=$?'
    [[ "$output" == *"rc=3"* ]]
    [ "$(grep -c '^flock -n 7$' "$SHIM_LOG")" -eq 0 ]
    # likewise a purge
    timers_json $((now + 100000)) $((now + 600))
    run --separate-stderr dat 'cd_data_timer_guard 30; echo rc=$?'
    [[ "$output" == *"rc=3"* ]]
    [ "$(grep -c '^flock -n 7$' "$SHIM_LOG")" -eq 0 ]
    # no timer data: unknown, and again no probe
    : >"$DK/timers.json"
    run --separate-stderr dat 'cd_data_timer_guard 30; echo rc=$?'
    [[ "$output" == *"rc=2"* ]]
    [ "$(grep -c '^flock -n 7$' "$SHIM_LOG")" -eq 0 ]
    # both timers clear of the span: now it is probed, once
    timers_json $((now + 100000)) $((now + 100000))
    run --separate-stderr dat 'cd_data_timer_guard 30; echo rc=$?'
    [[ "$output" == *"rc=0"* ]]
    [ "$(grep -c '^flock -n 7$' "$SHIM_LOG")" -eq 1 ]
}

@test "timer guard: CD's own hold of the host lock is not an overlap (the reconcile stage guards each child with the lock held)" {
    cd_need_flock
    local now=1700000000
    timers_json $((now + 100000)) $((now + 100000))
    run --separate-stderr dat 'cd_hostlock_take 0; cd_data_timer_guard 6; echo rc=$?'
    [[ "$output" == *"rc=0"* ]]
    # the real guard answered (a stub prints nothing)
    [[ "$output" == *"lock span: fits"* ]]
}

@test "timer guard: a different time zone and a moved backup time are followed (the timers are read as epochs)" {
    cd_need_flock
    local now=1700000000 tz
    for tz in UTC Asia/Tokyo America/Los_Angeles; do
        timers_json $((now + 240 * 60 - 60)) $((now + 100000))
        run env TZ="$tz" bash -c "$(declare -f dat); dat 'cd_data_timer_guard 150; echo rc=\$?'"
        [[ "$output" == *"rc=3"* ]]
    done
    # the backup moved to the afternoon: the same span now fits, in every zone
    for tz in UTC Asia/Tokyo; do
        timers_json $((now + 14 * 3600)) $((now + 100000))
        run env TZ="$tz" bash -c "$(declare -f dat); dat 'cd_data_timer_guard 150; echo rc=\$?'"
        [[ "$output" == *"rc=0"* ]]
    done
}

@test "timer guard: the Karenz minute-17 case does not block and is named" {
    cd_need_flock
    local now=1700000000
    timers_json $((now + 100000)) $((now + 100000))
    run --separate-stderr dat 'cd_data_timer_guard 150; echo rc=$?'
    [[ "$output" == *"rc=0"* ]]
    [[ "$output" == *"karenz"* ]]
    [[ "$output" == *"minute 17"* ]]
    [[ "$output" == *"accepted"* ]]
}

@test "timer guard: no timer data fails closed with code 2 (an empty list, a missing unit, a timer with no next elapse, a seconds value, a failing systemctl, a bad span)" {
    cd_need_flock
    local now=1700000000
    echo '[]' >"$DK/timers.json"
    run --separate-stderr dat 'cd_data_timer_guard 30; echo rc=$?'
    [[ "$output" == *"rc=2"* ]]
    jq -cn '[{unit:"gremion-backup.timer", next:1700090000000000}]' >"$DK/timers.json"
    run --separate-stderr dat 'cd_data_timer_guard 30; echo rc=$?'
    [[ "$output" == *"rc=2"* ]]
    jq -cn '[{unit:"gremion-backup.timer", next:null},{unit:"gremion-purge.timer", next:1700090000000000}]' >"$DK/timers.json"
    run --separate-stderr dat 'cd_data_timer_guard 30; echo rc=$?'
    [[ "$output" == *"rc=2"* ]]
    jq -cn '[{unit:"gremion-backup.timer", next:1700090000},{unit:"gremion-purge.timer", next:1700090000}]' >"$DK/timers.json"
    run --separate-stderr dat 'cd_data_timer_guard 30; echo rc=$?'
    [[ "$output" == *"rc=2"* ]]
    echo 'not json' >"$DK/timers.json"
    run --separate-stderr dat 'cd_data_timer_guard 30; echo rc=$?'
    [[ "$output" == *"rc=2"* ]]
    rm -f "$DK/timers.json"
    run --separate-stderr dat 'cd_data_timer_guard 30; echo rc=$?'
    [[ "$output" == *"rc=2"* ]]
    timers_json $((now + 100000)) $((now + 100000))
    run --separate-stderr dat 'cd_data_timer_guard 0; echo rc=$?'
    [[ "$output" == *"rc=2"* ]]
    run --separate-stderr dat 'cd_data_timer_guard abc; echo rc=$?'
    [[ "$output" == *"rc=2"* ]]
    run --separate-stderr dat 'cd_data_timer_guard; echo rc=$?'
    [[ "$output" == *"rc=2"* ]]
}

@test "timer guard: it reads no state and never exits (the status verb calls it with no state file)" {
    cd_need_flock
    local now=1700000000
    timers_json $((now + 100000)) $((now + 100000))
    rm -f "${GREMION_ROOT}/data/cd/state.json"
    run bash -c '. "${HOST_SRC}/lib/common.sh"; . "${HOST_SRC}/lib/cd/core.sh"; . "${HOST_SRC}/lib/cd/data.sh"; cd_cfg_load; cd_data_timer_guard 30 >/dev/null; echo rc=$?'
    [[ "$output" == *"rc=0"* ]]
}

# ---------------------------------------------------------------- migrate

# mig 'extra' -- the dump set taken, then the migrate stage, with the stubs of the units after this one
mig() {
    dat "cd_data_dumpset_take ${TAG} app >/dev/null 2>&1 || exit 90
${1:-}
cd_data_migrate ${TREE} green; echo rc=\$?"
}

@test "migrate: the pgbouncer auth role first, then the migrate and kernel-api-migrate one-shots from the new tree with the target colour's env, then the module step, then the leaf step" {
    run --separate-stderr mig
    [ "$output" = "rc=0" ]
    # the order of the calls the shims and stubs saw
    local order
    order="$(grep -nE '^docker exec -i c-postgres psql|^docker compose .* run |^stub cd_modules_upgrade|^stub cd_leaves_migrate|^stub cd_colour_portal_probe' "$SHIM_LOG" | sed -E 's/^[0-9]+://' | awk '{ if ($1 == "docker" && $2 == "exec") { if ($0 ~ / -d gremion /) print "pgbouncer-function"; else print "pgbouncer-role" } else if ($1 == "docker") print "run:" $NF; else print $2 }' | tr '\n' ' ')"
    [ "$order" = "pgbouncer-role pgbouncer-function run:migrate run:kernel-api-migrate cd_modules_upgrade cd_leaves_migrate cd_colour_portal_probe " ]
    # from the NEW tree with the TARGET colour's env, no --profile, never the live colour's file
    [ "$(grep -c '^run app-green ' "$DK/run.log")" -eq 2 ]
    [ "$(grep -c '^run app-blue ' "$DK/run.log")" -eq 0 ]
    [ "$(grep -c " cwd=${TREE} " "$DK/run.log")" -eq 2 ]
    grep -q -- "--no-deps" "$DK/run.log"
    grep -q -- "--pull never" "$DK/run.log"
    grep -q -- "-T" "$DK/run.log"
    # each one-shot runs under the cap of CD_DC_TIMEOUT (the timeout shim logs its own argv)
    grep -qE "^timeout -k 10 600 docker compose --env-file .*app-green.env run --rm --no-deps --pull never -T --label gremion.cd=${RID} migrate\$" "$SHIM_LOG"
    grep -qE "^timeout -k 10 600 docker compose --env-file .*app-green.env run --rm --no-deps --pull never -T --label gremion.cd=${RID} kernel-api-migrate\$" "$SHIM_LOG"
    [ "$(grep -c -- '--profile' "$DK/run.log")" -eq 0 ]
    grep -q "gremion.cd=${RID}" "$DK/run.log"
}

@test "migrate: the auth role password reaches psql on its stdin only: not an argv, not a stream, not a log" {
    run --separate-stderr mig
    [ "$output" = "rc=0" ]
    # the stdin of psql carried the password, once
    [ "$(grep -c "$PW" "$DK/pgb.stdin")" -eq 1 ]
    grep -q "docker exec -i c-postgres psql -X -U postgres -d postgres -q -v ON_ERROR_STOP=1 -f -" "$SHIM_LOG"
    # the argv log of the shim, every captured stream and every file of the run are free of it
    [ "$(grep -c "$PW" "$SHIM_LOG")" -eq 0 ]
    [[ "$output" != *"$PW"* ]]
    [[ "$stderr" != *"$PW"* ]]
    [ "$(grep -rl "$PW" "${GREMION_ROOT}/logs" "${GREMION_ROOT}/data" 2>/dev/null | wc -l)" -eq 0 ]
    # it was the main server and the superuser of state.env
    grep -q 'exec svc=postgres role=postgres db=postgres' "$DK/exec.log"
}

@test "migrate: a password that is not a plain token is refused before psql sees it" {
    sed -i 's/^PGBOUNCER_AUTH_PASSWORD=.*/PGBOUNCER_AUTH_PASSWORD=x; drop table y/' "${GREMION_ROOT}/etc/env/state.env"
    run --separate-stderr mig
    [[ "$output" == *"rc=2"* ]]
    [ ! -s "$DK/pgb.stdin" ]
    [ ! -s "$DK/run.log" ]
}

@test "migrate: a failing auth role is code 4 and no one-shot runs" {
    touch "$DK/pgb.fail"
    run --separate-stderr mig
    [[ "$output" == *"rc=4"* ]]
    [ ! -s "$DK/run.log" ]
}

@test "migrate: the auth_query function of the NEW tree is applied to the gremion database after the role, on stdin, as the installer does (guard: watched red when only the role was ensured)" {
    printf -- '-- marker of this release\nCREATE OR REPLACE FUNCTION pgbouncer.get_auth(uname text) RETURNS void LANGUAGE sql AS $$ SELECT $$;\n' >>"${TREE}/docker/pgbouncer/pgbouncer-auth.sql"
    run --separate-stderr mig
    [ "$output" = "rc=0" ]
    # the file of the tree reached psql unchanged, in the gremion database, as the superuser of state.env
    cmp "${TREE}/docker/pgbouncer/pgbouncer-auth.sql" "$DK/pgb.stdin.gremion"
    grep -q "docker exec -i c-postgres psql -X -U postgres -d gremion -q -v ON_ERROR_STOP=1 -f -" "$SHIM_LOG"
    grep -q 'exec svc=postgres role=postgres db=gremion' "$DK/exec.log"
    # the role came first, and the password is in the role's stdin only
    [ "$(grep -c "$PW" "$DK/pgb.stdin.gremion")" -eq 0 ]
    [ "$(grep -c "$PW" "$DK/pgb.stdin.postgres")" -eq 1 ]
}

@test "migrate: a tree with no pgbouncer-auth.sql is a refusal before the role and the one-shots" {
    rm -f "${TREE}/docker/pgbouncer/pgbouncer-auth.sql"
    run --separate-stderr mig
    [[ "$output" == *"rc=2"* ]]
    [[ "$stderr" == *"pgbouncer-auth.sql"* ]]
    [ ! -s "$DK/pgb.stdin" ]
    [ ! -s "$DK/run.log" ]
}

@test "migrate: a failing auth_query function is code 4, names no database, and no one-shot runs" {
    touch "$DK/pgb.fail.gremion"
    run --separate-stderr mig
    [[ "$output" == *"rc=4"* ]]
    [[ "$stderr" == *"auth_query function could not be applied"* ]]
    # the role was ensured; nothing after the function ran
    [ -s "$DK/pgb.stdin.postgres" ]
    [ ! -s "$DK/run.log" ]
    [ "$(grep -c '^stub cd_modules_upgrade' "$SHIM_LOG")" -eq 0 ]
}

@test "migrate: a one-shot that exits 124 is code 3, the container that outlived the client is killed by label and confirmed gone with docker ps -a" {
    echo 124 >"$DK/run.migrate.rc"
    touch "$DK/run.migrate.leave"
    run --separate-stderr mig
    [[ "$output" == *"rc=3"* ]]
    # the labelled container was removed, and the confirmation polled ps -a (the exited ones too)
    [ ! -e "$DK/labelled" ]
    grep -q "^rm -f c-leftover" "$DK/ps.log"
    grep -q "^ps -a" "$DK/ps.log" || grep -q "^ps .*-aq" "$DK/ps.log"
    # the stage stopped: the second one-shot and the module step did not run
    [ "$(grep -c 'svc=kernel-api-migrate' "$DK/run.log")" -eq 0 ]
    [ "$(grep -c '^stub cd_modules_upgrade' "$SHIM_LOG")" -eq 0 ]
}

@test "migrate: a container that cannot be confirmed gone after a timeout is code 2 (never 3)" {
    echo 124 >"$DK/run.migrate.rc"
    touch "$DK/run.migrate.leave" "$DK/rm.stuck"
    run --separate-stderr mig
    [[ "$output" == *"rc=2"* ]]
    [[ "$stderr" == *"could not be confirmed gone"* ]]
}

@test "migrate: a one-shot that exits 1 is code 1; exit 2 is code 2; any other code is an infrastructure failure (4)" {
    echo 1 >"$DK/run.migrate.rc"
    run --separate-stderr mig
    [[ "$output" == *"rc=1"* ]]
    [ "$(grep -c 'svc=kernel-api-migrate' "$DK/run.log")" -eq 0 ]
    echo 2 >"$DK/run.migrate.rc"
    run --separate-stderr mig
    [[ "$output" == *"rc=2"* ]]
    echo 125 >"$DK/run.migrate.rc"
    run --separate-stderr mig
    [[ "$output" == *"rc=4"* ]]
    echo 0 >"$DK/run.migrate.rc"
    echo 1 >"$DK/run.kernel-api-migrate.rc"
    run --separate-stderr mig
    [[ "$output" == *"rc=1"* ]]
    [ "$(grep -c '^stub cd_modules_upgrade' "$SHIM_LOG")" -eq 0 ]
}

@test "migrate: the last 15 lines of a one-shot's log go to a 0600 file under logs/ and nothing of them to stdout, stderr or the journal (a log fixture with a slug, a secret file name and the word password)" {
    {
        for i in $(seq 1 40); do echo "line $i"; done
        echo "migrating tenant some-slug"
        echo "reading /run/secrets/tenants/tenant_some-slug_db"
        echo "password authentication failed for user x"
    } >"$DK/run.migrate.out"
    echo 1 >"$DK/run.migrate.rc"
    local o="${GREMION_ROOT}/.o" e="${GREMION_ROOT}/.e"
    mig >"$o" 2>"$e"
    local f="${GREMION_ROOT}/logs/cd-data-migrate.log"
    [ "$(wc -l <"$f")" -eq 15 ]
    [ "$(stat -c %a "$f")" = 600 ]
    grep -q "some-slug" "$f"
    grep -q "password" "$f"
    local hay
    hay="$(leak_haystack "$o" "$e")"
    [[ "$hay" != *"some-slug"* ]]
    [[ "$hay" != *"tenant_"* ]]
    [[ "$hay" != *"password authentication"* ]]
    [[ "$hay" != *"line 40"* ]]
    # only the file name is reported
    grep -q "cd-data-migrate.log" "$e"
}

@test "migrate: after the two one-shots cd_modules_upgrade is called once with the same tree, colour and tag, and its code is the stage's; a failure stops the stage before the live portal probe" {
    run --separate-stderr mig
    [[ "$output" == *"rc=0"* ]]
    [ "$(grep -c '^stub cd_modules_upgrade' "$SHIM_LOG")" -eq 1 ]
    grep -q "^stub cd_modules_upgrade ${TREE} green ${TAG}\$" "$SHIM_LOG"
    : >"$SHIM_LOG"
    run --separate-stderr mig 'export CD_STUB_RC_cd_modules_upgrade=1'
    [[ "$output" == *"rc=1"* ]]
    [ "$(grep -c '^stub cd_colour_portal_probe' "$SHIM_LOG")" -eq 0 ]
    [ "$(grep -c '^stub cd_leaves_migrate' "$SHIM_LOG")" -eq 0 ]
    # every code is passed through
    for c in 2 4; do
        run --separate-stderr mig "export CD_STUB_RC_cd_modules_upgrade=$c"
        [[ "$output" == *"rc=${c}"* ]]
    done
}

@test "migrate: after cd_modules_upgrade returns 0 cd_leaves_migrate is called once with the same tree, colour and tag; its code is the stage's" {
    run --separate-stderr mig
    [[ "$output" == *"rc=0"* ]]
    [ "$(grep -c '^stub cd_leaves_migrate' "$SHIM_LOG")" -eq 1 ]
    grep -q "^stub cd_leaves_migrate ${TREE} green ${TAG}\$" "$SHIM_LOG"
    : >"$SHIM_LOG"
    run --separate-stderr mig 'export CD_STUB_RC_cd_leaves_migrate=3'
    [[ "$output" == *"rc=3"* ]]
    # the leaf step was called and failed, so the probe of the live colour never ran
    [ "$(grep -c '^stub cd_leaves_migrate' "$SHIM_LOG")" -eq 1 ]
    [ "$(grep -c '^stub cd_colour_portal_probe' "$SHIM_LOG")" -eq 0 ]
}

@test "migrate: with no module dump of the label the leaf step is not called" {
    # no module server is running and none holds an enabled row: the set has no module part
    rm -f "$DK"/cid.teststack-state.calendar-postgres "$DK"/cid.teststack-state.content-postgres "$DK"/cid.teststack-state.newsletter-postgres
    : >"$DK/rows.module_database"
    run --separate-stderr mig
    [[ "$output" == *"rc=0"* ]]
    [ "$(grep -c '^stub cd_modules_upgrade' "$SHIM_LOG")" -eq 1 ]
    [ "$(grep -c '^stub cd_leaves_migrate' "$SHIM_LOG")" -eq 0 ]
    [ "$(grep -c 'svc=[a-z]*-postgres' "$DK/dump.log")" -eq 0 ]
}

@test "migrate: the leaf step is not called when the module step failed" {
    : >"$SHIM_LOG"
    run --separate-stderr mig 'export CD_STUB_RC_cd_modules_upgrade=1'
    # the module step was called and failed with 1; an early exit of the stage would not say so
    [[ "$output" == *"rc=1"* ]]
    [ "$(grep -c '^stub cd_modules_upgrade' "$SHIM_LOG")" -eq 1 ]
    [ "$(grep -c '^stub cd_leaves_migrate' "$SHIM_LOG")" -eq 0 ]
}

@test "migrate: a bad tree, a bad colour or a missing release record is refused" {
    run --separate-stderr dat "cd_data_migrate /nonexistent green; echo rc=\$?"
    [ "$output" = "rc=2" ]
    run --separate-stderr dat "cd_data_migrate ${TREE} purple; echo rc=\$?"
    [ "$output" = "rc=2" ]
    seed_state '.release = null'
    run --separate-stderr dat "cd_data_migrate ${TREE} green; echo rc=\$?"
    [ "$output" = "rc=2" ]
}

# ---------------------------------------------------------------- the live portal probe

@test "live portal probe: three tries on the LIVE colour; a 500 or a timeout in all three sets rollback_target=unusable and returns 0 with a warning (guard: watched red by passing a 500 through)" {
    cd_stub_set cd_colour_portal_probe 1
    run --separate-stderr dat 'cd_data_live_portal_probe; echo rc=$?; cd_state_get ".release.rollback_target"'
    [ "${lines[0]}" = "rc=0" ]
    [ "${lines[1]}" = "unusable" ]
    [[ "$stderr" == *"WARNING"* ]]
    [ "$(grep -c '^stub cd_colour_portal_probe blue$' "$SHIM_LOG")" -eq 3 ]
    [ "$(grep -c '^stub cd_colour_portal_probe green' "$SHIM_LOG")" -eq 0 ]
}

@test "live portal probe: one good answer in three is a pass and records nothing" {
    cat >"${GREMION_ROOT}/.probe-seq" <<'EOF'
1
1
0
EOF
    run --separate-stderr dat 'cd_colour_portal_probe() { local n; n="$(cat "${GREMION_ROOT}/.probe-n" 2>/dev/null || echo 0)"; echo $((n + 1)) >"${GREMION_ROOT}/.probe-n"; return "$(sed -n "$((n + 1))p" "${GREMION_ROOT}/.probe-seq")"; }
cd_data_live_portal_probe; echo rc=$?; cd_state_get ".release.rollback_target"'
    [ "${lines[0]}" = "rc=0" ]
    [ "${lines[1]}" = "null" ]
    [ "$(cat "${GREMION_ROOT}/.probe-n")" -eq 3 ]
}

@test "live portal probe: a pass on the first try stops there" {
    cd_stub_set cd_colour_portal_probe 0
    run --separate-stderr dat 'cd_data_live_portal_probe; echo rc=$?'
    [ "$output" = "rc=0" ]
    [ "$(grep -c '^stub cd_colour_portal_probe' "$SHIM_LOG")" -eq 1 ]
}

@test "live portal probe: a probe that cannot say (docker unaskable, a bad base path) is no verdict: its code is returned and rollback_target stays unset" {
    cd_stub_set cd_colour_portal_probe 4
    run --separate-stderr dat 'cd_data_live_portal_probe; echo rc=$?; cd_state_get ".release.rollback_target"'
    [ "${lines[0]}" = "rc=4" ]
    [ "${lines[1]}" = "null" ]
    cd_stub_set cd_colour_portal_probe 2
    run --separate-stderr dat 'cd_data_live_portal_probe; echo rc=$?; cd_state_get ".release.rollback_target"'
    [ "${lines[0]}" = "rc=2" ]
    [ "${lines[1]}" = "null" ]
}

@test "migrate: the live portal probe runs after the module and leaf steps, and an unusable verdict does not fail the stage" {
    cd_stub_set cd_colour_portal_probe 1
    run --separate-stderr mig
    [[ "$output" == *"rc=0"* ]]
    [ "$(jq -r '.release.rollback_target' "${GREMION_ROOT}/data/cd/state.json")" = unusable ]
}

# ---------------------------------------------------------------- the live signal

@test "live signal: start stores the epoch and the baseline (counts only) in a 0600 file; read applies the watch_5xx rule" {
    cd_stub_set cd_watch_accesslog_count 0 '4'
    run --separate-stderr dat 'cd_data_live_signal_start; echo rc=$?'
    [ "$output" = "rc=0" ]
    local f="${GREMION_ROOT}/data/cd/live-signal"
    [ "$(stat -c %a "$f")" = 600 ]
    [ "$(jq -r '.baseline' "$f")" = 4 ]
    [ "$(jq -r '.epoch' "$f")" = 1700000000 ]
    [ "$(jq -r '.release' "$f")" = "$RID" ]
    # 9 errors: below CD_5XX_MIN (10)
    cd_advance 600
    cd_stub_set cd_watch_accesslog_count 0 '9'
    run --separate-stderr dat 'cd_data_live_signal_read; echo rc=$?; cd_state_get ".release.rollback_target"'
    [ "${lines[0]}" = "ok" ]
    [ "${lines[1]}" = "rc=0" ]
    [ "${lines[2]}" = "null" ]
}

@test "live signal: a signal file that cannot be written is code 4 (infrastructure), never 1, the code of a fault of the commit" {
    cd_stub_set cd_watch_accesslog_count 0 '4'
    run --separate-stderr dat 'cd_atomic_write() { cat >/dev/null; return 1; }; cd_data_live_signal_start; echo rc=$?'
    [ "$output" = "rc=4" ]
    [[ "$stderr" == *"signal file cannot be written"* ]]
    [ ! -e "${GREMION_ROOT}/data/cd/live-signal" ]
    # the same start with a writable file stores the epoch: the failure above was the write
    run --separate-stderr dat 'cd_data_live_signal_start; echo rc=$?'
    [ "$output" = "rc=0" ]
    [ -s "${GREMION_ROOT}/data/cd/live-signal" ]
}

@test "live signal: 10 errors with a zero baseline is a trigger and sets rollback_target=unusable; with a baseline that scales to 3 times as many it is not" {
    cd_stub_set cd_watch_accesslog_count 0 '0'
    run --separate-stderr dat 'cd_data_live_signal_start'
    cd_advance 300
    cd_stub_set cd_watch_accesslog_count 0 '10'
    run --separate-stderr dat 'cd_data_live_signal_read; echo rc=$?; cd_state_get ".release.rollback_target"'
    [ "${lines[0]}" = "trigger" ]
    [ "${lines[2]}" = "unusable" ]
    seed_state
    # baseline 3600 over 3600 s = 1 a second; 300 s later 300 expected, 3 x = 900: 10 is no trigger
    jq -cn --arg r "$RID" '{v:1, release:$r, epoch:1700000000, baseline:3600}' >"${GREMION_ROOT}/data/cd/live-signal"
    run --separate-stderr dat 'cd_data_live_signal_read; echo rc=$?; cd_state_get ".release.rollback_target"'
    [ "${lines[0]}" = "ok" ]
    [ "${lines[2]}" = "null" ]
    # 1000 errors against it is
    cd_stub_set cd_watch_accesslog_count 0 '1000'
    run --separate-stderr dat 'cd_data_live_signal_read; echo rc=$?; cd_state_get ".release.rollback_target"'
    [ "${lines[0]}" = "trigger" ]
    [ "${lines[2]}" = "unusable" ]
}

@test "live signal: a null count (the log cannot be read) is blind and never a trigger" {
    cd_stub_set cd_watch_accesslog_count 0 '4'
    run --separate-stderr dat 'cd_data_live_signal_start'
    cd_advance 300
    cd_stub_set cd_watch_accesslog_count 1 ''
    run --separate-stderr dat 'cd_data_live_signal_read; echo rc=$?; cd_state_get ".release.rollback_target"'
    [ "${lines[0]}" = "blind" ]
    [ "${lines[1]}" = "rc=0" ]
    [ "${lines[2]}" = "null" ]
    cd_stub_set cd_watch_accesslog_count 0 'not a number'
    run --separate-stderr dat 'cd_data_live_signal_read; echo rc=$?'
    [ "${lines[0]}" = "blind" ]
    # a baseline that could not be read is null and the minimum alone decides
    cd_stub_set cd_watch_accesslog_count 1 ''
    seed_state
    rm -f "${GREMION_ROOT}/data/cd/live-signal"
    run --separate-stderr dat 'cd_data_live_signal_start; jq -r ".baseline | tostring" "${GREMION_ROOT}/data/cd/live-signal"'
    [ "$output" = "null" ]
    cd_advance 300
    cd_stub_set cd_watch_accesslog_count 0 '10'
    run --separate-stderr dat 'cd_data_live_signal_read'
    [ "$output" = "trigger" ]
}

@test "live signal: a read with no start for this release is code 2 and records nothing; a start of another release does not count" {
    run --separate-stderr dat 'cd_data_live_signal_read; echo rc=$?'
    [ "$output" = "rc=2" ]
    jq -cn '{v:1, release:"ffffffffffff-9", epoch:1700000000, baseline:0}' >"${GREMION_ROOT}/data/cd/live-signal"
    run --separate-stderr dat 'cd_data_live_signal_read; echo rc=$?'
    [ "$output" = "rc=2" ]
}

@test "live signal: migrate primes the baseline BEFORE the one-shots and stores the epoch at its end" {
    cd_stub_set cd_watch_accesslog_count 0 '7'
    run --separate-stderr mig
    [[ "$output" == *"rc=0"* ]]
    local f="${GREMION_ROOT}/data/cd/live-signal"
    [ "$(jq -r '.baseline' "$f")" = 7 ]
    [ "$(jq -r '.epoch' "$f")" = 1700000000 ]
    # the baseline was asked before the first one-shot ran
    local first_count first_run
    first_count="$(grep -n '^stub cd_watch_accesslog_count' "$SHIM_LOG" | head -n 1 | cut -d: -f1)"
    first_run="$(grep -n '^docker compose .* run ' "$SHIM_LOG" | head -n 1 | cut -d: -f1)"
    [ "$first_count" -lt "$first_run" ]
}

# ---------------------------------------------------------------- hygiene

@test "hygiene: data.sh sets no shell options, calls no exit, runs nothing at the top level, is shellcheck clean and carries no private helper of another unit" {
    assert_absent '^[[:space:]]*(set -[euo]|exit )' "${HOST_SRC}/lib/cd/data.sh" "no shell option or exit at the top level"
    assert_absent '_cd_prep_|_cd_colour_|_cd_gh_|_cd_cls_' "${HOST_SRC}/lib/cd/data.sh" "a private helper of another unit"
    run bash -c 'set -euo pipefail; . "${HOST_SRC}/lib/common.sh"; . "${HOST_SRC}/lib/cd/core.sh"; . "${HOST_SRC}/lib/cd/data.sh"; echo sourced'
    [ "$output" = "sourced" ]
    if command -v shellcheck >/dev/null 2>&1; then
        run shellcheck -x "${HOST_SRC}/lib/cd/data.sh"
        [ "$status" -eq 0 ]
    fi
}

@test "hygiene: nothing in data.sh carries a real host, an address or a person" {
    assert_absent '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}' "${HOST_SRC}/lib/cd/data.sh" "an address"
    assert_absent '([0-9]{1,3}\.){3}[0-9]{1,3}' "${HOST_SRC}/lib/cd/data.sh" "an IPv4 address"
}
