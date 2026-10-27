#!/usr/bin/env bats
# Tests for infra/host/bin/gremion-executor (TASK-043d-1 TDD 12, A5, A6, A7):
# the host-side executor of the control panel's requests. Unit only: docker
# is test/host/fixtures/executor/docker-shim (the request functions of
# gremion_platform behind `docker exec ... psql`, and the tenant-create
# one-shot), flock and the sibling gremion-vendor-mail are recording stubs.
# The executor is INSTALLED the way bootstrap's `executor` stage installs it
# (<root>/bin + <root>/lib/common.sh) and sources its handlers from the
# release at <root>/current.
# Run: bats test/host/executor.bats

load 'test_helper/host'

OP='8d6b9c7e-1f2a-4b3c-9d4e-5f6a7b8c9d0e'
REQ='0192f0c4-0000-7000-8000-00000000000a'
FIX="${HOST_TEST_DIR}/fixtures/executor"
UNIT="${HOST_SRC}/templates/systemd/gremion-executor.service"

setup() {
    setup_host_root
    REL="${GREMION_ROOT}/current"
    mkdir -p "${REL}/infra/host/bin" "${REL}/infra/host/lib/executor/handlers" "${GREMION_ROOT}/lib"
    cp "${HOST_SRC}/lib/common.sh" "${REL}/infra/host/lib/"
    cp "${HOST_SRC}/lib/customer-ops.sh" "${REL}/infra/host/lib/"
    cp "${HOST_SRC}/lib/executor/db.sh" "${HOST_SRC}/lib/executor/registry.sh" "${REL}/infra/host/lib/executor/"
    cp "${HOST_SRC}/lib/executor/handlers/"*.sh "${REL}/infra/host/lib/executor/handlers/"
    # the installed layout (bootstrap.sh executor)
    cp "${HOST_SRC}/bin/gremion-executor" "${GREMION_ROOT}/bin/"
    cp "${HOST_SRC}/lib/common.sh" "${GREMION_ROOT}/lib/"
    EXEC="${GREMION_ROOT}/bin/gremion-executor"
    ORDER="${GREMION_ROOT}/order.log"
    : > "$ORDER"
    export ORDER
    cat > "${REL}/infra/host/bin/gremion-vendor-mail" <<'STUB'
#!/usr/bin/env bash
printf 'vendor-mail %s\n' "$*" >> "$ORDER"
[ -f "${GREMION_ROOT}/vendor-mail-fails" ] && exit 1
exit 0
STUB
    chmod +x "${REL}/infra/host/bin/gremion-vendor-mail"
    # the transport front (PLAN-mail-transport M2): every realm-smtp call goes through it
    cp "${HOST_SRC}/bin/gremion-mail" "${REL}/infra/host/bin/"
    export MAIL_TRANSPORT=stalwart
    echo blue > "${GREMION_ROOT}/runtime/active-colour"
    cat > "${GREMION_ROOT}/etc/env/state.env" <<'ENV'
STACK=guardstack
POSTGRES_USER=postgres
POSTGRES_PASSWORD=unit-pg-root-secret
KEYCLOAK_ADMIN_PASSWORD=unit-kc-admin-state-secret
TRAEFIK_CERT_RESOLVER=le-http
EDGE_BIND_IP=192.0.2.10
EDGE_BIND_IP6=2001:db8::a
ENV
    printf 'STACK=guardstack\nCOLOUR=blue\n' > "${GREMION_ROOT}/etc/env/app-blue.env"
    cp "${FIX}/verdict-create-ok.json" "${GREMION_ROOT}/verdict.json"
    shim docker "exec bash '${FIX}/docker-shim' \"\$@\""
    shim flock '[ -f "$GREMION_ROOT/lock-held" ] && exit 1; exit 0'
    export GREMION_EXECUTOR_HOST=h1.example GREMION_EXECUTOR_PG_CONTAINER=t043d-pg-fixture
}

teardown() {
    teardown_host_root
}

