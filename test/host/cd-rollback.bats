#!/usr/bin/env bats
# test/host/cd-rollback.bats -- cd-rollback: infra/host/lib/cd/rollback.sh, the one rollback sequence
# of the continuous deployment program (cd_rollback_run RULE): the old colour up from its own tree,
# proved, switched to from its own tree, confirmed, watched; the workers, the stop of the new colour,
# the block and the hold, `current`, the isolation record and the mail. Resumable.
#
# Run: MSYS_NO_PATHCONV=1 docker run --rm --user 1001 -v "$(pwd -W):/repo:ro" -w /repo gremion-bats:local test/host/cd-rollback.bats
#
# Nothing here touches a real docker, Traefik or network. The real core.sh and docker.sh run under
# the real rollback.sh; the other units' functions are stand-ins (SIM below) that read and write
# files under $DK, so each test decides what the world answers and every call lands, in order, in
# $SHIM_LOG as "sim <call>". Three groups run the REAL libraries instead: the THE LINE tests (real
# traffic.sh and colour.sh next to a fake Traefik and a gremion-switch inside each fake release
# tree), the retag test (real prepare.sh) and the mail test (real notify.sh). The clock is the fake
# clock of test_helper/cd (cd_sleep advances it, so the 180 second window costs nothing). Every name
# is a reserved example name.

bats_require_minimum_version 1.5.0
load 'test_helper/host'
load 'test_helper/cd'

FIX="${BATS_TEST_DIRNAME}/fixtures/cd/rollback"
OLD_TAG="pilot-aaaaaaaaaaaa"
NEW_TAG="pilot-bbbbbbbbbbbb"
PREV_TAG="pilot-cccccccccccc"
SHA_OLD="$(printf 'a%.0s' $(seq 1 40))"
SHA_NEW="$(printf 'b%.0s' $(seq 1 40))"
SHA_PREV="$(printf 'c%.0s' $(seq 1 40))"
BLOCK_RULES="build_failed migrate_failed start_failed readiness_failed isolation_failed verify_failed post_switch_verify watch_readiness watch_crash watch_5xx watch_pause_cap manual_rollback"
STEPS="record old prove switch confirm watch workers stop restore blockhold current isolation mail"

setup() {
    cd_setup
    export STACK=teststack
    unset CD_DC_TIMEOUT GREMION_CD_ROLLBACK_KILL_AFTER
    DK="${SHIM_DIR}/dk"
    OLD_TREE="${GREMION_ROOT}/releases/aaaaaaaaaaaa"
    NEW_TREE="${GREMION_ROOT}/releases/bbbbbbbbbbbb"
    PREV_TREE="${GREMION_ROOT}/releases/cccccccccccc"
    SIM_OLD=blue
    SIM_NEW=green
    export DK OLD_TREE NEW_TREE PREV_TREE SIM_OLD SIM_NEW OLD_TAG NEW_TAG PREV_TAG
    mkdir -p "$DK" "$OLD_TREE" "$NEW_TREE" "$PREV_TREE"
    cp "${FIX}/state.env" "${GREMION_ROOT}/etc/env/state.env"
    cp "${FIX}/app-blue.env" "${GREMION_ROOT}/etc/env/app-blue.env"
    cp "${FIX}/app-green.env" "${GREMION_ROOT}/etc/env/app-green.env"
    unset RL_LIBS RL_SIM
    export RL_LIBS=docker
    shim_curl_unit
    shim_docker_unit
    # the window after the switch back is off unless a test asks for it (it is the slow part)
    cd_write_cfg CD_POST_ROLLBACK_S=0
    world_new_serves
    seed_pre
}

teardown() {
    cd_teardown
}

# ------------------------------------------------------------------ the world

# The stand-ins of the other units for the unit tests. They are evaluated inside the loader, after
# the real libraries and the stub file, so they win. State of the world is files in $DK:
#   running.<colour>   the colour's project is up and healthy      active   what the file AND Traefik say
#   next               the colour app-next@file names               next.status   its status (UP)
#   switch.mode        ok | fail | write_then_fail | hang           switch.failn  N calls fail, then ok
#   confirm.fail pub.fail identity.fail portal.fail start.fail iso.fail isorun.fail notify.fail newdead
#   probe.seq sample.seq   one word per call (ok bad wrongrel shared), the last one sticks
#   fivexx             the 5xx count the access log gives            readyz   the loopback status (200)
sim_common() {
    cat <<'SIM'
_sim_log() { printf 'sim %s\n' "$*" >> "$SHIM_LOG"; }
_sim_seq() { # FILE DEFAULT -- the word of this call
    local f="$1" n line
    if [ ! -f "$f" ]; then printf '%s' "$2"; return 0; fi
    n="$(cat "$f.n" 2>/dev/null || echo 0)"
    line="$(sed -n "$((n + 1))p" "$f")"
    [ -n "$line" ] || line="$(tail -n 1 "$f")"
    echo "$((n + 1))" > "$f.n"
    printf '%s' "$line"
}
_sim_tag() { if [ "$1" = "$SIM_NEW" ]; then printf '%s' "$NEW_TAG"; else printf '%s' "$OLD_TAG"; fi; }
# a colour that answers nothing: every call that needs the new colour to answer is a finding
_sim_dead() { if [ "$1" = "$SIM_NEW" ] && [ -e "$DK/newdead" ]; then _sim_log "NEWCALL $2 $1"; return 0; fi; return 1; }
cd_wait_healthy() { local c="${1#app-}"; _sim_log "wait_healthy $c"; if _sim_dead "$c" wait_healthy; then return 3; fi; [ -e "$DK/running.$c" ] && return 0; return 3; }
cd_svc_cid() { _sim_log "cid $1 $2"; if [ "${1#app-}" = "$SIM_NEW" ] && [ -e "$DK/newdead" ]; then return 1; fi; printf 'cid-%s\n' "$1"; }
cd_colour_identity() { _sim_log "identity $1 $2"; if _sim_dead "$1" identity; then return 1; fi; [ ! -e "$DK/identity.fail" ]; }
cd_colour_probe() {
    local w
    _sim_log "probe $1"
    if _sim_dead "$1" probe; then return 1; fi
    w="$(_sim_seq "$DK/probe.seq" ok)"
    case "$w" in
        ok) printf '{"ready":true,"colour":"%s","release":"%s","tenants":{"total":1,"notReady":0}}\n' "$1" "$(_sim_tag "$1")" ;;
        wrongrel) printf '{"ready":true,"colour":"%s","release":"pilot-ffffffffffff","tenants":{"total":1,"notReady":0}}\n' "$1" ;;
        *) return 1 ;;
    esac
}
cd_colour_portal_probe() { _sim_log "portal $1"; if _sim_dead "$1" portal; then return 1; fi; [ ! -e "$DK/portal.fail" ]; }
cd_watch_probe_public() { _sim_log "probe_public"; if [ -e "$DK/pub.fail" ]; then printf '503 200\n'; return 1; fi; printf '200 200\n'; }
cd_watch_accesslog_count() { _sim_log "accesslog_count $1"; cat "$DK/fivexx" 2>/dev/null || echo 0; }
cd_watch_sample() {
    local w now
    _sim_log "sample $1 $2"
    if _sim_dead "$1" sample; then return 1; fi
    w="$(_sim_seq "$DK/sample.seq" ok)"
    now="$(cd_now)"
    jq -cn --arg c "$1" --arg t "$2" --arg w "$w" --argjson at "$now" '
        {v: 1, at: $at, duration_s: 0, colour: $c, tag: $t, old_colour: (if $c == "blue" then "green" else "blue" end),
         public: {readyz: "200", login: "302", ok: ($w == "ok")},
         internal: {answered: true, ready: true, colour: $c, release: $t, not_ready: 0},
         route: {known: true, ok: true}, identity: {ok: true}, portal: {ok: true},
         containers: {known: true, total: 4, bad: 0, restarts: 0}, fivexx: 0, requests: 10, window_s: 300,
         workers: {new: "on", old: "off"}, old_ready: true,
         shared: {state_ok: ($w != "shared"), traefik_ok: true, docker_ok: true}, timed_out: false}'
}
cd_colour_isolation_record() { _sim_log "isolation_record $1"; [ ! -e "$DK/iso.fail" ]; }
cd_colour_isolation_run() { _sim_log "isolation_run $1"; [ ! -e "$DK/isorun.fail" ]; }
if [ -z "${RL_REAL_PREPARE:-}" ]; then cd_prepare_retag_restore() { _sim_log "retag_restore"; return 0; }; fi
if [ -z "${RL_REAL_NOTIFY:-}" ]; then
cd_notify() {
    local nb nh
    nb="$(jq 'length' "$GREMION_ROOT/data/cd/blocked.json" 2>/dev/null || echo 0)"
    nh="$(jq -r '.hold.kind // "none"' "$GREMION_ROOT/data/cd/state.json" 2>/dev/null || echo none)"
    _sim_log "notify $* [blocks=$nb hold=$nh]"
    [ ! -e "$DK/notify.fail" ]
}
fi
SIM
}

