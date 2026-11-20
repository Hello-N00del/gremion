#!/usr/bin/env bash
# infra/host/lib/cd/adopt.sh -- adoption, the host manifest, the apply of host programs and
# of the state tier, and the self-test of gremion-cd (unit cd-adopt).
#
#   cd_manifest_write TREE      data/cd/host-manifest.json from the manifest set of a release tree
#   cd_manifest_diff TREE       the manifest-set files of TREE that differ from the manifest
#   cd_adopt_apply_host TREE    the deploy-user side of a host-programs apply: backup, then the
#                               root unit, then (only on success) the manifest
#   cd_adopt_apply_state TREE   the state-tier apply of `release-now --with-state`
#   verbs  cd_cmd_adopt (with --re-adopt --reason TEXT)  cd_cmd_selftest (with --post-apply)
#
# SOURCED, NEVER EXECUTED (see core.sh): no shell options are set here and nothing runs at the
# top level except assignments. A verb is called plainly by the dispatcher (errexit on), a
# stage function as `fn || rc=$?` (errexit off inside it), so every command that can fail
# carries its own `|| return N`.
#
# RETURN CODES. Verbs: 0 ok, 1 an assertion about the running system failed, 2 usage or a
# missing precondition, 3 busy (a lock, or a release in flight). Stage functions: 0 ok, 1 a
# failure attributable to the commit, 2 a precondition or host configuration, 3 waiting,
# 4 an infrastructure failure that may be retried.
#
# THE REAL-DATA BOUNDARY. Output and history carry names of components and checks, counts,
# colours, tags and short SHAs. Never a host name, an address, a customer slug or a path under
# /home. The probe host reaches psql on its stdin and appears nowhere else; the one query that
# maps it to a customer returns a COUNT, never the slug.
#
# DEPENDS ON core.sh, docker.sh, classify.sh (the manifest set is the classifier's own
# listing, so the two can never disagree), colour.sh (cd_colour_identity), prepare.sh (probe
# host, render, build classifier), data.sh (the dump set, the timer guard, the dump directory),
# notify.sh and github.sh. Functions of units that are built later (cd_watch_probe_public,
# cd_traffic_truth) are reached only through `declare -F`: when one is absent the check FAILS,
# it is never skipped.
#
# THE BACKUP LAYOUT (the contract with apply-root.sh, which restores from it):
#   data/cd/host-backup/<UTC time>/        a real directory, mode 0700, holding only
#       bin/<name>                         every regular file of ${ROOT}/bin  (cp -p: mode kept)
#       lib/common.sh                      ${ROOT}/lib/common.sh
#       lib/cd/<name>.sh                   every *.sh of ${ROOT}/lib/cd
#       units/<unit>                       the six gremion-cd unit files of the systemd directory
#   data/cd/host-backup/pending            a symlink to the directory above (absolute target)
# Nothing else: no index, no other library, no other unit. The restore accepts exactly these
# paths and refuses a backup that holds any other (a path outside it ends the apply and no
# host-programs release could ever be applied). It also removes every bin/*, lib/cd/*.sh and
# gremion-cd unit file of the host that the backup does not list, so the backup takes ALL of
# those, and it is refused here, before the root unit starts, when a file the restore needs
# (bin/gremion-cd, lib/common.sh, lib/cd/core.sh, lib/cd/apply-root.sh or one of the six
# units) is not installed.
#
# The jq programs are single-quoted on purpose ($name is jq's own variable syntax).
# shellcheck disable=SC2016

# set by cd_adopt_apply_state for the caller (the driver words the mail with them)
# shellcheck disable=SC2034
CD_ADOPT_STATE_APPLIED=0
# shellcheck disable=SC2034
CD_ADOPT_PREVIOUS_STATE_TAG=''

_cd_ad_err() { printf 'cd-adopt: %s\n' "$*" >&2; }

# _cd_ad_git TREE ARGS... -- git on a work tree: no stdin, none of the caller's GIT_*
# variables, no optional index lock.
_cd_ad_git() {
    local tree="$1"
    shift
    env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE -u GIT_OBJECT_DIRECTORY \
        git -C "$tree" --no-optional-locks "$@" </dev/null
}

# _cd_ad_head TREE -- the full HEAD SHA of a real (not linked) git work tree. 1 when it is
# not one.
_cd_ad_head() {
    local tree="$1" head
    [[ -d "$tree" && ! -L "$tree" && -e "${tree}/.git" ]] || return 1
    head="$(_cd_ad_git "$tree" rev-parse HEAD 2>/dev/null)" || return 1
    [[ "$head" =~ ^[0-9a-f]{40}$ ]] || return 1
    printf '%s\n' "$head"
}

# _cd_ad_tree_clean TREE -- 0 when the work tree has no change (ignored files do not count).
_cd_ad_tree_clean() {
    local st
    st="$(_cd_ad_git "$1" status --porcelain 2>/dev/null)" || return 1
    [[ -z "$st" ]]
}

# _cd_ad_release_tree TREE -- 0 when TREE is ${ROOT}/releases/<sha12> and HEAD starts with
# that <sha12>; prints the sha12. 2 when it is anything else.
_cd_ad_release_tree() {
    local tree="$1" base head
    [[ "$tree" == "${CD_ROOT}/releases/"* ]] || { _cd_ad_err "the tree is not a release tree under the host root"; return 2; }
    base="${tree##*/}"
    [[ "$base" =~ ^[0-9a-f]{12}$ ]] || { _cd_ad_err "the release tree is not named by a short SHA"; return 2; }
    [[ "${tree%/*}" == "${CD_ROOT}/releases" ]] || { _cd_ad_err "the release tree is not directly under releases/"; return 2; }
    head="$(_cd_ad_head "$tree")" || { _cd_ad_err "the release tree is not a git work tree"; return 2; }
    [[ "${head:0:12}" == "$base" ]] || { _cd_ad_err "the release tree's HEAD is not the commit it is named for"; return 2; }
    printf '%s\n' "$base"
}

# ==============================================================================
# THE MANIFEST
# ==============================================================================

# cd_manifest_write TREE -- data/cd/host-manifest.json = {"v":1,"applied_at","sha12","files"}
# for the manifest set of TREE (the listing of classify.sh, so a candidate is compared with
# exactly what is written here). Mode 0600, atomic. A tree with no file in the set is
# refused (1): a manifest of zero files would make every release look like a no-op.
cd_manifest_write() {
    local tree="${1:-}" files head at
    [[ -n "$tree" && -d "$tree" ]] || { _cd_ad_err "manifest: usage: cd_manifest_write TREE"; return 2; }
    declare -F _cd_cls_host_files >/dev/null 2>&1 || { _cd_ad_err "manifest: classify.sh is not loaded"; return 2; }
    head="$(_cd_ad_head "$tree")" || { _cd_ad_err "manifest: the tree is not a git work tree"; return 2; }
    files="$(_cd_cls_host_files "$tree" 2>/dev/null)" || { _cd_ad_err "manifest: the manifest set of the tree cannot be listed"; return 1; }
    if ! printf '%s' "$files" | jq -e 'type == "object" and length > 0 and ([.[] | type == "string"] | all)' >/dev/null 2>&1; then
        _cd_ad_err "manifest: the tree has no file of the manifest set (refusing an empty manifest)"
        return 1
    fi
    at="$(cd_iso)" || return 2
    cd_mkdir "$CD_DATA" || return 2
    jq -cn --arg at "$at" --arg s "${head:0:12}" --argjson f "$files" \
        '{v: 1, applied_at: $at, sha12: $s, files: $f}' | cd_atomic_write "${CD_DATA}/host-manifest.json" 600 \
        || { _cd_ad_err "manifest: the file could not be written"; return 1; }
    return 0
}

