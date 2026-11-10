#!/usr/bin/env bats
# Tests for infra/host/bin/gremion-isolation (pilot wave 2, Task 1): `run`
# produces the isolation evidence for the release tip in a throwaway postgres and
# a toolchain container, `record` imports it and asserts the rows the enable gate
# reads. Unit only: docker and git are recording shims; the toolchain container is
# played by the docker shim (it writes the evidence file into the mounted /out).
# Run: bats test/host/isolation-record.bats

load 'test_helper/host'

TIP='1f2e3d4c5b6a79881f2e3d4c5b6a79881f2e3d4c'
OTHER_TIP='9a8b7c6d5e4f30219a8b7c6d5e4f30219a8b7c6d'
MODULES='calendar content publishing votes files messaging'
REF='sha256:0000000000000000000000000000000000000000000000000000000000000000 fake-upstream-app gremion-ui/src/x.test.ts'

setup() {
    setup_host_root
    REL="${GREMION_ROOT}/current"
    mkdir -p "${REL}/.git" "${REL}/infra/host/bin" "${REL}/infra/host/lib/executor" "${REL}/test/isolation/tenant"
    cp "${HOST_SRC}/bin/gremion-isolation" "${REL}/infra/host/bin/"
    cp "${HOST_SRC}/lib/common.sh" "${HOST_SRC}/lib/customer-ops.sh" "${REL}/infra/host/lib/"
    cp "${HOST_SRC}/lib/executor/db.sh" "${REL}/infra/host/lib/executor/"
    cp "${KERNEL_ROOT}/docker-compose.yml" "${REL}/"
    : > "${REL}/test/isolation/tenant/Dockerfile"
    PROG="${REL}/infra/host/bin/gremion-isolation"
    export GREMION_EXECUTOR_PG_CONTAINER=iso-pg-fixture
    echo blue > "${GREMION_ROOT}/runtime/active-colour"
    printf 'STACK=isostack\nPOSTGRES_USER=postgres\n' > "${GREMION_ROOT}/etc/env/state.env"
    printf 'STACK=isostack\nCOLOUR=blue\n' > "${GREMION_ROOT}/etc/env/app-blue.env"
    printf '%s\n' "$TIP" > "${GREMION_ROOT}/tip"
    : > "${GREMION_ROOT}/git-status"
    make_evidence "$TIP" > "${GREMION_ROOT}/evidence.json"
    shim_git
    shim_docker
}

teardown() {
    teardown_host_root
}

# make_evidence <tip> -- what the producer writes for a passing run.
make_evidence() {
    local tip="$1" m first=1
    printf '{"produced_by":"verify","tree_clean":true,"release_tip_sha":"%s","verify_record":{"suite":"isolation:tenant","sha":"%s","collected":6,"passed":6,"failed":0},"results":[' "$tip" "$tip"
    for m in $MODULES; do
        [[ "$first" == 1 ]] || printf ','
        first=0
        printf '{"module":"%s","test_kind":"cross_customer","passed":true,"release_tip_sha":"%s","evidence_ref":"%s"}' "$m" "$tip" "$REF"
    done
    printf ']}\n'
}

shim_git() {
    shim git '
case "$*" in
  *"rev-parse --verify"*) cat "$GREMION_ROOT/tip"; exit 0 ;;
  *"status --porcelain"*) cat "$GREMION_ROOT/git-status"; exit 0 ;;
esac
exit 0'
}

