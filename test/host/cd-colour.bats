#!/usr/bin/env bats
# test/host/cd-colour.bats -- cd-colour: infra/host/lib/cd/colour.sh, one app colour of the
# continuous deployment program: start, identity, the readiness gate, the probes, the
# worker gate file, isolation, verify and the guarded takedown.
#
# Run: MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W):/repo:ro" -w /repo gremion-bats:local test/host/cd-colour.bats
#
# Nothing here touches a real docker, curl, Traefik or network: docker, curl and git are
# recording shims whose answers are files under $DK, the host layout is a temp
# $GREMION_ROOT, the clock is the fake clock of test_helper/cd (cd_sleep advances it, so
# the 60 second window and the 5 second rounds cost nothing). Every name is a reserved
# example name. The test loader sources the REAL docker.sh next to colour.sh (the stub
# file of test_helper/cd would answer 0 for every cd_dc and cd_colour_* call).

bats_require_minimum_version 1.5.0
load 'test_helper/host'
load 'test_helper/cd'

FIX="${BATS_TEST_DIRNAME}/fixtures/cd/colour"
SECRET_MARKER="cd-colour-test-marker-not-a-real-secret"
TAG_NEW="pilot-bbbbbbbbbbbb"
TAG_OLD="pilot-aaaaaaaaaaaa"
IMG_NEW="sha256:$(printf 'b%.0s' $(seq 1 64))"
IMG_OLD="sha256:$(printf 'a%.0s' $(seq 1 64))"
TIP="$(printf 'c%.0s' $(seq 1 40))"

setup() {
    cd_setup
    export STACK=teststack
    unset CD_DC_TIMEOUT CD_WAIT_BAD GREMION_WORKERS_DIR
    export CD_WAIT_POLL_S=0 CD_COLOUR_HEALTHY_S=0 CD_COLOUR_ROUTE_WAIT_S=4 CD_COLOUR_EXEC_TIMEOUT_S=15
    DK="${SHIM_DIR}/dk"
    export DK
    mkdir -p "$DK" "${GREMION_ROOT}/bin" "${GREMION_ROOT}/releases/bbbbbbbbbbbb" "${GREMION_ROOT}/releases/aaaaaaaaaaaa"
    TREE="${GREMION_ROOT}/releases/bbbbbbbbbbbb"
    OLD_TREE="${GREMION_ROOT}/releases/aaaaaaaaaaaa"
    export TREE OLD_TREE
    : > "${TREE}/.git"
    cp "${FIX}/state.env" "${GREMION_ROOT}/etc/env/state.env"
    cp "${FIX}/app-blue.env" "${GREMION_ROOT}/etc/env/app-blue.env"
    cp "${FIX}/app-green.env" "${GREMION_ROOT}/etc/env/app-green.env"
    printf 'blue\n' > "${GREMION_ROOT}/runtime/active-colour"
    shim_docker
    shim_curl
    # the real mv, recorded in its own log (SHIM_LOG must stay empty for the worker gate)
    REAL_MV="$(command -v mv)"
    export REAL_MV
    printf '#!/usr/bin/env bash\n(IFS="|"; printf "%%s\\n" "$*" >> "$DK/mv.log")\n[ -f "$DK/mv.lie" ] && exit 0\nexec "$REAL_MV" "$@"\n' > "${SHIM_DIR}/mv"
    chmod +x "${SHIM_DIR}/mv"
    shim git "case \"\$*\" in *rev-parse*) printf '%s\n' '${TIP}' ;; esac"
}

teardown() {
    cd_teardown
}

# ------------------------------------------------------------------ the shims

# docker: every answer is a file in $DK.
#   argv.log            one line per call, args joined with '|'
#   order.log           up / down calls of compose, with the cwd, the colour of the env
#                       file and (for up) what the worker gate file held at that moment
#   exec-env.log        the whole environment of every `docker exec`
#   services            the `compose config --services` answer
#   cids.<proj>         every running container of a project; cid.<proj>.<svc> one of a service
#   exited.<proj>       the exited containers of a project (`ps -a --filter status=exited`)
#   status.<cid>        inspect answer of the health format, one line per call, the last sticks
#   restart.<cid>       RestartCount, one line per call, the last sticks
#   exit.<cid>          ExitCode of a container (default 0)
#   imgline.<cid>       "<image ref> <image id>"
#   image.<ref>         the id of a reference (/ and : become _)
#   svc.<cid> mounts.<cid> nets.<cid> eps.<cid>   the isolation formats
#   ready.<cid>         answers of the internal /readyz exec, one per call ("EXIT n" = fail)
#   portal.<cid>        answers of the portal exec
#   up.fail up.timeout up.killdaemon (up fails and docker stops answering) down.fail down.timeout ps.fail slow
shim_docker() {
    shim docker "$(cat <<'EOF'
(IFS='|'; printf '%s\n' "$*" >> "$DK/argv.log")
nextline() {
  local f="$1" n line
  [ -f "$f" ] || return 1
  n=$(cat "$f.n" 2>/dev/null || echo 0)
  line=$(sed -n "$((n + 1))p" "$f")
  [ -n "$line" ] || line=$(tail -n 1 "$f")
  echo $((n + 1)) > "$f.n"
  printf '%s\n' "$line"
}
case "$1" in
  compose)
    envf=''; prev=''
    for a in "$@"; do [ "$prev" = "--env-file" ] && envf="$a"; prev="$a"; done
    colour="$(basename "$envf" .env)"
    case " $* " in
      *" up "*)
        printf 'up %s cwd=%s workers=%s\n' "$colour" "$PWD" "$(cat "$GREMION_ROOT/runtime/workers/${colour#app-}" 2>/dev/null || echo absent)" >> "$DK/order.log"
        [ -f "$DK/up.timeout" ] && exit 124
        [ -f "$DK/up.killdaemon" ] && { touch "$DK/ps.fail"; exit 1; }
        [ -f "$DK/up.fail" ] && exit 1
        exit 0 ;;
      *" down "*|*" down")
        printf 'down %s cwd=%s\n' "$colour" "$PWD" >> "$DK/order.log"
        [ -f "$DK/down.timeout" ] && exit 124
        [ -f "$DK/down.fail" ] && exit 1
        exit 0 ;;
      *" config "*"--services"*)
        [ -f "$DK/services" ] && cat "$DK/services"
        exit 0 ;;
    esac
    exit 0 ;;
  ps)
    proj=''; svc=''; all=''; exited=''
    for a in "$@"; do
      case "$a" in
        label=com.docker.compose.project=*) proj="${a#label=com.docker.compose.project=}" ;;
        label=com.docker.compose.service=*) svc="${a#label=com.docker.compose.service=}" ;;
        -a) all=1 ;;
        status=exited) exited=1 ;;
      esac
    done
    [ -f "$DK/ps.fail" ] && exit 1
    if [ -n "$exited" ]; then [ -f "$DK/exited.$proj" ] && cat "$DK/exited.$proj"; exit 0; fi
    if [ -n "$svc" ]; then [ -f "$DK/cid.$proj.$svc" ] && cat "$DK/cid.$proj.$svc"
    else [ -f "$DK/cids.$proj" ] && cat "$DK/cids.$proj"; fi
    exit 0 ;;
  inspect)
    cid="${@: -1}"; fmt=''; prev=''
    for a in "$@"; do case "$prev" in -f|--format) fmt="$a" ;; esac; prev="$a"; done
    case "$fmt" in
      *State.Health*) nextline "$DK/status.$cid" || exit 1 ;;
      *RestartCount*) nextline "$DK/restart.$cid" || echo 0 ;;
      *State.ExitCode*) cat "$DK/exit.$cid" 2>/dev/null || echo 0 ;;
      *Config.Image*) cat "$DK/imgline.$cid" 2>/dev/null || exit 1 ;;
      *'index .Config.Labels'*) cat "$DK/svc.$cid" 2>/dev/null || exit 1 ;;
      *'$ep.Aliases'*) cat "$DK/eps.$cid" 2>/dev/null || true ;;
      *'.NetworkSettings.Networks'*) cat "$DK/nets.$cid" 2>/dev/null || true ;;
      *.Mounts*) cat "$DK/mounts.$cid" 2>/dev/null || true ;;
      *) exit 1 ;;
    esac
    exit 0 ;;
  image)
    ref="${@: -1}"; key=$(printf '%s' "$ref" | tr '/:' '__')
    [ -f "$DK/image.$key" ] || { echo "Error: No such image: $ref" >&2; exit 1; }
    cat "$DK/image.$key"
    exit 0 ;;
  exec)
    env | sort >> "$DK/exec-env.log"
    cid="$2"; script="$5"
    [ -f "$DK/slow" ] && sleep 5
    case "$script" in
      *'/readyz'*) f="$DK/ready.$cid" ;;
      *'process.argv[1]'*) f="$DK/portal.$cid" ;;
      *) exit 1 ;;
    esac
    line=$(nextline "$f") || exit 1
    case "$line" in EXIT\ *) exit "${line#EXIT }" ;; esac
    printf '%b' "$line"
    exit 0 ;;
