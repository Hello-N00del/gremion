#!/usr/bin/env bash
set -euo pipefail
#
# apply-root.sh <sha12> -- the ROOT side of applying new host programs (gremion-cd). THE ONLY
# script of the program that runs as root, and only from gremion-cd-apply@<sha12>.service, which
# only `sudo -n systemctl start --wait` of the deploy user's release-now starts. No network. It is
# never sourced by the dispatcher (gremion-cd skips this file name) and never run from a tick.
#
#   1. refuse unless root, the instance is ^[0-9a-f]{12}$, releases/<sha12> is a real work tree
#      whose HEAD is that commit (read as the deploy user: root must not run git over a tree the
#      deploy user controls), and the pending backup is sound. Nothing is touched before all of
#      that holds.
#   2. run `bootstrap.sh cd` of THAT tree, `systemctl daemon-reload` if a unit file changed, then
#      the self-test of the NEW installed program as the deploy user (--post-apply: the caller
#      holds the locks, so the check asserts they are held and no test mail is sent).
#   3. on ANY failure after step 1 (a non-zero exit, a TERM at the unit's timeout) put the backup
#      back byte for byte (verified with cmp), reload again and exit non-zero. Half-installed is
#      not an end state. (SIGKILL cannot be caught: `gremion-cd selftest` after such a kill finds
#      the mix, and the backup stays in data/cd/host-backup for the operator.)
#
# THE BACKUP (written by the deploy-user side, data/cd/host-backup/<time>/, a real directory;
# `pending` is a link to it, or the directory itself, and its real path must lie under
# data/cd/host-backup). Paths below it, nothing else is accepted:
#   bin/<file>          every file of <root>/bin
#   lib/common.sh       <root>/lib/common.sh
#   lib/cd/<name>.sh    every file of <root>/lib/cd
#   units/<unit>        the six gremion-cd unit files of the systemd directory
# Modes and owners are not read from the backup: programs 0755 and libraries 0644 for the deploy
# user, apply-root.sh 0755 and the units 0644 for root, the way `bootstrap.sh cd` installs them.
umask 022
ROOT="${GREMION_ROOT:-/opt/gremion}"
UDIR="${GREMION_SYSTEMD_DIR:-/etc/systemd/system}"
UNITS=(gremion-cd.service gremion-cd.timer gremion-cd-watchdog.service gremion-cd-watchdog.timer
    gremion-cd-resume.service 'gremion-cd-apply@.service')
MUST=(bin/gremion-cd lib/common.sh lib/cd/core.sh lib/cd/apply-root.sh)

fail() { printf 'apply-root: %s\n' "$1" >&2; exit "${2:-1}"; }
is_unit() { local u; for u in "${UNITS[@]}"; do [[ "$u" == "$1" ]] && return 0; done; return 1; }

