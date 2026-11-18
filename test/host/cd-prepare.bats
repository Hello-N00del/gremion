#!/usr/bin/env bats
# Unit tests for infra/host/lib/cd/prepare.sh (continuous deployment, unit cd-prepare):
# the start gate, the fetch of a release tree, the retag of the target colour (and its
# restore), the render and the build.
#
# Real temporary git repositories (a bare mirror, as the poller keeps it) and a recording
# docker shim; docker.sh, notify.sh and core.sh are the REAL libraries, github.sh and the
# units after this one are the helper's stubs. Nothing touches a real docker, a registry or
# a host. The snippets run WITHOUT errexit, as a driver that calls a stage as `fn || rc=$?`.

bats_require_minimum_version 1.5.0
load 'test_helper/host'
load 'test_helper/cd'

FIX="${BATS_TEST_DIRNAME}/fixtures/cd/prepare"
LIVE_SHA="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
PREV_SHA="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

setup() {
    cd_setup
    export STACK=teststack TZ=UTC
    DK="${SHIM_DIR}/dk"
    export DK
    mkdir -p "$DK"
    cp "${FIX}/state.env" "${FIX}/app-blue.env" "${FIX}/app-green.env" "${GREMION_ROOT}/etc/env/"
    mkdir -p "${GREMION_ROOT}/runtime" "${GREMION_ROOT}/releases/aaaaaaaaaaaa" "${GREMION_ROOT}/releases/bbbbbbbbbbbb"
    echo blue >"${GREMION_ROOT}/runtime/active-colour"
    # the mail transport program: relay unless $DK/transport says otherwise
    cat >"${GREMION_ROOT}/bin/gremion-mail" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = transport ]; then cat "$DK/transport" 2>/dev/null || echo relay; fi
exit 0
EOF
    chmod +x "${GREMION_ROOT}/bin/gremion-mail"
    shim docker "$(cat "${FIX}/docker.shim")"
    shim renice
    shim ionice
    # df: the answer is the number of KB in $DK/df.root or $DK/df.docker
    shim df 'for a in "$@"; do last="$a"; done
f="$DK/df.docker"
if [ "$last" = "$GREMION_ROOT" ]; then f="$DK/df.root"; fi
printf "Filesystem 1024-blocks Used Available Capacity Mounted\nx 1 1 %s 1%% /\n" "$(cat "$f")"'
    echo /var/lib/docker-shim >"$DK/rootdir"
    set_free 100 100
    # a healthy state project
    echo postgres >"$DK/services"
    echo c-state >"$DK/cid.teststack-state.postgres"
    echo "running healthy" >"$DK/status.c-state"
    LIVE_JSON="$(jq -n --arg t "${GREMION_ROOT}/releases/aaaaaaaaaaaa" --arg s "$LIVE_SHA" \
        '{sha:$s, sha12:"aaaaaaaaaaaa", tag:"pilot-aaaaaaaaaaaa", colour:"blue", tree:$t, since:"2026-11-01T00:00:00Z", proof:false, modules:null, leaves:null, reconcile:null}')"
    PREV_JSON="$(jq -n --arg t "${GREMION_ROOT}/releases/bbbbbbbbbbbb" --arg s "$PREV_SHA" \
        '{sha:$s, sha12:"bbbbbbbbbbbb", tag:"pilot-bbbbbbbbbbbb", colour:"green", tree:$t, startable:true}')"
    export LIVE_JSON PREV_JSON
    seed_state
}

teardown() {
    cd_teardown
}

# ---------------------------------------------------------------- helpers

# prep 'snippet' -- the real libraries, then the stubs for everything after this unit; no
# errexit (a driver calls a stage as `fn || rc=$?`).
prep() {
    local snippet="$1"
    shift
    bash -c "set -uo pipefail
. \"\${HOST_SRC}/lib/common.sh\"
. \"\${HOST_SRC}/lib/cd/core.sh\"
. \"\${HOST_SRC}/lib/cd/docker.sh\"
. \"\${HOST_SRC}/lib/cd/notify.sh\"
. \"\${HOST_SRC}/lib/cd/prepare.sh\"
. \"\${GREMION_CD_STUBS_DIR}/cd-stubs.sh\"
cd_cfg_load || exit 99
${snippet}" prep "$@"
}

# set_free ROOT_GB DOCKER_GB
set_free() {
    echo $(($1 * 1048576 + 1024)) >"$DK/df.root"
    echo $(($2 * 1048576 + 1024)) >"$DK/df.docker"
}

# seed_state [JQ] -- an idle state: live blue, previous green, then the filter.
seed_state() {
    cd_base_state | jq --argjson live "$LIVE_JSON" --argjson prev "$PREV_JSON" '.live = $live | .previous = $prev' \
        | jq "${1:-.}" >"${GREMION_ROOT}/data/cd/state.json"
    chmod 600 "${GREMION_ROOT}/data/cd/state.json"
}

# the release record of a release of C3 that targets green, as the driver has it at `retag`;
# an optional jq filter is applied after it
seed_release() {
    local rel
    rel="$(jq -n --arg sha "$C3" --arg tag "pilot-${C3:0:12}" --arg tree "${GREMION_ROOT}/releases/${C3:0:12}" \
        '{id:(($sha[0:12]) + "-1"), sha:$sha, sha12:$sha[0:12], tag:$tag, colour:"green", tree:$tree, mode:"auto", stage:"retag", stage_status:"started", retag_prev:null}')"
    seed_state ".phase = \"releasing\" | .release = ${rel} | ${1:-.}"
}

# assert_recorded_stub FN / refute_stub_recorded FN -- the helper's stubs log "stub <fn> ..."
assert_recorded_stub() {
    grep -q "^stub ${1} \|^stub ${1}\$" "$SHIM_LOG" || {
        echo "FAIL: the stub ${1} was not called" >&2
        return 1
    }
}
refute_stub_recorded() {
    if grep -q "^stub ${1} \|^stub ${1}\$" "$SHIM_LOG"; then
        echo "FAIL: the stub ${1} was called" >&2
        return 1
    fi
    return 0
}