# The traffic, colour start/stop and worker stand-ins (not used where the real traffic.sh and
# colour.sh run).
sim_traffic() {
    cat <<'SIM'
cd_traefik_service() {
    local name="$1" c u st
    _sim_log "traefik_service $name"
    c="$(cat "$DK/next" 2>/dev/null || echo "$SIM_OLD")"
    st="$(cat "$DK/next.status" 2>/dev/null || echo UP)"
    u="http://gremion-ui-${c}:3000"
    jq -cn --arg u "$u" --arg s "$st" '{loadBalancer: {servers: [{url: $u}]}, serverStatus: {($u): $s}}'
}
cd_colour_start() { _sim_log "start $1 $2 $3"; [ -e "$DK/start.fail" ] && return 1; touch "$DK/running.$2"; return 0; }
cd_colour_down() {
    _sim_log "down $1 $2 active=$(cat "$DK/active")"
    if [ "$(cat "$DK/active")" = "$2" ]; then _sim_log "DOWN-OF-SERVING $2"; return 1; fi
    rm -f "$DK/running.$2"
    return 0
}
cd_colour_workers() {
    _sim_log "workers $1 $2"
    mkdir -p "$GREMION_ROOT/runtime/workers"
    case "$2" in
        get) cat "$GREMION_ROOT/runtime/workers/$1" 2>/dev/null || echo on ;;
        *) printf '%s' "$2" > "$GREMION_ROOT/runtime/workers/$1" ;;
    esac
}
cd_traffic_truth() {
    _sim_log "truth"
    if [ -e "$DK/truth.disagree" ]; then printf 'file=%s app=%s public=%s\n' "$SIM_OLD" "$SIM_NEW" "$SIM_NEW"; return 1; fi
    cat "$DK/active"
}
cd_traffic_switch() {
    local mode n rid
    rid="$(cd_state_get '.release.id // empty')"
    _sim_log "switch $1 $2 phase=$(cd_state_get .phase) rid=${rid:-none}"
    [ -n "$rid" ] || return 2
    mode="$(cat "$DK/switch.mode" 2>/dev/null || echo ok)"
    n="$(cat "$DK/switch.n" 2>/dev/null || echo 0)"
    echo "$((n + 1))" > "$DK/switch.n"
    if [ "$n" -lt "$(cat "$DK/switch.failn" 2>/dev/null || echo 0)" ]; then return 1; fi
    case "$mode" in
        ok) printf '%s\n' "$2" > "$DK/active"; printf '%s\n' "$2" > "$GREMION_ROOT/runtime/active-colour"; return 0 ;;
        write_then_fail) printf '%s\n' "$2" > "$DK/active"; return 1 ;;
        hang) sleep 3; printf '%s\n' "$2" > "$DK/active"; return 0 ;;
        *) return 1 ;;
    esac
}
cd_traffic_confirm() { _sim_log "confirm $1"; [ "$(cat "$DK/active")" = "$1" ] && [ ! -e "$DK/confirm.fail" ]; }
SIM
}

# rl 'snippet' -- a fresh bash: real common.sh, core.sh, cmd-state.sh, the libraries of $RL_LIBS, the
# real rollback.sh, the stub file, then $RL_SIM (the stand-ins); the cd lock is taken by hand
# (CD_LOCK_PID) like a driver that holds it. Use with `run`.
rl() {
    bash -c "set -euo pipefail
. \"\${HOST_SRC}/lib/common.sh\"
. \"\${HOST_SRC}/lib/cd/core.sh\"
. \"\${HOST_SRC}/lib/cd/cmd-state.sh\"
for l in \${RL_LIBS:-docker}; do . \"\${HOST_SRC}/lib/cd/\${l}.sh\"; done
. \"\${HOST_SRC}/lib/cd/rollback.sh\"
. \"\${GREMION_CD_STUBS_DIR}/cd-stubs.sh\"
eval \"\${RL_SIM:-}\"
cd_cfg_load
CD_LOCK_PID=\$\$
${1}" rl
}

# rl_nolock 'snippet' -- the same without the cd lock (a second process, a manual verb).
rl_nolock() {
    bash -c "set -euo pipefail
. \"\${HOST_SRC}/lib/common.sh\"
. \"\${HOST_SRC}/lib/cd/core.sh\"
. \"\${HOST_SRC}/lib/cd/cmd-state.sh\"
for l in \${RL_LIBS:-docker}; do . \"\${HOST_SRC}/lib/cd/\${l}.sh\"; done
. \"\${HOST_SRC}/lib/cd/rollback.sh\"
. \"\${GREMION_CD_STUBS_DIR}/cd-stubs.sh\"
eval \"\${RL_SIM:-}\"
cd_cfg_load
${1}" rl
}

# rbn RULE -- like rb, but the process takes the REAL cd lock itself (a second process, a verb).
rbn() {
    rl_nolock 'rc=0; cd_rollback_run '"$1"' || rc=$?; printf "rc=%s reason=%s
" "$rc" "$CD_ROLLBACK_REASON"'
}

sim_on() { export RL_SIM="$(sim_common)"$'\n'"$(sim_traffic)"; }

# rb RULE -- run the rollback and print "rc=<code> reason=<reason>".
rb() {
    rl 'rc=0; cd_rollback_run '"$1"' || rc=$?; printf "rc=%s reason=%s\n" "$rc" "$CD_ROLLBACK_REASON"'
}

shim_curl_unit() {
    shim curl "$(cat <<'EOF'
url="${@: -1}"
case "$url" in
  */readyz)
    code="$(cat "$DK/readyz" 2>/dev/null || echo 200)"
    if [ "$code" = 200 ]; then printf '{"ready":true}\n200'; else printf '{"ready":false}\n%s' "$code"; fi ;;
  *) exit 7 ;;
esac
EOF
)"
}

shim_docker_unit() {
    shim docker 'case "$1" in
  logs) echo "log-tail-marker-zq"; exit 0 ;;
esac
exit 0'
}