queue() {   # <kind> [slug]
    printf '%s|%s|%s|panel|%s|0\n' "$REQ" "$1" "${2:-alpha-rat}" "$OP" > "${GREMION_ROOT}/queue"
}
steps() { cat "$ORDER"; }
outcome() { cat "${GREMION_ROOT}/outcome" 2>/dev/null || true; }

@test "gremion-executor exists, is executable and sets strict mode" {
    [ -x "${HOST_SRC}/bin/gremion-executor" ]
    assert_present '^set -euo pipefail$' "${HOST_SRC}/bin/gremion-executor"
}

@test "A5: the executor carries no listener primitive (it PULLS; nothing reaches it)" {
    assert_absent '(^|[^a-z])(socat|ncat|nc )|ListenStream|/dev/tcp|/dev/udp' "${HOST_SRC}/bin/gremion-executor" 'a listener primitive in the executor'
    local f
    for f in "${HOST_SRC}/lib/customer-ops.sh" "${HOST_SRC}/lib/executor/"*.sh "${HOST_SRC}/lib/executor/handlers/"*.sh; do
        assert_absent '(^|[^a-z])(socat|ncat|nc )|ListenStream|/dev/tcp|/dev/udp' "$f" 'a listener primitive in an executor library'
    done
}

@test "A5: the unit has the hostd hardening and no Listen*, socket or RuntimeDirectory" {
    assert_present '^Type=exec$' "$UNIT"
    assert_present '^User=\$\{DEPLOY_USER\}$' "$UNIT"
    assert_present '^SupplementaryGroups=docker$' "$UNIT"
    assert_present '^NoNewPrivileges=true$' "$UNIT"
    assert_present '^PrivateTmp=true$' "$UNIT"
    assert_present '^ProtectSystem=full$' "$UNIT"
    assert_present '^ReadWritePaths=\$\{GREMION_ROOT\}$' "$UNIT"
    assert_present '^Restart=on-failure$' "$UNIT"
    assert_present '^ExecStart=\$\{GREMION_ROOT\}/bin/gremion-executor --loop$' "$UNIT"
    assert_absent '^[[:space:]]*(Listen[A-Za-z]*|Sockets|RuntimeDirectory[A-Za-z]*|Accept)=' "$UNIT" 'a listener directive in the unit'
    [ ! -e "${HOST_SRC}/templates/systemd/gremion-executor.socket" ]
}

@test "no request queued: exit 0, a heartbeat, a claim, nothing run" {
    run "$EXEC" --once
    [ "$status" -eq 0 ] || { echo "status=$status $output"; return 1; }
    run steps
    [ "$output" = "psql claim" ] || { echo "$output"; return 1; }
    grep -qx 'beat h1.example 043d-1' "${GREMION_ROOT}/beats.log"
    # the database is reached as gremion_executor only
    [ "$(sort -u "${GREMION_ROOT}/psql-roles.log")" = gremion_executor ]
}

@test "create: verify, mark verified, phase A, the mail step, record-step, phase B, the router, finish succeeded -- in that order" {
    queue create
    run "$EXEC" --once
    [ "$status" -eq 0 ] || { echo "status=$status $output"; steps; return 1; }
    run steps
    local want=("psql claim" "tc request-verify ${REQ}" "psql mark-verified" "tc phase-a alpha-rat"
                "vendor-mail realm-smtp --realm alpha-rat --tenant alpha_rat" "tc record-step alpha-rat"
                "tc phase-b alpha-rat" "tc render-router alpha-rat" "tc activate alpha-rat" "psql finish succeeded")
    [ "${#lines[@]}" -eq "${#want[@]}" ] || { echo "$output"; return 1; }
    local i
    for i in "${!want[@]}"; do [ "${lines[$i]}" = "${want[$i]}" ] || { echo "line $i: '${lines[$i]}' want '${want[$i]}'"; echo "$output"; return 1; }; done
    grep -qF '    tenant-alpha-rat.kc:' "${GREMION_ROOT}/etc/edge/tenant-alpha-rat.yml"
    # the VERIFIED args drive the engine: operator, admins, modules, body
    assert_present "--operator ${OP}" "${GREMION_ROOT}/tc-argv.log"
    assert_present '--it-admin it@alpha.example --council-admin rat@alpha.example' "${GREMION_ROOT}/tc-argv.log"
    assert_present '--enable calendar,votes' "${GREMION_ROOT}/tc-argv.log"
    assert_present '--body-name Stadtrat' "${GREMION_ROOT}/tc-argv.log"
    # ordered events for each step, the lease renewed at each
    run awk '{print $2}' "${GREMION_ROOT}/events.log"
    # (`create` carries the handler's own lines before its first step)
    [[ "$(uniq <<< "$output" | tr '\n' ' ')" == "claim verify create phase-a mail record-step phase-b router " ]] || { cat "${GREMION_ROOT}/events.log"; return 1; }
    [ "$(grep -c "^renew ${REQ} h1.example$" "${GREMION_ROOT}/renews.log")" -eq 5 ]
    [[ "$(outcome)" == "create alpha-rat: succeeded (last step router)" ]] || { outcome; return 1; }
}

