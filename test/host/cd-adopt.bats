#!/usr/bin/env bats
# test/host/cd-adopt.bats -- cd-adopt: infra/host/lib/cd/adopt.sh, adoption of a running host,
# the host manifest, the deploy-user side of the apply of host programs, the apply of the state
# tier and the self-test of gremion-cd.
#
# Run: MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W):/repo:ro" -w /repo gremion-bats:local test/host/cd-adopt.bats
#
# Nothing here touches a real docker, sudo, systemctl, curl or network: they are recording
# shims over a throwaway $GREMION_ROOT (test_helper/cd-adopt) whose two release trees are real
# git work trees. The libraries that other units own and that are not built yet (traffic, watch)
# are the stubs of test_helper/cd; a refusal test flips the stub and watches adopt refuse.
# Every name is a reserved example name; no customer is ever named.

bats_require_minimum_version 1.5.0
load 'test_helper/host'
load 'test_helper/cd'
load 'test_helper/cd-notify'
load 'test_helper/cd-adopt'

setup() {
    ad_setup
}

teardown() {
    cd_teardown
}

STATE="data/cd/state.json"

# ad_adopted -- the first adoption of the fake host, which must succeed.
ad_adopted() {
    run adlib 'cd_cmd_adopt'
    [ "$status" -eq 0 ] || { echo "$output" >&2; return 1; }
}

# ad_state_edit FILTER -- rewrite state.json through jq (the test's own hand on the record).
ad_state_edit() {
    jq "$1" "${GREMION_ROOT}/${STATE}" > "${GREMION_ROOT}/.state.new"
    mv -f "${GREMION_ROOT}/.state.new" "${GREMION_ROOT}/${STATE}"
    chmod 600 "${GREMION_ROOT}/${STATE}"
}

# ad_order PATTERN... -- every pattern is in the shim log, in this order.
ad_order() {
    local last=0 n p
    for p in "$@"; do
        n="$(grep -nF -m1 -- "$p" "$SHIM_LOG" | cut -d: -f1)"
        if [[ -z "$n" ]]; then
            echo "ad_order: not in the shim log: ${p}" >&2
            cat "$SHIM_LOG" >&2
            return 1
        fi
        if ((n <= last)); then
            echo "ad_order: out of order: ${p}" >&2
            cat "$SHIM_LOG" >&2
            return 1
        fi
        last="$n"
    done
}

# ---------------------------------------------------------------- the manifest

@test "manifest: written from the manifest set of the tree, mode 0600, with the sha12 and the time" {
    run adlib 'cd_manifest_write "${GREMION_ROOT}/releases/${A12}"'
    [ "$status" -eq 0 ]
    f="${GREMION_ROOT}/data/cd/host-manifest.json"
    [ "$(stat -c %a "$f")" = 600 ]
    jq -e --arg s "$A12" '.v == 1 and .sha12 == $s and (.applied_at | test("^2023-")) and (.files | length) == 8
        and (.files | has("infra/host/bin/gremion-x")) and (.files | has("infra/host/bootstrap.sh"))
        and (.files | has("infra/host/lib/cd/core.sh")) and (.files | has("infra/host/templates/env/x.env.tmpl"))
        and (.files | has("README.md") | not)' "$f"
}

@test "manifest: the classifier finds no host-program difference against what was written (parity with classify.sh)" {
    run adlib 'cd_manifest_write "${GREMION_ROOT}/releases/${A12}"
        t="${GREMION_ROOT}/releases/${A12}"
        cd_classify "$t" "$t" --no-compose | jq -c "{changed: .host.changed, held: ([.holds[].reason] | index(\"host_programs\"))}"'
    [ "$status" -eq 0 ]
    [[ "$output" == *'"changed":0'* ]]
    [[ "$output" == *'"held":null'* ]]
}

@test "manifest: a tree with no file of the manifest set is refused and no manifest appears" {
    w="${GREMION_ROOT}/releases/aaaaaaaaaaaa-empty"
    mkdir -p "$w"
    ad_git -C "$w" init -q -b main
    printf 'x\n' > "$w/README.md"
    ad_git -C "$w" add -A
    ad_git -C "$w" commit -q -m e
    run adlib 'rc=0; cd_manifest_write "'"$w"'" || rc=$?; echo rc=$rc'
    [[ "$output" == *"rc=1"* ]]
    run test -e "${GREMION_ROOT}/data/cd/host-manifest.json"
    [ "$status" -ne 0 ]
}

@test "manifest diff: no output when the tree is what was applied" {
    run adlib 'cd_manifest_write "${GREMION_ROOT}/releases/${A12}"; rc=0; cd_manifest_diff "${GREMION_ROOT}/releases/${A12}" || rc=$?; echo "rc=$rc"'
    [ "$status" -eq 0 ]
    [ "$output" = "rc=0" ]
}

@test "manifest diff: the current link is accepted as the tree (status passes it), and a change under it is seen" {
    run adlib 'cd_manifest_write "${GREMION_ROOT}/releases/${A12}"; rc=0; cd_manifest_diff "${GREMION_ROOT}/current" || rc=$?; echo "rc=$rc"'
    [ "$output" = "rc=0" ]
    printf '# core changed\n' > "${GREMION_ROOT}/releases/${A12}/infra/host/lib/cd/core.sh"
    ad_git -C "${GREMION_ROOT}/releases/${A12}" commit -q -a -m changed
    run adlib 'cd_manifest_diff "${GREMION_ROOT}/current"'
    [ "$output" = "infra/host/lib/cd/core.sh" ]
}