# world_new_serves -- the state after the switch: the new colour (green) serves, the old one (blue)
# is up and healthy and is the next route.
world_new_serves() {
    rm -f "$DK"/* 2>/dev/null || true
    touch "$DK/running.blue" "$DK/running.green"
    printf '%s\n' green > "$DK/active"
    printf '%s\n' green > "${GREMION_ROOT}/runtime/active-colour"
    printf '%s\n' blue > "$DK/next"
    cp "${FIX}/app-blue.env" "${GREMION_ROOT}/etc/env/app-blue.env"
    cp "${FIX}/app-green.env" "${GREMION_ROOT}/etc/env/app-green.env"
    rm -f "${GREMION_ROOT}/current" "${GREMION_ROOT}/runtime/current-tag" "${GREMION_ROOT}/runtime/previous-tag"
    rm -rf "${GREMION_ROOT}/runtime/workers"
    : > "$SHIM_LOG"
    rm -f "${GREMION_ROOT}/data/cd/blocked.json" "${GREMION_ROOT}/data/cd/history.jsonl" "${GREMION_ROOT}/data/cd/rollback.json"
}

# seed_pre [JQ] -- a release in flight (green, switched, watching) on top of blue; previous is on green.
seed_pre() {
    cd_seed_state '.phase = "watching"
      | .live = {"sha":"'"$SHA_OLD"'","sha12":"aaaaaaaaaaaa","tag":"'"$OLD_TAG"'","colour":"blue","tree":"'"$OLD_TREE"'","since":"2026-11-01T00:00:00Z"}
      | .previous = {"sha":"'"$SHA_PREV"'","sha12":"cccccccccccc","tag":"'"$PREV_TAG"'","colour":"green","tree":"'"$PREV_TREE"'","startable":true}
      | .release = {"id":"bbbbbbbbbbbb-1","sha":"'"$SHA_NEW"'","sha12":"bbbbbbbbbbbb","tag":"'"$NEW_TAG"'","colour":"green","tree":"'"$NEW_TREE"'",
                    "mode":"auto","stage":"watch","stage_status":"started","switch_started":true,"committed_at":null,
                    "watch":{"observed_s":300,"samples":20,"bad_streak":3,"paused_s":0,"blind":0,"requests":0,"baseline_5xx":0,"baseline_not_ready":0,"last_sample_epoch":0}}
      | '"${1:-.}"
}

# seed_post [JQ] -- a COMMITTED release: live is green (new), previous is blue (old, startable), the
# record is in stage reconcile with committed_at set; current and the tag files name the new release.
seed_post() {
    cd_seed_state '.phase = "releasing"
      | .live = {"sha":"'"$SHA_NEW"'","sha12":"bbbbbbbbbbbb","tag":"'"$NEW_TAG"'","colour":"green","tree":"'"$NEW_TREE"'","since":"2026-11-02T00:00:00Z"}
      | .previous = {"sha":"'"$SHA_OLD"'","sha12":"aaaaaaaaaaaa","tag":"'"$OLD_TAG"'","colour":"blue","tree":"'"$OLD_TREE"'","startable":true}
      | .release = {"id":"bbbbbbbbbbbb-1","sha":"'"$SHA_NEW"'","sha12":"bbbbbbbbbbbb","tag":"'"$NEW_TAG"'","colour":"green","tree":"'"$NEW_TREE"'",
                    "mode":"auto","stage":"reconcile","stage_status":"started","switch_started":true,"committed_at":"2026-11-02T00:00:00Z"}
      | '"${1:-.}"
    ln -sfn "$NEW_TREE" "${GREMION_ROOT}/current"
    printf '%s\n' "$NEW_TAG" > "${GREMION_ROOT}/runtime/current-tag"
    printf '%s\n' "$OLD_TAG" > "${GREMION_ROOT}/runtime/previous-tag"
}

# seed_idle -- the same committed release after its reconcile stage ended: nothing in flight.
seed_idle() {
    seed_post '.phase = "idle" | .release = null | '"${1:-.}"
}

sj() { jq -r "$1" "${GREMION_ROOT}/data/cd/state.json"; }
blocks() { jq -r "$1" "${GREMION_ROOT}/data/cd/blocked.json"; }
hist_has() { grep -q "\"event\":\"$1\"" "${GREMION_ROOT}/data/cd/history.jsonl"; }
# lineno PATTERN -- the line number of the first line of the call log that matches (fixed string).
lineno() { grep -n -m1 -F -- "$1" "$SHIM_LOG" | cut -d: -f1; }
# before A B -- the first line matching A comes before the first line matching B (both must exist).
before() {
    local a b
    a="$(lineno "$1")"
    b="$(lineno "$2")"
    [ -n "$a" ] || { echo "before: no line matches: $1" >&2; cat "$SHIM_LOG" >&2; return 1; }
    [ -n "$b" ] || { echo "before: no line matches: $2" >&2; cat "$SHIM_LOG" >&2; return 1; }
    [ "$a" -lt "$b" ] || { echo "before: '$1' ($a) is not before '$2' ($b)" >&2; cat "$SHIM_LOG" >&2; return 1; }
}
count() { grep -c -F -- "$1" "$SHIM_LOG" || true; }
# the whole world, as a string, to prove that a refusal touched nothing
fingerprint() {
    {
        cat "${GREMION_ROOT}/data/cd/state.json" 2>/dev/null
        cat "${GREMION_ROOT}/data/cd/blocked.json" 2>/dev/null || echo no-blocks
        wc -l < "${GREMION_ROOT}/data/cd/history.jsonl" 2>/dev/null || echo no-hist
        readlink "${GREMION_ROOT}/current" 2>/dev/null || echo no-current
        cat "${GREMION_ROOT}/runtime/active-colour" "${GREMION_ROOT}/runtime/current-tag" "${GREMION_ROOT}/runtime/previous-tag" 2>/dev/null || true
        cat "$DK/active" 2>/dev/null || true
        ls "${GREMION_ROOT}/data/cd" "${GREMION_ROOT}/runtime/workers" 2>/dev/null | sort | tr '\n' ' '
        cat "$SHIM_LOG"
    } | sha256sum
}

# ================================================================= the whole sequence

@test "a rollback of a release in flight runs the steps in order and ends with the old colour serving" {
    cd_write_cfg CD_POST_ROLLBACK_S=45
    sim_on
    run rb watch_readiness
    [ "$status" -eq 0 ]
    [[ "$output" == *"rc=0 "* ]]
    before 'sim identity blue' 'sim probe blue'
    before 'sim portal blue' 'sim switch'
    before 'sim switch' 'sim confirm blue'
    before 'sim confirm blue' 'sim probe_public'
    before 'sim probe_public' 'sim sample blue'
    before 'sim sample blue' 'sim workers green off'
    before 'sim workers green off' 'sim workers blue on'
    before 'sim workers blue on' 'sim down'
    before 'sim down' 'sim notify rolled_back'
    [ "$(cat "$DK/active")" = blue ]
    [ "$(cat "${GREMION_ROOT}/runtime/active-colour")" = blue ]
    [ ! -e "$DK/running.green" ]
    [ "$(cat "${GREMION_ROOT}/runtime/workers/green")" = off ]
    [ "$(cat "${GREMION_ROOT}/runtime/workers/blue")" = on ]
    [ "$(sj .phase)" = idle ]
    [ "$(sj .release)" = null ]
    [ "$(sj .hold.kind)" = blocked ]
    [ "$(sj .hold.reason)" = watch_readiness ]
    [ "$(sj .hold.sha12)" = bbbbbbbbbbbb ]
    [ "$(sj .live.tag)" = "$OLD_TAG" ]
    [ "$(blocks length)" = 1 ]
    [ "$(blocks '.[0].sha')" = "$SHA_NEW" ]
    [ ! -e "${GREMION_ROOT}/data/cd/rollback.json" ]
    hist_has rollback_started
    hist_has rolled_back
}

@test "record: the rule and the time are written first, before any call, and the phase is rolling_back while it runs" {
    sim_on
    run rb watch_5xx
    [ "$status" -eq 0 ]
    # the switch stand-in logged the state it saw
    assert_present '^sim switch .* phase=rolling_back rid=bbbbbbbbbbbb-1$' "$SHIM_LOG"
    run jq -r 'select(.event == "rollback_started") | .rule' "${GREMION_ROOT}/data/cd/history.jsonl"
    [ "$output" = watch_5xx ]
}

@test "record: the sidecar names the rule and the sides while the rollback is in progress (0600)" {
    sim_on
    export GREMION_CD_ROLLBACK_KILL_AFTER=record
    run rb watch_crash
    [ "$status" -eq 137 ]
    f="${GREMION_ROOT}/data/cd/rollback.json"
    [ "$(jq -r '.ctx.rule' "$f")" = watch_crash ]
    [ "$(jq -r '.ctx.old.colour + " " + .ctx.new.colour' "$f")" = "blue green" ]
    [ "$(jq -r '.steps | join(",")' "$f")" = record ]
    [ "$(stat -c %a "$f")" = 600 ]
    [ "$(sj .phase)" = rolling_back ]
}

# ================================================================= the old colour

@test "old: a healthy old colour is not started again" {
    sim_on
    run rb watch_readiness
    [ "$status" -eq 0 ]
    assert_absent '^sim start ' "$SHIM_LOG"
}

@test "old: an old colour whose containers are gone is started from ITS OWN tree, env and tag, before anything is proved" {
    sim_on
    rm -f "$DK/running.blue"
    run rb watch_readiness
    [ "$status" -eq 0 ]
    [ "$(count "sim start $OLD_TREE blue $OLD_TAG")" = 1 ]
    assert_absent "sim start ${NEW_TREE}" "$SHIM_LOG"
    before "sim start $OLD_TREE blue" 'sim identity blue'
}

@test "old: the env IMAGE_TAG is checked against the tag first; a colour that names another tag is NOT started and the new colour is left running" {
    sim_on
    rm -f "$DK/running.blue"
    sed -i 's/^IMAGE_TAG=.*/IMAGE_TAG=pilot-dddddddddddd/' "${GREMION_ROOT}/etc/env/app-blue.env"
    run rb watch_readiness
    [ "$status" -eq 0 ]
    [[ "$output" == *"rc=1 reason=old_not_startable"* ]]
    assert_absent '^sim start ' "$SHIM_LOG"
    assert_absent '^sim (switch|down|workers)' "$SHIM_LOG"
    [ -e "$DK/running.green" ]
    [ "$(sj .hold.kind)" = rollback_failed ]
    [ "$(sj .phase)" = idle ]
    assert_present '^sim notify rollback_failed ' "$SHIM_LOG"
}