esac
exit 0
EOF
)"
}

# curl: the Traefik API answers from traefik.<name>, the public readyz from pub.seq
# (one "<code>|<body>" per call, the last sticks), /healthz is always 200.
shim_curl() {
    shim curl "$(cat <<'EOF'
(IFS='|'; printf '%s\n' "$*" >> "$DK/curl.log")
url="${@: -1}"
nextline() {
  local f="$1" n line
  [ -f "$f" ] || return 1
  n=$(cat "$f.n" 2>/dev/null || echo 0)
  line=$(sed -n "$((n + 1))p" "$f")
  [ -n "$line" ] || line=$(tail -n 1 "$f")
  echo $((n + 1)) > "$f.n"
  printf '%s\n' "$line"
}
case "$url" in
  */api/version)
    [ -f "$DK/traefik.down" ] && { echo "curl: (7) Failed to connect" >&2; exit 7; }
    echo '{"Version":"3"}' ;;
  */api/http/services/*)
    [ -f "$DK/traefik.down" ] && { echo "curl: (7) Failed to connect" >&2; exit 7; }
    # traefik.svcfail: the API answered /api/version, then stops answering the service
    # reads: N calls fail (a number of calls), or every call while the file is empty
    if [ -f "$DK/traefik.svcfail" ]; then
      left=$(cat "$DK/traefik.svcfail")
      if [ -z "$left" ]; then echo "curl: (7) Failed to connect" >&2; exit 7; fi
      if [ "$left" -gt 0 ]; then echo $((left - 1)) > "$DK/traefik.svcfail"; echo "curl: (7) Failed to connect" >&2; exit 7; fi
    fi
    name="${url##*/api/http/services/}"
    [ -f "$DK/traefik.$name" ] || { echo "curl: (22) The requested URL returned error: 404" >&2; exit 22; }
    cat "$DK/traefik.$name" ;;
  */healthz)
    printf '{"ok":true}\n200' ;;
  */readyz)
    line=$(nextline "$DK/pub.seq") || exit 7
    printf '%s\n%s' "${line#*|}" "${line%%|*}" ;;
  *) exit 7 ;;
esac
exit 0
EOF
)"
}

# ------------------------------------------------------------------ the loader

# colour_lib 'snippet' -- a fresh bash with the real common.sh, core.sh, docker.sh and
# colour.sh and the config loaded. errexit is off on purpose: a library function is
# called from `if` and `||` in the real program and must not depend on it.
colour_lib() {
    local snippet="$1"
    shift
    bash -c "set -uo pipefail
. \"\${HOST_SRC}/lib/common.sh\"
. \"\${HOST_SRC}/lib/cd/core.sh\"
. \"\${HOST_SRC}/lib/cd/docker.sh\"
. \"\${HOST_SRC}/lib/cd/colour.sh\"
cd_paths_init
cd_cfg_load
${snippet}" colour-lib "$@"
}

# call 'cd_colour_x args' -- run it and print "rc=<n> reason=<code>" after its output.
call() {
    run colour_lib "${1}; echo \"rc=\$? reason=\${CD_COLOUR_REASON:-}\""
}

# ------------------------------------------------------------------ the fixture

# seqf FILE LINE... -- one line per call.
seqf() {
    local f="$1"
    shift
    printf '%s\n' "$@" > "$f"
}

# The ready answer of the internal probe, as the exec prints it.
ready_line() { # COLOUR TAG NOTREADY [STATUS]
    printf '%s\\n{"ready":true,"colour":"%s","release":"%s","tenants":{"total":3,"notReady":%s},"reasons":[]}\\n' "${4:-200}" "$1" "$2" "$3"
}

traefik_svc() { # NAME HOST COLOUR STATUS
    printf '{"loadBalancer":{"servers":[{"url":"http://%s-%s:3000"}]},"serverStatus":{"http://%s-%s:3000":"%s"},"status":"enabled","name":"%s","provider":"file","type":"loadbalancer"}\n' \
        "$2" "$3" "$2" "$3" "$4" "$1" > "$DK/traefik.$1"
}

# A container of the green project.
mk_container() { # CID SERVICE REF IMAGE_ID
    local c="$1" s="$2" proj=teststack-app-green
    printf '%s\n' "$c" > "$DK/cid.${proj}.${s}"
    printf '%s\n' "$c" >> "$DK/cids.${proj}"
    printf 'running healthy\n' > "$DK/status.${c}"
    printf '0\n' > "$DK/restart.${c}"
    printf '%s\n' "$s" > "$DK/svc.${c}"
    printf '%s %s\n' "$3" "$4" > "$DK/imgline.${c}"
    printf 'teststack_edge teststack_state teststack-app-green_app \n' > "$DK/nets.${c}"
    printf 'teststack_edge=%s-green, teststack_state=%s-green, teststack-app-green_app=%s, \n' "$s" "$s" "$s" > "$DK/eps.${c}"
    printf 'teststack-app-green_config-data  %s \n' "$(printf 'd%.0s' $(seq 1 64))" > "$DK/mounts.${c}"
}

# A green colour that passes every layer; the live colour is blue with baseline 1.
happy() {
    local ref_ui="ghcr.io/example/gremion-ui:${TAG_NEW}" ref_pub="ghcr.io/example/gremion-public:${TAG_NEW}"
    printf 'gremion-ui\ngremion-public\ncalendar-service\n' > "$DK/services"
    rm -f "$DK/cids.teststack-app-green"
    mk_container c-ui gremion-ui "$ref_ui" "$IMG_NEW"
    mk_container c-pub gremion-public "$ref_pub" "$IMG_NEW"
    mk_container c-cal calendar-service "docker.io/example/other@sha256:$(printf 'e%.0s' $(seq 1 64))" "sha256:$(printf 'e%.0s' $(seq 1 64))"
    printf '%s\n' "$IMG_NEW" > "$DK/image.ghcr.io_example_gremion-ui_${TAG_NEW}"
    printf '%s\n' "$IMG_NEW" > "$DK/image.ghcr.io_example_gremion-public_${TAG_NEW}"
    traefik_svc app-next@file gremion-ui green UP
    traefik_svc public-next@file gremion-public green UP
    traefik_svc app@file gremion-ui blue UP
    traefik_svc public@file gremion-public blue UP
    seqf "$DK/pub.seq" '200|{"ready":true}'
    printf '%s\n' "$(ready_line green "$TAG_NEW" 1)" > "$DK/ready.c-ui"
    printf '200\\n\n' > "$DK/portal.c-pub"
    seed_release 1
}

# The state: a release on green (tag pilot-bbbbbbbbbbbb) with the baseline of tenants
# not ready; BASELINE is a number or the word null.
seed_release() { # BASELINE
    cd_seed_state '.phase = "releasing" | .release = {
        "id":"bbbbbbbbbbbb-1","sha":"'"$(printf 'b%.0s' $(seq 1 40))"'","sha12":"bbbbbbbbbbbb","tag":"'"$TAG_NEW"'",
        "colour":"green","tree":"'"$TREE"'","mode":"auto","stage":"gates","stage_status":"started",
        "watch":{"baseline_not_ready":'"$1"'}}'
}

ready_green() { call "cd_colour_ready green ${TAG_NEW} \"\$TREE\""; }

# ================================================================== workers

@test "workers: get of an absent file is on; a content other than off reads as on; off reads as off" {
    call 'cd_colour_workers green get'
    [[ "$output" == "on"$'\n'"rc=0"* ]]
    mkdir -p "${GREMION_ROOT}/runtime/workers"
    printf 'ON' > "${GREMION_ROOT}/runtime/workers/green"
    call 'cd_colour_workers green get'
    [[ "$output" == "on"$'\n'"rc=0"* ]]
    printf 'garbage' > "${GREMION_ROOT}/runtime/workers/green"
    call 'cd_colour_workers green get'
    [[ "$output" == "on"$'\n'"rc=0"* ]]
    printf ' off' > "${GREMION_ROOT}/runtime/workers/green"
    call 'cd_colour_workers green get'
    [[ "$output" == "on"$'\n'"rc=0"* ]]
    printf 'off' > "${GREMION_ROOT}/runtime/workers/green"
    call 'cd_colour_workers green get'
    [[ "$output" == "off"$'\n'"rc=0"* ]]
    printf 'off\n' > "${GREMION_ROOT}/runtime/workers/green"
    call 'cd_colour_workers green get'
    [[ "$output" == "off"$'\n'"rc=0"* ]]
}

