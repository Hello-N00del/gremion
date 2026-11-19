#!/usr/bin/env bats
# test/host/cd-watch.bats -- cd-watch: infra/host/lib/cd/watch.sh, the sample, the access log
# counter and the trigger evaluation of the continuous deployment program. No loop is tested
# here (commit.sh owns it).
#
# Run: MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W):/repo:ro" -w /repo gremion-bats:local test/host/cd-watch.bats
#
# Nothing here touches a real docker, curl, Traefik or network: docker, curl and timeout are
# recording shims whose answers are files under $DK, the host layout is a temp $GREMION_ROOT,
# the clock is the fake clock of test_helper/cd. The real watch.sh runs on the real core.sh and
# docker.sh; the functions of colour.sh are stand-ins (fixtures/cd/watch/fakes.sh) that read
# files, so each test decides what the colour answers. Every name is a reserved example name.

bats_require_minimum_version 1.5.0
load 'test_helper/host'
load 'test_helper/cd'

FIX="${BATS_TEST_DIRNAME}/fixtures/cd/watch"
TAG_NEW="pilot-bbbbbbbbbbbb"
LOG_MARKER="/marker-secret-path-of-a-customer"

setup() {
    cd_setup
    export STACK=teststack
    unset CD_DC_TIMEOUT CD_WATCH_DEADLINE
    DK="${SHIM_DIR}/dk"
    export DK FIX
    mkdir -p "$DK" "${GREMION_ROOT}/releases/bbbbbbbbbbbb" "${GREMION_ROOT}/releases/aaaaaaaaaaaa"
    TREE="${GREMION_ROOT}/releases/bbbbbbbbbbbb"
    export TREE
    cp "${FIX}/state.env" "${GREMION_ROOT}/etc/env/state.env"
    cp "${FIX}/app-blue.env" "${GREMION_ROOT}/etc/env/app-blue.env"
    cp "${FIX}/app-green.env" "${GREMION_ROOT}/etc/env/app-green.env"
    REAL_TIMEOUT="$(type -P timeout)"
    export REAL_TIMEOUT
    shim_docker
    shim_curl
    shim timeout 'export CD_TEST_VIA_TIMEOUT=1; exec "$REAL_TIMEOUT" "$@"'
}

teardown() {
    cd_teardown
}

# ------------------------------------------------------------------ the shims

# docker. Answers are files in $DK:
#   cid.<project>.<service>   the id of a service's container (ps --filter service)
#   cids.<project>            every container of a project, one id per line (ps -a)
#   cont.<id>                 "<state> <exit code> <health> <restart count>" (inspect)
#   access.log                what `docker exec <traefik> tail` prints
#   log.fail                  the exec fails; ps.fail / inspect.fail: those calls fail
# docker.log has one line per call: the args, then bounded=1 when `timeout` wrapped the call.
shim_docker() {
    shim docker "$(cat <<'EOF'
(IFS='|'; printf '%s|bounded=%s\n' "$*" "${CD_TEST_VIA_TIMEOUT:-0}" >> "$DK/docker.log")
case "$1" in
  ps)
    proj=''; svc=''
    for a in "$@"; do
      case "$a" in
        label=com.docker.compose.project=*) proj="${a#label=com.docker.compose.project=}" ;;
        label=com.docker.compose.service=*) svc="${a#label=com.docker.compose.service=}" ;;
      esac
    done
    [ -f "$DK/ps.fail" ] && exit 1
    if [ -n "$svc" ]; then [ -f "$DK/cid.$proj.$svc" ] && cat "$DK/cid.$proj.$svc"
    else [ -f "$DK/cids.$proj" ] && cat "$DK/cids.$proj"; fi
    exit 0 ;;
  inspect)
    [ -f "$DK/inspect.fail" ] && exit 1
    cat "$DK/cont.${@: -1}" 2>/dev/null || exit 1
    exit 0 ;;
  exec)
    [ "$2" = "$(cat "$DK/cid.teststack-state.traefik" 2>/dev/null)" ] || exit 1
    [ -f "$DK/log.fail" ] && exit 1
    cat "$DK/access.log" 2>/dev/null
    exit 0 ;;
esac
exit 0
EOF
)"
}

# curl. Answers are files in $DK, "<status>|<body>" (the word TIMEOUT: no answer, exit 28):
#   pub.readyz pub.login   the public probe (the request carries --resolve)
#   old.readyz             the loopback route, the old colour
#   traefik.<name>         the JSON of a service, traefik.down: the API does not answer
shim_curl() {
    shim curl "$(cat <<'EOF'
(IFS='|'; printf '%s\n' "$*" >> "$DK/curl.log")
url="${@: -1}"; out=''; wfmt=''; prev=''; res=0
for a in "$@"; do
  case "$prev" in -o) out="$a" ;; -w) wfmt="$a" ;; esac
  [ "$a" = "--resolve" ] && res=1
  prev="$a"
done
reply() { # FILE
  local line status body
  [ -f "$1" ] || { echo "curl: (7) Failed to connect" >&2; exit 7; }
  line="$(cat "$1")"
  if [ "$line" = TIMEOUT ]; then
    case "$wfmt" in *http_code*) printf '000' ;; esac
    echo "curl: (28) Operation timed out" >&2; exit 28
  fi
  status="${line%%|*}"; body="${line#*|}"
  [ -n "$out" ] && printf '%s' "$body" > "$out"
  case "$wfmt" in
    $'\n'*) printf '%s\n%s' "$body" "$status" ;;
    *http_code*) printf '%s' "$status" ;;
    *) printf '%s' "$body" ;;
  esac
}
case "$url" in
  */api/version)
    [ -f "$DK/traefik.down" ] && { echo "curl: (7) Failed to connect" >&2; exit 7; }
    echo '{"Version":"3"}' ;;
  */api/http/services/*)
    [ -f "$DK/traefik.down" ] && { echo "curl: (7) Failed to connect" >&2; exit 7; }
    f="$DK/traefik.${url##*/api/http/services/}"
    [ -f "$f" ] || { echo "curl: (22) 404" >&2; exit 22; }
    cat "$f" ;;
  *127.0.0.1*/readyz) reply "$DK/old.readyz" ;;
  */readyz) [ "$res" = 1 ] && reply "$DK/pub.readyz" || exit 7 ;;
  */auth/login) [ "$res" = 1 ] && reply "$DK/pub.login" || exit 7 ;;
  *) exit 7 ;;
esac
exit 0
EOF
)"
}

# --------------------------------------------------------------- the world

# set_svc NAME SVC COLOUR [STATUS] -- the Traefik service NAME has one server SVC-COLOUR.
set_svc() {
    local url="http://${2}-${3}:3000"
    jq -cn --arg u "$url" --arg s "${4:-UP}" '{loadBalancer: {servers: [{url: $u}]}, serverStatus: {($u): $s}}' > "${DK}/traefik.${1}"
}