# One docker shim for the whole host side:
#   ps -aq                       no stale container (unless the stale file exists)
#   run -d ...                   the throwaway postgres
#   exec <c> pg_isready ...      ready
#   build ...                    the toolchain image
#   run --rm --name ...iso-run.. the toolchain container: copies evidence.json to <out>/<tip>.json
#   compose ... tenant-create    the isolation-record one-shot
#   exec -i <c> psql ...         the platform database: stdin saved, rows from psql-rows
shim_docker() {
    shim docker '
case "$*" in
  "ps -aq"*) [ -f "$GREMION_ROOT/stale" ] && echo deadbeef; exit 0 ;;
  "run -d "*) echo cid; exit 0 ;;
  "exec "*pg_isready*) exit 0 ;;
  "build "*) exit 0 ;;
  "rm -f "*) exit 0 ;;
  "run --rm --name gremion-iso-run-"*)
    [ -f "$GREMION_ROOT/toolchain-fails" ] && { echo "1 of 190 failed" >&2; exit 1; }
    out=""; prev=""
    for a in "$@"; do
      if [ "$prev" = "-v" ]; then case "$a" in *:/out) out="${a%:/out}" ;; esac; fi
      prev="$a"
    done
    [ -n "$out" ] || exit 3
    echo "$out" > "$GREMION_ROOT/out-dir-seen"
    [ -f "$GREMION_ROOT/toolchain-writes-nothing" ] && exit 0
    tip="$(cat "$GREMION_ROOT/tip")"
    cp "$GREMION_ROOT/evidence.json" "$out/${tip}.json"
    mkdir -p "$out/${tip}"; echo "{}" > "$out/${tip}/calendar.vitest.json"
    exit 0 ;;
  *"compose "*" tenant-create "*)
    [ -f "$GREMION_ROOT/record-fails" ] && exit 1
    exit 0 ;;
  "exec -i "*psql*)
    cat > "$GREMION_ROOT/psql-stdin.sql"
    cat "$GREMION_ROOT/psql-rows" 2>/dev/null
    exit 0 ;;
esac
exit 0'
}

# rows_all_pass <tip> -- the platform database holds a passing latest row per pilot module.
rows_all_pass() {
    local tip="$1" m
    : > "${GREMION_ROOT}/psql-rows"
    for m in $MODULES; do printf '%s|t|%s|%s\n' "$m" "$tip" "$REF" >> "${GREMION_ROOT}/psql-rows"; done
}

# ---------------------------------------------------------------------------
# run
# ---------------------------------------------------------------------------

@test "run refuses a dirty release tree: exit 2, nothing started" {
    echo ' M docker-compose.yml' > "${GREMION_ROOT}/git-status"
    run "$PROG" run
    [ "$status" -eq 2 ]
    [[ "$output" == *"not clean"* ]]
    refute_recorded docker "run -d"
    refute_recorded docker "build"
}

@test "run refuses a release tree with no release tip: exit 2, nothing started" {
    : > "${GREMION_ROOT}/tip"
    run "$PROG" run
    [ "$status" -eq 2 ]
    [[ "$output" == *"no release tip"* ]]
    refute_recorded docker "run -d"
}

@test "run is blocked, not silently reusing, when a container of an earlier run is still there" {
    : > "${GREMION_ROOT}/stale"
    run "$PROG" run
    [ "$status" -eq 3 ]
    [[ "$output" == *"BLOCKED"* ]]
    refute_recorded docker "run -d"
}

@test "run starts the kernel's own pinned postgres with no published port and joins the tool container to its namespace" {
    run "$PROG" run --out "${GREMION_ROOT}/ev"
    [ "$status" -eq 0 ]
    local short="${TIP:0:8}"
    assert_recorded docker "run -d --name gremion-iso-${short}"
    assert_recorded docker "listen_addresses=127.0.0.1"
    assert_recorded docker "--network container:gremion-iso-${short}"
    assert_recorded docker "ISOLATION_TENANT_PG_URL=postgres://postgres@127.0.0.1:"
    # the image is the pin of docker-compose.yml's x-module-postgres anchor: tag and digest
    grep '^docker run -d ' "$SHIM_LOG" | grep -Eq 'postgres:[0-9]+-alpine@sha256:[0-9a-f]{64}'
    # no published port, no compose project, no volume on the throwaway server
    local line
    line="$(grep '^docker run -d ' "$SHIM_LOG")"
    [[ "$line" != *" -p "* ]]
    [[ "$line" != *" --publish"* ]]
    [[ "$line" != *" -v "* ]]
    # the port is random and is not 5432
    [[ "$line" != *"port=5432"* ]]
    [[ "$line" =~ port=([0-9]+) ]]
    [ "${BASH_REMATCH[1]}" -ge 40000 ]
}