@test "manifest diff: lists exactly the changed files, and a file the tree no longer has" {
    run adlib 'cd_manifest_write "${GREMION_ROOT}/releases/${A12}"'
    [ "$status" -eq 0 ]
    # tree B differs from A in every file of the set (the mark is in each); a changed file,
    # an added file and a removed file in a third tree: the one change is the one line
    w="${GREMION_ROOT}/.work-C"
    cp -a "${GREMION_ROOT}/releases/${A12}" "$w"
    printf '# core changed\n' > "$w/infra/host/lib/cd/core.sh"
    printf 'new\n' > "$w/infra/host/bin/gremion-new"
    git -C "$w" rm -q infra/host/templates/env/x.env.tmpl
    ad_git -C "$w" add -A
    ad_git -C "$w" commit -q -m c
    run adlib 'cd_manifest_diff "'"$w"'"'
    [ "$status" -eq 0 ]
    [ "$output" = "$(printf '%s\n' infra/host/bin/gremion-new infra/host/lib/cd/core.sh infra/host/templates/env/x.env.tmpl)" ]
}

@test "manifest diff: an unreadable or missing manifest prints nothing and is not 0 (status counts the lines)" {
    run adlib 'rc=0; cd_manifest_diff "${GREMION_ROOT}/releases/${A12}" 2>/dev/null || rc=$?; echo "rc=$rc"'
    [ "$output" = "rc=2" ]
    printf 'garbage\n' > "${GREMION_ROOT}/data/cd/host-manifest.json"
    run adlib 'rc=0; cd_manifest_diff "${GREMION_ROOT}/releases/${A12}" 2>/dev/null || rc=$?; echo "rc=$rc"'
    [ "$output" = "rc=2" ]
}

# ---------------------------------------------------------------- adopt

@test "adopt: records live and previous from the running system, writes the manifest and queues the adopted mail" {
    run adlib 'cd_cmd_adopt'
    [ "$status" -eq 0 ]
    jq -e --arg a "$SHA_A" --arg b "$SHA_B" --arg root "$GREMION_ROOT" '
        .phase == "idle" and .hold == null and .release == null
        and .live.sha == $a and .live.tag == ("pilot-" + $a[0:12]) and .live.colour == "blue"
        and .live.tree == ($root + "/releases/" + $a[0:12]) and .live.proof == false
        and .previous.sha == $b and .previous.colour == "green" and .previous.startable == true
        and .previous.tree == ($root + "/releases/" + $b[0:12])' "${GREMION_ROOT}/${STATE}"
    jq -e --arg a "$A12" '.sha12 == $a' "${GREMION_ROOT}/data/cd/host-manifest.json"
    [ "$(mail_count)" = 1 ]
    mail_files | grep -q -- '-adopted\.eml$'
    # names only: no host, no address
    [[ "$output" != *"example.org"* ]]
}

@test "adopt: refuses when a container does not run the image its env tag resolves to, and writes nothing" {
    printf 'gremion-ui:pilot-%s sha256:%s\n' "$A12" "$(printf 'f%.0s' $(seq 1 64))" > "${DK}/imgline.cidblue"
    run adlib 'cd_cmd_adopt'
    [ "$status" -eq 1 ]
    [[ "$output" == *"does not run the image"* ]]
    ad_nothing_written
}

@test "adopt: refuses when current is not the tree of the live tag, and writes nothing" {
    ln -sfn "${GREMION_ROOT}/releases/${B12}" "${GREMION_ROOT}/current"
    run adlib 'cd_cmd_adopt'
    [ "$status" -eq 1 ]
    [[ "$output" == *"current link"* ]]
    ad_nothing_written
}

@test "adopt: refuses when the release tree HEAD is not the commit of the tag, and writes nothing" {
    cp -a "${GREMION_ROOT}/releases/${A12}" "${GREMION_ROOT}/releases/cccccccccccc"
    ad_set_live blue cccccccccccccccccccccccccccccccccccccccc
    run adlib 'cd_cmd_adopt'
    [ "$status" -eq 1 ]
    [[ "$output" == *"HEAD is not the commit"* ]]
    ad_nothing_written
}

@test "adopt: refuses a release tree with changes" {
    printf 'x\n' >> "${GREMION_ROOT}/releases/${A12}/README.md"
    run adlib 'cd_cmd_adopt'
    [ "$status" -eq 1 ]
    [[ "$output" == *"has changes"* ]]
    ad_nothing_written
}

@test "adopt: refuses when the public /readyz is not ready through the edge (guard: the probe is really asked)" {
    cd_stub_set cd_watch_probe_public 1
    run adlib 'cd_cmd_adopt'
    [ "$status" -eq 1 ]
    [[ "$output" == *"/readyz is not ready"* ]]
    grep -q '^stub cd_watch_probe_public' "$SHIM_LOG"
    ad_nothing_written
}

@test "adopt: refuses when the edge and runtime/active-colour disagree" {
    cd_stub_set cd_traffic_truth 1
    run adlib 'cd_cmd_adopt'
    [ "$status" -eq 1 ]
    ad_nothing_written
    cd_stub_set cd_traffic_truth 0 green
    run adlib 'cd_cmd_adopt'
    [ "$status" -eq 1 ]
    ad_nothing_written
}

@test "adopt: refuses on a repository without the rules, or without squash-only merging" {
    cd_stub_set cd_gh_rules_ok 3
    run adlib 'cd_cmd_adopt'
    [ "$status" -eq 1 ]
    [[ "$output" == *"repository rules"* ]]
    ad_nothing_written
    cd_stub_set cd_gh_rules_ok 0
    cd_stub_set cd_gh_merge_methods_ok 1
    run adlib 'cd_cmd_adopt'
    [ "$status" -eq 1 ]
    [[ "$output" == *"merge methods"* ]]
    ad_nothing_written
}

@test "adopt: the REAL rules and merge-method checks (github.sh) pass on the recorded answer, with no state file and no lock held by the caller" {
    ad_real_github "${HOST_TEST_DIR}/fixtures/cd/github/rules-main.json"
    run adlib 'cd_cmd_adopt'
    [ "$status" -eq 0 ] || { echo "$output" >&2; return 1; }
    jq -e '.live.colour == "blue"' "${GREMION_ROOT}/${STATE}"
}

