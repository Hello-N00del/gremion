#!/usr/bin/env bats
# Tests for the continuous-deployment (gremion-cd) host install: the six systemd units, the
# etc/cd.env template and the bootstrap stage `cd` (infra/host/bootstrap.sh).
# Run: bats test/host/cd-bootstrap.bats
#
# The stage runs for REAL against a scratch root: the files it installs are compared with the
# tree they came from, the inode of a replaced file is read, the directories are stat'ed. Only
# the commands that need a daemon or a second user are shims (systemctl, runuser, id).
#
# NO ROOT. The CI runner is a plain uid, and a skip is a failure there. The stage's root check is
# replaced by a no-op in the subshell that sources bootstrap.sh; `id` answers for the deploy user
# with the runner's own ids (so the chown and the stat the stage runs are real); a test that can
# only mean something as root asserts inside `if [ "$(id -u)" = 0 ]` like cd-docker.bats does.
# The repository-wide guards (address pattern, root allow-list, proof mode) are in
# scripts/cd/cd-guards.test.mjs.

load 'test_helper/host'
load 'test_helper/cd'

BOOTSTRAP="${HOST_SRC}/bootstrap.sh"
UNITS=(gremion-cd.service gremion-cd.timer gremion-cd-watchdog.service gremion-cd-watchdog.timer
    gremion-cd-resume.service 'gremion-cd-apply@.service')

setup() {
    setup_host_root
    mkdir -p "${GREMION_ROOT}/unit-dir" "${GREMION_ROOT}/data" "${GREMION_ROOT}/lib"
    export GREMION_SYSTEMD_DIR="${GREMION_ROOT}/unit-dir"
    export DEPLOY_USER=gremion
    # the ids of "gremion": the runner's own (a real chown to oneself), or fixed foreign ones as root
    if [ "$(id -u)" = 0 ]; then
        DEPLOY_IDS="1234 4321"
    else
        DEPLOY_IDS="$(id -u) $(id -g)"
    fi
    REAL_ID="$(command -v id)"
    REAL_CHOWN="$(command -v chown)"
    REAL_STAT="$(command -v stat)"
    set -- ${DEPLOY_IDS}
    shim id "if [ \"\${2-}\" = gremion ]; then case \"\$1\" in -u) echo $1; exit 0 ;; -g) echo $2; exit 0 ;; esac; fi; exec ${REAL_ID} \"\$@\""
    # runuser -u USER -- CMD...: run CMD as ourselves
    shim runuser 'shift 3; exec "$@"'
    shim systemctl
    # the program's status reads the engine and the mail transport: nothing here touches a real daemon
    shim docker
    shim curl
    hash -r
}

teardown() {
    teardown_host_root
}

# run_stage [SRC_DIR] -- stage_cd in a subshell with the root check replaced by a no-op.
run_stage() {
    local src="${1:-$HOST_SRC}"
    run bash -c '
        set -euo pipefail
        . "$1/bootstrap.sh"
        require_root() { :; }
        stage_cd
    ' stage "$src"
}