# world_good -- everything about the new colour (green) is fine, the old one (blue) is ready.
world_good() {
    printf '200|{"ready":true}' > "${DK}/pub.readyz"
    printf '302|' > "${DK}/pub.login"
    printf '200|{"ready":true}' > "${DK}/old.readyz"
    printf 'tr1\n' > "${DK}/cid.teststack-state.traefik"
    : > "${DK}/access.log"
    jq -cn '{ready: true, colour: "green", release: "pilot-bbbbbbbbbbbb", tenants: {total: 3, notReady: 0}, reasons: []}' > "${DK}/probe.green"
    printf 'g1\ng2\n' > "${DK}/cids.teststack-app-green"
    printf 'running 0 healthy 0\n' > "${DK}/cont.g1"
    printf 'running 0 nohealthcheck 0\n' > "${DK}/cont.g2"
    set_svc app@file gremion-ui green
    set_svc public@file gremion-public green
    set_svc app-next@file gremion-ui blue
    printf 'on' > "${DK}/workers.green"
    printf 'off' > "${DK}/workers.blue"
}

NOW0=1700000000

# seed [WATCH_JSON] -- the state: a release on green, switched 600 seconds ago, watching.
# WATCH_JSON is merged over the zero counters (baselines 0).
seed() {
    local w="${1:-}" sw
    [[ -n "$w" ]] || w='{}'
    sw="$(date -u -d "@$(($(cd_clock) - ${SWITCH_AGO:-600}))" +%Y-%m-%dT%H:%M:%SZ)"
    cd_seed_state '.phase = "watching" | .live = '"$CD_LIVE_JSON"' | .release = {
        "id":"bbbbbbbbbbbb-1","sha":"'"$(printf 'b%.0s' $(seq 1 40))"'","sha12":"bbbbbbbbbbbb","tag":"'"$TAG_NEW"'",
        "colour":"green","tree":"'"$TREE"'","mode":"auto","stage":"watch","stage_status":"started","switched_at":"'"$sw"'",
        "watch":({"observed_s":0,"samples":0,"bad_streak":0,"paused_s":0,"blind":0,"requests":0,"baseline_5xx":0,"baseline_not_ready":0,"last_sample_epoch":0} + '"$w"')}'
}

# logl SERVICE ROUTER STATUS AGE_S [COUNT] -- COUNT access log lines of the edge, AGE_S old.
logl() {
    local i n="${5:-1}" t
    t=$(($(cd_clock) - $4))
    for ((i = 0; i < n; i++)); do
        jq -cn --arg s "$1" --arg r "$2" --argjson st "$3" --argjson t "$t" --arg p "$LOG_MARKER" \
            '{ServiceName: $s, RouterName: $r, DownstreamStatus: $st, RequestPath: $p, RequestHost: "tenant.example.org", ClientHost: "198.51.100.7",
              StartUTC: ($t | todate | sub("Z$"; ".123456789Z")), time: ($t | todate)}' >> "${DK}/access.log"
    done
}

# wl 'snippet' -- a fresh bash with the real core.sh, docker.sh and watch.sh, then the stubs
# of the other units, then the file-driven stand-ins (use with `run`). The cd lock is claimed
# by hand (CD_LOCK_PID) so no flock is needed.
wl() {
    bash -c "set -euo pipefail
. \"\${HOST_SRC}/lib/common.sh\"
. \"\${HOST_SRC}/lib/cd/core.sh\"
. \"\${HOST_SRC}/lib/cd/cmd-state.sh\"
. \"\${HOST_SRC}/lib/cd/docker.sh\"
. \"\${HOST_SRC}/lib/cd/watch.sh\"
. \"\${GREMION_CD_STUBS_DIR}/cd-stubs.sh\"
. \"\${FIX}/fakes.sh\"
CD_LOCK_PID=\$\$
cd_cfg_load
${1}" wl
}

# wl_plain 'snippet' -- the same WITHOUT the stand-ins: every function of another unit is the
# default stub of test_helper/cd (exit 0, no output).
wl_plain() {
    bash -c "set -euo pipefail
. \"\${HOST_SRC}/lib/common.sh\"
. \"\${HOST_SRC}/lib/cd/core.sh\"
. \"\${HOST_SRC}/lib/cd/cmd-state.sh\"
. \"\${HOST_SRC}/lib/cd/docker.sh\"
. \"\${HOST_SRC}/lib/cd/watch.sh\"
. \"\${GREMION_CD_STUBS_DIR}/cd-stubs.sh\"
CD_LOCK_PID=\$\$
cd_cfg_load
${1}" wl
}

# ev 'JQ FILTER' -- evaluate the good sample with FILTER applied (at = the fake clock).
ev() {
    S="$(jq -c --argjson at "$(cd_clock)" ".at = \$at | ${1:-(.)}" "${FIX}/sample-good.json")"
    export S
    run --separate-stderr wl 'cd_watch_eval "$S"'
}

sw() { jq -r ".release.watch.$1" "${GREMION_ROOT}/data/cd/state.json"; }
adv() { cd_advance "${1:-15}"; }

# a failing readiness sample (public probe down)
BAD='.public.ok = false | .public.readyz = "503"'

# ================================================================= the public probe

@test "probe_public: the argv is --resolve host:443:edge, https, no -k, every call bounded" {
    world_good
    run --separate-stderr wl 'cd_watch_probe_public'
    [ "$status" -eq 0 ]
    [ "$output" = "200 302" ]
    run grep -c 'https://app.example.org/readyz' "${DK}/curl.log"
    [ "$output" = 1 ]
    grep -q -- '--resolve|app.example.org:443:203.0.113.10' "${DK}/curl.log"
    grep -q 'https://app.example.org/auth/login' "${DK}/curl.log"
    run grep -cE -- '(^|\|)(-k|--insecure)(\||$)' "${DK}/curl.log"
    [ "$output" = 0 ]
    local t
    while IFS= read -r t; do
        [[ "$t" =~ --max-time\|([0-9]+)\| ]]
        [ "${BASH_REMATCH[1]}" -le 12 ]
    done < "${DK}/curl.log"
}

@test "probe_public: ready only for 200 with exactly {\"ready\":true} and a login page below 500" {
    world_good
    printf '503|{"ready":false}' > "${DK}/pub.readyz"
    run --separate-stderr wl 'cd_watch_probe_public'
    [ "$status" -eq 1 ]
    [ "$output" = "503 302" ]
    printf '200|{"ready":false}' > "${DK}/pub.readyz"
    run --separate-stderr wl 'cd_watch_probe_public'
    [ "$status" -eq 1 ]
    printf '200|{"ready":true,"colour":"green"}' > "${DK}/pub.readyz"
    run --separate-stderr wl 'cd_watch_probe_public'
    [ "$status" -eq 1 ]
    printf '200|not json' > "${DK}/pub.readyz"
    run --separate-stderr wl 'cd_watch_probe_public'
    [ "$status" -eq 1 ]
    printf '200|{"ready":true}' > "${DK}/pub.readyz"
    printf '500|' > "${DK}/pub.login"
    run --separate-stderr wl 'cd_watch_probe_public'
    [ "$status" -eq 1 ]
    [ "$output" = "200 500" ]
    printf '404|' > "${DK}/pub.login"
    run --separate-stderr wl 'cd_watch_probe_public'
    [ "$status" -eq 0 ]
}

@test "probe_public: a timeout is bad, never a pass or a gap" {
    world_good
    printf 'TIMEOUT' > "${DK}/pub.readyz"
    run --separate-stderr wl 'cd_watch_probe_public'
    [ "$status" -eq 1 ]
    [ "$output" = "000 302" ]
    printf '200|{"ready":true}' > "${DK}/pub.readyz"
    printf 'TIMEOUT' > "${DK}/pub.login"
    run --separate-stderr wl 'cd_watch_probe_public'
    [ "$status" -eq 1 ]
    [ "$output" = "200 000" ]
}