# mk_mirror -- the bare mirror the poller keeps, at data/cd/mirror.git:
#   c1 (with the tree files) - c2 - c3   refs/heads/main
#     \_ d1                              refs/heads/side
# Sets C1 C2 C3 D1.
mk_mirror() {
    local work="${GREMION_ROOT}/.fixture-work" bare="${GREMION_ROOT}/data/cd/mirror.git"
    export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.org GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.org
    git init -q -b main "$work"
    cp -R "${FIX}/tree/." "$work/"
    chmod +x "$work/infra/host/bin/gremion-render"
    git -C "$work" add -A
    git -C "$work" commit -q -m c1
    C1="$(git -C "$work" rev-parse HEAD)"
    git -C "$work" commit -q --allow-empty -m c2
    C2="$(git -C "$work" rev-parse HEAD)"
    git -C "$work" commit -q --allow-empty -m c3
    C3="$(git -C "$work" rev-parse HEAD)"
    git -C "$work" checkout -q -b side "$C1"
    git -C "$work" commit -q --allow-empty -m d1
    D1="$(git -C "$work" rev-parse HEAD)"
    git clone -q --bare "$work" "$bare"
    chmod 700 "$bare"
    export C1 C2 C3 D1
}

# mk_tree -- the mirror and the fetched tree of C3. Sets TREE and TAG.
mk_tree() {
    mk_mirror
    TREE="$(prep 'cd_prepare_fetch "$C3"')"
    TAG="pilot-${C3:0:12}"
    export TREE TAG
}

# mk_live_images -- the live colour (blue) runs two containers; each tag resolves to the
# image the container runs.
mk_live_images() {
    local ref key id i=0
    : >"$DK/cids.teststack-app-blue"
    for ref in ghcr.io/example/gremion-ui:pilot-aaaaaaaaaaaa ghcr.io/example/gremion-public:pilot-aaaaaaaaaaaa; do
        i=$((i + 1))
        key="$(printf '%s' "$ref" | tr '/:' '__')"
        id="sha256:$(printf '%s' "live-$ref" | sha256sum | cut -d' ' -f1)"
        echo "$id" >"$DK/image.$key"
        echo "lc${i}" >>"$DK/cids.teststack-app-blue"
        echo "$id $ref" >"$DK/ctr.lc${i}"
    done
}

# retagged -- a tree, the release record and green retagged: the state `build` starts from.
retagged() {
    mk_tree
    seed_release
    run prep 'cd_lock_take; cd_prepare_retag "$TREE" green "$TAG"'
    [ "$status" -eq 0 ]
    mk_live_images
}

# refute_in NEEDLE HAYSTACK -- fails when HAYSTACK contains NEEDLE (no negated assertion).
refute_in() {
    case "$2" in
        *"$1"*)
            echo "FAIL: found '$1' in: $2" >&2
            return 1
            ;;
    esac
    return 0
}

# has_in NEEDLE HAYSTACK
has_in() {
    case "$2" in
        *"$1"*) return 0 ;;
    esac
    echo "FAIL: '$1' not found in: $2" >&2
    return 1
}

dk_count() { if [ -f "$DK/argv.log" ]; then grep -c -- "$1" "$DK/argv.log" || true; else echo 0; fi; }

# precheck -- run the gate and print its code word.
precheck() {
    run prep 'rc=0; cd_prepare_precheck || rc=$?; echo "why=${CD_PREPARE_WHY}"; exit "$rc"'
}

# ================================================================== precheck

@test "precheck: the all-green baseline passes" {
    precheck
    [ "$status" -eq 0 ]
    [ "$output" = "why=" ]
}

@test "precheck refuses: disk below CD_MIN_FREE_GB after a prune (4), and prunes first" {
    set_free 3 3
    precheck
    [ "$status" -eq 4 ]
    has_in 'why=disk' "$output"
    assert_recorded docker 'builder prune -f --keep-storage 12GB'
    # the image prune of the commit unit is tried when the builder cache is not enough
    assert_recorded_stub cd_commit_prune
}

@test "precheck: the docker root directory is measured, not only the host root" {
    set_free 100 3
    precheck
    [ "$status" -eq 4 ]
    has_in 'why=disk' "$output"
}

@test "precheck passes when the prune frees enough, and stops pruning there" {
    set_free 3 3
    echo $((50 * 1048576)) >"$DK/df.root.after"
    echo $((50 * 1048576)) >"$DK/df.docker.after"
    precheck
    [ "$status" -eq 0 ]
    assert_recorded docker 'builder prune'
    refute_stub_recorded cd_commit_prune
}

@test "precheck does not prune when the disk is fine" {
    precheck
    [ "$status" -eq 0 ]
    refute_recorded docker 'builder prune'
}

@test "precheck refuses: the live colour is not ready through the public edge (3)" {
    cd_stub_set cd_watch_probe_public 1
    precheck
    [ "$status" -eq 3 ]
    has_in 'why=live_not_ready' "$output"
}

@test "precheck refuses: the state project is unhealthy (3), service names only" {
    echo "running starting" >"$DK/status.c-state"
    precheck
    [ "$status" -eq 3 ]
    has_in 'why=state_unhealthy' "$output"
    has_in 'postgres(running starting)' "$output"
    refute_in 'c-state' "$output"
}

@test "precheck refuses: no live release recorded (2)" {
    seed_state '.live = null'
    precheck
    [ "$status" -eq 2 ]
    has_in 'why=no_live' "$output"
}

@test "precheck refuses: no probe host (2); the first line of tenant-hosts.txt is the fallback" {
    cd_write_cfg CD_PROBE_HOST=
    precheck
    [ "$status" -eq 2 ]
    has_in 'why=probe_host' "$output"
    printf '# hosts\n\nprobe.example.org extra\nother.example.org\n' >"${GREMION_ROOT}/etc/tenant-hosts.txt"
    precheck
    [ "$status" -eq 0 ]
    run prep 'cd_prepare_probe_host'
    [ "$status" -eq 0 ]
    [ "$output" = "probe.example.org" ]
}

@test "precheck never prints the probe host" {
    precheck
    [ "$status" -eq 0 ]
    refute_in 'example.org' "$output"
    cd_write_cfg CD_PROBE_HOST=
    printf 'probe.example.org\n' >"${GREMION_ROOT}/etc/tenant-hosts.txt"
    precheck
    [ "$status" -eq 0 ]
    refute_in 'example.org' "$output"
}

@test "precheck refuses: a probe host that is not a host name (2)" {
    cd_write_cfg CD_PROBE_HOST=
    printf '%s\n' '/x' >"${GREMION_ROOT}/etc/tenant-hosts.txt"
    precheck
    [ "$status" -eq 2 ]
    has_in 'why=probe_host' "$output"
}

