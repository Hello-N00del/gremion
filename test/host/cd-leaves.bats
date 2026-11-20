#!/usr/bin/env bats
# test/host/cd-leaves.bats -- cd-leaves: infra/host/lib/cd/leaves.sh, the host side of the leaf
# step of the continuous deployment program: the service list, the dump precondition for every
# leaf database, one container per leaf service, the mapping of its exit codes, the timeout that
# kills by label and confirms the container gone.
#
# Run: MSYS_NO_PATHCONV=1 docker run --rm --user 1001 -v "$(pwd -W):/repo:ro" -w /repo gremion-bats:local test/host/cd-leaves.bats
#
# Nothing here touches a real docker, psql or network: docker is one recording shim whose
# answers are files under $DK, gremion-migration-dump is a shim of the installed program, the
# host layout is a temp $GREMION_ROOT. docker.sh, notify.sh and core.sh are the REAL libraries;
# everything after this unit is the helper's stubs. Every name is a reserved example name; the
# leaf database names carry the marker word "slugmarker" so that a leak is found by grep, and
# the secret-looking word is a low-entropy fixture. The snippets run WITHOUT errexit, as a
# driver that calls a stage as `fn || rc=$?`.

bats_require_minimum_version 1.5.0
load 'test_helper/host'
load 'test_helper/cd'

FIX="${BATS_TEST_DIRNAME}/fixtures/cd/leaves"
REPO_ROOT="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
export TAG="pilot-bbbbbbbbbbbb"
export RID="bbbbbbbbbbbb-1"
# What one leaf answers: two customers, one migrated and one without a database.
JSON_OK='{"v":1,"total":2,"migrated":1,"skipped":1,"failed":0}'
# Services that the fixed list never contains and that must never be run.
NEVER_RUN_SERVICES="board-service"

# The docker shim body. State lives in $DK:
#   argv.log          one line per call, args joined with '|'
#   order.log         the calls that matter in order: exec, ps (with -a or not), config, run, kill, rm, dump
#   exec.log          container|role|database of every docker exec; sql.log the SQL texts
#   role.<cid>        the role that server accepts (any other role: "role does not exist")
#   dbs.<cid>         the databases a leaf server lists (dbs.<cid>.fail makes psql fail)
#   cid.<proj>.<svc>  a running compose service container
#   services          what `compose config --services` prints (services.fail makes it fail)
#   run.<svc>.out/.err/.rc   what the entry of that service prints and its exit code
#                     (run.out/run.err/run.rc are the defaults); run.<svc>.hang the client hangs
#                     after printing its output
#                     (the shim becomes sleep, so `timeout` kills it); .creates the run leaves a
#                     running labelled container behind; .exited an exited one
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
      postgres)
        [ -f "$DK/dbs.$cid.fail" ] && { echo "connection lost slugmarker" >&2; exit 2; }
        [ -f "$DK/dbs.$cid" ] && cat "$DK/dbs.$cid"
        exit 0 ;;
    esac
    exit 3 ;;
  compose)
    verb=''; svc=''; prev=''
    for a in "$@"; do
      case "$a" in config|run) [ -n "$verb" ] || verb="$a" ;; esac
      prev="$a"
    done
    if [ "$verb" = config ]; then
      echo "config" >>"$DK/order.log"
      [ -f "$DK/services.fail" ] && { echo "compose failed" >&2; exit 1; }
      [ -f "$DK/services" ] && cat "$DK/services"
      exit 0
    fi
    # the service is the argument that follows the --label value
    seen=''
    for a in "$@"; do
      if [ "$seen" = value ]; then svc="$a"; break; fi
      if [ "$seen" = label ]; then seen=value; continue; fi
      [ "$a" = --label ] && seen=label
    done
    (IFS='|'; printf '%s\n' "$*" >>"$DK/run.log")
    pwd >>"$DK/run.cwd"
    readlink "/proc/$$/fd/0" >>"$DK/run.stdin" 2>/dev/null || echo unknown >>"$DK/run.stdin"
    env | grep -E '^(CD_DC_TIMEOUT|COMPOSE_)' | sort >>"$DK/run.env" || true
    echo "run" >>"$DK/order.log"
    echo "run:$svc" >>"$DK/order.log"
    [ -s "$DK/ctr" ] && echo "run-saw-container" >>"$DK/order.log"
    [ -f "$DK/run.$svc.creates" ] && echo "c-$svc running" >>"$DK/ctr"
    [ -f "$DK/run.$svc.exited" ] && echo "c-$svc exited" >>"$DK/ctr"
    if [ -f "$DK/run.$svc.out" ]; then cat "$DK/run.$svc.out"; elif [ -f "$DK/run.out" ]; then cat "$DK/run.out"; fi
    if [ -f "$DK/run.$svc.err" ]; then cat "$DK/run.$svc.err" >&2; elif [ -f "$DK/run.err" ]; then cat "$DK/run.err" >&2; fi
    # a hanging client has already printed what it had: the log files of a timed-out run are not empty
    [ -f "$DK/run.$svc.hang" ] && exec sleep 30
    if [ -f "$DK/run.$svc.rc" ]; then exit "$(cat "$DK/run.$svc.rc")"; fi
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

# A gate-database name (the module step's, never the entry's).
gate() { printf 't_%032x__%s' "$1" "$2"; }

