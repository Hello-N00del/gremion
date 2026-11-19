#!/usr/bin/env bats
# test/host/cd-traffic.bats -- cd-traffic: infra/host/lib/cd/traffic.sh, the forward switch, the
# truth read and the confirm of the continuous deployment program.
#
# Run: MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W):/repo:ro" -w /repo gremion-bats:local test/host/cd-traffic.bats
#
# Nothing here touches a real docker, Traefik or network: docker and curl are recording shims
# whose answers are files under $DK (a fake Traefik JSON the test can change), gremion-switch is
# a script inside the fake release tree (it is run from there, as the program does), the host
# layout is a temp $GREMION_ROOT and the clock is the fake clock of test_helper/cd. The real
# traffic.sh runs on the real core.sh and docker.sh. Every name is a reserved example name.

bats_require_minimum_version 1.5.0
load 'test_helper/host'
load 'test_helper/cd'

FIX="${BATS_TEST_DIRNAME}/fixtures/cd/traffic"
CHILD_MARKER="child-output-marker-zq"
SLUG_MARKER="leakmarker"

setup() {
    cd_setup
    export STACK=teststack
    unset CD_DC_TIMEOUT CD_TRAFFIC_SWITCH_TIMEOUT_S
    DK="${SHIM_DIR}/dk"
    export DK CHILD_MARKER
    mkdir -p "$DK"
    TREE="${GREMION_ROOT}/releases/bbbbbbbbbbbb"
    OLD_TREE="${GREMION_ROOT}/releases/aaaaaaaaaaaa"
    export TREE OLD_TREE
    cp "${FIX}/state.env" "${GREMION_ROOT}/etc/env/state.env"
    cp "${FIX}/app-blue.env" "${GREMION_ROOT}/etc/env/app-blue.env"
    cp "${FIX}/app-green.env" "${GREMION_ROOT}/etc/env/app-green.env"
    install_tree "$TREE"
    install_tree "$OLD_TREE"
    shim_docker
    shim_curl
    seed
    world blue
}

teardown() {
    cd_teardown
}

# ------------------------------------------------------------------ the world

# install_tree TREE -- a fake release tree: the gremion-switch program and the edge template.
# The program writes what the real one writes, by the mode in $DK/switch.mode:
#   ok              the edge file, the three Traefik services, then runtime/active-colour
#   write_then_fail the edge file only (the real program dies in its poll after writing it), exit 1
#   fail            exit 2 before writing anything
#   lie             exit 0 and write nothing
#   hang            run for 30 seconds
install_tree() {
    local t="$1"
    mkdir -p "${t}/infra/host/bin" "${t}/infra/host/templates/edge"
    printf '# active.yml.tmpl (a fake)\n' > "${t}/infra/host/templates/edge/active.yml.tmpl"
    cat > "${t}/infra/host/bin/gremion-switch" <<'SWITCH'
#!/usr/bin/env bash
colour="$1"
f8=closed; [ -e /proc/self/fd/8 ] && f8=open
f9=closed; [ -e /proc/self/fd/9 ] && f9=open
{
    printf 'self=%s\n' "$0"
    printf 'argv=%s\n' "$*"
    printf 'template=%s\n' "${GREMION_EDGE_TEMPLATE:-unset}"
    printf 'api=%s\n' "${TRAEFIK_API:-unset}"
    printf 'root=%s\n' "${GREMION_ROOT:-unset}"
    printf 'started=%s\n' "$(jq -r '.release.switch_started // false' "$GREMION_ROOT/data/cd/state.json")"
    printf 'stdin=%s\n' "$(readlink /proc/self/fd/0 2>/dev/null || echo unknown)"
    printf 'fd8=%s fd9=%s\n' "$f8" "$f9"
} >> "$DK/switch.log"
mode="$(cat "$DK/switch.mode" 2>/dev/null || echo ok)"
echo "$CHILD_MARKER"
echo "$CHILD_MARKER" >&2
write_edge() { printf 'active=%s\n' "$colour" > "$GREMION_ROOT/etc/edge/active.yml"; }
point() {
    local pair name svc u
    for pair in app@file:gremion-ui public@file:gremion-public panel@file:control-panel; do
        name="${pair%%:*}"; svc="${pair##*:}"; u="http://${svc}-${colour}:3000"
        jq -cn --arg u "$u" '{loadBalancer: {servers: [{url: $u}]}, serverStatus: {($u): "UP"}}' > "$DK/traefik.${name}"
    done
}
case "$mode" in
    ok) write_edge; point; printf '%s\n' "$colour" > "$GREMION_ROOT/runtime/active-colour" ;;
    write_then_fail) write_edge; echo "poll failed" >&2; exit 1 ;;
    fail) exit 2 ;;
    lie) exit 0 ;;
    hang) exec sleep 30 ;;