@test "precheck refuses: inside a quiet window (3), end exclusive, and a window across midnight" {
    cd_fake_now 1700013600 # 02:00 UTC
    precheck
    [ "$status" -eq 3 ]
    has_in 'why=quiet_window' "$output"
    cd_fake_now 1700016900 # 02:55
    precheck
    [ "$status" -eq 3 ]
    cd_fake_now 1700018100 # 03:15 exactly: the window has ended
    precheck
    [ "$status" -eq 0 ]
    cd_write_cfg CD_QUIET_WINDOWS=23:00-01:00
    cd_fake_now 1700004600 # 23:30
    precheck
    [ "$status" -eq 3 ]
    cd_fake_now 1700008200 # 00:30
    precheck
    [ "$status" -eq 3 ]
    cd_fake_now 1700049600 # 12:00
    precheck
    [ "$status" -eq 0 ]
}

@test "precheck refuses: the kill switch is present (3)" {
    : >"${GREMION_ROOT}/etc/cd.disabled"
    precheck
    [ "$status" -eq 3 ]
    has_in 'why=killswitch' "$output"
}

@test "precheck refuses: CD_POLICY_ACK is not set (2)" {
    cd_write_cfg CD_POLICY_ACK=
    precheck
    [ "$status" -eq 2 ]
    has_in 'why=policy_ack' "$output"
}

@test "precheck refuses on the relay transport: data/cd/ALERT is present (3)" {
    echo "2026-11-17T00:00:00Z something broke" >"${GREMION_ROOT}/data/cd/ALERT"
    precheck
    [ "$status" -eq 3 ]
    has_in 'why=alert' "$output"
}

@test "precheck refuses on the relay transport: an outbox file older than one hour (3)" {
    mkdir -p "${GREMION_ROOT}/data/cd/outbox"
    : >"${GREMION_ROOT}/data/cd/outbox/$(($(cd_clock) - 4000))-rejected.eml"
    precheck
    [ "$status" -eq 3 ]
    has_in 'why=outbox_stale' "$output"
    rm -f "${GREMION_ROOT}"/data/cd/outbox/*.eml
    : >"${GREMION_ROOT}/data/cd/outbox/$(($(cd_clock) - 100))-rejected.eml"
    precheck
    [ "$status" -eq 0 ]
}

@test "precheck: a transport that is not the relay is refused unless CD_ALLOW_NO_MAIL=1 (2)" {
    echo stalwart >"$DK/transport"
    precheck
    [ "$status" -eq 2 ]
    has_in 'why=mail_transport' "$output"
}

@test "precheck: with CD_ALLOW_NO_MAIL=1 on a non-relay transport both mail checks are skipped" {
    echo stalwart >"$DK/transport"
    cd_write_cfg CD_ALLOW_NO_MAIL=1
    echo "2026-11-17T00:00:00Z something broke" >"${GREMION_ROOT}/data/cd/ALERT"
    mkdir -p "${GREMION_ROOT}/data/cd/outbox"
    : >"${GREMION_ROOT}/data/cd/outbox/$(($(cd_clock) - 9000))-rejected.eml"
    precheck
    [ "$status" -eq 0 ]
}

@test "precheck: CD_ALLOW_NO_MAIL=1 does not skip the mail checks on the relay transport" {
    cd_write_cfg CD_ALLOW_NO_MAIL=1
    echo "2026-11-17T00:00:00Z something broke" >"${GREMION_ROOT}/data/cd/ALERT"
    precheck
    [ "$status" -eq 3 ]
    has_in 'why=alert' "$output"
}

@test "precheck refuses: another process holds the cd lock (3)" {
    cd_need_flock
    cd_bg 'cd_lock_take; echo ready; exec sleep 300'
    precheck
    [ "$status" -eq 3 ]
    has_in 'why=lock_busy' "$output"
}

@test "precheck refuses: another process holds the host lock (3)" {
    hold_host_lock 30
    precheck
    [ "$status" -eq 3 ]
    has_in 'why=lock_busy' "$output"
}

@test "precheck passes when the locks are the caller's own" {
    cd_need_flock
    run prep 'cd_lock_take; cd_hostlock_take; rc=0; cd_prepare_precheck || rc=$?; echo "why=${CD_PREPARE_WHY}"; exit "$rc"'
    [ "$status" -eq 0 ]
}

@test "precheck: a failing docker is never read as free disk or a healthy state project" {
    : >"$DK/ps.fail"
    precheck
    [ "$status" -ne 0 ]
}

# ===================================================================== fetch

@test "fetch: a commit reachable from refs/heads/main gives a clean work tree at that commit" {
    mk_mirror
    run prep 'cd_prepare_fetch "$C2"'
    [ "$status" -eq 0 ]
    [ "$output" = "${GREMION_ROOT}/releases/${C2:0:12}" ]
    [ "$(git -C "$output" rev-parse HEAD)" = "$C2" ]
    [ -z "$(git -C "$output" status --porcelain)" ]
    [ -x "${output}/infra/host/bin/gremion-render" ]
    [ -f "${output}/.gitignore" ]
}

@test "fetch: a commit that exists only on another ref is refused, and no tree is made" {
    mk_mirror
    run prep 'cd_prepare_fetch "$D1"'
    [ "$status" -eq 2 ]
    [ ! -e "${GREMION_ROOT}/releases/${D1:0:12}" ]
}

@test "fetch: a commit the mirror does not have, and a short sha, are refused" {
    mk_mirror
    run prep 'cd_prepare_fetch 0123456789abcdef0123456789abcdef01234567'
    [ "$status" -eq 2 ]
    run prep 'cd_prepare_fetch "${C2:0:12}"'
    [ "$status" -eq 2 ]
}

@test "fetch: the directory mode is 755 under umask 077" {
    mk_mirror
    run prep 'umask 077; cd_prepare_fetch "$C3"'
    [ "$status" -eq 0 ]
    [ "$(stat -c %a "$output")" = "755" ]
    run find "$output" -path '*/.git' -prune -o -type d ! -perm 755 -print
    [ "$status" -eq 0 ]
    [ -z "$output" ]
}

@test "fetch: a proof ref is honoured only in proof mode" {
    mk_mirror
    git --git-dir="${GREMION_ROOT}/data/cd/mirror.git" update-ref refs/proof/p1 "$D1"
    run prep 'cd_prepare_fetch "$D1" p1'
    [ "$status" -eq 2 ]
    [ ! -e "${GREMION_ROOT}/releases/${D1:0:12}" ]
    cd_write_cfg CD_PROOF_MODE=1 CD_PROOF_REPO=https://example.org/org/proof
    run prep 'cd_prepare_fetch "$D1" p1'
    [ "$status" -eq 0 ]
    [ "$(git -C "$output" rev-parse HEAD)" = "$D1" ]
}