# fake_root -- make a plain-uid runner stand in for root, so that "root's" ownership and the deploy
# user's ownership are two DIFFERENT values and a test can tell them apart (as the runner both are
# the same uid and a stage that handed everything to the deploy user would pass):
#   `id -u` and `id -g` (no user) answer 0, `id -u gremion` the runner's ids as before;
#   chown records "<destination> <owner>" in $GREMION_ROOT/.owners (a temp name of the stage's
#   replace-by-rename is recorded under the destination it becomes) and really chowns unless the
#   owner is 0:0; stat of a recorded path answers that owner for %u and %g.
# owner_of <path> reads the answer back.
fake_root() {
    set -- ${DEPLOY_IDS}
    shim id "if [ \"\${2-}\" = gremion ]; then case \"\$1\" in -u) echo $1; exit 0 ;; -g) echo $2; exit 0 ;; esac; fi
case \"\$*\" in -u | -g) echo 0; exit 0 ;; esac
exec ${REAL_ID} \"\$@\""
    shim chown "owner=\"\$1\"; shift; [ \"\${1-}\" = -- ] && shift
for p in \"\$@\"; do
    key=\"\${p%.cd-new.*}\"
    printf '%s %s\n' \"\$key\" \"\$owner\" >> \"\${GREMION_ROOT}/.owners\"
    if [ \"\$owner\" != 0:0 ]; then ${REAL_CHOWN} \"\$owner\" -- \"\$p\" || exit 1; fi
done"
    shim stat "fmt=\"\$2\"; path=\"\$3\"
own=\"\$(awk -v k=\"\$path\" '\$1 == k { o = \$2 } END { print o }' \"\${GREMION_ROOT}/.owners\" 2>/dev/null)\"
if [ \"\$1\" = -c ] && [ -n \"\$own\" ]; then fmt=\"\${fmt//%u/\${own%%:*}}\"; fmt=\"\${fmt//%g/\${own##*:}}\"; fi
exec ${REAL_STAT} \"\$1\" \"\$fmt\" \"\$path\""
    hash -r
}

# owner_of <path> -- "uid:gid" as the stage left it (the recorded owner when fake_root is on)
owner_of() { stat -c %u:%g "$1"; }

# a writable copy of infra/host to mutate
scratch_host() {
    local d="${BATS_TEST_TMPDIR}/host-src"
    rm -rf "$d"
    mkdir -p "$d"
    cp -r "${HOST_SRC}/." "$d/"
    echo "$d"
}

# the installed set: every source file the stage must have copied, "<src> <dest>" per line
set_pairs() {
    local src="${1:-$HOST_SRC}" f
    for f in "$src"/bin/*; do
        [ -f "$f" ] && echo "$f ${GREMION_ROOT}/bin/${f##*/}"
    done
    echo "$src/lib/common.sh ${GREMION_ROOT}/lib/common.sh"
    for f in "$src"/lib/cd/*.sh; do
        [ -f "$f" ] && echo "$f ${GREMION_ROOT}/lib/cd/${f##*/}"
    done
    return 0
}

# the effective lines of a rendered unit (comments and blank lines dropped)
rendered() {
    bash -c '
        set -euo pipefail
        . "$1/bootstrap.sh"
        render_unit "$2" -
    ' render "$HOST_SRC" "$1" | sed -e '/^[[:space:]]*#/d' -e '/^[[:space:]]*$/d'
}

# ---------------------------------------------------------------------------
# the usage text and the dispatch
# ---------------------------------------------------------------------------

@test "--help names the stage cd and says what it does and does not do" {
    run bash "$BOOTSTRAP" --help
    [ "$status" -eq 0 ]
    [[ "$output" == *"  cd "* ]]
    [[ "$output" == *"enables nothing"* ]]
}

@test "the stage cd is not part of 'all' (it installs from a release checkout and enables nothing)" {
    run bash "$BOOTSTRAP" --help
    local all_line
    all_line="$(printf '%s\n' "$output" | grep -E '^  all ')"
    [[ "$all_line" != *" cd"* ]]
}

@test "main dispatches 'cd' to the stage, which starts with the root check" {
    run bash -c '
        set -euo pipefail
        . "$1/bootstrap.sh"
        require_root() { die "must run as root" 2; }
        main cd
    ' dispatch "$HOST_SRC"
    [ "$status" -eq 2 ]
    [[ "$output" == *"must run as root"* ]]
}

# ---------------------------------------------------------------------------
# the units, rendered through render_unit with its existing variable list
# ---------------------------------------------------------------------------

@test "every unit renders through render_unit with no token left and no literal install root" {
    local u out
    for u in "${UNITS[@]}"; do
        out="$(rendered "$u")"
        [ -n "$out" ] || { echo "$u rendered empty"; return 1; }
        [[ "$out" != *'${'* ]] || { echo "$u left a token"; return 1; }
        # a timer names its service only; every service names the install root
        case "$u" in
            *.service) [[ "$out" == *"${GREMION_ROOT}"* ]] || { echo "$u names no root"; return 1; } ;;
            *.timer) [[ "$out" == *"Unit=gremion-cd"* ]] || { echo "$u names no service"; return 1; } ;;
        esac
    done
}