setup() {
    cd_setup
    export STACK=teststack TZ=UTC
    DK="${SHIM_DIR}/dk"
    export DK
    mkdir -p "$DK"
    cp "${FIX}/state.env" "${FIX}/app-blue.env" "${FIX}/app-green.env" "${GREMION_ROOT}/etc/env/"
    printf 'TENANT_SECRETS_DIR=%s/etc/secrets/tenants\n' "$GREMION_ROOT" >>"${GREMION_ROOT}/etc/env/app-green.env"
    printf 'TENANT_SECRETS_DIR=%s/etc/secrets/tenants\n' "$GREMION_ROOT" >>"${GREMION_ROOT}/etc/env/app-blue.env"
    mkdir -p "${GREMION_ROOT}/etc/secrets/governance" "${GREMION_ROOT}/etc/secrets/tenants"
    chmod 700 "${GREMION_ROOT}/etc/secrets/governance" "${GREMION_ROOT}/etc/secrets/tenants"
    TREE="${GREMION_ROOT}/releases/bbbbbbbbbbbb"
    export TREE
    mkdir -p "$TREE"
    shim docker "$(docker_shim_body)"
    shim logger
    # the three leaf servers: container ids and the one role each accepts
    echo c-cal >"$DK/cid.teststack-state.calendar-postgres"
    echo cal_admin >"$DK/role.c-cal"
    echo c-con >"$DK/cid.teststack-state.content-postgres"
    echo con_admin >"$DK/role.c-con"
    echo c-nl >"$DK/cid.teststack-state.newsletter-postgres"
    echo nl_admin >"$DK/role.c-nl"
    # the databases of each: the catalogue database and one customer database
    printf 'calendar_control\ncalendar_slugmarker\n' >"$DK/dbs.c-cal"
    printf 'content_control\ncontent_slugmarker\n' >"$DK/dbs.c-con"
    printf 'newsletter_control\nnewsletter_slugmarker\n' >"$DK/dbs.c-nl"
    # what `compose config --services` of the green project renders: the three leaves, the board
    # leaf and other services that are never leaves
    cat >"$DK/services" <<'EOF'
gremion-ui
gremion-public
kernel-api
calendar-service
content-service
newsletter-service
board-service
matrix
nextcloud
EOF
    echo "$JSON_OK" >"$DK/run.out"
    mk_dump "$TAG" calendar_control calendar_slugmarker content_control content_slugmarker newsletter_control newsletter_slugmarker
    seed_release
}

teardown() {
    cd_teardown
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
    rel="$(jq -n --arg t "$TREE" '{id:"bbbbbbbbbbbb-1", sha:"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", sha12:"bbbbbbbbbbbb", tag:"pilot-bbbbbbbbbbbb", colour:"green", tree:$t, mode:"auto", stage:"migrate", stage_status:"started", class:null, modules:null, leaves:null}')"
    cd_seed_state ".phase = \"releasing\" | .release = ${rel} | ${extra}"
}

leaf() {
    local snippet="$1"
    shift
    bash -c "set -uo pipefail
. \"\${HOST_SRC}/lib/common.sh\"
. \"\${HOST_SRC}/lib/cd/core.sh\"
. \"\${HOST_SRC}/lib/cd/docker.sh\"
. \"\${HOST_SRC}/lib/cd/notify.sh\"
. \"\${HOST_SRC}/lib/cd/leaves.sh\"
. \"\${GREMION_CD_STUBS_DIR}/cd-stubs.sh\"
cd_cfg_load || exit 99
${snippet}" leaf "$@"
}

# step -- the step as a driver calls it: the lock taken, the code and the reason printed last.
step() {
    run --separate-stderr leaf 'cd_lock_take; rc=0; cd_leaves_migrate "$TREE" green "$TAG" || rc=$?; echo "reason=${CD_LEAVES_REASON}"; exit "$rc"'
}

# cfgfn POLICY TIMEOUT -- a cd_cfg that answers the two keys of the step. The loader accepts
# only the policy `always` and a timeout of at least 60 seconds, so the policy `migration` and a
# one-second timeout are given to the library this way, as the module step's tests do.
cfgfn() {
    printf '%s\n' 'eval "$(declare -f cd_cfg | sed "1s/^cd_cfg/_cd_cfg_real/")"'
    printf 'cd_cfg() { case "$1" in CD_DUMP_POLICY) echo %s ;; CD_LEAF_MIGRATE_TIMEOUT_S) echo %s ;; *) _cd_cfg_real "$@" ;; esac; }\n' "$1" "$2"
}

# step_with POLICY TIMEOUT -- the step with those two answers and a short confirmation window
# (the fake clock moves one second per poll: 8 seconds cover the two sticky answers and two
# empty ones of the timeout guard).
step_with() {
    run --separate-stderr leaf "$(cfgfn "$1" "$2")
export CD_LEAVES_CONFIRM_S=8
cd_lock_take; rc=0; cd_leaves_migrate \"\$TREE\" green \"\$TAG\" || rc=\$?; echo \"reason=\${CD_LEAVES_REASON}\"; exit \"\$rc\""
}

# state_leaves -- release.leaves of the state as compact JSON.
state_leaves() { jq -c '.release.leaves' "${GREMION_ROOT}/data/cd/state.json"; }

# svc_out SERVICE JSON / svc_rc SERVICE CODE -- what one leaf service answers.
svc_out() { printf '%s\n' "$2" >"$DK/run.$1.out"; }
svc_rc() { printf '%s\n' "$2" >"$DK/run.$1.rc"; }

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

@test "the step lists the services, finds a live dump for every leaf database, runs one entry per leaf service and records the summed counts" {
    step
    [ "$status" -eq 0 ]
    [ "$(calls run)" -eq 3 ]
    [ "$(state_leaves)" = '{"total":6,"migrated":3,"skipped":3,"failed":0}' ]
    out_has '^reason=$'
}

@test "the leaf servers are asked as their own role, on the postgres database, through their own container" {
    step
    [ "$status" -eq 0 ]
    assert_present '^c-cal\|cal_admin\|postgres$' "$DK/exec.log"
    assert_present '^c-con\|con_admin\|postgres$' "$DK/exec.log"
    assert_present '^c-nl\|nl_admin\|postgres$' "$DK/exec.log"
}