esac
exit 0
SWITCH
    chmod +x "${t}/infra/host/bin/gremion-switch"
}

# docker: a recording shim. cd_traffic_* must never call it, so every call is a finding.
shim_docker() {
    shim docker '(IFS="|"; printf "%s\n" "$*" >> "$DK/docker.log")
exit 0'
}

# curl. Answers are files in $DK:
#   traefik.<name>   the JSON of a service (app@file ...); traefik.down: the API does not answer
#   routers.json     the router list; routers.next: the X-Next-Page value (default 1);
#                    routers.down: only the router list does not answer
shim_curl() {
    shim curl "$(cat <<'EOF'
(IFS='|'; a="$*"; printf '%s\n' "${a//$'\n'/ }" >> "$DK/curl.log")
url="${@: -1}"; hdr=''; prev=''
for a in "$@"; do
  case "$prev" in -D) hdr="$a" ;; esac
  prev="$a"
done
down() { echo "curl: (7) Failed to connect" >&2; exit 7; }
[ -f "$DK/traefik.down" ] && down
case "$url" in
  */api/http/services/*)
    f="$DK/traefik.${url##*/api/http/services/}"
    [ -f "$f" ] || { echo "curl: (22) 404" >&2; exit 22; }
    cat "$f" ;;
  */api/http/routers*)
    [ -f "$DK/routers.down" ] && down
    [ -f "$DK/routers.json" ] || { echo "curl: (22) 404" >&2; exit 22; }
    [ -n "$hdr" ] && printf 'HTTP/1.1 200 OK\r\nX-Next-Page: %s\r\n\r\n' "$(cat "$DK/routers.next" 2>/dev/null || echo 1)" > "$hdr"
    cat "$DK/routers.json" ;;
  *) exit 7 ;;
esac
exit 0
EOF
)"
}

# set_svc NAME SVC COLOUR [STATUS] -- the Traefik service NAME has one server SVC-COLOUR.
set_svc() {
    local url="http://${2}-${3}:3000"
    jq -cn --arg u "$url" --arg s "${4:-UP}" '{loadBalancer: {servers: [{url: $u}]}, serverStatus: {($u): $s}}' > "${DK}/traefik.${1}"
}

# routers_good -- the router list of a healthy edge: Traefik's own router, the two loopback test
# routers (a HostRegexp rule), a tenant router and the portal router.
routers_good() {
    jq -cn --arg slug "$SLUG_MARKER" '[
      {name: "api@internal", rule: "PathPrefix(`/api`)", status: "enabled", service: "api@internal"},
      {name: "test-app@file", rule: "HostRegexp(`.+`)", status: "enabled", service: "app-next@file", entryPoints: ["internaltest"]},
      {name: "test-public@file", rule: "HostRegexp(`.+`) && PathPrefix(`/portal`)", status: "enabled", service: "public-next@file", entryPoints: ["internaltest"]},
      {name: ("tenant-" + $slug + "@docker"), rule: ("Host(`" + $slug + ".example.org`)"), status: "enabled", service: "app@file"},
      {name: "portal@docker", rule: "Host(`example.org`)", status: "enabled", service: "public@file"}
    ]' > "${DK}/routers.json"
}

# mod_routers 'JQ FILTER' -- change the router list.
mod_routers() {
    jq -c "$1" "${DK}/routers.json" > "${DK}/routers.tmp"
    mv -f "${DK}/routers.tmp" "${DK}/routers.json"
}