# cd_manifest_diff TREE -- the manifest-set files of TREE that differ from the manifest, one
# repo-relative path per line and nothing else on stdout: changed, added and REMOVED files
# (a file the manifest has and the tree has not). Returns 0 when the comparison was made
# (whether or not anything differs), 1 when the tree cannot be listed, 2 when the manifest
# cannot be read; on an error nothing is printed, because `status` counts the lines.
cd_manifest_diff() {
    local tree="${1:-}" manifest="${CD_DATA}/host-manifest.json" files out
    [[ -n "$tree" && -d "$tree" ]] || { _cd_ad_err "manifest diff: usage: cd_manifest_diff TREE"; return 2; }
    declare -F _cd_cls_host_files >/dev/null 2>&1 || { _cd_ad_err "manifest diff: classify.sh is not loaded"; return 2; }
    if [[ ! -f "$manifest" ]] || ! jq -e -s 'length == 1 and (.[0] | .v == 1 and (.files | type) == "object" and ([.files[] | type == "string"] | all))' \
        "$manifest" >/dev/null 2>&1; then
        _cd_ad_err "manifest diff: the host manifest is missing or unreadable"
        return 2
    fi
    files="$(_cd_cls_host_files "$tree" 2>/dev/null)" || { _cd_ad_err "manifest diff: the manifest set of the tree cannot be listed"; return 1; }
    printf '%s' "$files" | jq -e 'type == "object"' >/dev/null 2>&1 || return 1
    out="$(jq -r -n --slurpfile m "$manifest" --argjson f "$files" '
        ($m[0].files) as $a
        | ((($a | keys) + ($f | keys)) | unique)[] as $p
        | select($a[$p] != $f[$p])
        | $p' 2>/dev/null)" || return 1
    [[ -z "$out" ]] || printf '%s\n' "$out" | LC_ALL=C sort
    return 0
}

# ==============================================================================
# ADOPT: READ THE TRUTH OF THE RUNNING SYSTEM
# ==============================================================================

# What _cd_ad_truth fills (nothing is printed; a refusal is one line on stderr):
CD_AD_COLOUR='' CD_AD_TAG='' CD_AD_SHA='' CD_AD_SHA12='' CD_AD_TREE=''
CD_AD_PREV_JSON='null' CD_AD_PREV_NOTE=''

# _cd_ad_env_tag COLOUR -- the IMAGE_TAG of the colour's env file, printed. 2 when the file
# or the key is not usable, or the value is not a release tag.
_cd_ad_env_tag() {
    local f tag
    f="$(cd_envfile "app-${1}")" || return 2
    [[ -f "$f" && -r "$f" ]] || { _cd_ad_err "no readable env file for the ${1} colour"; return 2; }
    tag="$(cd_kv_get "$f" IMAGE_TAG 2>/dev/null)" || { _cd_ad_err "the ${1} env file has no single IMAGE_TAG"; return 2; }
    [[ "$tag" =~ ^pilot-[0-9a-f]{12}$ ]] || { _cd_ad_err "the IMAGE_TAG of the ${1} colour is not a release tag"; return 2; }
    printf '%s\n' "$tag"
}

# _cd_ad_truth -- the live release and the previous one, read from the running system:
#   1. runtime/active-colour names a colour, and (when cd_traffic_truth is installed) Traefik
#      agrees; the answer of an unknown edge is a refusal
#   2. the colour's env tag is a release tag and every first-party container runs the image
#      that tag resolves to (cd_colour_identity)
#   3. releases/<sha12> is a clean git work tree whose HEAD is that tag's commit
#   4. the `current` link points at that very tree
#   5. the public /readyz answers ready through the real edge (cd_watch_probe_public)
#   6. the other colour's env tag, and whether its tree is there with the same HEAD (then
#      `previous` is startable; otherwise it is null and CD_AD_PREV_NOTE says so)
# 0 filled; 1 the system is not as it must be; 2 a precondition is missing or cannot be read.
_cd_ad_truth() {
    local f act tag tree head cur want other otag otree ohead rc=0 out=''
    CD_AD_COLOUR='' CD_AD_TAG='' CD_AD_SHA='' CD_AD_SHA12='' CD_AD_TREE=''
    CD_AD_PREV_JSON='null' CD_AD_PREV_NOTE=''
    f="${CD_ROOT}/runtime/active-colour"
    [[ -f "$f" && -r "$f" ]] || { _cd_ad_err "runtime/active-colour is not readable"; return 2; }
    act="$(head -n 1 -- "$f" 2>/dev/null)" || act=''
    act="${act%$'\r'}"
    case "$act" in
        blue | green) ;;
        *) _cd_ad_err "runtime/active-colour names neither colour"; return 2 ;;
    esac

    if ! declare -F cd_traffic_truth >/dev/null 2>&1; then
        _cd_ad_err "the traffic truth cannot be read (traffic.sh is not installed)"
        return 2
    fi
    out="$(cd_traffic_truth 2>/dev/null </dev/null)" || rc=$?
    if ((rc != 0)); then
        _cd_ad_err "the active-colour file and the edge disagree, or the edge does not answer"
        return 1
    fi
    if [[ "$out" == blue || "$out" == green ]] && [[ "$out" != "$act" ]]; then
        _cd_ad_err "the edge routes to the other colour than runtime/active-colour names"
        return 1
    fi

    tag="$(_cd_ad_env_tag "$act")" || return 2
    declare -F cd_colour_identity >/dev/null 2>&1 || { _cd_ad_err "colour.sh is not installed"; return 2; }
    rc=0
    cd_colour_identity "$act" "$tag" >/dev/null 2>&1 </dev/null || rc=$?
    if ((rc == 1)); then
        _cd_ad_err "a container of the ${act} colour does not run the image its env tag resolves to"
        return 1
    elif ((rc != 0)); then
        _cd_ad_err "the images of the ${act} colour cannot be proven (docker did not answer or the install is not a host-build one)"
        return 2
    fi

    tree="${CD_ROOT}/releases/${tag#pilot-}"
    if [[ ! -d "$tree" || -L "$tree" ]]; then
        _cd_ad_err "the release tree of the live tag is not there"
        return 1
    fi
    head="$(_cd_ad_head "$tree")" || { _cd_ad_err "the release tree of the live tag is not a git work tree"; return 1; }
    if [[ "${head:0:12}" != "${tag#pilot-}" ]]; then
        _cd_ad_err "the release tree's HEAD is not the commit of the live tag"
        return 1
    fi
    if ! _cd_ad_tree_clean "$tree"; then
        _cd_ad_err "the release tree has changes (it must be a clean checkout of its commit)"
        return 1
    fi
    cur="$(readlink -f -- "${CD_ROOT}/current" 2>/dev/null)" || cur=''
    want="$(readlink -f -- "$tree" 2>/dev/null)" || want=''
    if [[ -z "$cur" || -z "$want" || "$cur" != "$want" ]]; then
        _cd_ad_err "the current link is not the tree of the live tag"
        return 1
    fi

    if ! declare -F cd_watch_probe_public >/dev/null 2>&1; then
        _cd_ad_err "the public probe is not installed (watch.sh)"
        return 2
    fi
    if ! cd_watch_probe_public >/dev/null 2>&1 </dev/null; then
        _cd_ad_err "the public /readyz is not ready through the edge"
        return 1
    fi

    CD_AD_COLOUR="$act" CD_AD_TAG="$tag" CD_AD_SHA="$head" CD_AD_SHA12="${head:0:12}" CD_AD_TREE="$tree"

    other="$(cd_colour_other "$act")" || return 2
    if otag="$(_cd_ad_env_tag "$other" 2>/dev/null)"; then
        otree="${CD_ROOT}/releases/${otag#pilot-}"
        if ohead="$(_cd_ad_head "$otree")" && [[ "${ohead:0:12}" == "${otag#pilot-}" ]]; then
            CD_AD_PREV_JSON="$(jq -cn --arg s "$ohead" --arg t "$otag" --arg c "$other" --arg p "$otree" \
                '{sha: $s, sha12: $s[0:12], tag: $t, colour: $c, tree: $p, startable: true}')" || return 2
        else
            CD_AD_PREV_NOTE="the ${other} colour names a tag whose release tree is missing or differs: no rollback target is recorded"
        fi
    else
        CD_AD_PREV_NOTE="the ${other} colour's env file names no release tag: no rollback target is recorded"
    fi
    return 0
}

