#!/usr/bin/env bats
# test/host/cd-modules.bats -- cd-modules: infra/host/lib/cd/modules.sh, the host side of the
# module step of the continuous deployment program: the preconditions, the registry
# listing and its cross-checks, the dump precondition, the one-shot call and the mapping of
# its exit codes, the timeout that kills by label and confirms the container gone.
#
# Run: MSYS_NO_PATHCONV=1 docker run --rm --user 1001 -v "$(pwd -W):/repo:ro" -w /repo gremion-bats:local test/host/cd-modules.bats
#
# Nothing here touches a real docker, psql or network: docker is one recording shim whose
# answers are files under $DK, gremion-migration-dump is a shim of the installed program,
# the host layout is a temp $GREMION_ROOT. docker.sh, notify.sh and core.sh are the REAL
# libraries; everything after this unit is the helper's stubs. Every name is a reserved
# example name; the database names are made-up hex and the secret-looking words are low
# entropy fixtures. The snippets run WITHOUT errexit, as a driver that calls a stage as
# `fn || rc=$?`.

bats_require_minimum_version 1.5.0
load 'test_helper/host'
load 'test_helper/cd'

FIX="${BATS_TEST_DIRNAME}/fixtures/cd/modules"
export TAG="pilot-bbbbbbbbbbbb"
export RID="bbbbbbbbbbbb-1"
JSON_OK='{"total":2,"upgraded":1,"unchanged":1,"skipped":0,"failed":0,"files_applied":3}'

# The docker shim body. State lives in $DK:
#   argv.log          one line per call, args joined with '|'
#   order.log         the calls that matter in order: exec, ps (with -a or not), run, kill, rm, dump
#   exec.log          container|role|database of every docker exec; sql.log the SQL texts
#   role.<cid>        the role that server accepts (any other role: "role does not exist")
#   q1 q2             the answers of the two registry queries (q1.fail / q2.fail make psql fail)
#   dbs.<cid>         the gate databases a module server lists (dbs.<cid>.fail makes psql fail)
#   cid.<proj>.<svc>  a running compose service container
#   run.out run.err   what the one-shot prints on stdout and on stderr; run.rc its exit code
#   run.hang          the client hangs (the shim becomes sleep, so `timeout` kills it)
#   run.creates       the run leaves a labelled container behind, state running
#   ctr               labelled containers, "<id> running|exited"
#   rm.refuse kill.refuse   docker rm -f / docker kill do nothing
#   sticky            after a successful rm, `docker ps -a` still lists the container this many times
#   ps.fail           every labelled `docker ps` fails (the daemon does not answer)
docker_shim_body() {
    cat <<'SHIM_EOF'
(IFS='|'; printf '%s\n' "$*" >>"$DK/argv.log")
case "$1" in
  ps)
    all=''; lab=''; proj=''; svc=''
    for a in "$@"; do
      case "$a" in
        -a) all=1 ;;
        label=gremion.cd=*) lab="${a#label=gremion.cd=}" ;;
        label=com.docker.compose.project=*) proj="${a#label=com.docker.compose.project=}" ;;
        label=com.docker.compose.service=*) svc="${a#label=com.docker.compose.service=}" ;;
      esac
    done
    if [ -n "$lab" ]; then
      echo "ps ${all:+-a }$lab" >>"$DK/order.log"
      [ -f "$DK/ps.fail" ] && exit 1
      if [ -f "$DK/sticky.n" ] && [ "$(cat "$DK/sticky.n")" -gt 0 ]; then
        echo $(( $(cat "$DK/sticky.n") - 1 )) >"$DK/sticky.n"
        cut -d' ' -f1 "$DK/ctr.stale"
        exit 0
      fi
      if [ -f "$DK/ctr" ]; then
        while read -r id st; do
          [ -n "$id" ] || continue
          if [ -n "$all" ] || [ "$st" = running ]; then echo "$id"; fi
        done <"$DK/ctr"
      fi
      exit 0
    fi
    [ -f "$DK/cid.$proj.$svc" ] && cat "$DK/cid.$proj.$svc"
    exit 0 ;;
  exec)
    cid="$2"; role=''; db=''; sql=''; prev=''
    for a in "$@"; do
      case "$prev" in -U) role="$a" ;; -d) db="$a" ;; -c) sql="$a" ;; esac
      prev="$a"
    done
    echo "exec" >>"$DK/order.log"
    printf '%s|%s|%s\n' "$cid" "$role" "$db" >>"$DK/exec.log"
    printf '%s\n' "$sql" >>"$DK/sql.log"
    want="$(cat "$DK/role.$cid" 2>/dev/null || true)"
    if [ "$role" != "$want" ]; then
      echo "FATAL: role \"$role\" does not exist (slugmarker, password)" >&2
      exit 2
    fi
    case "$db" in
      gremion_platform)
        case "$sql" in
          *module_enablement*)
            [ -f "$DK/q2.fail" ] && { echo "connection lost slugmarker" >&2; exit 2; }
            [ -f "$DK/q2" ] && cat "$DK/q2"
            exit 0 ;;
          *module_database*)
            [ -f "$DK/q1.fail" ] && { echo "connection lost slugmarker" >&2; exit 2; }
            [ -f "$DK/q1" ] && cat "$DK/q1"
            exit 0 ;;
        esac
        exit 3 ;;
      postgres)
        [ -f "$DK/dbs.$cid.fail" ] && { echo "connection lost slugmarker" >&2; exit 2; }
        [ -f "$DK/dbs.$cid" ] && cat "$DK/dbs.$cid"
        exit 0 ;;
    esac
    exit 3 ;;
  compose)
    (IFS='|'; printf '%s\n' "$*" >>"$DK/run.log")
    pwd >>"$DK/run.cwd"
    readlink "/proc/$$/fd/0" >>"$DK/run.stdin" 2>/dev/null || echo unknown >>"$DK/run.stdin"
    env | grep -E '^(CD_DC_TIMEOUT|COMPOSE_)' | sort >>"$DK/run.env" || true
    echo "run" >>"$DK/order.log"
    [ -s "$DK/ctr" ] && echo "run-saw-container" >>"$DK/order.log"
    [ -f "$DK/run.creates" ] && echo "c-mod running" >>"$DK/ctr"
    [ -f "$DK/run.exited" ] && echo "c-mod exited" >>"$DK/ctr"
    [ -f "$DK/run.hang" ] && exec sleep 30
    [ -f "$DK/run.out" ] && cat "$DK/run.out"
    [ -f "$DK/run.err" ] && cat "$DK/run.err" >&2
    exit "$(cat "$DK/run.rc" 2>/dev/null || echo 0)" ;;
  kill)
    echo "kill" >>"$DK/order.log"
    [ -f "$DK/kill.refuse" ] && exit 0
    [ -f "$DK/ctr" ] && sed -i 's/ running$/ exited/' "$DK/ctr"
    exit 0 ;;
  rm)
    echo "rm" >>"$DK/order.log"
    [ -f "$DK/rm.refuse" ] && exit 0
    if [ -s "$DK/ctr" ]; then
      cp "$DK/ctr" "$DK/ctr.stale"
      : >"$DK/ctr"
      [ -f "$DK/sticky" ] && cp "$DK/sticky" "$DK/sticky.n"
    fi
    exit 0 ;;