@test "probe_public: the probe host comes from etc/tenant-hosts.txt when CD_PROBE_HOST is not set" {
    world_good
    grep -v '^CD_PROBE_HOST=' "${GREMION_ROOT}/etc/cd.env" > "${GREMION_ROOT}/etc/cd.env.new"
    mv "${GREMION_ROOT}/etc/cd.env.new" "${GREMION_ROOT}/etc/cd.env"
    printf '# the hosts\n\nfallback.example.org extra\n' > "${GREMION_ROOT}/etc/tenant-hosts.txt"
    run --separate-stderr wl 'cd_watch_probe_public'
    [ "$status" -eq 0 ]
    grep -q -- '--resolve|fallback.example.org:443:203.0.113.10' "${DK}/curl.log"
}

@test "probe_public: no probe host is 2 and no request is made" {
    world_good
    grep -v '^CD_PROBE_HOST=' "${GREMION_ROOT}/etc/cd.env" > "${GREMION_ROOT}/etc/cd.env.new"
    mv "${GREMION_ROOT}/etc/cd.env.new" "${GREMION_ROOT}/etc/cd.env"
    run --separate-stderr wl 'cd_watch_probe_public'
    [ "$status" -eq 2 ]
    [ ! -e "${DK}/curl.log" ]
}

@test "probe_public: an edge address that is not an address is 2" {
    world_good
    sed -i 's/^EDGE_BIND_IP=.*/EDGE_BIND_IP=CHANGE_ME_OPERATOR_edge_bind_ip/' "${GREMION_ROOT}/etc/env/state.env"
    run --separate-stderr wl 'cd_watch_probe_public'
    [ "$status" -eq 2 ]
    [ ! -e "${DK}/curl.log" ]
}

@test "probe_public: an IPv6 edge address is bracketed for --resolve and a port other than 443 is in the URL" {
    world_good
    sed -i 's/^EDGE_BIND_IP=.*/EDGE_BIND_IP=2001:db8::10/; s/^EDGE_HTTPS_PORT=.*/EDGE_HTTPS_PORT=8443/' "${GREMION_ROOT}/etc/env/state.env"
    run --separate-stderr wl 'cd_watch_probe_public'
    [ "$status" -eq 0 ]
    grep -q -- '--resolve|app.example.org:8443:\[2001:db8::10\]' "${DK}/curl.log"
    grep -q 'https://app.example.org:8443/readyz' "${DK}/curl.log"
}

# ============================================================= the access log counter

@test "accesslog_count: 9 errors count 9, a 500 and a 599 count, a 600 and the 4xx do not" {
    world_good
    logl app@file r-app@file 502 60 4
    logl public@file r-portal@file 500 60 3
    logl app@file r-app@file 599 60 2
    logl app@file r-app@file 600 60 5
    logl app@file r-app@file 404 60 5
    logl app@file r-app@file 200 60 20
    run --separate-stderr wl 'cd_watch_accesslog_count $(( $(cd_now) - 300 ))'
    [ "$status" -eq 0 ]
    [ "$output" = 9 ]
}

@test "accesslog_count: the test routers and the other services are not counted" {
    world_good
    logl app@file test-app@file 502 60 6
    logl public@file test-public@file 502 60 6
    logl app-next@file r-x@file 502 60 6
    logl portal@file r-y@file 502 60 6
    logl keycloak@docker r-z@docker 503 60 6
    logl app@file r-app@file 503 60 1
    run --separate-stderr wl 'cd_watch_accesslog_count $(( $(cd_now) - 300 ))'
    [ "$output" = 1 ]
}

@test "accesslog_count: lines older than SINCE are not counted, and a fraction of a second parses" {
    world_good
    logl app@file r@file 502 400 7
    logl app@file r@file 502 100 2
    run --separate-stderr wl 'cd_watch_accesslog_count $(( $(cd_now) - 300 ))'
    [ "$output" = 2 ]
}

@test "accesslog_count: it prints an integer and stores no line (nothing of the log in any output, state or history)" {
    world_good
    seed
    logl app@file r@file 502 60 12
    run wl 'cd_watch_accesslog_count $(( $(cd_now) - 300 )); cd_watch_baseline'
    [[ "$output" == 12* ]]
    [[ "$output" != *marker* ]]
    [[ "$output" != *tenant.example.org* ]]
    [[ "$output" != *198.51.100.7* ]]
    run grep -rl -e "$LOG_MARKER" -e tenant.example.org -e 198.51.100.7 "${GREMION_ROOT}/data" "${GREMION_ROOT}/runtime"
    [ "$status" -eq 1 ]
}

@test "accesslog_count: an empty log is 0, a garbage line is skipped" {
    world_good
    run --separate-stderr wl 'cd_watch_accesslog_count $(( $(cd_now) - 300 ))'
    [ "$status" -eq 0 ]
    [ "$output" = 0 ]
    printf 'not json at all\n{broken\n' >> "${DK}/access.log"
    logl app@file r@file 502 60 3
    run --separate-stderr wl 'cd_watch_accesslog_count $(( $(cd_now) - 300 ))'
    [ "$output" = 3 ]
}

@test "accesslog_count: an unreadable log prints nothing and is not zero" {
    world_good
    touch "${DK}/log.fail"
    run --separate-stderr wl 'cd_watch_accesslog_count $(( $(cd_now) - 300 ))'
    [ "$status" -ne 0 ]
    [ -z "$output" ]
    rm "${DK}/log.fail"
    rm "${DK}/cid.teststack-state.traefik"
    run --separate-stderr wl 'cd_watch_accesslog_count $(( $(cd_now) - 300 ))'
    [ "$status" -ne 0 ]
    [ -z "$output" ]
}

@test "accesslog_count: a read that fills the tail and does not reach back to SINCE is unreadable, not a low number" {
    world_good
    # a tail of five lines, five lines all inside the window: older lines may have been cut off
    logl app@file r@file 502 100 5
    run --separate-stderr wl '_CD_WATCH_TAIL_LINES=5; cd_watch_accesslog_count $(( $(cd_now) - 300 ))'
    [ "$status" -ne 0 ]
    [ -z "$output" ]
    # the oldest line of the read is older than the window: it reaches back, the count is exact
    : > "${DK}/access.log"
    logl app@file r@file 502 400 1
    logl app@file r@file 502 100 4
    run --separate-stderr wl '_CD_WATCH_TAIL_LINES=5; cd_watch_accesslog_count $(( $(cd_now) - 300 ))'
    [ "$status" -eq 0 ]
    [ "$output" = 4 ]
    # the same log asked for a longer window does not reach back
    run --separate-stderr wl '_CD_WATCH_TAIL_LINES=5; cd_watch_accesslog_count $(( $(cd_now) - 3000 ))'
    [ "$status" -ne 0 ]
    [ -z "$output" ]
    # a log shorter than the tail is complete whatever the window
    run --separate-stderr wl '_CD_WATCH_TAIL_LINES=50; cd_watch_accesslog_count $(( $(cd_now) - 3000 ))'
    [ "$status" -eq 0 ]
    [ "$output" = 5 ]
}