@test "adopt: the REAL checks refuse a repository without a rule, or without linear history" {
    jq 'map(select(.type != "deletion"))' "${HOST_TEST_DIR}/fixtures/cd/github/rules-main.json" > "${GREMION_ROOT}/.rules-nodel.json"
    ad_real_github "${GREMION_ROOT}/.rules-nodel.json"
    run adlib 'cd_cmd_adopt'
    [ "$status" -eq 1 ]
    [[ "$output" == *"repository rules"* ]]
    ad_nothing_written
    jq 'map(select(.type != "required_linear_history"))' "${HOST_TEST_DIR}/fixtures/cd/github/rules-main.json" > "${GREMION_ROOT}/.rules-nolin.json"
    ad_real_github "${GREMION_ROOT}/.rules-nolin.json"
    run adlib 'cd_cmd_adopt'
    [ "$status" -eq 1 ]
    [[ "$output" == *"merge methods"* ]]
    ad_nothing_written
}

@test "adopt: refuses when the state file already exists (no silent re-adopt) and leaves it as it was" {
    ad_adopted
    cp "${GREMION_ROOT}/${STATE}" "${GREMION_ROOT}/.state.before"
    run adlib 'cd_cmd_adopt'
    [ "$status" -eq 2 ]
    [[ "$output" == *"already adopted"* ]]
    cmp "${GREMION_ROOT}/.state.before" "${GREMION_ROOT}/${STATE}"
}

@test "adopt: a missing active-colour file or an env file without a release tag is a precondition (2), nothing written" {
    rm -f "${GREMION_ROOT}/runtime/active-colour"
    run adlib 'cd_cmd_adopt'
    [ "$status" -eq 2 ]
    ad_nothing_written
    printf 'blue\n' > "${GREMION_ROOT}/runtime/active-colour"
    ad_set_env_tag blue latest
    run adlib 'cd_cmd_adopt'
    [ "$status" -eq 2 ]
    ad_nothing_written
}

@test "adopt: a previous colour whose tree is missing or whose tag is no release tag gives previous null, said out loud" {
    ad_set_other green ffffffffffffffffffffffffffffffffffffffff
    run adlib 'cd_cmd_adopt'
    [ "$status" -eq 0 ]
    [[ "$output" == *"previous: none"* ]]
    jq -e '.previous == null' "${GREMION_ROOT}/${STATE}"
    rm -f "${GREMION_ROOT}/${STATE}" "${GREMION_ROOT}/data/cd/host-manifest.json"
    ad_set_other green none
    run adlib 'cd_cmd_adopt'
    [ "$status" -eq 0 ]
    jq -e '.previous == null' "${GREMION_ROOT}/${STATE}"
}

@test "adopt: the verb is wired into the dispatcher (a usage error exits 2 before anything is read)" {
    run cd_prog adopt --reason nothing
    [ "$status" -eq 2 ]
    run cd_prog adopt --re-adopt
    [ "$status" -eq 2 ]
    [[ "$output" == *"--reason"* ]]
}

# ---------------------------------------------------------------- re-adopt

# ad_hand_upgrade -- the host is upgraded by hand to a new release C on green; blue keeps A.
ad_hand_upgrade() {
    SHA_C="$(ad_make_tree C)"
    C12="${SHA_C:0:12}"
    export SHA_C C12
    ad_set_live green "$SHA_C"
    ad_set_other blue "$SHA_A"
    ad_container blue "$SHA_A"
}

@test "re-adopt: after a hand upgrade it rewrites live, previous and the manifest from the running system" {
    ad_adopted
    ad_hand_upgrade
    run adlib 'cd_cmd_adopt --re-adopt --reason "hand upgrade to the board release"'
    [ "$status" -eq 0 ]
    jq -e --arg c "$SHA_C" --arg a "$SHA_A" '.live.sha == $c and .live.colour == "green"
        and .previous.sha == $a and .previous.colour == "blue" and .previous.startable == true' "${GREMION_ROOT}/${STATE}"
    jq -e --arg c "$C12" '.sha12 == $c' "${GREMION_ROOT}/data/cd/host-manifest.json"
}

@test "re-adopt: keeps blocked.json, history.jsonl and the notified map byte for byte, and the hold (guard: it must not clear the blocks)" {
    ad_adopted
    printf '[{"sha":"%s","sha12":"%s","tag":"pilot-%s","at":"2026-11-01T00:00:00Z","rule":"build_failed","detail":"x","cleared":null}]\n' \
        "$SHA_B" "$B12" "$B12" > "${GREMION_ROOT}/data/cd/blocked.json"
    ad_state_edit '.notified = {"held:abc": "2026-11-01T00:00:00Z"} | .hold = {kind: "blocked", reason: "build_failed", sha12: "'"$B12"'", since: "2026-11-01T00:00:00Z"}'
    ad_hand_upgrade
    cp "${GREMION_ROOT}/data/cd/blocked.json" "${GREMION_ROOT}/.blocked.before"
    cp "${GREMION_ROOT}/data/cd/history.jsonl" "${GREMION_ROOT}/.hist.before"
    jq -S .notified "${GREMION_ROOT}/${STATE}" > "${GREMION_ROOT}/.notified.before"
    run adlib 'cd_cmd_adopt --re-adopt --reason "hand upgrade"'
    [ "$status" -eq 0 ]
    cmp "${GREMION_ROOT}/.blocked.before" "${GREMION_ROOT}/data/cd/blocked.json"
    cmp -n "$(stat -c %s "${GREMION_ROOT}/.hist.before")" "${GREMION_ROOT}/.hist.before" "${GREMION_ROOT}/data/cd/history.jsonl"
    jq -S .notified "${GREMION_ROOT}/${STATE}" | cmp - "${GREMION_ROOT}/.notified.before"
    jq -e '.hold.kind == "blocked" and .phase == "idle"' "${GREMION_ROOT}/${STATE}"
}

@test "re-adopt: logs the reason and queues the adopted mail (the mail carries a code, never the text)" {
    ad_adopted
    ad_hand_upgrade
    run adlib 'cd_cmd_adopt --re-adopt --reason "hand upgrade to the board release"'
    [ "$status" -eq 0 ]
    tail -n 5 "${GREMION_ROOT}/data/cd/history.jsonl" | grep -F '"event":"adopted"' | grep -qF '"reason":"hand upgrade to the board release"'
    [ "$(mail_count)" = 2 ]
    last="$(grep -l 're_adopt' $(mail_files))"
    [ -n "$last" ]
    refute_in "$last" "board release"
}

