#!/usr/bin/env bats
# test/host/cd-reconcile.bats -- cd-reconcile: infra/host/lib/cd/reconcile.sh, the reconcile stage
# of the continuous deployment program: the customer list and its fail-closed cross-checks, the
# canary and the probes, the host lock per customer, the timeout that kills by label, the call
# of the verb, the exit mapping, the bounds and the outcome.
#
# Run: MSYS_NO_PATHCONV=1 docker run --rm --user 1001 -v "$(pwd -W):/repo:ro" -w /repo gremion-bats:local test/host/cd-reconcile.bats
#
# Nothing here touches a real docker, psql, network or host: docker is one recording shim whose
# answers are files under $DK (it also plays psql, which the program reaches through
# `docker exec`), gremion-tenant is a shim in a fake release tree behind `current`, the probe, the
# timer guard and the kernel database listing are the stand-ins of the other units, the clock is
# the fake one. core.sh, docker.sh and notify.sh are the REAL libraries. Every customer name
# carries the marker word "slugmarker" so that a leak is found by grep; the secret-looking word the
# child prints is a low-entropy fixture, not a credential. The snippets run WITHOUT errexit, as a
# driver that calls a stage as `fn || rc=$?`.

bats_require_minimum_version 1.5.0
load 'test_helper/host'
load 'test_helper/cd'

FIX="${BATS_TEST_DIRNAME}/fixtures/cd/reconcile"
export TAG="pilot-aaaaaaaaaaaa"
SHA40="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
# What the verb gets as its reason, pinned by value.
REASON_WANT="Automatischer Abgleich nach dem Release pilot-aaaaaaaaaaaa (gremion-cd)"
ID1="11111111111111111111111111111111"
ID2="22222222222222222222222222222222"

# The docker shim body. State lives in $DK:
#   argv.log                every call, args joined with '|'
#   events.log              the calls that matter in order: child-start, child-end, reqps, kill
#   exec.log                container|role|database of every docker exec (psql)
#   sql.all  sql.<n>        the SQL texts that reached psql on stdin
#   q.log                   which query each exec was (list, status, ids, canary)
#   q.<name>                what that query answers; q.<name>.fail makes psql fail
#   cid.<proj>.<svc>        a running compose service container
#   reqps.log               <uuid>|lockrc=<n> of every `docker ps` by the request label (lockrc 1:
#                           the host lock was held at that moment, 0: it was free)
#   alive                   a labelled container that is running (the child's container); a `docker
#                           kill` removes it unless kill.refuse exists; ps.fail makes the label ps fail
docker_shim_body() {
    cat <<'SHIM_EOF'
(IFS='|'; printf '%s\n' "$*" >>"$DK/argv.log")
case "$1" in
  ps)
    lab=''; proj=''; svc=''
    for a in "$@"; do
      case "$a" in
        label=gremion.request=*) lab="${a#label=gremion.request=}" ;;
        label=com.docker.compose.project=*) proj="${a#label=com.docker.compose.project=}" ;;
        label=com.docker.compose.service=*) svc="${a#label=com.docker.compose.service=}" ;;
      esac
    done
    if [ -n "$lab" ]; then
      flock -n "$GREMION_ROOT/runtime/hostd.lock" true
      echo "$lab|lockrc=$?" >>"$DK/reqps.log"
      echo reqps >>"$DK/events.log"
      [ -f "$DK/ps.fail" ] && exit 1
      [ -f "$DK/alive" ] && cat "$DK/alive"
      exit 0
    fi
    [ -f "$DK/cid.$proj.$svc" ] && cat "$DK/cid.$proj.$svc"
    exit 0 ;;
  kill)
    echo "$*" >>"$DK/kill.log"
    echo kill >>"$DK/events.log"
    [ -f "$DK/kill.refuse" ] || rm -f "$DK/alive"
    exit 0 ;;
  rm)
    echo "rm $*" >>"$DK/rm.log"
    exit 0 ;;
  exec)
    n=$(( $(cat "$DK/sql.n" 2>/dev/null || echo 0) + 1 ))
    echo "$n" >"$DK/sql.n"
    sql="$(cat)"
    printf '%s\n' "$sql" >"$DK/sql.$n"
    printf '%s\n' "$sql" >>"$DK/sql.all"
    role=''; db=''; prev=''
    for a in "$@"; do
      case "$prev" in -U) role="$a" ;; -d) db="$a" ;; esac
      prev="$a"
    done
    printf '%s|%s|%s\n' "$3" "$role" "$db" >>"$DK/exec.log"
    if [ "$role" != pgsuper ] || [ "$db" != control ]; then
      echo "FATAL: wrong role or database (slugmarker, password)" >&2
      exit 2
    fi
    case "$sql" in
      *"group by status"*) q=status ;;
      *"replace(id::text"*) q=ids ;;
      *tenant_domain*) q=canary ;;
      *"status in ('active','suspended')"*) q=list ;;
      *) q=other ;;
    esac
    echo "$q" >>"$DK/q.log"
    if [ -f "$DK/q.$q.fail" ]; then
      echo "connection lost slugmarker password" >&2
      exit 2
    fi
    [ -f "$DK/q.$q" ] && cat "$DK/q.$q"
    exit 0 ;;
esac
exit 0
SHIM_EOF
}

# The verb: a shim in the release tree behind `current`. What it does per customer, from files in $DK:
#   child.<slug>.rc / child.rc   its exit code (0); child.<slug>.seq one exit code per call, first line first
#   child.<slug>.run             a snippet it sources (a side effect: the kill switch, a request, the clock)
#   outlive.<slug>               leaves a running labelled container behind
#   hang.<slug>                  hangs, so that `timeout` ends it
child_shim_body() {
    cat <<'SHIM_EOF'
#!/usr/bin/env bash
slug="${2:-}"
(IFS='|'; printf '%s\n' "$*" >>"$DK/child.argv")
echo child-start >>"$DK/events.log"
printf '%s|%s|%s|%s\n' "${GREMION_HOST_LOCK_HELD:-unset}" "${GREMION_EXECUTOR_REQUEST_ID:-unset}" "${GREMION_RELEASE_DIR-unset}" "${GREMION_ROOT:-unset}" >>"$DK/child.env"
readlink "/proc/$$/fd/0" >>"$DK/child.stdin" 2>/dev/null || echo unknown >>"$DK/child.stdin"
{ if [ -e "/proc/$$/fd/8" ]; then echo open8; fi; if [ -e "/proc/$$/fd/9" ]; then echo open9; fi; echo fdcheck; } >>"$DK/child.fds"
cat "/proc/$PPID/comm" >>"$DK/child.parent"
flock -n "$GREMION_ROOT/runtime/hostd.lock" true
echo "$?" >>"$DK/child.lock"
echo "reconciling $slug in realm-$slug, password handling"
echo "warning for $slug" >&2
if [ -f "$DK/child.$slug.run" ]; then . "$DK/child.$slug.run"; fi
if [ -f "$DK/outlive.$slug" ]; then echo "c-$slug" >"$DK/alive"; fi
if [ -f "$DK/hang.$slug" ]; then exec sleep 30; fi
echo child-end >>"$DK/events.log"
if [ -s "$DK/child.$slug.seq" ]; then
  rc="$(head -n 1 "$DK/child.$slug.seq")"
  sed -i 1d "$DK/child.$slug.seq"
  exit "$rc"
fi
exit "$(cat "$DK/child.$slug.rc" 2>/dev/null || cat "$DK/child.rc" 2>/dev/null || echo 0)"
SHIM_EOF
}