@test "fetch in proof mode: with REF only that ref counts, and without REF only main" {
    mk_mirror
    git --git-dir="${GREMION_ROOT}/data/cd/mirror.git" update-ref refs/proof/p1 "$D1"
    cd_write_cfg CD_PROOF_MODE=1 CD_PROOF_REPO=https://example.org/org/proof
    run prep 'cd_prepare_fetch "$C3" p1'
    [ "$status" -eq 2 ]
    run prep 'cd_prepare_fetch "$D1"'
    [ "$status" -eq 2 ]
    run prep 'cd_prepare_fetch "$D1" ../../heads/main'
    [ "$status" -eq 2 ]
    run prep 'cd_prepare_fetch "$D1" nosuchref'
    [ "$status" -eq 2 ]
}

@test "fetch: a tree that is already exactly right is reused, a rendered (ignored) file survives" {
    mk_mirror
    run prep 'cd_prepare_fetch "$C3"'
    [ "$status" -eq 0 ]
    tree="$output"
    echo rendered >"${tree}/rendered.out"
    run prep 'cd_prepare_fetch "$C3"'
    [ "$status" -eq 0 ]
    [ "$output" = "$tree" ]
    [ -f "${tree}/rendered.out" ]
}

@test "fetch: a dirty tree that is not in use is replaced by a clean one" {
    mk_mirror
    run prep 'cd_prepare_fetch "$C3"'
    tree="$output"
    echo stray >"${tree}/stray.txt"
    run prep 'cd_prepare_fetch "$C3"'
    [ "$status" -eq 0 ]
    [ ! -e "${tree}/stray.txt" ]
    [ -z "$(git -C "$tree" status --porcelain)" ]
}

@test "fetch: a tree at the wrong commit is replaced" {
    mk_mirror
    run prep 'cd_prepare_fetch "$C3"'
    tree="$output"
    git -C "$tree" checkout -q --detach "$C2"
    run prep 'cd_prepare_fetch "$C3"'
    [ "$status" -eq 0 ]
    [ "$(git -C "$tree" rev-parse HEAD)" = "$C3" ]
}

@test "fetch: a dirty tree that is the live tree is refused and left alone" {
    mk_mirror
    run prep 'cd_prepare_fetch "$C3"'
    tree="$output"
    echo stray >"${tree}/stray.txt"
    seed_state ".live.tree = \"${tree}\""
    run prep 'cd_prepare_fetch "$C3"'
    [ "$status" -eq 2 ]
    [ -f "${tree}/stray.txt" ]
}

@test "fetch: the leftover of a crashed fetch is cleaned and a clone failure is code 4" {
    mk_mirror
    mkdir -p "${GREMION_ROOT}/releases/.fetch-${C3:0:12}.99999"
    run prep 'cd_prepare_fetch "$C3"'
    [ "$status" -eq 0 ]
    [ ! -e "${GREMION_ROOT}/releases/.fetch-${C3:0:12}.99999" ]
    rm -rf "${GREMION_ROOT}/releases/${C3:0:12}"
    # only the clone fails (a full disk, a broken git); every read of the mirror still works
    REALGIT="$(command -v git)"
    shim git "case \" \$* \" in *\" clone \"*) exit 1 ;; esac
exec ${REALGIT} \"\$@\""
    run prep 'cd_prepare_fetch "$C3"'
    [ "$status" -eq 4 ]
    [ ! -e "${GREMION_ROOT}/releases/${C3:0:12}" ]
    run find "${GREMION_ROOT}/releases" -name '.fetch-*'
    [ -z "$output" ]
}

# ===================================================================== retag

@test "retag: only IMAGE_TAG of the target env file changes; the other two files are byte-identical" {
    mk_tree
    seed_release
    cp "${GREMION_ROOT}/etc/env/app-blue.env" "$DK/blue.before"
    cp "${GREMION_ROOT}/etc/env/state.env" "$DK/state.before"
    cp "${GREMION_ROOT}/etc/env/app-green.env" "$DK/green.before"
    run --separate-stderr prep 'cd_lock_take; cd_prepare_retag "$TREE" green "$TAG"'
    [ "$status" -eq 0 ]
    # stdout is the previous tag and nothing else
    [ "$output" = "pilot-bbbbbbbbbbbb" ]
    cmp "${GREMION_ROOT}/etc/env/app-blue.env" "$DK/blue.before"
    cmp "${GREMION_ROOT}/etc/env/state.env" "$DK/state.before"
    run diff "$DK/green.before" "${GREMION_ROOT}/etc/env/app-green.env"
    [ "$status" -eq 1 ]
    has_in "< IMAGE_TAG=pilot-bbbbbbbbbbbb" "$output"
    has_in "> IMAGE_TAG=${TAG}" "$output"
    [ "$(diff "$DK/green.before" "${GREMION_ROOT}/etc/env/app-green.env" | grep -c '^[<>]')" -eq 2 ]
    run jq -r '.release.retag_prev' "${GREMION_ROOT}/data/cd/state.json"
    [ "$output" = "pilot-bbbbbbbbbbbb" ]
    run jq -r '.previous.startable' "${GREMION_ROOT}/data/cd/state.json"
    [ "$output" = "false" ]
}

@test "retag: previous stays startable when it is not on the target colour" {
    mk_tree
    seed_release '.previous.colour = "blue"'
    run prep 'cd_lock_take; cd_prepare_retag "$TREE" green "$TAG"'
    [ "$status" -eq 0 ]
    run jq -r '.previous.startable' "${GREMION_ROOT}/data/cd/state.json"
    [ "$output" = "true" ]
}

@test "retag keeps the owner and the mode of the env file" {
    mk_tree
    seed_release
    chmod 640 "${GREMION_ROOT}/etc/env/app-green.env"
    before="$(stat -c '%a %u:%g' "${GREMION_ROOT}/etc/env/app-green.env")"
    run prep 'cd_lock_take; cd_prepare_retag "$TREE" green "$TAG"'
    [ "$status" -eq 0 ]
    [ "$(stat -c '%a %u:%g' "${GREMION_ROOT}/etc/env/app-green.env")" = "$before" ]
}

@test "retag refuses when the live colour's env already carries the new tag" {
    mk_tree
    seed_release
    cp "${GREMION_ROOT}/etc/env/app-green.env" "$DK/green.before"
    sed -i "s/^IMAGE_TAG=.*/IMAGE_TAG=${TAG}/" "${GREMION_ROOT}/etc/env/app-blue.env"
    run prep 'cd_lock_take; cd_prepare_retag "$TREE" green "$TAG"'
    [ "$status" -eq 2 ]
    has_in "live colour already carries" "$output"
    cmp "${GREMION_ROOT}/etc/env/app-green.env" "$DK/green.before"
}