# _cd_ad_live_json -- the `live` object of the schema from the CD_AD_* variables.
_cd_ad_live_json() {
    local at
    at="$(cd_iso)" || return 2
    jq -cn --arg s "$CD_AD_SHA" --arg t "$CD_AD_TAG" --arg c "$CD_AD_COLOUR" --arg p "$CD_AD_TREE" --arg at "$at" \
        '{sha: $s, sha12: $s[0:12], tag: $t, colour: $c, tree: $p, since: $at, proof: false,
          modules: null, leaves: null, reconcile: null}'
}

# ==============================================================================
# THE VERB: adopt
# ==============================================================================

# cd_cmd_adopt [--re-adopt --reason TEXT]
#   adopt: the first adoption. Refuses, before anything is written, on any mismatch of the
#   running system (see _cd_ad_truth), on a repository without the ruleset, and when the state
#   file already exists.
#   --re-adopt: the way back to a true state after a hand upgrade or any other hand
#   intervention. It needs a state file, `phase` idle or parked and a reason; it rewrites
#   `live`, `previous` and the manifest from the running system and clears NOTHING else:
#   hold, blocks, history, the notified map and a running release record stay as they are.
cd_cmd_adopt() {
    local re=0 reason='' rc=0 live prev phase mode prev12 prev_colour
    while (($# > 0)); do
        case "$1" in
            --re-adopt) re=1; shift ;;
            --reason)
                (($# >= 2)) || cd_die 2 "adopt: --reason needs a value"
                reason="$2"
                shift 2
                ;;
            *) cd_die 2 "adopt: unknown argument (usage: gremion-cd adopt [--re-adopt --reason TEXT])" ;;
        esac
    done
    if ((re == 0)) && [[ -n "$reason" ]]; then
        cd_die 2 "adopt: --reason belongs to --re-adopt"
    fi
    if ((re == 1)); then
        [[ -n "$reason" ]] || cd_die 2 "adopt: --re-adopt needs --reason TEXT (it is logged and mailed)"
        cd_arg_reason "$reason"
    fi
    rc=0
    cd_lock_take || rc=$?
    ((rc == 0)) || cd_die "$rc" "adopt: the cd lock is held by another gremion-cd (a release or another adopt); try again later"

    mode=first
    if ((re == 1)); then
        mode=re
        [[ -f "$CD_STATE_FILE" ]] || cd_die 2 "adopt: there is no state file to re-adopt (run gremion-cd adopt first)"
        phase="$(cd_state_get '.phase')" || cd_die 2 "adopt: the state cannot be read"
        case "$phase" in
            idle | parked) ;;
            *) cd_die 3 "adopt: a release is in flight (phase ${phase}); re-adopt when it has ended" ;;
        esac
    else
        if [[ -e "$CD_STATE_FILE" || -L "$CD_STATE_FILE" ]]; then
            cd_die 2 "adopt: already adopted (a state file exists); after a hand intervention use: gremion-cd adopt --re-adopt --reason TEXT"
        fi
    fi

    rc=0
    _cd_ad_truth || rc=$?
    ((rc == 0)) || cd_die "$rc" "adopt: refused; nothing was written"

    if [[ "$mode" == first ]]; then
        # the repository rules are a precondition of every pick-up. A RE-adopt does not ask
        # GitHub: it re-reads the host, and the host must stay recoverable while the network is
        # down; the self-test checks the rules.
        rc=0
        cd_gh_rules_ok >/dev/null 2>&1 </dev/null || rc=$?
        ((rc == 0)) || cd_die 1 "adopt: the repository rules of main are not in force (or cannot be read); nothing was written"
        rc=0
        cd_gh_merge_methods_ok >/dev/null 2>&1 </dev/null || rc=$?
        ((rc == 0)) || cd_die 1 "adopt: the merge methods of the repository are not squash only; nothing was written"
    fi

    # every refusal is behind us: from here on the writes. The manifest first (a failure
    # leaves no state file, so a retry is a clean first adopt); then the state in two steps
    # whose half-done end (a state without `live`) is exactly what --re-adopt repairs.
    cd_manifest_write "$CD_AD_TREE" || cd_die 1 "adopt: the host manifest could not be written"
    live="$(_cd_ad_live_json)" || cd_die 2 "adopt: the clock cannot be read"
    prev="$CD_AD_PREV_JSON"
    if [[ "$mode" == first ]]; then
        cd_state_init || cd_die 1 "adopt: the state file could not be created"
        cd_state_set '.live = $l | .previous = $p' --argjson l "$live" --argjson p "$prev" \
            || cd_die 1 "adopt: the state could not be written (run: gremion-cd adopt --re-adopt --reason TEXT)"
        cd_hist adopted mode=first sha12="$CD_AD_SHA12" colour="$CD_AD_COLOUR" || true
    else
        # the same release keeps what the record learned about it (counts, since)
        cd_state_set '.live = (if .live != null and .live.sha == $l.sha
                               then (.live + {colour: $l.colour, tag: $l.tag, tree: $l.tree})
                               else $l end)
                      | .previous = $p' --argjson l "$live" --argjson p "$prev" \
            || cd_die 1 "adopt: the state could not be written"
        cd_hist adopted mode=re sha12="$CD_AD_SHA12" colour="$CD_AD_COLOUR" reason="$reason" || true
    fi
    prev12="$(printf '%s' "$prev" | jq -r '.sha12 // "none"')"
    prev_colour="$(printf '%s' "$prev" | jq -r '.colour // empty')"
    if [[ -n "$prev_colour" ]]; then
        cd_notify adopted sha12="$CD_AD_SHA12" prev_sha12="$prev12" colour="$CD_AD_COLOUR" \
            reason="$([[ "$mode" == re ]] && echo re_adopt || echo first_adopt)" command="gremion-cd status"
    else
        cd_notify adopted sha12="$CD_AD_SHA12" colour="$CD_AD_COLOUR" \
            reason="$([[ "$mode" == re ]] && echo re_adopt || echo first_adopt)" command="gremion-cd status"
    fi
    if [[ "$mode" == re ]]; then
        cd_info "re-adopted: live ${CD_AD_TAG} on ${CD_AD_COLOUR}; hold, blocks and history are untouched"
    else
        cd_info "adopted: live ${CD_AD_TAG} on ${CD_AD_COLOUR}"
    fi
    if [[ -n "$prev_colour" ]]; then
        cd_info "previous: $(printf '%s' "$prev" | jq -r '.tag') on ${prev_colour} (startable)"
    else
        cd_info "previous: none (${CD_AD_PREV_NOTE})"
    fi
    return 0
}