# The stand-ins of the other units that a test steers with a sequence file (one answer per call,
# default 0): the public probe, the timer guard; and the kernel database listing.
ovr_body() {
    cat <<'OVR_EOF'
_seq_next() {
    local f="$DK/seq.$1" rc=0
    if [ -s "$f" ]; then
        rc="$(head -n 1 "$f")"
        sed -i 1d "$f"
    fi
    return "$rc"
}
cd_watch_probe_public() {
    local lr=0
    printf 'stub cd_watch_probe_public\n' >>"$SHIM_LOG"
    flock -n "$GREMION_ROOT/runtime/hostd.lock" true || lr=$?
    echo "lockrc=$lr" >>"$DK/probe.lock"
    cat "$GREMION_CD_NOW_FILE" >>"$DK/probe.at"
    echo probe >>"$DK/events.log"
    _seq_next cd_watch_probe_public
}
cd_data_timer_guard() {
    printf 'stub cd_data_timer_guard %s\n' "$*" >>"$SHIM_LOG"
    _seq_next cd_data_timer_guard
}
cd_data_kernel_db_ids() {
    local -n _o="$1"
    local l
    _o=()
    printf 'stub cd_data_kernel_db_ids %s\n' "$1" >>"$SHIM_LOG"
    if [ -f "$DK/kernel.fail" ]; then return 4; fi
    if [ -f "$DK/kernel.ids" ]; then
        while IFS= read -r l; do
            if [ -n "$l" ]; then _o+=("$l"); fi
        done <"$DK/kernel.ids"
    fi
    return 0
}
OVR_EOF
}

setup() {
    cd_setup
    export STACK=teststack TZ=UTC
    DK="${SHIM_DIR}/dk"
    export DK
    mkdir -p "$DK"
    cp "${FIX}/state.env" "${GREMION_ROOT}/etc/env/state.env"
    TREE="${GREMION_ROOT}/releases/aaaaaaaaaaaa"
    export TREE
    mkdir -p "${TREE}/infra/host/bin"
    child_shim_body >"${TREE}/infra/host/bin/gremion-tenant"
    chmod +x "${TREE}/infra/host/bin/gremion-tenant"
    ln -s "$TREE" "${GREMION_ROOT}/current"
    printf 'blue\n' >"${GREMION_ROOT}/runtime/active-colour"
    # the installed copy must never be the one that runs (F17)
    printf '#!/usr/bin/env bash\necho decoy >>"$DK/decoy.log"\nexit 0\n' >"${GREMION_ROOT}/bin/gremion-tenant"
    chmod +x "${GREMION_ROOT}/bin/gremion-tenant"
    OVR="${GREMION_ROOT}/.ovr.sh"
    export OVR
    ovr_body >"$OVR"
    shim docker "$(docker_shim_body)"
    shim logger
    echo c-pg >"$DK/cid.teststack-state.postgres"
    # three customers, listed out of order and with a customer that is not the canary
    printf 'slugmarker-c\nslugmarker-a\nslugmarker-b\n' >"$DK/q.list"
    cfg
    seed
}

teardown() {
    cd_teardown
}

# seed [JQ] -- an idle host whose live release is aaaaaaaaaaaa on blue (no release in flight).
seed() {
    local extra="${1:-.}" live
    live="$(jq -n --arg t "$TREE" --arg sha "$SHA40" '{sha:$sha, sha12:"aaaaaaaaaaaa", tag:"pilot-aaaaaaaaaaaa", colour:"blue", tree:$t, since:"2026-11-01T00:00:00Z", proof:false, modules:null, leaves:null, reconcile:null}')"
    cd_seed_state ".live = ${live} | ${extra}"
}

# seed_release -- the committed release in stage reconcile, as the pipeline calls the stage.
seed_release() {
    local rel
    rel="$(jq -n --arg t "$TREE" --arg sha "$SHA40" '{id:"aaaaaaaaaaaa-1", sha:$sha, sha12:"aaaaaaaaaaaa", tag:"pilot-aaaaaaaaaaaa", colour:"blue", tree:$t, mode:"auto", stage:"reconcile", stage_status:"started", switch_started:true, committed_at:"2026-11-17T01:00:00Z", class:null, modules:null, leaves:null}')"
    seed ".phase = \"releasing\" | .release = ${rel}"
}

rec() {
    local snippet="$1"
    shift
    bash -c "set -uo pipefail
. \"\${HOST_SRC}/lib/common.sh\"
. \"\${HOST_SRC}/lib/cd/core.sh\"
. \"\${HOST_SRC}/lib/cd/docker.sh\"
. \"\${HOST_SRC}/lib/cd/notify.sh\"
. \"\${HOST_SRC}/lib/cd/reconcile.sh\"
. \"\${GREMION_CD_STUBS_DIR}/cd-stubs.sh\"
. \"\${OVR}\"
cd_cfg_load || exit 99
${snippet}" rec "$@"
}

# stage -- the stage as a driver calls it: the cd lock taken, the code printed last.
stage() {
    run --separate-stderr rec 'cd_lock_take; rc=0; cd_reconcile_run || rc=$?; echo "rc=${rc}"; exit "$rc"'
}

# stage_then SNIPPET -- the stage, then a snippet that looks at the locks of the same process.
stage_then() {
    run --separate-stderr rec "cd_lock_take; rc=0; cd_reconcile_run || rc=\$?; echo \"rc=\${rc}\"; $1; exit \"\$rc\""
}

# cfg [KEY=VAL ...] -- etc/cd.env: the valid base, no post-reconcile window unless a test asks for one.
cfg() { cd_write_cfg CD_POST_RECONCILE_S=0 "$@"; }