@test "old: a start that fails is a rollback_failed with the new colour left running" {
    sim_on
    rm -f "$DK/running.blue"
    touch "$DK/start.fail"
    run rb watch_readiness
    [[ "$output" == *"rc=1 reason=old_start_failed"* ]]
    assert_absent '^sim (switch|down)' "$SHIM_LOG"
    [ -e "$DK/running.green" ]
}

# ================================================================= the proof of the old colour

@test "prove: the old colour's image identity is checked; a failure stops before the switch" {
    sim_on
    touch "$DK/identity.fail"
    run rb watch_readiness
    [[ "$output" == *"rc=1 reason=old_identity"* ]]
    assert_present "^sim identity blue $OLD_TAG" "$SHIM_LOG"
    assert_absent '^sim (switch|down|workers)' "$SHIM_LOG"
}

@test "prove: the portal list page of the old colour must pass; a failure stops before the switch" {
    sim_on
    touch "$DK/portal.fail"
    run rb watch_readiness
    [[ "$output" == *"rc=1 reason=old_portal"* ]]
    assert_absent '^sim (switch|down|workers)' "$SHIM_LOG"
}

@test "prove: three CONSECUTIVE answers of the old colour are needed (a failure in between starts again)" {
    sim_on
    printf 'ok\nok\nbad\nok\nok\nok\n' > "$DK/probe.seq"
    run rb watch_readiness
    [ "$status" -eq 0 ]
    [[ "$output" == *"rc=0 "* ]]
    [ "$(count 'sim probe blue')" = 6 ]
    before 'sim probe blue' 'sim switch'
}

@test "prove: an answer of the wrong release is not the old colour (no switch)" {
    sim_on
    printf 'wrongrel\n' > "$DK/probe.seq"
    export CD_ROLLBACK_PROVE_TRIES=4
    run rb watch_readiness
    [[ "$output" == *"rc=1 reason=old_not_ready"* ]]
    [ "$(count 'sim probe blue')" = 4 ]
    assert_absent '^sim (switch|down|workers)' "$SHIM_LOG"
}

@test "prove: when the next route names the old colour, the loopback ready-only answer must be {\"ready\":true}" {
    sim_on
    run rb watch_readiness
    [ "$status" -eq 0 ]
    [[ "$output" == *"rc=0 "* ]]
    # (the shim records the -w format on two lines, so the call is read from the whole log)
    assert_present 'http://127.0.0.1:18081/readyz' "$SHIM_LOG"
    assert_present 'Host: cd-rollback.invalid' "$SHIM_LOG"
}

@test "prove: a loopback answer other than 200 {\"ready\":true} stops before the switch" {
    sim_on
    printf '503\n' > "$DK/readyz"
    export CD_ROLLBACK_PROVE_TRIES=3
    run rb watch_readiness
    [[ "$output" == *"rc=1 reason=old_not_ready"* ]]
    assert_absent '^sim (switch|down|workers)' "$SHIM_LOG"
}

@test "prove: a next route that names the old colour but is not UP stops before the switch" {
    sim_on
    printf 'DOWN\n' > "$DK/next.status"
    export CD_ROLLBACK_PROVE_TRIES=3
    run rb watch_readiness
    [[ "$output" == *"rc=1 reason=old_not_ready"* ]]
    assert_absent '^sim switch' "$SHIM_LOG"
}

@test "prove: a next route that names the OTHER colour (the old colour still serves) is covered by the real-edge probe, no loopback call" {
    sim_on
    printf 'green\n' > "$DK/next"
    printf 'blue\n' > "$DK/active"
    run rb watch_readiness
    [ "$status" -eq 0 ]
    [[ "$output" == *"rc=0 "* ]]
    assert_absent 'readyz' "$SHIM_LOG"
}

# ================================================================= the switch back

@test "switch: gremion-switch is called with the OLD tree and the old colour" {
    sim_on
    run rb watch_readiness
    [ "$status" -eq 0 ]
    [ "$(count "sim switch $OLD_TREE blue ")" = 1 ]
    assert_absent "sim switch ${NEW_TREE}" "$SHIM_LOG"
}

@test "switch: when the truth already says the old colour serves, the switch is not written again" {
    sim_on
    printf 'blue\n' > "$DK/active"
    run rb watch_readiness
    [ "$status" -eq 0 ]
    [[ "$output" == *"rc=0 "* ]]
    assert_absent '^sim switch ' "$SHIM_LOG"
    assert_present '^sim confirm blue' "$SHIM_LOG"
}

@test "switch: a file and an edge that disagree are not 'done': the switch is written" {
    sim_on
    printf 'blue\n' > "$DK/active"
    touch "$DK/truth.disagree"
    run rb watch_readiness
    [[ "$output" == *"rc=0 "* ]]
    [ "$(count 'sim switch ')" = 1 ]
}

@test "switch: three failures end in rollback_failed, a critical mail and a hold, and the new colour is LEFT RUNNING" {
    sim_on
    printf 'fail\n' > "$DK/switch.mode"
    run rb watch_readiness
    [[ "$output" == *"rc=1 reason=switch_failed"* ]]
    [ "$(count 'sim switch ')" = 3 ]
    assert_absent '^sim (down|workers|confirm)' "$SHIM_LOG"
    [ -e "$DK/running.green" ]
    [ "$(sj .hold.kind)" = rollback_failed ]
    [ "$(sj .hold.reason)" = switch_failed ]
    [ "$(sj .phase)" = idle ]
    [ ! -e "${GREMION_ROOT}/data/cd/blocked.json" ]
    assert_present '^sim notify rollback_failed .*reason=switch_failed' "$SHIM_LOG"
    [ ! -e "${GREMION_ROOT}/data/cd/rollback.json" ]
}

@test "switch: two failures and then a success is a rollback (three tries)" {
    sim_on
    printf '2\n' > "$DK/switch.failn"
    run rb watch_readiness
    [[ "$output" == *"rc=0 "* ]]
    [ "$(count 'sim switch ')" = 3 ]
}

# ================================================================= the confirm and the window after it

@test "confirm: a switch that does not show on the edge is a rollback_failed and the new colour stays up" {
    sim_on
    touch "$DK/confirm.fail"
    export CD_ROLLBACK_CONFIRM_TRIES=2
    run rb watch_readiness
    [[ "$output" == *"rc=1 reason=confirm_failed"* ]]
    assert_absent '^sim (down|workers)' "$SHIM_LOG"
    [ -e "$DK/running.green" ]
}

@test "confirm: the public ready-only probe through the real edge must pass too" {
    sim_on
    touch "$DK/pub.fail"
    export CD_ROLLBACK_CONFIRM_TRIES=2
    run rb watch_readiness
    [[ "$output" == *"rc=1 reason=confirm_failed"* ]]
    assert_absent '^sim (down|workers)' "$SHIM_LOG"
}

@test "window: the samples of the watch run on the OLD colour for CD_POST_ROLLBACK_S (180 s, every 15 s)" {
    cd_write_cfg CD_POST_ROLLBACK_S=180
    sim_on
    run rb watch_readiness
    [ "$status" -eq 0 ]
    n="$(count 'sim sample blue '"$OLD_TAG")"
    [ "$n" -ge 11 ]
    [ "$n" -le 13 ]
    assert_absent '^sim sample green' "$SHIM_LOG"
    before 'sim sample blue' 'sim workers green off'
}

@test "window: CD_POST_ROLLBACK_S=0 takes no sample" {
    cd_write_cfg CD_POST_ROLLBACK_S=0
    sim_on
    run rb watch_readiness
    [[ "$output" == *"rc=0 "* ]]
    assert_absent '^sim sample' "$SHIM_LOG"
}