@test "re-adopt: the same release keeps what the record learned about it (since, reconcile counts)" {
    ad_adopted
    ad_state_edit '.live.since = "2026-11-02T00:00:00Z" | .live.reconcile = {at: "2026-11-02T00:10:00Z", total: 3, ok: 3, failed: 0, timeout: 0, busy: 0, skipped: 0, invalid: 0, seconds: 40, reason: null}'
    run adlib 'cd_cmd_adopt --re-adopt --reason "check"'
    [ "$status" -eq 0 ]
    jq -e '.live.since == "2026-11-02T00:00:00Z" and .live.reconcile.total == 3' "${GREMION_ROOT}/${STATE}"
}

@test "re-adopt: refused without a reason, with a reason that is not one line, and with no state to re-adopt" {
    ad_adopted
    run adlib 'cd_cmd_adopt --re-adopt'
    [ "$status" -eq 2 ]
    run adlib 'cd_cmd_adopt --re-adopt --reason "$(printf "a\nb")"'
    [ "$status" -eq 2 ]
    rm -f "${GREMION_ROOT}/${STATE}"
    run adlib 'cd_cmd_adopt --re-adopt --reason "x"'
    [ "$status" -eq 2 ]
    [[ "$output" == *"no state file"* ]]
}

@test "re-adopt: refused while a release is in flight (releasing, watching, rolling_back), the state untouched" {
    ad_adopted
    ad_hand_upgrade
    for ph in releasing watching rolling_back; do
        ad_state_edit ".phase = \"$ph\""
        cp "${GREMION_ROOT}/${STATE}" "${GREMION_ROOT}/.state.before"
        run adlib 'cd_cmd_adopt --re-adopt --reason "x"'
        [ "$status" -eq 3 ]
        [[ "$output" == *"in flight"* ]]
        cmp "${GREMION_ROOT}/.state.before" "${GREMION_ROOT}/${STATE}"
    done
}

@test "re-adopt: refused while another gremion-cd holds the cd lock" {
    cd_need_flock
    ad_adopted
    cd_bg 'cd_lock_take; echo ready; exec sleep 300'
    run adlib 'cd_cmd_adopt --re-adopt --reason "x"'
    [ "$status" -eq 3 ]
}

@test "re-adopt: allowed when parked, and clears nothing else (the hold stays)" {
    ad_adopted
    ad_state_edit '.phase = "parked" | .hold = {kind: "failure", reason: "watch_pause_cap", sha12: "", since: "2026-11-01T00:00:00Z"}'
    run adlib 'cd_cmd_adopt --re-adopt --reason "rolled back by hand"'
    [ "$status" -eq 0 ]
    jq -e '.phase == "parked" and .hold.kind == "failure"' "${GREMION_ROOT}/${STATE}"
}

@test "re-adopt: a state without live (a first adopt that stopped half way) is repaired, not refused" {
    ad_adopted
    ad_state_edit '.live = null | .previous = null'
    run adlib 'cd_cmd_adopt --re-adopt --reason "finish the adoption"'
    [ "$status" -eq 0 ]
    jq -e --arg a "$SHA_A" '.live.sha == $a' "${GREMION_ROOT}/${STATE}"
}

@test "re-adopt: refuses on any mismatch like adopt does, and leaves the record as it was" {
    ad_adopted
    ad_hand_upgrade
    ln -sfn "${GREMION_ROOT}/releases/${A12}" "${GREMION_ROOT}/current"
    cp "${GREMION_ROOT}/${STATE}" "${GREMION_ROOT}/.state.before"
    run adlib 'cd_cmd_adopt --re-adopt --reason "x"'
    [ "$status" -eq 1 ]
    cmp "${GREMION_ROOT}/.state.before" "${GREMION_ROOT}/${STATE}"
}

# ---------------------------------------------------------------- apply of host programs

# the snippet that holds both locks like release-now does, then applies tree B
ad_apply_host() {
    adlib 'cd_lock_take; cd_hostlock_take
        rc=0; cd_adopt_apply_host "${GREMION_ROOT}/releases/${B12}" || rc=$?; echo "rc=$rc"'
}

@test "apply-host: the installed set is copied to host-backup/<time> first, pending points at it, then the shim is started with exactly the documented argv" {
    run adlib 'cd_manifest_write "${GREMION_ROOT}/releases/${A12}"'
    before="$(sha256sum < "${GREMION_ROOT}/data/cd/host-manifest.json" | cut -c1-64)"
    run ad_apply_host
    [[ "$output" == *"rc=0"* ]]
    assert_recorded sudo "-n systemctl start --wait gremion-cd-apply@${B12}.service"
    # at the moment the unit started: the pending link existed and the manifest was still the old one
    grep -q "^pending=${GREMION_ROOT}/data/cd/host-backup/" "${DK}/sudo.seen"
    grep -q "^manifest=${before}$" "${DK}/sudo.seen"
    pend="${GREMION_ROOT}/data/cd/host-backup/pending"
    [ -L "$pend" ]
    dir="$(readlink "$pend")"
    [ "$(stat -c %a "$dir")" = 700 ]
    [ "$(stat -c %a "${GREMION_ROOT}/data/cd/host-backup")" = 700 ]
    cmp "${dir}/set/bin/gremion-x" "${GREMION_ROOT}/bin/gremion-x"
    cmp "${dir}/set/lib/cd/core.sh" "${GREMION_ROOT}/lib/cd/core.sh"
    cmp "${dir}/set/units/gremion-cd.service" "${GREMION_CD_SYSTEMD_DIR}/gremion-cd.service"
    run test -e "${dir}/set/units/unrelated.service"
    [ "$status" -ne 0 ]
    h="$(sha256sum < "${GREMION_ROOT}/bin/gremion-x" | cut -c1-64)"
    grep -q "^${h}  bin/gremion-x$" "${dir}/INDEX"
}