# journal_lines -- what the program said to the journal (the logger shim records its calls).
journal_lines() { grep -E '^logger ' "$SHIM_LOG" || true; }

STATE="data/cd/state.json"
jqs() { jq -c "$1" "${GREMION_ROOT}/${STATE}"; }
counts() { jqs '.live.reconcile | del(.at)'; }
hold_kind() { jq -r '.hold.kind // "none"' "${GREMION_ROOT}/${STATE}"; }
hold_reason() { jq -r '.hold.reason // "none"' "${GREMION_ROOT}/${STATE}"; }
rec_reason() { jq -r '.live.reconcile.reason // "null"' "${GREMION_ROOT}/${STATE}"; }

# seq_rc NAME RC... -- the answers of a stand-in, one per call.
seq_rc() {
    local name="$1"
    shift
    printf '%s\n' "$@" >"$DK/seq.$name"
}

# child_rc SLUG RC / child_run SLUG 'snippet' / child_seq SLUG RC...
child_rc() { printf '%s\n' "$2" >"$DK/child.$1.rc"; }
child_run() { printf '%s\n' "$2" >"$DK/child.$1.run"; }
child_seq() {
    local s="$1"
    shift
    printf '%s\n' "$@" >"$DK/child.$s.seq"
}

# order_of -- the slugs the verb was called for, in the order of the calls.
order_of() { awk -F'|' '{ print $2 }' "$DK/child.argv" | paste -sd' ' -; }

only() { printf '%s\n' "$@" >"$DK/q.list"; }
file_lines() { if [ -f "$1" ]; then wc -l <"$1"; else echo 0; fi; }

calls_of() {
    if [ -f "$SHIM_LOG" ]; then grep -c -- "$1" "$SHIM_LOG" || true; else echo 0; fi
}

refute_text() {
    case "$2" in
        *"$1"*)
            echo "unexpected text: $1" >&2
            return 1
            ;;
    esac
    return 0
}

out_has() {
    grep -qE -- "$1" <<<"$output" && return 0
    echo "out_has: /$1/ not in the output:" >&2
    printf '%s\n' "$output" >&2
    return 1
}