# world COLOUR -- the edge serves COLOUR on every service, the file says so, the routers are fine.
world() {
    set_svc app@file gremion-ui "$1"
    set_svc public@file gremion-public "$1"
    set_svc panel@file control-panel "$1"
    printf '%s\n' "$1" > "${GREMION_ROOT}/runtime/active-colour"
    rm -f "${DK}/traefik.down" "${DK}/routers.down" "${DK}/routers.next"
    routers_good
}

use_panel() { cp "${FIX}/state-panel.env" "${GREMION_ROOT}/etc/env/state.env"; }

# seed [SWITCH_STARTED] -- a release on green, in the switch stage.
seed() {
    cd_seed_state '.phase = "releasing" | .live = ('"$CD_LIVE_JSON"' + {"tree":"'"$OLD_TREE"'"}) | .release = {
        "id":"bbbbbbbbbbbb-1","sha":"'"$(printf 'b%.0s' $(seq 1 40))"'","sha12":"bbbbbbbbbbbb","tag":"pilot-bbbbbbbbbbbb",
        "colour":"green","tree":"'"$TREE"'","mode":"auto","stage":"switch","stage_status":"started","switch_started":'"${1:-false}"'}'
}

# tl 'snippet' -- a fresh bash with the real core.sh, docker.sh and traffic.sh, then the stubs of
# the other units (use with `run`). The cd lock is claimed by hand (CD_LOCK_PID).
tl() {
    bash -c "set -euo pipefail
. \"\${HOST_SRC}/lib/common.sh\"
. \"\${HOST_SRC}/lib/cd/core.sh\"
. \"\${HOST_SRC}/lib/cd/cmd-state.sh\"
. \"\${HOST_SRC}/lib/cd/docker.sh\"
. \"\${HOST_SRC}/lib/cd/traffic.sh\"
. \"\${GREMION_CD_STUBS_DIR}/cd-stubs.sh\"
CD_LOCK_PID=\$\$
cd_cfg_load
${1}" tl
}

# tl_nolock 'snippet' -- the same WITHOUT the cd lock.
tl_nolock() {
    bash -c "set -euo pipefail
. \"\${HOST_SRC}/lib/common.sh\"
. \"\${HOST_SRC}/lib/cd/core.sh\"
. \"\${HOST_SRC}/lib/cd/cmd-state.sh\"
. \"\${HOST_SRC}/lib/cd/docker.sh\"
. \"\${HOST_SRC}/lib/cd/traffic.sh\"
. \"\${GREMION_CD_STUBS_DIR}/cd-stubs.sh\"
cd_cfg_load
${1}" tl
}

# cf COLOUR -- run the confirm and print "<code> <reason>" (called directly, so the reason is kept).
cf() {
    tl 'rc=0; cd_traffic_confirm '"$1"' 2>/dev/null || rc=$?; printf "%s %s\n" "$rc" "$CD_TRAFFIC_REASON"'
}

state_json() { jq -r "$1" "${GREMION_ROOT}/data/cd/state.json"; }
swlog() { grep "^$1=" "${DK}/switch.log" | tail -n 1 | cut -d= -f2-; }

# refused 'snippet' -- the switch is refused with 2 before anything is written or called.
refused() {
    run --separate-stderr tl "$1"
    [ "$status" -eq 2 ]
    [ ! -e "${DK}/switch.log" ]
    [ "$(state_json '.release.switch_started')" = false ]
}

# ================================================================= the switch

@test "switch: gremion-switch runs from the NEW tree with the colour, --no-evict, the new template and the API of state.env" {
    run --separate-stderr tl 'cd_traffic_switch "$TREE" green'
    [ "$status" -eq 0 ]
    [ "$(swlog self)" = "${TREE}/infra/host/bin/gremion-switch" ]
    [ "$(swlog argv)" = "green --no-evict" ]
    [ "$(swlog template)" = "${TREE}/infra/host/templates/edge/active.yml.tmpl" ]
    [ "$(swlog api)" = "http://127.0.0.1:18080" ]
    [ "$(swlog root)" = "$GREMION_ROOT" ]
    # the API port is the one of state.env: another port gives another URL
    sed -i 's/^TRAEFIK_API_PORT=.*/TRAEFIK_API_PORT=19999/' "${GREMION_ROOT}/etc/env/state.env"
    rm -f "${DK}/switch.log"
    run --separate-stderr tl 'cd_traffic_switch "$TREE" green'
    [ "$(swlog api)" = "http://127.0.0.1:19999" ]
}