@test "the SQL texts hold no database name and skip the templates and the postgres database" {
    step
    [ "$status" -eq 0 ]
    assert_absent "slugmarker|t_[0-9a-f]{32}__" "$DK/sql.log"
    assert_present "NOT datistemplate" "$DK/sql.log"
    assert_present "datname <> 'postgres'" "$DK/sql.log"
}

@test "the library releases no lock, writes no block and no hold and never calls a rollback" {
    run --separate-stderr leaf 'cd_lock_take; cd_hostlock_take; rc=0; cd_leaves_migrate "$TREE" green "$TAG" || rc=$?
if ( exec 9>>"${GREMION_ROOT}/runtime/hostd.lock"; flock -n 9 ); then echo HOSTLOCK=free; else echo HOSTLOCK=held; fi
exit "$rc"'
    [ "$status" -eq 0 ]
    out_has 'HOSTLOCK=held'
    # the step ran: one container per enabled leaf service, so the absences below are read
    # from a state the step really worked on
    [ "$(calls run)" -eq 3 ]
    [ "$(jq -c '.hold' "${GREMION_ROOT}/data/cd/state.json")" = null ]
    [ ! -s "${GREMION_ROOT}/data/cd/blocked.json" ] || [ "$(jq 'length' "${GREMION_ROOT}/data/cd/blocked.json")" = 0 ]
    assert_absent 'cd_rollback_run' "$SHIM_LOG"
}

# ------------------------------------------------------------------------ the service list

@test "GUARD: only the leaf services that the target colour's compose project renders are run; board, messaging and Nextcloud never are" {
    # newsletter is off in this colour's profiles
    grep -v '^newsletter-service$' "$DK/services" >"$DK/services.new"
    mv "$DK/services.new" "$DK/services"
    step
    [ "$status" -eq 0 ]
    [ "$(calls run)" -eq 2 ]
    assert_present '^run:calendar-service$' "$DK/order.log"
    assert_present '^run:content-service$' "$DK/order.log"
    refute_in_order_log '^run:newsletter-service$'
    refute_in_order_log '^run:board-service$'
    refute_in_order_log '^run:(matrix|nextcloud|gremion-ui|kernel-api|messaging)'
    [ "$(state_leaves)" = '{"total":4,"migrated":2,"skipped":2,"failed":0}' ]
}

@test "GUARD: a service of the fixed list that is not rendered is not run, and the dump of its server is not required either" {
    grep -v '^newsletter-service$' "$DK/services" >"$DK/services.new"
    mv "$DK/services.new" "$DK/services"
    mk_dump "$TAG" calendar_control calendar_slugmarker content_control content_slugmarker
    step
    [ "$status" -eq 0 ]
    [ "$(calls run)" -eq 2 ]
}

@test "no leaf profile on: nothing runs, nothing is dumped or listed, and the counts are zero" {
    printf 'gremion-ui\nkernel-api\nboard-service\n' >"$DK/services"
    step
    [ "$status" -eq 0 ]
    [ "$(calls run)" -eq 0 ]
    [ "$(calls exec)" -eq 0 ]
    [ "$(state_leaves)" = '{"total":0,"migrated":0,"skipped":0,"failed":0}' ]
}

@test "a compose project that renders nothing, or does not render at all, is code 2 and not 'no leaf'" {
    : >"$DK/services"
    step
    [ "$status" -eq 2 ]
    out_has 'reason=services_failed'
    [ "$(calls run)" -eq 0 ]
    touch "$DK/services.fail"
    step
    [ "$status" -eq 2 ]
    out_has 'reason=services_failed'
    [ "$(calls run)" -eq 0 ]
}

@test "cd_leaves_services prints the leaves of the colour in the order of the fixed list, and refuses a bad call" {
    printf 'matrix\nnewsletter-service\ncalendar-service\n' >"$DK/services"
    run --separate-stderr leaf 'cd_leaves_services "$TREE" green'
    [ "$status" -eq 0 ]
    [ "$output" = "$(printf 'calendar-service\nnewsletter-service')" ]
    run --separate-stderr leaf 'cd_leaves_services "$TREE"'
    [ "$status" -eq 2 ]
    run --separate-stderr leaf 'cd_leaves_services "$TREE" purple'
    [ "$status" -eq 2 ]
    run --separate-stderr leaf 'cd_leaves_services /nonexistent-tree green'
    [ "$status" -eq 2 ]
    printf 'gremion-ui\n' >"$DK/services"
    run --separate-stderr leaf 'cd_leaves_services "$TREE" green'
    [ "$status" -eq 0 ]
    [ -z "$output" ]
}

# compose_services FILE -- the names of the services of a compose file that end in -service.
compose_services() {
    awk '/^services:/{s=1;next} /^[a-z]/{s=0} s && /^  [a-z0-9-]+-service:[[:space:]]*$/{n=$1; sub(":","",n); print n}' "$1" | LC_ALL=C sort
}

# service_block FILE SERVICE -- the lines of one service of a compose file.
service_block() {
    awk -v want="$2" '/^services:/{s=1;next} /^[a-z]/{s=0} s && /^  [a-z0-9-]+:[[:space:]]*$/{n=$1; sub(":","",n); on=(n==want); next} on' "$1"
}

# leaf_drift FILE -- prints every difference between the fixed list of leaves.sh and the
# -service entries of the compose file FILE, minus the services that never run: a service in the
# file that is in neither list, and a service of the list that the file lacks.
leaf_drift() {
    local f="$1" fixed names n
    fixed="$(leaf 'printf "%s\n" "${_CD_LEAF_SERVICES[@]}"' | LC_ALL=C sort)"
    names="$(compose_services "$f")"
    for n in $names; do
        case " $NEVER_RUN_SERVICES " in *" $n "*) continue ;; esac
        grep -qxF -- "$n" <<<"$fixed" || echo "in the compose file, not in the list: $n"
    done
    for n in $fixed; do
        grep -qxF -- "$n" <<<"$names" || echo "in the list, not in the compose file: $n"
    done
}