@test "accesslog_count: it reads the log by docker exec tail of the traefik container, bounded, and needs an epoch" {
    world_good
    run --separate-stderr wl 'cd_watch_accesslog_count $(( $(cd_now) - 300 ))'
    grep -q 'exec|tr1|tail|-n|200000|/logs/access.log|bounded=1' "${DK}/docker.log"
    run --separate-stderr wl 'cd_watch_accesslog_count notanumber'
    [ "$status" -eq 2 ]
}

# ============================================================================ the sample

@test "sample: one JSON object with the fixed keys" {
    world_good
    seed
    run --separate-stderr wl 'cd_watch_sample'
    [ "$status" -eq 0 ]
    run jq -r 'keys | join(",")' <<<"$output"
    [ "$output" = "at,colour,containers,duration_s,fivexx,identity,internal,old_colour,old_ready,portal,public,requests,route,shared,tag,timed_out,v,window_s,workers" ]
}

@test "sample: a healthy world gives every probe good, the facts of the colour and no host" {
    world_good
    seed
    logl app@file r@file 200 60 5
    run --separate-stderr wl 'cd_watch_sample'
    [ "$status" -eq 0 ]
    local s="$output"
    [ "$(jq -r '.public.ok' <<<"$s")" = true ]
    [ "$(jq -r '.public.readyz + " " + .public.login' <<<"$s")" = "200 302" ]
    [ "$(jq -c '.internal' <<<"$s")" = '{"answered":true,"ready":true,"colour":"green","release":"pilot-bbbbbbbbbbbb","not_ready":0}' ]
    [ "$(jq -r '.route.ok' <<<"$s")" = true ]
    [ "$(jq -r '.identity.ok' <<<"$s")" = true ]
    [ "$(jq -r '.portal.ok' <<<"$s")" = true ]
    [ "$(jq -c '.containers' <<<"$s")" = '{"known":true,"total":2,"bad":0,"restarts":0}' ]
    [ "$(jq -r '.fivexx' <<<"$s")" = 0 ]
    [ "$(jq -r '.requests' <<<"$s")" = 5 ]
    [ "$(jq -c '.workers' <<<"$s")" = '{"new":"on","old":"off"}' ]
    [ "$(jq -r '.old_ready' <<<"$s")" = true ]
    [ "$(jq -c '.shared' <<<"$s")" = '{"state_ok":true,"traefik_ok":true,"docker_ok":true}' ]
    [ "$(jq -r '.timed_out' <<<"$s")" = false ]
    [ "$(jq -r '.colour + " " + .tag + " " + .old_colour' <<<"$s")" = "green pilot-bbbbbbbbbbbb blue" ]
    [[ "$s" != *app.example.org* ]]
    [[ "$stderr" != *app.example.org* ]]
}

@test "sample: the public probe is cd_watch_probe_public (one code path, the same argv)" {
    world_good
    seed
    run --separate-stderr wl 'cd_watch_sample >/dev/null'
    grep -q -- '--resolve|app.example.org:443:203.0.113.10' "${DK}/curl.log"
    run grep -c 'https://app.example.org/readyz' "${DK}/curl.log"
    [ "$output" = 1 ]
    run --separate-stderr wl 'cd_watch_sample >/dev/null; cd_watch_probe_public >/dev/null'
    run grep -c 'https://app.example.org/readyz' "${DK}/curl.log"
    [ "$output" = 3 ]
}

@test "sample: every curl, docker and stand-in call carries a timeout of at most CD_SAMPLE_TIMEOUT_S" {
    world_good
    seed
    cd_write_cfg CD_SAMPLE_TIMEOUT_S=5
    logl app@file r@file 502 60 1
    run --separate-stderr wl 'cd_watch_sample >/dev/null'
    [ "$status" -eq 0 ]
    local l n calls bounds
    # one URL per call; every call names its --max-time, and none is above the key
    calls="$(grep -cE 'https?://' "${DK}/curl.log")"
    bounds="$(grep -oE -- '--max-time\|[0-9]+' "${DK}/curl.log" | wc -l)"
    [ "$calls" -ge 6 ]
    [ "$calls" = "$bounds" ]
    while IFS= read -r l; do
        [ "${l#*|}" -le 5 ]
    done < <(grep -oE -- '--max-time\|[0-9]+' "${DK}/curl.log")
    # every docker call went through timeout, and every timeout is at most 5 seconds
    run grep -c 'bounded=0' "${DK}/docker.log"
    [ "$output" = 0 ]
    run grep -c . "${DK}/docker.log"
    [ "$output" -ge 3 ]
    while IFS= read -r l; do
        n="${l#* }"
        n="${n%% *}"
        [ "$n" -le 5 ]
    done < <(grep -h -oE '^timeout -k 2 [0-9]+' "${SHIM_LOG}" | sed 's/^timeout -k 2 //; s/^/x /')
    # the stand-ins of the colour and the compose wait are told the same bound
    grep -q 'probe green timeout=5' "${DK}/fake.log"
    grep -q 'portal green timeout=5' "${DK}/fake.log"
    grep -q 'wait state 0 .* timeout=5' "${DK}/fake.log"
}

@test "sample: a timed-out public probe is a failed probe and flags the sample" {
    world_good
    seed
    printf 'TIMEOUT' > "${DK}/pub.readyz"
    run --separate-stderr wl 'cd_watch_sample'
    [ "$(jq -r '.public.ok' <<<"$output")" = false ]
    [ "$(jq -r '.public.readyz' <<<"$output")" = 000 ]
    [ "$(jq -r '.timed_out' <<<"$output")" = true ]
}

@test "sample: the colour that answers wrongly, or not at all, is not ready" {
    world_good
    seed
    jq -cn '{ready: true, colour: "blue", release: "pilot-bbbbbbbbbbbb", tenants: {total: 3, notReady: 0}, reasons: []}' > "${DK}/probe.green"
    run --separate-stderr wl 'cd_watch_sample'
    [ "$(jq -r '.internal.colour' <<<"$output")" = blue ]
    rm "${DK}/probe.green"
    run --separate-stderr wl 'cd_watch_sample'
    [ "$(jq -r '.internal.answered' <<<"$output")" = false ]
    [ "$(jq -r '.internal.ready' <<<"$output")" = false ]
}

@test "sample: the 5xx count reaches back at most to the switch (the service names are the same for both colours)" {
    world_good
    seed
    logl app@file r@file 502 200 12
    run --separate-stderr wl 'cd_watch_sample'
    [ "$(jq -r '.fivexx' <<<"$output")" = 12 ]
    [ "$(jq -r '.window_s' <<<"$output")" = 300 ]
    SWITCH_AGO=100 seed
    run --separate-stderr wl 'cd_watch_sample'
    [ "$(jq -r '.fivexx' <<<"$output")" = 0 ]
    [ "$(jq -r '.window_s' <<<"$output")" = 100 ]
    logl app@file r@file 502 50 11
    run --separate-stderr wl 'cd_watch_sample'
    [ "$(jq -r '.fivexx' <<<"$output")" = 11 ]
}

@test "sample: an unreadable log is a null count, not a zero" {
    world_good
    seed
    touch "${DK}/log.fail"
    run --separate-stderr wl 'cd_watch_sample'
    [ "$status" -eq 0 ]
    [ "$(jq -r '.fivexx' <<<"$output")" = null ]
    [ "$(jq -r '.requests' <<<"$output")" = null ]
}