@test "workers: get of a path that is not a readable file is on" {
    mkdir -p "${GREMION_ROOT}/runtime/workers/green"
    call 'cd_colour_workers green get'
    [[ "$output" == "on"$'\n'"rc=0"* ]]
}

@test "workers: off and on are written on the host, read back, one colour at a time" {
    call 'cd_colour_workers green off'
    [[ "$output" == "rc=0"* ]]
    [ "$(cat "${GREMION_ROOT}/runtime/workers/green")" = off ]
    [ ! -e "${GREMION_ROOT}/runtime/workers/blue" ]
    call 'cd_colour_workers blue off'
    call 'cd_colour_workers green on'
    [[ "$output" == "rc=0"* ]]
    [ "$(cat "${GREMION_ROOT}/runtime/workers/green")" = on ]
    [ "$(cat "${GREMION_ROOT}/runtime/workers/blue")" = off ]
}

@test "workers: the write is atomic (no temp file is left), mode 0644, and needs no docker, no curl and no secret" {
    : > "$SHIM_LOG"
    call 'cd_colour_workers green off'
    [[ "$output" == "rc=0"* ]]
    # nothing but the one gate file is in the directory
    [ "$(ls -A "${GREMION_ROOT}/runtime/workers")" = green ]
    # written to a temp file in the same directory and renamed over the gate file
    assert_present "^-f\|-T\|--\|${GREMION_ROOT}/runtime/workers/\.green\.[A-Za-z0-9]+\|${GREMION_ROOT}/runtime/workers/green$" "$DK/mv.log" "the gate file was not renamed into place"
    if fs_carries_modes "${GREMION_ROOT}/runtime/workers"; then
        [ "$(stat -c %a "${GREMION_ROOT}/runtime/workers/green")" = 644 ]
        [ "$(stat -c %a "${GREMION_ROOT}/runtime/workers")" = 755 ]
    fi
    # no shim was called at all
    [ ! -s "$SHIM_LOG" ]
}

@test "workers: GREMION_WORKERS_DIR moves the directory, as the compose mount does" {
    export GREMION_WORKERS_DIR="${GREMION_ROOT}/elsewhere"
    call 'cd_colour_workers blue off'
    [[ "$output" == "rc=0"* ]]
    [ "$(cat "${GREMION_ROOT}/elsewhere/blue")" = off ]
    [ ! -e "${GREMION_ROOT}/runtime/workers" ]
}

@test "workers: GREMION_WORKERS_DIR of the colour's own env file moves the directory, as the compose mount reads it" {
    printf 'GREMION_WORKERS_DIR=%s/from-env-file\n' "$GREMION_ROOT" >> "${GREMION_ROOT}/etc/env/app-green.env"
    call 'cd_colour_workers green off'
    [[ "$output" == "rc=0"* ]]
    [ "$(cat "${GREMION_ROOT}/from-env-file/green")" = off ]
    [ ! -e "${GREMION_ROOT}/runtime/workers" ]
    call 'cd_colour_workers green get'
    [[ "$output" == "off"$'\n'"rc=0"* ]]
    # the other colour has no such key and keeps the default
    call 'cd_colour_workers blue off'
    [ "$(cat "${GREMION_ROOT}/runtime/workers/blue")" = off ]
}

@test "workers: the environment of the process wins over the env file, as it does for compose" {
    printf 'GREMION_WORKERS_DIR=%s/from-env-file\n' "$GREMION_ROOT" >> "${GREMION_ROOT}/etc/env/app-green.env"
    export GREMION_WORKERS_DIR="${GREMION_ROOT}/from-process"
    call 'cd_colour_workers green off'
    [[ "$output" == "rc=0"* ]]
    [ "$(cat "${GREMION_ROOT}/from-process/green")" = off ]
    [ ! -e "${GREMION_ROOT}/from-env-file" ]
}

@test "workers: a directory that compose would read differently (relative, or with a variable) is refused and nothing is written" {
    printf 'GREMION_WORKERS_DIR=relative/dir\n' >> "${GREMION_ROOT}/etc/env/app-green.env"
    call 'cd_colour_workers green off'
    [[ "$output" == *"rc=2"* ]]
    call 'cd_colour_workers green get'
    [[ "$output" == *"rc=2"* ]]
    sed -i '$d' "${GREMION_ROOT}/etc/env/app-green.env"
    printf 'GREMION_WORKERS_DIR=${GREMION_ROOT}/w\n' >> "${GREMION_ROOT}/etc/env/app-green.env"
    call 'cd_colour_workers green off'
    [[ "$output" == *"rc=2"* ]]
    [ ! -e "${GREMION_ROOT}/runtime/workers" ]
}

@test "workers: start writes off into the directory the env file names" {
    happy
    printf 'GREMION_WORKERS_DIR=%s/from-env-file\n' "$GREMION_ROOT" >> "${GREMION_ROOT}/etc/env/app-green.env"
    call "cd_colour_start \"\$TREE\" green ${TAG_NEW}"
    [[ "$output" == *"rc=0"* ]]
    [ "$(cat "${GREMION_ROOT}/from-env-file/green")" = off ]
}

@test "workers: a write that did not land is caught by the read-back" {
    touch "$DK/mv.lie"
    call 'cd_colour_workers green off'
    [[ "$output" == *"rc=1"* ]]
    # no temp file is left behind
    [ -z "$(ls -A "${GREMION_ROOT}/runtime/workers")" ]
}

@test "workers: a bad colour or mode is a usage error and writes nothing" {
    call 'cd_colour_workers purple off'
    [[ "$output" == *"rc=2"* ]]
    call 'cd_colour_workers green maybe'
    [[ "$output" == *"rc=2"* ]]
    [ ! -e "${GREMION_ROOT}/runtime/workers" ]
}

@test "workers: a write that cannot happen is an error, never a silent success" {
    mkdir -p "${GREMION_ROOT}/runtime"
    : > "${GREMION_ROOT}/runtime/workers"
    call 'cd_colour_workers green off'
    [[ "$output" == *"rc=2"* ]]
}

# ================================================================== start

@test "start: the worker gate is written off BEFORE the first up, a stale on is overwritten, leftovers go down first" {
    happy
    mkdir -p "${GREMION_ROOT}/runtime/workers"
    printf 'on' > "${GREMION_ROOT}/runtime/workers/green"
    call "cd_colour_start \"\$TREE\" green ${TAG_NEW}"
    [[ "$output" == *"rc=0"* ]]
    # down first, then up
    [ "$(sed -n 1p "$DK/order.log" | cut -d' ' -f1)" = down ]
    [ "$(sed -n 2p "$DK/order.log" | cut -d' ' -f1)" = up ]
    # what the file held at the moment of the up
    assert_present "^up app-green cwd=${TREE} workers=off$" "$DK/order.log" "the gate file was not off when the colour came up"
    [ "$(cat "${GREMION_ROOT}/runtime/workers/green")" = off ]
}

@test "start: up -d runs from the new tree with the target env file and no profile, no -f, no -p" {
    happy
    call "cd_colour_start \"\$TREE\" green ${TAG_NEW}"
    [[ "$output" == *"rc=0"* ]]
    assert_present "^compose\|--env-file\|${GREMION_ROOT}/etc/env/app-green.env\|up\|-d$" "$DK/argv.log" "up -d with the target env file"
    assert_absent '(^|\|)--profile(\||$)' "$DK/argv.log" "start passed a profile"
    assert_absent '(^|\|)(-f|-p|--file|--project-name)(\||$)' "$DK/argv.log" "start passed -f or -p"
    # the other colour is never named
    assert_absent 'app-blue' "$DK/argv.log" "start touched the other colour"
}

@test "start: an env file whose IMAGE_TAG is not the tag asked for is refused, nothing is touched" {
    happy
    call "cd_colour_start \"\$TREE\" green pilot-cccccccccccc"
    [[ "$output" == *"rc=2 reason=env_tag"* ]]
    [ ! -e "$DK/order.log" ]
    [ ! -e "${GREMION_ROOT}/runtime/workers/green" ]
}

@test "start: the stale previous case, the env of the old colour carries another tag, is refused" {
    call "cd_colour_start \"\$OLD_TREE\" blue ${TAG_NEW}"
    [[ "$output" == *"rc=2 reason=env_tag"* ]]
    [ ! -e "$DK/order.log" ]
}

@test "start: it refuses to take down the colour that serves (active-colour names it)" {
    happy
    printf 'green\n' > "${GREMION_ROOT}/runtime/active-colour"
    call "cd_colour_start \"\$TREE\" green ${TAG_NEW}"
    [[ "$output" == *"rc=1"* ]]
    [ ! -e "$DK/order.log" ]
    [ ! -e "${GREMION_ROOT}/runtime/workers/green" ]
}

