#!/usr/bin/env bash
# infra/host/lib/cd/prepare.sh -- the "prepare" stages of gremion-cd (unit cd-prepare):
# the start gate (precheck), the fetch of a release tree, the retag of the target colour,
# the render and the build.
#
# SOURCED, NEVER EXECUTED. Like the rest of the family it sets no shell options and runs
# nothing at the top level: the program that sources it owns them, and a driver calls a
# stage as `fn || rc=$?`, which switches errexit off inside it. Every command here that
# can fail therefore carries its own `|| return N`.
#
# STAGE RETURN CODES (the family convention): 0 ok, 1 a failure attributable to the
# commit, 2 a precondition or host configuration, 3 waiting (retry later, a timeout
# included), 4 an infrastructure failure that may be retried. A stage prints a reason
# on stderr (one line, names and counts only) and, for the precheck, in CD_PREPARE_WHY.
#
# WHAT THIS FILE NEVER DOES. It never moves the `current` link, never touches a live
# colour's env file, tag, tree or containers, never touches state.env, and never prints
# a host name, an address, a slug or the text of a build or render log: a log goes to a
# 0600 file under logs/ and only the file name is reported. It calls compose only
# through cd_dc (docker.sh), which owns the one compose shape and the profile star.
#
# DEPENDS ON core.sh (config, state, locks, clock, history) and docker.sh (cd_dc,
# cd_envfile, cd_kv_get, cd_set_env_key, cd_project_cids, cd_image_id, cd_wait_healthy)
# and notify.sh (the mail transport and the age of the outbox). It calls, when they
# exist, cd_watch_probe_public (watch.sh).

# The jq programs below are single-quoted on purpose ($name is jq's own variable syntax),
# and CD_PREPARE_WHY is read by the driver, which shellcheck does not follow from here.
# shellcheck disable=SC2016,SC2034

# why the last precheck refused: a code word, empty when it passed
CD_PREPARE_WHY=''

# The build log patterns of an INFRASTRUCTURE failure (retried, never blocked): one array,
# one test per entry. Everything else a failed build says is a failure of the commit.
CD_PREPARE_INFRA_PATTERNS=(
    'no space left on device'
    'TLS handshake timeout'
    'toomanyrequests'
    'connection reset'
    'i/o timeout'
    'temporary failure in name resolution'
    'unexpected EOF'
    '50[234] (Bad Gateway|Service Unavailable|Gateway Time-?out)'
    'unexpected (HTTP )?status:? 50[234]'
)

# Lines the infra patterns must never see: bash says the same words about a broken RUN
# script, and that is the commit's own error.
_CD_PREP_NOT_INFRA='unexpected EOF while looking for matching|syntax error: unexpected end of file'

# the first-party repositories whose images only a build with the profile star
# produces (the one-shots: gremion-migrate serves migrate and tenant-create, the
# kernel-api image serves kernel-api-migrate); the build stage fails when the image
# list it computed has none of them under the new tag
_CD_PREP_ONESHOT_REPOS=(gremion-migrate gremion-kernel-api)

_cd_prep_err() { printf 'cd-prepare: %s\n' "$*" >&2; }

# _cd_prep_refuse WHY TEXT... -- record the code word and say it once.
_cd_prep_refuse() {
    CD_PREPARE_WHY="$1"
    shift
    _cd_prep_err "precheck: $*"
}

_cd_prep_colour_ok() { [[ "${1:-}" == blue || "${1:-}" == green ]]; }
_cd_prep_tag_ok() { [[ "${1:-}" =~ ^pilot-[0-9a-f]{12}$ ]]; }

# _cd_prep_git TREE ARGS... -- git on a work tree: no stdin, none of the caller's GIT_*
# variables, no optional index lock.
_cd_prep_git() {
    local tree="$1"
    shift
    env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE -u GIT_OBJECT_DIRECTORY \
        git -C "$tree" --no-optional-locks "$@" </dev/null
}

# _cd_prep_mg ARGS... -- git against the mirror.
_cd_prep_mg() {
    env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE -u GIT_OBJECT_DIRECTORY \
        git --git-dir="$CD_MIRROR_DIR" "$@" </dev/null
}

# _cd_prep_tree_ok TREE SHA -- 0 when TREE is a git work tree whose HEAD is SHA and whose
# work tree is clean (ignored files, which a render writes, do not count).
_cd_prep_tree_ok() {
    local tree="$1" sha="$2" head st
    [[ -d "$tree" && ! -L "$tree" && -d "${tree}/.git" ]] || return 1
    head="$(_cd_prep_git "$tree" rev-parse HEAD 2>/dev/null)" || return 1
    [[ "$head" == "$sha" ]] || return 1
    st="$(_cd_prep_git "$tree" status --porcelain 2>/dev/null)" || return 1
    [[ -z "$st" ]]
}

# _cd_prep_tree_tag TREE TAG -- 0 when the tree's HEAD is the commit the tag names: an image
# built from one commit under the tag of another is the worst silent mistake there is.
_cd_prep_tree_tag() {
    local head
    head="$(_cd_prep_git "$1" rev-parse HEAD 2>/dev/null)" || return 1
    [[ "${head:0:12}" == "${2#pilot-}" ]]
}

