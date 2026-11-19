#!/usr/bin/env bats
# test/host/cd-proof.bats -- the CD proof tooling in scripts/cd-proof/: the three proof
# patches, make-proof-commits.sh (the local bare repository of proof commits), spike.sh
# (the bounded 5xx burst) and run-sheet.md (the proof steps).
#
# Run: MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W):/repo:ro" -w /repo gremion-bats:local test/host/cd-proof.bats
#
# No network, no docker, no real host. The proof commits are built in a throwaway repository
# that holds ONE file, copied from the working tree (the file the patches change), so a patch
# that stops applying to the real file turns the test red. curl and sleep are shims. Every
# host name here is a reserved example name.

bats_require_minimum_version 1.5.0
load 'test_helper/host'

setup() {
    CP_DIR="${KERNEL_ROOT}/scripts/cd-proof"
    MAKE="${CP_DIR}/make-proof-commits.sh"
    SPIKE="${CP_DIR}/spike.sh"
    SHEET="${CP_DIR}/run-sheet.md"
    PATCHES="${CP_DIR}/patches"
    BRANCHES=(proof-readiness-fail proof-window-fail proof-5xx)
    setup_host_root
    export CD_PROOF_STATE_DIR="${BATS_TEST_TMPDIR}/spike-state"
}

teardown() { teardown_host_root; }

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

# cp_src_repo -- a repository with the one real file the patches change, committed.
cp_src_repo() {
    SRC="${BATS_TEST_TMPDIR}/src"
    mkdir -p "${SRC}/gremion-ui/src/routes/readyz"
    # LF and a plain file mode whatever the checkout did (a Windows checkout is CRLF and 0755)
    sed 's/\r$//' "${KERNEL_ROOT}/gremion-ui/src/routes/readyz/+server.ts" >"${SRC}/gremion-ui/src/routes/readyz/+server.ts"
    chmod 644 "${SRC}/gremion-ui/src/routes/readyz/+server.ts"
    git init -q "$SRC"
    git -C "$SRC" add -A
    git -C "$SRC" -c user.name=t -c user.email=t@example.test -c commit.gpgsign=false commit -q -m base </dev/null
    BASE="$(git -C "$SRC" rev-parse HEAD)"
    OUT="${BATS_TEST_TMPDIR}/proof.git"
}

cp_make() { # [extra args...] -- run the maker against the fixture repository
    run bash "$MAKE" "$BASE" --repo "$SRC" --out "$OUT" "$@"
}

# cp_bad_patches NAME BODY -- a copy of the real patches with proof-5xx.patch replaced by BODY.
cp_bad_patches() {
    BAD="${BATS_TEST_TMPDIR}/bad-patches"
    rm -rf "$BAD"
    cp -r "$PATCHES" "$BAD"
    printf '%s\n' "$2" >"${BAD}/proof-5xx.patch"
}

# cp_changed BRANCH -- the files a branch changes against the base.
cp_changed() {
    git -C "$OUT" diff-tree --no-commit-id --name-only -r "$BASE" "refs/heads/$1"
}

# ---------------------------------------------------------------------------
# make-proof-commits.sh
# ---------------------------------------------------------------------------

@test "the scripts parse, are executable and answer --help" {
    bash -n "$MAKE"
    bash -n "$SPIKE"
    [ -x "$MAKE" ]
    [ -x "$SPIKE" ]
    run bash "$MAKE" --help
    [ "$status" -eq 0 ]
    [[ "$output" == *"Usage:"* ]]
    run bash "$SPIKE" --help
    [ "$status" -eq 0 ]
    [[ "$output" == *"Usage:"* ]]
}

@test "makes a bare repository with exactly the three proof branches, each one commit on the given main commit" {
    cp_src_repo
    cp_make
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    [[ "$output" == *"CD_PROOF_REPO=${OUT}"* ]]
    [ "$(git -C "$OUT" rev-parse --is-bare-repository)" = true ]
    heads="$(git -C "$OUT" for-each-ref --format='%(refname:short)' refs/heads | sort | tr '\n' ' ')"
    [ "$heads" = "proof-5xx proof-readiness-fail proof-window-fail " ]
    for b in "${BRANCHES[@]}"; do
        [ "$(git -C "$OUT" rev-list --count "${BASE}..refs/heads/${b}")" = 1 ]
        [ "$(git -C "$OUT" rev-parse "refs/heads/${b}^")" = "$BASE" ]
        # the sha printed for the branch is the branch tip
        tip="$(git -C "$OUT" rev-parse "refs/heads/${b}")"
        [[ "$output" == *"${b} ${tip}"* ]]
    done
}