@test "start: a compose up that fails is 1, one that times out is 4, and the gate stays off" {
    happy
    touch "$DK/up.fail"
    call "cd_colour_start \"\$TREE\" green ${TAG_NEW}"
    [[ "$output" == *"rc=1 reason=up_failed"* ]]
    rm -f "$DK/up.fail"
    touch "$DK/up.timeout"
    call "cd_colour_start \"\$TREE\" green ${TAG_NEW}"
    [[ "$output" == *"rc=4"* ]]
    [ "$(cat "${GREMION_ROOT}/runtime/workers/green")" = off ]
}

@test "start: leftovers that cannot be taken down, or a down that times out, are infrastructure (4), never a verdict on the commit" {
    happy
    touch "$DK/down.fail"
    call "cd_colour_start \"\$TREE\" green ${TAG_NEW}"
    [[ "$output" == *"rc=4"* ]]
    rm -f "$DK/down.fail"
    touch "$DK/down.timeout"
    call "cd_colour_start \"\$TREE\" green ${TAG_NEW}"
    [[ "$output" == *"rc=4"* ]]
    # nothing was brought up after the failed down
    assert_absent '^up ' "$DK/order.log" "an up ran after a down that failed"
}

@test "start: a compose up that fails while docker no longer answers is infrastructure (4)" {
    happy
    touch "$DK/up.killdaemon"
    call "cd_colour_start \"\$TREE\" green ${TAG_NEW}"
    [[ "$output" == *"rc=4"* ]]
}

@test "start: stack isolation passes with an anonymous volume, a bind mount and the aliases (the workers bind mount is accepted)" {
    happy
    # a bind mount has no name: its token is empty, an anonymous volume is 64 hex
    printf 'teststack-app-green_config-data  %s  \n' "$(printf 'd%.0s' $(seq 1 64))" > "$DK/mounts.c-ui"
    call "cd_colour_start \"\$TREE\" green ${TAG_NEW}"
    [[ "$output" == *"rc=0"* ]]
    # no teardown after the start
    [ "$(grep -c '^down ' "$DK/order.log")" -eq 1 ]
}

@test "start: a foreign volume tears the colour down" {
    happy
    printf 'otherstack_data  \n' > "$DK/mounts.c-pub"
    call "cd_colour_start \"\$TREE\" green ${TAG_NEW}"
    [[ "$output" == *"rc=1"* ]]
    [ "$(sed -n '$p' "$DK/order.log" | cut -d' ' -f1)" = down ]
    [ "$(grep -c '^down ' "$DK/order.log")" -eq 2 ]
}

@test "start: a foreign network tears the colour down" {
    happy
    printf 'teststack_edge otherstack_net \n' > "$DK/nets.c-ui"
    call "cd_colour_start \"\$TREE\" green ${TAG_NEW}"
    [[ "$output" == *"rc=1"* ]]
    [ "$(grep -c '^down ' "$DK/order.log")" -eq 2 ]
}

@test "start: a container with no colour alias on a shared network tears the colour down" {
    happy
    printf 'teststack_edge=gremion-ui-blue, teststack_state=gremion-ui-green, \n' > "$DK/eps.c-ui"
    call "cd_colour_start \"\$TREE\" green ${TAG_NEW}"
    [[ "$output" == *"rc=1"* ]]
    [ "$(grep -c '^down ' "$DK/order.log")" -eq 2 ]
}

@test "start: a colour that started no container is a violation, not a pass" {
    happy
    rm -f "$DK/cids.teststack-app-green"
    call "cd_colour_start \"\$TREE\" green ${TAG_NEW}"
    [[ "$output" == *"rc=1"* ]]
    [ "$(grep -c '^down ' "$DK/order.log")" -eq 2 ]
}

# ================================================================== identity

@test "identity: every first-party container runs the image of its own tag" {
    happy
    call "cd_colour_identity green ${TAG_NEW}"
    [[ "$output" == *"rc=0"* ]]
}

@test "identity: a container whose image ID is not the ID its own new tag resolves to fails" {
    happy
    printf '%s %s\n' "ghcr.io/example/gremion-ui:${TAG_NEW}" "$IMG_OLD" > "$DK/imgline.c-ui"
    call "cd_colour_identity green ${TAG_NEW}"
    [[ "$output" == *"rc=1 reason=identity"* ]]
}

@test "identity: a first-party container still on the OLD tag fails (it is not skipped as third party)" {
    happy
    printf '%s %s\n' "ghcr.io/example/gremion-public:${TAG_OLD}" "$IMG_OLD" > "$DK/imgline.c-pub"
    printf '%s\n' "$IMG_OLD" > "$DK/image.ghcr.io_example_gremion-public_${TAG_OLD}"
    call "cd_colour_identity green ${TAG_NEW}"
    [[ "$output" == *"rc=1 reason=identity"* ]]
}

@test "identity: an ID equal to the other colour's is NOT a failure (an unchanged service builds to the same image)" {
    happy
    # the live blue colour runs the same image under its own tag, and the new tag resolves to it too
    mkdir -p "$DK"
    printf '%s\n' "$IMG_OLD" > "$DK/image.ghcr.io_example_gremion-ui_${TAG_NEW}"
    printf '%s %s\n' "ghcr.io/example/gremion-ui:${TAG_NEW}" "$IMG_OLD" > "$DK/imgline.c-ui"
    printf '%s\n' "$IMG_OLD" > "$DK/image.ghcr.io_example_gremion-ui_${TAG_OLD}"
    call "cd_colour_identity green ${TAG_NEW}"
    [[ "$output" == *"rc=0"* ]]
}

@test "identity: no first-party container at all fails (zero things fails)" {
    happy
    rm -f "$DK/cids.teststack-app-green"
    printf 'c-cal\n' > "$DK/cids.teststack-app-green"
    call "cd_colour_identity green ${TAG_NEW}"
    [[ "$output" == *"rc=1 reason=identity"* ]]
}

@test "identity: an install that pins its first-party images by digest is told apart from a colour with none (2, not 1)" {
    happy
    local d
    d="$(printf 'e%.0s' $(seq 1 64))"
    printf '%s %s\n' "ghcr.io/example/gremion-ui@sha256:${d}" "$IMG_NEW" > "$DK/imgline.c-ui"
    printf '%s %s\n' "ghcr.io/example/gremion-public@sha256:${d}" "$IMG_NEW" > "$DK/imgline.c-pub"
    run --separate-stderr colour_lib "cd_colour_identity green ${TAG_NEW}; echo \"rc=\$? reason=\${CD_COLOUR_REASON:-}\""
    [[ "$output" == *"rc=2 reason=pinned_install"* ]]
    [[ "$stderr" == *"digest"* ]]
}

@test "identity: a tag that does not resolve, or a docker that does not answer, is not a pass" {
    happy
    rm -f "$DK/image.ghcr.io_example_gremion-ui_${TAG_NEW}"
    call "cd_colour_identity green ${TAG_NEW}"
    [[ "$output" == *"rc=1 reason=identity"* ]]
    touch "$DK/ps.fail"
    call "cd_colour_identity green ${TAG_NEW}"
    [[ "$output" == *"rc=4"* ]]
}

# ================================================================== ready

@test "ready: a colour that passes every layer is ready" {
    happy
    ready_green
    [ "$status" -eq 0 ]
    [[ "$output" == *"rc=0 reason="* ]]
}

@test "ready: layer 1, a container that is not healthy" {
    happy
    printf 'running starting\n' > "$DK/status.c-ui"
    ready_green
    [[ "$output" == *"rc=1 reason=unhealthy"* ]]
}

@test "ready: layer 1, a restart count that rises during the stable window" {
    happy
    printf '0\n1\n' > "$DK/restart.c-pub"
    ready_green
    [[ "$output" == *"rc=1 reason=restart"* ]]
}

@test "ready: layer 1, a container that turns unhealthy during the stable window" {
    happy
    printf 'running healthy\nrunning unhealthy\n' > "$DK/status.c-ui"
    ready_green
    [[ "$output" == *"rc=1 reason=restart"* ]]
}

@test "ready: layer 1, a health read that cannot be made at the end of the stable window is 2, not a restart verdict" {
    happy
    rm -f "$DK/w.n"
    call 'cd_wait_healthy() { local n; n=$(cat "$DK/w.n" 2>/dev/null || echo 0); echo $((n + 1)) > "$DK/w.n"; [ "$n" -ge 1 ] && return 2; return 0; }
        cd_colour_ready green '"${TAG_NEW}"' "$TREE"'
    [[ "$output" == *"rc=2 reason=unhealthy"* ]]
    # the second call is the one at the end of the window
    [ "$(cat "$DK/w.n")" -eq 2 ]
}