esac
exit 0
SHIM_EOF
}

dbn() { printf 't_%032x__%s' "$1" "$2"; }

setup() {
    cd_setup
    export STACK=teststack TZ=UTC
    DK="${SHIM_DIR}/dk"
    export DK
    mkdir -p "$DK"
    cp "${FIX}/state.env" "${FIX}/app-blue.env" "${FIX}/app-green.env" "${GREMION_ROOT}/etc/env/"
    printf 'TENANT_SECRETS_DIR=%s/etc/secrets/tenants\n' "$GREMION_ROOT" >>"${GREMION_ROOT}/etc/env/app-green.env"
    printf 'TENANT_SECRETS_DIR=%s/etc/secrets/tenants\n' "$GREMION_ROOT" >>"${GREMION_ROOT}/etc/env/app-blue.env"
    mkdir -p "${GREMION_ROOT}/etc/secrets/governance" "${GREMION_ROOT}/etc/secrets/tenants" "${GREMION_ROOT}/data/module-exports"
    chmod 700 "${GREMION_ROOT}/etc/secrets/governance" "${GREMION_ROOT}/etc/secrets/tenants"
    TREE="${GREMION_ROOT}/releases/bbbbbbbbbbbb"
    export TREE
    mk_module calendar calendar-postgres
    mk_module content content-postgres
    mk_module publishing newsletter-postgres
    mk_module board null
    shim docker "$(docker_shim_body)"
    shim logger
    # the three module servers and the main one: container ids and the one role each accepts
    echo c-main >"$DK/cid.teststack-state.postgres"
    echo pgsuper >"$DK/role.c-main"
    echo c-cal >"$DK/cid.teststack-state.calendar-postgres"
    echo cal_admin >"$DK/role.c-cal"
    echo c-con >"$DK/cid.teststack-state.content-postgres"
    echo con_admin >"$DK/role.c-con"
    echo c-nl >"$DK/cid.teststack-state.newsletter-postgres"
    echo nl_admin >"$DK/role.c-nl"
    # a healthy registry: two customers, one module each, both enabled, both on a running server
    DB1="$(dbn 1 calendar)"
    DB2="$(dbn 2 content)"
    export DB1 DB2
    printf '%s|enabled\n%s|enabled\n' "$DB1" "$DB2" >"$DK/q1"
    printf '%s\n%s\n' "$DB1" "$DB2" >"$DK/q2"
    printf '%s\n' "$DB1" >"$DK/dbs.c-cal"
    printf '%s\n' "$DB2" >"$DK/dbs.c-con"
    : >"$DK/dbs.c-nl"
    mk_dump "$TAG" "$DB1" "$DB2"
    seed_release
}

teardown() {
    cd_teardown
}

# mk_module ID SERVICE|null -- a module.json in the release tree.
mk_module() {
    mkdir -p "${TREE}/modules/$1"
    if [ "$2" = null ]; then
        printf '{"schemaVersion":1,"id":"%s","runtime":{"version":"1.0.0","database":null}}\n' "$1" >"${TREE}/modules/$1/module.json"
    else
        printf '{"schemaVersion":1,"id":"%s","runtime":{"version":"1.0.0","database":{"postgresService":"%s","migrations":"migrations"}}}\n' "$1" "$2" >"${TREE}/modules/$1/module.json"
    fi
}