# -- logs ---------------------------------------------------------------------
# _cd_prep_log_open NAME -- a fresh 0600 file logs/NAME.log, its path on stdout.
_cd_prep_log_open() {
    local d="${CD_ROOT}/logs" f
    if [[ ! -d "$d" ]]; then
        mkdir -p "$d" || return 1
        chmod 700 "$d" || return 1
    fi
    f="${d}/${1}.log"
    ( umask 077; : >"$f" ) || return 1
    chmod 600 "$f" || return 1
    printf '%s\n' "$f"
}

# _cd_prep_log_keep FILE -- keep the last 500 lines, mode 0600.
_cd_prep_log_keep() {
    local f="$1"
    ( umask 077; tail -n 500 -- "$f" >"${f}.tmp" ) || return 1
    mv -f -- "${f}.tmp" "$f" || return 1
    chmod 600 "$f"
}

# ==============================================================================
# PRECHECK
# ==============================================================================

# _cd_prep_in_quiet_window -- 0 when the host's clock time lies inside a
# CD_QUIET_WINDOWS slot (HH:MM-HH:MM, comma separated, a slot may cross midnight).
_cd_prep_in_quiet_window() {
    local now hm cur w s e sm em
    local -a ws=()
    now="$(cd_now)" || return 2
    hm="$(date -d "@${now}" +%H:%M)" || return 2
    cur=$((10#${hm%:*} * 60 + 10#${hm#*:}))
    IFS=',' read -r -a ws <<<"$(cd_cfg CD_QUIET_WINDOWS)" || true
    for w in "${ws[@]+"${ws[@]}"}"; do
        [[ -n "$w" ]] || continue
        s="${w%-*}"
        e="${w#*-}"
        sm=$((10#${s%:*} * 60 + 10#${s#*:}))
        em=$((10#${e%:*} * 60 + 10#${e#*:}))
        if ((sm < em)); then
            if ((cur >= sm && cur < em)); then return 0; fi
        elif ((sm > em)); then
            if ((cur >= sm || cur < em)); then return 0; fi
        fi
    done
    return 1
}

# cd_prepare_probe_host -- the customer host the probes ask: CD_PROBE_HOST, else the first
# field of the first line of etc/tenant-hosts.txt that is no comment. Printed (so a caller
# can use it; this file never does). 2 when neither names one.
cd_prepare_probe_host() {
    local h f line
    h="$(cd_cfg CD_PROBE_HOST)" || return 2
    if [[ -z "$h" ]]; then
        f="${CD_ROOT}/etc/tenant-hosts.txt"
        if [[ -r "$f" ]]; then
            while IFS= read -r line || [[ -n "$line" ]]; do
                line="${line%$'\r'}"
                line="${line#"${line%%[![:space:]]*}"}"
                [[ -z "$line" || "$line" == \#* ]] && continue
                h="${line%%[[:space:]]*}"
                break
            done <"$f"
        fi
    fi
    if [[ -z "$h" ]]; then
        _cd_prep_err "no probe host (CD_PROBE_HOST is empty and etc/tenant-hosts.txt names none)"
        return 2
    fi
    if ! cd_cfg_check host "$h"; then
        _cd_prep_err "the probe host is not a host name"
        return 2
    fi
    printf '%s\n' "$h"
}

# _cd_prep_lock_free FILE HOLDER_PID -- 0 when no OTHER process holds the lock on FILE (this
# process counts as free: it is the caller's own lock), 1 when another does, 2 without flock.
_cd_prep_lock_free() {
    local f="$1" holder="$2"
    [[ "$holder" == "$$" ]] && return 0
    [[ -e "$f" ]] || return 0
    command -v flock >/dev/null 2>&1 || return 2
    ( exec 7>>"$f" && flock -n 7 ) 2>/dev/null </dev/null || return 1
    return 0
}

# _cd_prep_free_gb PATH -- whole gigabytes free on the file system of PATH.
_cd_prep_free_gb() {
    local kb
    kb="$(df -Pk -- "$1" 2>/dev/null </dev/null | awk 'NR == 2 { print $4 }')" || return 1
    [[ "$kb" =~ ^[0-9]+$ ]] || return 1
    printf '%s\n' "$((kb / 1048576))"
}

# _cd_prep_disk_gb -- the smaller of the free space under the host root and under the
# docker root directory (the build writes into the second). 1 when either is unknown.
_cd_prep_disk_gb() {
    local a b droot
    a="$(_cd_prep_free_gb "$CD_ROOT")" || return 1
    droot="$(docker info --format '{{.DockerRootDir}}' </dev/null 2>/dev/null)" || return 1
    [[ "$droot" == /* ]] || return 1
    b="$(_cd_prep_free_gb "$droot")" || return 1
    if ((a < b)); then printf '%s\n' "$a"; else printf '%s\n' "$b"; fi
}

# cd_prepare_precheck -- may a release start now? 0 yes. Otherwise a reason on stderr and
# in CD_PREPARE_WHY and: 2 a configuration or precondition problem, 3 not now (retry
# later), 4 the disk (an infrastructure problem). The refusals without side effect come
# first; the prune of the disk check is the only thing that changes anything.
# It does not look at the hold or at the block list: those depend on the candidate and
# are the driver's. Needs state.live (the state project's compose files come from the
# live release tree).
cd_prepare_precheck() {
    local relay=0 age min free live_tree rc=0
    CD_PREPARE_WHY=''
    cd_cfg CD_MIN_FREE_GB >/dev/null || { _cd_prep_refuse config "the config is not loaded"; return 2; }

    if cd_killswitch_active; then
        _cd_prep_refuse killswitch "the kill switch is present"
        return 3
    fi
    if ! cd_cfg_is_set CD_POLICY_ACK; then
        _cd_prep_refuse policy_ack "CD_POLICY_ACK is not set"
        return 2
    fi
    if ! cd_cfg_is_set CD_MAIL_TO; then
        _cd_prep_refuse mail_to "CD_MAIL_TO is not set"
        return 2
    fi

    # mail: a release nobody can be told about is refused, unless the operator said so
    if cd_notify_transport_ok; then relay=1; fi
    if ((relay == 0)); then
        # the flag excuses the Stalwart transport only: a transport that cannot be read is
        # "cannot tell", never a pass
        if [[ "${CD_NOTIFY_TRANSPORT_VALUE:-}" != stalwart ]]; then
            _cd_prep_refuse mail_transport "the mail transport cannot be read"
            return 2
        fi
        if [[ "$(cd_cfg CD_ALLOW_NO_MAIL)" != 1 ]]; then
            _cd_prep_refuse mail_transport "the mail transport is not the relay and CD_ALLOW_NO_MAIL is not 1"
            return 2
        fi
    fi
    if ((relay == 1)); then
        if [[ -e "$CD_ALERT_FILE" || -L "$CD_ALERT_FILE" ]]; then
            _cd_prep_refuse alert "the ALERT file is present"
            return 3
        fi
        age="$(cd_notify_outbox_age)" || age=0
        if [[ "$age" =~ ^[0-9]+$ ]] && ((age > 3600)); then
            _cd_prep_refuse outbox_stale "a mail has waited in the outbox for more than an hour"
            return 3
        fi
    fi

    rc=0
    _cd_prep_in_quiet_window || rc=$?
    if ((rc == 0)); then
        _cd_prep_refuse quiet_window "the clock is inside a quiet window"
        return 3
    elif ((rc != 1)); then
        _cd_prep_refuse clock "the clock cannot be read"
        return 2
    fi

    cd_prepare_probe_host >/dev/null || { CD_PREPARE_WHY=probe_host; return 2; }

    rc=0
    _cd_prep_lock_free "${CD_RUN}/cd.lock" "${CD_LOCK_PID:-}" || rc=$?
    if ((rc == 2)); then _cd_prep_refuse lock_busy "flock is not installed"; return 2; fi
    if ((rc != 0)); then _cd_prep_refuse lock_busy "another gremion-cd holds the cd lock"; return 3; fi
    rc=0
    _cd_prep_lock_free "${CD_ROOT}/runtime/hostd.lock" "${CD_HOSTLOCK_PID:-}" || rc=$?
    if ((rc == 2)); then _cd_prep_refuse lock_busy "flock is not installed"; return 2; fi
    if ((rc != 0)); then _cd_prep_refuse lock_busy "the host lock is held"; return 3; fi

    live_tree="$(cd_state_get '.live.tree // empty')" || { _cd_prep_refuse state "the state cannot be read"; return 2; }
    if [[ -z "$live_tree" ]]; then
        _cd_prep_refuse no_live "no live release is recorded (adopt first)"
        return 2
    fi
    if ! declare -F cd_watch_probe_public >/dev/null 2>&1; then
        _cd_prep_refuse live_not_ready "the public probe is not installed"
        return 2
    fi
    if ! cd_watch_probe_public >/dev/null 2>&1; then
        _cd_prep_refuse live_not_ready "the live colour does not answer ready through the public edge"
        return 3
    fi
    rc=0
    cd_wait_healthy state 0 "$live_tree" || rc=$?
    if ((rc == 3)); then
        _cd_prep_refuse state_unhealthy "the state project is not healthy:${CD_WAIT_BAD:-}"
        return 3
    elif ((rc != 0)); then
        _cd_prep_refuse state_unknown "the state project could not be inspected"
        return 2
    fi

    # disk last: it is the one check that acts (a prune)
    min="$(cd_cfg CD_MIN_FREE_GB)" || return 2
    if ((10#$min > 0)); then
        free="$(_cd_prep_disk_gb)" || { _cd_prep_refuse disk "the free disk space cannot be read"; return 4; }
        if ((free < 10#$min)); then
            docker builder prune -f --keep-storage "$(cd_cfg CD_BUILD_CACHE_KEEP_GB)GB" </dev/null >/dev/null 2>&1 \
                || _cd_prep_err "precheck: the builder cache prune failed"
            free="$(_cd_prep_disk_gb)" || { _cd_prep_refuse disk "the free disk space cannot be read"; return 4; }
        fi
        if ((free < 10#$min)); then
            _cd_prep_refuse disk "${free} GB free after a prune, ${min} GB are required"
            return 4
        fi
    fi
    return 0
}

# ==============================================================================
# FETCH
# ==============================================================================

# _cd_prep_tree_in_use TREE -- 0 when TREE is the live or the previous release tree (or the
# state cannot say: unknown counts as in use).
_cd_prep_tree_in_use() {
    local t
    t="$(cd_state_get '[.live.tree, .previous.tree] | map(select(. != null)) | .[]')" || return 0
    printf '%s\n' "$t" | grep -Fxq -- "$1"
}

# cd_prepare_fetch SHA [REF] -- the full git work tree of SHA at releases/<sha12>, from the
# mirror only (no network). SHA must be an ancestor of refs/heads/main, or, in proof mode
# with REF, of refs/proof/<REF>: a commit that exists only on another ref is refused (2).
# The tree is cloned to a temporary name under umask 022 and moved into place, so a crash
# leaves no half tree and the caller's umask never reaches it; HEAD is SHA and the work
# tree is clean. An existing tree that already is exactly that is reused. Prints the path.
# 2 refused or not as expected, 4 the clone failed (disk, git).
cd_prepare_fetch() {
    local sha="${1:-}" ref="${2:-}" sha12 tipref rel tree tmp
    if [[ ! "$sha" =~ ^[0-9a-f]{40}$ ]]; then
        _cd_prep_err "fetch: not a full sha"
        return 2
    fi
    sha12="${sha:0:12}"
    if [[ ! -d "$CD_MIRROR_DIR" ]]; then
        _cd_prep_err "fetch: there is no mirror"
        return 2
    fi
    if [[ -n "$ref" ]]; then
        if [[ "$(cd_cfg CD_PROOF_MODE)" != 1 ]]; then
            _cd_prep_err "fetch: a proof ref is honoured only in proof mode"
            return 2
        fi
        if [[ ! "$ref" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$ || "$ref" == *..* || "$ref" == */ || "$ref" == *.lock ]]; then
            _cd_prep_err "fetch: not a branch name"
            return 2
        fi
        tipref="refs/proof/${ref}"
    else
        tipref="refs/heads/main"
    fi
    if ! _cd_prep_mg cat-file -e "${sha}^{commit}" >/dev/null 2>&1; then
        _cd_prep_err "fetch: the commit is not in the mirror"
        return 2
    fi
    if ! _cd_prep_mg rev-parse --verify --quiet "${tipref}^{commit}" >/dev/null 2>&1; then
        _cd_prep_err "fetch: the ref the commit must be reachable from is not in the mirror"
        return 2
    fi
    if ! _cd_prep_mg merge-base --is-ancestor "$sha" "$tipref" >/dev/null 2>&1; then
        _cd_prep_err "fetch: the commit is not reachable from ${tipref}"
        return 2
    fi

    rel="${CD_ROOT}/releases"
    tree="${rel}/${sha12}"
    ( umask 022; mkdir -p "$rel" ) || { _cd_prep_err "fetch: cannot create releases/"; return 2; }
    if [[ -e "$tree" || -L "$tree" ]]; then
        if _cd_prep_tree_ok "$tree" "$sha"; then
            printf '%s\n' "$tree"
            return 0
        fi
        if _cd_prep_tree_in_use "$tree"; then
            _cd_prep_err "fetch: the tree of this commit exists, is not as expected and is in use"
            return 2
        fi
        if [[ -L "$tree" || ! -d "$tree" ]]; then
            _cd_prep_err "fetch: releases/<sha12> is not a directory"
            return 2
        fi
        rm -rf -- "$tree" || { _cd_prep_err "fetch: cannot remove a tree that is not as expected"; return 2; }
    fi
    tmp="${rel}/.fetch-${sha12}.$$"
    rm -rf -- "${rel}/.fetch-${sha12}."* 2>/dev/null || true
    if ! (
        umask 022
        export GIT_TERMINAL_PROMPT=0
        env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE -u GIT_OBJECT_DIRECTORY \
            git clone --quiet --no-checkout -- "$CD_MIRROR_DIR" "$tmp" \
            && env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE -u GIT_OBJECT_DIRECTORY \
                git -C "$tmp" -c advice.detachedHead=false checkout --quiet --detach "$sha"
    ) </dev/null >/dev/null 2>&1; then
        rm -rf -- "$tmp"
        _cd_prep_err "fetch: the clone failed"
        return 4
    fi
    if ! _cd_prep_tree_ok "$tmp" "$sha"; then
        rm -rf -- "$tmp"
        _cd_prep_err "fetch: the new tree is not at the commit or is not clean"
        return 2
    fi
    chmod 755 "$tmp" || { rm -rf -- "$tmp"; _cd_prep_err "fetch: cannot set the mode of the tree"; return 2; }
    mv -T -- "$tmp" "$tree" || { rm -rf -- "$tmp"; _cd_prep_err "fetch: cannot move the tree into place"; return 4; }
    cd_hist fetch_done sha12="$sha12" || true
    printf '%s\n' "$tree"
}

# ==============================================================================
# RETAG
# ==============================================================================

# _cd_prep_with_hostlock CMD ARGS... -- run CMD under the host lock: taken here (waiting
# CD_LOCK_WAIT_S, 3 when it stays busy) and released here, unless this process already
# holds it (the caller's own lock is never dropped).
_cd_prep_with_hostlock() {
    local took=0 rc=0 wait
    wait="$(cd_cfg CD_LOCK_WAIT_S)" || return 2
    if [[ "${CD_HOSTLOCK_PID:-}" != "$$" ]]; then
        cd_hostlock_take "$wait" || {
            rc=$?
            if ((rc == 3)); then _cd_prep_err "the host lock is busy"; fi
            return "$rc"
        }
        took=1
    fi
    "$@" || rc=$?
    if ((took == 1)); then cd_hostlock_release; fi
    return "$rc"
}

# _cd_prep_active_colour -- what runtime/active-colour says, nothing when it is not blue
# or green.
_cd_prep_active_colour() {
    local c=''
    [[ -r "${CD_ROOT}/runtime/active-colour" ]] || return 1
    read -r c <"${CD_ROOT}/runtime/active-colour" || true
    _cd_prep_colour_ok "$c" || return 1
    printf '%s\n' "$c"
}

# _cd_prep_retag_locked TREE COLOUR TAG -- the body of cd_prepare_retag, under the lock.
_cd_prep_retag_locked() {
    local tree="$1" colour="$2" tag="$3" proj envf live_colour live_env live_tag active cids prev saved
    proj="app-${colour}"
    envf="$(cd_envfile "$proj")" || return 2
    if ! _cd_prep_tree_tag "$tree" "$tag"; then
        _cd_prep_err "retag: the tree is not the commit the tag names"
        return 2
    fi
    live_colour="$(cd_state_get '.live.colour // empty')" || return 2
    if ! _cd_prep_colour_ok "$live_colour"; then
        _cd_prep_err "retag: no live colour is recorded"
        return 2
    fi
    if [[ "$colour" == "$live_colour" ]]; then
        _cd_prep_err "retag: the target colour is the live colour"
        return 2
    fi
    active="$(_cd_prep_active_colour)" || {
        _cd_prep_err "retag: the active colour cannot be read"
        return 2
    }
    if [[ "$colour" == "$active" ]]; then
        _cd_prep_err "retag: the target colour is the active colour"
        return 2
    fi
    live_env="$(cd_envfile "app-${live_colour}")" || return 2
    live_tag="$(cd_kv_get "$live_env" IMAGE_TAG)" || {
        _cd_prep_err "retag: the live colour's tag cannot be read"
        return 2
    }
    if [[ "$live_tag" == "$tag" ]]; then
        _cd_prep_err "retag: the live colour already carries this tag"
        return 2
    fi
    cids="$(cd_project_cids "$proj")" || {
        _cd_prep_err "retag: cannot tell whether the target colour is running"
        return 2
    }
    if [[ -n "$cids" ]]; then
        _cd_prep_err "retag: the target colour project is running"
        return 2
    fi
    prev="$(cd_kv_get "$envf" IMAGE_TAG)" || {
        _cd_prep_err "retag: the target env file has no single IMAGE_TAG"
        return 2
    }
    saved="$(cd_state_get '.release.retag_prev // empty')" || return 2
    if [[ "$prev" == "$tag" ]]; then
        # a re-run after a crash: the env already carries the tag, the first run saved the
        # tag it replaced before it edited anything
        if [[ -z "$saved" ]]; then
            _cd_prep_err "retag: the target env already carries the tag and no previous tag was saved"
            return 2
        fi
        prev="$saved"
    fi
    # state first (retag_prev, startable), then the env file: a crash in between leaves a
    # restorable record and an unchanged file, never a changed file with no record
    cd_state_set '(if .release != null then .release.retag_prev = $p else . end)
                  | (if (.previous != null and .previous.colour == $c) then .previous.startable = false else . end)' \
        --arg p "$prev" --arg c "$colour" || {
        _cd_prep_err "retag: the state could not be written"
        return 2
    }
    cd_set_env_key "$envf" IMAGE_TAG "$tag" || {
        _cd_prep_err "retag: the env file could not be changed"
        return 2
    }
    cd_hist retag_done colour="$colour" || true
    printf '%s\n' "$prev"
}

# cd_prepare_retag TREE COLOUR TAG -- IMAGE_TAG in the TARGET colour's env file, nothing
# else, nothing in any other file. Prints the tag it replaced and saves it as
# release.retag_prev; previous.startable becomes false when previous is on that colour
# (its env file no longer names it). Refuses (2) when the tree is not the tag's commit,
# when the target is the live or the active colour, when the live colour's env already
# carries the tag, and when the target project is running. The host lock is held for the
# edit (3 when it stays busy), then released. Safe to run again after a crash.
cd_prepare_retag() {
    local tree="${1:-}" colour="${2:-}" tag="${3:-}"
    if ! _cd_prep_colour_ok "$colour" || ! _cd_prep_tag_ok "$tag" || [[ ! -d "$tree" ]]; then
        _cd_prep_err "retag: usage: TREE blue|green pilot-<sha12>"
        return 2
    fi
    _cd_prep_with_hostlock _cd_prep_retag_locked "$tree" "$colour" "$tag"
}

# _cd_prep_restore_locked -- the body of cd_prepare_retag_restore, under the lock.
_cd_prep_restore_locked() {
    local colour="$1" prev="$2" envf cur live_colour active
    envf="$(cd_envfile "app-${colour}")" || return 2
    live_colour="$(cd_state_get '.live.colour // empty')" || return 2
    active="$(_cd_prep_active_colour)" || active=''
    if [[ "$colour" == "$live_colour" || "$colour" == "$active" ]]; then
        _cd_prep_err "retag restore: the colour is the live or the active one; refusing to touch its env file"
        return 2
    fi
    cur="$(cd_kv_get "$envf" IMAGE_TAG)" || {
        _cd_prep_err "retag restore: the env file has no single IMAGE_TAG"
        return 1
    }
    if [[ "$cur" != "$prev" ]]; then
        cd_set_env_key "$envf" IMAGE_TAG "$prev" || {
            _cd_prep_err "retag restore: the env file could not be restored; previous stays not startable"
            return 1
        }
    fi
    cd_state_set '(if (.previous != null and .previous.colour == $c and .previous.tag == $p)
                   then .previous.startable = true else . end)' \
        --arg p "$prev" --arg c "$colour" || {
        _cd_prep_err "retag restore: the state could not be written"
        return 1
    }
    cd_hist retag_restored colour="$colour" || true
    return 0
}

# cd_prepare_retag_restore -- put release.retag_prev back into the target colour's env file
# and flip previous.startable back to true (only when previous is that colour at that tag).
# Nothing recorded means nothing was retagged: 0 and nothing touched. A second call changes
# nothing. 1 when the env file cannot be restored (startable then stays false).
cd_prepare_retag_restore() {
    local colour prev
    colour="$(cd_state_get '.release.colour // empty')" || return 2
    prev="$(cd_state_get '.release.retag_prev // empty')" || return 2
    if [[ -z "$colour" || -z "$prev" ]]; then
        return 0
    fi
    if ! _cd_prep_colour_ok "$colour" || ! _cd_prep_tag_ok "$prev"; then
        _cd_prep_err "retag restore: the recorded colour or tag is not valid"
        return 1
    fi
    _cd_prep_with_hostlock _cd_prep_restore_locked "$colour" "$prev"
}

# ==============================================================================
# RENDER
# ==============================================================================

# cd_prepare_render TREE COLOUR -- gremion-render from the NEW tree (the live edge file of
# the control panel is left alone: --defer-control-panel), the ipcrypt key hard-linked
# into the tree, a compose config of the target colour that names no unset variable, and a
# tree that is still clean. 2 on any failure; the render's own output goes to a 0600 log
# under logs/ and only its name is reported, an unset variable is reported by NAME.
cd_prepare_render() {
    local tree="${1:-}" colour="${2:-}" proj render log key dst sha12 names st n err why
    if ! _cd_prep_colour_ok "$colour" || [[ ! -d "$tree" ]]; then
        _cd_prep_err "render: usage: TREE blue|green"
        return 2
    fi
    proj="app-${colour}"
    render="${tree}/infra/host/bin/gremion-render"
    if [[ ! -f "$render" || ! -x "$render" ]]; then
        _cd_prep_err "render: the tree has no gremion-render"
        return 2
    fi
    sha12="$(_cd_prep_git "$tree" rev-parse --short=12 HEAD 2>/dev/null)" || sha12=unknown
    log="$(_cd_prep_log_open "cd-render-${sha12}")" || { _cd_prep_err "render: cannot create the log file"; return 2; }
    if ! GREMION_ROOT="$CD_ROOT" "$render" --release "$tree" --defer-control-panel </dev/null >>"$log" 2>&1; then
        _cd_prep_log_keep "$log" || true
        _cd_prep_err "render: gremion-render failed; log kept as ${log##*/}"
        return 2
    fi
    rm -f -- "$log"

    key="${CD_ROOT}/etc/secrets/ipcrypt_key.txt"
    dst="${tree}/secrets/ipcrypt_key.txt"
    if [[ ! -f "$key" || -L "$key" ]]; then
        _cd_prep_err "render: the ipcrypt key is not a regular file after the render"
        return 2
    fi
    mkdir -p "${tree}/secrets" || { _cd_prep_err "render: cannot create secrets/ in the tree"; return 2; }
    if ! ln -f -- "$key" "$dst" 2>/dev/null; then
        _cd_prep_err "render: cannot hard-link the ipcrypt key into the tree"
        return 2
    fi
    if [[ "$(stat -c %i -- "$key")" != "$(stat -c %i -- "$dst")" ]]; then
        _cd_prep_err "render: the ipcrypt key in the tree is not the host's file"
        return 2
    fi

    # compose reports an unset variable as a warning and carries on, so the exit status
    # alone says nothing: read the warnings, report the NAMES. The resolved config
    # (it holds values) is never kept.
    err="$(mktemp 2>/dev/null)" || { _cd_prep_err "render: cannot create a temporary file"; return 2; }
    if ! cd_dc "$tree" "$proj" config --quiet >/dev/null 2>"$err"; then
        # the one line cd_dc itself writes about a refused shape is ours and safe to show;
        # whatever compose says is not (it can quote values)
        why="$(head -n 1 "$err" | tr -cd '[:print:]' | cut -c 1-200)" || why=''
        rm -f -- "$err"
        case "$why" in
            'cd-docker: '*) _cd_prep_err "render: compose config of the ${colour} colour was refused: ${why#cd-docker: }" ;;
            *) _cd_prep_err "render: compose config of the ${colour} colour failed" ;;
        esac
        return 2
    fi
    names="$(sed -n 's/.*The \\\{0,1\}"\([A-Za-z_][A-Za-z0-9_]*\)\\\{0,1\}" variable is not set.*/\1/p' "$err" | sort -u | tr '\n' ' ')" || names=''
    rm -f -- "$err"
    if [[ -n "${names// /}" ]]; then
        _cd_prep_err "render: compose config names unset variables: ${names% }"
        return 2
    fi

    st="$(_cd_prep_git "$tree" status --porcelain 2>/dev/null)" || { _cd_prep_err "render: git cannot read the tree"; return 2; }
    if [[ -n "$st" ]]; then
        n="$(printf '%s\n' "$st" | wc -l | tr -d ' ')"
        _cd_prep_err "render: the tree is not clean after the render (${n} paths)"
        return 2
    fi
    return 0
}

# ==============================================================================
# BUILD
# ==============================================================================

# cd_prepare_classify_build_failure LOGFILE -- prints `infra` when the log matches one of
# CD_PREPARE_INFRA_PATTERNS (outside the lines bash writes about a broken script), else
# `commit`. 2 (nothing printed) when the file cannot be read.
cd_prepare_classify_build_failure() {
    local f="${1:-}" body p
    [[ -n "$f" && -f "$f" && -r "$f" ]] || { _cd_prep_err "classify: no readable log"; return 2; }
    body="$(grep -viE -- "$_CD_PREP_NOT_INFRA" "$f")" || body=''
    for p in "${CD_PREPARE_INFRA_PATTERNS[@]}"; do
        if printf '%s\n' "$body" | grep -qiE -- "$p"; then
            printf 'infra\n'
            return 0
        fi
    done
    printf 'commit\n'
}

# _cd_prep_run_dc SECONDS TREE PROJECT ARGS... -- one compose call through cd_dc, niced
# and with the compose parallelism capped: a subshell lowers its own priority first, so
# the compose it starts inherits it (cd_dc is a function, `nice` cannot wrap it).
_cd_prep_run_dc() {
    local t="$1"
    shift
    (
        if command -v renice >/dev/null 2>&1; then renice -n 10 -p "$BASHPID" >/dev/null 2>&1 || true; fi
        if command -v ionice >/dev/null 2>&1; then ionice -c 3 -p "$BASHPID" >/dev/null 2>&1 || true; fi
        COMPOSE_PARALLEL_LIMIT=2 CD_DC_TIMEOUT="$t" cd_dc "$@"
    )
}

# _cd_prep_live_images PROJECT -- one line per RUNNING container of the project:
# "<container> <image id the container runs> <image id its own tag resolves to now>".
# 2 when docker cannot be asked, when no container runs, or a tag does not resolve.
_cd_prep_live_images() {
    local cids cid line img ref rid
    cids="$(cd_project_cids "$1")" || return 2
    if [[ -z "$cids" ]]; then
        _cd_prep_err "build: the live colour has no running container"
        return 2
    fi
    while IFS= read -r cid; do
        [[ -n "$cid" ]] || continue
        line="$(docker inspect -f '{{.Image}} {{.Config.Image}}' "$cid" </dev/null 2>/dev/null)" || return 2
        read -r img ref <<<"$line" || true
        [[ "$img" =~ ^sha256:[0-9a-f]{64}$ && -n "$ref" ]] || return 2
        rid="$(cd_image_id "$ref" 2>/dev/null)" || return 2
        printf '%s %s %s\n' "$cid" "$img" "$rid"
    done <<<"$cids"
}

# _cd_prep_remaining DEADLINE -- the whole seconds left until the epoch DEADLINE, printed;
# 1 when none are left, 2 when the clock cannot be read.
_cd_prep_remaining() {
    local now left
    now="$(cd_now)" || return 2
    left=$(($1 - now))
    if ((left <= 0)); then return 1; fi
    printf '%s\n' "$left"
}

# cd_prepare_build TREE COLOUR TAG -- build the target colour's images under the NEW tag.
# `pull --ignore-buildable` and `build` of the target project, both through cd_dc (which
# adds the profile star: the one-shot images are profile-gated), niced, compose parallelism
# 2, bounded in total by CD_BUILD_TIMEOUT_MIN. Output goes to a 0600 log under logs/ (kept,
# last 500 lines, on failure) and is never printed. A failure whose log matches an
# infrastructure pattern is retried CD_BUILD_RETRIES times with waits of 60 and 300
# seconds, then returns 4 (no block); any other failure returns 1 at once; the time limit
# returns 3. Post-conditions on the running system: (a) every first-party image of the
# star-computed image list exists under the new tag, one-shots included, and the list has
# the one-shot images at all; (b) every container of the live colour runs the image its own
# tag resolves to, read before and again after the build (a build that moved a live tag
# returns 1). 2 for a precondition (the env file does not carry the tag, docker cannot be
# asked, no live colour).
cd_prepare_build() {
    local tree="${1:-}" colour="${2:-}" tag="${3:-}" proj envf live_colour live_proj envtag
    local refs ref repo found r missing='' before after line cid img rid brid rc kind
    local log attempt=0 retries start deadline remaining secs outoftime=0
    if ! _cd_prep_colour_ok "$colour" || ! _cd_prep_tag_ok "$tag" || [[ ! -d "$tree" ]]; then
        _cd_prep_err "build: usage: TREE blue|green pilot-<sha12>"
        return 2
    fi
    proj="app-${colour}"
    envf="$(cd_envfile "$proj")" || return 2
    if ! _cd_prep_tree_tag "$tree" "$tag"; then
        _cd_prep_err "build: the tree is not the commit the tag names"
        return 2
    fi
    envtag="$(cd_kv_get "$envf" IMAGE_TAG)" || { _cd_prep_err "build: the env file has no single IMAGE_TAG"; return 2; }
    if [[ "$envtag" != "$tag" ]]; then
        _cd_prep_err "build: the target env file does not carry the tag (retag first)"
        return 2
    fi
    live_colour="$(cd_state_get '.live.colour // empty')" || return 2
    if ! _cd_prep_colour_ok "$live_colour" || [[ "$live_colour" == "$colour" ]]; then
        _cd_prep_err "build: no live colour, or the target is the live colour"
        return 2
    fi
    live_proj="app-${live_colour}"

    # the image list, computed with the profile star (cd_dc adds it for `config`)
    refs="$(cd_dc "$tree" "$proj" config --images 2>/dev/null </dev/null)" || {
        _cd_prep_err "build: the image list could not be computed"
        return 2
    }
    refs="$(printf '%s\n' "$refs" | sed -e 's/\r$//' -e '/^[[:space:]]*$/d' | grep -E -- ":${tag}\$" | sort -u)" || refs=''
    if [[ -z "$refs" ]]; then
        _cd_prep_err "build: the image list has no first-party image under the new tag"
        return 2
    fi
    for r in "${_CD_PREP_ONESHOT_REPOS[@]}"; do
        found=0
        while IFS= read -r ref; do
            repo="${ref##*/}"
            [[ "${repo%%:*}" == "$r" ]] && found=1
        done <<<"$refs"
        if ((found == 0)); then
            _cd_prep_err "build: the image list has no ${r} image under the new tag (is the profile star missing?)"
            return 1
        fi
    done

    before="$(_cd_prep_live_images "$live_proj")" || { _cd_prep_err "build: the live colour's images could not be read"; return 2; }
    while read -r cid img rid; do
        if [[ "$img" != "$rid" ]]; then
            _cd_prep_err "build: a live container does not run the image its tag resolves to; refusing to build"
            return 2
        fi
    done <<<"$before"

    log="$(_cd_prep_log_open "cd-build-${tag}")" || { _cd_prep_err "build: cannot create the log file"; return 2; }
    retries="$(cd_cfg CD_BUILD_RETRIES)" || return 2
    start="$(cd_now)" || return 2
    deadline=$((start + 60 * 10#$(cd_cfg CD_BUILD_TIMEOUT_MIN)))
    while :; do
        # each compose call gets what is left of the one limit, so pull plus build cannot
        # run past it
        rc=0
        outoftime=0
        remaining="$(_cd_prep_remaining "$deadline")" || rc=$?
        if ((rc == 2)); then return 2; fi
        if ((rc == 1)); then
            _cd_prep_log_keep "$log" || true
            _cd_prep_err "build: the time limit is used up; log kept as ${log##*/}"
            return 3
        fi
        rc=0
        _cd_prep_run_dc "$remaining" "$tree" "$proj" pull --ignore-buildable >>"$log" 2>&1 || rc=$?
        if ((rc == 0)); then
            remaining="$(_cd_prep_remaining "$deadline")" || outoftime=$?
            if ((outoftime == 2)); then return 2; fi
            if ((outoftime == 0)); then
                _cd_prep_run_dc "$remaining" "$tree" "$proj" build >>"$log" 2>&1 || rc=$?
            fi
        fi
        if ((rc == 0 && outoftime == 0)); then break; fi
        _cd_prep_log_keep "$log" || true
        if ((rc == 124 || rc == 137 || outoftime == 1)); then
            _cd_prep_err "build: the build timed out; log kept as ${log##*/}"
            return 3
        fi
        if ((rc == 2)); then
            _cd_prep_err "build: compose was refused; log kept as ${log##*/}"
            return 2
        fi
        kind="$(cd_prepare_classify_build_failure "$log")" || kind=commit
        if [[ "$kind" == commit ]]; then
            _cd_prep_err "build: the build failed (a failure of the commit); log kept as ${log##*/}"
            cd_hist build_failed kind=commit attempts=$((attempt + 1)) || true
            return 1
        fi
        if ((attempt >= 10#$retries)); then
            _cd_prep_err "build: infrastructure failure after $((attempt + 1)) attempts; log kept as ${log##*/}"
            cd_hist build_failed kind=infra attempts=$((attempt + 1)) || true
            return 4
        fi
        secs=60
        if ((attempt >= 1)); then secs=300; fi
        _cd_prep_err "build: infrastructure failure, retrying in ${secs}s"
        cd_sleep "$secs" || return 2
        attempt=$((attempt + 1))
    done

    # post-condition (a): every first-party image of the list exists under the new tag
    while IFS= read -r ref; do
        [[ -n "$ref" ]] || continue
        rc=0
        cd_image_id "$ref" >/dev/null 2>&1 || rc=$?
        if ((rc == 2)); then
            _cd_prep_log_keep "$log" || true
            _cd_prep_err "build: docker cannot be asked for the built images"
            return 2
        elif ((rc != 0)); then
            missing+=" ${ref##*/}"
        fi
    done <<<"$refs"
    if [[ -n "$missing" ]]; then
        _cd_prep_log_keep "$log" || true
        _cd_prep_err "build: images missing after the build:${missing}; log kept as ${log##*/}"
        return 1
    fi

    # post-condition (b): the live colour is intact
    after="$(_cd_prep_live_images "$live_proj")" || { _cd_prep_err "build: the live colour's images could not be read after the build"; return 2; }
    while read -r cid img rid; do
        if [[ "$img" != "$rid" ]]; then
            _cd_prep_err "build: a live container no longer runs the image its tag resolves to: the build moved a live tag"
            return 1
        fi
        brid="$(printf '%s\n' "$before" | awk -v c="$cid" '$1 == c { print $3 }')"
        if [[ -n "$brid" && "$brid" != "$rid" ]]; then
            _cd_prep_err "build: the build changed the image a live tag resolves to"
            return 1
        fi
    done <<<"$after"
    rm -f -- "$log"
    cd_hist build_done attempts=$((attempt + 1)) seconds=$(($(cd_now) - start)) images="$(printf '%s\n' "$refs" | wc -l | tr -d ' ')" || true
    return 0
}