# ==============================================================================
# APPLY OF HOST PROGRAMS (the deploy-user side)
# ==============================================================================

# _cd_ad_systemd_dir -- the directory the units are installed into. A test may point it
# elsewhere, and only under GREMION_CD_TESTING=1.
_cd_ad_systemd_dir() {
    if [[ "${GREMION_CD_TESTING:-}" == 1 && -n "${GREMION_CD_SYSTEMD_DIR:-}" ]]; then
        printf '%s\n' "$GREMION_CD_SYSTEMD_DIR"
    else
        printf '%s\n' /etc/systemd/system
    fi
}

# the six unit files of the cd program, and the files the root restore needs in any backup
_CD_AD_UNITS=(gremion-cd.service gremion-cd.timer gremion-cd-watchdog.service gremion-cd-watchdog.timer
    gremion-cd-resume.service 'gremion-cd-apply@.service')
_CD_AD_NEEDED=(bin/gremion-cd lib/common.sh lib/cd/core.sh lib/cd/apply-root.sh)

# _cd_ad_backup_set DIR -- copy the installed set into DIR (layout in the header). 1 on any
# failure: a backup that is not whole is no backup.
_cd_ad_backup_set() {
    local dir="$1" sysd f u rel
    sysd="$(_cd_ad_systemd_dir)"
    # the directory tree is made here, once and by name: a path is never derived from a
    # file name (a file directly under lib/ has no directory part to strip)
    ( umask 077; mkdir -p -- "${dir}/bin" "${dir}/lib/cd" "${dir}/units" ) || return 1
    # plain globs, no find: an unreadable directory is a copy failure below, never a
    # silently partial backup
    for f in "${CD_ROOT}/bin"/*; do
        [[ -f "$f" ]] || continue
        cp -p -- "$f" "${dir}/bin/${f##*/}" || return 1
    done
    if [[ -f "${CD_ROOT}/lib/common.sh" ]]; then
        cp -p -- "${CD_ROOT}/lib/common.sh" "${dir}/lib/common.sh" || return 1
    fi
    for f in "${CD_ROOT}/lib/cd"/*.sh; do
        [[ -f "$f" ]] || continue
        cp -p -- "$f" "${dir}/lib/cd/${f##*/}" || return 1
    done
    for u in "${_CD_AD_UNITS[@]}"; do
        [[ -f "${sysd}/${u}" ]] || continue
        cp -p -- "${sysd}/${u}" "${dir}/units/${u}" || return 1
    done
    # what the root restore cannot do without: a backup without it would empty the host
    for rel in "${_CD_AD_NEEDED[@]}"; do
        if [[ ! -f "${dir}/${rel}" ]]; then
            _cd_ad_err "the installed set has no ${rel} (run: bash infra/host/bootstrap.sh cd); a backup without it cannot restore the host"
            return 1
        fi
    done
    for u in "${_CD_AD_UNITS[@]}"; do
        if [[ ! -f "${dir}/units/${u}" ]]; then
            _cd_ad_err "the installed set has no units/${u} (run: bash infra/host/bootstrap.sh cd); a backup without it cannot restore the host"
            return 1
        fi
    done
    return 0
}

# cd_adopt_apply_host TREE -- the deploy-user side of the apply of host programs. TREE is
# releases/<sha12>. The caller holds the cd lock and the host lock (release-now does). In
# order: refuse a backup place that is not ours; copy the installed set to
# data/cd/host-backup/<time>/ and point `pending` at it; run the root unit as
#   sudo -n systemctl start --wait gremion-cd-apply@<sha12>.service
# (nothing here writes /etc: the unit does, as root, and restores the backup itself on any
# failure); and only when the unit exited 0 write the manifest. 0 applied; 1 the apply (or
# the backup) failed, manifest untouched; 2 a refusal before anything was touched.
cd_adopt_apply_host() {
    local tree="${1:-}" sha12 hb pend target real stamp dir n=0 rc=0
    [[ -n "$tree" ]] || { _cd_ad_err "apply-host: usage: cd_adopt_apply_host TREE"; return 2; }
    cd_require_lock "the host apply" || return 2
    if [[ "${CD_HOSTLOCK_PID:-}" != "$$" ]]; then
        _cd_ad_err "apply-host: refusing without the host lock"
        return 2
    fi
    sha12="$(_cd_ad_release_tree "$tree")" || return 2
    [[ "$sha12" =~ ^[0-9a-f]{12}$ ]] || return 2

    hb="${CD_DATA}/host-backup"
    pend="${hb}/pending"
    if [[ -L "$hb" ]]; then
        _cd_ad_err "apply-host: host-backup is a symlink; refusing"
        return 2
    fi
    cd_mkdir "$hb" || return 2
    if [[ ! -d "$hb" || "$(stat -c '%a' -- "$hb")" != 700 || "$(stat -c '%u' -- "$hb")" != "$(id -u)" ]]; then
        _cd_ad_err "apply-host: host-backup is not a directory of mode 700 owned by the deploy user"
        return 2
    fi
    real="$(cd "$hb" && pwd -P)" || return 2
    if [[ -e "$pend" || -L "$pend" ]]; then
        if [[ ! -L "$pend" ]]; then
            _cd_ad_err "apply-host: pending is not a symlink; refusing"
            return 2
        fi
        target="$(readlink -f -- "$pend" 2>/dev/null)" || target=''
        if [[ -z "$target" || "$target" != "${real}/"* ]]; then
            _cd_ad_err "apply-host: pending points outside data/cd/host-backup; refusing"
            return 2
        fi
    fi

    stamp="$(date -u -d "@$(cd_now)" +%Y%m%dT%H%M%SZ)" || return 2
    dir="${hb}/${stamp}"
    while [[ -e "$dir" || -L "$dir" ]]; do
        n=$((n + 1))
        dir="${hb}/${stamp}-${n}"
    done
    ( umask 077; mkdir -- "$dir" ) || { _cd_ad_err "apply-host: the backup directory cannot be created"; return 1; }
    if ! _cd_ad_backup_set "$dir"; then
        rm -rf -- "$dir"
        _cd_ad_err "apply-host: the installed set could not be backed up; nothing was applied"
        return 1
    fi
    if ! ln -s -- "$dir" "${pend}.new.$$" || ! mv -f -T -- "${pend}.new.$$" "$pend"; then
        rm -f -- "${pend}.new.$$"
        _cd_ad_err "apply-host: the pending link could not be set"
        return 1
    fi
    cd_hist host_backup_taken sha12="$sha12" || true

    sudo -n systemctl start --wait "gremion-cd-apply@${sha12}.service" </dev/null >/dev/null 2>&1 || rc=$?
    if ((rc != 0)); then
        cd_hist host_apply_failed sha12="$sha12" || true
        _cd_ad_err "apply-host: the apply unit failed (exit ${rc}); it restores the backup itself; the manifest is unchanged"
        return 1
    fi
    cd_manifest_write "$tree" || { _cd_ad_err "apply-host: the apply passed but the manifest could not be written"; return 1; }
    cd_hist host_applied sha12="$sha12" || true
    return 0
}