@test "the tenant config is the brand identity only, 0600, and gone after the run (no host path from the request)" {
    queue create
    run "$EXEC" --once
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    run sed -n 2p "${GREMION_ROOT}/config-seen"
    [ "$output" = '{"brand":{"product":"Ratsportal","org_short":"AR"},"modules":{}}' ] || { echo "$output"; return 1; }
    if fs_carries_modes "$GREMION_ROOT"; then
        [ "$(head -n 1 "${GREMION_ROOT}/config-seen")" = 600 ]
    fi
    [ ! -e "${GREMION_ROOT}/runtime/executor/${REQ}" ] || { find "${GREMION_ROOT}/runtime/executor"; return 1; }
    [ ! -e "${GREMION_ROOT}/dpia-seen" ]
}

@test "C13: DPIA decisions in the verified args reach both phases as a read-only 0600 file" {
    jq -c '.args.dpia = {votes: {requires_dpia: false, reason_codes: ["no_special_category"], document_ref: null}}' "${FIX}/verdict-create-ok.json" > "${GREMION_ROOT}/verdict.json"
    queue create
    run "$EXEC" --once
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    [ "$(grep -c -- '--dpia-json /run/gremion/dpia.json' "${GREMION_ROOT}/tc-argv.log")" -eq 2 ]
    run sed -n 2p "${GREMION_ROOT}/dpia-seen"
    [ "$output" = '{"votes":{"requires_dpia":false,"reason_codes":["no_special_category"],"document_ref":null}}' ] || { echo "$output"; return 1; }
}

@test "G7 (TASK-044 re-applied): tenant-create gets the release tip DERIVED from the release tree, and the scratch/production flags by name" {
    command -v git >/dev/null || skip "git absent"
    git -C "$REL" init -q
    git -C "$REL" -c user.email=t@e.x -c user.name=t commit -q --allow-empty -m tip
    local tip; tip="$(git -C "$REL" rev-parse HEAD)"
    queue create
    run "$EXEC" --once
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    [ "$(grep -c -- "-e GREMION_RELEASE_TIP=${tip}" "${GREMION_ROOT}/tc-argv.log")" -eq "$(wc -l < "${GREMION_ROOT}/tc-argv.log")" ] || { cat "${GREMION_ROOT}/tc-argv.log"; return 1; }
    assert_present '-e GREMION_SCRATCH_FIXTURES -e GREMION_PRODUCTION_STACK' "${GREMION_ROOT}/tc-argv.log"
}

@test "mail_step seam (mail-transport M1): customer_create reaches the mail only through mail_step; the executor announces step mail through it" {
    local body
    body="$(awk '/^customer_create\(\) \{/{f=1} f{print} f && /^\}/{exit}' "${HOST_SRC}/lib/customer-ops.sh")"
    [ -n "$body" ]
    [[ "$body" == *'mail_step '* ]] || { echo "customer_create does not call mail_step"; return 1; }
    [[ "$body" != *vendor_mail* ]] || { echo "customer_create still calls vendor_mail directly"; return 1; }
    [[ "$body" != *mail_principal_issued* ]] || { echo "the record-step moved into the seam"; return 1; }
    assert_present '^mail_step\(\) \{' "${HOST_SRC}/lib/customer-ops.sh"
    assert_present '^[[:space:]]+executor_step mail$' "${HOST_SRC}/bin/gremion-executor"
}