@test "ready: layer 1, a docker daemon that does not answer during the health wait is infrastructure (4), not a verdict on the commit" {
    happy
    touch "$DK/ps.fail"
    ready_green
    [[ "$output" == *"rc=4 reason=docker_none"* ]]
    rm -f "$DK/ps.fail"
    # an inspect that fails is the same
    rm -f "$DK/status.c-ui" "$DK/status.c-ui.n"
    ready_green
    [[ "$output" == *"rc=4 reason=docker_none"* ]]
}

@test "ready: layer 1, a service that is really not healthy stays a verdict (1) even when another read failed" {
    happy
    rm -f "$DK/status.c-ui" "$DK/status.c-ui.n"
    printf 'running starting\n' > "$DK/status.c-pub"
    ready_green
    [[ "$output" == *"rc=1 reason=unhealthy"* ]]
}

@test "ready: layer 1, a docker that stops answering at the end of the stable window is infrastructure (4)" {
    happy
    rm -f "$DK/w.n"
    call 'cd_wait_healthy() { local n; n=$(cat "$DK/w.n" 2>/dev/null || echo 0); echo $((n + 1)) > "$DK/w.n"; [ "$n" -ge 1 ] && { CD_WAIT_BAD=" gremion-ui(docker_error) gremion-public(inspect_failed)"; return 3; }; return 0; }
        cd_colour_ready green '"${TAG_NEW}"' "$TREE"'
    [[ "$output" == *"rc=4 reason=docker_none"* ]]
    [ "$(cat "$DK/w.n")" -eq 2 ]
}

@test "ready: layer 1, a one-shot that exited non-zero" {
    happy
    printf 'c-migrate\n' > "$DK/exited.teststack-app-green"
    printf '1\n' > "$DK/exit.c-migrate"
    ready_green
    [[ "$output" == *"rc=1 reason=oneshot"* ]]
}

@test "ready: layer 1, a one-shot that exited zero is fine" {
    happy
    printf 'c-migrate\n' > "$DK/exited.teststack-app-green"
    printf '0\n' > "$DK/exit.c-migrate"
    ready_green
    [[ "$output" == *"rc=0 reason="* ]]
}

@test "ready: layer 1, a first-party container on the wrong image (identity)" {
    happy
    printf '%s %s\n' "ghcr.io/example/gremion-ui:${TAG_NEW}" "$IMG_OLD" > "$DK/imgline.c-ui"
    ready_green
    [[ "$output" == *"rc=1 reason=identity"* ]]
}

@test "ready: layer 1, a foreign volume (stack isolation)" {
    happy
    printf 'otherstack_data \n' > "$DK/mounts.c-ui"
    ready_green
    [[ "$output" == *"rc=1 reason=stack_isolation"* ]]
}

@test "ready: layer 2, app-next@file is not UP" {
    happy
    traefik_svc app-next@file gremion-ui green DOWN
    ready_green
    [[ "$output" == *"rc=1 reason=next_route_down"* ]]
}

@test "ready: layer 2, public-next@file is not UP" {
    happy
    traefik_svc public-next@file gremion-public green DOWN
    ready_green
    [[ "$output" == *"rc=1 reason=next_route_down"* ]]
}

@test "ready: layer 2, app-next@file points at the wrong colour" {
    happy
    traefik_svc app-next@file gremion-ui blue UP
    ready_green
    [[ "$output" == *"rc=1 reason=next_route_colour"* ]]
}

@test "ready: layer 2, the Traefik API that does not answer is infrastructure (4), not a verdict on the colour" {
    happy
    touch "$DK/traefik.down"
    ready_green
    [[ "$output" == *"rc=4"* ]]
}

@test "ready: layer 2, a Traefik API that does not answer says curl's reason" {
    happy
    touch "$DK/traefik.down"
    run --separate-stderr colour_lib "cd_colour_ready green ${TAG_NEW} \"\$TREE\"; echo \"rc=\$?\""
    [[ "$output" == *"rc=4"* ]]
    [[ "$stderr" == *"the Traefik API does not answer: curl: (7) Failed to connect"* ]]
}

@test "ready: layer 2, a Traefik API that stops answering AFTER the first check is infrastructure (4), not a verdict on the commit" {
    happy
    # /api/version answers, the service reads do not (an edge restart inside the window)
    : > "$DK/traefik.svcfail"
    ready_green
    [[ "$output" == *"rc=4 reason=next_route_none"* ]]
}

@test "ready: layer 2, a service that the Traefik API answers 404 for (the switch file is not loaded) is infrastructure (4)" {
    happy
    rm -f "$DK/traefik.app-next@file"
    ready_green
    [[ "$output" == *"rc=4 reason=next_route_none"* ]]
}

@test "ready: layer 2, an edge that comes back inside the route window passes" {
    happy
    # the first service read fails, the retry two seconds later answers
    echo 1 > "$DK/traefik.svcfail"
    ready_green
    [[ "$output" == *"rc=0 reason="* ]]
}

@test "ready: layer 2, a public probe that gets no answer at all is infrastructure (4), not a verdict on the commit" {
    happy
    rm -f "$DK/pub.seq"
    ready_green
    [[ "$output" == *"rc=4 reason=public_none"* ]]
    # the status 000 curl writes when nothing answered is the same case
    seqf "$DK/pub.seq" '000|'
    ready_green
    [[ "$output" == *"rc=4 reason=public_none"* ]]
}

@test "ready: layer 2, the portal list page answering 500 fails the gate" {
    happy
    printf '500\\n\n' > "$DK/portal.c-pub"
    ready_green
    [[ "$output" == *"rc=1 reason=portal"* ]]
}

@test "ready: layer 2, a portal that cannot be reached fails the gate" {
    happy
    printf 'EXIT 5\n' > "$DK/portal.c-pub"
    ready_green
    [[ "$output" == *"rc=1 reason=portal"* ]]
}

@test "ready: layer 2, the public /readyz answering 200 with {ready:false}" {
    happy
    seqf "$DK/pub.seq" '200|{"ready":false}'
    ready_green
    [[ "$output" == *"rc=1 reason=public_ready"* ]]
}

@test "ready: layer 2, the public /readyz answering 503" {
    happy
    seqf "$DK/pub.seq" '503|{"ready":false}'
    ready_green
    [[ "$output" == *"rc=1 reason=public_ready"* ]]
}

@test "ready: layer 2, the public status code is checked on its own (503 with a ready body)" {
    happy
    seqf "$DK/pub.seq" '503|{"ready":true}'
    ready_green
    [[ "$output" == *"rc=1 reason=public_ready"* ]]
}

@test "ready: layer 2, a public body that is more than {ready:true} fails" {
    happy
    seqf "$DK/pub.seq" '200|{"ready":true,"colour":"green"}'
    ready_green
    [[ "$output" == *"rc=1 reason=public_ready"* ]]
}

@test "ready: layer 2, flapping (200, 200, 503) fails: three consecutive rounds are required" {
    happy
    seqf "$DK/pub.seq" '200|{"ready":true}' '200|{"ready":true}' '503|{"ready":false}'
    ready_green
    [[ "$output" == *"rc=1 reason=public_ready"* ]]
    # all three rounds were taken, none skipped
    [ "$(grep -c '/readyz' "$DK/curl.log")" -eq 3 ]
}

@test "ready: layer 2, /healthz answers 200 while /readyz answers 503 (a healthy process is not a ready one)" {
    happy
    seqf "$DK/pub.seq" '503|{"ready":false}'
    ready_green
    [[ "$output" == *"rc=1 reason=public_ready"* ]]
    # the probe asked /readyz, never /healthz
    assert_absent 'healthz' "$DK/curl.log" "the gate looked at /healthz"
}

@test "ready: layer 2, the public probe goes through the loopback test router with a non-real Host header" {
    happy
    ready_green
    [[ "$output" == *"rc=0"* ]]
    assert_present 'http://127.0.0.1:18081/readyz' "$DK/curl.log" "the internaltest port of state.env"
    assert_present 'Host: cd-readiness.invalid' "$DK/curl.log" "a Host header"
}

@test "ready: layer 2, the internal probe says it is not ready" {
    happy
    printf '%s\n' '503\n{"ready":false,"colour":"green","release":"'"$TAG_NEW"'","tenants":{"total":3,"notReady":0},"reasons":["control_db"]}\n' > "$DK/ready.c-ui"
    ready_green
    [[ "$output" == *"rc=1 reason=internal_ready"* ]]
}

@test "ready: layer 2, the internal probe with the colour wrong" {
    happy
    printf '%s\n' "$(ready_line blue "$TAG_NEW" 1)" > "$DK/ready.c-ui"
    ready_green
    [[ "$output" == *"rc=1 reason=internal_colour"* ]]
}