@test "a short main sha is resolved and the output is self-contained (no alternates, fsck clean)" {
    cp_src_repo
    run bash "$MAKE" "${BASE:0:9}" --repo "$SRC" --out "$OUT"
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    [ ! -e "${OUT}/objects/info/alternates" ]
    run git -C "$OUT" fsck --connectivity-only --no-dangling
    [ "$status" -eq 0 ]
    # the base commit itself is in the output, not borrowed
    git -C "$OUT" cat-file -e "${BASE}^{commit}"
}

@test "the proof commits carry no workstation identity and are reproducible" {
    cp_src_repo
    cp_make
    [ "$status" -eq 0 ]
    for b in "${BRANCHES[@]}"; do
        [ "$(git -C "$OUT" log -1 --format='%an <%ae>|%cn <%ce>' "refs/heads/$b")" = "cd-proof <cd-proof@example.invalid>|cd-proof <cd-proof@example.invalid>" ]
    done
    first="$(git -C "$OUT" rev-parse refs/heads/proof-5xx refs/heads/proof-window-fail refs/heads/proof-readiness-fail)"
    OUT="${BATS_TEST_TMPDIR}/proof2.git"
    cp_make
    [ "$status" -eq 0 ]
    [ "$(git -C "$OUT" rev-parse refs/heads/proof-5xx refs/heads/proof-window-fail refs/heads/proof-readiness-fail)" = "$first" ]
}

@test "the repository the commits are made from is only read" {
    cp_src_repo
    before_objects="$(git -C "$SRC" count-objects -v | grep -E '^(count|in-pack):')"
    before_refs="$(git -C "$SRC" for-each-ref)"
    cp_make
    [ "$status" -eq 0 ]
    [ "$(git -C "$SRC" count-objects -v | grep -E '^(count|in-pack):')" = "$before_objects" ]
    [ "$(git -C "$SRC" for-each-ref)" = "$before_refs" ]
    [ -z "$(git -C "$SRC" status --porcelain)" ]
}

