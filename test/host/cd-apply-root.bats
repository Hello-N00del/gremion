#!/usr/bin/env bats
# Tests for infra/host/lib/cd/apply-root.sh -- the one script of the continuous-deployment
# program that runs as root, started only by gremion-cd-apply@<sha12>.service.
# Run: bats test/host/cd-apply-root.bats
#
# The bootstrap of the release tree, systemctl, runuser, id and gremion-cd are shims (the fake
# bootstrap really replaces and adds files, so the restore is proven on bytes, not on a call).
# NO ROOT is needed: `id` answers 0 for the script's own root check, and the deploy user's ids
# are the runner's (root files are created by the process, so nothing is chowned to uid 0).
#
# THE BACKUP LAYOUT THIS SCRIPT READS (a contract with the deploy-user side that writes it,
# data/cd/host-backup/<time>/, and `pending` points at one of those directories):
#   bin/<file>                every file of <root>/bin
#   lib/common.sh             <root>/lib/common.sh
#   lib/cd/<file>.sh          every file of <root>/lib/cd
#   units/<unit file>         the six gremion-cd unit files of the systemd directory

load 'test_helper/host'

FX="${HOST_TEST_DIR}/fixtures/cd/units"
APPLY="${HOST_SRC}/lib/cd/apply-root.sh"
SHA12=0123456789ab
UNITS=(gremion-cd.service gremion-cd.timer gremion-cd-watchdog.service gremion-cd-watchdog.timer
    gremion-cd-resume.service 'gremion-cd-apply@.service')
BACKUP_NAME=2026-11-17T01-00-00