@test "sample: the route must name the new colour and be UP for app and public" {
    world_good
    seed
    set_svc app@file gremion-ui blue
    run --separate-stderr wl 'cd_watch_sample'
    [ "$(jq -r '.route.ok' <<<"$output")" = false ]
    [ "$(jq -r '.route.known' <<<"$output")" = true ]
    set_svc app@file gremion-ui green DOWN
    run --separate-stderr wl 'cd_watch_sample'
    [ "$(jq -r '.route.ok' <<<"$output")" = false ]
    set_svc app@file gremion-ui green
    set_svc public@file gremion-public blue
    run --separate-stderr wl 'cd_watch_sample'
    [ "$(jq -r '.route.ok' <<<"$output")" = false ]
}

@test "sample: a Traefik API that does not answer is an unknown route and an unhealthy shared service" {
    world_good
    seed
    touch "${DK}/traefik.down"
    run --separate-stderr wl 'cd_watch_sample'
    [ "$(jq -r '.route.known' <<<"$output")" = false ]
    [ "$(jq -r '.route.ok' <<<"$output")" = false ]
    [ "$(jq -r '.shared.traefik_ok' <<<"$output")" = false ]
    [ "$(jq -r '.old_ready' <<<"$output")" = false ]
}

@test "sample: the state project unhealthy is shared.state_ok false" {
    world_good
    seed
    printf '3' > "${DK}/state.rc"
    run --separate-stderr wl 'cd_watch_sample'
    [ "$(jq -r '.shared.state_ok' <<<"$output")" = false ]
}

@test "sample: container facts, restarts summed, an exited one-shot is fine, a failed one is bad, a silent docker is unknown" {
    world_good
    seed
    printf 'g1\ng2\ng3\ng4\n' > "${DK}/cids.teststack-app-green"
    printf 'running 0 healthy 1\n' > "${DK}/cont.g1"
    printf 'running 0 nohealthcheck 2\n' > "${DK}/cont.g2"
    printf 'exited 0 nohealthcheck 0\n' > "${DK}/cont.g3"
    printf 'running 0 healthy 0\n' > "${DK}/cont.g4"
    run --separate-stderr wl 'cd_watch_sample'
    [ "$(jq -c '.containers' <<<"$output")" = '{"known":true,"total":4,"bad":0,"restarts":3}' ]
    printf 'exited 1 nohealthcheck 0\n' > "${DK}/cont.g3"
    printf 'running 0 unhealthy 0\n' > "${DK}/cont.g4"
    run --separate-stderr wl 'cd_watch_sample'
    [ "$(jq -r '.containers.bad' <<<"$output")" = 2 ]
    touch "${DK}/ps.fail"
    run --separate-stderr wl 'cd_watch_sample'
    [ "$(jq -r '.containers.known' <<<"$output")" = false ]
    [ "$(jq -r '.shared.docker_ok' <<<"$output")" = false ]
}

@test "sample: the worker gate files and the identity are read for the colours" {
    world_good
    seed
    printf 'off' > "${DK}/workers.green"
    printf 'on' > "${DK}/workers.blue"
    printf '1' > "${DK}/identity.green.rc"
    run --separate-stderr wl 'cd_watch_sample'
    [ "$(jq -c '.workers' <<<"$output")" = '{"new":"off","old":"on"}' ]
    [ "$(jq -r '.identity.ok' <<<"$output")" = false ]
    grep -q 'identity green pilot-bbbbbbbbbbbb' "${DK}/fake.log"
}

@test "sample: the old colour is probed through app-next@file and counts only when that route names the old colour" {
    world_good
    seed
    run --separate-stderr wl 'cd_watch_sample'
    [ "$(jq -r '.old_ready' <<<"$output")" = true ]
    grep -q 'http://127.0.0.1:18081/readyz' "${DK}/curl.log"
    grep -q 'Host: cd-readiness.invalid' "${DK}/curl.log"
    # the next route names the NEW colour: it would probe the colour under test
    set_svc app-next@file gremion-ui green
    run --separate-stderr wl 'cd_watch_sample'
    [ "$(jq -r '.old_ready' <<<"$output")" = false ]
    set_svc app-next@file gremion-ui blue
    printf '503|{"ready":false}' > "${DK}/old.readyz"
    run --separate-stderr wl 'cd_watch_sample'
    [ "$(jq -r '.old_ready' <<<"$output")" = false ]
    printf '200|{"ready":true}' > "${DK}/old.readyz"
    set_svc app-next@file gremion-ui blue DOWN
    run --separate-stderr wl 'cd_watch_sample'
    [ "$(jq -r '.old_ready' <<<"$output")" = false ]
}

@test "sample: with the other units' functions at their default stubs and no answers it is a failing sample" {
    seed
    run --separate-stderr wl_plain 'cd_watch_sample'
    [ "$status" -eq 0 ]
    local s="$output"
    [ "$(jq -r '.public.ok' <<<"$s")" = false ]
    [ "$(jq -r '.internal.answered' <<<"$s")" = false ]
    [ "$(jq -r '.route.ok' <<<"$s")" = false ]
    [ "$(jq -r '.containers.bad > 0' <<<"$s")" = true ]
    [ "$(jq -r '.fivexx' <<<"$s")" = null ]
    [ "$(jq -r '.old_ready' <<<"$s")" = false ]
    export S="$s"
    run --separate-stderr wl_plain 'cd_watch_eval "$S"'
    [ "${lines[0]}" != ok ]
}

@test "sample: no release in the state is 2, and a colour argument samples that colour" {
    world_good
    cd_seed_state
    run --separate-stderr wl 'cd_watch_sample'
    [ "$status" -eq 2 ]
    seed
    jq -cn '{ready: true, colour: "blue", release: "pilot-aaaaaaaaaaaa", tenants: {total: 3, notReady: 0}, reasons: []}' > "${DK}/probe.blue"
    run --separate-stderr wl 'cd_watch_sample blue pilot-aaaaaaaaaaaa "$TREE"'
    [ "$status" -eq 0 ]
    [ "$(jq -r '.colour + " " + .old_colour + " " + .tag' <<<"$output")" = "blue green pilot-aaaaaaaaaaaa" ]
}

# ===================================================================== the evaluation

@test "eval: a good sample is ok and the counters of the state move" {
    seed
    ev '(.)'
    [ "$status" -eq 0 ]
    [ "${lines[0]}" = ok ]
    [ "$(sw samples)" = 1 ]
    [ "$(sw bad_streak)" = 0 ]
    [ "$(sw last_sample_epoch)" = "$(cd_clock)" ]
    [ "$(sw requests)" = 120 ]
    adv 15
    ev '(.)'
    [ "${lines[0]}" = ok ]
    [ "$(sw samples)" = 2 ]
    [ "$(sw observed_s)" = 15 ]
}

@test "eval: three consecutive failed readiness samples give trigger:watch_readiness" {
    seed
    ev "$BAD"
    [ "${lines[0]}" = bad ]
    adv
    ev "$BAD"
    [ "${lines[0]}" = bad ]
    [ "$(sw bad_streak)" = 2 ]
    adv
    ev "$BAD"
    [ "${lines[0]}" = trigger:watch_readiness ]
}

@test "eval: two failed then one good resets the streak" {
    seed
    ev "$BAD"
    adv
    ev "$BAD"
    adv
    ev '(.)'
    [ "${lines[0]}" = ok ]
    [ "$(sw bad_streak)" = 0 ]
    adv
    ev "$BAD"
    [ "${lines[0]}" = bad ]
    [ "$(sw bad_streak)" = 1 ]
}