@test "drift: the fixed list equals the leaf services of the compose file, and each leaf's database URL names its listed server" {
    local f="${REPO_ROOT}/docker-compose.app.yml" svc server drift
    [ -f "$f" ]
    drift="$(leaf_drift "$f")"
    [ -z "$drift" ] || { echo "$drift" >&2; return 1; }
    for svc in calendar-service content-service newsletter-service; do
        server="$(leaf 'printf "%s" "${_CD_LEAF_SERVER_OF[$1]}"' "$svc")"
        [ -n "$server" ]
        service_block "$f" "$svc" >"$BATS_TEST_TMPDIR/block"
        assert_present "@${server}:5432/" "$BATS_TEST_TMPDIR/block"
        assert_present "profiles: \[${svc%-service}\]" "$BATS_TEST_TMPDIR/block"
    done
}

@test "GUARD: the drift check turns red when a leaf is added to the compose file, or one of the three leaves is removed" {
    local f="${REPO_ROOT}/docker-compose.app.yml" scratch="$BATS_TEST_TMPDIR/compose.yml" drift
    # a leaf added
    awk '/^networks:/ && !done {print "  extra-service:\n    profiles: [extra]\n    image: example.org/extra\n"; done=1} {print}' "$f" >"$scratch"
    drift="$(leaf_drift "$scratch")"
    [[ "$drift" == *"in the compose file, not in the list: extra-service"* ]]
    # a leaf removed
    grep -v '^  calendar-service:' "$f" >"$scratch"
    drift="$(leaf_drift "$scratch")"
    [[ "$drift" == *"in the list, not in the compose file: calendar-service"* ]]
}

# ------------------------------------------------------------------------ the preconditions

@test "GUARD: one leaf database without a live ledger line of this release is code 2, and docker compose run is not called" {
    mk_dump "$TAG" calendar_control calendar_slugmarker content_control content_slugmarker newsletter_control
    step
    [ "$status" -eq 2 ]
    out_has 'reason=dump_missing'
    [ "$(calls run)" -eq 0 ]
    # the message counts, it names nothing
    refute_text slugmarker "$stderr"
}

@test "GUARD: the preconditions of every leaf are checked before the first container starts: a gap on the last server stops the first" {
    mk_dump "$TAG" calendar_control calendar_slugmarker content_control content_slugmarker
    step
    [ "$status" -eq 2 ]
    out_has 'reason=dump_missing'
    [ "$(calls run)" -eq 0 ]
}

@test "GUARD: the ledger and the server listing are read before the first run" {
    step
    [ "$status" -eq 0 ]
    local first_run first_dump first_exec
    first_run="$(grep -nxF 'run' "$DK/order.log" | head -n 1 | cut -d: -f1)"
    first_dump="$(grep -nxF 'dump' "$DK/order.log" | head -n 1 | cut -d: -f1)"
    first_exec="$(grep -nxF 'exec' "$DK/order.log" | tail -n 1 | cut -d: -f1)"
    [ -n "$first_run" ] && [ -n "$first_dump" ] && [ -n "$first_exec" ]
    [ "$first_dump" -lt "$first_run" ]
    [ "$first_exec" -lt "$first_run" ]
}

@test "a live line of another release does not count, and the ledger is asked for this release's label" {
    # (the program prints the lines of the label it was asked for; an answer of another label
    # is not an answer to the question, and no database of it is read as dumped)
    mk_dump "pilot-aaaaaaaaaaaa" calendar_control calendar_slugmarker content_control content_slugmarker newsletter_control newsletter_slugmarker
    step
    [ "$status" -eq 2 ]
    out_has 'reason=dump_status_unparsed'
    [ "$(calls run)" -eq 0 ]
    assert_present "^status\|--release\|${TAG}$" "$DK/dump.argv"
}

@test "a gate database on a leaf server needs no dump here: a blocked one is left undumped by design" {
    printf 'calendar_control\ncalendar_slugmarker\n%s\n' "$(gate 7 calendar)" >"$DK/dbs.c-cal"
    step
    [ "$status" -eq 0 ]
    [ "$(calls run)" -eq 3 ]
}

@test "the ledger that cannot be read, that is cut off or that has a line of an unknown shape is code 2" {
    echo 2 >"$DK/dump.rc"
    step
    [ "$status" -eq 2 ]
    out_has 'reason=dump_status_failed'
    [ "$(calls run)" -eq 0 ]
    rm "$DK/dump.rc"
    mk_dump "$TAG" calendar_control calendar_slugmarker content_control content_slugmarker newsletter_control newsletter_slugmarker
    sed -i 's/^STATUS: 6 /STATUS: 7 /' "$DK/dump.status"
    step
    [ "$status" -eq 2 ]
    out_has 'reason=dump_status_unparsed'
    [ "$(calls run)" -eq 0 ]
    mk_dump "$TAG" calendar_control calendar_slugmarker content_control content_slugmarker newsletter_control newsletter_slugmarker
    echo 'something else' >>"$DK/dump.status"
    step
    [ "$status" -eq 2 ]
    out_has 'reason=dump_status_unparsed'
    [ "$(calls run)" -eq 0 ]
    : >"${GREMION_ROOT}/bin/gremion-migration-dump"
    rm "${GREMION_ROOT}/bin/gremion-migration-dump"
    step
    [ "$status" -eq 2 ]
    out_has 'reason=dump_program'
}

@test "a leaf server that is not running, whose role is not in state.env or that answers an error is code 2 and nothing runs" {
    rm "$DK/cid.teststack-state.content-postgres"
    step
    [ "$status" -eq 2 ]
    out_has 'reason=leaf_server_down'
    [ "$(calls run)" -eq 0 ]
    echo c-con >"$DK/cid.teststack-state.content-postgres"
    sed -i '/^CONTENT_PG_USER=/d' "${GREMION_ROOT}/etc/env/state.env"
    step
    [ "$status" -eq 2 ]
    out_has 'reason=no_pg_user'
    [ "$(calls run)" -eq 0 ]
    cp "${FIX}/state.env" "${GREMION_ROOT}/etc/env/state.env"
    touch "$DK/dbs.c-nl.fail"
    step
    [ "$status" -eq 2 ]
    out_has 'reason=server_listing_failed'
    [ "$(calls run)" -eq 0 ]
}