@test "ready: layer 2, the internal probe with the release wrong (the stale tag case)" {
    happy
    printf '%s\n' "$(ready_line green "$TAG_OLD" 1)" > "$DK/ready.c-ui"
    ready_green
    [[ "$output" == *"rc=1 reason=internal_release"* ]]
}

@test "ready: layer 2, tenants not ready ABOVE the baseline fails" {
    happy
    printf '%s\n' "$(ready_line green "$TAG_NEW" 2)" > "$DK/ready.c-ui"
    ready_green
    [[ "$output" == *"rc=1 reason=tenants_not_ready"* ]]
}

@test "ready: layer 2, tenants not ready EQUAL to the baseline passes (one customer already down on the live colour)" {
    happy
    seed_release 2
    printf '%s\n' "$(ready_line green "$TAG_NEW" 2)" > "$DK/ready.c-ui"
    ready_green
    [[ "$output" == *"rc=0 reason="* ]]
}

@test "ready: layer 2, tenants not ready BELOW the baseline passes" {
    happy
    seed_release 4
    ready_green
    [[ "$output" == *"rc=0 reason="* ]]
}

@test "ready: a baseline that is null fails closed" {
    happy
    seed_release null
    ready_green
    [[ "$output" == *"rc=2 reason=baseline_unreadable"* ]]
}

@test "ready: a state that cannot be read fails closed" {
    happy
    rm -f "${GREMION_ROOT}/data/cd/state.json"
    ready_green
    [[ "$output" == *"rc=2"* ]]
}

@test "ready: layer 2, an internal probe with no answer is not ready" {
    happy
    printf 'EXIT 5\n' > "$DK/ready.c-ui"
    ready_green
    [[ "$output" == *"rc=1 reason=internal_none"* ]]
}

@test "ready: the tree comes from the state when it is not given, and a colour no record names is 2" {
    happy
    call "cd_colour_ready green ${TAG_NEW}"
    [[ "$output" == *"rc=0 reason="* ]]
    call "cd_colour_ready blue ${TAG_OLD}"
    [[ "$output" == *"rc=2 reason=no_tree"* ]]
}

@test "ready: a bad colour or tag is a usage error" {
    call "cd_colour_ready purple ${TAG_NEW} \"\$TREE\""
    [[ "$output" == *"rc=2"* ]]
    call 'cd_colour_ready green latest "$TREE"'
    [[ "$output" == *"rc=2"* ]]
}

# ================================================================== probes

@test "probe: the answer of the internal /readyz is printed as compact JSON" {
    happy
    run colour_lib 'cd_colour_probe green'
    [ "$status" -eq 0 ]
    [ "$(printf '%s' "$output" | jq -r '.colour + " " + .release + " " + (.tenants.notReady | tostring)')" = "green ${TAG_NEW} 1" ]
}

@test "probe: docker exec of node, the secret is read inside the container and is on no argv and in no environment" {
    happy
    run colour_lib 'cd_colour_probe green'
    [ "$status" -eq 0 ]
    # the call is a plain exec of node -e: no -i, -t, -e or --env handed to docker
    assert_present '^exec\|c-ui\|node\|-e\|' "$DK/argv.log" "docker exec c-ui node -e"
    assert_absent '^exec\|(-i|-t|--env|-e)\|' "$DK/argv.log" "docker exec was given flags"
    assert_absent "$SECRET_MARKER" "$DK/argv.log" "the secret is on an argv"
    : >> "$DK/curl.log"
    assert_absent "$SECRET_MARKER" "$DK/curl.log" "the secret is on a curl argv"
    assert_absent "$SECRET_MARKER" "$DK/exec-env.log" "the secret is in the environment of docker exec"
    assert_absent "$SECRET_MARKER" "$SHIM_LOG" "the secret is in a recorded call"
    # the script reads it from the container's own environment
    assert_present 'process.env.INTERNAL_PUSH_SECRET' "$DK/argv.log" "the script does not read the secret inside the container"
}

@test "probe: an unreachable container is no answer, not ready" {
    happy
    printf 'EXIT 5\n' > "$DK/ready.c-ui"
    call 'cd_colour_probe green'
    [[ "$output" == *"rc=1"* ]]
    # nothing printed as an answer
    [[ "$output" != *'"ready"'* ]]
}

@test "probe: no running gremion-ui container is no answer" {
    happy
    rm -f "$DK/cid.teststack-app-green.gremion-ui"
    call 'cd_colour_probe green'
    [[ "$output" == *"rc=1"* ]]
}

@test "probe: the anonymous shape, a wrong status and a body that is not JSON are no answer" {
    happy
    printf '%s\n' '200\n{"ready":true}\n' > "$DK/ready.c-ui"
    call 'cd_colour_probe green'
    [[ "$output" == *"rc=1"* ]]
    printf '%s\n' '500\n{"ready":true,"colour":"green","release":"x","tenants":{"total":1,"notReady":0}}\n' > "$DK/ready.c-ui"
    call 'cd_colour_probe green'
    [[ "$output" == *"rc=1"* ]]
    printf '%s\n' '200\nnot json\n' > "$DK/ready.c-ui"
    call 'cd_colour_probe green'
    [[ "$output" == *"rc=1"* ]]
}

@test "probe: a call that hangs is cut off and is no answer" {
    happy
    touch "$DK/slow"
    export CD_COLOUR_EXEC_TIMEOUT_S=1
    call 'cd_colour_probe green'
    [[ "$output" == *"rc=1"* ]]
}

@test "probe: docker that does not answer is 4" {
    happy
    touch "$DK/ps.fail"
    call 'cd_colour_probe green'
    [[ "$output" == *"rc=4"* ]]
}

@test "portal probe: a 200 passes, with the base path of state.env and no host and no secret on any argv" {
    happy
    sed -i 's|^PUBLIC_BASE_PATH=.*|PUBLIC_BASE_PATH=/portal|' "${GREMION_ROOT}/etc/env/state.env"
    call 'cd_colour_portal_probe green'
    [[ "$output" == *"rc=0"* ]]
    assert_present '^exec\|c-pub\|node\|-e\|.*\|/portal/protokolle$' "$DK/argv.log" "the request path was not given as the argument"
    assert_absent "$SECRET_MARKER" "$DK/argv.log" "a secret on an argv"
    assert_absent "$SECRET_MARKER" "$DK/exec-env.log" "a secret in the environment"
    assert_absent 'example\.org|Host' "$DK/argv.log" "a host on an argv"
}

@test "portal probe: with an empty base path the request is /protokolle" {
    happy
    call 'cd_colour_portal_probe green'
    [[ "$output" == *"rc=0"* ]]
    assert_present '\|/protokolle$' "$DK/argv.log" "the request path"
}

@test "portal probe: a 404 is below 500 and passes" {
    happy
    printf '404\\n\n' > "$DK/portal.c-pub"
    call 'cd_colour_portal_probe green'
    [[ "$output" == *"rc=0"* ]]
}

@test "portal probe: a 500, a timeout and an unreachable container are failures" {
    happy
    printf '500\\n\n' > "$DK/portal.c-pub"
    call 'cd_colour_portal_probe green'
    [[ "$output" == *"rc=1"* ]]
    printf 'EXIT 5\n' > "$DK/portal.c-pub"
    call 'cd_colour_portal_probe green'
    [[ "$output" == *"rc=1"* ]]
    printf '200\\n\n' > "$DK/portal.c-pub"
    touch "$DK/slow"
    export CD_COLOUR_EXEC_TIMEOUT_S=1
    call 'cd_colour_portal_probe green'
    [[ "$output" == *"rc=1"* ]]
    rm -f "$DK/slow" "$DK/cid.teststack-app-green.gremion-public"
    call 'cd_colour_portal_probe green'
    [[ "$output" == *"rc=1"* ]]
}

@test "portal probe: a base path that is not a base path is refused, not spliced anywhere" {
    happy
    sed -i 's|^PUBLIC_BASE_PATH=.*|PUBLIC_BASE_PATH=/a;b|' "${GREMION_ROOT}/etc/env/state.env"
    call 'cd_colour_portal_probe green'
    [[ "$output" == *"rc=2"* ]]
    # no docker call at all: the base path is read before the container is looked up
    [ ! -e "$DK/argv.log" ]
}

# ================================================================== isolation

shim_isolation() {
    cat > "${GREMION_ROOT}/bin/gremion-isolation" <<'EOF'
#!/usr/bin/env bash
printf '%s|%s\n' "${GREMION_RELEASE_DIR:-unset}" "$*" >> "$DK/iso.log"
echo "output that names host.example.org and a router table"
echo "stderr line for host.example.org" >&2
[ -f "$DK/iso.hang" ] && exec sleep 30
[ -f "$DK/iso.fail" ] && exit "$(cat "$DK/iso.fail")"
if [ "$1" = run ]; then
  out="$3"
  [ -f "$DK/iso.noevidence" ] || { mkdir -p "$out"; echo '{}' > "$out/${ISO_TIP}.json"; }
fi
exit 0
EOF
    chmod +x "${GREMION_ROOT}/bin/gremion-isolation"
    export ISO_TIP="$TIP"
}