@test "eval: CD_FAIL_SAMPLES is honoured" {
    cd_write_cfg CD_FAIL_SAMPLES=2
    seed
    ev "$BAD"
    adv
    ev "$BAD"
    [ "${lines[0]}" = trigger:watch_readiness ]
}

@test "eval: the internal probe with the wrong colour or the wrong release counts as failed" {
    seed '{"bad_streak":2}'
    ev '.internal.colour = "blue"'
    [ "${lines[0]}" = trigger:watch_readiness ]
    seed '{"bad_streak":2}'
    ev '.internal.release = "pilot-cccccccccccc"'
    [ "${lines[0]}" = trigger:watch_readiness ]
    seed '{"bad_streak":2}'
    ev '.internal.ready = false'
    [ "${lines[0]}" = trigger:watch_readiness ]
    seed '{"bad_streak":2}'
    ev '.internal.answered = false'
    [ "${lines[0]}" = trigger:watch_readiness ]
}

@test "eval: tenants.notReady above the baseline counts as failed, equal to it does not" {
    seed '{"bad_streak":2,"baseline_not_ready":2}'
    ev '.internal.not_ready = 2'
    [ "${lines[0]}" = ok ]
    seed '{"bad_streak":2,"baseline_not_ready":2}'
    ev '.internal.not_ready = 3'
    [ "${lines[0]}" = trigger:watch_readiness ]
}

@test "eval: a baseline that was never taken cannot be compared with, so the sample fails" {
    seed '{"bad_streak":2,"baseline_not_ready":null}'
    ev '(.)'
    [ "${lines[0]}" = trigger:watch_readiness ]
}

@test "eval: a portal probe answering 500 counts as a failed readiness sample, a 200 does not" {
    seed
    ev '.portal.ok = false'
    [ "${lines[0]}" = bad ]
    [ "$(sw bad_streak)" = 1 ]
    adv
    ev '.portal.ok = false'
    adv
    ev '.portal.ok = false'
    [ "${lines[0]}" = trigger:watch_readiness ]
    seed
    ev '.portal.ok = true'
    [ "${lines[0]}" = ok ]
}

@test "eval: a route that does not name the new colour, a wrong image and an unhealthy container count as failed" {
    seed
    ev '.route.ok = false'
    [ "${lines[0]}" = bad ]
    seed
    ev '.identity.ok = false'
    [ "${lines[0]}" = bad ]
    seed
    ev '.containers.bad = 1'
    [ "${lines[0]}" = bad ]
    seed
    ev '.containers.known = false'
    [ "${lines[0]}" = bad ]
}

@test "eval: two container restarts give trigger:watch_crash, one does not" {
    seed
    ev '(.)'
    adv
    ev '.containers.restarts = 1'
    [ "${lines[0]}" = ok ]
    adv
    ev '.containers.restarts = 2'
    [ "${lines[0]}" = trigger:watch_crash ]
}

@test "eval: the restart baseline is the first sample of the release, so a colour that restarted before it does not trigger" {
    seed
    ev '.containers.restarts = 5'
    [ "${lines[0]}" = ok ]
    adv
    ev '.containers.restarts = 6'
    [ "${lines[0]}" = ok ]
    adv
    ev '.containers.restarts = 7'
    [ "${lines[0]}" = trigger:watch_crash ]
}

@test "eval: a new release starts a new restart baseline" {
    seed
    ev '.containers.restarts = 9'
    seed
    jq '.release.id = "cccccccccccc-1"' "${GREMION_ROOT}/data/cd/state.json" > "${GREMION_ROOT}/data/cd/state.json.new"
    mv "${GREMION_ROOT}/data/cd/state.json.new" "${GREMION_ROOT}/data/cd/state.json"
    adv
    ev '.containers.restarts = 9'
    [ "${lines[0]}" = ok ]
}

@test "eval: a failing sample with the state project unhealthy is paused and the observed clock does not advance" {
    seed
    ev '(.)'
    adv
    ev "$BAD | .shared.state_ok = false"
    [ "${lines[0]}" = paused ]
    [ "$(sw observed_s)" = 0 ]
    [ "$(sw paused_s)" = 15 ]
    [ "$(sw bad_streak)" = 0 ]
    adv
    ev "$BAD | .shared.state_ok = false"
    [ "$(sw paused_s)" = 30 ]
    [ "$(sw observed_s)" = 0 ]
}

@test "eval: a failing sample with the Traefik API down is paused" {
    seed
    ev "$BAD | .shared.traefik_ok = false | .route.known = false | .route.ok = false"
    [ "${lines[0]}" = paused ]
}

@test "eval: a failing sample with docker silent is paused" {
    seed
    ev '.containers.known = false | .shared.docker_ok = false'
    [ "${lines[0]}" = paused ]
}

@test "eval: a good sample is ok even when a shared check says no, and the clock advances" {
    seed
    ev '(.)'
    adv
    ev '.shared.state_ok = false'
    [ "${lines[0]}" = ok ]
    [ "$(sw observed_s)" = 15 ]
}

@test "eval: a shared outage pauses a crash and a 5xx hit too (the outage restarts the new colour)" {
    seed
    ev '(.)'
    adv
    ev '.shared.state_ok = false | .containers.restarts = 3'
    [ "${lines[0]}" = paused ]
    adv
    ev '.shared.state_ok = false | .fivexx = 80'
    [ "${lines[0]}" = paused ]
}

@test "eval: the first paused sample queues one paused mail, counts only" {
    seed
    ev '(.)'
    adv
    ev "$BAD | .shared.state_ok = false"
    adv
    ev "$BAD | .shared.state_ok = false"
    run grep -c '^stub cd_notify paused ' "$SHIM_LOG"
    [ "$output" = 1 ]
    grep -q '^stub cd_notify paused key=paused-bbbbbbbbbbbb-1 sha12=bbbbbbbbbbbb colour=green stage=watch rule=none ' "$SHIM_LOG"
}

@test "eval: below the pause cap it stays paused, at the cap with the old colour ready and the new not it triggers watch_pause_cap" {
    cd_write_cfg CD_PAUSE_MAX_MIN=1
    seed
    ev '(.)'
    local i
    for i in 1 2 3; do
        adv
        ev "$BAD | .shared.state_ok = false"
        [ "${lines[0]}" = paused ]
    done
    [ "$(sw paused_s)" = 45 ]
    adv
    ev "$BAD | .shared.state_ok = false"
    [ "${lines[0]}" = trigger:watch_pause_cap ]
}

@test "eval: at the cap with the old colour not ready the release is parked" {
    cd_write_cfg CD_PAUSE_MAX_MIN=1
    seed
    ev '(.)'
    local i
    for i in 1 2 3; do
        adv
        ev "$BAD | .shared.state_ok = false | .old_ready = false"
    done
    adv
    ev "$BAD | .shared.state_ok = false | .old_ready = false"
    [ "${lines[0]}" = parked ]
}

@test "eval: at the cap with the old colour ready but the new colour ready too is parked, not a rollback" {
    cd_write_cfg CD_PAUSE_MAX_MIN=1
    seed
    ev '(.)'
    local i
    for i in 1 2 3; do
        adv
        ev '.portal.ok = false | .shared.state_ok = false'
    done
    adv
    ev '.portal.ok = false | .shared.state_ok = false'
    [ "${lines[0]}" = parked ]
}