@test "switch: switch_started is in the state BEFORE the call and still true after a good one" {
    [ "$(state_json '.release.switch_started')" = false ]
    run --separate-stderr tl 'cd_traffic_switch "$TREE" green'
    [ "$status" -eq 0 ]
    [ "$(swlog started)" = true ]
    [ "$(state_json '.release.switch_started')" = true ]
}

@test "switch: stdin is closed and the child holds neither lock descriptor" {
    run --separate-stderr tl 'exec 8>"${GREMION_ROOT}/fd8.probe"; exec 9>"${GREMION_ROOT}/fd9.probe"; cd_traffic_switch "$TREE" green'
    [ "$status" -eq 0 ]
    [ "$(swlog stdin)" = /dev/null ]
    [ "$(swlog fd8)" = "closed fd9=closed" ]
}

@test "switch: a failed call after the edge file was written returns non-zero, keeps switch_started and never touches the colour project" {
    printf 'write_then_fail' > "${DK}/switch.mode"
    run --separate-stderr tl 'cd_traffic_switch "$TREE" green'
    [ "$status" -ne 0 ]
    # the edge file was written for the new colour and is left as it is (the rollback owns it)
    [ "$(cat "${GREMION_ROOT}/etc/edge/active.yml")" = "active=green" ]
    [ "$(cat "${GREMION_ROOT}/runtime/active-colour")" = blue ]
    [ "$(state_json '.release.switch_started')" = true ]
    # the state names it a switch failure for the driver
    [ "$(state_json '.release.failure.stage')" = switch ]
    [ "$(state_json '.release.failure.kind')" = commit ]
    [ "$(state_json '.release.failure.code')" = switch_failed ]
    # no compose down, no docker call of any kind
    [ ! -e "${DK}/docker.log" ]
    run grep -c '"event":"switch_failed"' "${GREMION_ROOT}/data/cd/history.jsonl"
    [ "$output" = 1 ]
}

@test "switch: a failed switch back leaves the failure record and the stage of the release alone" {
    seed true
    printf 'write_then_fail' > "${DK}/switch.mode"
    run --separate-stderr tl 'cd_traffic_switch "$OLD_TREE" blue'
    [ "$status" -ne 0 ]
    [ "$(state_json '.release.switch_started')" = true ]
    [ "$(state_json '.release.stage')" = switch ]
    [ "$(state_json '.release.stage_status')" = started ]
    [ "$(state_json '.release.failure')" = null ]
}

@test "switch: an exit 0 that left no active-colour file for the colour is a failure" {
    printf 'lie' > "${DK}/switch.mode"
    run --separate-stderr tl 'cd_traffic_switch "$TREE" green'
    [ "$status" -ne 0 ]
    [ "$(state_json '.release.switch_started')" = true ]
    [ "$(state_json '.release.failure.code')" = switch_failed ]
}

@test "switch: a call that runs out of time is killed and fails" {
    printf 'hang' > "${DK}/switch.mode"
    export CD_TRAFFIC_SWITCH_TIMEOUT_S=1
    local start=$SECONDS
    run --separate-stderr tl 'cd_traffic_switch "$TREE" green'
    [ "$status" -ne 0 ]
    [ $((SECONDS - start)) -lt 15 ]
    [[ "$stderr" == *"ran out of time"* ]]
    [ "$(state_json '.release.switch_started')" = true ]
}

@test "switch: a bad colour is refused with 2 before anything is written or called" {
    refused 'cd_traffic_switch "$TREE" red'
}

@test "switch: a release tree without the program is refused before anything is written or called" {
    mkdir -p "${GREMION_ROOT}/releases/cccccccccccc"
    refused 'cd_traffic_switch "${GREMION_ROOT}/releases/cccccccccccc" green'
}