@test "run gives the tool container the release tree read-only and a clone-based, frozen-lockfile procedure" {
    run "$PROG" run --out "${GREMION_ROOT}/ev"
    [ "$status" -eq 0 ]
    assert_recorded docker ":/src:ro"
    # git inside the container trusts the read-only tree (a clone reads /src/.git): by environment, not by git config
    assert_recorded docker "-e GIT_CONFIG_KEY_1=safe.directory -e GIT_CONFIG_VALUE_1=/src/.git"
    # the in-container procedure is the multi-line `sh -c` argument: its lines are logged on their own
    local want
    for want in 'git clone -q --no-hardlinks /src /work/tree' 'git checkout -q --detach "$ISOLATION_TIP"' 'pnpm install --frozen-lockfile' 'node scripts/verify/verify.mjs --only isolation:tenant'; do
        grep -qF -- "$want" "$SHIM_LOG" || { echo "the tool container's procedure lacks: ${want}"; return 1; }
    done
}

@test "run moves the evidence to <out>/<tip>.json (mode 0644), keeps the reports beside it, prints the path, removes both containers and the temp dir" {
    run "$PROG" run --out "${GREMION_ROOT}/ev"
    [ "$status" -eq 0 ]
    local dest="${GREMION_ROOT}/ev/${TIP}.json"
    [ -s "$dest" ]
    [ "${lines[-1]}" = "$dest" ]
    [ -f "${GREMION_ROOT}/ev/${TIP}/calendar.vitest.json" ]
    jq -e --arg tip "$TIP" '.release_tip_sha == $tip and .produced_by == "verify"' "$dest" >/dev/null
    if fs_carries_modes "${GREMION_ROOT}"; then
        [ "$(stat -c %a "$dest")" = "644" ]
    else
        skip "this filesystem does not store POSIX modes (the 0644 is asserted on the Debian host)"
    fi
}

@test "run removes the throwaway postgres, the tool container and the output directory on success" {
    run "$PROG" run --out "${GREMION_ROOT}/ev"
    [ "$status" -eq 0 ]
    assert_recorded docker "rm -f gremion-iso-run-${TIP:0:8} gremion-iso-${TIP:0:8}"
    [ -s "${GREMION_ROOT}/out-dir-seen" ]
    [ ! -e "$(cat "${GREMION_ROOT}/out-dir-seen")" ]
}

@test "run removes the tip-tagged toolchain image it built, on success and on failure, so a release run leaves no image behind" {
    run "$PROG" run --out "${GREMION_ROOT}/ev"
    [ "$status" -eq 0 ]
    assert_recorded docker "rmi -f gremion-isolation-toolchain:${TIP:0:8}"
    : > "$SHIM_LOG"
    : > "${GREMION_ROOT}/toolchain-fails"
    run "$PROG" run --out "${GREMION_ROOT}/ev"
    [ "$status" -eq 1 ]
    assert_recorded docker "rmi -f gremion-isolation-toolchain:${TIP:0:8}"
}

@test "run cleans up on FAILURE too: a failing isolation case exits 1, keeps no evidence, removes both containers and the temp dir" {
    : > "${GREMION_ROOT}/toolchain-fails"
    run "$PROG" run --out "${GREMION_ROOT}/ev"
    [ "$status" -eq 1 ]
    [[ "$output" == *"no evidence was kept"* ]]
    assert_recorded docker "rm -f gremion-iso-run-${TIP:0:8} gremion-iso-${TIP:0:8}"
    [ ! -e "${GREMION_ROOT}/ev/${TIP}.json" ]
    [ ! -e "$(cat "${GREMION_ROOT}/out-dir-seen")" ]
}