@test "the shim enforces the role: a state.env that names the wrong role for a leaf server is refused, and the error text reaches no stream" {
    sed -i 's/^CALENDAR_PG_USER=.*/CALENDAR_PG_USER=somebody_else/' "${GREMION_ROOT}/etc/env/state.env"
    step
    [ "$status" -eq 2 ]
    out_has 'reason=server_listing_failed'
    [ "$(calls run)" -eq 0 ]
    refute_text slugmarker "$output"
    refute_text slugmarker "$stderr"
    refute_text password "$stderr"
}

@test "a leaf server that lists a database with an odd name is code 2" {
    printf 'calendar_control\nbad name;\n' >"$DK/dbs.c-cal"
    step
    [ "$status" -eq 2 ]
    out_has 'reason=server_listing_failed'
    [ "$(calls run)" -eq 0 ]
}

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

@test "the tenant secrets directory missing, wide open, unnamed by the env file or differing from the environment is code 2" {
    chmod 755 "${GREMION_ROOT}/etc/secrets/tenants"
    step
    [ "$status" -eq 2 ]
    out_has 'reason=secrets_dir'
    [ "$(calls run)" -eq 0 ]
    chmod 700 "${GREMION_ROOT}/etc/secrets/tenants"
    sed -i '/^TENANT_SECRETS_DIR=/d' "${GREMION_ROOT}/etc/env/app-green.env"
    step
    [ "$status" -eq 2 ]
    out_has 'reason=secrets_dir'
    [ "$(calls run)" -eq 0 ]
    printf 'TENANT_SECRETS_DIR=%s/etc/secrets/tenants\n' "$GREMION_ROOT" >>"${GREMION_ROOT}/etc/env/app-green.env"
    run --separate-stderr leaf 'export TENANT_SECRETS_DIR=/somewhere/else; cd_lock_take; rc=0; cd_leaves_migrate "$TREE" green "$TAG" || rc=$?; echo "reason=${CD_LEAVES_REASON}"; exit "$rc"'
    [ "$status" -eq 2 ]
    out_has 'reason=secrets_dir'
    [ "$(calls run)" -eq 0 ]
}

@test "a usage error, a missing release record or a release record of another tag or colour is code 2 and touches nothing" {
    run --separate-stderr leaf 'cd_lock_take; rc=0; cd_leaves_migrate "$TREE" green || rc=$?; exit "$rc"'
    [ "$status" -eq 2 ]
    run --separate-stderr leaf 'cd_lock_take; rc=0; cd_leaves_migrate "$TREE" purple "$TAG" || rc=$?; exit "$rc"'
    [ "$status" -eq 2 ]
    run --separate-stderr leaf 'cd_lock_take; rc=0; cd_leaves_migrate "$TREE" green not-a-tag || rc=$?; exit "$rc"'
    [ "$status" -eq 2 ]
    run --separate-stderr leaf 'cd_lock_take; rc=0; cd_leaves_migrate "$TREE" blue "$TAG" || rc=$?; echo "reason=${CD_LEAVES_REASON}"; exit "$rc"'
    [ "$status" -eq 2 ]
    out_has 'reason=release_mismatch'
    run --separate-stderr leaf 'cd_lock_take; rc=0; cd_leaves_migrate "$TREE" green pilot-cccccccccccc || rc=$?; echo "reason=${CD_LEAVES_REASON}"; exit "$rc"'
    [ "$status" -eq 2 ]
    out_has 'reason=release_mismatch'
    cd_seed_state '.release = null'
    step
    [ "$status" -eq 2 ]
    out_has 'reason=no_release'
    [ ! -e "$DK/argv.log" ]
}

# ------------------------------------------------------------------------ one container per service

@test "GUARD: exactly one compose run per leaf service, with the fixed argument list: no -f, no -p, no --profile, no database name" {
    step
    [ "$status" -eq 0 ]
    [ "$(wc -l <"$DK/run.log")" -eq 3 ]
    local svc envf
    envf="${GREMION_ROOT}/etc/env/app-green.env"
    for svc in calendar-service content-service newsletter-service; do
        assert_present "^compose\|--env-file\|${envf}\|run\|--rm\|--no-deps\|-T\|--label\|gremion\.cd=${RID}\|${svc}\|node\|dist/index\.js\|--migrate-only$" "$DK/run.log"
    done
    assert_absent '\|(-f|-p|--profile|--project-name|--file)(\||=|$)' "$DK/run.log"
    assert_absent 'slug|t_[0-9a-f]{32}|_control|calendar_|content_|newsletter_' "$DK/run.log"
    assert_absent 'slugmarker|t_[0-9a-f]{32}__|_control' "$DK/argv.log"
}

@test "GUARD: the number of containers does not depend on the number of customers: thirty customer databases still mean one run per service" {
    local i
    for i in $(seq 1 30); do
        printf 'calendar_slugmarker%s\n' "$i" >>"$DK/dbs.c-cal"
    done
    local dbs=(calendar_control calendar_slugmarker content_control content_slugmarker newsletter_control newsletter_slugmarker)
    for i in $(seq 1 30); do dbs+=("calendar_slugmarker${i}"); done
    mk_dump "$TAG" "${dbs[@]}"
    step
    [ "$status" -eq 0 ]
    [ "$(calls run)" -eq 3 ]
    [ "$(wc -l <"$DK/run.log")" -eq 3 ]
    assert_absent 'slugmarker' "$DK/run.log"
}