@test "eval: the pause cap is the one in the config (guard against pausing for ever)" {
    cd_write_cfg CD_PAUSE_MAX_MIN=3
    seed '{"paused_s":150,"last_sample_epoch":'"$(cd_clock)"'}'
    adv
    ev "$BAD | .shared.state_ok = false"
    [ "${lines[0]}" = paused ]
    adv
    ev "$BAD | .shared.state_ok = false"
    [ "${lines[0]}" = trigger:watch_pause_cap ]
}

@test "eval: a worker gate that diverged gives flip lines, old off first, then new on" {
    seed
    ev '.workers.new = "off" | .workers.old = "on"'
    [ "${lines[0]}" = ok ]
    [ "${lines[1]}" = "flip blue off" ]
    [ "${lines[2]}" = "flip green on" ]
    [ "${#lines[@]}" = 3 ]
    seed
    ev '.workers.new = "off"'
    [ "${lines[1]}" = "flip green on" ]
    [ "${#lines[@]}" = 2 ]
    seed
    ev '.workers.old = "on"'
    [ "${lines[1]}" = "flip blue off" ]
    seed
    ev '(.)'
    [ "${#lines[@]}" = 1 ]
}

@test "eval: no flip line on a trigger, and eval never writes a gate file" {
    seed '{"bad_streak":2}'
    ev "$BAD | .workers.new = \"off\""
    [ "${lines[0]}" = trigger:watch_readiness ]
    [ "${#lines[@]}" = 1 ]
    [ ! -e "${DK}/fake.log" ]
}

# the 5xx rule: 10 and 3 times the baseline of the window. The baseline is the RAW count of
# CD_BASELINE_S (3600): 60 over an hour expects 5 in the 300 second window, so 15 is 3 times.

@test "eval 5xx: 9 errors are ok, 10 errors with a zero baseline trigger watch_5xx, 40 errors trigger" {
    seed
    ev '.fivexx = 9'
    [ "${lines[0]}" = ok ]
    seed
    ev '.fivexx = 10'
    [ "${lines[0]}" = trigger:watch_5xx ]
    seed
    ev '.fivexx = 40'
    [ "${lines[0]}" = trigger:watch_5xx ]
}

@test "eval 5xx: 10 errors with a baseline of 60 (15 expected in the window) are ok, 15 trigger" {
    seed '{"baseline_5xx":60}'
    ev '.fivexx = 10'
    [ "${lines[0]}" = ok ]
    seed '{"baseline_5xx":60}'
    ev '.fivexx = 14'
    [ "${lines[0]}" = ok ]
    seed '{"baseline_5xx":60}'
    ev '.fivexx = 15'
    [ "${lines[0]}" = trigger:watch_5xx ]
}

@test "eval 5xx: the expectation is scaled to the real window, so a short window after the switch is judged on its own length" {
    seed '{"baseline_5xx":60}'
    ev '.fivexx = 10 | .window_s = 100'
    [ "${lines[0]}" = trigger:watch_5xx ]
}

@test "eval 5xx: a null baseline (log unreadable then) uses the minimum alone" {
    seed '{"baseline_5xx":null}'
    ev '.fivexx = 10'
    [ "${lines[0]}" = trigger:watch_5xx ]
    seed '{"baseline_5xx":null}'
    ev '.fivexx = 9'
    [ "${lines[0]}" = ok ]
}

@test "eval 5xx: CD_5XX_MIN and CD_5XX_FACTOR are honoured" {
    cd_write_cfg CD_5XX_MIN=20 CD_5XX_FACTOR=2
    # a baseline of 240 over the hour expects 20 in 300 seconds, twice that is 40
    seed '{"baseline_5xx":240}'
    ev '.fivexx = 19'
    [ "${lines[0]}" = ok ]
    seed '{"baseline_5xx":240}'
    ev '.fivexx = 39'
    [ "${lines[0]}" = ok ]
    seed '{"baseline_5xx":240}'
    ev '.fivexx = 40'
    [ "${lines[0]}" = trigger:watch_5xx ]
    seed '{"baseline_5xx":240}'
    ev '.fivexx = 20 | .window_s = 150'
    [ "${lines[0]}" = trigger:watch_5xx ]
}

@test "eval 5xx: a 5xx hit alone triggers at once and does not wait for a streak" {
    seed
    ev '.fivexx = 12 | .portal.ok = false'
    [ "${lines[0]}" = trigger:watch_5xx ]
}

@test "eval: the crash rule comes before the 5xx rule and the readiness streak" {
    seed '{"bad_streak":2}'
    ev '.containers.restarts = 0'
    adv
    ev "$BAD | .containers.restarts = 3 | .fivexx = 50"
    [ "${lines[0]}" = trigger:watch_crash ]
}

@test "eval blind: an unreadable log gives a blind line and no trigger on its own" {
    seed
    ev '.fivexx = null | .requests = null'
    [ "${lines[0]}" = ok ]
    [ "${lines[1]}" = blind ]
    [ "$(sw blind)" = 1 ]
    adv
    ev '(.)'
    [ "$(sw blind)" = 0 ]
    [ "${#lines[@]}" = 1 ]
}

@test "eval blind: ten blind samples in a row queue one warning mail, never a trigger" {
    seed
    local i
    for i in $(seq 1 11); do
        ev '.fivexx = null | .requests = null'
        [ "${lines[0]}" = ok ]
        adv
    done
    [ "$(sw blind)" = 11 ]
    run grep -c '^stub cd_notify paused key=blind-bbbbbbbbbbbb-1 ' "$SHIM_LOG"
    [ "$output" = 1 ]
}

@test "eval blind: nine blind samples and a readable one send no warning" {
    seed
    local i
    for i in $(seq 1 9); do
        ev '.fivexx = null'
        adv
    done
    ev '(.)'
    for i in $(seq 1 9); do
        ev '.fivexx = null'
        adv
    done
    run grep -c 'cd_notify paused key=blind' "$SHIM_LOG"
    [ "$output" = 0 ]
}

@test "eval blind: the probes still trigger while the log is blind" {
    seed '{"bad_streak":2}'
    ev "$BAD | .fivexx = null"
    [ "${lines[0]}" = trigger:watch_readiness ]
    [ "${lines[1]}" = blind ]
}

@test "eval time: the real gap counts when it is at most twice the interval, a bigger gap adds nothing" {
    seed
    ev '(.)'
    adv 20
    ev '(.)'
    [ "$(sw observed_s)" = 20 ]
    adv 30
    ev '(.)'
    [ "$(sw observed_s)" = 50 ]
    adv 31
    ev '(.)'
    [ "$(sw observed_s)" = 50 ]
}

@test "eval time: a timed-out sample adds at most the interval" {
    seed
    ev '(.)'
    adv 25
    ev '.timed_out = true'
    [ "$(sw observed_s)" = 15 ]
}

@test "eval time: the first sample of a release adds nothing" {
    seed
    ev '(.)'
    [ "$(sw observed_s)" = 0 ]
}