# mk_dump RELEASE DB... -- the answer of `gremion-migration-dump status --release R`: one LIVE
# line per database (the real program prints the name in db=) and the trailer.
mk_dump() {
    local rel="$1" n=0 db
    shift
    : >"$DK/dump.status"
    for db in "$@"; do
        n=$((n + 1))
        printf 'LIVE id%s release=%s db=%s taken=2026-11-17T01:00:00Z bytes=1024 file=x/%s.dump\n' "$n" "$rel" "$db" "$n" >>"$DK/dump.status"
    done
    printf 'STATUS: %s live dump(s)\n' "$n" >>"$DK/dump.status"
    cat >"${GREMION_ROOT}/bin/gremion-migration-dump" <<'EOF'
#!/usr/bin/env bash
(IFS='|'; printf '%s\n' "$*" >>"$DK/dump.argv")
echo dump >>"$DK/order.log"
[ -f "$DK/dump.stderr" ] && cat "$DK/dump.stderr" >&2
[ -f "$DK/dump.rc" ] && exit "$(cat "$DK/dump.rc")"
cat "$DK/dump.status"
EOF
    chmod +x "${GREMION_ROOT}/bin/gremion-migration-dump"
}

# seed_release [JQ] -- the release record of a run at stage migrate (policy always).
seed_release() {
    local extra="${1:-.}"
    local rel
    rel="$(jq -n --arg t "$TREE" '{id:"bbbbbbbbbbbb-1", sha:"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", sha12:"bbbbbbbbbbbb", tag:"pilot-bbbbbbbbbbbb", colour:"green", tree:$t, mode:"auto", stage:"migrate", stage_status:"started", class:null, modules:null}')"
    cd_seed_state ".phase = \"releasing\" | .release = ${rel} | ${extra}"
}

mod() {
    local snippet="$1"
    shift
    bash -c "set -uo pipefail
. \"\${HOST_SRC}/lib/common.sh\"
. \"\${HOST_SRC}/lib/cd/core.sh\"
. \"\${HOST_SRC}/lib/cd/docker.sh\"
. \"\${HOST_SRC}/lib/cd/notify.sh\"
. \"\${HOST_SRC}/lib/cd/modules.sh\"
. \"\${GREMION_CD_STUBS_DIR}/cd-stubs.sh\"
cd_cfg_load || exit 99
${snippet}" mod "$@"
}

# step -- the step as a driver calls it: the lock taken, the code and the reason printed last.
step() {
    run --separate-stderr mod 'cd_lock_take; rc=0; cd_modules_upgrade "$TREE" green "$TAG" || rc=$?; echo "reason=${CD_MODULES_REASON}"; exit "$rc"'
}

# state_modules -- release.modules of the state as compact JSON.
state_modules() { jq -c '.release.modules' "${GREMION_ROOT}/data/cd/state.json"; }

# out_has ERE / err_has ERE -- the stdout (the code and the reason) or the stderr of the last
# step holds a line matching ERE. A plain command, so a miss fails the test where it stands.
out_has() {
    grep -qE -- "$1" <<<"$output" && return 0
    echo "out_has: /$1/ not in the output:" >&2
    printf '%s\n' "$output" >&2
    return 1
}
err_has() {
    grep -qE -- "$1" <<<"$stderr" && return 0
    echo "err_has: /$1/ not in the stderr:" >&2
    printf '%s\n' "$stderr" >&2
    return 1
}

# calls NAME -- how often the order log holds the line NAME.
calls() {
    if [ -f "$DK/order.log" ]; then
        grep -cxF -- "$1" "$DK/order.log" || true
    else
        echo 0
    fi
}

# refute_text NEEDLE TEXT -- fails when TEXT contains NEEDLE (no negated assertion).
refute_text() {
    case "$2" in
        *"$1"*)
            echo "unexpected text: $1" >&2
            return 1
            ;;
    esac
    return 0
}

# ------------------------------------------------------------------------ the happy path

@test "the step lists the registry, finds a live dump for every database and runs the one-shot, then records the counts" {
    echo "$JSON_OK" >"$DK/run.out"
    step
    [ "$status" -eq 0 ]
    [ "$(calls run)" -eq 1 ]
    [ "$(state_modules)" = "$JSON_OK" ]
    out_has '^reason=$'
}

@test "the registry is read as the state superuser from gremion_platform through the state project's postgres, the module servers as their own role" {
    echo "$JSON_OK" >"$DK/run.out"
    step
    [ "$status" -eq 0 ]
    assert_present '^c-main\|pgsuper\|gremion_platform$' "$DK/exec.log"
    assert_present '^c-cal\|cal_admin\|postgres$' "$DK/exec.log"
    assert_present '^c-con\|con_admin\|postgres$' "$DK/exec.log"
    # the server with no database is listed as well: publishing runs on newsletter-postgres
    assert_present '^c-nl\|nl_admin\|postgres$' "$DK/exec.log"
}