@test "mail_step seam: an unknown MAIL_TRANSPORT fails create at the mail step, phase B does not run, no mail principal is issued" {
    queue create
    MAIL_TRANSPORT=carrier-pigeon run "$EXEC" --once
    [ "$status" -eq 1 ] || { echo "status=$status $output"; return 1; }
    run steps
    [[ "$output" != *"vendor-mail"* && "$output" != *"phase-b"* && "$output" != *"record-step"* ]] || { echo "$output"; return 1; }
    [[ "$(outcome)" == *"failed in mail"* ]] || { outcome; return 1; }
    grep -q 'MAIL_TRANSPORT' "${GREMION_ROOT}/events.log" || { cat "${GREMION_ROOT}/events.log"; return 1; }
}

@test "a refused verdict: finished refused with the reason, no phase runs, nothing is marked verified" {
    printf '{"verdict":"refused","reason":"evidence: the ID token has acr loa1, loa2 is required"}\n' > "${GREMION_ROOT}/verdict.json"
    queue create
    run "$EXEC" --once
    [ "$status" -eq 1 ] || { echo "status=$status $output"; return 1; }
    run steps
    [ "$output" = $'psql claim\ntc request-verify '"${REQ}"$'\npsql finish refused' ] || { echo "$output"; return 1; }
    [[ "$(outcome)" == "refused: evidence: the ID token has acr loa1, loa2 is required" ]]
}

@test "request-verify that cannot decide (exit 1): finished failed, nothing ran" {
    touch "${GREMION_ROOT}/fail-request-verify"
    queue create
    run "$EXEC" --once
    [ "$status" -eq 1 ]
    run steps
    [ "$output" = $'psql claim\ntc request-verify '"${REQ}"$'\npsql finish failed' ] || { echo "$output"; return 1; }
    [[ "$(outcome)" == *"could not decide"* ]]
}

@test "a kind without a handler: refused 'no handler for <kind>', nothing runs" {
    jq -c '.kind = "suspend"' "${FIX}/verdict-create-ok.json" > "${GREMION_ROOT}/verdict.json"
    queue suspend
    run "$EXEC" --once
    [ "$status" -eq 1 ]
    run steps
    [ "$output" = $'psql claim\ntc request-verify '"${REQ}"$'\npsql mark-verified\npsql finish refused' ] || { echo "$output"; return 1; }
    [ "$(outcome)" = "no handler for suspend" ]
}

@test "a phase B failure: finished failed naming phase-b; the events carry its lines; no router" {
    touch "${GREMION_ROOT}/fail-phase-b"
    queue create
    run "$EXEC" --once
    [ "$status" -eq 1 ] || { echo "status=$status $output"; return 1; }
    run steps
    [ "${lines[-1]}" = "psql finish failed" ]
    [[ "$output" != *"render-router"* ]]
    [[ "$(outcome)" == "create alpha-rat: failed in phase-b (exit 1); a new request resumes from the ledger" ]] || { outcome; return 1; }
    grep -q '^error phase-b .*FAILED: phase-b (fixture)' "${GREMION_ROOT}/events.log" || { cat "${GREMION_ROOT}/events.log"; return 1; }
    grep -q '^error phase-b .*phase B of alpha-rat failed' "${GREMION_ROOT}/events.log"
    [ ! -e "${GREMION_ROOT}/etc/edge/tenant-alpha-rat.yml" ]
}