@test "apply-host: the manifest is rewritten only after the unit exited 0, and then it is the new tree's" {
    run adlib 'cd_manifest_write "${GREMION_ROOT}/releases/${A12}"'
    run ad_apply_host
    [[ "$output" == *"rc=0"* ]]
    jq -e --arg b "$B12" '.sha12 == $b' "${GREMION_ROOT}/data/cd/host-manifest.json"
}

@test "apply-host: when the unit fails the function fails, the manifest is untouched and the backup is left for the restore" {
    run adlib 'cd_manifest_write "${GREMION_ROOT}/releases/${A12}"'
    cp "${GREMION_ROOT}/data/cd/host-manifest.json" "${GREMION_ROOT}/.manifest.before"
    printf '1\n' > "${GREMION_ROOT}/.sudo.rc"
    run ad_apply_host
    [[ "$output" == *"rc=1"* ]]
    cmp "${GREMION_ROOT}/.manifest.before" "${GREMION_ROOT}/data/cd/host-manifest.json"
    [ -L "${GREMION_ROOT}/data/cd/host-backup/pending" ]
}

@test "apply-host: nothing in the deploy-user process writes the systemd directory" {
    before="$(cd "$GREMION_CD_SYSTEMD_DIR" && sha256sum ./* | sha256sum)"
    run ad_apply_host
    [[ "$output" == *"rc=0"* ]]
    [ "$before" = "$(cd "$GREMION_CD_SYSTEMD_DIR" && sha256sum ./* | sha256sum)" ]
}

@test "apply-host: a pending link that points outside data/cd is refused before anything is touched" {
    mkdir -p "${GREMION_ROOT}/data/cd/host-backup" "${GREMION_ROOT}/elsewhere"
    chmod 700 "${GREMION_ROOT}/data/cd/host-backup"
    ln -s "${GREMION_ROOT}/elsewhere" "${GREMION_ROOT}/data/cd/host-backup/pending"
    run ad_apply_host
    [[ "$output" == *"rc=2"* ]]
    [[ "$output" == *"outside"* ]]
    refute_recorded sudo "systemctl"
    run find "${GREMION_ROOT}/data/cd/host-backup" -mindepth 1 -maxdepth 1 -not -name pending
    [ -z "$output" ]
}

@test "apply-host: host-backup as a symlink, or pending as a plain directory, is refused" {
    mkdir -p "${GREMION_ROOT}/elsewhere"
    ln -s "${GREMION_ROOT}/elsewhere" "${GREMION_ROOT}/data/cd/host-backup"
    run ad_apply_host
    [[ "$output" == *"rc=2"* ]]
    refute_recorded sudo "systemctl"
    rm -f "${GREMION_ROOT}/data/cd/host-backup"
    mkdir -p "${GREMION_ROOT}/data/cd/host-backup/pending"
    chmod 700 "${GREMION_ROOT}/data/cd/host-backup"
    run ad_apply_host
    [[ "$output" == *"rc=2"* ]]
    refute_recorded sudo "systemctl"
}

@test "apply-host: a tree that is not releases/<sha12> of its own HEAD, or no locks, are refused" {
    cp -a "${GREMION_ROOT}/releases/${A12}" "${GREMION_ROOT}/releases/dddddddddddd"
    run adlib 'cd_lock_take; cd_hostlock_take
        rc=0; cd_adopt_apply_host "${GREMION_ROOT}/releases/dddddddddddd" || rc=$?; echo "rc=$rc"'
    [[ "$output" == *"rc=2"* ]]
    run adlib 'rc=0; cd_adopt_apply_host "${GREMION_ROOT}/releases/${B12}" || rc=$?; echo "rc=$rc"'
    [[ "$output" == *"rc=2"* ]]
    run adlib 'cd_lock_take; rc=0; cd_adopt_apply_host "${GREMION_ROOT}/releases/${B12}" || rc=$?; echo "rc=$rc"'
    [[ "$output" == *"rc=2"* ]]
    refute_recorded sudo "systemctl"
}

# ---------------------------------------------------------------- apply of the state tier

CLASS_STATE='{"v":1,"app_only":false,"state_tier":["compose_state:legal"],"holds":[{"kind":"state_tier","reason":"compose_state:legal"}],"hold":null}'
CLASS_PLATFORM='{"v":1,"app_only":false,"state_tier":["compose_state:legal","platform_migration"],"holds":[{"kind":"state_tier","reason":"compose_state:legal"}],"hold":null}'

# ad_state_setup CLASS_JSON -- the live record, the stubs that record, and a tenant program
# that writes what it saw into the shim log.
ad_state_setup() {
    if [[ ! -e "${GREMION_ROOT}/${STATE}" ]]; then ad_adopted; fi
    : > "$SHIM_LOG"
    export AD_OVERRIDE="cd_data_dumpset_take cd_classify cd_prepare_render cd_wait_healthy"
    cd_stub_set cd_classify 0 "$1"
    printf '#!/bin/sh\nprintf "tenant-init args=%%s lock_held=%%s release_dir=%%s\\n" "$*" "${GREMION_HOST_LOCK_HELD:-unset}" "${GREMION_RELEASE_DIR:-}" >> "$SHIM_LOG"\n[ -f "$DK/tenant.fail" ] && exit 1\nexit 0\n' \
        > "${GREMION_ROOT}/releases/${B12}/infra/host/bin/gremion-tenant"
    # what each stub saw of state.env and of the previous-state-tag at the moment it ran
    export AD_SEEN="${DK}/seen"
    : > "$AD_SEEN"
}