@test "the SQL texts hold no database name: the names live in the process only" {
    echo "$JSON_OK" >"$DK/run.out"
    step
    [ "$status" -eq 0 ]
    assert_absent "t_[0-9a-f]{32}__[a-z]" "$DK/sql.log"
    assert_absent "t_00000000" "$DK/argv.log"
}

# ------------------------------------------------------------------------ the preconditions

@test "the governance directory missing, wide open or a symlink is code 2 and no container starts" {
    rmdir "${GREMION_ROOT}/etc/secrets/governance"
    step
    [ "$status" -eq 2 ]
    [ "$(calls run)" -eq 0 ]
    out_has 'reason=secrets_dir'
    mkdir -m 755 "${GREMION_ROOT}/etc/secrets/governance"
    chmod 755 "${GREMION_ROOT}/etc/secrets/governance"
    step
    [ "$status" -eq 2 ]
    [ "$(calls run)" -eq 0 ]
    rmdir "${GREMION_ROOT}/etc/secrets/governance"
    ln -s "${GREMION_ROOT}/etc/secrets/tenants" "${GREMION_ROOT}/etc/secrets/governance"
    step
    [ "$status" -eq 2 ]
    [ "$(calls run)" -eq 0 ]
}

@test "TENANT_SECRETS_DIR is read from the target env file: missing directory, wrong mode, no key and a relative path are code 2" {
    rmdir "${GREMION_ROOT}/etc/secrets/tenants"
    step
    [ "$status" -eq 2 ]
    [ "$(calls run)" -eq 0 ]
    mkdir -m 755 "${GREMION_ROOT}/etc/secrets/tenants"
    chmod 755 "${GREMION_ROOT}/etc/secrets/tenants"
    step
    [ "$status" -eq 2 ]
    [ "$(calls run)" -eq 0 ]
    chmod 700 "${GREMION_ROOT}/etc/secrets/tenants"
    grep -v '^TENANT_SECRETS_DIR=' "${GREMION_ROOT}/etc/env/app-green.env" >"${GREMION_ROOT}/etc/env/app-green.env.new"
    mv "${GREMION_ROOT}/etc/env/app-green.env.new" "${GREMION_ROOT}/etc/env/app-green.env"
    step
    [ "$status" -eq 2 ]
    printf 'TENANT_SECRETS_DIR=secrets/tenants\n' >>"${GREMION_ROOT}/etc/env/app-green.env"
    step
    [ "$status" -eq 2 ]
    [ "$(calls run)" -eq 0 ]
    # nothing was asked of docker before the directories were right
    [ "$(calls exec)" -eq 0 ]
}

@test "a directory that belongs to another user is code 2 (the deploy user's uid is compared)" {
    shim id 'echo 4242'
    step
    [ "$status" -eq 2 ]
    [ "$(calls run)" -eq 0 ]
}

@test "the module export directory that the service also mounts must exist: Docker would create it as root" {
    rmdir "${GREMION_ROOT}/data/module-exports"
    step
    [ "$status" -eq 2 ]
    [ "$(calls run)" -eq 0 ]
    out_has 'reason=exports_dir'
}

# ------------------------------------------------------------------------ the listing

@test "a failing listing is code 2 and the one-shot is not called" {
    touch "$DK/q1.fail"
    step
    [ "$status" -eq 2 ]
    [ "$(calls run)" -eq 0 ]
    out_has 'reason=listing_failed'
    rm "$DK/q1.fail"
    touch "$DK/q2.fail"
    step
    [ "$status" -eq 2 ]
    [ "$(calls run)" -eq 0 ]
    rm "$DK/q2.fail"
    touch "$DK/dbs.c-cal.fail"
    step
    [ "$status" -eq 2 ]
    [ "$(calls run)" -eq 0 ]
    out_has 'reason=server_listing_failed'
}

@test "no running postgres in the state project is code 2" {
    rm "$DK/cid.teststack-state.postgres"
    step
    [ "$status" -eq 2 ]
    out_has 'reason=no_state_postgres'
    [ "$(calls run)" -eq 0 ]
}

@test "a row that is not a name and a state, a name that is no gate database and a repeated row are code 2" {
    printf 'not-a-database|enabled\n' >"$DK/q1"
    : >"$DK/q2"
    step
    [ "$status" -eq 2 ]
    out_has 'reason=listing_malformed'
    printf '%s\n' "$DB1" >"$DK/q1"
    step
    [ "$status" -eq 2 ]
    printf '%s|enabled\n%s|enabled\n' "$DB1" "$DB1" >"$DK/q1"
    step
    [ "$status" -eq 2 ]
    [ "$(calls run)" -eq 0 ]
}

@test "an empty listing is code 0 with total 0 and the one-shot is not called, once the cross-checks passed" {
    : >"$DK/q1"
    : >"$DK/q2"
    : >"$DK/dbs.c-cal"
    : >"$DK/dbs.c-con"
    step
    [ "$status" -eq 0 ]
    [ "$(calls run)" -eq 0 ]
    [ "$(state_modules)" = '{"total":0,"upgraded":0,"unchanged":0,"skipped":0,"failed":0,"files_applied":0}' ]
}

@test "GUARD: an enabled row that the joined query does not return is code 2, never 'nothing to do'" {
    : >"$DK/q2"
    step
    [ "$status" -eq 2 ]
    out_has 'reason=enabled_count_mismatch'
    [ "$(calls run)" -eq 0 ]
}