# ==============================================================================
# APPLY OF THE STATE TIER
# ==============================================================================

# _cd_ad_log NAME -- a fresh 0600 file logs/NAME.log, its path printed. Nothing a child says
# reaches stdout: it names databases and secret file names.
_cd_ad_log() {
    local d="${CD_ROOT}/logs" f
    if [[ ! -d "$d" ]]; then
        mkdir -p "$d" && chmod 700 "$d" || return 1
    fi
    f="${d}/${1}.log"
    ( umask 077; : >"$f" ) || return 1
    chmod 600 "$f" || return 1
    printf '%s\n' "$f"
}

# cd_adopt_apply_state TREE -- the state-tier effects of `release-now <sha12> --with-state`:
#   1. refuse a tree whose class holds unsupported_chain, contract_migration,
#      waived_migration or classify_failed (ANY entry of `holds`, not only the first)
#   2. the state-scope dump set under the label state-<tag> (the Keycloak database included,
#      a module server never), BEFORE anything changes
#   3. the previous state tag to data/cd/previous-state-tag, then the retag of state.env
#   4. the state image build, the render
#   5. `gremion-tenant init` only when the class has platform_migration, with
#      GREMION_HOST_LOCK_HELD=1 (the child would exit 3 on the lock this process holds)
#   6. `compose up -d --pull never` for the state project, healthy, and the edge answering
# The state tier is NOT rolled back automatically (the previous tag is kept for a hand
# restore). data/cd/state-apply-pending is written with the retag and removed only when the
# apply reached its end: while it exists state.env names a tag that may never have run, and
# the next apply of ANY release keeps previous-state-tag instead of recording that tag.
# A failed apply leaves state.env retagged and no images built until a retry or a hand restore
# (a compose up of the state project by another tool before then fails on the missing tag). Needs the cd lock and the host lock. 0 applied; 1 attributable to the commit;
# 2 a refusal or precondition (nothing changed); 4 an infrastructure failure.
cd_adopt_apply_state() {
    local tree="${1:-}" sha12 tag live_tree live_colour cls kinds envf prev rc=0 log initlog retry=0
    local step callstart kind livetag active pendingf pending=0
    CD_ADOPT_STATE_APPLIED=0
    CD_ADOPT_PREVIOUS_STATE_TAG=''
    [[ -n "$tree" ]] || { _cd_ad_err "apply-state: usage: cd_adopt_apply_state TREE"; return 2; }
    cd_require_lock "the state apply" || return 2
    if [[ "${CD_HOSTLOCK_PID:-}" != "$$" ]]; then
        _cd_ad_err "apply-state: refusing without the host lock"
        return 2
    fi
    sha12="$(_cd_ad_release_tree "$tree")" || return 2
    tag="pilot-${sha12}"
    live_tree="$(cd_state_get '.live.tree // empty')" || return 2
    live_colour="$(cd_state_get '.live.colour // empty')" || return 2
    [[ -n "$live_tree" && -d "$live_tree" && ( "$live_colour" == blue || "$live_colour" == green ) ]] \
        || { _cd_ad_err "apply-state: no live release is recorded"; return 2; }
    declare -F cd_classify >/dev/null 2>&1 || { _cd_ad_err "apply-state: classify.sh is not installed"; return 2; }
    cls="$(cd_classify "$live_tree" "$tree" 2>/dev/null </dev/null)" || { _cd_ad_err "apply-state: the tree cannot be classified"; return 2; }
    if ! printf '%s' "$cls" | jq -e 'type == "object" and (.holds | type == "array") and (.state_tier | type == "array")' >/dev/null 2>&1; then
        _cd_ad_err "apply-state: the class is not the document the classifier prints"
        return 2
    fi
    kinds="$(printf '%s' "$cls" | jq -r '[.holds[].kind] | map(select(. == "unsupported_chain" or . == "contract_migration" or . == "waived_migration" or . == "classify_failed")) | unique | join(",")')" || return 2
    if [[ -n "$kinds" ]]; then
        _cd_ad_err "apply-state: refused: the release carries a hold that stage 1 cannot apply (${kinds}); a hand upgrade, then: gremion-cd adopt --re-adopt --reason TEXT"
        return 2
    fi

    # the platform step of the state tier is `gremion-tenant init`, which runs the one-shot of
    # the ACTIVE colour: from the image its env file names. When that image is not this
    # release's, the step would run the old release's migrations and the apply would report
    # a success for work that never ran. Refused before anything changes.
    if printf '%s' "$cls" | jq -e '.state_tier | index("platform_migration") != null' >/dev/null 2>&1; then
        active=''
        if [[ -f "${CD_ROOT}/runtime/active-colour" && ! -L "${CD_ROOT}/runtime/active-colour" ]]; then
            active="$(tr -d '[:space:]' <"${CD_ROOT}/runtime/active-colour" 2>/dev/null)" || active=''
        fi
        livetag=''
        if [[ "$active" == blue || "$active" == green ]]; then
            livetag="$(cd_kv_get "$(cd_envfile "app-${active}" 2>/dev/null)" IMAGE_TAG 2>/dev/null)" || livetag=''
        fi
        if [[ "$livetag" != "$tag" ]]; then
            _cd_ad_err "apply-state: refused: the release carries a platform migration (platform_migration) and the platform step runs from the image of the active colour (${livetag:-unknown}), not from this release (${tag}); nothing was changed. Apply it by hand, then: gremion-cd adopt --re-adopt --reason TEXT"
            return 2
        fi
    fi

    envf="$(cd_envfile state)" || return 2
    prev="$(cd_kv_get "$envf" IMAGE_TAG 2>/dev/null)" || { _cd_ad_err "apply-state: state.env has no single IMAGE_TAG"; return 2; }
    [[ "$prev" =~ ^[A-Za-z0-9._-]{1,128}$ ]] || { _cd_ad_err "apply-state: the IMAGE_TAG of state.env is not usable"; return 2; }
    pendingf="${CD_DATA}/state-apply-pending"
    if [[ -e "$pendingf" || -L "$pendingf" ]]; then
        pending=1
    fi
    if [[ "$prev" == "$tag" || "$pending" == 1 ]]; then
        # a retry after an apply that did not finish: state.env already names the tag of that
        # try, which may never have run (a failed pull or build leaves it retagged), so it is
        # NOT the tag to go back to, whichever release is applied now. The tag to go back to is
        # the one recorded before that try; recording state.env's tag over it would lose the
        # only way back. Without a record there is nothing to go back to: refuse.
        if [[ -f "${CD_DATA}/previous-state-tag" && ! -L "${CD_DATA}/previous-state-tag" ]]; then
            prev="$(head -n 1 -- "${CD_DATA}/previous-state-tag" 2>/dev/null)" || prev=''
        else
            prev=''
        fi
        if [[ ! "$prev" =~ ^[A-Za-z0-9._-]{1,128}$ ]] || [[ "$pending" != 1 && "$prev" == "$tag" ]]; then
            _cd_ad_err "apply-state: state.env carries a tag that may not have run and there is no record of the tag before it; restore state.env by hand first"
            return 2
        fi
        retry=1
    fi
    declare -F cd_data_dumpset_take >/dev/null 2>&1 || { _cd_ad_err "apply-state: data.sh is not installed"; return 2; }

    # 2. the dump set first: a state apply that fails half way has a restore point
    rc=0
    cd_data_dumpset_take "state-${tag}" state </dev/null || rc=$?
    if ((rc != 0)); then
        _cd_ad_err "apply-state: the state dump set was not taken (code ${rc}); nothing was changed"
        ((rc == 4)) && return 4
        return 2
    fi

    # 3. the record of what to restore, then the change
    cd_mkdir "$CD_DATA" || return 2
    if ((retry == 0)); then
        printf '%s\n' "$prev" | cd_atomic_write "${CD_DATA}/previous-state-tag" 600 \
            || { _cd_ad_err "apply-state: the previous state tag could not be recorded; nothing was changed"; return 2; }
    fi
    CD_ADOPT_PREVIOUS_STATE_TAG="$prev"
    # the apply is open from here until it reaches the end: while this file exists the tag in
    # state.env is not known to have run, so the record above is never replaced
    printf '%s\n' "$tag" | cd_atomic_write "$pendingf" 600 \
        || { _cd_ad_err "apply-state: the open-apply marker could not be written; nothing was changed"; return 2; }
    cd_set_env_key "$envf" IMAGE_TAG "$tag" || { _cd_ad_err "apply-state: state.env could not be retagged"; return 2; }
    cd_hist state_retagged sha12="$sha12" || true

    # 4. pull, build and render. The pull fetches every image of the state project that has no
    # build section (database, login server, edge, ...): a digest that moved with the release
    # is not on the host yet, and `up --pull never` below would stop on it. The build makes
    # the project's own images. One log, one failing call classified from its own output.
    log="$(_cd_ad_log "cd-state-build-${sha12}")" || { _cd_ad_err "apply-state: cannot create the log file"; return 2; }
    for step in pull build; do
        callstart="$(wc -c <"$log" 2>/dev/null | tr -d ' ')" || callstart=0
        [[ "$callstart" =~ ^[0-9]+$ ]] || callstart=0
        rc=0
        if [[ "$step" == pull ]]; then
            CD_DC_TIMEOUT="$(( 10#$(cd_cfg CD_BUILD_TIMEOUT_MIN) * 60 ))" cd_dc "$tree" state pull --ignore-buildable >>"$log" 2>&1 </dev/null || rc=$?
        else
            CD_DC_TIMEOUT="$(( 10#$(cd_cfg CD_BUILD_TIMEOUT_MIN) * 60 ))" cd_dc "$tree" state build >>"$log" 2>&1 </dev/null || rc=$?
        fi
        if ((rc != 0)); then
            kind=commit
            if declare -F cd_prepare_classify_build_failure >/dev/null 2>&1; then
                kind="$(cd_prepare_classify_build_failure "$log" "$callstart" "${_CD_PREP_CLASSIFY_TAIL:-40}" 2>/dev/null)" || kind=commit
            fi
            if tail -n 500 -- "$log" >"${log}.tmp" 2>/dev/null; then
                mv -f -- "${log}.tmp" "$log" 2>/dev/null || true
                chmod 600 "$log" 2>/dev/null || true
            fi
            _cd_ad_err "apply-state: the state image ${step} failed (exit ${rc}); log kept as ${log##*/}"
            ((rc == 124 || rc == 137)) && return 4
            [[ "$kind" == infra ]] && return 4
            return 1
        fi
    done
    rm -f -- "$log"
    declare -F cd_prepare_render >/dev/null 2>&1 || { _cd_ad_err "apply-state: prepare.sh is not installed"; return 2; }
    rc=0
    cd_prepare_render "$tree" "$live_colour" </dev/null || rc=$?
    ((rc == 0)) || { _cd_ad_err "apply-state: the render failed"; return 2; }

    # 5. the platform migration of the state tier. gremion-tenant is run from the tree being
    # deployed (its ../lib neighbours must match it) and GREMION_RELEASE_DIR names that tree,
    # because stage 1 runs compose from the tree being deployed and never from `current`,
    # which moves only at the commit point. The one-shot starts from the active colour's env
    # file, whose image tag was checked to be this release's before anything changed.
    if printf '%s' "$cls" | jq -e '.state_tier | index("platform_migration") != null' >/dev/null 2>&1; then
        initlog="$(_cd_ad_log "cd-state-init-${sha12}")" || { _cd_ad_err "apply-state: cannot create the log file"; return 2; }
        rc=0
        GREMION_ROOT="$CD_ROOT" GREMION_HOST_LOCK_HELD=1 GREMION_RELEASE_DIR="$tree" \
            "${tree}/infra/host/bin/gremion-tenant" init </dev/null >>"$initlog" 2>&1 || rc=$?
        if ((rc != 0)); then
            _cd_ad_err "apply-state: gremion-tenant init failed (exit ${rc}); log kept as ${initlog##*/}"
            return 1
        fi
        rm -f -- "$initlog"
    fi

    # 6. up, healthy, the edge
    rc=0
    cd_dc "$tree" state up -d --pull never </dev/null >/dev/null 2>&1 || rc=$?
    if ((rc != 0)); then
        _cd_ad_err "apply-state: compose up of the state project failed (exit ${rc})"
        ((rc == 124 || rc == 137)) && return 4
        return 1
    fi
    rc=0
    cd_wait_healthy state 300 "$tree" || rc=$?
    if ((rc != 0)); then
        _cd_ad_err "apply-state: the state project is not healthy after the apply:${CD_WAIT_BAD:-}"
        return 1
    fi
    if ! declare -F cd_watch_probe_public >/dev/null 2>&1 || ! cd_watch_probe_public >/dev/null 2>&1 </dev/null; then
        _cd_ad_err "apply-state: the edge does not answer ready after the state apply"
        return 1
    fi
    CD_ADOPT_STATE_APPLIED=1
    rm -f -- "$pendingf" 2>/dev/null || _cd_ad_err "apply-state: the open-apply marker could not be removed; remove state-apply-pending by hand"
    cd_hist state_applied sha12="$sha12" || true
    cd_info "state tier applied for ${tag}; it is NOT rolled back automatically (the previous state tag is kept in data/cd/previous-state-tag)"
    return 0
}