@test "switch: a program that is not executable is refused before anything is written or called" {
    chmod -x "${TREE}/infra/host/bin/gremion-switch"
    refused 'cd_traffic_switch "$TREE" green'
}

@test "switch: a tree without the edge template is refused before anything is written or called" {
    rm -f "${TREE}/infra/host/templates/edge/active.yml.tmpl"
    refused 'cd_traffic_switch "$TREE" green'
}

@test "switch: a state.env without TRAEFIK_API_PORT is refused before anything is written or called" {
    sed -i '/^TRAEFIK_API_PORT=/d' "${GREMION_ROOT}/etc/env/state.env"
    refused 'cd_traffic_switch "$TREE" green'
}

@test "switch: no release in the state is refused before anything is written or called" {
    cd_seed_state '.'
    run --separate-stderr tl 'cd_traffic_switch "$TREE" green'
    [ "$status" -eq 2 ]
    [ ! -e "${DK}/switch.log" ]
}

@test "switch: without the cd lock nothing is called and switch_started stays false" {
    run --separate-stderr tl_nolock 'cd_traffic_switch "$TREE" green'
    [ "$status" -eq 2 ]
    [ ! -e "${DK}/switch.log" ]
    [ "$(state_json '.release.switch_started')" = false ]
}

@test "switch: the output of the child goes to one 0600 file under logs and not to stdout or stderr" {
    printf 'write_then_fail' > "${DK}/switch.mode"
    run --separate-stderr tl 'cd_traffic_switch "$TREE" green'
    [ "$status" -ne 0 ]
    [[ "$output" != *"$CHILD_MARKER"* ]]
    [[ "$stderr" != *"$CHILD_MARKER"* ]]
    local n f
    n="$(find "${GREMION_ROOT}/logs" -type f -name 'cd-switch-*' | wc -l)"
    [ "$n" -eq 1 ]
    f="$(find "${GREMION_ROOT}/logs" -type f -name 'cd-switch-*')"
    [ "$(stat -c %a "$f")" = 600 ]
    grep -q "$CHILD_MARKER" "$f"
    # the journal gets the file name only
    [[ "$stderr" == *"$(basename "$f")"* ]]
}

# ================================================================= the confirm

@test "confirm: a clean edge on the colour passes (panel opted in) and the state is not touched" {
    use_panel
    world green
    local before
    before="$(sha256sum "${GREMION_ROOT}/data/cd/state.json")"
    run --separate-stderr cf green
    [ "$output" = "0 " ]
    [ "$(sha256sum "${GREMION_ROOT}/data/cd/state.json")" = "$before" ]
}

@test "confirm: app on the colour but public and panel not is a failure (only app is not enough)" {
    use_panel
    world green
    set_svc public@file gremion-public blue
    set_svc panel@file control-panel blue
    run --separate-stderr cf green
    [ "$output" = "1 public_not_on_colour" ]
}

@test "confirm: public on the other colour is a failure" {
    use_panel
    world green
    set_svc public@file gremion-public blue
    run --separate-stderr cf green
    [ "$output" = "1 public_not_on_colour" ]
}

@test "confirm: app on the other colour is a failure" {
    use_panel
    world green
    set_svc app@file gremion-ui blue
    run --separate-stderr cf green
    [ "$output" = "1 app_not_on_colour" ]
}

@test "confirm: an opted-in panel on the other colour is a failure" {
    use_panel
    world green
    set_svc panel@file control-panel blue
    run --separate-stderr cf green
    [ "$output" = "1 panel_not_on_colour" ]
}

@test "confirm: an opted-in panel whose server is not UP is a failure" {
    use_panel
    world green
    set_svc panel@file control-panel green DOWN
    run --separate-stderr cf green
    [ "$output" = "1 panel_down" ]
}

@test "confirm: without the opt-in the panel is not looked at" {
    world green
    set_svc panel@file control-panel blue DOWN
    run --separate-stderr cf green
    [ "$output" = "0 " ]
    # an empty value is no opt-in
    printf 'CONTROL_PANEL_ORIGIN=\n' >> "${GREMION_ROOT}/etc/env/state.env"
    run --separate-stderr cf green
    [ "$output" = "0 " ]
}