@test "window: a bad streak ends in a critical mail with the note unhealthy_after_rollback and NO further action" {
    cd_write_cfg CD_POST_ROLLBACK_S=180
    sim_on
    printf 'bad\n' > "$DK/sample.seq"
    run rb watch_readiness
    [[ "$output" == *"rc=1 reason=unhealthy_after_rollback"* ]]
    [ "$(count 'sim sample blue')" = 3 ]
    assert_absent '^sim (workers|down)' "$SHIM_LOG"
    assert_present '^sim notify rollback_failed .*notes=unhealthy_after_rollback' "$SHIM_LOG"
    [ "$(sj .hold.kind)" = rollback_failed ]
    [ "$(sj .phase)" = idle ]
    [ ! -e "${GREMION_ROOT}/data/cd/blocked.json" ]
    [ -e "$DK/running.green" ]
}

@test "window: two bad samples and a good one reset the streak" {
    cd_write_cfg CD_POST_ROLLBACK_S=180
    sim_on
    printf 'bad\nbad\nok\nbad\nbad\nok\n' > "$DK/sample.seq"
    run rb watch_readiness
    [[ "$output" == *"rc=0 "* ]]
}

@test "window: a bad sample while a shared service is down neither counts nor resets" {
    cd_write_cfg CD_POST_ROLLBACK_S=60
    sim_on
    printf 'shared\n' > "$DK/sample.seq"
    run rb watch_readiness
    [[ "$output" == *"rc=0 "* ]]
}

@test "window: the 5xx rule counts from the confirm, with the minimum alone when the baseline is null" {
    cd_write_cfg CD_POST_ROLLBACK_S=180
    sim_on
    printf '50\n' > "$DK/fivexx"
    run rb watch_readiness
    [[ "$output" == *"rc=1 reason=unhealthy_after_rollback"* ]]
    assert_present '^sim accesslog_count [0-9]+' "$SHIM_LOG"
}

@test "window: nine 5xx answers are below the minimum" {
    cd_write_cfg CD_POST_ROLLBACK_S=60
    sim_on
    printf '9\n' > "$DK/fivexx"
    run rb watch_readiness
    [[ "$output" == *"rc=0 "* ]]
}

# ================================================================= workers and the stop of the new colour

@test "workers: the new colour goes off, THEN the old colour on, BEFORE the new colour is stopped" {
    sim_on
    run rb watch_readiness
    [ "$status" -eq 0 ]
    before 'sim workers green off' 'sim workers blue on'
    before 'sim workers blue on' 'sim down'
}

@test "stop: the new colour is stopped only after the confirm, from its own tree, and never while it serves" {
    sim_on
    run rb watch_readiness
    [ "$status" -eq 0 ]
    before 'sim confirm blue' "sim down $NEW_TREE green active=blue"
    assert_absent 'DOWN-OF-SERVING' "$SHIM_LOG"
}

@test "stop: the log tail of the new colour is kept under logs/ with mode 0600" {
    sim_on
    run rb watch_readiness
    [ "$status" -eq 0 ]
    f="$(ls "${GREMION_ROOT}"/logs/cd-rollback-"${NEW_TAG}"-*.log)"
    [ -n "$f" ]
    [ "$(stat -c %a "$f")" = 600 ]
    assert_present 'log-tail-marker-zq' "$f"
    [[ "$output" != *"log-tail-marker-zq"* ]]
}

@test "stop: a stop that fails is a warning, the rollback is still done" {
    sim_on
    export RL_SIM="${RL_SIM}"$'\n''cd_colour_down() { _sim_log "down $1 $2"; return 4; }'
    run rb watch_readiness
    [[ "$output" == *"rc=0 "* ]]
    hist_has rollback_stop_failed
    [ "$(sj .phase)" = idle ]
}

@test "the new colour answers nothing at all: no call that needs it is made and the rollback completes" {
    sim_on
    touch "$DK/newdead"
    run rb watch_readiness
    [ "$status" -eq 0 ]
    [[ "$output" == *"rc=0 "* ]]
    assert_absent 'NEWCALL' "$SHIM_LOG"
    [ "$(cat "$DK/active")" = blue ]
    [ "$(sj .hold.kind)" = blocked ]
}

# ================================================================= current, tags, state

@test "current: a manual rollback after the commit point moves current, current-tag and previous-tag back and the state follows" {
    sim_on
    seed_post
    run rb manual_rollback
    [ "$status" -eq 0 ]
    [[ "$output" == *"rc=0 "* ]]
    [ "$(readlink "${GREMION_ROOT}/current")" = "$OLD_TREE" ]
    [ "$(cat "${GREMION_ROOT}/runtime/current-tag")" = "$OLD_TAG" ]
    [ ! -e "${GREMION_ROOT}/runtime/previous-tag" ]
    [ "$(sj .live.tag)" = "$OLD_TAG" ]
    [ "$(sj .live.colour)" = blue ]
    [ "$(sj .live.tree)" = "$OLD_TREE" ]
    [ "$(sj .previous)" = null ]
    [ "$(sj .release)" = null ]
    [ "$(sj .phase)" = idle ]
    # the NEW release (live before) is the one blocked
    [ "$(blocks '.[0].sha')" = "$SHA_NEW" ]
    [ "$(blocks '.[0].rule')" = manual_rollback ]
    [ "$(sj .hold.sha12)" = bbbbbbbbbbbb ]
    # the old colour is the one that was proved, switched to and put on
    assert_present "^sim switch ${OLD_TREE} blue " "$SHIM_LOG"
    assert_present '^sim workers blue on' "$SHIM_LOG"
    assert_present "^sim down ${NEW_TREE} green" "$SHIM_LOG"
}

@test "current: a rollback before the commit point leaves current and the tag files alone when they never moved" {
    sim_on
    ln -sfn "$OLD_TREE" "${GREMION_ROOT}/current"
    printf '%s\n' "$OLD_TAG" > "${GREMION_ROOT}/runtime/current-tag"
    printf '%s\n' "$PREV_TAG" > "${GREMION_ROOT}/runtime/previous-tag"
    run rb watch_readiness
    [ "$status" -eq 0 ]
    [ "$(readlink "${GREMION_ROOT}/current")" = "$OLD_TREE" ]
    [ "$(cat "${GREMION_ROOT}/runtime/current-tag")" = "$OLD_TAG" ]
    [ "$(cat "${GREMION_ROOT}/runtime/previous-tag")" = "$PREV_TAG" ]
    [ "$(sj .live.tag)" = "$OLD_TAG" ]
    [ "$(sj .previous.tag)" = "$PREV_TAG" ]
}

@test "current: commit_stuck after commit step 3 (current and the tags had moved) puts all three back, previous-tag from the state's previous" {
    sim_on
    ln -sfn "$NEW_TREE" "${GREMION_ROOT}/current"
    printf '%s\n' "$NEW_TAG" > "${GREMION_ROOT}/runtime/current-tag"
    printf '%s\n' "$OLD_TAG" > "${GREMION_ROOT}/runtime/previous-tag"
    run rb commit_stuck
    [ "$status" -eq 0 ]
    [[ "$output" == *"rc=0 "* ]]
    [ "$(readlink "${GREMION_ROOT}/current")" = "$OLD_TREE" ]
    [ "$(cat "${GREMION_ROOT}/runtime/current-tag")" = "$OLD_TAG" ]
    [ "$(cat "${GREMION_ROOT}/runtime/previous-tag")" = "$PREV_TAG" ]
    [ "$(sj .live.tag)" = "$OLD_TAG" ]
}

# ================================================================= the isolation record

@test "isolation: a rollback after the commit point re-records the OLD tip" {
    sim_on
    seed_post
    run rb manual_rollback
    [ "$status" -eq 0 ]
    [ "$(count "sim isolation_record ${OLD_TREE}")" = 1 ]
    before 'sim switch' 'sim isolation_record'
}

@test "isolation: a rollback before the commit point does NOT call the isolation record" {
    sim_on
    run rb watch_readiness
    [ "$status" -eq 0 ]
    assert_absent '^sim isolation_' "$SHIM_LOG"
}

@test "isolation: commit_stuck re-records the old tip (commit step 1 had recorded the new tip before the commit point)" {
    sim_on
    run rb commit_stuck
    [ "$status" -eq 0 ]
    assert_present "^sim isolation_record ${OLD_TREE}" "$SHIM_LOG"
}