@test "a line carrying a credential never reaches an event or the audit log" {
    touch "${GREMION_ROOT}/leak"
    queue create
    run "$EXEC" --once
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    ! grep -q 'unit-app-secret-t043d' "${GREMION_ROOT}/events.log" "${GREMION_ROOT}/runtime/executor/audit.log" || { echo "a credential reached a log"; return 1; }
    grep -qF 'phase-a [a line carrying a credential was withheld]' "${GREMION_ROOT}/events.log"
    grep -qF '[a line carrying a credential was withheld]' "${GREMION_ROOT}/runtime/executor/audit.log"
}

@test "the audit log records the claim, every event and the finish (append-only file under runtime/executor)" {
    queue create
    run "$EXEC" --once
    [ "$status" -eq 0 ]
    local a="${GREMION_ROOT}/runtime/executor/audit.log"
    grep -q "host=h1.example .* req=${REQ} event info claim: claimed by h1.example: create alpha-rat" "$a"
    grep -q "req=${REQ} finish succeeded: create alpha-rat: succeeded" "$a"
    queue create
    run "$EXEC" --once
    [ "$(grep -c "req=${REQ} finish succeeded" "$a")" -eq 2 ]
}

@test "the host lock held (a deploy, switch or rollback): no claim, exit 3" {
    touch "${GREMION_ROOT}/lock-held"
    queue create
    run "$EXEC" --once
    [ "$status" -eq 3 ] || { echo "status=$status $output"; return 1; }
    [[ "$output" == *"busy"* ]]
    run steps
    [ -z "$output" ] || { echo "claimed under a held lock: $output"; return 1; }
    [ -s "${GREMION_ROOT}/queue" ]
}

@test "TRD-440 still runs in the handler (deletion-aware): a container that appears fails the request" {
    touch "${GREMION_ROOT}/extra-container"
    queue create
    run "$EXEC" --once
    [ "$status" -eq 1 ] || { echo "status=$status $output"; return 1; }
    grep -q 'TRD-440: the container set moved' "${GREMION_ROOT}/events.log" || { cat "${GREMION_ROOT}/events.log"; return 1; }
    [[ "$(outcome)" == *"failed in router"* ]]
}

@test "no secret on any recorded argv, and no token: the executor never handles one" {
    queue create
    run "$EXEC" --once
    [ "$status" -eq 0 ]
    local v
    for v in unit-pg-root-secret unit-kc-admin-state-secret eyJ; do
        ! grep -qF -- "$v" "$SHIM_LOG" || { echo "${v} on an argv"; return 1; }
    done
}

@test "--loop: at start its own orphaned requests are re-queued before the first claim (crash-resume)" {
    command -v timeout >/dev/null 2>&1 || skip "timeout(1) is not installed"
    GREMION_EXECUTOR_POLL_SECONDS=1 run timeout 4 "$EXEC" --loop
    run steps
    [ "${lines[0]}" = "psql requeue-own h1.example" ] || { echo "$output"; return 1; }
    [ "${lines[1]}" = "psql claim" ]
}

@test "usage: no mode, a bad host id, or a release without the executor library is exit 2" {
    run "$EXEC"
    [ "$status" -eq 2 ]
    GREMION_EXECUTOR_HOST='Bad Host!' run "$EXEC" --once
    [ "$status" -eq 2 ] || { echo "$output"; return 1; }
    rm -f "${REL}/infra/host/lib/executor/registry.sh"
    run "$EXEC" --once
    [ "$status" -eq 2 ]
    [[ "$output" == *"carries no executor library"* ]]
    run steps
    [ -z "$output" ]
}