@test "retag refuses when the target colour is the live colour" {
    mk_tree
    seed_release
    run prep 'cd_lock_take; cd_prepare_retag "$TREE" blue "$TAG"'
    [ "$status" -eq 2 ]
    has_in "live colour" "$output"
    grep -qx "IMAGE_TAG=pilot-aaaaaaaaaaaa" "${GREMION_ROOT}/etc/env/app-blue.env"
}

@test "retag refuses when the target colour is the active colour" {
    mk_tree
    seed_release
    echo green >"${GREMION_ROOT}/runtime/active-colour"
    run prep 'cd_lock_take; cd_prepare_retag "$TREE" green "$TAG"'
    [ "$status" -eq 2 ]
    has_in "active colour" "$output"
    grep -qx "IMAGE_TAG=pilot-bbbbbbbbbbbb" "${GREMION_ROOT}/etc/env/app-green.env"
}

@test "retag refuses when the active colour cannot be read" {
    mk_tree
    seed_release
    rm -f "${GREMION_ROOT}/runtime/active-colour"
    run prep 'cd_lock_take; cd_prepare_retag "$TREE" green "$TAG"'
    [ "$status" -eq 2 ]
    grep -qx "IMAGE_TAG=pilot-bbbbbbbbbbbb" "${GREMION_ROOT}/etc/env/app-green.env"
}

@test "retag refuses when the target colour project is running" {
    mk_tree
    seed_release
    echo gc1 >"$DK/cids.teststack-app-green"
    run prep 'cd_lock_take; cd_prepare_retag "$TREE" green "$TAG"'
    [ "$status" -eq 2 ]
    has_in "running" "$output"
    grep -qx "IMAGE_TAG=pilot-bbbbbbbbbbbb" "${GREMION_ROOT}/etc/env/app-green.env"
}

@test "retag: a docker that cannot answer is not read as 'not running'" {
    mk_tree
    seed_release
    : >"$DK/ps.fail"
    run prep 'cd_lock_take; cd_prepare_retag "$TREE" green "$TAG"'
    [ "$status" -eq 2 ]
    grep -qx "IMAGE_TAG=pilot-bbbbbbbbbbbb" "${GREMION_ROOT}/etc/env/app-green.env"
}

@test "retag refuses a tree that is not the commit the tag names" {
    mk_tree
    seed_release
    run prep 'cd_lock_take; cd_prepare_retag "$TREE" green pilot-cccccccccccc'
    [ "$status" -eq 2 ]
    grep -qx "IMAGE_TAG=pilot-bbbbbbbbbbbb" "${GREMION_ROOT}/etc/env/app-green.env"
}

@test "retag refuses bad arguments" {
    mk_tree
    seed_release
    run prep 'cd_lock_take; cd_prepare_retag "$TREE" purple "$TAG"'
    [ "$status" -eq 2 ]
    run prep 'cd_lock_take; cd_prepare_retag "$TREE" green latest'
    [ "$status" -eq 2 ]
    run prep 'cd_lock_take; cd_prepare_retag /nonexistent green "$TAG"'
    [ "$status" -eq 2 ]
}

@test "retag: a busy host lock waits, then returns 3 and changes nothing" {
    mk_tree
    seed_release
    cp "${GREMION_ROOT}/etc/env/app-green.env" "$DK/green.before"
    cd_write_cfg CD_LOCK_WAIT_S=1
    hold_host_lock 30
    run prep 'cd_lock_take; cd_prepare_retag "$TREE" green "$TAG"'
    [ "$status" -eq 3 ]
    cmp "${GREMION_ROOT}/etc/env/app-green.env" "$DK/green.before"
}

@test "retag takes the host lock for the edit and releases it afterwards" {
    cd_need_flock
    mk_tree
    seed_release
    run prep 'cd_lock_take
cd_prepare_retag "$TREE" green "$TAG" >/dev/null || exit 1
if ( exec 7>>"${GREMION_ROOT}/runtime/hostd.lock" && flock -n 7 ); then echo FREE; else echo HELD; fi'
    [ "$status" -eq 0 ]
    [ "$output" = "FREE" ]
}

@test "retag does not drop a host lock the caller already holds" {
    cd_need_flock
    mk_tree
    seed_release
    run prep 'cd_lock_take; cd_hostlock_take
cd_prepare_retag "$TREE" green "$TAG" >/dev/null || exit 1
if ( exec 7>>"${GREMION_ROOT}/runtime/hostd.lock" && flock -n 7 ); then echo FREE; else echo HELD; fi'
    [ "$status" -eq 0 ]
    [ "$output" = "HELD" ]
}

@test "retag is safe to run again: the saved previous tag comes back, not the new tag" {
    mk_tree
    seed_release
    run prep 'cd_lock_take; cd_prepare_retag "$TREE" green "$TAG"'
    [ "$status" -eq 0 ]
    cp "${GREMION_ROOT}/etc/env/app-green.env" "$DK/green.once"
    cp "${GREMION_ROOT}/data/cd/state.json" "$DK/state.once"
    run prep 'cd_lock_take; cd_prepare_retag "$TREE" green "$TAG"'
    [ "$status" -eq 0 ]
    [ "$output" = "pilot-bbbbbbbbbbbb" ]
    cmp "${GREMION_ROOT}/etc/env/app-green.env" "$DK/green.once"
    cmp "${GREMION_ROOT}/data/cd/state.json" "$DK/state.once"
}

@test "retag: an env that already carries the tag with no saved previous tag is refused" {
    mk_tree
    seed_release
    sed -i "s/^IMAGE_TAG=.*/IMAGE_TAG=${TAG}/" "${GREMION_ROOT}/etc/env/app-green.env"
    run prep 'cd_lock_take; cd_prepare_retag "$TREE" green "$TAG"'
    [ "$status" -eq 2 ]
}

@test "retag: a target env file without IMAGE_TAG is refused" {
    mk_tree
    seed_release
    sed -i '/^IMAGE_TAG=/d' "${GREMION_ROOT}/etc/env/app-green.env"
    run prep 'cd_lock_take; cd_prepare_retag "$TREE" green "$TAG"'
    [ "$status" -eq 2 ]
}