@test "GUARD: a gate database on a running module server with no registry row is code 2" {
    printf '%s\n%s\n' "$DB1" "$(dbn 9 calendar)" >"$DK/dbs.c-cal"
    step
    [ "$status" -eq 2 ]
    out_has 'reason=unknown_database'
    [ "$(calls run)" -eq 0 ]
}

@test "GUARD: a state outside the five is code 2" {
    printf '%s|enabled\n%s|frozen\n' "$DB1" "$DB2" >"$DK/q1"
    printf '%s\n' "$DB1" >"$DK/q2"
    step
    [ "$status" -eq 2 ]
    out_has 'reason=unknown_state'
    [ "$(calls run)" -eq 0 ]
}

@test "GUARD: an enabled row whose database is on no running server is code 2 (also when its server is not running)" {
    : >"$DK/dbs.c-con"
    step
    [ "$status" -eq 2 ]
    out_has 'reason=enabled_database_missing'
    [ "$(calls run)" -eq 0 ]
    printf '%s\n' "$DB2" >"$DK/dbs.c-con"
    rm "$DK/cid.teststack-state.content-postgres"
    step
    [ "$status" -eq 2 ]
    out_has 'reason=enabled_database_missing'
    [ "$(calls run)" -eq 0 ]
}

@test "an enabled row of a module the release tree declares no database for is code 2" {
    rm "${TREE}/modules/content/module.json"
    mk_module content null
    step
    [ "$status" -eq 2 ]
    out_has 'reason=module_undeclared'
    [ "$(calls run)" -eq 0 ]
}

@test "a blocked and an enabling row whose databases are present are no error and are not migrated" {
    DB3="$(dbn 3 calendar)"
    DB4="$(dbn 4 content)"
    printf '%s|enabled\n%s|enabled\n%s|blocked\n%s|enabling\n' "$DB1" "$DB2" "$DB3" "$DB4" >"$DK/q1"
    printf '%s\n%s\n' "$DB1" "$DB2" >"$DK/q2"
    printf '%s\n%s\n' "$DB1" "$DB3" >"$DK/dbs.c-cal"
    printf '%s\n%s\n' "$DB2" "$DB4" >"$DK/dbs.c-con"
    echo "$JSON_OK" >"$DK/run.out"
    step
    [ "$status" -eq 0 ]
    [ "$(calls run)" -eq 1 ]
}

@test "a module server that is not running and holds no enabled row is skipped, not an error" {
    rm "$DK/cid.teststack-state.newsletter-postgres"
    echo "$JSON_OK" >"$DK/run.out"
    step
    [ "$status" -eq 0 ]
    [ "$(calls run)" -eq 1 ]
}

@test "a missing role key of a running module server is code 2, never a default" {
    grep -v '^CALENDAR_PG_USER=' "${GREMION_ROOT}/etc/env/state.env" >"${GREMION_ROOT}/etc/env/state.env.new"
    mv "${GREMION_ROOT}/etc/env/state.env.new" "${GREMION_ROOT}/etc/env/state.env"
    step
    [ "$status" -eq 2 ]
    out_has 'reason=no_pg_user'
    [ "$(calls run)" -eq 0 ]
}

# ------------------------------------------------------------------------ the dump precondition

@test "GUARD: a database with no live dump of this release is code 2 and the one-shot is not called" {
    mk_dump "$TAG" "$DB1"
    step
    [ "$status" -eq 2 ]
    out_has 'reason=dump_missing'
    [ "$(calls run)" -eq 0 ]
}

@test "a live dump of another release does not count, and the ledger is asked for this release's label" {
    mk_dump "pilot-cccccccccccc" "$DB1" "$DB2"
    step
    [ "$status" -eq 2 ]
    [ "$(calls run)" -eq 0 ]
    assert_present '^status\|--release\|pilot-bbbbbbbbbbbb$' "$DK/dump.argv"
}

@test "GUARD: the dump ledger is read BEFORE the one-shot starts" {
    echo "$JSON_OK" >"$DK/run.out"
    step
    [ "$status" -eq 0 ]
    local d r
    d="$(grep -nxF dump "$DK/order.log" | head -n 1 | cut -d: -f1)"
    r="$(grep -nxF run "$DK/order.log" | head -n 1 | cut -d: -f1)"
    [ -n "$d" ] && [ -n "$r" ] && [ "$d" -lt "$r" ]
}

@test "an unreadable, truncated or unparseable ledger answer is code 2" {
    echo 3 >"$DK/dump.rc"
    step
    [ "$status" -eq 2 ]
    rm "$DK/dump.rc"
    sed -i '$d' "$DK/dump.status"
    step
    [ "$status" -eq 2 ]
    out_has 'reason=dump_status_unparsed'
    mk_dump "$TAG" "$DB1" "$DB2"
    printf 'something else\n' >>"$DK/dump.status"
    step
    [ "$status" -eq 2 ]
    mk_dump "$TAG" "$DB1" "$DB2"
    sed -i 's/STATUS: 2/STATUS: 3/' "$DK/dump.status"
    step
    [ "$status" -eq 2 ]
    [ "$(calls run)" -eq 0 ]
}

# ------------------------------------------------------------------------ the call