@test "confirm: an opt-in declared twice cannot be read and is refused with 2" {
    use_panel
    world green
    printf 'CONTROL_PANEL_ORIGIN=https://control.example.org\n' >> "${GREMION_ROOT}/etc/env/state.env"
    run --separate-stderr cf green
    [ "${output%% *}" = 2 ]
}

@test "confirm: a service with two servers, one of them the other colour, is a failure" {
    world green
    jq -cn '{loadBalancer: {servers: [{url: "http://gremion-ui-green:3000"}, {url: "http://gremion-ui-blue:3000"}]}, serverStatus: {}}' > "${DK}/traefik.app@file"
    run --separate-stderr cf green
    [ "$output" = "1 app_not_on_colour" ]
}

@test "confirm: a service with no server is a failure" {
    world green
    jq -cn '{loadBalancer: {servers: []}, serverStatus: {}}' > "${DK}/traefik.public@file"
    run --separate-stderr cf green
    [ "$output" = "1 public_not_on_colour" ]
}

@test "confirm: a router with an empty Host() rule is a failure" {
    world green
    mod_routers '(.[3].rule) = "Host(``)"'
    run --separate-stderr cf green
    [ "$output" = "1 router_empty_host" ]
    # the other empty spellings
    mod_routers '(.[3].rule) = "Host()"'
    run --separate-stderr cf green
    [ "$output" = "1 router_empty_host" ]
    mod_routers '(.[3].rule) = ""'
    run --separate-stderr cf green
    [ "$output" = "1 router_empty_host" ]
}

@test "confirm: a router whose status is not enabled is a failure" {
    world green
    mod_routers '(.[3].status) = "disabled"'
    run --separate-stderr cf green
    [ "$output" = "1 router_not_enabled" ]
    # a router with no status at all is not enabled either
    mod_routers 'del(.[3].status)'
    run --separate-stderr cf green
    [ "$output" = "1 router_not_enabled" ]
}

@test "confirm: Traefik's own routers are not judged and HostRegexp rules pass" {
    world green
    mod_routers '(.[0].status) = "disabled" | (.[0].rule) = ""'
    run --separate-stderr cf green
    [ "$output" = "0 " ]
}

@test "confirm: an empty router list is a failure (zero things checked)" {
    world green
    printf '[]' > "${DK}/routers.json"
    run --separate-stderr cf green
    [ "$output" = "1 no_routers" ]
}

@test "confirm: a truncated router list is refused with 2" {
    world green
    printf '2' > "${DK}/routers.next"
    run --separate-stderr cf green
    [ "$output" = "2 routers_truncated" ]
}

@test "confirm: the router list is asked for with a page size and a time bound" {
    world green
    run --separate-stderr cf green
    [ "$output" = "0 " ]
    grep -q 'api/http/routers?per_page=10000&page=1' "${DK}/curl.log"
    local l
    l="$(grep 'api/http/routers' "${DK}/curl.log")"
    [[ "$l" =~ --max-time\|([0-9]+)\| ]]
    [ "${BASH_REMATCH[1]}" -le 12 ]
}

@test "confirm: an API that does not answer is code 4, never a pass" {
    world green
    touch "${DK}/traefik.down"
    run --separate-stderr cf green
    [ "$output" = "4 traefik_unreachable" ]
    rm -f "${DK}/traefik.down"
    touch "${DK}/routers.down"
    run --separate-stderr cf green
    [ "$output" = "4 traefik_unreachable" ]
}

@test "confirm: an active-colour file that names the other colour is a failure" {
    world green
    printf 'blue\n' > "${GREMION_ROOT}/runtime/active-colour"
    run --separate-stderr cf green
    [ "$output" = "1 active_colour_file" ]
}

@test "confirm: a missing or unreadable active-colour file is code 2" {
    world green
    rm -f "${GREMION_ROOT}/runtime/active-colour"
    run --separate-stderr cf green
    [ "${output%% *}" = 2 ]
    printf 'purple\n' > "${GREMION_ROOT}/runtime/active-colour"
    run --separate-stderr cf green
    [ "${output%% *}" = 2 ]
}