setup() {
    setup_host_root
    export DEPLOY_USER=gremion
    export GREMION_SYSTEMD_DIR="${GREMION_ROOT}/unit-dir"
    mkdir -p "${GREMION_SYSTEMD_DIR}" "${GREMION_ROOT}/data/cd/host-backup" "${GREMION_ROOT}/lib/cd"
    chmod 700 "${GREMION_ROOT}/data/cd"
    if [ "$(id -u)" = 0 ]; then
        DEPLOY_IDS="1234 4321"
    else
        DEPLOY_IDS="$(id -u) $(id -g)"
    fi
    local real_id; real_id="$(command -v id)"
    set -- ${DEPLOY_IDS}
    # id -u answers 0 (this is the root script) unless .not-root exists; the deploy user has the runner's ids
    shim id "if [ \"\${2-}\" = gremion ]; then case \"\$1\" in -u) echo $1; exit 0 ;; -g) echo $2; exit 0 ;; esac; fi
if [ \"\$*\" = -u ]; then if [ -e \"\${GREMION_ROOT}/.not-root\" ]; then echo 1000; else echo 0; fi; exit 0; fi
exec ${real_id} \"\$@\""
    shim runuser 'shift 3; exec "$@"'
    # systemctl fails for the argument named in .systemctl-fail
    shim systemctl 'if [ -f "${GREMION_ROOT}/.systemctl-fail" ] && [ "$1" = "$(cat "${GREMION_ROOT}/.systemctl-fail")" ]; then exit 1; fi'
    hash -r
    make_installed_set
    make_release_tree
    echo ok > "${GREMION_ROOT}/.boot-mode"
}

teardown() {
    teardown_host_root
}

# the installed set, old content
make_installed_set() {
    local r="$GREMION_ROOT" u
    mkdir -p "$r/bin" "$r/lib/cd"
    cp "${FX}/fake-gremion-cd.body" "$r/bin/gremion-cd"
    printf '#!/bin/sh\necho other-old\n' > "$r/bin/gremion-other"
    printf '# common, old\n' > "$r/lib/common.sh"
    printf '# core, old\n' > "$r/lib/cd/core.sh"
    printf '#!/usr/bin/env bash\n# apply, old\n' > "$r/lib/cd/apply-root.sh"
    chmod 755 "$r/bin/gremion-cd" "$r/bin/gremion-other" "$r/lib/cd/apply-root.sh"
    chmod 644 "$r/lib/common.sh" "$r/lib/cd/core.sh"
    for u in "${UNITS[@]}"; do
        printf '[Unit]\nDescription=old %s\n' "$u" > "${GREMION_SYSTEMD_DIR}/${u}"
    done
}

# the backup of the installed set: data/cd/host-backup/<time>/{bin,lib,units}, `pending` pointing at it
make_backup() {
    local b="${GREMION_ROOT}/data/cd/host-backup/${BACKUP_NAME}" u
    mkdir -p "$b/bin" "$b/lib/cd" "$b/units"
    cp -p "${GREMION_ROOT}"/bin/* "$b/bin/"
    cp -p "${GREMION_ROOT}/lib/common.sh" "$b/lib/"
    cp -p "${GREMION_ROOT}"/lib/cd/*.sh "$b/lib/cd/"
    for u in "${UNITS[@]}"; do
        cp -p "${GREMION_SYSTEMD_DIR}/${u}" "$b/units/"
    done
    chmod 700 "$b"
    ln -sfn "$BACKUP_NAME" "${GREMION_ROOT}/data/cd/host-backup/pending"
}

# the release tree: a real git work tree whose HEAD starts with SHA12, holding the fake bootstrap
make_release_tree() {
    local t="${BATS_TEST_TMPDIR}/rel" sha
    rm -rf "$t"
    mkdir -p "$t/infra/host"
    cp "${FX}/fake-bootstrap.body" "$t/infra/host/bootstrap.sh"
    git -C "$t" init -q
    git -C "$t" add -A
    git -C "$t" -c user.name=t -c user.email=t@example.org -c commit.gpgsign=false commit -q -m x
    sha="$(git -C "$t" rev-parse HEAD)"
    RELEASE_SHA12="${sha:0:12}"
    mkdir -p "${GREMION_ROOT}/releases"
    mv "$t" "${GREMION_ROOT}/releases/${RELEASE_SHA12}"
}

apply() {
    # an explicit empty instance must reach the script as an empty argument
    run bash "$APPLY" "${1-$RELEASE_SHA12}"
}

# a digest of the installed set: every file of bin/, lib/common.sh, lib/cd/*.sh and the six units, path + bytes + mode
set_digest() {
    local r="$GREMION_ROOT" f
    for f in "$r"/bin/* "$r"/lib/common.sh "$r"/lib/cd/*.sh "${GREMION_SYSTEMD_DIR}"/gremion-cd*; do
        [ -e "$f" ] || continue
        printf '%s %s %s\n' "${f#"$r"/}" "$(stat -c %a "$f")" "$(cksum < "$f")"
    done | sort
}

# assert_set_is_backup -- every backup file is installed with the same bytes, and nothing else is installed
assert_set_is_backup() {
    local b="${GREMION_ROOT}/data/cd/host-backup/${BACKUP_NAME}" f rel dest n=0
    while IFS= read -r f; do
        rel="${f#"$b"/}"
        case "$rel" in
            units/*) dest="${GREMION_SYSTEMD_DIR}/${rel#units/}" ;;
            *) dest="${GREMION_ROOT}/${rel}" ;;
        esac
        [ -f "$dest" ] || { echo "restore did not bring back: $rel"; return 1; }
        cmp -s "$f" "$dest" || { echo "differs from the backup: $rel"; return 1; }
        n=$((n + 1))
    done < <(find "$b" -type f | sort)
    [ "$n" -ge 11 ] || { echo "only $n files compared"; return 1; }
    for f in "${GREMION_ROOT}"/bin/* "${GREMION_ROOT}"/lib/cd/*.sh "${GREMION_SYSTEMD_DIR}"/gremion-cd*; do
        [ -e "$f" ] || continue
        case "$f" in
            "${GREMION_SYSTEMD_DIR}"/*) rel="units/${f##*/}" ;;
            *) rel="${f#"${GREMION_ROOT}"/}" ;;
        esac
        [ -f "$b/$rel" ] || { echo "a file the backup does not have is still installed: $rel"; return 1; }
    done
}

# ---------------------------------------------------------------------------
# what the script refuses before it touches anything
# ---------------------------------------------------------------------------