@test "the one-shot is started from the NEW tree with the TARGET colour's env, no -f, -p or profile, --no-deps, stdin from /dev/null" {
    echo "$JSON_OK" >"$DK/run.out"
    step
    [ "$status" -eq 0 ]
    local line
    line="$(cat "$DK/run.log")"
    [ "$line" = "compose|--env-file|${GREMION_ROOT}/etc/env/app-green.env|run|--rm|--no-deps|-T|--label|gremion.cd=${RID}|tenant-create|module-upgrade|--all" ]
    [ "$(cat "$DK/run.cwd")" = "$TREE" ]
    [ "$(cat "$DK/run.stdin")" = /dev/null ]
}

@test "the call is bounded by CD_MODULE_UPGRADE_TIMEOUT_S" {
    cd_write_cfg CD_MODULE_UPGRADE_TIMEOUT_S=321
    echo "$JSON_OK" >"$DK/run.out"
    step
    [ "$status" -eq 0 ]
    assert_present '^CD_DC_TIMEOUT=321$' "$DK/run.env"
}

@test "the release record must exist and agree with the tag and colour asked for" {
    run --separate-stderr mod 'cd_lock_take; rc=0; cd_modules_upgrade "$TREE" blue "$TAG" || rc=$?; echo "reason=${CD_MODULES_REASON}"; exit "$rc"'
    [ "$status" -eq 2 ]
    out_has 'reason=release_mismatch'
    run --separate-stderr mod 'cd_lock_take; rc=0; cd_modules_upgrade "$TREE" green pilot-cccccccccccc || rc=$?; echo "reason=${CD_MODULES_REASON}"; exit "$rc"'
    [ "$status" -eq 2 ]
    cd_seed_state
    step
    [ "$status" -eq 2 ]
    out_has 'reason=no_release'
    run --separate-stderr mod 'cd_lock_take; rc=0; cd_modules_upgrade "$TREE" purple "$TAG" || rc=$?; exit "$rc"'
    [ "$status" -eq 2 ]
    run --separate-stderr mod 'cd_lock_take; rc=0; cd_modules_upgrade "$TREE" green latest || rc=$?; exit "$rc"'
    [ "$status" -eq 2 ]
    run --separate-stderr mod 'cd_lock_take; rc=0; cd_modules_upgrade /nonexistent green "$TAG" || rc=$?; exit "$rc"'
    [ "$status" -eq 2 ]
    [ "$(calls run)" -eq 0 ]
}

# ------------------------------------------------------------------------ the exit codes

@test "exit 0 with a valid line whose counts add up is ok; the counts go to release.modules" {
    echo '{"total":5,"upgraded":2,"unchanged":2,"skipped":1,"failed":0,"files_applied":7}' >"$DK/run.out"
    step
    [ "$status" -eq 0 ]
    [ "$(state_modules)" = '{"total":5,"upgraded":2,"unchanged":2,"skipped":1,"failed":0,"files_applied":7}' ]
}

@test "exit 1 with a valid JSON line is code 1 (a failure of the commit); the counts are recorded" {
    echo '{"total":3,"upgraded":1,"unchanged":0,"skipped":0,"failed":1,"files_applied":2}' >"$DK/run.out"
    echo 1 >"$DK/run.rc"
    step
    [ "$status" -eq 1 ]
    out_has 'reason=module_upgrade'
    [ "$(state_modules)" = '{"total":3,"upgraded":1,"unchanged":0,"skipped":0,"failed":1,"files_applied":2}' ]
}

@test "exit 3 is code 4 (an infrastructure failure, retried, no block)" {
    echo '{"total":3,"upgraded":0,"unchanged":0,"skipped":0,"failed":0,"files_applied":0}' >"$DK/run.out"
    echo 3 >"$DK/run.rc"
    step
    [ "$status" -eq 4 ]
    out_has 'reason=module_infra'
}

@test "exit 2 is code 2" {
    echo 2 >"$DK/run.rc"
    step
    [ "$status" -eq 2 ]
}

@test "GUARD: an exit 1 with no valid JSON line is compose's own failure: code 4, not a failure of the commit" {
    echo 1 >"$DK/run.rc"
    echo 'compose: no such service slugmarker' >"$DK/run.err"
    step
    [ "$status" -eq 4 ]
    out_has 'reason=module_run_failed'
    echo 'not json' >"$DK/run.out"
    step
    [ "$status" -eq 4 ]
}

@test "any other exit (docker's own 125 to 127) is code 4, never 0 or 1" {
    local rc
    for rc in 125 126 127; do
        echo "$rc" >"$DK/run.rc"
        step
        [ "$status" -eq 4 ]
    done
}

@test "GUARD: exit 0 with a missing, unparseable or ambiguous line is code 1 (fail closed)" {
    step
    [ "$status" -eq 1 ]
    out_has 'reason=module_result_invalid'
    echo '{"total":2,' >"$DK/run.out"
    step
    [ "$status" -eq 1 ]
    printf '%s\n%s\n' "$JSON_OK" "$JSON_OK" >"$DK/run.out"
    step
    [ "$status" -eq 1 ]
    echo '{"total":2,"upgraded":1,"unchanged":1,"skipped":0,"failed":"0","files_applied":3}' >"$DK/run.out"
    step
    [ "$status" -eq 1 ]
    echo '{"total":2,"upgraded":1,"unchanged":1,"skipped":0,"failed":0}' >"$DK/run.out"
    step
    [ "$status" -eq 1 ]
    # the line on stderr does not count: stdout is the verb's answer
    : >"$DK/run.out"
    echo "$JSON_OK" >"$DK/run.err"
    step
    [ "$status" -eq 1 ]
    [ "$(state_modules)" = null ]
}