@test "run: a failed rerun for the same tip leaves no evidence of the earlier pass behind, so 'no evidence was kept' is true" {
    mkdir -p "${GREMION_ROOT}/ev/${TIP}"
    echo '{}' > "${GREMION_ROOT}/ev/${TIP}.json"
    echo '{}' > "${GREMION_ROOT}/ev/${TIP}/calendar.vitest.json"
    : > "${GREMION_ROOT}/toolchain-fails"
    run "$PROG" run --out "${GREMION_ROOT}/ev"
    [ "$status" -eq 1 ]
    [ ! -e "${GREMION_ROOT}/ev/${TIP}.json" ]
    [ ! -e "${GREMION_ROOT}/ev/${TIP}" ]
}

@test "run asserts the post-condition: a toolchain run that exits 0 and wrote no evidence file is a failure" {
    : > "${GREMION_ROOT}/toolchain-writes-nothing"
    run "$PROG" run --out "${GREMION_ROOT}/ev"
    [ "$status" -eq 1 ]
    [[ "$output" == *"wrote no evidence file"* ]]
    [ ! -e "${GREMION_ROOT}/ev/${TIP}.json" ]
    assert_recorded docker "rm -f gremion-iso-run-${TIP:0:8} gremion-iso-${TIP:0:8}"
}

@test "run refuses evidence that is not a clean verify stamp for the tip" {
    make_evidence "$OTHER_TIP" > "${GREMION_ROOT}/evidence.json"
    run "$PROG" run --out "${GREMION_ROOT}/ev"
    [ "$status" -eq 1 ]
    [[ "$output" == *"not a clean verify stamp"* ]]
    [ ! -e "${GREMION_ROOT}/ev/${TIP}.json" ]
}

# ---------------------------------------------------------------------------
# record
# ---------------------------------------------------------------------------

@test "record refuses a file for another release tip: exit 2, nothing imported" {
    make_evidence "$OTHER_TIP" > "${GREMION_ROOT}/other.json"
    run "$PROG" record "${GREMION_ROOT}/other.json"
    [ "$status" -eq 2 ]
    [[ "$output" == *"another release tip"* ]]
    refute_recorded docker "tenant-create"
}

@test "record refuses a release tree with no tip: exit 2, nothing imported" {
    : > "${GREMION_ROOT}/tip"
    run "$PROG" record "${GREMION_ROOT}/evidence.json"
    [ "$status" -eq 2 ]
    [[ "$output" == *"no release tip"* ]]
    refute_recorded docker "tenant-create"
}

@test "record refuses a file that is not stamped by verify, and one that is not clean" {
    jq '.produced_by = "run.mjs"' "${GREMION_ROOT}/evidence.json" > "${GREMION_ROOT}/unstamped.json"
    run "$PROG" record "${GREMION_ROOT}/unstamped.json"
    [ "$status" -eq 2 ]
    jq '.tree_clean = false' "${GREMION_ROOT}/evidence.json" > "${GREMION_ROOT}/unclean.json"
    run "$PROG" record "${GREMION_ROOT}/unclean.json"
    [ "$status" -eq 2 ]
    refute_recorded docker "tenant-create"
}

@test "record refuses a scratch-fixture reference: exit 2, nothing imported" {
    jq '.results[0].evidence_ref = "scratch-fixture:harness"' "${GREMION_ROOT}/evidence.json" > "${GREMION_ROOT}/fixture.json"
    run "$PROG" record "${GREMION_ROOT}/fixture.json"
    [ "$status" -eq 2 ]
    [[ "$output" == *"scratch-fixture:"* ]]
    refute_recorded docker "tenant-create"
}