@test "the entry runs from the release tree with stdin from /dev/null, under the configured timeout, and with the compose variables of the caller unset" {
    cd_write_cfg CD_LEAF_MIGRATE_TIMEOUT_S=77
    run --separate-stderr leaf 'export COMPOSE_PROFILES=nonsense COMPOSE_PROJECT_NAME=other; cd_lock_take; rc=0; cd_leaves_migrate "$TREE" green "$TAG" || rc=$?; exit "$rc"'
    [ "$status" -eq 0 ]
    [ "$(grep -c . "$DK/run.stdin")" -eq 3 ]
    [ "$(grep -cx '/dev/null' "$DK/run.stdin")" -eq 3 ]
    assert_present "^${TREE}\$" "$DK/run.cwd"
    assert_present '^CD_DC_TIMEOUT=77$' "$DK/run.env"
    assert_absent 'COMPOSE_PROFILES=nonsense|COMPOSE_PROJECT_NAME=other' "$DK/run.env"
}

@test "the default timeout is 600 seconds per service" {
    step
    [ "$status" -eq 0 ]
    assert_present '^CD_DC_TIMEOUT=600$' "$DK/run.env"
}

@test "the services run in the order of the fixed list, one after the other" {
    step
    [ "$status" -eq 0 ]
    [ "$(grep '^run:' "$DK/order.log" | tr '\n' ' ')" = "run:calendar-service run:content-service run:newsletter-service " ]
}

@test "the counts of the three services are summed" {
    svc_out calendar-service '{"v":1,"total":3,"migrated":2,"skipped":1,"failed":0}'
    svc_out content-service '{"v":1,"total":1,"migrated":1,"skipped":0,"failed":0}'
    svc_out newsletter-service '{"v":1,"total":0,"migrated":0,"skipped":0,"failed":0}'
    step
    [ "$status" -eq 0 ]
    [ "$(state_leaves)" = '{"total":4,"migrated":3,"skipped":1,"failed":0}' ]
}

# ------------------------------------------------------------------------ the exit codes

@test "exit 0 with a valid line is code 0 and fills release.leaves" {
    step
    [ "$status" -eq 0 ]
    [ "$(state_leaves)" = '{"total":6,"migrated":3,"skipped":3,"failed":0}' ]
}

@test "exit 1 with a valid line is code 1 (a failure of the commit), reason leaf_migrate, the counts of the failure are recorded and no later service runs" {
    svc_out content-service '{"v":1,"total":2,"migrated":1,"skipped":0,"failed":1}'
    svc_rc content-service 1
    step
    [ "$status" -eq 1 ]
    out_has 'reason=leaf_migrate'
    [ "$(calls run)" -eq 2 ]
    refute_in_order_log '^run:newsletter-service$'
    [ "$(state_leaves)" = '{"total":4,"migrated":2,"skipped":1,"failed":1}' ]
}

@test "exit 3 is code 4 (an infrastructure retry, no block), and a valid line of it is kept" {
    svc_rc calendar-service 3
    step
    [ "$status" -eq 4 ]
    out_has 'reason=leaf_infra'
    [ "$(calls run)" -eq 1 ]
    [ "$(state_leaves)" = '{"total":2,"migrated":1,"skipped":1,"failed":0}' ]
    [ "$(jq -c '.hold' "${GREMION_ROOT}/data/cd/state.json")" = null ]
}

@test "exit 2 is code 2" {
    svc_rc calendar-service 2
    step
    [ "$status" -eq 2 ]
    out_has 'reason=leaf_usage'
    [ "$(calls run)" -eq 1 ]
}

@test "exit 1 without a valid line is code 4 (compose's own failure)" {
    : >"$DK/run.calendar-service.out"
    svc_rc calendar-service 1
    step
    [ "$status" -eq 4 ]
    out_has 'reason=leaf_run_failed'
    [ "$(calls run)" -eq 1 ]
}

@test "GUARD: exit 1 with a line of the right shape that does not add up (an entry that stopped at its first failing database) is still code 1: a failure of the commit, not a retry" {
    svc_out calendar-service '{"v":1,"total":9,"migrated":1,"skipped":0,"failed":1}'
    svc_rc calendar-service 1
    step
    [ "$status" -eq 1 ]
    out_has 'reason=leaf_migrate'
    [ "$(calls run)" -eq 1 ]
    [ "$(state_leaves)" = '{"total":9,"migrated":1,"skipped":0,"failed":1}' ]
}

@test "exit 1 with a line of the wrong shape (no version, a string count) is no valid line: code 4" {
    svc_out calendar-service '{"total":2,"migrated":1,"skipped":0,"failed":1}'
    svc_rc calendar-service 1
    step
    [ "$status" -eq 4 ]
    out_has 'reason=leaf_run_failed'
    seed_release
    svc_out calendar-service '{"v":1,"total":"2","migrated":1,"skipped":0,"failed":1}'
    step
    [ "$status" -eq 4 ]
}

@test "exit 0 with a missing line is code 1" {
    : >"$DK/run.calendar-service.out"
    step
    [ "$status" -eq 1 ]
    out_has 'reason=leaf_result_invalid'
    [ "$(calls run)" -eq 1 ]
}

@test "exit 0 with a line that does not add up, that counts a failure, that has another version or that is not the only line is code 1" {
    local bad
    for bad in \
        '{"v":1,"total":5,"migrated":1,"skipped":1,"failed":0}' \
        '{"v":1,"total":2,"migrated":1,"skipped":0,"failed":1}' \
        '{"v":2,"total":2,"migrated":1,"skipped":1,"failed":0}' \
        '{"total":2,"migrated":1,"skipped":1,"failed":0}' \
        '{"v":1,"total":2,"migrated":-1,"skipped":3,"failed":0}' \
        '{"v":1,"total":"2","migrated":1,"skipped":1,"failed":0}' \
        '{"v":1,"total":2.5,"migrated":1,"skipped":1.5,"failed":0}' \
        '[1,2]' \
        "$(printf '%s\n%s' "$JSON_OK" "$JSON_OK")"; do
        seed_release
        svc_out calendar-service "$bad"
        : >"$DK/order.log"
        step
        [ "$status" -eq 1 ] || { echo "not code 1 for: $bad" >&2; return 1; }
        out_has 'reason=leaf_result_invalid'
        [ "$(calls run)" -eq 1 ]
    done
}