@test "GUARD: exit 0 with counts that do not add up, or with a failed database, is code 1" {
    echo '{"total":5,"upgraded":1,"unchanged":1,"skipped":0,"failed":0,"files_applied":3}' >"$DK/run.out"
    step
    [ "$status" -eq 1 ]
    echo '{"total":2,"upgraded":1,"unchanged":0,"skipped":0,"failed":1,"files_applied":3}' >"$DK/run.out"
    step
    [ "$status" -eq 1 ]
    [ "$(state_modules)" = null ]
}

# ------------------------------------------------------------------------ nothing leaks

@test "GUARD: the one-shot's output goes to 0600 files under logs/; a slug, a database name and the word password reach no stream, state, history, outbox or journal" {
    echo "$JSON_OK" >"$DK/run.out"
    printf 'applied for slugmarker in %s password=secretword\n' "$DB1" >"$DK/run.err"
    printf 'dump program says %s slugmarker\n' "$DB2" >"$DK/dump.stderr"
    step
    [ "$status" -eq 0 ]
    local f seen=0
    f="${BATS_TEST_TMPDIR}/streams.txt"
    {
        printf '%s\n' "$output"
        printf '%s\n' "$stderr"
        cat "${GREMION_ROOT}/data/cd/state.json" "${GREMION_ROOT}/data/cd/history.jsonl" "$SHIM_LOG" 2>/dev/null
        find "${GREMION_ROOT}/data/cd" -type f \( -path '*outbox*' -o -name ALERT \) -exec cat {} + 2>/dev/null
    } >"$f"
    assert_absent "slugmarker" "$f"
    assert_absent "password" "$f"
    assert_absent "secretword" "$f"
    assert_absent "t_0000000000000000000000000000000[0-9]__" "$f"
    # the output is kept, in files only the deploy user reads
    for f in "${GREMION_ROOT}"/logs/cd-modules-*.log; do
        [ "$(stat -c %a "$f")" = 600 ]
        if grep -q slugmarker "$f"; then seen=1; fi
    done
    [ "$seen" -eq 1 ]
}

@test "a failure at every stage of the step stays quiet about the names (listing, dump, timeout)" {
    printf '%s\n' "$DB1" >"$DK/dbs.c-cal"
    touch "$DK/q1.fail"
    step
    [ "$status" -eq 2 ]
    local f="${BATS_TEST_TMPDIR}/streams.txt"
    {
        printf '%s\n' "$output"
        printf '%s\n' "$stderr"
    } >"$f"
    assert_absent "slugmarker" "$f"
    assert_absent "t_0000000000000000000000000000000[0-9]__" "$f"
    # the file name of the output is said, nothing of its content
    err_has 'logs/cd-modules-query-'
}

# ------------------------------------------------------------------------ policy

@test "policy migration with no module chain file in the class: the step is skipped, modules stay null, docker is not asked" {
    seed_release '.release.class = {migrations: {total: 1, chains: {"kernel-data": {class: "tenant-store", expand: 1, migrate: 0, contract: 0}}}}'
    run --separate-stderr mod 'cd_cfg() { case "$1" in CD_DUMP_POLICY) echo migration ;; CD_MODULE_UPGRADE_TIMEOUT_S) echo 900 ;; *) return 2 ;; esac; }
cd_lock_take; rc=0; cd_modules_upgrade "$TREE" green "$TAG" || rc=$?; exit "$rc"'
    [ "$status" -eq 0 ]
    [ "$(state_modules)" = null ]
    refute_recorded docker ""
}

@test "policy migration with a module-upgrade chain that gained a file runs the step" {
    seed_release '.release.class = {migrations: {total: 1, chains: {"module-calendar": {class: "module-upgrade", expand: 1, migrate: 0, contract: 0}}}}'
    echo "$JSON_OK" >"$DK/run.out"
    run --separate-stderr mod 'cd_cfg() { case "$1" in CD_DUMP_POLICY) echo migration ;; CD_MODULE_UPGRADE_TIMEOUT_S) echo 900 ;; *) return 2 ;; esac; }
cd_lock_take; rc=0; cd_modules_upgrade "$TREE" green "$TAG" || rc=$?; exit "$rc"'
    [ "$status" -eq 0 ]
    [ "$(calls run)" -eq 1 ]
}

@test "policy migration with no readable class is code 2, never a skip" {
    run --separate-stderr mod 'cd_cfg() { case "$1" in CD_DUMP_POLICY) echo migration ;; CD_MODULE_UPGRADE_TIMEOUT_S) echo 900 ;; *) return 2 ;; esac; }
cd_lock_take; rc=0; cd_modules_upgrade "$TREE" green "$TAG" || rc=$?; echo "reason=${CD_MODULES_REASON}"; exit "$rc"'
    [ "$status" -eq 2 ]
    out_has 'reason=class_missing'
    [ "$(calls run)" -eq 0 ]
}