# ==============================================================================
# SELF-TEST
# ==============================================================================

CD_ST_FAILS=()
CD_ST_WARNS=()
CD_ST_FIRST_FAIL=''

_cd_st_ok() { cd_info "ok    $1"; }
_cd_st_warn() {
    CD_ST_WARNS+=("$1")
    cd_info "warn  $1: $2"
}
_cd_st_fail() {
    CD_ST_FAILS+=("$1")
    [[ -n "$CD_ST_FIRST_FAIL" ]] || CD_ST_FIRST_FAIL="$1"
    cd_info "FAIL  $1: $2"
}

# _cd_st_lockfile_free FILE -- 0 when no process holds the lock on FILE, 1 when one does.
# The probe takes the lock on a spare descriptor of a subshell and lets it go at once.
_cd_st_lockfile_free() {
    local f="$1"
    [[ -e "$f" ]] || return 0
    ( exec 7>>"$f" && flock -n 7 ) 2>/dev/null </dev/null
}

# _cd_st_check_locks POST_APPLY -- plain: both locks are free. --post-apply: both ARE held (by
# release-now, which started the apply); a plain self-test inside an apply would find them
# held and fail, and every apply would restore the backup.
_cd_st_check_locks() {
    local post="$1" cd_free=0 host_free=0
    command -v flock >/dev/null 2>&1 || { _cd_st_fail locks "flock is not installed"; return 0; }
    _cd_st_lockfile_free "${CD_RUN}/cd.lock" && cd_free=1
    _cd_st_lockfile_free "${CD_ROOT}/runtime/hostd.lock" && host_free=1
    if [[ "$post" == 1 ]]; then
        if ((cd_free == 0 && host_free == 0)); then
            _cd_st_ok locks
        else
            _cd_st_fail locks "post-apply: the cd lock and the host lock must both be held by the caller"
        fi
    else
        if ((cd_free == 1 && host_free == 1)); then
            _cd_st_ok locks
        elif ((cd_free == 0)); then
            _cd_st_fail locks "the cd lock is held"
        else
            _cd_st_fail locks "the host lock is held"
        fi
    fi
}