ad_apply_state() {
    adlib 'cd_data_dumpset_take() { local r=0; _cd_stub_call cd_data_dumpset_take "$@" || r=$?
            printf "dump tag=%s prev=%s\n" "$(grep ^IMAGE_TAG= "${GREMION_ROOT}/etc/env/state.env")" "$([ -e "${GREMION_ROOT}/data/cd/previous-state-tag" ] && echo yes || echo no)" >> "$AD_SEEN"; return "$r"; }
        cd_prepare_render() { local r=0; _cd_stub_call cd_prepare_render "$@" || r=$?
            printf "render tag=%s prev=%s\n" "$(grep ^IMAGE_TAG= "${GREMION_ROOT}/etc/env/state.env")" "$(cat "${GREMION_ROOT}/data/cd/previous-state-tag" 2>/dev/null)" >> "$AD_SEEN"; return "$r"; }
        cd_lock_take; cd_hostlock_take
        rc=0; cd_adopt_apply_state "${GREMION_ROOT}/releases/${B12}" || rc=$?; echo "rc=$rc applied=$CD_ADOPT_STATE_APPLIED"'
}

@test "apply-state: the state dump set first, then the previous tag is recorded, then retag, build, render, up, healthy and the edge, in that order" {
    ad_state_setup "$CLASS_STATE"
    run ad_apply_state
    [[ "$output" == *"rc=0 applied=1"* ]]
    # the dump saw the OLD tag and no previous-state-tag; the render saw the NEW tag and the old one recorded
    grep -q "^dump tag=IMAGE_TAG=pilot-aaaaaaaaaaaa prev=no$" "$AD_SEEN"
    grep -q "^render tag=IMAGE_TAG=pilot-${B12} prev=pilot-aaaaaaaaaaaa$" "$AD_SEEN"
    [ "$(cat "${GREMION_ROOT}/data/cd/previous-state-tag")" = "pilot-aaaaaaaaaaaa" ]
    [ "$(stat -c %a "${GREMION_ROOT}/data/cd/previous-state-tag")" = 600 ]
    grep -q "^IMAGE_TAG=pilot-${B12}$" "${GREMION_ROOT}/etc/env/state.env"
    ad_order "stub cd_data_dumpset_take state-pilot-${B12} state" \
        "build" "stub cd_prepare_render" "up -d --pull never" \
        "stub cd_wait_healthy state" "stub cd_watch_probe_public"
    # the dump set is the state scope, never an app set, and compose is only ever the state project
    refute_recorded stub "cd_data_dumpset_take state-pilot-${B12} app"
    grep -q "state.env" <<<"$(grep '^docker compose' "$SHIM_LOG" | grep ' build')"
}

@test "apply-state: the output says the state tier is not rolled back automatically" {
    ad_state_setup "$CLASS_STATE"
    run ad_apply_state
    [[ "$output" == *"NOT rolled back automatically"* ]]
    [[ "$output" == *"previous-state-tag"* ]]
}

@test "apply-state: gremion-tenant init only when the class has platform_migration, with GREMION_HOST_LOCK_HELD=1 exported" {
    ad_state_setup "$CLASS_STATE"
    run ad_apply_state
    [[ "$output" == *"rc=0"* ]]
    refute_recorded tenant-init "args="
    ad_state_setup "$CLASS_PLATFORM"
    run ad_apply_state
    [[ "$output" == *"rc=0"* ]]
    assert_recorded tenant-init "args=init lock_held=1 release_dir=${GREMION_ROOT}/releases/${B12}"
    ad_order "stub cd_prepare_render" "tenant-init" "up -d --pull never"
}

@test "apply-state: a hold stage 1 cannot apply is refused even when it is not the first hold, and nothing changes" {
    ad_state_setup '{"v":1,"app_only":false,"state_tier":["edge"],"holds":[{"kind":"state_tier","reason":"edge"},{"kind":"unsupported_chain","reason":"module_declaration_changed:board"}],"hold":null}'
    run ad_apply_state
    [[ "$output" == *"rc=2"* ]]
    [[ "$output" == *"unsupported_chain"* ]]
    refute_recorded stub "cd_data_dumpset_take"
    grep -q "^IMAGE_TAG=pilot-aaaaaaaaaaaa$" "${GREMION_ROOT}/etc/env/state.env"
    run test -e "${GREMION_ROOT}/data/cd/previous-state-tag"
    [ "$status" -ne 0 ]
    for k in contract_migration waived_migration classify_failed; do
        cd_stub_set cd_classify 0 "{\"v\":1,\"app_only\":false,\"state_tier\":[],\"holds\":[{\"kind\":\"$k\",\"reason\":\"x\"}],\"hold\":null}"
        run ad_apply_state
        [[ "$output" == *"rc=2"* ]]
    done
    refute_recorded stub "cd_data_dumpset_take"
}

@test "apply-state: a failed dump set stops everything before the first change (4 for an infrastructure failure)" {
    ad_state_setup "$CLASS_STATE"
    cd_stub_set cd_data_dumpset_take 4
    run ad_apply_state
    [[ "$output" == *"rc=4"* ]]
    grep -q "^IMAGE_TAG=pilot-aaaaaaaaaaaa$" "${GREMION_ROOT}/etc/env/state.env"
    run test -e "${GREMION_ROOT}/data/cd/previous-state-tag"
    [ "$status" -ne 0 ]
    refute_recorded stub "cd_prepare_render"
}

@test "apply-state: a failed build (an infrastructure failure is 4, the commit's own is 1) never reaches up; the previous tag stays recorded" {
    ad_state_setup "$CLASS_STATE"
    printf 'no space left on device\n' > "${DK}/build.fail"
    run ad_apply_state
    [[ "$output" == *"rc=4"* ]]
    refute_recorded docker "up -d"
    [ "$(cat "${GREMION_ROOT}/data/cd/previous-state-tag")" = "pilot-aaaaaaaaaaaa" ]
    printf 'failed to solve: dockerfile parse error on line 3\n' > "${DK}/build.fail"
    run ad_apply_state
    [[ "$output" == *"rc=1"* ]]
    refute_recorded docker "up -d"
    # the second try finds state.env already retagged: it must not record the NEW tag as the
    # one to go back to (the record of the first try stays)
    [ "$(cat "${GREMION_ROOT}/data/cd/previous-state-tag")" = "pilot-aaaaaaaaaaaa" ]
}