@test "retag_restore puts retag_prev back and flips startable back; a second call changes nothing" {
    mk_tree
    seed_release
    cp "${GREMION_ROOT}/etc/env/app-green.env" "$DK/green.original"
    run prep 'cd_lock_take; cd_prepare_retag "$TREE" green "$TAG"'
    [ "$status" -eq 0 ]
    run prep 'cd_lock_take; cd_prepare_retag_restore'
    [ "$status" -eq 0 ]
    cmp "${GREMION_ROOT}/etc/env/app-green.env" "$DK/green.original"
    run jq -r '.previous.startable' "${GREMION_ROOT}/data/cd/state.json"
    [ "$output" = "true" ]
    cp "${GREMION_ROOT}/data/cd/state.json" "$DK/state.restored"
    run prep 'cd_lock_take; cd_prepare_retag_restore'
    [ "$status" -eq 0 ]
    cmp "${GREMION_ROOT}/etc/env/app-green.env" "$DK/green.original"
    cmp "${GREMION_ROOT}/data/cd/state.json" "$DK/state.restored"
}

@test "retag_restore with nothing retagged touches nothing" {
    mk_tree
    seed_release '.previous.startable = false'
    run prep 'cd_lock_take; cd_prepare_retag_restore'
    [ "$status" -eq 0 ]
    run jq -r '.previous.startable' "${GREMION_ROOT}/data/cd/state.json"
    [ "$output" = "false" ]
    grep -qx "IMAGE_TAG=pilot-bbbbbbbbbbbb" "${GREMION_ROOT}/etc/env/app-green.env"
}

@test "retag_restore: when the env file cannot be restored previous stays not startable (1)" {
    mk_tree
    seed_release
    run prep 'cd_lock_take; cd_prepare_retag "$TREE" green "$TAG"'
    [ "$status" -eq 0 ]
    mv "${GREMION_ROOT}/etc/env/app-green.env" "$DK/green.real"
    ln -s "$DK/green.real" "${GREMION_ROOT}/etc/env/app-green.env"
    run prep 'cd_lock_take; cd_prepare_retag_restore'
    [ "$status" -eq 1 ]
    run jq -r '.previous.startable' "${GREMION_ROOT}/data/cd/state.json"
    [ "$output" = "false" ]
}

@test "retag_restore never touches the env file of the live colour" {
    mk_tree
    seed_release '.release.colour = "blue" | .release.retag_prev = "pilot-dddddddddddd"'
    run prep 'cd_lock_take; cd_prepare_retag_restore'
    [ "$status" -eq 2 ]
    grep -qx "IMAGE_TAG=pilot-aaaaaaaaaaaa" "${GREMION_ROOT}/etc/env/app-blue.env"
}

# ==================================================================== render

@test "render: gremion-render runs from the new tree, with the control-panel edge file left alone" {
    mk_tree
    run prep 'cd_prepare_render "$TREE" green'
    [ "$status" -eq 0 ]
    grep -qF -- "--release ${TREE} --defer-control-panel" "$DK/render.log"
    grep -qF -- "root=${GREMION_ROOT}" "$DK/render.log"
    [ -f "${TREE}/rendered.out" ]
}

@test "render: the ipcrypt key is hard-linked into the tree (one inode)" {
    mk_tree
    run prep 'cd_prepare_render "$TREE" green'
    [ "$status" -eq 0 ]
    [ "$(stat -c %i "${GREMION_ROOT}/etc/secrets/ipcrypt_key.txt")" = "$(stat -c %i "${TREE}/secrets/ipcrypt_key.txt")" ]
    [ -z "$(git -C "$TREE" status --porcelain)" ]
}

@test "render: compose config with an unset variable fails, naming the variables only" {
    mk_tree
    {
        echo 'time="2026-11-17T00:00:00Z" level=warning msg="The \"FOO_SECRET\" variable is not set. Defaulting to a blank string."'
        echo 'WARN[0000] The "BAR_VALUE" variable is not set. Defaulting to a blank string.'
    } >"$DK/config.warn"
    run prep 'cd_prepare_render "$TREE" green'
    [ "$status" -eq 2 ]
    has_in 'FOO_SECRET' "$output"
    has_in 'BAR_VALUE' "$output"
    refute_in 'Defaulting' "$output"
    refute_in 'level=warning' "$output"
}

@test "render: a failing compose config fails" {
    mk_tree
    : >"$DK/config.fail"
    run prep 'cd_prepare_render "$TREE" green'
    [ "$status" -eq 2 ]
}

@test "render: a refused compose shape (no COMPOSE_FILE) says why, in cd_dc's own words" {
    mk_tree
    sed -i '/^COMPOSE_FILE=/d' "${GREMION_ROOT}/etc/env/app-green.env"
    run prep 'cd_prepare_render "$TREE" green'
    [ "$status" -eq 2 ]
    has_in 'was refused' "$output"
    has_in 'COMPOSE_FILE' "$output"
}

@test "render: a dirty tree after the render fails" {
    mk_tree
    echo dirty >"$DK/render.mode"
    run prep 'cd_prepare_render "$TREE" green'
    [ "$status" -eq 2 ]
    has_in 'not clean' "$output"
}

@test "render: a failing gremion-render goes to a 0600 log, nothing of it is printed" {
    mk_tree
    echo fail >"$DK/render.mode"
    run prep 'cd_prepare_render "$TREE" green'
    [ "$status" -eq 2 ]
    refute_in 'RENDER-STDOUT-MARKER' "$output"
    refute_in 'RENDER-STDERR-MARKER' "$output"
    has_in 'cd-render-' "$output"
    log="$(ls "${GREMION_ROOT}"/logs/cd-render-*.log)"
    [ "$(stat -c %a "$log")" = "600" ]
    grep -q 'RENDER-STDOUT-MARKER' "$log"
    grep -q 'RENDER-STDERR-MARKER' "$log"
}

@test "render: a tree without gremion-render, a bad colour and a missing tree are refused" {
    mk_tree
    rm -f "${TREE}/infra/host/bin/gremion-render"
    run prep 'cd_prepare_render "$TREE" green'
    [ "$status" -eq 2 ]
    run prep 'cd_prepare_render "$TREE" purple'
    [ "$status" -eq 2 ]
    run prep 'cd_prepare_render /nonexistent green'
    [ "$status" -eq 2 ]
}

# ============================================================ build failure kinds

@test "the infra pattern list is pinned at nine entries" {
    run prep 'echo "${#CD_PREPARE_INFRA_PATTERNS[@]}"'
    [ "$output" = "9" ]
}

classify() { # TEXT -> kind
    printf '%s\n' "$1" >"$DK/classify.log"
    run prep 'cd_prepare_classify_build_failure "$DK/classify.log"'
}

@test "classify: no space left on device is infra" {
    classify 'ERROR: failed to solve: write /var/lib/x: no space left on device'
    [ "$status" -eq 0 ]
    [ "$output" = "infra" ]
}