# _cd_st_free_gb PATH -- whole gigabytes free on the file system of PATH.
_cd_st_free_gb() {
    local kb
    kb="$(df -Pk -- "$1" 2>/dev/null </dev/null | awk 'NR == 2 { print $4 }')" || return 1
    [[ "$kb" =~ ^[0-9]+$ ]] || return 1
    printf '%s\n' "$((kb / 1048576))"
}

_cd_st_check_disk() {
    local min a b droot
    min="$(cd_cfg CD_MIN_FREE_GB)" || { _cd_st_fail disk "the config is not loaded"; return 0; }
    if ((10#$min == 0)); then
        _cd_st_ok disk
        return 0
    fi
    a="$(_cd_st_free_gb "$CD_ROOT")" || { _cd_st_fail disk "the free space under the host root cannot be read"; return 0; }
    droot="$(timeout -k 5 30 docker info --format '{{.DockerRootDir}}' </dev/null 2>/dev/null)" || droot=''
    if [[ "$droot" != /* ]]; then
        _cd_st_fail disk "the docker root directory cannot be read"
        return 0
    fi
    b="$(_cd_st_free_gb "$droot")" || { _cd_st_fail disk "the free space of the docker root cannot be read"; return 0; }
    if ((a < 10#$min || b < 10#$min)); then
        _cd_st_fail disk "less than ${min} GB free (host root ${a}, docker ${b})"
    else
        _cd_st_ok disk
    fi
}

_cd_st_check_dump_dir() {
    local dir mode owner
    if ! declare -F _cd_data_dumpdir >/dev/null 2>&1; then
        _cd_st_fail dump_dir "data.sh is not installed"
        return 0
    fi
    dir="$(_cd_data_dumpdir 2>/dev/null)" || { _cd_st_fail dump_dir "GREMION_MIGRATION_DUMP_DIR is not usable in state.env"; return 0; }
    if [[ -L "$dir" || ! -d "$dir" ]]; then
        _cd_st_fail dump_dir "the dump directory is missing or not a plain directory"
        return 0
    fi
    mode="$(stat -c '%a' -- "$dir" 2>/dev/null)" || mode=''
    owner="$(stat -c '%u' -- "$dir" 2>/dev/null)" || owner=''
    if [[ "$mode" != 700 ]]; then
        _cd_st_fail dump_dir "the dump directory has mode ${mode:-unknown}, want 700"
    elif [[ "$owner" != "$(id -u)" ]]; then
        _cd_st_fail dump_dir "the dump directory is not owned by the deploy user"
    else
        _cd_st_ok dump_dir
    fi
}

# _cd_st_probe_customers HOST -- how many ACTIVE customers own HOST: a count, never the slug.
# The host (validated as a host name) reaches psql on its stdin and no argv.
_cd_st_probe_customers() {
    local host="$1" f pguser ctl cid out
    [[ "$host" =~ ^[a-z0-9.-]{1,253}$ ]] || return 2
    f="$(cd_envfile state)" || return 2
    pguser="$(cd_kv_get "$f" POSTGRES_USER 2>/dev/null)" || return 2
    ctl="$(cd_kv_get "$f" CONTROL_DB_NAME 2>/dev/null)" || return 2
    [[ "$pguser" =~ ^[a-z_][a-z0-9_]{0,62}$ && "$ctl" =~ ^[A-Za-z0-9_]{1,63}$ ]] || return 2
    cid="$(cd_svc_cid state postgres 2>/dev/null)" || return 4
    [[ -n "$cid" ]] || return 4
    out="$(printf "select count(*) from tenant t join tenant_domain d on d.tenant_id = t.id where d.host = '%s' and t.status = 'active';\n" "$host" \
        | timeout -k 5 30 docker exec -i "$cid" psql -X -U "$pguser" -d "$ctl" -Atq -v ON_ERROR_STOP=1 -f - 2>/dev/null)" || return 4
    [[ "$out" =~ ^[0-9]{1,9}$ ]] || return 4
    printf '%s\n' "$((10#$out))"
}

_cd_st_check_probe() {
    local host rc=0 n
    if ! declare -F cd_prepare_probe_host >/dev/null 2>&1; then
        _cd_st_fail probe_host "prepare.sh is not installed"
        return 0
    fi
    host="$(cd_prepare_probe_host 2>/dev/null)" || rc=$?
    if ((rc != 0)) || [[ -z "$host" ]]; then
        _cd_st_fail probe_host "no probe host: CD_PROBE_HOST is empty and etc/tenant-hosts.txt lists none"
        return 0
    fi
    _cd_st_ok probe_host
    rc=0
    n="$(_cd_st_probe_customers "$host")" || rc=$?
    if ((rc != 0)); then
        _cd_st_fail probe_customer "the customer registry cannot be asked (code ${rc})"
    elif ((n < 1)); then
        _cd_st_fail probe_customer "the probe host maps to no active customer"
    else
        _cd_st_ok probe_customer
    fi
}

_cd_st_check_timers() {
    local rc=0 span
    if ! declare -F cd_data_timer_guard >/dev/null 2>&1; then
        _cd_st_fail timers "data.sh is not installed"
        return 0
    fi
    span="$(cd_cfg CD_LOCK_SPAN_MAX_MIN)" || { _cd_st_fail timers "the config is not loaded"; return 0; }
    cd_data_timer_guard "$span" >/dev/null 2>&1 </dev/null || rc=$?
    case "$rc" in
        0) _cd_st_ok timers ;;
        3) _cd_st_warn timers "a span of ${span} minutes started now would overlap a timer (the timers exist)" ;;
        *) _cd_st_fail timers "the next elapse of the backup or purge timer cannot be read (a timer is missing from systemctl list-timers?)" ;;
    esac
}

_cd_st_check_state() {
    local live
    if [[ ! -f "$CD_STATE_FILE" ]]; then
        _cd_st_fail state "no state file (gremion-cd adopt has not run)"
        return 0
    fi
    # cd_state_load exits on a bad file; the subshell takes that exit, and its alert is the
    # program's own
    if ! live="$( ( cd_state_get 'if .live == null then "none" else "live" end' ) 2>/dev/null )"; then
        _cd_st_fail state "the state file is unreadable, of an unknown version or breaks the schema"
    elif [[ "$live" != live ]]; then
        _cd_st_fail state "the state records no live release (run: gremion-cd adopt --re-adopt --reason TEXT)"
    else
        _cd_st_ok state
    fi
}

# cd_cmd_selftest [--post-apply] -- every check runs and every failure is reported; the exit
# code is 1 when any failed, 0 otherwise (a warning does not fail). It sends one test mail of
# kind `selftest` (except under --post-apply) and prints no address.
cd_cmd_selftest() {
    local post=0 rc=0 missing hostfloor span live12 result=ok reason=none mailrc url
    while (($# > 0)); do
        case "$1" in
            --post-apply) post=1; shift ;;
            *) cd_die 2 "selftest: unknown argument (usage: gremion-cd selftest [--post-apply])" ;;
        esac
    done
    CD_ST_FAILS=()
    CD_ST_WARNS=()
    CD_ST_FIRST_FAIL=''

    # config (the dispatcher refused a bad file already; these are the keys a release needs)
    if cd_cfg_is_set CD_POLICY_ACK && cd_cfg_is_set CD_MAIL_TO && cd_cfg_is_set CD_REPO_URL; then
        _cd_st_ok config
    else
        _cd_st_fail config "CD_REPO_URL, CD_MAIL_TO and CD_POLICY_ACK must all be set"
    fi
    _cd_st_check_state
    _cd_st_check_dump_dir

    if declare -F cd_data_lock_span_floor >/dev/null 2>&1; then
        hostfloor="$(cd_data_lock_span_floor 2>/dev/null)" || hostfloor=''
        span="$(cd_cfg CD_LOCK_SPAN_MAX_MIN)" || span=''
        if [[ "$hostfloor" =~ ^[0-9]+$ && "$span" =~ ^[0-9]+$ ]] && ((10#$span >= 10#$hostfloor)); then
            _cd_st_ok lock_span
        else
            _cd_st_fail lock_span "CD_LOCK_SPAN_MAX_MIN (${span:-unknown}) is below the sum of the stage caps (${hostfloor:-unknown})"
        fi
    else
        _cd_st_fail lock_span "data.sh is not installed"
    fi

    # the mirror and the repository
    if declare -F cd_gh_tip >/dev/null 2>&1 && cd_gh_tip >/dev/null 2>&1 </dev/null; then
        _cd_st_ok mirror
    else
        _cd_st_fail mirror "the repository does not answer git ls-remote"
    fi
    rc=0
    missing="$(cd_gh_rules_ok 2>/dev/null </dev/null)" || rc=$?
    case "$rc" in
        0) _cd_st_ok rules ;;
        1) _cd_st_fail rules "the branch rules of main lack: ${missing//[^a-z_,]/}" ;;
        *) _cd_st_fail rules "the branch rules of main cannot be read" ;;
    esac
    rc=0
    cd_gh_merge_methods_ok >/dev/null 2>&1 </dev/null || rc=$?
    if ((rc == 0)); then
        _cd_st_ok merge_methods
    else
        _cd_st_fail merge_methods "the merge methods of the repository are not squash only with linear history"
    fi

    # docker, disk, locks
    if timeout -k 5 30 docker info --format '{{.ServerVersion}}' </dev/null >/dev/null 2>&1; then
        _cd_st_ok docker
    else
        _cd_st_fail docker "docker does not answer"
    fi
    _cd_st_check_disk
    _cd_st_check_locks "$post"

    # mail transport
    if cd_notify_transport_ok >/dev/null 2>&1 </dev/null; then
        _cd_st_ok mail_transport
    elif [[ "${CD_NOTIFY_TRANSPORT_VALUE:-}" == stalwart && "$(cd_cfg CD_ALLOW_NO_MAIL)" == 1 ]]; then
        _cd_st_warn mail_transport "the transport is not the relay (CD_ALLOW_NO_MAIL=1 says so)"
    else
        _cd_st_fail mail_transport "the mail transport is not the relay"
    fi

    _cd_st_check_probe
    _cd_st_check_timers

    # the ping: once, and a failure is a warning. cd_ping (notify.sh) swallows its own result,
    # so the one request is made here; the URL may carry a token, so it reaches curl on stdin
    # only and is never printed.
    if cd_cfg_is_set CD_PING_URL; then
        url="$(cd_cfg CD_PING_URL)" || url=''
        if printf 'url = "%s"\n' "$url" \
            | curl --silent --show-error --fail --connect-timeout 5 --max-time 10 --output /dev/null -K - >/dev/null 2>&1 7>&-; then
            _cd_st_ok ping
        else
            _cd_st_warn ping "the outbound ping failed once"
        fi
        url=''
    fi

    # the test mail: the one thing that proves the relay accepts what the program sends
    if ((post == 0)); then
        if ((${#CD_ST_FAILS[@]} > 0)); then
            result=failed
            reason="$CD_ST_FIRST_FAIL"
        fi
        live12="$( ( cd_state_get '.live.sha12 // "none"' ) 2>/dev/null )" || live12=none
        [[ "$live12" =~ ^([0-9a-f]{12}|none)$ ]] || live12=none
        if cd_notify_transport_ok >/dev/null 2>&1 </dev/null; then
            cd_notify selftest sha12="$live12" stage=none result="$result" reason="$reason"
            mailrc=0
            cd_notify_flush >/dev/null 2>&1 </dev/null || mailrc=$?
            case "$mailrc" in
                0) _cd_st_ok test_mail ;;
                3) _cd_st_warn test_mail "another sender is flushing the outbox; the test mail goes with it" ;;
                *) _cd_st_fail test_mail "the relay did not take the test mail" ;;
            esac
        else
            cd_info "skip  test_mail: the transport is not the relay"
        fi
    fi

    if ((${#CD_ST_FAILS[@]} > 0)); then
        cd_info "selftest: ${#CD_ST_FAILS[@]} check(s) failed, ${#CD_ST_WARNS[@]} warning(s)"
        cd_hist selftest result=failed failed="${#CD_ST_FAILS[@]}" post_apply="$post" || true
        return 1
    fi
    cd_info "selftest: all checks passed (${#CD_ST_WARNS[@]} warning(s))"
    cd_hist selftest result=ok failed=0 post_apply="$post" || true
    return 0
}