@test "any other exit of compose (a missing image, a signal) is code 4" {
    svc_rc calendar-service 125
    step
    [ "$status" -eq 4 ]
    out_has 'reason=leaf_run_failed'
    seed_release
    svc_rc calendar-service 127
    step
    [ "$status" -eq 4 ]
}

@test "a leaf line printed among other lines of output is still found when it is the only one that starts with a brace" {
    printf 'booting\n%s\ndone\n' "$JSON_OK" >"$DK/run.calendar-service.out"
    step
    [ "$status" -eq 0 ]
}

# ------------------------------------------------------------------------ the policy

@test "policy always runs the step; policy migration skips it when no leaf chain gained a file, and touches nothing" {
    seed_release '.release.class = {migrations: {chains: {"module-calendar": {class: "module-upgrade", expand: 0, migrate: 0, contract: 0}, "module-finance": {class: "module-upgrade", expand: 4, migrate: 0, contract: 0}, "platform": {class: "tenant-store", expand: 2}}}}'
    step_with migration 600
    [ "$status" -eq 0 ]
    [ ! -e "$DK/argv.log" ]
    [ "$(state_leaves)" = null ]
}

@test "policy migration runs the step when a chain of a leaf gained a file" {
    local chain
    for chain in module-calendar module-content module-publishing; do
        seed_release ".release.class = {migrations: {chains: {\"${chain}\": {class: \"module-upgrade\", expand: 1}}}}"
        : >"$DK/order.log"
        step_with migration 600
        [ "$status" -eq 0 ]
        [ "$(calls run)" -eq 3 ] || { echo "no run for ${chain}" >&2; return 1; }
    done
}

@test "policy migration with no readable class is code 2 and never a skip; an unreadable policy is code 2" {
    step_with migration 600
    [ "$status" -eq 2 ]
    out_has 'reason=class_missing'
    [ "$(calls run)" -eq 0 ]
    step_with sometimes 600
    [ "$status" -eq 2 ]
    out_has 'reason=policy'
    [ "$(calls run)" -eq 0 ]
}

# ------------------------------------------------------------------------ the timeout

@test "GUARD: on a timeout the container outlives the killed client; it is killed and removed by its label and the step returns only when two polls of docker ps -a in a row are empty" {
    touch "$DK/run.calendar-service.hang" "$DK/run.calendar-service.creates"
    echo 2 >"$DK/sticky"
    step_with always 1
    [ "$status" -eq 2 ]
    out_has 'reason=leaf_timeout'
    # the labelled container is gone at the moment the step returned, and the order was run,
    # kill, rm, then the polls: at least the 2 sticky answers and 2 empty ones
    [ ! -s "$DK/ctr" ]
    local after
    after="$(sed -n '/^rm$/,$p' "$DK/order.log" | grep -c '^ps -a ')"
    [ "$after" -ge 4 ]
    [ "$(calls kill)" -ge 1 ]
    assert_present "^ps -a ${RID}$" "$DK/order.log"
    # no second run starts, and the code is not 124
    [ "$(calls run)" -eq 1 ]
}

@test "GUARD: an exited labelled container is found because the poll uses docker ps -a, not docker ps" {
    touch "$DK/run.calendar-service.hang" "$DK/run.calendar-service.exited"
    step_with always 1
    [ "$status" -eq 2 ]
    out_has 'reason=leaf_timeout'
    [ ! -s "$DK/ctr" ]
    refute_in_order_log '^ps [^-]'
}

@test "GUARD: a container that never disappears is code 2 with leaf_container_alive, a critical mail, no second run, and the locks stay held" {
    touch "$DK/run.calendar-service.hang" "$DK/run.calendar-service.creates" "$DK/rm.refuse"
    run --separate-stderr leaf "$(cfgfn always 1)"'
export CD_LEAVES_CONFIRM_S=3; cd_lock_take; cd_hostlock_take; rc=0; cd_leaves_migrate "$TREE" green "$TAG" || rc=$?; echo "reason=${CD_LEAVES_REASON}"
if ( exec 9>>"${GREMION_ROOT}/runtime/hostd.lock"; flock -n 9 ); then echo HOSTLOCK=free; else echo HOSTLOCK=held; fi
exit "$rc"'
    [ "$status" -eq 2 ]
    out_has 'reason=leaf_container_alive'
    out_has 'HOSTLOCK=held'
    [ -s "$DK/ctr" ]
    [ "$(calls run)" -eq 1 ]
    local mail
    mail="$(cat "${GREMION_ROOT}"/data/cd/outbox/*stopped*.eml 2>/dev/null || true)"
    [[ "$mail" == *leaf_container_alive* ]]
    refute_text slugmarker "$mail"
}

@test "GUARD: a container of an earlier try is removed before the next one starts, and when it cannot be no run starts" {
    echo "c-old running" >"$DK/ctr"
    step
    [ "$status" -eq 0 ]
    # the old container was reaped first: no run saw it
    refute_in_order_log '^run-saw-container$'
    seed_release
    echo "c-old running" >"$DK/ctr"
    : >"$DK/order.log"
    touch "$DK/rm.refuse"
    run --separate-stderr leaf 'export CD_LEAVES_CONFIRM_S=3; cd_lock_take; rc=0; cd_leaves_migrate "$TREE" green "$TAG" || rc=$?; echo "reason=${CD_LEAVES_REASON}"; exit "$rc"'
    [ "$status" -eq 2 ]
    out_has 'reason=leaf_container_alive'
    [ "$(calls run)" -eq 0 ]
}