@test "isolation: a failed record tries a fresh run and then a mail, never a failure of the rollback" {
    sim_on
    seed_post
    touch "$DK/iso.fail"
    run rb manual_rollback
    [ "$status" -eq 0 ]
    [[ "$output" == *"rc=0 "* ]]
    [ "$(count 'sim isolation_run')" = 1 ]
    [ "$(count 'sim isolation_record')" = 2 ]
    assert_present '^sim notify stopped .*reason=isolation_record_failed' "$SHIM_LOG"
    [ "$(sj .phase)" = idle ]
    [ "$(sj .live.tag)" = "$OLD_TAG" ]
}

# ================================================================= block, hold and mail

@test "every rule of the blocked-rule list writes a block and the hold blocked" {
    local rule
    for rule in $BLOCK_RULES; do
        world_new_serves
        seed_pre
        sim_on
        run rb "$rule"
        [ "$status" -eq 0 ]
        [[ "$output" == *"rc=0 "* ]]
        [ "$(blocks length)" = 1 ]
        [ "$(blocks '.[0].rule')" = "$rule" ]
        [ "$(sj .hold.kind)" = blocked ]
        [ "$(sj .hold.reason)" = "$rule" ]
    done
}

@test "proof_end and commit_stuck write NO block" {
    local rule
    for rule in proof_end commit_stuck; do
        world_new_serves
        seed_pre
        sim_on
        run rb "$rule"
        [ "$status" -eq 0 ]
        [ ! -e "${GREMION_ROOT}/data/cd/blocked.json" ]
        [ "$(sj .hold.reason)" = "$rule" ]
    done
    [ "$(sj .hold.kind)" = failure ]
}

@test "proof_end holds as a proof" {
    sim_on
    run rb proof_end
    [ "$status" -eq 0 ]
    [ "$(sj .hold.kind)" = proof ]
}

@test "the block and the hold are written BEFORE the mail is queued" {
    sim_on
    run rb watch_5xx
    [ "$status" -eq 0 ]
    assert_present '^sim notify rolled_back .*\[blocks=1 hold=blocked\]$' "$SHIM_LOG"
}

@test "the rolled_back mail carries the release, the colours and the rule" {
    sim_on
    run rb watch_5xx
    assert_present '^sim notify rolled_back key=bbbbbbbbbbbb-1-rolled_back sha12=bbbbbbbbbbbb prev_sha12=aaaaaaaaaaaa tag=pilot-bbbbbbbbbbbb colour=green prev_colour=blue rule=watch_5xx stage=watch command=gremion-cd status observed_min=5' "$SHIM_LOG"
}

@test "a mail that cannot be sent does not change the result" {
    sim_on
    touch "$DK/notify.fail"
    run rb watch_readiness
    [ "$status" -eq 0 ]
    [[ "$output" == *"rc=0 "* ]]
    [ "$(sj .phase)" = idle ]
    [ "$(sj .hold.kind)" = blocked ]
}

# ================================================================= refusals

@test "an unknown rule and a missing rule are refused with 2 and nothing is touched" {
    sim_on
    before_fp="$(fingerprint)"
    run rl 'rc=0; cd_rollback_run stuck_stage || rc=$?; echo "rc=$rc"'
    [[ "$output" == *"rc=2"* ]]
    run rl 'rc=0; cd_rollback_run || rc=$?; echo "rc=$rc"'
    [[ "$output" == *"rc=2"* ]]
    [ "$(fingerprint)" = "$before_fp" ]
}

@test "THE LINE: a COMMITTED release refuses every rule except manual_rollback with 2 and touches nothing" {
    local rule
    sim_on
    seed_post
    before_fp="$(fingerprint)"
    for rule in $BLOCK_RULES proof_end commit_stuck; do
        [ "$rule" = manual_rollback ] && continue
        run rb "$rule"
        [ "$status" -eq 0 ]
        [[ "$output" == *"rc=2 "* ]] || { echo "rule $rule: $output" >&2; return 1; }
        [ "$(fingerprint)" = "$before_fp" ]
    done
    [ ! -e "${GREMION_ROOT}/data/cd/blocked.json" ]
    [ ! -s "$SHIM_LOG" ] || { cat "$SHIM_LOG" >&2; return 1; }
}

@test "THE LINE: manual_rollback of a committed release still runs the whole sequence, including the move of current back" {
    sim_on
    seed_post
    run rb manual_rollback
    [[ "$output" == *"rc=0 "* ]]
    [ "$(readlink "${GREMION_ROOT}/current")" = "$OLD_TREE" ]
    assert_present '^sim switch ' "$SHIM_LOG"
    assert_present '^sim down ' "$SHIM_LOG"
}

@test "THE LINE: only the committed marker decides: an aborted release record in an idle state is not 'in flight'" {
    sim_on
    seed_idle '.release = {"id":"eeeeeeeeeeee-1","sha":"'"$(printf 'e%.0s' $(seq 1 40))"'","sha12":"eeeeeeeeeeee","tag":"pilot-eeeeeeeeeeee","colour":"green","tree":"'"$NEW_TREE"'","mode":"auto","stage":"gates","stage_status":"failed","committed_at":null}'
    before_fp="$(fingerprint)"
    run rb watch_readiness
    [[ "$output" == *"rc=2 "* ]]
    [ "$(fingerprint)" = "$before_fp" ]
}

@test "nothing in flight: only manual_rollback may go back one release, the rest is refused" {
    sim_on
    seed_idle
    before_fp="$(fingerprint)"
    run rb watch_readiness
    [[ "$output" == *"rc=2 "* ]]
    [ "$(fingerprint)" = "$before_fp" ]
}

@test "manual rollback of an idle host (no release in the state): the sequence runs on a record made for it" {
    sim_on
    seed_idle
    run rb manual_rollback
    [ "$status" -eq 0 ]
    [[ "$output" == *"rc=0 "* ]]
    # the switch needs a release in the state: it named the release being left
    assert_present '^sim switch .* phase=rolling_back rid=bbbbbbbbbbbb-[0-9]+$' "$SHIM_LOG"
    [ "$(sj .release)" = null ]
    [ "$(sj .live.tag)" = "$OLD_TAG" ]
    [ "$(sj .previous)" = null ]
    [ "$(blocks '.[0].sha')" = "$SHA_NEW" ]
    [ "$(readlink "${GREMION_ROOT}/current")" = "$OLD_TREE" ]
}

@test "a manual rollback with nothing to go back to is refused with 2" {
    sim_on
    seed_idle '.previous = null'
    before_fp="$(fingerprint)"
    run rb manual_rollback
    [[ "$output" == *"rc=2 "* ]]
    [ "$(fingerprint)" = "$before_fp" ]
}

# ================================================================= resume and concurrency

@test "resume: a kill after ANY step, then a second run, ends in the same state and the switch is written once" {
    local m
    for m in $STEPS; do
        world_new_serves
        seed_pre
        sim_on
        export GREMION_CD_ROLLBACK_KILL_AFTER="$m"
        run rb watch_5xx
        [ "$status" -eq 137 ] || { echo "kill after $m: status $status: $output" >&2; return 1; }
        [ -e "${GREMION_ROOT}/data/cd/rollback.json" ]
        unset GREMION_CD_ROLLBACK_KILL_AFTER
        run rb watch_5xx
        [[ "$output" == *"rc=0 "* ]] || { echo "resume after $m: $output" >&2; return 1; }
        [ "$(count 'sim switch ')" = 1 ] || { echo "kill after $m: switch count $(count 'sim switch ')" >&2; return 1; }
        [ "$(count 'sim notify rolled_back')" = 1 ] || { echo "kill after $m: mail count" >&2; return 1; }
        [ "$(cat "$DK/active")" = blue ]
        [ ! -e "$DK/running.green" ]
        [ "$(sj .phase)" = idle ]
        [ "$(sj .release)" = null ]
        [ "$(sj .hold.kind)" = blocked ]
        [ "$(sj .hold.reason)" = watch_5xx ]
        [ "$(blocks length)" = 1 ]
        [ "$(cat "${GREMION_ROOT}/runtime/workers/blue")" = on ]
        [ "$(cat "${GREMION_ROOT}/runtime/workers/green")" = off ]
        [ ! -e "${GREMION_ROOT}/data/cd/rollback.json" ]
    done
}