@test "classify: TLS handshake timeout is infra" {
    classify 'Get "https://registry.example.org/v2/": net/http: TLS handshake timeout'
    [ "$output" = "infra" ]
}

@test "classify: toomanyrequests is infra" {
    classify 'toomanyrequests: You have reached your pull rate limit'
    [ "$output" = "infra" ]
}

@test "classify: connection reset is infra" {
    classify 'read tcp 192.0.2.1:1->192.0.2.2:443: read: connection reset by peer'
    [ "$output" = "infra" ]
}

@test "classify: i/o timeout is infra" {
    classify 'dial tcp 192.0.2.2:443: i/o timeout'
    [ "$output" = "infra" ]
}

@test "classify: temporary failure in name resolution is infra" {
    classify 'Temporary failure in name resolution'
    [ "$output" = "infra" ]
}

@test "classify: unexpected EOF is infra" {
    classify 'error pulling image configuration: unexpected EOF'
    [ "$output" = "infra" ]
}

@test "classify: a 502, 503 or 504 from a registry is infra" {
    classify 'received unexpected HTTP status: 503 Service Unavailable'
    [ "$output" = "infra" ]
    classify 'Error response from daemon: 502 Bad Gateway'
    [ "$output" = "infra" ]
    classify 'unexpected status: 504'
    [ "$output" = "infra" ]
}

@test "classify: a Dockerfile syntax error is a failure of the commit" {
    classify 'ERROR: failed to solve: dockerfile parse error on line 3: unknown instruction: RUNN'
    [ "$status" -eq 0 ]
    [ "$output" = "commit" ]
}

@test "classify: bash's own unexpected EOF of a broken RUN script is a failure of the commit" {
    classify '/bin/sh: 1: unexpected EOF while looking for matching quote'
    [ "$output" = "commit" ]
    classify 'build.sh: line 9: syntax error: unexpected end of file'
    [ "$output" = "commit" ]
}

@test "classify: an unreadable log is refused with nothing printed" {
    run prep 'cd_prepare_classify_build_failure /nonexistent'
    [ "$status" -eq 2 ]
    refute_in 'infra' "$output"
}

# ===================================================================== build

@test "build: pull and build carry the profile star, the image list is computed with it, niced, parallel 2" {
    retagged
    run prep 'cd_prepare_build "$TREE" green "$TAG"'
    [ "$status" -eq 0 ]
    grep -qF -- "|--profile|*|pull|--ignore-buildable" "$DK/argv.log"
    grep -qF -- "|--profile|*|build" "$DK/argv.log"
    grep -qF -- "|--profile|*|config|--images" "$DK/argv.log"
    run grep -c -e '|up|' -e '|down|' "$DK/argv.log"
    [ "$output" = "0" ]
    # every compose call ran from the tree, bounded, with the parallelism cap
    run grep -vc -- "cwd=${TREE} " "$DK/ctx.log"
    [ "$output" = "0" ]
    grep -qF -- "par=2" "$DK/ctx.log"
    grep -qF -- "timeout=3600" "$DK/ctx.log"
    assert_recorded renice '-n 10 -p'
    assert_recorded ionice '-c 3 -p'
}

@test "build: the one-shot images exist under the new tag" {
    retagged
    run prep 'cd_prepare_build "$TREE" green "$TAG"'
    [ "$status" -eq 0 ]
    grep -qx "ghcr.io/example/gremion-migrate:${TAG}" "$DK/built"
    grep -qx "ghcr.io/example/gremion-kernel-api:${TAG}" "$DK/built"
    grep -qx "ghcr.io/example/gremion-ui:${TAG}" "$DK/built"
}

@test "build fails when the profile star is lost: the image list has no one-shot image (guard)" {
    retagged
    : >"$DK/ignore.star"
    run prep 'cd_prepare_build "$TREE" green "$TAG"'
    [ "$status" -eq 1 ]
    has_in 'gremion-migrate' "$output"
    [ "$(dk_count "|build")" = "0" ]
}

@test "build fails when a one-shot image is missing after the build (guard)" {
    retagged
    : >"$DK/skip.oneshot.build"
    run prep 'cd_prepare_build "$TREE" green "$TAG"'
    [ "$status" -eq 1 ]
    has_in 'gremion-migrate:' "$output"
    has_in 'missing' "$output"
}

@test "build fails when it moved the image a live tag resolves to (the retag lesson)" {
    retagged
    echo "ghcr.io_example_gremion-ui_pilot-aaaaaaaaaaaa" >"$DK/build.clobber"
    run prep 'cd_prepare_build "$TREE" green "$TAG"'
    [ "$status" -eq 1 ]
    has_in 'live' "$output"
}

@test "build refuses to start when a live container does not run the image its tag resolves to" {
    retagged
    echo "sha256:$(printf '%064d' 9) ghcr.io/example/gremion-ui:pilot-aaaaaaaaaaaa" >"$DK/ctr.lc1"
    run prep 'cd_prepare_build "$TREE" green "$TAG"'
    [ "$status" -eq 2 ]
    [ "$(dk_count "|build")" = "0" ]
}

@test "build: two colours with equal image ids for an unchanged service pass" {
    retagged
    echo "ghcr.io_example_gremion-ui_pilot-aaaaaaaaaaaa" >"$DK/build.same"
    run prep 'cd_prepare_build "$TREE" green "$TAG"'
    [ "$status" -eq 0 ]
    [ "$(cat "$DK/image.ghcr.io_example_gremion-ui_pilot-aaaaaaaaaaaa")" = "$(cat "$DK/image.ghcr.io_example_gremion-ui_${TAG}")" ]
}

@test "build: a live colour with no running container is refused (a count of zero fails)" {
    retagged
    : >"$DK/cids.teststack-app-blue"
    run prep 'cd_prepare_build "$TREE" green "$TAG"'
    [ "$status" -eq 2 ]
}

@test "build: an infra failure retries twice with 60 and 300 second waits, then returns 4" {
    retagged
    printf '%s\n' '1 dial tcp: i/o timeout' '1 dial tcp: i/o timeout' '1 dial tcp: i/o timeout' >"$DK/build.script"
    run prep 't0=$(cd_now); rc=0; cd_prepare_build "$TREE" green "$TAG" || rc=$?; echo "elapsed=$(( $(cd_now) - t0 ))"; exit "$rc"'
    [ "$status" -eq 4 ]
    has_in 'elapsed=360' "$output"
    [ "$(grep -c -- '|build' "$DK/argv.log")" -eq 3 ]
}