# ------------------------------------------------------------------------ the timeout (F50)

@test "GUARD: on a timeout the container outlives the killed client; it is killed and removed by its label and the step returns only when two polls of docker ps -a in a row are empty" {
    cd_write_cfg CD_MODULE_UPGRADE_TIMEOUT_S=1
    touch "$DK/run.hang" "$DK/run.creates"
    echo 2 >"$DK/sticky"
    step
    [ "$status" -eq 2 ]
    out_has 'reason=module_timeout'
    # the labelled container is gone at the moment the step returned, and the order was
    # run, kill, rm, then the polls: at least the 2 sticky answers and 2 empty ones
    [ ! -s "$DK/ctr" ]
    local after
    after="$(sed -n '/^rm$/,$p' "$DK/order.log" | grep -c '^ps -a ')"
    [ "$after" -ge 4 ]
    [ "$(calls kill)" -ge 1 ]
    assert_present "^ps -a ${RID}$" "$DK/order.log"
}

@test "GUARD: an exited labelled container is found because the poll uses docker ps -a, not docker ps" {
    cd_write_cfg CD_MODULE_UPGRADE_TIMEOUT_S=1
    touch "$DK/run.hang" "$DK/run.exited"
    step
    [ "$status" -eq 2 ]
    out_has 'reason=module_timeout'
    [ ! -s "$DK/ctr" ]
    refute_in_order_log '^ps [^-]'
}

@test "a container that never disappears is code 2 with module_container_alive, a mail, and the locks stay held" {
    cd_write_cfg CD_MODULE_UPGRADE_TIMEOUT_S=1
    touch "$DK/run.hang" "$DK/run.creates" "$DK/rm.refuse"
    run --separate-stderr mod 'cd_lock_take; cd_hostlock_take; rc=0; cd_modules_upgrade "$TREE" green "$TAG" || rc=$?; echo "reason=${CD_MODULES_REASON}"
if ( exec 9>>"${GREMION_ROOT}/runtime/hostd.lock"; flock -n 9 ); then echo HOSTLOCK=free; else echo HOSTLOCK=held; fi
exit "$rc"'
    [ "$status" -eq 2 ]
    out_has 'reason=module_container_alive'
    out_has 'HOSTLOCK=held'
    [ -s "$DK/ctr" ]
    local mail
    mail="$(cat "${GREMION_ROOT}"/data/cd/outbox/*stopped*.eml 2>/dev/null || true)"
    [[ "$mail" == *module_container_alive* ]]
}

@test "GUARD: a container of an earlier try is removed before the next one starts, and when it cannot be no second run starts" {
    echo "c-old running" >"$DK/ctr"
    echo "$JSON_OK" >"$DK/run.out"
    step
    [ "$status" -eq 0 ]
    # the old container was reaped first: the run did not see it
    refute_in_order_log '^run-saw-container$'
    seed_release
    echo "c-old running" >"$DK/ctr"
    : >"$DK/order.log"
    touch "$DK/rm.refuse"
    step
    [ "$status" -eq 2 ]
    out_has 'reason=module_container_alive'
    [ "$(calls run)" -eq 0 ]
}

@test "a labelled docker ps that does not answer is not read as an empty answer" {
    touch "$DK/ps.fail"
    step
    [ "$status" -eq 2 ]
    out_has 'reason=module_container_alive'
    [ "$(calls run)" -eq 0 ]
}

# ------------------------------------------------------------------------ the count

@test "cd_modules_enabled_count equals the listing" {
    run --separate-stderr mod 'cd_modules_enabled_count'
    [ "$status" -eq 0 ]
    [ "$output" = 2 ]
    DB3="$(dbn 3 calendar)"
    printf '%s|enabled\n%s|enabled\n%s|enabled\n%s|blocked\n' "$DB1" "$DB2" "$DB3" "$(dbn 4 content)" >"$DK/q1"
    printf '%s\n%s\n%s\n' "$DB1" "$DB2" "$DB3" >"$DK/q2"
    run --separate-stderr mod 'cd_modules_enabled_count'
    [ "$status" -eq 0 ]
    [ "$output" = 3 ]
    : >"$DK/q1"
    : >"$DK/q2"
    run --separate-stderr mod 'cd_modules_enabled_count'
    [ "$status" -eq 0 ]
    [ "$output" = 0 ]
}

@test "cd_modules_enabled_count prints nothing and returns 2 when the registry cannot be read or the queries disagree" {
    touch "$DK/q1.fail"
    run --separate-stderr mod 'cd_modules_enabled_count'
    [ "$status" -eq 2 ]
    [ -z "$output" ]
    rm "$DK/q1.fail"
    : >"$DK/q2"
    run --separate-stderr mod 'cd_modules_enabled_count'
    [ "$status" -eq 2 ]
    [ -z "$output" ]
}

# refute_in_order_log ERE -- fails when a line of the docker order log matches ERE.
refute_in_order_log() {
    local hit
    hit="$(grep -nE -- "$1" "$DK/order.log" || true)"
    if [ -n "$hit" ]; then
        echo "unexpected line in the order log: $hit" >&2
        return 1
    fi
    return 0
}