@test "resume: after a kill in a committed rollback, the second run still has the sides of the first (the state already moved)" {
    sim_on
    seed_post
    export GREMION_CD_ROLLBACK_KILL_AFTER=current
    run rb manual_rollback
    [ "$status" -eq 137 ]
    # the state's live is already the old release: only the sidecar still knows what was left
    [ "$(sj .live.tag)" = "$OLD_TAG" ]
    unset GREMION_CD_ROLLBACK_KILL_AFTER
    run rb manual_rollback
    [[ "$output" == *"rc=0 "* ]]
    [ "$(sj .live.tag)" = "$OLD_TAG" ]
    [ "$(blocks length)" = 1 ]
    [ "$(blocks '.[0].sha')" = "$SHA_NEW" ]
    [ "$(count 'sim isolation_record')" = 1 ]
}

@test "resume: the rule of the first run wins whatever the second caller passes" {
    sim_on
    export GREMION_CD_ROLLBACK_KILL_AFTER=old
    run rb watch_5xx
    [ "$status" -eq 137 ]
    unset GREMION_CD_ROLLBACK_KILL_AFTER
    run rb watch_crash
    [[ "$output" == *"rc=0 "* ]]
    [ "$(blocks '.[0].rule')" = watch_5xx ]
    hist_has rollback_resumed
}

@test "resume: a sidecar of another release or of a rollback that is over is not honoured" {
    sim_on
    jq -cn '{v: 1, ctx: {rule: "watch_crash", committed: false, release_id: "ffffffffffff-9", stage: "watch", synth: false, prev_tag: "",
            new: {sha: "x", sha12: "ffffffffffff", tag: "pilot-ffffffffffff", colour: "green", tree: "/x"},
            old: {sha: "y", sha12: "eeeeeeeeeeee", tag: "pilot-eeeeeeeeeeee", colour: "blue", tree: "/y"}}, steps: ["record", "old"]}' \
        > "${GREMION_ROOT}/data/cd/rollback.json"
    run rb watch_5xx
    [[ "$output" == *"rc=0 "* ]]
    [ "$(blocks '.[0].sha')" = "$SHA_NEW" ]
    [ "$(blocks '.[0].rule')" = watch_5xx ]
    assert_present "^sim switch ${OLD_TREE} blue" "$SHIM_LOG"
}

@test "a second cd_rollback_run while one is running returns 3 and changes nothing" {
    cd_need_flock
    sim_on
    printf 'hang\n' > "$DK/switch.mode"
    ( rbn watch_readiness > "${GREMION_ROOT}/.first.out" 2>&1 ) 3>&- &
    first=$!
    for i in $(seq 1 100); do
        grep -q '^sim switch ' "$SHIM_LOG" 2>/dev/null && break
        sleep 0.1
    done
    assert_present '^sim switch ' "$SHIM_LOG"
    before_fp="$(sj .phase)$(wc -l < "$SHIM_LOG")"
    run rl_nolock 'rc=0; cd_rollback_run watch_readiness || rc=$?; echo "rc=$rc"'
    [[ "$output" == *"rc=3"* ]]
    [ "$(sj .phase)$(wc -l < "$SHIM_LOG")" = "$before_fp" ]
    wait "$first"
    grep -q 'rc=0' "${GREMION_ROOT}/.first.out"
}

# ================================================================= previous after a pre-commit rollback

@test "previous: after a pre-commit rollback the target env's IMAGE_TAG is restored and previous is startable again" {
    export RL_LIBS="docker prepare" RL_REAL_PREPARE=1
    sim_on
    # release N+1 retagged green (previous N-1 was on green) and aborted
    sed -i 's/^IMAGE_TAG=.*/IMAGE_TAG='"$NEW_TAG"'/' "${GREMION_ROOT}/etc/env/app-green.env"
    seed_pre '.release.retag_prev = "'"$PREV_TAG"'" | .previous.startable = false'
    run rb watch_readiness
    [ "$status" -eq 0 ]
    [[ "$output" == *"rc=0 "* ]]
    [ "$(grep '^IMAGE_TAG=' "${GREMION_ROOT}/etc/env/app-green.env")" = "IMAGE_TAG=${PREV_TAG}" ]
    [ "$(sj .previous.startable)" = true ]
}

@test "previous: when the env file cannot be restored startable stays false and a manual rollback of the idle host refuses with the message" {
    export RL_LIBS="docker prepare" RL_REAL_PREPARE=1
    sim_on
    export RL_SIM="${RL_SIM}"$'\n''cd_set_env_key() { return 1; }'
    sed -i 's/^IMAGE_TAG=.*/IMAGE_TAG='"$NEW_TAG"'/' "${GREMION_ROOT}/etc/env/app-green.env"
    seed_pre '.release.retag_prev = "'"$PREV_TAG"'" | .previous.startable = false'
    run rb watch_readiness
    [[ "$output" == *"rc=0 "* ]]
    hist_has rollback_retag_not_restored
    [ "$(sj .previous.startable)" = false ]
    [ "$(sj .phase)" = idle ]
    # idle: live is the old release, previous is the one that could not be restored
    : > "$SHIM_LOG"
    before_fp="$(fingerprint)"
    run rb manual_rollback
    [[ "$output" == *"rc=2 "* ]]
    [[ "$output" == *"cannot be started"* ]]
    [[ "$output" == *"adopt --re-adopt"* ]]
    [ "$(fingerprint)" = "$before_fp" ]
}

@test "previous: a COMMITTED rollback restores nothing (the retag record belongs to the release that was committed)" {
    sim_on
    seed_post '.release.retag_prev = "'"$PREV_TAG"'"'
    run rb manual_rollback
    [ "$status" -eq 0 ]
    assert_absent '^sim retag_restore' "$SHIM_LOG"
}

@test "previous: before the commit point the restore is called after the new colour is stopped" {
    sim_on
    run rb watch_readiness
    [ "$status" -eq 0 ]
    before 'sim down' 'sim retag_restore'
    before 'sim retag_restore' 'sim notify rolled_back'
}

# ================================================================= the REAL mail

@test "the mails use only fields the notifier allows: nothing is redacted or dropped" {
    export RL_LIBS="docker notify" RL_REAL_NOTIFY=1
    sim_on
    run rb watch_5xx
    [ "$status" -eq 0 ]
    [[ "$output" == *"rc=0 "* ]]
    f="$(ls "${GREMION_ROOT}"/data/cd/outbox/*-rolled_back.eml)"
    assert_present '^kind: rolled_back' "$f"
    assert_present '^sha12: bbbbbbbbbbbb' "$f"
    assert_present '^prev_sha12: aaaaaaaaaaaa' "$f"
    assert_present '^rule: watch_5xx' "$f"
    assert_present '^stage: watch' "$f"
    assert_absent 'redacted' "$f"
    # the failed one
    world_new_serves
    seed_pre
    printf 'fail\n' > "$DK/switch.mode"
    run rb watch_5xx
    [[ "$output" == *"rc=1 "* ]]
    f="$(ls "${GREMION_ROOT}"/data/cd/outbox/*-rollback_failed.eml)"
    assert_present '^reason: switch_failed' "$f"
    assert_present '^rule: watch_5xx' "$f"
    assert_absent 'redacted' "$f"
}

# ================================================================= THE LINE with the real traffic.sh and colour.sh