@test "apply-state: state.env already at the target tag and no record of the tag before it is a refusal, nothing taken" {
    ad_state_setup "$CLASS_STATE"
    sed -i "s#^IMAGE_TAG=.*#IMAGE_TAG=pilot-${B12}#" "${GREMION_ROOT}/etc/env/state.env"
    run ad_apply_state
    [[ "$output" == *"rc=2"* ]]
    [[ "$output" == *"no record"* ]]
    refute_recorded stub "cd_data_dumpset_take"
}

@test "apply-state: a state project that does not become healthy, or an edge that does not answer, is a failure (1)" {
    ad_state_setup "$CLASS_STATE"
    cd_stub_set cd_wait_healthy 3
    run ad_apply_state
    [[ "$output" == *"rc=1 applied=0"* ]]
    cd_stub_set cd_wait_healthy 0
    cd_stub_set cd_watch_probe_public 1
    run ad_apply_state
    [[ "$output" == *"rc=1 applied=0"* ]]
}

@test "apply-state: a failing platform init is a failure and compose up is never reached" {
    ad_state_setup "$CLASS_PLATFORM"
    : > "${DK}/tenant.fail"
    run ad_apply_state
    [[ "$output" == *"rc=1"* ]]
    refute_recorded docker "up -d"
}

@test "apply-state: without the cd lock and the host lock it refuses and changes nothing" {
    ad_state_setup "$CLASS_STATE"
    run adlib 'rc=0; cd_adopt_apply_state "${GREMION_ROOT}/releases/${B12}" || rc=$?; echo "rc=$rc"'
    [[ "$output" == *"rc=2"* ]]
    run adlib 'cd_lock_take; rc=0; cd_adopt_apply_state "${GREMION_ROOT}/releases/${B12}" || rc=$?; echo "rc=$rc"'
    [[ "$output" == *"rc=2"* ]]
    refute_recorded stub "cd_data_dumpset_take"
}

# ---------------------------------------------------------------- selftest

# ad_green -- adopted, and everything a green selftest needs behind it.
ad_green() {
    ad_adopted
    printf 'cidpg\n' > "${DK}/cid.teststack-state.postgres"
    cd_write_cfg CD_MIN_FREE_GB=0
}

# ad_selftest [ARGS] -- the verb under a fresh shell.
ad_selftest() {
    adlib "cd_cmd_selftest $*"
}

# ad_one_failure CHECK -- exactly one failing check, and it is CHECK.
ad_one_failure() {
    [ "$status" -eq 1 ]
    [[ "$output" == *"FAIL  $1"* ]] || { echo "$output" >&2; return 1; }
    [ "$(printf '%s\n' "$output" | grep -c '^FAIL')" -eq 1 ] || { echo "$output" >&2; return 1; }
}

@test "selftest: all green exits 0, every check says ok, one test mail of kind selftest goes out and no address is printed" {
    ad_green
    run ad_selftest
    [ "$status" -eq 0 ] || { echo "$output" >&2; return 1; }
    for c in config state dump_dir lock_span mirror rules merge_methods docker disk locks mail_transport probe_host probe_customer timers test_mail; do
        [[ "$output" == *"ok    ${c}"* ]] || { echo "missing ok ${c}"; echo "$output"; return 1; }
    done
    # the queued adopted mail goes with the flush; exactly one of the sent mails is the test mail
    [ "$(grep -l 'kind: selftest' "${GREMION_ROOT}"/.sent.* | wc -l | tr -d ' ')" = 1 ]
    [[ "$output" != *"@"* ]]
    # the probe host reaches psql on stdin only
    run grep -c 'app.example.org' "${DK}/psql.argv"
    [ "$output" = 0 ]
    grep -q "app.example.org" "${DK}/psql.stdin"
}

@test "selftest: a bad config is refused by the dispatcher (exit 2) before any check" {
    ad_green
    cd_write_cfg CD_MAIL_TO=CHANGE_ME_OPERATOR_MAIL
    run cd_prog selftest
    [ "$status" -eq 2 ]
}

@test "selftest: a missing state file, a broken state file and a state with no live release fail the state check" {
    ad_green
    ad_state_edit '.v = 7'
    run ad_selftest
    ad_one_failure state
    ad_state_edit '.v = 1 | .live = null'
    run ad_selftest
    ad_one_failure state
    rm -f "${GREMION_ROOT}/${STATE}"
    run ad_selftest
    ad_one_failure state
}

@test "selftest: a missing dump directory fails dump_dir" {
    ad_green
    rmdir "${GREMION_ROOT}/data/migration-dumps"
    run ad_selftest
    ad_one_failure dump_dir
    mkdir "${GREMION_ROOT}/data/migration-dumps"
    chmod 755 "${GREMION_ROOT}/data/migration-dumps"
    run ad_selftest
    ad_one_failure dump_dir
}

@test "selftest: a lock span below the sum of the stage caps fails lock_span" {
    ad_green
    cd_write_cfg CD_MIN_FREE_GB=0 CD_LOCK_SPAN_MAX_MIN=20
    run ad_selftest
    ad_one_failure lock_span
}

@test "selftest: an unreachable mirror fails mirror" {
    ad_green
    cd_stub_set cd_gh_tip 1
    run ad_selftest
    ad_one_failure mirror
}

@test "selftest: repository rules that are not in force fail rules, wrong merge methods fail merge_methods" {
    ad_green
    cd_stub_set cd_gh_rules_ok 1 non_fast_forward
    run ad_selftest
    ad_one_failure rules
    [[ "$output" == *"non_fast_forward"* ]]
    cd_stub_set cd_gh_rules_ok 0
    cd_stub_set cd_gh_merge_methods_ok 1
    run ad_selftest
    ad_one_failure merge_methods
}

@test "selftest: docker down fails docker (and disk, which asks it for its root)" {
    ad_green
    cd_write_cfg CD_MIN_FREE_GB=0
    : > "${DK}/docker.down"
    run ad_selftest
    ad_one_failure docker
}