@test "gremion-cd.service: oneshot as the deploy user, docker group, the installed tick, no deadline, no NoNewPrivileges" {
    run rendered gremion-cd.service
    [ "$status" -eq 0 ]
    local line
    for line in 'Type=oneshot' 'User=gremion' 'Group=gremion' 'SupplementaryGroups=docker' \
        "Environment=GREMION_ROOT=${GREMION_ROOT}" "ExecStart=${GREMION_ROOT}/bin/gremion-cd tick" \
        'TimeoutStartSec=infinity' 'Nice=10' 'ProtectSystem=full'; do
        printf '%s\n' "$output" | grep -qxF -- "$line" || { echo "missing: $line"; return 1; }
    done
    assert_unit_lacks "$output" NoNewPrivileges
}

@test "gremion-cd.timer: boot delay, five minutes after the last run, a random delay" {
    run rendered gremion-cd.timer
    [ "$status" -eq 0 ]
    local line
    for line in 'OnUnitInactiveSec=5min' 'Unit=gremion-cd.service' 'WantedBy=timers.target'; do
        printf '%s\n' "$output" | grep -qxF -- "$line" || { echo "missing: $line"; return 1; }
    done
    printf '%s\n' "$output" | grep -qE '^OnBootSec=[0-9]+(min|s)$'
    printf '%s\n' "$output" | grep -qE '^RandomizedDelaySec=[0-9]+(min|s)$'
}

@test "gremion-cd-watchdog: its own service and its own ten-minute timer, not the tick's" {
    run rendered gremion-cd-watchdog.service
    [ "$status" -eq 0 ]
    local line
    for line in 'Type=oneshot' 'User=gremion' 'Group=gremion' "ExecStart=${GREMION_ROOT}/bin/gremion-cd watchdog"; do
        printf '%s\n' "$output" | grep -qxF -- "$line" || { echo "missing: $line"; return 1; }
    done
    assert_unit_lacks "$output" NoNewPrivileges
    run rendered gremion-cd-watchdog.timer
    [ "$status" -eq 0 ]
    for line in 'OnUnitInactiveSec=10min' 'Unit=gremion-cd-watchdog.service' 'WantedBy=timers.target'; do
        printf '%s\n' "$output" | grep -qxF -- "$line" || { echo "missing: $line"; return 1; }
    done
    printf '%s\n' "$output" | grep -qE '^OnBootSec='
}

@test "gremion-cd-resume.service: finishes an interrupted release before the executor starts, holds its lock for as long as it runs" {
    run rendered gremion-cd-resume.service
    [ "$status" -eq 0 ]
    local line
    for line in 'Type=oneshot' 'User=gremion' 'Group=gremion' 'SupplementaryGroups=docker' \
        'After=docker.service' 'Before=gremion-executor.service' 'WantedBy=multi-user.target' \
        'TimeoutStartSec=infinity' "ExecStart=${GREMION_ROOT}/bin/gremion-cd tick --resume-only"; do
        printf '%s\n' "$output" | grep -qxF -- "$line" || { echo "missing: $line"; return 1; }
    done
    assert_unit_lacks "$output" NoNewPrivileges
    # an exited oneshot would drop the lock the resumed release holds
    assert_unit_lacks "$output" RemainAfterExit
}

@test "gremion-cd-apply@.service: a root oneshot with no sandbox, no User, one ExecStart, no [Install]" {
    run rendered 'gremion-cd-apply@.service'
    [ "$status" -eq 0 ]
    local line
    for line in 'Type=oneshot' "ExecStart=${GREMION_ROOT}/lib/cd/apply-root.sh %i" \
        "Environment=GREMION_ROOT=${GREMION_ROOT}" 'Environment=DEPLOY_USER=gremion'; do
        printf '%s\n' "$output" | grep -qxF -- "$line" || { echo "missing: $line"; return 1; }
    done
    [ "$(printf '%s\n' "$output" | grep -c '^Exec')" -eq 1 ]
    local k
    for k in ProtectSystem ProtectHome User Group NoNewPrivileges WantedBy RequiredBy; do
        assert_unit_lacks "$output" "$k"
    done
    [[ "$output" != *'[Install]'* ]]
}

# assert_unit_lacks <rendered unit text> <key> -- no effective line sets the key
assert_unit_lacks() {
    local hit
    hit="$(printf '%s\n' "$1" | grep -E "^$2=" || true)"
    [ -z "$hit" ] || { echo "the unit sets $2: $hit"; return 1; }
}