# A fake Traefik and a gremion-switch inside each fake release tree, as in cd-traffic.bats. The real
# cd_traffic_switch, cd_traffic_truth, cd_traffic_confirm and cd_colour_down (with its guard) run; the
# probes of the colours are stand-ins. Every event lands in ONE ordered log, $DK/order.log.
line_world() {
    local t
    world_new_serves
    seed_pre
    export RL_LIBS="docker colour traffic"
    export RL_SIM="$(sim_common)"$'\n''cd_wait_healthy() { _sim_log "wait_healthy ${1#app-}"; return 0; }'
    for t in "$OLD_TREE" "$NEW_TREE"; do
        mkdir -p "${t}/infra/host/bin" "${t}/infra/host/templates/edge"
        printf '# active.yml.tmpl (a fake)\n' > "${t}/infra/host/templates/edge/active.yml.tmpl"
        cat > "${t}/infra/host/bin/gremion-switch" <<'SWITCH'
#!/usr/bin/env bash
colour="$1"
mode="$(cat "$DK/switch.mode.$colour" 2>/dev/null || echo ok)"
printf 'switch %s mode=%s from=%s\n' "$colour" "$mode" "$(dirname "$(dirname "$(dirname "$0")")")" >> "$DK/order.log"
point() {
    local pair name svc u
    for pair in app@file:gremion-ui public@file:gremion-public panel@file:control-panel; do
        name="${pair%%:*}"; svc="${pair##*:}"; u="http://${svc}-${colour}:3000"
        jq -cn --arg u "$u" '{loadBalancer: {servers: [{url: $u}]}, serverStatus: {($u): "UP"}}' > "$DK/traefik.${name}"
    done
    printf 'active=%s\n' "$colour" > "$GREMION_ROOT/etc/edge/active.yml"
}
case "$mode" in
    ok) point; printf '%s\n' "$colour" > "$GREMION_ROOT/runtime/active-colour" ;;
    write_then_fail) point; echo "poll failed" >&2; exit 1 ;;
    fail) exit 2 ;;
esac
exit 0
SWITCH
        chmod +x "${t}/infra/host/bin/gremion-switch"
    done
    # before the switch: blue serves (the file and the edge say so), green is the next route
    point_edge blue
    printf '%s\n' blue > "${GREMION_ROOT}/runtime/active-colour"
    shim curl "$(cat <<'EOF'
(IFS='|'; a="$*"; printf '%s\n' "${a//$'\n'/ }" >> "$DK/curl.log")
url="${@: -1}"; hdr=''; prev=''
for a in "$@"; do case "$prev" in -D) hdr="$a" ;; esac; prev="$a"; done
case "$url" in
  */api/http/services/*)
    f="$DK/traefik.${url##*/api/http/services/}"
    [ -f "$f" ] || { echo "curl: (22) 404" >&2; exit 22; }
    cat "$f" ;;
  */api/http/routers*)
    [ -n "$hdr" ] && printf 'HTTP/1.1 200 OK\r\nX-Next-Page: 1\r\n\r\n' > "$hdr"
    cat "$DK/routers.json" ;;
  */readyz) printf '{"ready":true}\n200' ;;
  *) exit 7 ;;
esac
exit 0
EOF
)"
    shim docker 'case "$1" in
  compose)
    envf=""; prev=""
    for a in "$@"; do [ "$prev" = "--env-file" ] && envf="$a"; prev="$a"; done
    case " $* " in
      *" down"*|*" down ") printf "down %s active=%s\n" "$(basename "$envf" .env)" "$(cat "$GREMION_ROOT/runtime/active-colour")" >> "$DK/order.log" ;;
    esac ;;
  logs) echo log-tail-marker-zq ;;
esac
exit 0'
    jq -cn '[
      {name: "api@internal", rule: "PathPrefix(`/api`)", status: "enabled", service: "api@internal"},
      {name: "test-app@file", rule: "HostRegexp(`.+`)", status: "enabled", service: "app-next@file"},
      {name: "portal@docker", rule: "Host(`example.org`)", status: "enabled", service: "public@file"}
    ]' > "$DK/routers.json"
}

# point_edge COLOUR -- Traefik shows COLOUR on every service and the OTHER one as the next route.
point_edge() {
    local c="$1" o u pair name svc
    [ "$c" = green ] && o=blue || o=green
    for pair in app@file:gremion-ui public@file:gremion-public panel@file:control-panel; do
        name="${pair%%:*}"; svc="${pair##*:}"; u="http://${svc}-${c}:3000"
        jq -cn --arg u "$u" '{loadBalancer: {servers: [{url: $u}]}, serverStatus: {($u): "UP"}}' > "$DK/traefik.${name}"
    done
    u="http://gremion-ui-${o}:3000"
    jq -cn --arg u "$u" '{loadBalancer: {servers: [{url: $u}]}, serverStatus: {($u): "UP"}}' > "$DK/traefik.app-next@file"
}

@test "THE LINE: the switch writes the edge file for the new colour and exits 1; the rollback ends with the old colour serving and the new colour is stopped only AFTER the confirm, never while Traefik names it" {
    line_world
    printf 'write_then_fail\n' > "$DK/switch.mode.green"
    run rl 'cd_traffic_switch "$NEW_TREE" green || echo "forward switch failed rc=$?"
rc=0; cd_rollback_run post_switch_verify || rc=$?; echo "rc=$rc reason=$CD_ROLLBACK_REASON"'
    echo "$output"
    [[ "$output" == *"forward switch failed rc=1"* ]]
    [[ "$output" == *"rc=0 reason="* ]]
    # the end state: the file, active-colour and Traefik agree on the old colour
    [ "$(cat "${GREMION_ROOT}/runtime/active-colour")" = blue ]
    [ "$(jq -r '.loadBalancer.servers[0].url' "$DK/traefik.panel@file")" = "http://control-panel-blue:3000" ]
    [ "$(jq -r '.loadBalancer.servers[0].url' "$DK/traefik.app@file")" = "http://gremion-ui-blue:3000" ]
    [ "$(jq -r '.loadBalancer.servers[0].url' "$DK/traefik.public@file")" = "http://gremion-public-blue:3000" ]
    assert_present '^active=blue' "${GREMION_ROOT}/etc/edge/active.yml"
    # the order of the events
    assert_present "^switch green mode=write_then_fail from=${NEW_TREE}" "$DK/order.log"
    assert_present "^switch blue mode=ok from=${OLD_TREE}" "$DK/order.log"
    assert_present '^down app-green active=blue$' "$DK/order.log"
    # the colour that Traefik named is never taken down: no `down` while the file says green
    assert_absent '^down app-green active=green' "$DK/order.log"
    a="$(grep -n '^switch blue' "$DK/order.log" | cut -d: -f1)"
    d="$(grep -n '^down app-green' "$DK/order.log" | cut -d: -f1)"
    [ "$a" -lt "$d" ]
    # and no down of the old colour at all
    assert_absent '^down app-blue' "$DK/order.log"
}

@test "THE LINE: a switch that ran out of its three tries leaves the new colour up and writes no down at all" {
    line_world
    printf 'write_then_fail\n' > "$DK/switch.mode.green"
    printf 'fail\n' > "$DK/switch.mode.blue"
    run rl 'cd_traffic_switch "$NEW_TREE" green || true
rc=0; cd_rollback_run post_switch_verify || rc=$?; echo "rc=$rc reason=$CD_ROLLBACK_REASON"'
    [[ "$output" == *"rc=1 reason=switch_failed"* ]]
    assert_absent '^down ' "$DK/order.log"
    [ "$(grep -c '^switch blue' "$DK/order.log")" = 3 ]
    [ "$(sj .hold.kind)" = rollback_failed ]
}

@test "THE LINE: cd_colour_down itself refuses the colour the edge names (the guard the rollback leans on)" {
    line_world
    point_edge green
    run rl 'rc=0; cd_colour_down "$NEW_TREE" green || rc=$?; echo "rc=$rc"'
    [[ "$output" == *"rc=1"* ]]
    # no event at all: the log is absent or empty
    [ ! -s "$DK/order.log" ]
}

@test "confirm with the real cd_traffic_confirm: an old colour on app only is NOT confirmed (all three services)" {
    line_world
    printf 'write_then_fail\n' > "$DK/switch.mode.green"
    # the switch back moves app@file but leaves public@file on green
    cat > "${OLD_TREE}/infra/host/bin/gremion-switch" <<'SWITCH'
#!/usr/bin/env bash
printf 'switch %s half\n' "$1" >> "$DK/order.log"
u="http://gremion-ui-$1:3000"
jq -cn --arg u "$u" '{loadBalancer: {servers: [{url: $u}]}, serverStatus: {($u): "UP"}}' > "$DK/traefik.app@file"
printf '%s\n' "$1" > "$GREMION_ROOT/runtime/active-colour"
exit 0
SWITCH
    export CD_ROLLBACK_CONFIRM_TRIES=2
    run rl 'cd_traffic_switch "$NEW_TREE" green || true
rc=0; cd_rollback_run post_switch_verify || rc=$?; echo "rc=$rc reason=$CD_ROLLBACK_REASON"'
    [[ "$output" == *"rc=1 reason=confirm_failed"* ]]
    assert_absent '^down ' "$DK/order.log"
}