[[ "$(id -u)" -eq 0 ]] || fail "must run as root (gremion-cd-apply@.service is the only way in)" 2
[[ $# -eq 1 && "$1" =~ ^[0-9a-f]{12}$ ]] || fail "the instance must be twelve lower-case hex digits" 2
SHA="$1"
[[ -n "${DEPLOY_USER:-}" ]] || fail "DEPLOY_USER is not set" 2
DU="$(id -u "$DEPLOY_USER")" && DG="$(id -g "$DEPLOY_USER")" || fail "the deploy user does not exist" 2
export GREMION_ROOT="$ROOT" DEPLOY_USER GREMION_SYSTEMD_DIR="$UDIR"

TREE="${ROOT}/releases/${SHA}"
[[ -d "$TREE" && ! -L "$TREE" ]] || fail "releases/${SHA} is not a real directory" 2
HEAD_SHA="$(runuser -u "$DEPLOY_USER" -- env -i "PATH=${PATH}" git -C "$TREE" rev-parse HEAD </dev/null 2>/dev/null)" \
    || fail "cannot read HEAD of releases/${SHA}" 2
[[ "$HEAD_SHA" =~ ^[0-9a-f]{40}$ && "${HEAD_SHA:0:12}" == "$SHA" ]] || fail "HEAD of releases/${SHA} is not ${SHA}" 2
[[ -f "${TREE}/infra/host/bootstrap.sh" && ! -L "${TREE}/infra/host/bootstrap.sh" ]] \
    || fail "releases/${SHA} has no infra/host/bootstrap.sh" 2

# the pending backup: a real directory under data/cd/host-backup, reached by at most the one link
HB="${ROOT}/data/cd/host-backup"
[[ -e "${HB}/pending" || -L "${HB}/pending" ]] || fail "there is no pending backup (${HB}/pending)" 2
BK="${HB}/pending"
if [[ -L "$BK" ]]; then
    BK="$(readlink -- "$BK")"
    [[ "$BK" == /* ]] || BK="${HB}/${BK}"
fi
[[ -d "$BK" && ! -L "$BK" ]] || fail "the pending backup is not a real directory (a missing target or a link chain)" 2
BK="$(readlink -f -- "$BK")"
[[ "$BK" == "$(readlink -f -- "${ROOT}/data/cd")/host-backup/"?* ]] || fail "the pending backup lies outside data/cd/host-backup" 2
if [[ -n "$(find "$BK" -mindepth 1 ! -type f ! -type d -print -quit)" ]]; then
    fail "the pending backup holds a symlink or a special file" 2
fi
while IFS= read -r -d '' f; do
    rel="${f#"${BK}"/}"
    case "$rel" in
        bin | lib | lib/cd | units) ;;
        *) fail "the pending backup holds a directory outside its layout: ${rel}" 2 ;;
    esac
done < <(find "$BK" -mindepth 1 -type d -print0)
while IFS= read -r -d '' f; do
    rel="${f#"${BK}"/}"
    [[ "$rel" =~ ^(bin/[^/]+|lib/common\.sh|lib/cd/[^/]+\.sh)$ ]] && continue
    [[ "$rel" == units/* ]] && is_unit "${rel#units/}" && continue
    fail "the pending backup holds a file outside its layout: ${rel}" 2
done < <(find "$BK" -type f -print0)
for rel in "${MUST[@]}"; do
    [[ -f "${BK}/${rel}" ]] || fail "the pending backup has no ${rel}: restoring from it would empty the host" 2
done
for rel in "${UNITS[@]}"; do
    [[ -f "${BK}/units/${rel}" ]] || fail "the pending backup has no units/${rel}" 2
done

dest_of() { if [[ "$1" == units/* ]]; then printf '%s/%s' "$UDIR" "${1#units/}"; else printf '%s/%s' "$ROOT" "$1"; fi; }
mode_of() { case "$1" in bin/* | lib/cd/apply-root.sh) echo 755 ;; *) echo 644 ;; esac; }
deploy_owned() { case "$1" in units/* | lib/cd/apply-root.sh) return 1 ;; *) return 0 ;; esac; }

# restore_set -- the backup back byte for byte, strays gone, verified, reloaded; 0 only if all of it held
restore_set() {
    local f rel dest tmp rc=0
    while IFS= read -r -d '' f; do
        rel="${f#"${BK}"/}"
        dest="$(dest_of "$rel")"
        tmp="${dest}.restore.$$"
        { install -m "$(mode_of "$rel")" -- "$f" "$tmp" \
            && { ! deploy_owned "$rel" || chown "${DU}:${DG}" -- "$tmp"; } \
            && mv -f -T -- "$tmp" "$dest"; } || { rm -f -- "$tmp"; rc=1; }
    done < <(find "$BK" -type f -print0)
    for f in "${ROOT}"/bin/* "${ROOT}"/lib/cd/*.sh "${UDIR}"/gremion-cd*.service "${UDIR}"/gremion-cd*.timer; do
        [[ -f "$f" || -L "$f" ]] || continue
        case "$f" in "${UDIR}"/*) rel="units/${f##*/}" ;; *) rel="${f#"${ROOT}"/}" ;; esac
        [[ -f "${BK}/${rel}" ]] || rm -f -- "$f" || rc=1
    done
    while IFS= read -r -d '' f; do
        rel="${f#"${BK}"/}"
        dest="$(dest_of "$rel")"
        { [[ -f "$dest" && ! -L "$dest" ]] && cmp -s "$f" "$dest" && [[ "$(stat -c %a "$dest")" == "$(mode_of "$rel")" ]]; } \
            || { printf 'apply-root: restore: %s is not back as it was\n' "$rel" >&2; rc=1; }
    done < <(find "$BK" -type f -print0)
    systemctl daemon-reload || { printf 'apply-root: restore: systemctl daemon-reload failed\n' >&2; rc=1; }
    return "$rc"
}

unit_sums() { local u; for u in "${UNITS[@]}"; do sha256sum -- "${UDIR}/${u}" 2>/dev/null || echo "absent ${u}"; done; }

APPLIED=0
trap 'exit 143' TERM INT HUP
trap 'rc=$?; trap "" TERM INT HUP; trap - EXIT
    if [[ "$APPLIED" != 1 ]]; then
        printf "apply-root: apply of %s failed (exit %s), restoring the backup\n" "$SHA" "$rc" >&2
        if restore_set; then printf "apply-root: the host programs are back as they were\n" >&2
        else printf "apply-root: THE RESTORE DID NOT HOLD: the host programs may be half-installed\n" >&2; rc=1; fi
        [[ "$rc" -ne 0 ]] || rc=1
    fi
    exit "$rc"' EXIT

BEFORE="$(unit_sums)"
bash "${TREE}/infra/host/bootstrap.sh" cd </dev/null
if [[ "$(unit_sums)" != "$BEFORE" ]]; then
    systemctl daemon-reload
fi
runuser -u "$DEPLOY_USER" -- env "GREMION_ROOT=${ROOT}" "${ROOT}/bin/gremion-cd" selftest --post-apply </dev/null
APPLIED=1
printf 'apply-root: host programs of release %s applied\n' "$SHA"