# A7 (last case): customers are created and operated in the panel. No guarded
# document names a gremion-tenant customer verb as an operator step outside
# the ONE decommission note (docs/runbooks/tenant-lifecycle.md).
@test "A7 docs guard: no gremion-tenant (create|suspend|resume|reconcile|status) outside the decommission note" {
    local root="${KERNEL_ROOT}" hits f
    local -a files=()
    while IFS= read -r f; do files+=("$f"); done < <(find "${root}/docs" -name '*.md' -type f)
    files+=("${root}/infra/host/README.md" "${root}/ops/vendor-mail/RUNBOOK.md" "${root}/apps/control-panel/README.md")
    hits=""
    for f in "${files[@]}"; do
        [ -f "$f" ] || continue
        hits+="$(awk -v F="${f#"${root}"/}" '
            /<!-- gremion-tenant decommission note \(R31-I4\) -->/ { inside = 1; next }
            /<!-- \/gremion-tenant decommission note -->/ { inside = 0; next }
            !inside && /gremion-tenant (create|suspend|resume|reconcile|status)/ { printf "%s:%d: %s\n", F, NR, $0 }' "$f")"
    done
    [ -z "$hits" ] || { echo "$hits"; return 1; }
    # the note exists exactly once
    [ "$(grep -rl --include='*.md' 'gremion-tenant decommission note (R31-I4)' "${root}/docs" | wc -l)" -eq 1 ]
}

# ---------------------------------------------------------------------------
# TASK-031 fix round (house review MED 1): `gremion-tenant request` for a kind
# that carries a member list.

big_args() { # <file> <rows>: an import_members args file well over 128 KiB
    local i
    { printf 'name,email,body,role\n'; for ((i = 0; i < $2; i++)); do printf 'Erika Mustermann%d,erika.mustermann%d@example.org,Rat,member\n' "$i" "$i"; done; } > "${GREMION_ROOT}/list.csv"
    jq -nc --rawfile c "${GREMION_ROOT}/list.csv" '{slug:"alpha-rat",phase:"validate",vertical:"stura",csv:$c}' > "$1"
    chmod 600 "$1"
}

@test "request: the args (a member list) travel on STDIN inside the SQL, never in the docker argv (E2BIG above 128 KiB, process table)" {
    cp "${HOST_SRC}/bin/gremion-tenant" "${REL}/infra/host/bin/"
    local f="${GREMION_ROOT}/big-args.json"
    big_args "$f" 5000
    [ "$(wc -c < "$f")" -gt 262144 ]
    run "${REL}/infra/host/bin/gremion-tenant" request import_members --operator "$OP" --args-file "$f" --reason "bulk import without the panel"
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    [[ "$output" == *"0192f0c4-0000-7000-8000-000000000001"* ]]
    # the shim recorded every exec's whole argv: it names no row and is small
    [ -s "${GREMION_ROOT}/exec-argv.log" ]
    assert_absent 'Mustermann' "${GREMION_ROOT}/exec-argv.log" 'a row name reached the docker argv'
    assert_absent 'example\.org' "${GREMION_ROOT}/exec-argv.log" 'an address reached the docker argv'
    [ "$(wc -c < "${GREMION_ROOT}/exec-argv.log")" -lt 2000 ]
    # ...and the whole JSON still reached the queue, byte for byte
    [ "$(cat "${GREMION_ROOT}/submitted-args")" = "$(jq -c . "$f")" ]
}

@test "request: args with quotes, backslashes, dollar signs and psql-variable look-alikes arrive unchanged (dollar quoting)" {
    cp "${HOST_SRC}/bin/gremion-tenant" "${REL}/infra/host/bin/"
    local f="${GREMION_ROOT}/odd-args.json"
    jq -nc '{slug:"alpha-rat",phase:"validate",vertical:"stura",csv:"name,email,body,role\nO'"'"'Neil $$ :'"'"'kind'"'"' \\ $g1$ \"q\",o@example.org,Rat,member\n"}' > "$f"
    chmod 600 "$f"
    run "${REL}/infra/host/bin/gremion-tenant" request import_members --operator "$OP" --args-file "$f" --reason "odd characters in the list"
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    [ "$(cat "${GREMION_ROOT}/submitted-args")" = "$(jq -c . "$f")" ]
    ! grep -q 'Neil' "${GREMION_ROOT}/exec-argv.log"
}

# ---------------------------------------------------------------------------
# create-harden H4 (a lost lease aborts the handler loudly) and H7 (the event
# level follows the step's exit status, not only the text "FAIL").

handler_gone() { [ ! -s "${GREMION_ROOT}/hang.pid" ] || ! kill -0 "$(cat "${GREMION_ROOT}/hang.pid")" 2>/dev/null; }

@test "H4: a definitively refused lease renewal aborts the handler (process group killed), records an error event, exits non-zero" {
    touch "${GREMION_ROOT}/renew-refused" "${GREMION_ROOT}/hang-phase-a"
    queue create
    GREMION_EXECUTOR_RENEW_SECONDS=1 run "$EXEC" --once
    [ "$status" -ne 0 ] || { echo "$output"; return 1; }
    grep -q '^error .*lease' "${GREMION_ROOT}/events.log" || { cat "${GREMION_ROOT}/events.log"; return 1; }
    assert_present 'lease' "${GREMION_ROOT}/runtime/executor/audit.log"
    handler_gone || { echo "the handler survived the lost lease (or never ran)"; return 1; }
    run steps
    [[ "$output" != *"tc phase-b"* && "$output" != *"render-router"* ]] || { echo "$output"; return 1; }
    [[ "$output" != *"finish succeeded"* ]] || { echo "$output"; return 1; }
}

@test "H4: the background renewer detects a lease lost DURING a long step (no step marker needed)" {
    touch "${GREMION_ROOT}/hang-phase-b" "${GREMION_ROOT}/refuse-renew-when-hung"
    queue create
    GREMION_EXECUTOR_RENEW_SECONDS=1 run "$EXEC" --once
    [ "$status" -ne 0 ] || { echo "$output"; return 1; }
    handler_gone || { echo "the handler survived"; return 1; }
    grep -q '^error .*lease' "${GREMION_ROOT}/events.log" || { cat "${GREMION_ROOT}/events.log"; return 1; }
}

@test "H4: renewals that cannot reach the database past the local fence deadline abort the handler (self-fence before the lease can lapse)" {
    touch "${GREMION_ROOT}/hang-phase-b" "${GREMION_ROOT}/renew-unreachable-when-hung"
    queue create
    GREMION_EXECUTOR_RENEW_SECONDS=1 GREMION_EXECUTOR_FENCE_SECONDS=3 run "$EXEC" --once
    [ "$status" -ne 0 ] || { echo "$output"; return 1; }
    handler_gone || { echo "the handler survived the fence"; return 1; }
    assert_present 'fence' "${GREMION_ROOT}/runtime/executor/audit.log"
}

@test "H4: a second --loop executor on the same host is refused (its requeue-own would re-queue the first one's running request)" {
    command -v flock >/dev/null || skip "flock absent"
    rm -f "${SHIM_DIR}/flock"
    local lockf="${GREMION_ROOT}/runtime/executor/executor.lock"
    mkdir -p "$(dirname "$lockf")"
    exec 8>>"$lockf"
    flock -n 8
    run "$EXEC" --loop
    exec 8>&-
    [ "$status" -eq 3 ] || { echo "status=$status $output"; return 1; }
    printf '%s\n' "$(steps)" > "${GREMION_ROOT}/steps.txt"
    assert_absent 'requeue-own' "${GREMION_ROOT}/steps.txt" 'requeue-own ran under a second daemon'
}

@test "H4: the SQL grants the lapsed lease a grace before attempt + 1 and refuses to revive it" {
    local f; f="$(ls "${KERNEL_ROOT}"/packages/tenant-store/src/lifecycle/platform-migrations/0011_*.sql)"
    assert_present 'lease_until < now\(\) - interval' "$f"
    assert_present 'lease_until >= now\(\)' "$f"
}

@test "H7: a step that exits non-zero without the text FAIL is recorded at level error" {
    touch "${GREMION_ROOT}/fail-silent-phase-b"
    queue create
    run "$EXEC" --once
    [ "$status" -eq 1 ] || { echo "status=$status $output"; return 1; }
    grep -q '^error phase-b .*exited 3' "${GREMION_ROOT}/events.log" || { cat "${GREMION_ROOT}/events.log"; return 1; }
}

@test "H7: a clean run records no error event" {
    queue create
    run "$EXEC" --once
    [ "$status" -eq 0 ]
    assert_absent '^error ' "${GREMION_ROOT}/events.log" 'an error event on a clean run'
}