@test "selftest: low disk fails disk" {
    ad_green
    cd_write_cfg CD_MIN_FREE_GB=999999999
    run ad_selftest
    ad_one_failure disk
}

@test "selftest: a lock that is held fails the lock check, the host lock and the cd lock each" {
    ad_green
    hold_host_lock 30
    run ad_selftest
    ad_one_failure locks
    [[ "$output" == *"host lock is held"* ]]
    release_host_lock
    cd_bg 'cd_lock_take; echo ready; exec sleep 300'
    run ad_selftest
    ad_one_failure locks
    [[ "$output" == *"cd lock is held"* ]]
}

@test "selftest: a mail transport that is not the relay fails mail_transport, a warning when CD_ALLOW_NO_MAIL=1" {
    ad_green
    printf 'stalwart\n' > "${GREMION_ROOT}/.transport"
    run ad_selftest
    ad_one_failure mail_transport
    cd_write_cfg CD_MIN_FREE_GB=0 CD_ALLOW_NO_MAIL=1
    run ad_selftest
    [ "$status" -eq 0 ]
    [[ "$output" == *"warn  mail_transport"* ]]
    [ "$(sent_count)" = 0 ]
}

@test "selftest: a test mail the relay refuses fails test_mail" {
    ad_green
    : > "${GREMION_ROOT}/.curl-fail"
    run ad_selftest
    ad_one_failure test_mail
}

@test "selftest: a probe host that is neither configured nor listed fails probe_host" {
    ad_green
    cd_write_cfg CD_MIN_FREE_GB=0 CD_PROBE_HOST=
    run ad_selftest
    ad_one_failure probe_host
}

@test "selftest: a probe host that maps to no active customer, or a registry that cannot be asked, fails probe_customer" {
    ad_green
    printf '0\n' > "${DK}/psql.count"
    run ad_selftest
    ad_one_failure probe_customer
    printf '1\n' > "${DK}/psql.count"
    : > "${DK}/psql.fail"
    run ad_selftest
    ad_one_failure probe_customer
}

@test "selftest: a guard timer missing from systemctl list-timers fails timers" {
    ad_green
    ad_timers_json gremion-purge.timer
    run ad_selftest
    ad_one_failure timers
}

@test "selftest: a ping that fails once is a warning, not a failure" {
    ad_green
    cd_write_cfg CD_MIN_FREE_GB=0 CD_PING_URL=https://ping.example.org/secret-token-path
    # the relay answers; only the ping URL's request fails
    shim curl "$(cat <<'EOF'
cfg="$(cat)"
printf '%s\n' "$cfg" >> "$GREMION_ROOT/.curl-stdin.all"
case "$cfg" in
  *ping.example.org*) exit 22 ;;
esac
up="$(printf '%s\n' "$cfg" | sed -n 's/^upload-file = "\(.*\)"$/\1/p')"
[ -n "$up" ] && [ -f "$up" ] && cp "$up" "$GREMION_ROOT/.sent.$(date +%s%N)"
exit 0
EOF
)"
    run ad_selftest
    [ "$status" -eq 0 ] || { echo "$output" >&2; return 1; }
    [[ "$output" == *"warn  ping"* ]]
    # the URL (it may carry a token) is on curl's stdin only: no argv, no output
    [[ "$output" != *"secret-token-path"* ]]
    refute_recorded curl "secret-token-path"
    grep -q "ping.example.org/secret-token-path" "${GREMION_ROOT}/.curl-stdin.all"
}

@test "selftest: a ping that answers is ok" {
    ad_green
    cd_write_cfg CD_MIN_FREE_GB=0 CD_PING_URL=https://ping.example.org/x
    run ad_selftest
    [ "$status" -eq 0 ]
    [[ "$output" == *"ok    ping"* ]]
}

@test "selftest --post-apply: the locks ARE held by the caller, so it passes the lock check, sends no mail, and exits 0" {
    cd_need_flock
    ad_green
    cd_bg 'cd_lock_take; cd_hostlock_take; echo ready; exec sleep 300'
    before="$(mail_count)"
    run ad_selftest --post-apply
    [ "$status" -eq 0 ] || { echo "$output" >&2; return 1; }
    [[ "$output" == *"ok    locks"* ]]
    [ "$(sent_count)" = 0 ]
    [ "$(mail_count)" = "$before" ]
    [ "$(curl_calls)" = 0 ]
}

@test "selftest --post-apply: the REAL rules and merge-method checks need neither the cd lock nor a state write (the caller holds the locks)" {
    cd_need_flock
    ad_green
    ad_real_github "${HOST_TEST_DIR}/fixtures/cd/github/rules-main.json"
    cd_bg 'cd_lock_take; cd_hostlock_take; echo ready; exec sleep 300'
    cp "${GREMION_ROOT}/${STATE}" "${GREMION_ROOT}/.state.before"
    run ad_selftest --post-apply
    [ "$status" -eq 0 ] || { echo "$output" >&2; return 1; }
    [[ "$output" == *"ok    rules"* ]]
    [[ "$output" == *"ok    merge_methods"* ]]
    cmp "${GREMION_ROOT}/.state.before" "${GREMION_ROOT}/${STATE}"
}

@test "selftest --post-apply: still fails on any other bad check" {
    cd_need_flock
    ad_green
    cd_bg 'cd_lock_take; cd_hostlock_take; echo ready; exec sleep 300'
    : > "${DK}/docker.down"
    run ad_selftest --post-apply
    ad_one_failure docker
}

@test "selftest: a plain selftest while both locks are held fails (guard: the post-apply logic must not run in the plain mode)" {
    cd_need_flock
    ad_green
    cd_bg 'cd_lock_take; cd_hostlock_take; echo ready; exec sleep 300'
    run ad_selftest
    ad_one_failure locks
}

@test "selftest --post-apply: with the locks free it fails, because the apply is started by a process that holds them" {
    ad_green
    run ad_selftest --post-apply
    ad_one_failure locks
}

@test "selftest: an unknown argument is a usage error" {
    ad_green
    run ad_selftest --nope
    [ "$status" -eq 2 ]
}