@test "an instance name that is not twelve lower-case hex digits is refused and nothing runs" {
    make_backup
    local before; before="$(set_digest)"
    local bad
    for bad in "" abc 0123456789a 0123456789abc 0123456789AB 0123456789ag '../releases' '0123456789a/' '0123456789 b'; do
        apply "$bad"
        [ "$status" -eq 2 ] || { echo "'${bad}' gave ${status}: ${output}"; return 1; }
        # refused by the name alone, before any path is built from it
        [[ "$output" == *"twelve lower-case hex digits"* ]] || { echo "'${bad}': ${output}"; return 1; }
    done
    refute_recorded bootstrap "cd"
    refute_recorded systemctl "daemon-reload"
    [ "$(set_digest)" = "$before" ]
}

@test "a script that is not root refuses before anything (the unit is the only way in)" {
    make_backup
    : > "${GREMION_ROOT}/.not-root"
    local before; before="$(set_digest)"
    apply
    [ "$status" -eq 2 ]
    [[ "$output" == *"root"* ]]
    refute_recorded bootstrap "cd"
    [ "$(set_digest)" = "$before" ]
}

@test "no DEPLOY_USER is refused: the self-test must run as the deploy user" {
    make_backup
    run env -u DEPLOY_USER bash "$APPLY" "$RELEASE_SHA12"
    [ "$status" -eq 2 ]
    [[ "$output" == *"DEPLOY_USER"* ]]
    refute_recorded bootstrap "cd"
}

@test "a releases/<sha12> that is missing, a symlink or a plain directory is refused" {
    make_backup
    local before; before="$(set_digest)"
    # missing
    apply 000000000000
    [ "$status" -eq 2 ]
    # a symlink to the real tree
    ln -s "${GREMION_ROOT}/releases/${RELEASE_SHA12}" "${GREMION_ROOT}/releases/111111111111"
    apply 111111111111
    [ "$status" -eq 2 ]
    # a directory that is not a git work tree
    mkdir -p "${GREMION_ROOT}/releases/222222222222/infra/host"
    cp "${FX}/fake-bootstrap.body" "${GREMION_ROOT}/releases/222222222222/infra/host/bootstrap.sh"
    apply 222222222222
    [ "$status" -eq 2 ]
    refute_recorded bootstrap "cd"
    [ "$(set_digest)" = "$before" ]
}

@test "a release tree whose HEAD is another commit than the name says is refused" {
    make_backup
    mv "${GREMION_ROOT}/releases/${RELEASE_SHA12}" "${GREMION_ROOT}/releases/333333333333"
    local before; before="$(set_digest)"
    apply 333333333333
    [ "$status" -eq 2 ]
    [[ "$output" == *"HEAD"* ]]
    refute_recorded bootstrap "cd"
    [ "$(set_digest)" = "$before" ]
}

@test "a release tree edited after the checkout is refused: root would run a file that is not the commit" {
    make_backup
    printf '# edited after the checkout\n' >> "${GREMION_ROOT}/releases/${RELEASE_SHA12}/infra/host/bootstrap.sh"
    local before; before="$(set_digest)"
    apply
    [ "$status" -eq 2 ]
    [[ "$output" == *"not clean"* ]]
    refute_recorded bootstrap "cd"
    [ "$(set_digest)" = "$before" ]
}

@test "a pending backup that lies outside data/cd is refused before anything is touched" {
    make_backup
    mkdir -p "${BATS_TEST_TMPDIR}/elsewhere"
    cp -a "${GREMION_ROOT}/data/cd/host-backup/${BACKUP_NAME}/." "${BATS_TEST_TMPDIR}/elsewhere/"
    ln -sfn "${BATS_TEST_TMPDIR}/elsewhere" "${GREMION_ROOT}/data/cd/host-backup/pending"
    local before; before="$(set_digest)"
    apply
    [ "$status" -eq 2 ]
    [[ "$output" == *"pending"* ]]
    refute_recorded bootstrap "cd"
    refute_recorded systemctl "daemon-reload"
    [ "$(set_digest)" = "$before" ]
}

@test "a pending backup that is itself a symlink to a directory (a chain) is refused" {
    make_backup
    ln -sfn "$BACKUP_NAME" "${GREMION_ROOT}/data/cd/host-backup/real-link"
    ln -sfn real-link "${GREMION_ROOT}/data/cd/host-backup/pending"
    local before; before="$(set_digest)"
    apply
    [ "$status" -eq 2 ]
    refute_recorded bootstrap "cd"
    [ "$(set_digest)" = "$before" ]
}