# fingerprint -- everything that must not move in this stage: the `current` link, the active
# colour, the env files, the live release (but for live.reconcile), the release record and the
# block list.
fingerprint() {
    (
        cd "$GREMION_ROOT" || exit 1
        readlink current
        cat runtime/active-colour
        sha256sum etc/env/*.env
        jq -S -c '.live | del(.reconcile)' "$STATE"
        jq -S -c '.release' "$STATE"
        if [ -f data/cd/blocked.json ]; then sha256sum data/cd/blocked.json; else echo noblocks; fi
    )
}

# ------------------------------------------------------------------------ the happy path

@test "every customer is reconciled once, in sorted order, and the stage ends ok with no hold" {
    stage
    [ "$status" -eq 0 ]
    [ "$output" = "rc=0" ]
    [ "$(order_of)" = "slugmarker-a slugmarker-b slugmarker-c" ]
    [ "$(counts)" = '{"total":3,"ok":3,"failed":0,"timeout":0,"busy":0,"skipped":0,"invalid":0,"seconds":0,"reason":null}' ]
    [ "$(hold_kind)" = none ]
}

# ------------------------------------------------------------------------ the customer list

@test "the customer list asks the control database for active and suspended customers only, sorted, on psql's stdin" {
    stage
    [ "$status" -eq 0 ]
    grep -qxF "select slug from tenant where status in ('active','suspended') order by slug;" "$DK/sql.all"
    # the state project's postgres, the state role and the control database
    grep -qxF 'c-pg|pgsuper|control' "$DK/exec.log"
    # no query text and no customer on an argv of CD's own commands
    refute_text "tenant" "$(cat "$DK/argv.log")"
    refute_text "slugmarker" "$(cat "$DK/argv.log")"
}

@test "a failing psql is code 2 with the reason unknown, and no child is run (fail closed)" {
    : >"$DK/q.list.fail"
    run --separate-stderr rec 'arr=(); rc=0; cd_reconcile_customers arr || rc=$?; echo "rc=${rc} reason=${CD_RECONCILE_REASON} n=${#arr[@]}"'
    [ "$output" = "rc=2 reason=unknown n=0" ]
    stage
    [ "$status" -eq 1 ]
    [ "$(hold_kind)" = reconcile_failed ]
    [ "$(hold_reason)" = unknown ]
    [ "$(rec_reason)" = unknown ]
    [ "$(file_lines "$DK/child.argv")" -eq 0 ]
    [ "$(jqs '.live.reconcile.total')" = 0 ]
}

@test "a row that breaks the slug rule is counted invalid and skipped, the valid ones still run" {
    only slugmarker-a Bad_Slug ab platform slugmarker-b "a--b" "$(printf 'x%.0s' $(seq 1 31))"
    stage
    [ "$status" -eq 1 ]
    [ "$(order_of)" = "slugmarker-a slugmarker-b" ]
    [ "$(counts)" = '{"total":7,"ok":2,"failed":0,"timeout":0,"busy":0,"skipped":0,"invalid":5,"seconds":0,"reason":"failed"}' ]
    [ "$(hold_kind)" = reconcile_failed ]
}

@test "a zero-row listing on a fresh install is accepted: no live status, every kernel database has a deleted row, total 0" {
    only
    printf 'deleted|1\ndeleting|1\n' >"$DK/q.status"
    printf '%s|deleted\n%s|deleting\n' "$ID1" "$ID2" >"$DK/q.ids"
    printf '%s\n%s\n' "$ID1" "$ID2" >"$DK/kernel.ids"
    stage
    [ "$status" -eq 0 ]
    [ "$(counts)" = '{"total":0,"ok":0,"failed":0,"timeout":0,"busy":0,"skipped":0,"invalid":0,"seconds":0,"reason":null}' ]
    [ "$(file_lines "$DK/child.argv")" -eq 0 ]
    [ "$(hold_kind)" = none ]
}

@test "zero rows with no kernel database and no registry row ends ok with total 0" {
    only
    stage
    [ "$status" -eq 0 ]
    [ "$(jqs '.live.reconcile.total')" = 0 ]
    [ "$(hold_kind)" = none ]
    [ "$(file_lines "$DK/child.argv")" -eq 0 ]
}

@test "zero rows while the status count shows an active row is unknown, not an empty fleet" {
    only
    printf 'active|2\n' >"$DK/q.status"
    stage
    [ "$status" -eq 1 ]
    [ "$(hold_reason)" = unknown ]
    [ "$(file_lines "$DK/child.argv")" -eq 0 ]
}

@test "zero rows while a kernel database has an active registry row (a wrong status literal) is unknown" {
    only
    printf 'deleted|1\n' >"$DK/q.status"
    printf '%s|active\n' "$ID1" >"$DK/q.ids"
    printf '%s\n' "$ID1" >"$DK/kernel.ids"
    stage
    [ "$status" -eq 1 ]
    [ "$(hold_reason)" = unknown ]
    [ "$(file_lines "$DK/child.argv")" -eq 0 ]
}

@test "zero rows with a status outside the five is unknown" {
    only
    printf 'archived|1\ndeleted|1\n' >"$DK/q.status"
    stage
    [ "$status" -eq 1 ]
    [ "$(hold_reason)" = unknown ]
    [ "$(file_lines "$DK/child.argv")" -eq 0 ]
}

@test "zero rows while a kernel database has no registry row at all is unknown" {
    only
    printf 'deleted|1\n' >"$DK/q.status"
    printf '%s|deleted\n' "$ID1" >"$DK/q.ids"
    printf '%s\n%s\n' "$ID1" "$ID2" >"$DK/kernel.ids"
    stage
    [ "$status" -eq 1 ]
    [ "$(hold_reason)" = unknown ]
    [ "$(file_lines "$DK/child.argv")" -eq 0 ]
}

@test "zero rows while the kernel databases cannot be listed is unknown" {
    only
    : >"$DK/kernel.fail"
    stage
    [ "$status" -eq 1 ]
    [ "$(hold_reason)" = unknown ]
    [ "$(file_lines "$DK/child.argv")" -eq 0 ]
}

# ------------------------------------------------------------------------ canary and probe

@test "the canary is the customer that owns the probe host, it goes first and the host reaches psql on stdin and on no argv" {
    echo slugmarker-b >"$DK/q.canary"
    stage
    [ "$status" -eq 0 ]
    [ "$(order_of)" = "slugmarker-b slugmarker-a slugmarker-c" ]
    grep -qF "select t.slug from tenant t join tenant_domain d on d.tenant_id = t.id where d.host = 'app.example.org' and t.status = 'active';" "$DK/sql.all"
    refute_text "app.example.org" "$(cat "$DK/argv.log")"
}

@test "a probe host that maps to no active customer gives no canary: the sorted order, and the history says so" {
    : >"$DK/q.canary"
    stage
    [ "$status" -eq 0 ]
    [ "$(order_of)" = "slugmarker-a slugmarker-b slugmarker-c" ]
    grep -qF '"event":"reconcile_no_canary"' "${GREMION_ROOT}/data/cd/history.jsonl"
}

@test "a canary question that cannot be asked is unknown and no child runs" {
    : >"$DK/q.canary.fail"
    stage
    [ "$status" -eq 1 ]
    [ "$(hold_reason)" = unknown ]
    [ "$(file_lines "$DK/child.argv")" -eq 0 ]
}

@test "the probe runs after every customer and nothing but good answers lets the stage end ok" {
    cfg CD_POST_RECONCILE_S=120
    seed_release
    stage
    [ "$status" -eq 0 ]
    # three customers, and the default post window of 120 s is 8 samples 15 s apart
    [ "$(calls_of 'stub cd_watch_probe_public')" -eq 11 ]
}

@test "two bad answers 5 seconds apart after the canary stop the stage with reason canary, the rest skipped, the release still committed" {
    echo slugmarker-b >"$DK/q.canary"
    seed_release
    seq_rc cd_watch_probe_public 1 1
    local before
    before="$(fingerprint)"
    stage
    [ "$status" -eq 1 ]
    [ "$(order_of)" = "slugmarker-b" ]
    [ "$(counts)" = '{"total":3,"ok":1,"failed":0,"timeout":0,"busy":0,"skipped":2,"invalid":0,"seconds":5,"reason":"canary"}' ]
    [ "$(hold_kind)" = reconcile_failed ]
    [ "$(hold_reason)" = canary ]
    # the two answers are 5 seconds apart on the fake clock
    [ "$(( $(sed -n 2p "$DK/probe.at") - $(sed -n 1p "$DK/probe.at") ))" -eq 5 ]
    # the release stays committed: nothing rolled back, nothing moved, the mail names the way back
    [ "$(calls_of 'stub cd_rollback_run')" -eq 0 ]
    [ "$(fingerprint)" = "$before" ]
    grep -qxF 'command: gremion-cd rollback' "${GREMION_ROOT}"/data/cd/outbox/*.eml
}

@test "two bad answers after a later customer stop the stage with reason probe" {
    echo slugmarker-b >"$DK/q.canary"
    seq_rc cd_watch_probe_public 0 1 1
    stage
    [ "$status" -eq 1 ]
    [ "$(order_of)" = "slugmarker-b slugmarker-a" ]
    [ "$(counts)" = '{"total":3,"ok":2,"failed":0,"timeout":0,"busy":0,"skipped":1,"invalid":0,"seconds":5,"reason":"probe"}' ]
    [ "$(calls_of 'stub cd_rollback_run')" -eq 0 ]
    grep -qxF 'command: gremion-cd rollback' "${GREMION_ROOT}"/data/cd/outbox/*.eml
}

@test "one bad answer that the second asking clears does not stop the stage" {
    seq_rc cd_watch_probe_public 1 0
    stage
    [ "$status" -eq 0 ]
    [ "$(order_of)" = "slugmarker-a slugmarker-b slugmarker-c" ]
}

@test "after the last customer the probe runs every 15 seconds for CD_POST_RECONCILE_S, and three bad samples in a row give probe" {
    cfg CD_POST_RECONCILE_S=45
    only slugmarker-a
    # the sample after the customer is good, then three bad ones
    seq_rc cd_watch_probe_public 0 1 1 1
    stage
    [ "$status" -eq 1 ]
    [ "$(rec_reason)" = probe ]
    [ "$(hold_reason)" = probe ]
    [ "$(counts | jq -r .ok)" = 1 ]
    [ "$(file_lines "$DK/probe.at")" -eq 4 ]
    [ "$(( $(sed -n 3p "$DK/probe.at") - $(sed -n 2p "$DK/probe.at") ))" -eq 15 ]
    [ "$(calls_of 'stub cd_rollback_run')" -eq 0 ]
    grep -qxF 'command: gremion-cd rollback' "${GREMION_ROOT}"/data/cd/outbox/*.eml
}

@test "two bad samples and a good one in the post window are not three in a row" {
    cfg CD_POST_RECONCILE_S=60
    only slugmarker-a
    seq_rc cd_watch_probe_public 0 1 1 0 1
    stage
    [ "$status" -eq 0 ]
    [ "$(file_lines "$DK/probe.at")" -eq 5 ]
    [ "$(hold_kind)" = none ]
}

# ------------------------------------------------------------------------ the locks

@test "the host lock is taken before each child and freed between two customers: a competing take is refused during a child and succeeds in between" {
    stage
    [ "$status" -eq 0 ]
    # during every child the host lock was held (flock -n failed: 1)
    [ "$(sort -u "$DK/child.lock")" = 1 ]
    [ "$(file_lines "$DK/child.lock")" -eq 3 ]
    # at every probe, between two children, it was free
    [ "$(sort -u "$DK/probe.lock" | head -n 1)" = "lockrc=0" ]
    [ "$(grep -vc 'lockrc=0' "$DK/probe.lock" || true)" -eq 0 ]
    # and after the stage it is free
    run flock -n "${GREMION_ROOT}/runtime/hostd.lock" true
    [ "$status" -eq 0 ]
}

@test "the host lock is held through the confirmation that the container is gone, and the call exports that it holds it" {
    stage
    [ "$status" -eq 0 ]
    [ "$(file_lines "$DK/reqps.log")" -ge 6 ]
    [ "$(cut -d'|' -f2 "$DK/reqps.log" | sort -u)" = "lockrc=1" ]
    [ "$(cut -d'|' -f1 "$DK/child.env" | sort -u)" = 1 ]
}

@test "the cd lock is held for the whole stage and is still held when it returns" {
    stage_then 'flock -n "${GREMION_ROOT}/runtime/cd/cd.lock" true; echo "cdlock=$?"'
    [ "$status" -eq 0 ]
    out_has '^cdlock=1$'
}

@test "the stage refuses to run without the cd lock" {
    run --separate-stderr rec 'rc=0; cd_reconcile_run || rc=$?; echo "rc=${rc}"'
    [ "$output" = "rc=2" ]
    [ "$(file_lines "$DK/child.argv")" -eq 0 ]
}

@test "a host lock that stays taken is retried once and then counts the customer busy, the next customers wait the same" {
    hold_host_lock 30
    cfg CD_RECONCILE_LOCK_WAIT_S=1
    only slugmarker-a
    stage
    [ "$status" -eq 1 ]
    [ "$(file_lines "$DK/child.argv")" -eq 0 ]
    [ "$(counts)" = '{"total":1,"ok":0,"failed":0,"timeout":0,"busy":1,"skipped":0,"invalid":0,"seconds":0,"reason":"busy"}' ]
    [ "$(hold_reason)" = busy ]
    release_host_lock
}

# ------------------------------------------------------------------------ timeout and container (F50)

@test "after exit 124 the stage kills the containers of that request, polls until two empty answers, and only then frees the host lock" {
    cfg CD_RECONCILE_TIMEOUT_S=1
    only slugmarker-a slugmarker-b
    : >"$DK/outlive.slugmarker-a"
    : >"$DK/hang.slugmarker-a"
    stage
    [ "$status" -eq 1 ]
    [ "$(counts)" = '{"total":2,"ok":1,"failed":0,"timeout":1,"busy":0,"skipped":0,"invalid":0,"seconds":0,"reason":"timeout"}' ]
    # the kill, by the container the child left, after the label ps found it
    [ "$(file_lines "$DK/kill.log")" -eq 1 ]
    grep -qxF 'kill c-slugmarker-a' "$DK/kill.log"
    # the polls carry the request id of THAT child, and the host lock was held at every one
    local uuid
    uuid="$(cut -d'|' -f2 "$DK/child.env" | head -n 1)"
    [ "$(cut -d'|' -f1 "$DK/reqps.log" | head -n 1)" = "$uuid" ]
    [ "$(cut -d'|' -f2 "$DK/reqps.log" | sort -u)" = "lockrc=1" ]
    # after the kill, two empty polls come before the next customer's call
    local after
    after="$(awk '/^kill$/ {k=1; next} k && /^reqps$/ {n++} k && /^child-start$/ {print n; exit}' "$DK/events.log")"
    [ "$after" -ge 2 ]
}

@test "a container that never disappears ends the stage with reason container_alive, the rest skipped, a critical journal line, and the host lock still held" {
    only slugmarker-a slugmarker-b slugmarker-c
    : >"$DK/outlive.slugmarker-a"
    : >"$DK/kill.refuse"
    stage_then 'flock -n "${GREMION_ROOT}/runtime/hostd.lock" true; echo "hostlock=$?"'
    [ "$status" -eq 1 ]
    out_has '^hostlock=1$'
    [ "$(order_of)" = "slugmarker-a" ]
    [ "$(counts)" = '{"total":3,"ok":0,"failed":1,"timeout":0,"busy":0,"skipped":2,"invalid":0,"seconds":0,"reason":"container_alive"}' ]
    [ "$(hold_kind)" = reconcile_failed ]
    [ "$(hold_reason)" = container_alive ]
    [ ! -e "${GREMION_ROOT}/data/cd/ALERT" ]
    grep -q "could not be confirmed gone" "$SHIM_LOG"
    grep -q 'kind: reconcile_failed' "${GREMION_ROOT}"/data/cd/outbox/*.eml
    grep -qxF 'reason: container_alive' "${GREMION_ROOT}"/data/cd/outbox/*.eml
}

@test "a label ps that cannot be answered is no empty answer: the container counts as alive" {
    only slugmarker-a
    : >"$DK/ps.fail"
    stage
    [ "$status" -eq 1 ]
    [ "$(rec_reason)" = container_alive ]
}

# ------------------------------------------------------------------------ the call

@test "the call: argv is exactly reconcile SLUG --apply --reason CONSTANT, the program is the one in current, stdin is /dev/null, it runs under timeout" {
    only slugmarker-a
    stage
    [ "$status" -eq 0 ]
    [ "$(wc -l <"$DK/child.argv")" -eq 1 ]
    [ "$(cat "$DK/child.argv")" = "reconcile|slugmarker-a|--apply|--reason|${REASON_WANT}" ]
    # the installed copy never ran
    [ "$(file_lines "$DK/decoy.log")" -eq 0 ]
    [ "$(cat "$DK/child.stdin")" = /dev/null ]
    [ "$(cat "$DK/child.parent")" = timeout ]
    # neither lock descriptor reaches the child
    [ "$(cat "$DK/child.fds")" = fdcheck ]
}

@test "the call: the environment carries the host lock flag and a fresh lower-case request id per child, and no release directory" {
    stage
    [ "$status" -eq 0 ]
    local line uuid
    while IFS='|' read -r held uuid reldir root; do
        [ "$held" = 1 ]
        [[ "$uuid" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]
        [ "$reldir" = unset ]
        [ "$root" = "$GREMION_ROOT" ]
    done <"$DK/child.env"
    [ "$(cut -d'|' -f2 "$DK/child.env" | sort -u | wc -l)" -eq 3 ]
}

@test "the call: GREMION_RELEASE_DIR of CD's own environment never reaches the child" {
    export GREMION_RELEASE_DIR=/somewhere/else
    stage
    [ "$status" -eq 0 ]
    [ "$(cut -d'|' -f3 "$DK/child.env" | sort -u)" = unset ]
}

@test "the reason is one constant of 10 to 500 characters with the tag and no slug, pinned by value" {
    only slugmarker-a
    stage
    [ "$status" -eq 0 ]
    local r
    r="$(awk -F'|' '{ print $5 }' "$DK/child.argv")"
    [ "$r" = "$REASON_WANT" ]
    [ "${#r}" -ge 10 ]
    [ "${#r}" -le 500 ]
    [[ "$r" == *"$TAG"* ]]
    refute_text "slugmarker" "$r"
    run --separate-stderr rec 'printf "%s" "$CD_RECONCILE_REASON_FMT"'
    [ "$output" = 'Automatischer Abgleich nach dem Release %s (gremion-cd)' ]
}

# ------------------------------------------------------------------------ the output

@test "the child's output goes to one 0600 file under logs/ and nothing reaches stdout or stderr" {
    only slugmarker-a slugmarker-b
    stage
    [ "$status" -eq 0 ]
    [ "$output" = "rc=0" ]
    [ -z "$stderr" ]
    local n f
    n="$(find "${GREMION_ROOT}/logs" -name 'cd-reconcile-*.log' | wc -l)"
    [ "$n" -eq 1 ]
    f="$(find "${GREMION_ROOT}/logs" -name 'cd-reconcile-*.log')"
    [ "$(stat -c '%a' "$f")" = 600 ]
    grep -q 'slugmarker-a' "$f"
    grep -q 'slugmarker-b' "$f"
}

@test "a child that prints a slug, a realm name and the word password leaves none of them in the state, history, outbox, stdout or stderr" {
    stage
    [ "$status" -eq 0 ]
    local w
    for w in slugmarker realm- password; do
        refute_text "$w" "$output"
        refute_text "$w" "$stderr"
        refute_text "$w" "$(cat "${GREMION_ROOT}/${STATE}")"
        refute_text "$w" "$(cat "${GREMION_ROOT}/data/cd/history.jsonl")"
        refute_text "$w" "$(cat "${GREMION_ROOT}"/data/cd/outbox/*.eml 2>/dev/null)"
        refute_text "$w" "$(journal_lines)"
    done
    # a failing run leaks nothing either
    child_rc slugmarker-b 1
    stage
    [ "$status" -eq 1 ]
    for w in slugmarker realm- password; do
        refute_text "$w" "$output"
        refute_text "$w" "$stderr"
        refute_text "$w" "$(cat "${GREMION_ROOT}/${STATE}")"
        refute_text "$w" "$(cat "${GREMION_ROOT}/data/cd/history.jsonl")"
        refute_text "$w" "$(cat "${GREMION_ROOT}"/data/cd/outbox/*.eml 2>/dev/null)"
        refute_text "$w" "$(journal_lines)"
    done
}

@test "a failing psql keeps what psql said out of stdout, stderr, state, history and outbox" {
    : >"$DK/q.list.fail"
    stage
    [ "$status" -eq 1 ]
    local w
    for w in slugmarker password; do
        refute_text "$w" "$output"
        refute_text "$w" "$stderr"
        refute_text "$w" "$(cat "${GREMION_ROOT}/${STATE}")"
        refute_text "$w" "$(cat "${GREMION_ROOT}/data/cd/history.jsonl")"
        refute_text "$w" "$(cat "${GREMION_ROOT}"/data/cd/outbox/*.eml 2>/dev/null)"
        refute_text "$w" "$(journal_lines)"
    done
}

# ------------------------------------------------------------------------ exit mapping

@test "exit 0 of the verb is ok" {
    only slugmarker-a
    child_rc slugmarker-a 0
    stage
    [ "$status" -eq 0 ]
    [ "$(jqs '.live.reconcile.ok')" = 1 ]
}

@test "exit 1 of the verb is failed" {
    only slugmarker-a
    child_rc slugmarker-a 1
    stage
    [ "$status" -eq 1 ]
    [ "$(counts)" = '{"total":1,"ok":0,"failed":1,"timeout":0,"busy":0,"skipped":0,"invalid":0,"seconds":0,"reason":"failed"}' ]
    [ "$(hold_reason)" = failed ]
}

@test "exit 2 of the verb stops the stage and counts the rest skipped with reason precondition" {
    child_rc slugmarker-a 2
    stage
    [ "$status" -eq 1 ]
    [ "$(order_of)" = "slugmarker-a" ]
    [ "$(counts)" = '{"total":3,"ok":0,"failed":1,"timeout":0,"busy":0,"skipped":2,"invalid":0,"seconds":0,"reason":"precondition"}' ]
    [ "$(hold_reason)" = precondition ]
}

@test "exit 3 of the verb is retried once after 30 seconds on the fake clock, and then busy" {
    only slugmarker-a
    child_seq slugmarker-a 3 3
    stage
    [ "$status" -eq 1 ]
    [ "$(file_lines "$DK/child.argv")" -eq 2 ]
    [ "$(counts)" = '{"total":1,"ok":0,"failed":0,"timeout":0,"busy":1,"skipped":0,"invalid":0,"seconds":30,"reason":"busy"}' ]
    # a second request id for the retry
    [ "$(cut -d'|' -f2 "$DK/child.env" | sort -u | wc -l)" -eq 2 ]
}

@test "exit 3 of the verb followed by a good retry is ok" {
    only slugmarker-a
    child_seq slugmarker-a 3 0
    stage
    [ "$status" -eq 0 ]
    [ "$(file_lines "$DK/child.argv")" -eq 2 ]
    [ "$(jqs '.live.reconcile.ok')" = 1 ]
    [ "$(jqs '.live.reconcile.seconds')" = 30 ]
}

@test "exit 124 of the verb is timeout" {
    cfg CD_RECONCILE_TIMEOUT_S=1
    only slugmarker-a
    : >"$DK/hang.slugmarker-a"
    stage
    [ "$status" -eq 1 ]
    [ "$(counts)" = '{"total":1,"ok":0,"failed":0,"timeout":1,"busy":0,"skipped":0,"invalid":0,"seconds":0,"reason":"timeout"}' ]
}

@test "any other exit code of the verb is failed" {
    only slugmarker-a
    child_rc slugmarker-a 7
    stage
    [ "$status" -eq 1 ]
    [ "$(jqs '.live.reconcile.failed')" = 1 ]
    [ "$(hold_reason)" = failed ]
}

@test "one failing customer does not stop the next" {
    child_rc slugmarker-a 1
    stage
    [ "$status" -eq 1 ]
    [ "$(order_of)" = "slugmarker-a slugmarker-b slugmarker-c" ]
    [ "$(counts)" = '{"total":3,"ok":2,"failed":1,"timeout":0,"busy":0,"skipped":0,"invalid":0,"seconds":0,"reason":"failed"}' ]
}

# ------------------------------------------------------------------------ bounds

@test "at CD_RECONCILE_MAX_MIN the remaining customers are skipped with reason budget" {
    cfg CD_RECONCILE_MAX_MIN=1
    child_run slugmarker-a 'echo $(( $(cat "$GREMION_CD_NOW_FILE") + 61 )) >"$GREMION_CD_NOW_FILE"'
    stage
    [ "$status" -eq 1 ]
    [ "$(order_of)" = "slugmarker-a" ]
    [ "$(counts)" = '{"total":3,"ok":1,"failed":0,"timeout":0,"busy":0,"skipped":2,"invalid":0,"seconds":61,"reason":"budget"}' ]
    [ "$(hold_reason)" = budget ]
}

@test "the kill switch between two customers stops the stage: the rest skipped, the hold set, nothing parks and no lock is held" {
    child_run slugmarker-a ': >"$GREMION_ROOT/etc/cd.disabled"'
    stage_then 'flock -n "${GREMION_ROOT}/runtime/hostd.lock" true; echo "hostlock=$?"'
    [ "$status" -eq 1 ]
    [ "$(order_of)" = "slugmarker-a" ]
    [ "$(counts)" = '{"total":3,"ok":1,"failed":0,"timeout":0,"busy":0,"skipped":2,"invalid":0,"seconds":0,"reason":"killswitch"}' ]
    [ "$(hold_kind)" = reconcile_failed ]
    [ "$(hold_reason)" = killswitch ]
    # it returned, and the host lock is free
    out_has '^hostlock=0$'
}

@test "a rollback request stops the stage with reason rollback_request and the request is left for the driver" {
    local req="${GREMION_ROOT}/runtime/cd/requests/1700000000-0001-rollback.json"
    child_run slugmarker-a 'mkdir -p "$GREMION_ROOT/runtime/cd/requests"; printf "%s\n" "{\"v\":1,\"verb\":\"rollback\",\"args\":{},\"at\":\"2026-11-17T01:00:00Z\",\"by\":\"op\"}" >"$GREMION_ROOT/runtime/cd/requests/1700000000-0001-rollback.json"'
    stage
    [ "$status" -eq 1 ]
    [ "$(order_of)" = "slugmarker-a" ]
    [ "$(rec_reason)" = rollback_request ]
    [ "$(jqs '.live.reconcile.skipped')" = 2 ]
    # untouched: still in the queue, not moved to processed/
    [ -f "$req" ]
    [ ! -e "${GREMION_ROOT}/runtime/cd/requests/processed" ]
}

@test "a request that is no rollback does not stop the stage" {
    mkdir -p "${GREMION_ROOT}/runtime/cd/requests"
    printf '{"v":1,"verb":"hold","args":{},"at":"x","by":"op"}\n' >"${GREMION_ROOT}/runtime/cd/requests/1700000000-0001-hold.json"
    printf 'not json\n' >"${GREMION_ROOT}/runtime/cd/requests/1700000000-0002-rollback.json"
    stage
    [ "$status" -eq 0 ]
}

@test "the timer guard answering 3 between two customers stops the stage with reason timer_guard" {
    seq_rc cd_data_timer_guard 0 3 3
    stage
    [ "$status" -eq 1 ]
    [ "$(order_of)" = "slugmarker-a" ]
    [ "$(counts)" = '{"total":3,"ok":1,"failed":0,"timeout":0,"busy":0,"skipped":2,"invalid":0,"seconds":0,"reason":"timer_guard"}' ]
    # a span of one child's cap (300 s: 5 minutes) plus one minute
    grep -qxF 'stub cd_data_timer_guard 6' "$SHIM_LOG"
}

@test "the timer guard answering 3 because the host lock is held by an operation is no stop: the stage waits for the lock and goes on" {
    hold_host_lock 3
    only slugmarker-a
    seq_rc cd_data_timer_guard 3
    stage
    [ "$status" -eq 0 ]
    [ "$(order_of)" = "slugmarker-a" ]
    [ "$(counts)" = '{"total":1,"ok":1,"failed":0,"timeout":0,"busy":0,"skipped":0,"invalid":0,"seconds":0,"reason":null}' ]
    # asked twice: once before the wait and once after
    [ "$(calls_of 'stub cd_data_timer_guard')" -eq 2 ]
    release_host_lock
}

@test "a guard answer 3 with the host lock held for longer than the wait counts the customer busy and runs no child" {
    hold_host_lock 30
    cfg CD_RECONCILE_LOCK_WAIT_S=1
    only slugmarker-a
    seq_rc cd_data_timer_guard 3
    stage
    [ "$status" -eq 1 ]
    [ "$(file_lines "$DK/child.argv")" -eq 0 ]
    [ "$(rec_reason)" = busy ]
    [ "$(jqs '.live.reconcile.busy')" = 1 ]
    release_host_lock
}

@test "a timer guard that cannot answer is not a pass: the stage stops with reason unknown" {
    seq_rc cd_data_timer_guard 2
    stage
    [ "$status" -eq 1 ]
    [ "$(file_lines "$DK/child.argv")" -eq 0 ]
    [ "$(rec_reason)" = unknown ]
}

# ------------------------------------------------------------------------ the order guard

@test "the stage refuses when current is not the live release's tree: code 2, no child, no query" {
    # the other tree is a complete one, so only the order guard can refuse
    mkdir -p "${GREMION_ROOT}/releases/bbbbbbbbbbbb/infra/host/bin"
    cp "${TREE}/infra/host/bin/gremion-tenant" "${GREMION_ROOT}/releases/bbbbbbbbbbbb/infra/host/bin/gremion-tenant"
    ln -sfn "${GREMION_ROOT}/releases/bbbbbbbbbbbb" "${GREMION_ROOT}/current"
    stage
    [ "$status" -eq 2 ]
    [ "$(file_lines "$DK/child.argv")" -eq 0 ]
    [ "$(file_lines "$DK/sql.all")" -eq 0 ]
    [ "$(hold_reason)" = precondition ]
}

@test "the stage refuses when the active colour is not the live colour: code 2, no child" {
    printf 'green\n' >"${GREMION_ROOT}/runtime/active-colour"
    stage
    [ "$status" -eq 2 ]
    [ "$(file_lines "$DK/child.argv")" -eq 0 ]
    [ "$(hold_reason)" = precondition ]
}

@test "the stage refuses when the active colour file is missing" {
    rm -f "${GREMION_ROOT}/runtime/active-colour"
    stage
    [ "$status" -eq 2 ]
    [ "$(file_lines "$DK/child.argv")" -eq 0 ]
}

@test "the stage refuses when the release tree has no executable verb, or when there is no probe host" {
    chmod -x "${TREE}/infra/host/bin/gremion-tenant"
    stage
    [ "$status" -eq 2 ]
    chmod +x "${TREE}/infra/host/bin/gremion-tenant"
    cfg CD_PROBE_HOST=
    stage
    [ "$status" -eq 2 ]
    [ "$(file_lines "$DK/child.argv")" -eq 0 ]
}

@test "with no probe host configured, the first host of etc/tenant-hosts.txt is the probe host" {
    cfg CD_PROBE_HOST=
    printf '# hosts\n\nfirst.example.org extra\nsecond.example.org\n' >"${GREMION_ROOT}/etc/tenant-hosts.txt"
    stage
    [ "$status" -eq 0 ]
    grep -qF "d.host = 'first.example.org'" "$DK/sql.all"
}

# ------------------------------------------------------------------------ the outcome

@test "all ok gives the history event reconciled and the mail reconciled with counts and no hold, and moves nothing" {
    seed_release
    local before
    before="$(fingerprint)"
    stage
    [ "$status" -eq 0 ]
    grep -qF '"event":"reconciled"' "${GREMION_ROOT}/data/cd/history.jsonl"
    [ "$(find "${GREMION_ROOT}/data/cd/outbox" -name '*.eml' | wc -l)" -eq 1 ]
    local mail
    mail="$(cat "${GREMION_ROOT}"/data/cd/outbox/*.eml)"
    [[ "$mail" == *"kind: reconciled"* ]]
    [[ "$mail" == *"customers_total: 3"* ]]
    [[ "$mail" == *"customers_ok: 3"* ]]
    [ "$(hold_kind)" = none ]
    [ "$(calls_of 'stub cd_rollback_run')" -eq 0 ]
    [ "$(fingerprint)" = "$before" ]
}

@test "anything else gives the hold reconcile_failed with the reason code, one mail with counts and the one command, and moves nothing" {
    seed_release
    child_rc slugmarker-b 1
    local before
    before="$(fingerprint)"
    stage
    [ "$status" -eq 1 ]
    [ "$(hold_kind)" = reconcile_failed ]
    [ "$(hold_reason)" = failed ]
    [ "$(find "${GREMION_ROOT}/data/cd/outbox" -name '*.eml' | wc -l)" -eq 1 ]
    local mail
    mail="$(cat "${GREMION_ROOT}"/data/cd/outbox/*.eml)"
    [[ "$mail" == *"kind: reconcile_failed"* ]]
    [[ "$mail" == *"customers_total: 3"* ]]
    [[ "$mail" == *"customers_ok: 2"* ]]
    [[ "$mail" == *"customers_failed: 1"* ]]
    [[ "$mail" == *"reason: failed"* ]]
    [[ "$mail" == *"command: gremion-cd reconcile"* ]]
    [ "$(calls_of 'stub cd_rollback_run')" -eq 0 ]
    [ "$(fingerprint)" = "$before" ]
}

@test "every failure shape leaves the committed release alone: no rollback, no block, nothing moved" {
    seed_release
    local before shape
    before="$(fingerprint)"
    child_rc slugmarker-a 2
    stage
    [ "$status" -eq 1 ]
    rm -f "$DK/child.slugmarker-a.rc"
    : >"${GREMION_ROOT}/etc/cd.disabled"
    stage
    [ "$status" -eq 1 ]
    rm -f "${GREMION_ROOT}/etc/cd.disabled"
    seq_rc cd_watch_probe_public 1 1
    stage
    [ "$status" -eq 1 ]
    : >"$DK/q.list.fail"
    stage
    [ "$status" -eq 1 ]
    [ "$(calls_of 'stub cd_rollback_run')" -eq 0 ]
    [ "$(fingerprint)" = "$before" ]
}

@test "a second run on the same state gives the same counts, and a re-run overwrites a failed one" {
    child_rc slugmarker-b 1
    stage
    [ "$status" -eq 1 ]
    [ "$(jqs '.live.reconcile.failed')" = 1 ]
    local first
    stage
    first="$(counts)"
    stage
    [ "$(counts)" = "$first" ]
    # the cause is fixed: the next run overwrites the failed counts with a clean one
    rm -f "$DK/child.slugmarker-b.rc"
    stage
    [ "$status" -eq 0 ]
    [ "$(counts)" = '{"total":3,"ok":3,"failed":0,"timeout":0,"busy":0,"skipped":0,"invalid":0,"seconds":0,"reason":null}' ]
}

@test "the counts add up, hold no slug, and seconds is the measured duration of the stage" {
    only slugmarker-a slugmarker-b Bad_Slug
    child_run slugmarker-a 'echo $(( $(cat "$GREMION_CD_NOW_FILE") + 7 )) >"$GREMION_CD_NOW_FILE"'
    child_rc slugmarker-b 1
    stage
    [ "$status" -eq 1 ]
    local c
    c="$(jqs '.live.reconcile')"
    [ "$(jq -r '.total' <<<"$c")" = "$(jq -r '[.ok, .failed, .timeout, .busy, .skipped, .invalid] | add' <<<"$c")" ]
    [ "$(jq -r '.seconds' <<<"$c")" = 7 ]
    [ "$(jq -r '.total' <<<"$c")" = 3 ]
    refute_text "slugmarker" "$c"
    refute_text "Bad_Slug" "$c"
}

@test "the stage runs the same inside a release in flight (stage reconcile, committed) and leaves the release record as it was" {
    seed_release
    stage
    [ "$status" -eq 0 ]
    [ "$(jqs '.release.stage')" = '"reconcile"' ]
    [ "$(jqs '.release.stage_status')" = '"started"' ]
    [ "$(jqs '.release.committed_at')" = '"2026-11-17T01:00:00Z"' ]
    [ "$(jqs '.phase')" = '"releasing"' ]
}