@test "eval time: a slow sample is not a resume, so the streak keeps counting" {
    seed '{"bad_streak":2,"last_sample_epoch":'"$(cd_clock)"'}'
    printf '{"v":1,"release":"bbbbbbbbbbbb-1","grace":0,"restarts":0,"last_duration_s":40}\n' > "${GREMION_ROOT}/data/cd/watch-eval.json"
    adv 41
    ev "$BAD"
    [ "${lines[0]}" = trigger:watch_readiness ]
}

@test "eval reboot rule: after a long gap two failing samples are bad and never a trigger, the third is judged" {
    seed '{"bad_streak":2,"last_sample_epoch":'"$(cd_clock)"'}'
    adv 900
    ev "$BAD"
    [ "${lines[0]}" = bad ]
    [ "$(sw bad_streak)" = 2 ]
    adv 15
    ev "$BAD"
    [ "${lines[0]}" = bad ]
    adv 15
    ev "$BAD"
    [ "${lines[0]}" = trigger:watch_readiness ]
}

@test "eval reboot rule: a crash and a 5xx hit in the first two samples after a resume are not triggers" {
    seed '{"last_sample_epoch":'"$(cd_clock)"'}'
    ev '.containers.restarts = 0'
    adv 900
    ev '.containers.restarts = 5 | .fivexx = 90'
    [ "${lines[0]}" = bad ]
    adv 15
    ev '.containers.restarts = 5 | .fivexx = 90'
    [ "${lines[0]}" = bad ]
    adv 15
    ev '.containers.restarts = 5 | .fivexx = 90'
    [ "${lines[0]}" = trigger:watch_crash ]
}

@test "eval reboot rule: a 5xx hit in the first two samples after a resume is not a trigger either" {
    seed '{"last_sample_epoch":'"$(cd_clock)"'}'
    ev '(.)'
    adv 900
    ev '.fivexx = 90'
    [ "${lines[0]}" = bad ]
    adv 15
    ev '.fivexx = 90'
    [ "${lines[0]}" = bad ]
    adv 15
    ev '.fivexx = 90'
    [ "${lines[0]}" = trigger:watch_5xx ]
}

@test "eval reboot rule: a good sample in the grace window is ok and counts" {
    seed '{"bad_streak":1,"last_sample_epoch":'"$(cd_clock)"'}'
    adv 900
    ev '(.)'
    [ "${lines[0]}" = ok ]
    [ "$(sw bad_streak)" = 0 ]
    [ "$(sw samples)" = 1 ]
}

@test "eval: a sample that is not a sample, and a state without a release, are 2" {
    seed
    export S='{"v":1}'
    run --separate-stderr wl 'cd_watch_eval "$S"'
    [ "$status" -eq 2 ]
    export S='not json'
    run --separate-stderr wl 'cd_watch_eval "$S"'
    [ "$status" -eq 2 ]
    cd_seed_state
    ev '(.)'
    [ "$status" -eq 2 ]
}

@test "eval: a verdict other than ok or bad is a history line of names and counts, and no host or log text is anywhere" {
    seed
    ev '(.)'
    adv
    ev "$BAD | .shared.state_ok = false"
    run jq -r 'select(.event == "watch_verdict") | .verdict' "${GREMION_ROOT}/data/cd/history.jsonl"
    [ "$output" = paused ]
    run grep -rl -e app.example.org -e "$LOG_MARKER" -e tenant.example.org "${GREMION_ROOT}/data" "${GREMION_ROOT}/runtime"
    [ "$status" -eq 1 ]
}

# ===================================================================== the baseline

@test "baseline: the live colour's tenants.notReady and the raw 5xx count of the hour go to release.watch" {
    world_good
    seed '{"observed_s":0}'
    jq -cn '{ready: true, colour: "blue", release: "pilot-aaaaaaaaaaaa", tenants: {total: 4, notReady: 2}, reasons: []}' > "${DK}/probe.blue"
    logl app@file r@file 502 1800 7
    logl app@file r@file 502 4000 9
    run --separate-stderr wl 'cd_watch_baseline'
    [ "$status" -eq 0 ]
    [ "$(sw baseline_not_ready)" = 2 ]
    [ "$(sw baseline_5xx)" = 7 ]
    grep -q 'probe blue' "${DK}/fake.log"
}

@test "baseline: a log that cannot be read is a null 5xx baseline, the tenant baseline is still written" {
    world_good
    seed '{"baseline_5xx":3,"baseline_not_ready":9}'
    jq -cn '{ready: true, colour: "blue", release: "pilot-aaaaaaaaaaaa", tenants: {total: 4, notReady: 1}, reasons: []}' > "${DK}/probe.blue"
    touch "${DK}/log.fail"
    run --separate-stderr wl 'cd_watch_baseline'
    [ "$status" -eq 0 ]
    [ "$(sw baseline_5xx)" = null ]
    [ "$(sw baseline_not_ready)" = 1 ]
}

@test "baseline: a live colour that does not answer is 4 and writes nothing, never a zero" {
    world_good
    seed '{"baseline_5xx":3,"baseline_not_ready":9}'
    run --separate-stderr wl 'cd_watch_baseline'
    [ "$status" -eq 4 ]
    [ "$(sw baseline_not_ready)" = 9 ]
    [ "$(sw baseline_5xx)" = 3 ]
    printf '{"ready":true,"colour":"blue","release":"x","tenants":{"total":1}}' > "${DK}/probe.blue"
    run --separate-stderr wl 'cd_watch_baseline'
    [ "$status" -eq 4 ]
    [ "$(sw baseline_not_ready)" = 9 ]
}

@test "baseline: no live colour or no release is 2" {
    world_good
    cd_seed_state
    run --separate-stderr wl 'cd_watch_baseline'
    [ "$status" -eq 2 ]
    seed
    jq '.live = null' "${GREMION_ROOT}/data/cd/state.json" > "${GREMION_ROOT}/data/cd/state.json.new"
    mv "${GREMION_ROOT}/data/cd/state.json.new" "${GREMION_ROOT}/data/cd/state.json"
    run --separate-stderr wl 'cd_watch_baseline'
    [ "$status" -eq 2 ]
}

@test "baseline: a baseline from the fresh watch fills every counter with a zero so the schema holds" {
    world_good
    cd_seed_state '.phase = "watching" | .live = '"$CD_LIVE_JSON"' | .release = {
        "id":"bbbbbbbbbbbb-1","sha":"'"$(printf 'b%.0s' $(seq 1 40))"'","sha12":"bbbbbbbbbbbb","tag":"'"$TAG_NEW"'",
        "colour":"green","tree":"'"$TREE"'","mode":"auto","stage":"select","stage_status":"started"}'
    jq -cn '{ready: true, colour: "blue", release: "pilot-aaaaaaaaaaaa", tenants: {total: 4, notReady: 0}, reasons: []}' > "${DK}/probe.blue"
    run --separate-stderr wl 'cd_watch_baseline'
    [ "$status" -eq 0 ]
    [ "$(sw samples)" = 0 ]
    [ "$(sw last_sample_epoch)" = 0 ]
    [ "$(sw baseline_not_ready)" = 0 ]
}

# ============================================================ the edge log proof script

@test "the edge log proof script exists, is executable and names the three fields and the tail" {
    local f="${BATS_TEST_DIRNAME}/integration/cd-edge-log-proof.sh"
    [ -x "$f" ]
    grep -q DownstreamStatus "$f"
    grep -q ServiceName "$f"
    grep -q RouterName "$f"
    grep -q 'tail' "$f"
    bash -n "$f"
}