@test "a missing pending backup is refused: no restore point, no apply" {
    local before; before="$(set_digest)"
    apply
    [ "$status" -eq 2 ]
    [[ "$output" == *"pending"* ]]
    refute_recorded bootstrap "cd"
    [ "$(set_digest)" = "$before" ]
}

@test "a backup that holds a symlink or a file outside the set layout is refused (root would follow or install it)" {
    make_backup
    local b="${GREMION_ROOT}/data/cd/host-backup/${BACKUP_NAME}" before
    ln -s /etc/hostname "$b/bin/gremion-link"
    before="$(set_digest)"
    apply
    [ "$status" -eq 2 ]
    refute_recorded bootstrap "cd"
    rm -f "$b/bin/gremion-link"
    printf 'x\n' > "$b/etc-passwd"
    apply
    [ "$status" -eq 2 ]
    refute_recorded bootstrap "cd"
    [ "$(set_digest)" = "$before" ]
}

@test "a backup without the dispatcher, the core library, the apply script or a unit is refused (a restore from it would empty the host)" {
    make_backup
    local b="${GREMION_ROOT}/data/cd/host-backup/${BACKUP_NAME}" miss before
    before="$(set_digest)"
    mkdir -p "${BATS_TEST_TMPDIR}/held"
    for miss in bin/gremion-cd lib/cd/core.sh lib/cd/apply-root.sh lib/common.sh units/gremion-cd.timer; do
        mv "$b/$miss" "${BATS_TEST_TMPDIR}/held/held"
        apply
        [ "$status" -eq 2 ] || { echo "${miss}: ${status}: ${output}"; return 1; }
        mv "${BATS_TEST_TMPDIR}/held/held" "$b/$miss"
    done
    refute_recorded bootstrap "cd"
    [ "$(set_digest)" = "$before" ]
}

# ---------------------------------------------------------------------------
# the apply
# ---------------------------------------------------------------------------

@test "the bootstrap stage cd runs from the release tree, then the self-test runs as the deploy user with --post-apply" {
    make_backup
    apply
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    assert_recorded bootstrap "cd mode=ok tree=${RELEASE_SHA12}"
    assert_recorded runuser "-u gremion --"
    assert_recorded gremion-cd "selftest --post-apply"
    # the order: bootstrap, then the reload, then the self-test
    local order
    order="$(grep -nE '^(bootstrap|systemctl daemon-reload|gremion-cd selftest)' "$SHIM_LOG" | sed -E 's/^[0-9]+://' | cut -d' ' -f1-2 | tr '\n' ',')"
    [ "$order" = "bootstrap cd,systemctl daemon-reload,gremion-cd selftest," ] || { echo "order: $order"; return 1; }
    # the new content stays (a successful apply restores nothing)
    grep -q 'new content of the release' "${GREMION_ROOT}/lib/cd/core.sh"
    [ -f "${GREMION_ROOT}/bin/gremion-added" ]
}

@test "daemon-reload is called when a unit file changed, and not when none did" {
    make_backup
    apply
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    assert_recorded systemctl "daemon-reload"
    : > "$SHIM_LOG"
    # the units already hold the release's content: a second apply with the mode that leaves them alone
    echo no-units > "${GREMION_ROOT}/.boot-mode"
    make_backup
    apply
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    refute_recorded systemctl "daemon-reload"
    assert_recorded gremion-cd "selftest --post-apply"
}

@test "the self-test of the NEW installed program is the one that runs" {
    make_backup
    apply
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    # the line the fake program writes comes from the file the bootstrap replaced
    tail -1 "${GREMION_ROOT}/bin/gremion-cd" | grep -q 'new content of the release'
    assert_recorded gremion-cd "selftest --post-apply"
}

# ---------------------------------------------------------------------------
# half-installed is not a possible end state
# ---------------------------------------------------------------------------

@test "a bootstrap that fails midway (programs and libraries replaced, no unit rendered): the set ends BYTE-IDENTICAL to the backup" {
    make_backup
    echo fail-midway > "${GREMION_ROOT}/.boot-mode"
    # the fake really replaced files: prove the restore had something to undo
    local before; before="$(set_digest)"
    apply
    [ "$status" -ne 0 ]
    assert_recorded bootstrap "mode=fail-midway"
    assert_set_is_backup
    [ "$(set_digest)" = "$before" ] || { echo "the set differs from before the apply"; return 1; }
    # daemon-reload runs again after the restore, the self-test never ran
    assert_recorded systemctl "daemon-reload"
    refute_recorded gremion-cd "selftest"
    [ ! -e "${GREMION_ROOT}/bin/gremion-added" ]
    [ ! -e "${GREMION_ROOT}/lib/cd/zz-added.sh" ]
}