@test "confirm: the same function confirms the old colour after a switch back" {
    use_panel
    world blue
    run --separate-stderr cf blue
    [ "$output" = "0 " ]
    run --separate-stderr cf green
    [ "${output%% *}" = 1 ]
}

@test "confirm: a bad colour is refused with 2" {
    run --separate-stderr cf red
    [ "${output%% *}" = 2 ]
}

@test "confirm: a failure names a reason code and a count, never a router, a rule or a customer" {
    world green
    mod_routers '(.[3].rule) = "Host(``)"'
    run --separate-stderr tl 'cd_traffic_confirm green || true'
    local all
    all="${output}${stderr}$(cat "${GREMION_ROOT}/data/cd/state.json" "${GREMION_ROOT}/data/cd/history.jsonl" 2>/dev/null || true)"
    [[ "$all" != *"$SLUG_MARKER"* ]]
    [[ "$all" != *"tenant-"* ]]
    mod_routers '(.[3].status) = "disabled"'
    run --separate-stderr tl 'cd_traffic_confirm green || true'
    [[ "${output}${stderr}" != *"$SLUG_MARKER"* ]]
}

# ================================================================= the truth

@test "truth: file and edge agree, one colour word on stdout, no state needed" {
    rm -f "${GREMION_ROOT}/data/cd/state.json"
    world blue
    run --separate-stderr tl 'cd_traffic_truth'
    [ "$status" -eq 0 ]
    [ "$output" = blue ]
    world green
    run --separate-stderr tl 'cd_traffic_truth'
    [ "$status" -eq 0 ]
    [ "$output" = green ]
}

@test "truth: the file says old and Traefik says new is non-zero, with a log line (the crash after the file write)" {
    world blue
    set_svc app@file gremion-ui green
    set_svc public@file gremion-public green
    run --separate-stderr tl 'cd_traffic_truth'
    [ "$status" -eq 1 ]
    [[ "$stderr" == *"disagree"* ]]
    [[ "$output" == *"file=blue"* ]]
    [[ "$output" == *"app=green"* ]]
}

@test "truth: a half-written edge (app on the new colour, public on the old) is a disagreement" {
    world blue
    set_svc app@file gremion-ui green
    run --separate-stderr tl 'cd_traffic_truth'
    [ "$status" -eq 1 ]
    [[ "$output" == "file=blue app=green public=blue" ]]
    world green
    set_svc public@file gremion-public blue
    run --separate-stderr tl 'cd_traffic_truth'
    [ "$status" -eq 1 ]
    [[ "$output" == "file=green app=green public=blue" ]]
}

@test "truth: an unknown server URL or no server is a disagreement, never a colour" {
    world blue
    jq -cn '{loadBalancer: {servers: [{url: "http://elsewhere.example.org:3000"}]}, serverStatus: {}}' > "${DK}/traefik.app@file"
    run --separate-stderr tl 'cd_traffic_truth'
    [ "$status" -eq 1 ]
    [[ "$output" == "file=blue app=other public=blue" ]]
    jq -cn '{loadBalancer: {servers: []}, serverStatus: {}}' > "${DK}/traefik.app@file"
    run --separate-stderr tl 'cd_traffic_truth'
    [ "$status" -eq 1 ]
    [[ "$output" == "file=blue app=other public=blue" ]]
}

@test "truth: an API that does not answer is 4 and a missing file is 2" {
    world blue
    touch "${DK}/traefik.down"
    run --separate-stderr tl 'cd_traffic_truth'
    [ "$status" -eq 4 ]
    rm -f "${DK}/traefik.down" "${GREMION_ROOT}/runtime/active-colour"
    run --separate-stderr tl 'cd_traffic_truth'
    [ "$status" -eq 2 ]
}

@test "truth: it reads the file and the edge, never our own state" {
    # the state says a release on green is switching; the running system says blue
    seed true
    world blue
    run --separate-stderr tl 'cd_traffic_truth'
    [ "$status" -eq 0 ]
    [ "$output" = blue ]
}