@test "every proof commit changes only gremion-ui files, and no migration" {
    cp_src_repo
    cp_make
    [ "$status" -eq 0 ]
    for b in "${BRANCHES[@]}"; do
        files="$(cp_changed "$b")"
        [ -n "$files" ]
        while IFS= read -r f; do
            [[ "$f" == gremion-ui/* ]] || { echo "outside gremion-ui: $f"; return 1; }
            case "/${f}" in
                */migrations/* | */migration/* | */migrate/* | *.sql) echo "migration path: $f"; return 1 ;;
            esac
        done <<<"$files"
    done
}

@test "the readiness-fail commit changes only the control check: /readyz is 503 for both answers, /healthz is not touched" {
    cp_src_repo
    cp_make
    [ "$status" -eq 0 ]
    [ "$(cp_changed proof-readiness-fail)" = "gremion-ui/src/routes/readyz/+server.ts" ]
    f="$(git -C "$OUT" show "refs/heads/proof-readiness-fail:gremion-ui/src/routes/readyz/+server.ts")"
    # one line is replaced, nothing else: the readiness verdict and both answers are the shipped code
    removed="$(grep -c '^-[^-]' "${PATCHES}/proof-readiness-fail.patch")"
    [ "$removed" -eq 1 ]
    grep -qF '    const controlOk = bootComplete ? (await controlPing()) && false : false' <<<"$f"
    grep -qF '    const ready = bootComplete && controlOk' <<<"$f"
    grep -qF 'if (!isInternalCaller(request)) return answer({ ready }, ready)' <<<"$f"
    grep -qF 'tenants: getTenantReadinessCounts(),' <<<"$f"
    [ "$(git -C "$OUT" diff-tree --no-commit-id --name-only -r "$BASE" refs/heads/proof-readiness-fail | grep -c healthz || true)" = 0 ]
}

@test "the window-fail commit flips /readyz on the flag file and keeps the shape of both answers" {
    cp_src_repo
    cp_make
    [ "$status" -eq 0 ]
    [ "$(cp_changed proof-window-fail)" = "gremion-ui/src/routes/readyz/+server.ts" ]
    f="$(git -C "$OUT" show "refs/heads/proof-window-fail:gremion-ui/src/routes/readyz/+server.ts")"
    grep -qF "import { existsSync } from 'node:fs'" <<<"$f"
    grep -qF "(await controlPing()) && !existsSync('/tmp/cd-proof-fail')" <<<"$f"
    grep -qF '    const ready = bootComplete && controlOk' <<<"$f"
    grep -qF 'colour: process.env.COLOUR' <<<"$f"
    [ "$(git -C "$OUT" diff-tree --no-commit-id --name-only -r "$BASE" refs/heads/proof-window-fail | grep -c healthz || true)" = 0 ]
}

@test "the 5xx commit adds one public page that answers 500 on the flag file and leaves /readyz alone" {
    cp_src_repo
    cp_make
    [ "$status" -eq 0 ]
    [ "$(cp_changed proof-5xx)" = "gremion-ui/src/routes/legal/cd-proof/+server.ts" ]
    f="$(git -C "$OUT" show "refs/heads/proof-5xx:gremion-ui/src/routes/legal/cd-proof/+server.ts")"
    grep -qF "existsSync('/tmp/cd-proof-fail') ? 500 : 200" <<<"$f"
    # the page is under a subtree the session guard lets through without a session
    grep -qF "  '/legal/'," "${KERNEL_ROOT}/gremion-ui/src/hooks.server.ts"
    # the real tree has no such page yet (a patch that creates a file needs the path to be free)
    [ ! -e "${KERNEL_ROOT}/gremion-ui/src/routes/legal/cd-proof" ]
}

@test "spike.sh sends to exactly the page the 5xx patch adds, and every script and sheet names the same flag file" {
    route="$(sed -n 's|^+++ b/gremion-ui/src/routes\(/.*\)/+server.ts$|\1|p' "${PATCHES}/proof-5xx.patch")"
    [ "$route" = "/legal/cd-proof" ]
    grep -qF "SPIKE_PATH='${route}'" "$SPIKE"
    for f in "${PATCHES}/proof-window-fail.patch" "${PATCHES}/proof-5xx.patch" "$SHEET"; do
        grep -qF '/tmp/cd-proof-fail' "$f"
    done
    # one spelling only: no other /tmp/cd-proof* path anywhere in the tooling
    run grep -rhoE '/tmp/cd-proof[A-Za-z0-9._-]*' "$CP_DIR"
    [ "$status" -eq 0 ]
    [ "$(sort -u <<<"$output")" = "/tmp/cd-proof-fail" ]
}

@test "the patches are plain LF text" {
    for b in "${BRANCHES[@]}"; do
        run grep -c $'\r' "${PATCHES}/${b}.patch"
        [ "$output" = 0 ]
    done
    run grep -c $'\r' "$MAKE"
    [ "$output" = 0 ]
    run grep -c $'\r' "$SPIKE"
    [ "$output" = 0 ]
}

@test "usage errors are exit 2 and make nothing" {
    cp_src_repo
    run bash "$MAKE"
    [ "$status" -eq 2 ]
    run bash "$MAKE" --repo "$SRC" --out "$OUT"
    [ "$status" -eq 2 ]
    run bash "$MAKE" HEAD --repo "$SRC" --out "$OUT"
    [ "$status" -eq 2 ]
    run bash "$MAKE" "${BASE}" extra --repo "$SRC" --out "$OUT"
    [ "$status" -eq 2 ]
    run bash "$MAKE" "$BASE" --bogus --repo "$SRC" --out "$OUT"
    [ "$status" -eq 2 ]
    run bash "$MAKE" 0123456789abcdef0123456789abcdef01234567 --repo "$SRC" --out "$OUT"
    [ "$status" -eq 2 ]
    [ ! -e "$OUT" ]
}

@test "an output path that exists is refused and left as it is" {
    cp_src_repo
    mkdir -p "$OUT"
    echo keep >"${OUT}/marker"
    cp_make
    [ "$status" -eq 2 ]
    [ "$(cat "${OUT}/marker")" = keep ]
}

@test "guard: a patch outside gremion-ui is refused before anything is made" {
    cp_src_repo
    cp_bad_patches x 'diff --git a/infra/host/bin/x b/infra/host/bin/x
new file mode 100644
--- /dev/null
+++ b/infra/host/bin/x
@@ -0,0 +1 @@
+x'
    cp_make --patches "$BAD"
    [ "$status" -eq 2 ]
    [[ "$output" == *"outside gremion-ui/"* ]]
    [ ! -e "$OUT" ]
}

@test "guard: a patch that adds a migration folder file or a .sql file is refused" {
    cp_src_repo
    cp_bad_patches x 'diff --git a/gremion-ui/migrations/001-x.txt b/gremion-ui/migrations/001-x.txt
new file mode 100644
--- /dev/null
+++ b/gremion-ui/migrations/001-x.txt
@@ -0,0 +1 @@
+x'
    cp_make --patches "$BAD"
    [ "$status" -eq 2 ]
    [[ "$output" == *"migration"* ]]
    [ ! -e "$OUT" ]
    cp_bad_patches x 'diff --git a/gremion-ui/src/lib/x.sql b/gremion-ui/src/lib/x.sql
new file mode 100644
--- /dev/null
+++ b/gremion-ui/src/lib/x.sql
@@ -0,0 +1 @@
+select 1;'
    cp_make --patches "$BAD"
    [ "$status" -eq 2 ]
    [[ "$output" == *"migration"* ]]
    [ ! -e "$OUT" ]
}

@test "guard: a rename, a delete and a mode change are refused (only create or modify)" {
    cp_src_repo
    cp_bad_patches x 'diff --git a/gremion-ui/src/routes/readyz/+server.ts b/gremion-ui/src/routes/readyz/other.ts
similarity index 100%
rename from gremion-ui/src/routes/readyz/+server.ts
rename to gremion-ui/src/routes/readyz/other.ts'
    cp_make --patches "$BAD"
    [ "$status" -eq 2 ]
    [[ "$output" == *"does more than create or modify"* ]]
    cp_bad_patches x 'diff --git a/gremion-ui/src/routes/readyz/+server.ts b/gremion-ui/src/routes/readyz/+server.ts
deleted file mode 100644
--- a/gremion-ui/src/routes/readyz/+server.ts
+++ /dev/null
@@ -1 +0,0 @@
-x'
    cp_make --patches "$BAD"
    [ "$status" -eq 2 ]
    [[ "$output" == *"does more than create or modify"* ]]
    cp_bad_patches x 'diff --git a/gremion-ui/src/routes/readyz/+server.ts b/gremion-ui/src/routes/readyz/+server.ts
old mode 100644
new mode 100755'
    cp_make --patches "$BAD"
    [ "$status" -eq 2 ]
    [[ "$output" == *"does more than create or modify"* ]]
    [ ! -e "$OUT" ]
}

@test "guard: a patch that does not apply to the given commit is refused and no half-made output stays" {
    cp_src_repo
    cp_bad_patches x 'diff --git a/gremion-ui/src/routes/readyz/+server.ts b/gremion-ui/src/routes/readyz/+server.ts
--- a/gremion-ui/src/routes/readyz/+server.ts
+++ b/gremion-ui/src/routes/readyz/+server.ts
@@ -1,1 +1,1 @@
-this line is not in the file
+changed'
    cp_make --patches "$BAD"
    [ "$status" -eq 2 ]
    [[ "$output" == *"does not apply"* ]]
    [ ! -e "$OUT" ]
}

@test "guard: a missing or empty patch is refused" {
    cp_src_repo
    cp_bad_patches x ''
    cp_make --patches "$BAD"
    [ "$status" -eq 2 ]
    rm -f "${BAD}/proof-5xx.patch"
    cp_make --patches "$BAD"
    [ "$status" -eq 2 ]
    [[ "$output" == *"missing"* ]]
    [ ! -e "$OUT" ]
}

# ---------------------------------------------------------------------------
# spike.sh
# ---------------------------------------------------------------------------

# sp_shims [code] [rc] -- curl answers CODE (default 500) with exit RC (default 0) and notes
# whether the state file existed at the moment of the call; sleep does not sleep.
sp_shims() {
    export SPIKE_TEST_CODE="${1:-500}" SPIKE_TEST_RC="${2:-0}"
    shim curl 'if [ -f "$CD_PROOF_STATE_DIR/spike.last" ]; then echo "curl-saw-stamp" >> "$SHIM_LOG"; fi
printf "%s" "$SPIKE_TEST_CODE"
exit "$SPIKE_TEST_RC"'
    shim sleep
}

@test "spike: no host, a second argument or a malformed host is refused before any request" {
    sp_shims
    run bash "$SPIKE"
    [ "$status" -eq 2 ]
    run bash "$SPIKE" example.org 100
    [ "$status" -eq 2 ]
    for bad in 'https://example.org' 'example.org:8443' 'example.org/x' '-oProxy' 'a b' 'example..org' ''; do
        run bash "$SPIKE" "$bad"
        [ "$status" -eq 2 ] || { echo "accepted: $bad"; return 1; }
    done
    refute_recorded curl ""
    [ ! -e "${CD_PROOF_STATE_DIR}/spike.last" ]
}

@test "spike: 40 requests, one after the other, half a second apart, to the page the patch adds; counts only" {
    sp_shims 500
    run bash "$SPIKE" example.org
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    [[ "$output" =~ ^spike:\ sent=40\ ok=0\ 5xx=40\ other=0\ seconds=[0-9]+$ ]]
    [ "$(grep -c '^curl ' "$SHIM_LOG")" -eq 40 ]
    [ "$(grep -c '^sleep 0.5$' "$SHIM_LOG")" -eq 39 ]
    assert_recorded curl "https://example.org/legal/cd-proof"
    assert_recorded curl "-m 3"
    # the output names neither the host nor the path
    [[ "$output" != *example* ]]
    [[ "$output" != *legal* ]]
}

@test "spike: the time of the run is written before the first request, as a bare number" {
    sp_shims 500
    run bash "$SPIKE" example.org
    [ "$status" -eq 0 ]
    # present at every one of the 40 calls, the first included
    [ "$(grep -c '^curl-saw-stamp$' "$SHIM_LOG")" -eq 40 ]
    assert_present '^[0-9]{9,12}$' "${CD_PROOF_STATE_DIR}/spike.last"
    assert_absent 'example' "${CD_PROOF_STATE_DIR}/spike.last"
}

@test "spike: a second run within 10 minutes is refused with exit 3 and sends nothing" {
    sp_shims 500
    run bash "$SPIKE" example.org
    [ "$status" -eq 0 ]
    : >"$SHIM_LOG"
    run bash "$SPIKE" example.org
    [ "$status" -eq 3 ]
    [ "$(grep -c '^curl ' "$SHIM_LOG" || true)" -eq 0 ]
    # 599 seconds ago is still too soon; 601 is enough
    printf '%s\n' "$(( $(date +%s) - 599 ))" >"${CD_PROOF_STATE_DIR}/spike.last"
    run bash "$SPIKE" example.org
    [ "$status" -eq 3 ]
    printf '%s\n' "$(( $(date +%s) - 601 ))" >"${CD_PROOF_STATE_DIR}/spike.last"
    run bash "$SPIKE" example.org
    [ "$status" -eq 0 ]
    [ "$(grep -c '^curl ' "$SHIM_LOG")" -eq 40 ]
}

@test "spike: a time in the future or a state file that is not a number refuses too" {
    sp_shims 500
    mkdir -p "$CD_PROOF_STATE_DIR"
    printf '%s\n' "$(( $(date +%s) + 3000 ))" >"${CD_PROOF_STATE_DIR}/spike.last"
    run bash "$SPIKE" example.org
    [ "$status" -eq 3 ]
    printf 'not a time\n' >"${CD_PROOF_STATE_DIR}/spike.last"
    run bash "$SPIKE" example.org
    [ "$status" -eq 2 ]
    refute_recorded curl ""
}

@test "spike: the limits cannot be raised by the environment or the command line" {
    run bash "$SPIKE" --limits
    [ "$status" -eq 0 ]
    [ "$output" = "requests=40 seconds=30 gap=600" ]
    CD_PROOF_SPIKE_SECONDS=9999 run bash "$SPIKE" --limits
    [ "$output" = "requests=40 seconds=30 gap=600" ]
    CD_PROOF_SPIKE_SECONDS=12 run bash "$SPIKE" --limits
    [ "$output" = "requests=40 seconds=12 gap=600" ]
    CD_PROOF_SPIKE_SECONDS=abc run bash "$SPIKE" --limits
    [ "$status" -eq 2 ]
    # a request count or gap in the environment is not read at all
    sp_shims 500
    SPIKE_MAX_REQUESTS=1000 SPIKE_MIN_GAP_S=0 run bash "$SPIKE" example.org
    [ "$status" -eq 0 ]
    [ "$(grep -c '^curl ' "$SHIM_LOG")" -eq 40 ]
    SPIKE_MAX_REQUESTS=1000 SPIKE_MIN_GAP_S=0 run bash "$SPIKE" example.org
    [ "$status" -eq 3 ]
}

@test "spike: the burst stops at the time limit, whatever was sent" {
    # curl takes a real second per request here; the limit is lowered to 8 seconds, so a
    # request is started only while it and its timeout still end inside the limit.
    shim curl 'command -p sleep 1; printf "500"; exit 0'
    shim sleep
    CD_PROOF_SPIKE_SECONDS=8 run bash "$SPIKE" example.org
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    [[ "$output" =~ sent=([0-9]+)\ .*seconds=([0-9]+)$ ]]
    sent="${BASH_REMATCH[1]}"
    took="${BASH_REMATCH[2]}"
    [ "$sent" -ge 1 ] && [ "$sent" -lt 40 ]
    [ "$took" -le 8 ]
}

@test "spike: when no request gets an answer the exit is 1 and the counts say so" {
    sp_shims 000 28
    run bash "$SPIKE" example.org
    [ "$status" -eq 1 ]
    [[ "$output" =~ sent=40\ ok=0\ 5xx=0\ other=40 ]]
}

@test "spike: 2xx, 5xx and anything else are counted apart" {
    # a curl that answers 200, 500 and 302 in turn, from a counter file
    echo 0 >"${BATS_TEST_TMPDIR}/n"
    export SPIKE_COUNTER="${BATS_TEST_TMPDIR}/n"
    shim curl 'n=$(cat "$SPIKE_COUNTER"); echo $((n + 1)) >"$SPIKE_COUNTER"
case $((n % 3)) in 0) printf 200 ;; 1) printf 500 ;; 2) printf 302 ;; esac
exit 0'
    shim sleep
    run bash "$SPIKE" example.org
    [ "$status" -eq 0 ]
    # 40 requests: 14 x 200, 13 x 500, 13 x 302
    [[ "$output" =~ sent=40\ ok=14\ 5xx=13\ other=13 ]]
}

# ---------------------------------------------------------------------------
# run-sheet.md
# ---------------------------------------------------------------------------

# sheet_section N -- the lines of the numbered section "## N. ..." up to the next "## ".
sheet_section() {
    awk -v n="$1" '
        $0 ~ "^## " n "\\. " { on = 1; next }
        on && /^## / { exit }
        on { print }
    ' "$SHEET"
}

@test "run sheet: the proof section of the plan is there, one numbered section each" {
    [ -f "$SHEET" ]
    heads="$(grep '^## ' "$SHEET")"
    for want in \
        'Before you start' 'Setup checks and owed measurements' \
        'Scenario 1 ' 'Scenario 2a ' 'Scenario 2b ' 'Scenario 3 ' 'Scenario 4 ' 'Scenario 5 ' \
        'Scenario 5b ' 'Scenario 5c ' 'Scenario 6 ' 'Scenario 7 ' \
        'the worker gate' 'reboot of the host in the middle of a window' 'shared-outage pause' \
        'After the proof' 'does not show'; do
        grep -qF -- "$want" <<<"$heads" || { echo "no section: $want"; return 1; }
    done
}

@test "run sheet: every scenario and every 'also' block has a Passed-when with a docker inspect, jq, curl or stat check" {
    for n in 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16; do
        body="$(sheet_section "$n")"
        [ -n "$body" ] || { echo "section $n is empty or missing"; return 1; }
        grep -qi 'passed when' <<<"$body" || { echo "section $n has no Passed-when"; return 1; }
        grep -qE 'docker inspect|jq |curl |stat ' <<<"$body" || { echo "section $n has no inspect/jq/curl/stat check"; return 1; }
    done
    # the setup section holds the owed measurements, each with its own Passed-when
    [ "$(sheet_section 1 | grep -ci 'passed when')" -ge 10 ]
    for tool in 'docker inspect' 'jq ' 'curl ' 'stat '; do
        grep -qF -- "$tool" "$SHEET" || { echo "the sheet never uses: $tool"; return 1; }
    done
}

@test "run sheet: it names the owed measurements, the worker gate, the mid-window reboot, the pause, the reconcile read-back, the module step and scenarios 6 and 7" {
    for want in \
        'access.log' 'gremion-verify' 'proof-measure' 'proof-restore' 'pg_database' \
        'build --no-cache' 'list-timers' '/protokolle' '/readyz' 'host_reconcile' \
        'module-upgrade' '--pg-service' '--pg-user' 'gremion.request' '--entrypoint true calendar-service' \
        'docker kill' 'datacl' 'premigration-dump' \
        'runtime/workers' 'docker restart' 'systemctl reboot' 'CD_PAUSE_MAX_MIN' 'parked' \
        'leaf_migrate' 'live.leaves' 'live.modules' 'live.reconcile' 'canary' 'reconcile_failed' \
        'resume --accept-descendants --reason "proof-over"' 'make-proof-commits.sh' 'spike.sh' \
        'proof-readiness-fail' 'proof-window-fail' 'proof-5xx' 'readiness_failed' 'watch_readiness' 'watch_5xx' \
        'stat -c'; do
        grep -qiF -- "$want" "$SHEET" || { echo "the sheet does not mention: $want"; return 1; }
    done
}

@test "run sheet: every gremion-cd verb it types is a verb of the program, every CD_ key is a key the program knows" {
    verbs="status hold resume release-now rollback reconcile adopt selftest poll classify tick watchdog help version"
    run grep -ohE 'gremion-cd [a-z][a-z-]*' "$SHEET"
    [ "$status" -eq 0 ]
    while read -r _ v; do
        [[ " $verbs " == *" $v "* ]] || { echo "not a verb: $v"; return 1; }
    done < <(sort -u <<<"$output")
    run grep -ohE '\bCD_[A-Z0-9_]+\b' "$SHEET"
    [ "$status" -eq 0 ]
    while read -r k; do
        grep -qF "[$k]=" "${KERNEL_ROOT}/infra/host/lib/cd/core.sh" || { echo "not a config key: $k"; return 1; }
    done < <(sort -u <<<"$output")
}

@test "run sheet: no fact number, unit id, plan section, private path, real host, address or IP of a host" {
    files=("$SHEET" "$SPIKE" "$MAKE" "${PATCHES}"/*.patch)
    [ "${#files[@]}" -eq 6 ]
    run grep -nE '\bF[0-9]{1,3}\b|\bU[0-9]{1,2}[a-g]?\b|\.claude|PLAN-|[Pp]lan section|HANDOVER|E2E-FINDINGS' "${files[@]}"
    [ "$status" -eq 1 ] || { echo "$output"; return 1; }
    # every URL names a reserved example host
    run grep -ohE 'https?://[A-Za-z0-9.-]+' "${files[@]}"
    while read -r u; do
        [ -z "$u" ] && continue
        h="${u#*://}"
        [[ "$h" == example.org || "$h" == example.com || "$h" == *.invalid || "$h" == *.test ]] || { echo "real-looking URL host: $u"; return 1; }
    done <<<"$output"
    # no IPv4 literal but loopback and the documentation range
    run grep -ohE '\b[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\b' "${files[@]}"
    while read -r ip; do
        [ -z "$ip" ] && continue
        [[ "$ip" == 127.0.0.1 || "$ip" == 203.0.113.* ]] || { echo "IP literal: $ip"; return 1; }
    done <<<"$output"
    # no e-mail address whose domain is not a reserved example domain
    run grep -ohE '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+' "${files[@]}"
    while read -r a; do
        [ -z "$a" ] && continue
        d="${a#*@}"
        [[ "$d" == example.org || "$d" == example.com || "$d" == *.invalid || "$d" == *.test ]] || { echo "address: $a"; return 1; }
    done <<<"$output"
}

@test "run sheet: the shell blocks without a placeholder parse" {
    # fenced blocks only, one file each; a block that holds a <placeholder> is left out
    local dir="${BATS_TEST_TMPDIR}/blocks" f n=0
    mkdir -p "$dir"
    awk -v d="$dir" '/^```$/ { if (on) { on = 0; close(f) } else { on = 1; k++; f = d "/block." k } next } on { print > f }' "$SHEET"
    for f in "$dir"/block.*; do
        [ -f "$f" ] || continue
        if grep -qE '<[A-Za-z][A-Za-z0-9 _.-]*>' "$f"; then continue; fi
        bash -n "$f" || { echo "does not parse:"; cat "$f"; return 1; }
        n=$((n + 1))
    done
    [ "$n" -ge 15 ] || { echo "only $n blocks were checked"; return 1; }
}