@test "a forced self-test failure restores the set, reloads again and exits non-zero" {
    make_backup
    echo 1 > "${GREMION_ROOT}/.selftest-rc"
    apply
    [ "$status" -ne 0 ]
    assert_recorded gremion-cd "selftest --post-apply"
    assert_set_is_backup
    # one reload after the bootstrap (units changed) and one after the restore
    [ "$(grep -c '^systemctl daemon-reload' "$SHIM_LOG")" -ge 2 ]
}

@test "a failing daemon-reload restores the set, tries to reload once more and exits non-zero" {
    make_backup
    echo daemon-reload > "${GREMION_ROOT}/.systemctl-fail"
    apply
    [ "$status" -ne 0 ]
    assert_set_is_backup
    [ "$(grep -c '^systemctl daemon-reload' "$SHIM_LOG")" -ge 2 ]
    refute_recorded gremion-cd "selftest"
}

@test "a TERM during the bootstrap (a timeout) restores the set too" {
    make_backup
    echo term > "${GREMION_ROOT}/.boot-mode"
    apply
    # the exit code of the TERM trap, not whatever the bootstrap ended with (it ended with 0)
    [ "$status" -eq 143 ] || { echo "status ${status}: ${output}"; return 1; }
    assert_recorded bootstrap "mode=term"
    # the bootstrap kept writing for a second after the TERM: the restore must wait for it (the
    # `trap 'exit 143' TERM` is what defers the signal until the child is done), or this tail
    # lands on top of the restored set
    assert_set_is_backup
    [ ! -e "${GREMION_ROOT}/lib/cd/zz-late.sh" ]
}

@test "the restore puts back modes and owners: programs 0755, libraries 0644, units 0644, the deploy user's files in the deploy user's name" {
    make_backup
    echo fail-midway > "${GREMION_ROOT}/.boot-mode"
    chmod 600 "${GREMION_ROOT}/lib/common.sh"
    chmod 700 "${GREMION_ROOT}/bin/gremion-other"
    # a recording chown (it really chowns): as a plain-uid runner root's and the deploy user's
    # files have one owner, so the calls are what tells "handed to the deploy user" from "left root's"
    local real_chown; real_chown="$(command -v chown)"
    shim chown "exec ${real_chown} \"\$@\""
    hash -r
    apply
    [ "$status" -ne 0 ]
    assert_recorded chown "gremion-other.restore"
    assert_recorded chown "lib/cd/core.sh.restore"
    # the apply script and the units are root's: the restore must not hand them to the deploy user
    refute_recorded chown "apply-root.sh"
    refute_recorded chown "gremion-cd.service"
    [ "$(stat -c %a "${GREMION_ROOT}/bin/gremion-other")" = 755 ]
    [ "$(stat -c %a "${GREMION_ROOT}/lib/common.sh")" = 644 ]
    [ "$(stat -c %a "${GREMION_ROOT}/lib/cd/core.sh")" = 644 ]
    [ "$(stat -c %a "${GREMION_ROOT}/lib/cd/apply-root.sh")" = 755 ]
    [ "$(stat -c %a "${GREMION_SYSTEMD_DIR}/gremion-cd.service")" = 644 ]
    set -- ${DEPLOY_IDS}
    [ "$(stat -c %u:%g "${GREMION_ROOT}/bin/gremion-other")" = "$1:$2" ]
    [ "$(stat -c %u:%g "${GREMION_ROOT}/lib/cd/core.sh")" = "$1:$2" ]
}

@test "the restore replaces files by a new inode, so a script bash is running from the installed set is never changed in place" {
    make_backup
    echo fail-midway > "${GREMION_ROOT}/.boot-mode"
    local f="${GREMION_ROOT}/bin/gremion-cd" before after
    before="$(stat -c %i "$f")"
    # hold the old inode open, as a running bash does: it cannot be reused for the restored file
    exec 7<"$f"
    apply
    exec 7<&-
    [ "$status" -ne 0 ]
    after="$(stat -c %i "$f")"
    [ "$before" != "$after" ]
    cmp -s "$f" "${GREMION_ROOT}/data/cd/host-backup/${BACKUP_NAME}/bin/gremion-cd"
}