# ---------------------------------------------------------------------------
# cd.env.tmpl against the parser of the program
# ---------------------------------------------------------------------------

# template_keys -- the KEY of every effective line of the template, sorted
template_keys() {
    sed -e '/^[[:space:]]*#/d' -e '/^[[:space:]]*$/d' "${HOST_SRC}/templates/env/cd.env.tmpl" | sed 's/=.*//' | sort
}

@test "cd.env.tmpl carries every key the parser knows and no key it would refuse (drift both ways)" {
    run bash -c '
        set -euo pipefail
        . "$1/lib/common.sh"
        . "$1/lib/cd/core.sh"
        printf "%s\n" "${!CD_KIND[@]}" | sort
    ' keys "$HOST_SRC"
    [ "$status" -eq 0 ]
    local known="$output" mine
    mine="$(template_keys)"
    [ -n "$mine" ]
    [ "$known" = "$mine" ] || { diff <(printf '%s\n' "$known") <(printf '%s\n' "$mine") || true; return 1; }
}

@test "cd.env.tmpl: a key with a default in the program ships exactly that default, every other key is empty or a placeholder" {
    run bash -c '
        set -euo pipefail
        . "$1/lib/common.sh"
        . "$1/lib/cd/core.sh"
        n=0
        while IFS= read -r line; do
            [[ "$line" =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]] || continue
            key="${BASH_REMATCH[1]}"; val="${BASH_REMATCH[2]}"
            if [[ "$val" =~ ^\"(.*)\"$ ]]; then val="${BASH_REMATCH[1]}"; fi
            n=$((n + 1))
            if [[ -n "${CD_DEFAULTS[$key]+set}" ]]; then
                [[ "$val" == "${CD_DEFAULTS[$key]}" ]] || { echo "$key: template ${val}, program default ${CD_DEFAULTS[$key]}"; exit 1; }
            else
                [[ -z "$val" || "$val" == CHANGE_ME_OPERATOR_* ]] || { echo "$key has no default but ships a value"; exit 1; }
            fi
        done < <(sed -e "/^[[:space:]]*#/d" "$2")
        [[ "$n" -ge 40 ]] || { echo "only $n keys read"; exit 1; }
        echo "checked $n"
    ' defaults "$HOST_SRC" "${HOST_SRC}/templates/env/cd.env.tmpl"
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
}

@test "cd.env.tmpl as shipped is refused by the program (placeholders), filled with example values it parses (exit 0)" {
    local cfg="${GREMION_ROOT}/etc/cd.env"
    cp "${HOST_SRC}/templates/env/cd.env.tmpl" "$cfg"
    run bash -c '
        set -euo pipefail
        . "$1/lib/common.sh"
        . "$1/lib/cd/core.sh"
        cd_cfg_load
    ' load "$HOST_SRC"
    [ "$status" -eq 2 ]
    [[ "$output" == *"CHANGE_ME_OPERATOR_"* ]]

    sed -i \
        -e 's|^CD_REPO_URL=.*|CD_REPO_URL=https://example.org/org/repo|' \
        -e 's|^CD_MAIL_TO=.*|CD_MAIL_TO=ops@example.org|' \
        -e 's|^CD_HOST_LABEL=.*|CD_HOST_LABEL=pilot-a|' \
        -e 's|^CD_PROBE_HOST=.*|CD_PROBE_HOST=app.example.org|' "$cfg"
    run bash -c '
        set -euo pipefail
        . "$1/lib/common.sh"
        . "$1/lib/cd/core.sh"
        cd_cfg_load
        printf "%s %s\n" "$(cd_cfg CD_PROOF_MODE)" "$(cd_cfg CD_LEAF_MIGRATE_TIMEOUT_S)"
    ' load "$HOST_SRC"
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    [ "$output" = "0 600" ]
}

# ---------------------------------------------------------------------------
# the stage
# ---------------------------------------------------------------------------

@test "stage cd installs bin/*, lib/common.sh and lib/cd/*.sh as real files, byte-identical to the tree" {
    run_stage
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    local n=0 src dest
    while read -r src dest; do
        [ -f "$dest" ] || { echo "not installed: $dest"; return 1; }
        [ ! -L "$dest" ] || { echo "a symlink: $dest"; return 1; }
        cmp -s "$src" "$dest" || { echo "differs: $dest"; return 1; }
        n=$((n + 1))
    done < <(set_pairs)
    # a stage that copied nothing must not pass: the dispatcher, the core library and the apply script are there
    [ "$n" -ge 20 ]
    [ -x "${GREMION_ROOT}/bin/gremion-cd" ]
    [ -f "${GREMION_ROOT}/lib/cd/core.sh" ]
    [ -x "${GREMION_ROOT}/lib/cd/apply-root.sh" ]
}

@test "stage cd modes: programs 0755, libraries 0644, apply-root.sh 0755" {
    run_stage
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    [ "$(stat -c %a "${GREMION_ROOT}/bin/gremion-cd")" = 755 ]
    [ "$(stat -c %a "${GREMION_ROOT}/lib/common.sh")" = 644 ]
    [ "$(stat -c %a "${GREMION_ROOT}/lib/cd/core.sh")" = 644 ]
    [ "$(stat -c %a "${GREMION_ROOT}/lib/cd/apply-root.sh")" = 755 ]
    [ "$(stat -c %a "${GREMION_ROOT}/lib/cd")" = 755 ]
}

# What this proves and what it does not. The apply script and lib/cd are root's, so a process of
# the deploy user that holds no sudo cannot edit the script in place. It is NOT a barrier against
# the deploy user itself: that user holds sudo NOPASSWD:ALL (stage user) and owns lib/, so it can
# rename lib/cd whatever the owner of the directory is. The owner is still checked, because a
# deploy-owned apply script would also be edited in place by every compromised tick.
@test "stage cd owners: apply-root.sh and lib/cd belong to root, everything else of the set to the deploy user" {
    fake_root
    run_stage
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    set -- ${DEPLOY_IDS}
    local dep="$1:$2" f
    [ "$(owner_of "${GREMION_ROOT}/lib/cd/apply-root.sh")" = 0:0 ] || { echo "apply-root.sh: $(owner_of "${GREMION_ROOT}/lib/cd/apply-root.sh")"; return 1; }
    [ "$(owner_of "${GREMION_ROOT}/lib/cd")" = 0:0 ] || { echo "lib/cd: $(owner_of "${GREMION_ROOT}/lib/cd")"; return 1; }
    for f in bin/gremion-cd lib/common.sh lib/cd/core.sh bin lib; do
        [ "$(owner_of "${GREMION_ROOT}/${f}")" = "$dep" ] || { echo "${f}: $(owner_of "${GREMION_ROOT}/${f}")"; return 1; }
    done
    # the guard has teeth: the two owners are really different values here
    [ "$dep" != 0:0 ]
    [ -s "${GREMION_ROOT}/.owners" ]
}

@test "stage cd replaces a file by a NEW inode, so a script bash is running is never changed in place" {
    run_stage
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    local f before after
    for f in bin/gremion-cd lib/common.sh lib/cd/core.sh lib/cd/apply-root.sh; do
        before="$(stat -c %i "${GREMION_ROOT}/${f}")"
        # hold the old inode open, as a running bash does
        exec 7<"${GREMION_ROOT}/${f}"
        run_stage
        [ "$status" -eq 0 ] || { echo "$output"; return 1; }
        after="$(stat -c %i "${GREMION_ROOT}/${f}")"
        exec 7<&-
        [ "$before" != "$after" ] || { echo "${f} was rewritten in place (inode ${before})"; return 1; }
    done
}

@test "stage cd removes a library of lib/cd that the tree no longer has (the dispatcher sources every file there)" {
    mkdir -p "${GREMION_ROOT}/lib/cd"
    printf 'cd_stale() { :; }\n' > "${GREMION_ROOT}/lib/cd/zz-stale.sh"
    run_stage
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    [ ! -e "${GREMION_ROOT}/lib/cd/zz-stale.sh" ]
    [ -f "${GREMION_ROOT}/lib/cd/core.sh" ]
}

@test "stage cd renders the six units, runs daemon-reload and enables or starts nothing" {
    run_stage
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    local u
    for u in "${UNITS[@]}"; do
        [ -s "${GREMION_SYSTEMD_DIR}/${u}" ] || { echo "not rendered: $u"; return 1; }
        [ "$(stat -c %a "${GREMION_SYSTEMD_DIR}/${u}")" = 644 ]
        [ "$(grep -c '\${' "${GREMION_SYSTEMD_DIR}/${u}" || true)" = 0 ]
    done
    assert_recorded systemctl "daemon-reload"
    refute_recorded systemctl "enable"
    refute_recorded systemctl "start"
    refute_recorded systemctl "restart"
    refute_recorded systemctl "disable"
}

@test "stage cd creates data/cd (0700), runtime/cd (0700) and runtime/workers (0755) for the deploy user" {
    run_stage
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    set -- ${DEPLOY_IDS}
    [ "$(stat -c '%a %u:%g' "${GREMION_ROOT}/data/cd")" = "700 $1:$2" ]
    [ "$(stat -c '%a %u:%g' "${GREMION_ROOT}/runtime/cd")" = "700 $1:$2" ]
    [ "$(stat -c '%a %u:%g' "${GREMION_ROOT}/runtime/workers")" = "755 $1:$2" ]
}

@test "stage cd is idempotent: a wrong mode is corrected and what is right stays" {
    mkdir -p "${GREMION_ROOT}/data/cd" "${GREMION_ROOT}/runtime/cd" "${GREMION_ROOT}/runtime/workers"
    chmod 755 "${GREMION_ROOT}/data/cd" "${GREMION_ROOT}/runtime/cd"
    chmod 700 "${GREMION_ROOT}/runtime/workers"
    : > "${GREMION_ROOT}/runtime/workers/blue"
    run_stage
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    run_stage
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    [ "$(stat -c %a "${GREMION_ROOT}/data/cd")" = 700 ]
    [ "$(stat -c %a "${GREMION_ROOT}/runtime/cd")" = 700 ]
    [ "$(stat -c %a "${GREMION_ROOT}/runtime/workers")" = 755 ]
    # a gate file that is already there is not touched
    [ -f "${GREMION_ROOT}/runtime/workers/blue" ]
}

@test "stage cd hands a root-owned runtime/workers (a bind source docker made) to the deploy user" {
    # Only root can make a directory root-owned and only root can hand it back: the assertions run
    # in the root bats runner (make test-host-docker) and the stage's own post-condition
    # (stat of the owner) fails the stage on every other uid when the chown did not take.
    mkdir -p "${GREMION_ROOT}/runtime/workers" "${GREMION_ROOT}/data/cd"
    if [ "$(id -u)" = 0 ]; then
        chown 0:0 "${GREMION_ROOT}/runtime/workers" "${GREMION_ROOT}/data/cd"
    fi
    run_stage
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    set -- ${DEPLOY_IDS}
    [ "$(stat -c %u:%g "${GREMION_ROOT}/runtime/workers")" = "$1:$2" ]
    [ "$(stat -c %u:%g "${GREMION_ROOT}/data/cd")" = "$1:$2" ]
}

@test "stage cd refuses a directory it cannot hand to the deploy user, naming it" {
    # the deploy user's ids differ from the runner's, so the chown is refused (a no-op as root)
    if [ "$(id -u)" = 0 ]; then
        shim chown 'exit 1'
    else
        shim id "if [ \"\${2-}\" = gremion ]; then case \"\$1\" in -u) echo 4242; exit 0 ;; -g) echo 4242; exit 0 ;; esac; fi; exec ${REAL_ID} \"\$@\""
    fi
    hash -r
    run_stage
    [ "$status" -ne 0 ]
    [[ "$output" == *"data/cd"* || "$output" == *"runtime"* || "$output" == *"hand"* || "$output" == *"owner"* ]]
}

@test "stage cd writes etc/cd.env from the template only when it is absent, mode 0640 for the deploy user" {
    run_stage
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    local cfg="${GREMION_ROOT}/etc/cd.env"
    [ -f "$cfg" ]
    cmp -s "${HOST_SRC}/templates/env/cd.env.tmpl" "$cfg"
    set -- ${DEPLOY_IDS}
    [ "$(stat -c '%a %u:%g' "$cfg")" = "640 $1:$2" ]
    # an operator's edit survives a second run (and an apply)
    printf '# edited by the operator\n' >> "$cfg"
    local before; before="$(cksum < "$cfg")"
    run_stage
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    [ "$(cksum < "$cfg")" = "$before" ]
}

@test "stage cd runs gremion-cd status as the deploy user: a fresh install answers with the config refusal, a configured one with 0" {
    run_stage
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    [[ "$output" == *"gremion-cd status"* ]]
    # now with a configuration the program accepts
    sed -i \
        -e 's|^CD_REPO_URL=.*|CD_REPO_URL=https://example.org/org/repo|' \
        -e 's|^CD_MAIL_TO=.*|CD_MAIL_TO=ops@example.org|' \
        -e 's|^CD_HOST_LABEL=.*|CD_HOST_LABEL=pilot-a|' \
        -e 's|^CD_PROBE_HOST=.*|CD_PROBE_HOST=app.example.org|' "${GREMION_ROOT}/etc/cd.env"
    run_stage
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    assert_recorded runuser "-u gremion --"
}

@test "stage cd fails when an installed library does not load (the status check is not vacuous)" {
    local src; src="$(scratch_host)"
    printf 'cd_broken() {\n' > "${src}/lib/cd/zz-broken.sh"
    run_stage "$src"
    [ "$status" -ne 0 ]
    [[ "$output" == *"library did not load"* || "$output" == *"status"* ]]
}

@test "stage cd fails when an installed file does not read back byte-identical to the tree" {
    local src; src="$(scratch_host)"
    # a cp that corrupts the file it installs: the post-condition must catch it
    local real_cmp; real_cmp="$(command -v cmp)"
    shim cmp "case \"\$*\" in *gremion-cd*) exit 1 ;; *) exec ${real_cmp} \"\$@\" ;; esac"
    hash -r
    run_stage "$src"
    [ "$status" -ne 0 ]
    [[ "$output" == *"differs"* || "$output" == *"identical"* ]]
}

@test "stage cd refuses a source tree without the dispatcher before it touches the root" {
    local src; src="$(scratch_host)"
    rm -f "${src}/bin/gremion-cd"
    run_stage "$src"
    [ "$status" -eq 2 ]
    [[ "$output" == *"gremion-cd"* ]]
    [ ! -e "${GREMION_ROOT}/lib/cd" ]
    [ ! -e "${GREMION_ROOT}/etc/cd.env" ]
}

@test "stage cd refuses a deploy user that does not exist, naming the stage to run first" {
    shim id "if [ \"\${2-}\" = gremion ]; then exit 1; fi; exec ${REAL_ID} \"\$@\""
    hash -r
    run_stage
    [ "$status" -eq 2 ]
    [[ "$output" == *"user"* ]]
    [ ! -e "${GREMION_ROOT}/lib/cd" ]
}

@test "stage cd passes its status check in the middle of an apply: a release in flight, a hold, an ALERT file and both locks held by the caller" {
    cd_need_flock
    run_stage
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    sed -i \
        -e 's|^CD_REPO_URL=.*|CD_REPO_URL=https://example.org/org/repo|' \
        -e 's|^CD_MAIL_TO=.*|CD_MAIL_TO=ops@example.org|' \
        -e 's|^CD_HOST_LABEL=.*|CD_HOST_LABEL=pilot-a|' \
        -e 's|^CD_PROBE_HOST=.*|CD_PROBE_HOST=app.example.org|' "${GREMION_ROOT}/etc/cd.env"
    # what release-now leaves behind while it applies host programs
    cd_seed_state '.phase = "releasing"
        | .live = ('"$CD_LIVE_JSON"')
        | .hold = {"kind":"failure","reason":"build","sha12":"bbbbbbbbbbbb","since":"2026-11-17T01:00:00Z"}
        | .release = {"id":"bbbbbbbbbbbb-1","sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","sha12":"bbbbbbbbbbbb","tag":"pilot-bbbbbbbbbbbb","colour":"green","tree":"/opt/gremion/releases/bbbbbbbbbbbb","mode":"manual","stage":"host_apply","stage_status":"started","attempt":1}'
    printf 'an earlier fatal exit\n' > "${GREMION_ROOT}/data/cd/ALERT"
    hold_host_lock 30
    exec 8>>"${GREMION_ROOT}/runtime/cd/cd.lock"
    flock -n 8
    run_stage
    exec 8>&-
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    [[ "$output" == *"gremion-cd status runs"* ]]
}