@test "isolation run: it runs with GREMION_RELEASE_DIR set to the new tree and prints the evidence path of the new tip" {
    shim_isolation
    run colour_lib 'cd_colour_isolation_run "$TREE"'
    [ "$status" -eq 0 ]
    [ "$output" = "${GREMION_ROOT}/data/isolation-evidence/${TIP}.json" ]
    assert_present "^${TREE}\|run --out ${GREMION_ROOT}/data/isolation-evidence$" "$DK/iso.log" "the run did not get the new tree"
}

@test "isolation run: its output is in a 0600 file under logs/ and on neither stdout nor stderr" {
    shim_isolation
    run --separate-stderr colour_lib 'cd_colour_isolation_run "$TREE"'
    [ "$status" -eq 0 ]
    [[ "$output" != *"host.example.org"* ]]
    [[ "$stderr" != *"host.example.org"* ]]
    local f
    f="$(ls "${GREMION_ROOT}"/logs/cd-isolation-*.log)"
    assert_present 'host.example.org' "$f" "the output of the program was not kept"
    if fs_carries_modes "${GREMION_ROOT}/logs"; then
        [ "$(stat -c %a "$f")" = 600 ]
    fi
}

@test "isolation run: a program that fails is 1 and names the log file, not its output" {
    shim_isolation
    echo 1 > "$DK/iso.fail"
    run --separate-stderr colour_lib 'cd_colour_isolation_run "$TREE"; echo "rc=$?"'
    [[ "$output" == *"rc=1"* ]]
    [[ "$stderr" == *"logs/cd-isolation-"* ]]
    [[ "$stderr" != *"host.example.org"* ]]
}

@test "isolation run: exit 0 with no evidence file for the new tip is a failure" {
    shim_isolation
    touch "$DK/iso.noevidence"
    call 'cd_colour_isolation_run "$TREE"'
    [[ "$output" == *"rc=1 reason=isolation_run"* ]]
}

@test "isolation run: a tree with no tip, or a program that is not installed, is 2" {
    shim_isolation
    rm -f "${TREE}/.git"
    call 'cd_colour_isolation_run "$TREE"'
    [[ "$output" == *"rc=2"* ]]
    : > "${TREE}/.git"
    rm -f "${GREMION_ROOT}/bin/gremion-isolation"
    call 'cd_colour_isolation_run "$TREE"'
    [[ "$output" == *"rc=2"* ]]
}

@test "isolation record: it is its own function, needs the evidence file of the new tip and records it with the new tree" {
    shim_isolation
    call 'cd_colour_isolation_record "$TREE"'
    [[ "$output" == *"rc=1 reason=isolation_record"* ]]
    [ ! -e "$DK/iso.log" ]
    mkdir -p "${GREMION_ROOT}/data/isolation-evidence"
    echo '{}' > "${GREMION_ROOT}/data/isolation-evidence/${TIP}.json"
    call 'cd_colour_isolation_record "$TREE"'
    [[ "$output" == *"rc=0"* ]]
    assert_present "^${TREE}\|record ${GREMION_ROOT}/data/isolation-evidence/${TIP}.json$" "$DK/iso.log" "record was not called with the new tree"
    # the run was never called by the record
    assert_absent '\|run ' "$DK/iso.log" "record ran the producer"
}

@test "isolation run: the exit codes of the program are told apart (1 assertion, 2 precondition, 3 blocked, anything else infrastructure)" {
    shim_isolation
    echo 2 > "$DK/iso.fail"
    call 'cd_colour_isolation_run "$TREE"'
    [[ "$output" == *"rc=2 reason=isolation_run"* ]]
    echo 3 > "$DK/iso.fail"
    call 'cd_colour_isolation_run "$TREE"'
    [[ "$output" == *"rc=3 reason=isolation_run"* ]]
    echo 137 > "$DK/iso.fail"
    call 'cd_colour_isolation_run "$TREE"'
    [[ "$output" == *"rc=4 reason=isolation_run"* ]]
    echo 1 > "$DK/iso.fail"
    call 'cd_colour_isolation_run "$TREE"'
    [[ "$output" == *"rc=1 reason=isolation_run"* ]]
}

@test "isolation record: the exit codes of the program are told apart too" {
    shim_isolation
    mkdir -p "${GREMION_ROOT}/data/isolation-evidence"
    echo '{}' > "${GREMION_ROOT}/data/isolation-evidence/${TIP}.json"
    echo 2 > "$DK/iso.fail"
    call 'cd_colour_isolation_record "$TREE"'
    [[ "$output" == *"rc=2 reason=isolation_record"* ]]
    echo 3 > "$DK/iso.fail"
    call 'cd_colour_isolation_record "$TREE"'
    [[ "$output" == *"rc=3 reason=isolation_record"* ]]
}

@test "isolation run and record: the tip of a SHA-256 repository (64 hex) is accepted, as the program's own release tip accepts it" {
    local tip64
    tip64="$(printf 'f%.0s' $(seq 1 64))"
    shim git "case \"\$*\" in *rev-parse*) printf '%s\n' '${tip64}' ;; esac"
    shim_isolation
    export ISO_TIP="$tip64"
    call 'cd_colour_isolation_run "$TREE"'
    [[ "$output" == *"rc=0"* ]]
    [[ "$output" == *"/${tip64}.json"* ]]
    call 'cd_colour_isolation_record "$TREE"'
    [[ "$output" == *"rc=0"* ]]
    assert_present "record ${GREMION_ROOT}/data/isolation-evidence/${tip64}.json$" "$DK/iso.log" "the record did not name the evidence of the 64 hex tip"
    # a tip of any other length is still no tip
    shim git "case \"\$*\" in *rev-parse*) printf '%s\n' '${tip64}ff' ;; esac"
    call 'cd_colour_isolation_run "$TREE"'
    [[ "$output" == *"rc=2"* ]]
}

@test "isolation record: a failing record is 1" {
    shim_isolation
    mkdir -p "${GREMION_ROOT}/data/isolation-evidence"
    echo '{}' > "${GREMION_ROOT}/data/isolation-evidence/${TIP}.json"
    echo 1 > "$DK/iso.fail"
    call 'cd_colour_isolation_record "$TREE"'
    [[ "$output" == *"rc=1 reason=isolation_record"* ]]
}

@test "isolation run and record: a program that hangs is cut off by the time limit and is infrastructure (4)" {
    shim_isolation
    mkdir -p "${GREMION_ROOT}/data/isolation-evidence"
    echo '{}' > "${GREMION_ROOT}/data/isolation-evidence/${TIP}.json"
    touch "$DK/iso.hang"
    export CD_COLOUR_ISOLATION_TIMEOUT_S=1 CD_COLOUR_ISOLATION_RECORD_TIMEOUT_S=1
    SECONDS=0
    call 'cd_colour_isolation_run "$TREE"'
    [[ "$output" == *"rc=4 reason=isolation_run"* ]]
    call 'cd_colour_isolation_record "$TREE"'
    [[ "$output" == *"rc=4 reason=isolation_record"* ]]
    # two one-second limits, not the 30 seconds the program slept
    [ "$SECONDS" -lt 20 ]
}

# ================================================================== verify

shim_verify() {
    cat > "${GREMION_ROOT}/bin/gremion-verify" <<'EOF'
#!/usr/bin/env bash
printf '%s|%s\n' "${GREMION_WAIVER_LEDGER:-unset}" "$*" >> "$DK/verify.log"
echo "router table of host.example.org"
exit "$(cat "$DK/verify.rc" 2>/dev/null || echo 0)"
EOF
    chmod +x "${GREMION_ROOT}/bin/gremion-verify"
    mkdir -p "${TREE}/docs/ops"
    : > "${TREE}/docs/ops/release-1-waivers.md"
}

@test "verify: a pass is 0 and it ran against the colour with the waiver ledger of the new tree" {
    shim_verify
    call 'cd_colour_verify green "$TREE"'
    [[ "$output" == *"rc=0"* ]]
    assert_present "^${TREE}/docs/ops/release-1-waivers.md\|--colour green$" "$DK/verify.log" "verify was not run with the ledger of the tree"
}