@test "a container left behind by a run that ended on its own is removed before the next service starts" {
    touch "$DK/run.calendar-service.exited"
    step
    [ "$status" -eq 0 ]
    [ "$(calls run)" -eq 3 ]
    [ ! -s "$DK/ctr" ]
    [ "$(calls rm)" -ge 1 ]
}

@test "a labelled docker ps that does not answer is not read as an empty answer" {
    touch "$DK/ps.fail"
    run --separate-stderr leaf 'export CD_LEAVES_CONFIRM_S=3; cd_lock_take; rc=0; cd_leaves_migrate "$TREE" green "$TAG" || rc=$?; echo "reason=${CD_LEAVES_REASON}"; exit "$rc"'
    [ "$status" -eq 2 ]
    out_has 'reason=leaf_container_alive'
    [ "$(calls run)" -eq 0 ]
}

# ------------------------------------------------------------------------ what no stream may hold

@test "GUARD: the output of every entry goes to a 0600 file under logs/; a slug, a database name and the word password are found in no stream, state file, history or outbox" {
    local leak='boom calendar_slugmarker t_00000000000000000000000000000001__calendar password=hunter2'
    printf '%s\n%s\n' "$leak" "$JSON_OK" >"$DK/run.out"
    printf '%s\n' "$leak" >"$DK/run.err"
    svc_rc newsletter-service 1
    svc_out newsletter-service "$(printf '%s\n%s' "$leak" '{"v":1,"total":1,"migrated":0,"skipped":0,"failed":1}')"
    step
    [ "$status" -eq 1 ]
    local f seen=0 all
    for f in "${GREMION_ROOT}"/logs/cd-leaves-*; do
        [ -e "$f" ] || continue
        seen=$((seen + 1))
        [ "$(stat -c '%a' "$f")" = 600 ]
    done
    [ "$seen" -ge 3 ]
    # the leak fixture reached the files, so the check below looks at something that was there
    grep -q slugmarker "${GREMION_ROOT}"/logs/cd-leaves-out-calendar-*
    all="${output}${stderr}"
    all+="$(cat "${GREMION_ROOT}/data/cd/state.json" 2>/dev/null || true)"
    all+="$(cat "${GREMION_ROOT}/data/cd/history.jsonl" 2>/dev/null || true)"
    all+="$(cat "${GREMION_ROOT}"/data/cd/outbox/* 2>/dev/null || true)"
    all+="$(cat "$DK/argv.log" "$DK/run.log" 2>/dev/null || true)"
    refute_text slugmarker "$all"
    refute_text password "$all"
    refute_text hunter2 "$all"
    refute_text t_00000000 "$all"
}

@test "GUARD: a run that succeeds writes its history line, and neither that line, the state nor any stream holds what the entry printed" {
    local leak='boom calendar_slugmarker t_00000000000000000000000000000001__calendar password=hunter2'
    printf '%s\n%s\n' "$leak" "$JSON_OK" >"$DK/run.out"
    printf '%s\n' "$leak" >"$DK/run.err"
    step
    [ "$status" -eq 0 ]
    # the history line exists, so the absence below is read from something that was written
    assert_present 'leaves_done' "${GREMION_ROOT}/data/cd/history.jsonl"
    local all
    all="${output}${stderr}"
    all+="$(cat "${GREMION_ROOT}/data/cd/state.json")"
    all+="$(cat "${GREMION_ROOT}/data/cd/history.jsonl")"
    all+="$(cat "$DK/argv.log" "$DK/run.log")"
    refute_text slugmarker "$all"
    refute_text hunter2 "$all"
    refute_text t_00000000 "$all"
}

@test "GUARD: the container-alive path writes its history line and its mail, and neither holds what the entry printed" {
    local leak='boom calendar_slugmarker password=hunter2'
    printf '%s\n' "$leak" >"$DK/run.out"
    printf '%s\n' "$leak" >"$DK/run.err"
    touch "$DK/run.calendar-service.hang" "$DK/run.calendar-service.creates" "$DK/rm.refuse"
    step_with always 1
    [ "$status" -eq 2 ]
    out_has 'reason=leaf_container_alive'
    assert_present 'leaves_container_alive' "${GREMION_ROOT}/data/cd/history.jsonl"
    # the hung client printed the leak fixture before it hung, so the entry's log files hold it
    # and the absences below are read from streams that could have carried it
    grep -q slugmarker "${GREMION_ROOT}"/logs/cd-leaves-out-calendar-*
    grep -q slugmarker "${GREMION_ROOT}"/logs/cd-leaves-run-calendar-*
    local mails all
    mails="$(cat "${GREMION_ROOT}"/data/cd/outbox/*stopped*.eml)"
    [ -n "$mails" ]
    all="${output}${stderr}${mails}"
    all+="$(cat "${GREMION_ROOT}/data/cd/history.jsonl")"
    all+="$(cat "${GREMION_ROOT}/data/cd/state.json")"
    refute_text slugmarker "$all"
    refute_text hunter2 "$all"
}

@test "the journal line of a failure names the log file and nothing of its content" {
    printf 'calendar_slugmarker password=hunter2\n' >"$DK/run.calendar-service.err"
    : >"$DK/run.calendar-service.out"
    svc_rc calendar-service 1
    step
    [ "$status" -eq 4 ]
    err_has 'logs/cd-leaves-run-calendar-'
    refute_text slugmarker "$stderr"
    refute_text hunter2 "$stderr"
}

@test "a run that succeeds removes the log files that stayed empty and keeps the ones with content" {
    step
    [ "$status" -eq 0 ]
    local f
    for f in "${GREMION_ROOT}"/logs/cd-leaves-*; do
        [ ! -e "$f" ] || [ -s "$f" ]
    done
}