@test "build: an infra failure that clears on the second try succeeds after one 60 second wait" {
    retagged
    printf '%s\n' '1 TLS handshake timeout' >"$DK/build.script"
    run prep 't0=$(cd_now); rc=0; cd_prepare_build "$TREE" green "$TAG" || rc=$?; echo "elapsed=$(( $(cd_now) - t0 ))"; exit "$rc"'
    [ "$status" -eq 0 ]
    has_in 'elapsed=60' "$output"
    [ "$(grep -c -- '|build' "$DK/argv.log")" -eq 2 ]
}

@test "build: CD_BUILD_RETRIES=0 does not retry" {
    retagged
    cd_write_cfg CD_BUILD_RETRIES=0
    printf '%s\n' '1 dial tcp: i/o timeout' >"$DK/build.script"
    run prep 't0=$(cd_now); rc=0; cd_prepare_build "$TREE" green "$TAG" || rc=$?; echo "elapsed=$(( $(cd_now) - t0 ))"; exit "$rc"'
    [ "$status" -eq 4 ]
    has_in 'elapsed=0' "$output"
    [ "$(grep -c -- '|build' "$DK/argv.log")" -eq 1 ]
}

@test "build: a failure of the commit returns 1 at once, with no wait and no retry" {
    retagged
    printf '%s\n' '1 dockerfile parse error on line 3: unknown instruction: RUNN' >"$DK/build.script"
    run prep 't0=$(cd_now); rc=0; cd_prepare_build "$TREE" green "$TAG" || rc=$?; echo "elapsed=$(( $(cd_now) - t0 ))"; exit "$rc"'
    [ "$status" -eq 1 ]
    has_in 'elapsed=0' "$output"
    [ "$(grep -c -- '|build' "$DK/argv.log")" -eq 1 ]
}

@test "build: a bash 'unexpected EOF while looking for matching' is a failure of the commit, not a retry" {
    retagged
    printf '%s\n' '1 /bin/sh: 1: unexpected EOF while looking for matching quote' >"$DK/build.script"
    run prep 'cd_prepare_build "$TREE" green "$TAG"'
    [ "$status" -eq 1 ]
    [ "$(grep -c -- '|build' "$DK/argv.log")" -eq 1 ]
}

@test "build: the timeout returns 3" {
    retagged
    printf '%s\n' '124' >"$DK/build.script"
    run prep 'cd_prepare_build "$TREE" green "$TAG"'
    [ "$status" -eq 3 ]
    has_in 'timed out' "$output"
}

@test "build: the time limit covers the retries: a wait that would pass it returns 3" {
    retagged
    cd_write_cfg CD_BUILD_TIMEOUT_MIN=1
    printf '%s\n' '1 dial tcp: i/o timeout' '1 dial tcp: i/o timeout' >"$DK/build.script"
    run prep 'cd_prepare_build "$TREE" green "$TAG"'
    [ "$status" -eq 3 ]
    [ "$(grep -c -- '|build' "$DK/argv.log")" -eq 1 ]
}

@test "build: the container log of a failure goes to a 0600 file under logs/ and nothing of it is printed" {
    retagged
    printf '%s\n' '1 SECRET-SLUG-MARKER acme-council config line' >"$DK/build.script"
    run --separate-stderr prep 'cd_prepare_build "$TREE" green "$TAG"'
    [ "$status" -eq 1 ]
    refute_in 'SECRET-SLUG-MARKER' "$output"
    refute_in 'SECRET-SLUG-MARKER' "$stderr"
    refute_in 'acme-council' "$stderr"
    has_in "cd-build-${TAG}.log" "$stderr"
    log="${GREMION_ROOT}/logs/cd-build-${TAG}.log"
    [ "$(stat -c %a "$log")" = "600" ]
    grep -q 'SECRET-SLUG-MARKER' "$log"
}

@test "build: an infra failure also keeps its log privately and prints none of it" {
    retagged
    cd_write_cfg CD_BUILD_RETRIES=0
    printf '%s\n' '1 INFRA-MARKER-TEXT i/o timeout' >"$DK/build.script"
    run --separate-stderr prep 'cd_prepare_build "$TREE" green "$TAG"'
    [ "$status" -eq 4 ]
    refute_in 'INFRA-MARKER-TEXT' "$output"
    refute_in 'INFRA-MARKER-TEXT' "$stderr"
    [ "$(stat -c %a "${GREMION_ROOT}/logs/cd-build-${TAG}.log")" = "600" ]
}

@test "build: a good build leaves no log behind" {
    retagged
    run prep 'cd_prepare_build "$TREE" green "$TAG"'
    [ "$status" -eq 0 ]
    [ ! -e "${GREMION_ROOT}/logs/cd-build-${TAG}.log" ]
}

@test "build refuses when the target env file does not carry the tag (retag first)" {
    mk_tree
    seed_release
    mk_live_images
    run prep 'cd_prepare_build "$TREE" green "$TAG"'
    [ "$status" -eq 2 ]
    [ "$(dk_count "|build")" = "0" ]
}

@test "build refuses the live colour as a target, and a tree that is not the tag's commit" {
    retagged
    run prep 'cd_prepare_build "$TREE" blue "$TAG"'
    [ "$status" -eq 2 ]
    run prep 'cd_prepare_build "$TREE" green pilot-cccccccccccc'
    [ "$status" -eq 2 ]
}

@test "build: compose refusing the shape (a bad env file) is code 2, not a block" {
    retagged
    sed -i '/^COMPOSE_FILE=/d' "${GREMION_ROOT}/etc/env/app-green.env"
    run prep 'cd_prepare_build "$TREE" green "$TAG"'
    [ "$status" -eq 2 ]
}

# ============================================================ the file itself

@test "prepare.sh sets no shell option and runs nothing when it is sourced" {
    run bash -c 'set +e; . "$HOST_SRC/lib/common.sh"; . "$HOST_SRC/lib/cd/core.sh"; . "$HOST_SRC/lib/cd/docker.sh"; . "$HOST_SRC/lib/cd/notify.sh"; . "$HOST_SRC/lib/cd/prepare.sh"; case $- in *e*) exit 1;; esac; case $- in *u*) exit 1;; esac; exit 0'
    [ "$status" -eq 0 ]
    run grep -nE '^[[:space:]]*set[[:space:]]+-' "${HOST_SRC}/lib/cd/prepare.sh"
    [ "$status" -eq 1 ]
}

@test "prepare.sh names no host, address or customer: it only ever prints names and counts" {
    run grep -nE '[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|@[a-z0-9-]+\.[a-z]{2,}' "${HOST_SRC}/lib/cd/prepare.sh"
    [ "$status" -eq 1 ]
}