@test "a successful apply leaves the backup directory and the pending pointer alone (the deploy side owns them)" {
    make_backup
    apply
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    [ -L "${GREMION_ROOT}/data/cd/host-backup/pending" ]
    [ -f "${GREMION_ROOT}/data/cd/host-backup/${BACKUP_NAME}/bin/gremion-cd" ]
}

@test "a real directory named pending inside host-backup is accepted as the backup" {
    make_backup
    rm -f "${GREMION_ROOT}/data/cd/host-backup/pending"
    mv "${GREMION_ROOT}/data/cd/host-backup/${BACKUP_NAME}" "${GREMION_ROOT}/data/cd/host-backup/pending"
    echo fail-midway > "${GREMION_ROOT}/.boot-mode"
    apply
    [ "$status" -ne 0 ]
    # the backup was accepted: the bootstrap ran and failed (a refusal would leave the set alone
    # and the comparison below trivially true), and the restore ran
    assert_recorded bootstrap "mode=fail-midway"
    [[ "$output" == *"restoring the backup"* ]] || { echo "$output"; return 1; }
    BACKUP_NAME=pending assert_set_is_backup
    [ ! -e "${GREMION_ROOT}/bin/gremion-added" ]
}

@test "a pending backup that is not the installed set (a stale one) is refused before anything is touched" {
    make_backup
    local before r="$GREMION_ROOT"
    before="$(set_digest)"
    # a program installed after the backup: a restore would delete it
    printf '#!/bin/sh\necho later\n' > "$r/bin/gremion-later"
    chmod 755 "$r/bin/gremion-later"
    before="$(set_digest)"
    apply
    [ "$status" -eq 2 ] || { echo "later program: ${status}: ${output}"; return 1; }
    [[ "$output" == *"bin/gremion-later"* ]] || { echo "$output"; return 1; }
    refute_recorded bootstrap "cd"
    [ "$(set_digest)" = "$before" ]
    rm -f "$r/bin/gremion-later"
    # a library changed after the backup: a restore would revert it
    printf '# core, newer than the backup\n' > "$r/lib/cd/core.sh"
    before="$(set_digest)"
    apply
    [ "$status" -eq 2 ] || { echo "changed library: ${status}: ${output}"; return 1; }
    [[ "$output" == *"lib/cd/core.sh"* ]] || { echo "$output"; return 1; }
    refute_recorded bootstrap "cd"
    [ "$(set_digest)" = "$before" ]
    cp -p "${GREMION_ROOT}/data/cd/host-backup/${BACKUP_NAME}/lib/cd/core.sh" "$r/lib/cd/core.sh"
    # a unit installed after the backup
    printf '[Unit]\nDescription=later\n' > "${GREMION_SYSTEMD_DIR}/gremion-cd-later.service"
    before="$(set_digest)"
    apply
    [ "$status" -eq 2 ] || { echo "later unit: ${status}: ${output}"; return 1; }
    refute_recorded bootstrap "cd"
    [ "$(set_digest)" = "$before" ]
    rm -f "${GREMION_SYSTEMD_DIR}/gremion-cd-later.service"
    # the installed set is the backup again: the apply goes ahead
    apply
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    assert_recorded bootstrap "cd mode=ok"
}

@test "an installed file that is a symlink is refused: it is not the backup's bytes, whatever it points at" {
    make_backup
    local r="$GREMION_ROOT" before
    # same bytes as the backup, so only the link itself can make this refuse
    cp "$r/bin/gremion-other" "${BATS_TEST_TMPDIR}/other.real"
    rm -f "$r/bin/gremion-other"
    ln -s "${BATS_TEST_TMPDIR}/other.real" "$r/bin/gremion-other"
    before="$(set_digest)"
    apply
    [ "$status" -eq 2 ] || { echo "${status}: ${output}"; return 1; }
    refute_recorded bootstrap "cd"
    [ "$(set_digest)" = "$before" ]
}