@test "verify: with CD_VERIFY_ENFORCE=0 a failure is logged and counted and returns 0" {
    shim_verify
    echo 1 > "$DK/verify.rc"
    cd_write_cfg CD_VERIFY_ENFORCE=0
    run --separate-stderr colour_lib 'cd_colour_verify green "$TREE"; echo "rc=$?"'
    [[ "$output" == *"rc=0"* ]]
    [[ "$stderr" == *"reported only"* ]]
    [[ "$stderr" != *"host.example.org"* ]]
    # counted, names and counts only
    assert_present '"event":"verify_report"' "${GREMION_ROOT}/data/cd/history.jsonl" "the failure was not counted"
    assert_present '"enforce":0' "${GREMION_ROOT}/data/cd/history.jsonl" "the mode was not recorded"
    assert_absent 'host.example.org' "${GREMION_ROOT}/data/cd/history.jsonl" "a host name in the history"
}

@test "verify: with CD_VERIFY_ENFORCE=1 a failure returns 1 and a program that could not run returns 2" {
    shim_verify
    cd_write_cfg CD_VERIFY_ENFORCE=1
    echo 1 > "$DK/verify.rc"
    call 'cd_colour_verify green "$TREE"'
    [[ "$output" == *"rc=1 reason=verify"* ]]
    echo 2 > "$DK/verify.rc"
    call 'cd_colour_verify green "$TREE"'
    [[ "$output" == *"rc=2 reason=verify"* ]]
    # a program cut off by the time limit is infrastructure, not a verdict on the commit
    echo 124 > "$DK/verify.rc"
    call 'cd_colour_verify green "$TREE"'
    [[ "$output" == *"rc=4 reason=verify"* ]]
}

@test "verify: an exit code that gremion-verify does not document (3) is infrastructure (4), never a blocked retry" {
    shim_verify
    cd_write_cfg CD_VERIFY_ENFORCE=1
    echo 3 > "$DK/verify.rc"
    call 'cd_colour_verify green "$TREE"'
    [[ "$output" == *"rc=4 reason=verify"* ]]
}

@test "verify: the output of the program is in a 0600 file under logs/, not on stdout or stderr" {
    shim_verify
    cd_write_cfg CD_VERIFY_ENFORCE=1
    echo 1 > "$DK/verify.rc"
    run --separate-stderr colour_lib 'cd_colour_verify green "$TREE"; echo "rc=$?"'
    [[ "$output" != *"host.example.org"* ]]
    [[ "$stderr" != *"host.example.org"* ]]
    [[ "$stderr" == *"logs/cd-verify-"* ]]
    assert_present 'host.example.org' "$(ls "${GREMION_ROOT}"/logs/cd-verify-*.log)" "the output was not kept"
}

# ================================================================== gates

@test "gates: ready, isolation, verify and the probe again, in that order, and the first failure stops" {
    happy
    run colour_lib '
        cd_colour_ready() { echo "ready $*" >> "$GREMION_ROOT/gates.log"; return "${RDY_RC:-0}"; }
        cd_colour_isolation_run() { echo "isolation $*" >> "$GREMION_ROOT/gates.log"; return 0; }
        cd_colour_verify() { echo "verify $*" >> "$GREMION_ROOT/gates.log"; return 0; }
        cd_colour_gates "$TREE" green '"$TAG_NEW"'; echo "rc=$?"'
    [[ "$output" == *"rc=0"* ]]
    [ "$(cut -d' ' -f1 "${GREMION_ROOT}/gates.log" | paste -sd, -)" = "ready,isolation,verify,ready" ]
    assert_present "^ready green ${TAG_NEW} ${TREE}$" "${GREMION_ROOT}/gates.log" "ready was not given the tree"
    assert_present "^isolation ${TREE}$" "${GREMION_ROOT}/gates.log" "isolation was not given the tree"
    assert_present "^verify green ${TREE}$" "${GREMION_ROOT}/gates.log" "verify was not given the tree"
    rm -f "${GREMION_ROOT}/gates.log"
    run colour_lib '
        cd_colour_ready() { echo ready >> "$GREMION_ROOT/gates.log"; return 0; }
        cd_colour_isolation_run() { echo isolation >> "$GREMION_ROOT/gates.log"; return 1; }
        cd_colour_verify() { echo verify >> "$GREMION_ROOT/gates.log"; return 0; }
        cd_colour_gates "$TREE" green '"$TAG_NEW"'; echo "rc=$?"'
    [[ "$output" == *"rc=1"* ]]
    [ "$(paste -sd, "${GREMION_ROOT}/gates.log")" = "ready,isolation" ]
}

@test "gates: a failure of the probe before the switch is the code of that failure" {
    happy
    run colour_lib '
        n=0
        cd_colour_ready() { n=$((n + 1)); [ "$n" -eq 1 ] && return 0; return 4; }
        cd_colour_isolation_run() { return 0; }
        cd_colour_verify() { return 0; }
        cd_colour_gates "$TREE" green '"$TAG_NEW"'; echo "rc=$?"'
    [[ "$output" == *"rc=4"* ]]
}

# ================================================================== down

@test "down: it removes only the named colour's project, from its own tree, never -v" {
    happy
    call 'cd_colour_down "$TREE" green'
    [[ "$output" == *"rc=0"* ]]
    assert_present "^compose\|--env-file\|${GREMION_ROOT}/etc/env/app-green.env\|down$" "$DK/argv.log" "down of the green project"
    assert_absent 'app-blue' "$DK/argv.log" "down touched the other colour"
    assert_absent '(^|\|)(-v|--volumes|--rmi|-p|--project-name)(\||$)' "$DK/argv.log" "down was given a destructive flag"
    [ "$(grep -c '^down ' "$DK/order.log")" -eq 1 ]
}

@test "down: it REFUSES the colour that runtime/active-colour names, with no compose call" {
    happy
    printf 'green\n' > "${GREMION_ROOT}/runtime/active-colour"
    run --separate-stderr colour_lib 'cd_colour_down "$TREE" green; echo "rc=$?"'
    [[ "$output" == *"rc=1"* ]]
    [[ "$stderr" == *"refusing"* ]]
    [ ! -e "$DK/argv.log" ]
}

@test "down: it REFUSES a colour that the Traefik API shows as app@file, although active-colour names the old one" {
    happy
    traefik_svc app@file gremion-ui green UP
    call 'cd_colour_down "$TREE" green'
    [[ "$output" == *"rc=1"* ]]
    [ ! -e "$DK/order.log" ]
}

@test "down: it REFUSES a colour that the Traefik API shows as public@file" {
    happy
    traefik_svc public@file gremion-public green UP
    call 'cd_colour_down "$TREE" green'
    [[ "$output" == *"rc=1"* ]]
    [ ! -e "$DK/order.log" ]
}

@test "down: it refuses when it cannot be told whether the colour serves (no active-colour, no Traefik answer)" {
    happy
    touch "$DK/traefik.down"
    call 'cd_colour_down "$TREE" green'
    [[ "$output" == *"rc=4"* ]]
    [ ! -e "$DK/order.log" ]
    rm -f "$DK/traefik.down" "${GREMION_ROOT}/runtime/active-colour"
    call 'cd_colour_down "$TREE" green'
    [[ "$output" == *"rc=2"* ]]
    [ ! -e "$DK/order.log" ]
}

@test "down: the colour that is not named by either is taken down even while the other serves" {
    happy
    call 'cd_colour_down "$OLD_TREE" green'
    [[ "$output" == *"rc=0"* ]]
}

@test "down: a compose down that fails or times out is infrastructure (4), not the answer of a refusal (1)" {
    happy
    touch "$DK/down.fail"
    call 'cd_colour_down "$TREE" green'
    [[ "$output" == *"rc=4"* ]]
    rm -f "$DK/down.fail"
    touch "$DK/down.timeout"
    call 'cd_colour_down "$TREE" green'
    [[ "$output" == *"rc=4"* ]]
    # and the refusal stays 1
    rm -f "$DK/down.timeout"
    printf 'green\n' > "${GREMION_ROOT}/runtime/active-colour"
    call 'cd_colour_down "$TREE" green'
    [[ "$output" == *"rc=1"* ]]
}

# ================================================================== the family

@test "the library does not run anything when it is sourced and sets no shell option" {
    run bash -c ". \"${HOST_SRC}/lib/cd/colour.sh\"; shopt -qo errexit && echo errexit; shopt -qo nounset && echo nounset; echo done"
    [ "$status" -eq 0 ]
    [ "$output" = done ]
}

@test "the dispatcher loads the library without error and the stub of a cross-unit function steps aside" {
    run cd_prog version
    [ "$status" -eq 0 ]
    run bash -c "set -u; . \"${HOST_SRC}/lib/common.sh\"; . \"${HOST_SRC}/lib/cd/core.sh\"; . \"${HOST_SRC}/lib/cd/colour.sh\"; . \"${GREMION_CD_STUBS_DIR}/cd-stubs.sh\"; declare -f cd_colour_workers | grep -q stub_call && echo STUB || echo REAL"
    [ "$output" = REAL ]
}