@test "record refuses a file that does not name exactly the pilot modules (board is never recorded)" {
    jq '.results += [{"module":"board","test_kind":"cross_customer","passed":true,"release_tip_sha":.release_tip_sha,"evidence_ref":"sha256:00 x"}]' "${GREMION_ROOT}/evidence.json" > "${GREMION_ROOT}/board.json"
    run "$PROG" record "${GREMION_ROOT}/board.json"
    [ "$status" -eq 2 ]
    [[ "$output" == *"exactly the pilot modules"* ]]
    refute_recorded docker "tenant-create"
}

@test "record mounts the file read-only and runs isolation-record in the active colour's tenant-create one-shot" {
    rows_all_pass "$TIP"
    run "$PROG" record "${GREMION_ROOT}/evidence.json"
    [ "$status" -eq 0 ]
    assert_recorded docker "compose --env-file ${GREMION_ROOT}/etc/env/app-blue.env run --rm -T"
    assert_recorded docker "${GREMION_ROOT}/evidence.json:/run/isolation-evidence.json:ro"
    assert_recorded docker "tenant-create isolation-record /run/isolation-evidence.json"
}

@test "record asserts the DATABASE, not the import's exit code: it reads the latest cross_customer row per module the way the gate does" {
    rows_all_pass "$TIP"
    run "$PROG" record "${GREMION_ROOT}/evidence.json"
    [ "$status" -eq 0 ]
    local sql="${GREMION_ROOT}/psql-stdin.sql"
    assert_present "x.test_kind = 'cross_customer'" "$sql" "the gate's kind"
    assert_present "ORDER BY x.run_at DESC, x.created_at DESC, x.isolation_test_result_id DESC" "$sql" "the gate's ordering (enable-gate/gate.ts)"
    assert_present "LIMIT 1" "$sql" "one row per module"
}

@test "record fails when a newer failing row sits beside an older pass (the latest row decides)" {
    rows_all_pass "$TIP"
    sed -i 's/^votes|t|/votes|f|/' "${GREMION_ROOT}/psql-rows"
    run "$PROG" record "${GREMION_ROOT}/evidence.json"
    [ "$status" -eq 1 ]
    [[ "$output" == *"votes: the latest cross_customer row is a FAIL"* ]]
}

@test "record fails when the latest row of a module is for another tip, is fixture evidence, or is missing" {
    rows_all_pass "$TIP"
    sed -i "s/^calendar|t|${TIP}/calendar|t|${OTHER_TIP}/" "${GREMION_ROOT}/psql-rows"
    sed -i 's#^files|t|\([0-9a-f]*\)|sha256:[0-9a-f]* [a-z-]* [^|]*#files|t|\1|scratch-fixture:x#' "${GREMION_ROOT}/psql-rows"
    sed -i '/^messaging|/d' "${GREMION_ROOT}/psql-rows"
    run "$PROG" record "${GREMION_ROOT}/evidence.json"
    [ "$status" -eq 1 ]
    [[ "$output" == *"calendar: the latest cross_customer row is for tip ${OTHER_TIP}"* ]]
    [[ "$output" == *"files: the latest row is fixture evidence"* ]]
    [[ "$output" == *"messaging: no cross_customer row at all"* ]]
}

@test "record exits 1 when the import itself fails, without reading the database as proof" {
    : > "${GREMION_ROOT}/record-fails"
    rows_all_pass "$TIP"
    run "$PROG" record "${GREMION_ROOT}/evidence.json"
    [ "$status" -eq 1 ]
    [[ "$output" == *"isolation-record failed"* ]]
    refute_recorded docker "psql"
}

@test "usage: no verb, an unknown verb and an unknown flag exit 2" {
    run "$PROG"
    [ "$status" -eq 2 ]
    run "$PROG" bogus
    [ "$status" -eq 2 ]
    run "$PROG" run --bogus
    [ "$status" -eq 2 ]
}
