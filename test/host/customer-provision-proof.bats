#!/usr/bin/env bats
# Static guards on test/host/integration/customer-provision-proof.sh (#50): the
# proof drifted from the verbs and directories it drives, and only a live Linux
# run noticed. Each guard reads the script, so it runs on every host.

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
    PROOF="$REPO_ROOT/test/host/integration/customer-provision-proof.sh"
}

@test "every 'tenant reconcile ... --apply' in the proof passes --reason (gremion-tenant refuses an unaudited apply)" {
    run grep -nE 'tenant reconcile [^|;]*--apply' "$PROOF"
    [ "$status" -eq 0 ]
    local re='--reason "[^"]{10,}"'
    while IFS= read -r line; do
        [[ "$line" =~ $re ]] || { echo "no --reason: $line"; return 1; }
    done <<< "$output"
    # the verb really requires it (if this stops matching, re-check the guard above)
    grep -q 'reconcile --apply needs --reason' "$REPO_ROOT/infra/host/bin/gremion-tenant"
}

@test "the tenant-secret ownership check reads the app env's TENANT_SECRETS_DIR and skips .gitkeep" {
    grep -qF "s/^TENANT_SECRETS_DIR=//p' \"\$PENV/app-blue.env\"" "$PROOF"
    grep -q 'find "$tsd" -type f ! -name .gitkeep' "$PROOF"
    # pooled-stack-proof is what renders that variable into app-<colour>.env
    grep -q '^TENANT_SECRETS_DIR=\${SROOT_H}/secrets/tenants' "$REPO_ROOT/test/host/integration/pooled-stack-proof.sh"
    # Last on purpose: bats discards a `!`-negated status anywhere but the final
    # statement (common.bats enforces this), so mid-body it asserted nothing.
    ! grep -q 'PROOF_TENANT_SECRETS_DIR:-$ROOT/secrets/tenants' "$PROOF"
}

@test "a fresh tenant's warm-up is waited for: create-check and the suspend baseline use edge_served_wait (#50)" {
    grep -q '^edge_served_wait() {' "$PROOF"
    grep -q 'if edge_served_wait "$(host_of "$X")"; then ok "customer-create:' "$PROOF"
    # the suspend phase proves Y is served BEFORE it suspends X, so "Y was affected" means affected by the suspend
    local body; body="$(sed -n '/^phase_customer_suspend() {/,/^}/p' "$PROOF")"
    local base sus
    base="$(grep -n 'edge_served_wait "$(host_of "$Y")"' <<< "$body" | head -1 | cut -d: -f1)"
    sus="$(grep -n 'tenant suspend "$X"' <<< "$body" | head -1 | cut -d: -f1)"
    [ -n "$base" ] && [ -n "$sus" ] && [ "$base" -lt "$sus" ]
}

@test "the proof's own node fixtures pass (panel-session sign-in incl. gremion-ui's disabled Auth.js CSRF, #50)" {
    command -v node >/dev/null || skip "node not on PATH"
    mkdir -p "$REPO_ROOT/.scratch"
    run node --test "$REPO_ROOT/test/host/fixtures/customer-provision/panel-session-signin.test.mjs" "$REPO_ROOT/test/host/fixtures/customer-provision/panel-session.test.mjs"
    [ "$status" -eq 0 ] || { printf '%s\n' "$output" | tail -30; return 1; }
    [[ "$output" =~ pass\ ([0-9]+) ]] && [ "${BASH_REMATCH[1]}" -ge 18 ]
}

# ── #50 item 6 and the mid-run HEAD move: unit tests on the sourced proof ─────
# The proof is sourced with a fake docker/curl/git on PATH and its kcadm (skc)
# and psql (q) helpers replaced; nothing reaches an engine.
SHA_A=aaaaaaaa11111111111111111111111111111111
SHA_B=bbbbbbbb22222222222222222222222222222222
OP_ID=0b7c2e1a-3f4d-4a5b-8c6d-7e8f9a0b1c2d

cp_unit_setup() { # <head sha the fake git reports>
    local bin="${BATS_TEST_TMPDIR}/bin"
    mkdir -p "$bin" "${BATS_TEST_TMPDIR}/env" "${BATS_TEST_TMPDIR}/out"
    printf '#!/usr/bin/env bash\nexit 0\n' > "$bin/docker"; cp "$bin/docker" "$bin/curl"
    export FAKE_GIT_HEAD="${BATS_TEST_TMPDIR}/fake-head"
    printf '#!/usr/bin/env bash\nh="$(cat "$FAKE_GIT_HEAD")"; for a in "$@"; do [[ "$a" == --short=8 ]] && h="${h:0:8}"; done; echo "$h"\n' > "$bin/git"
    chmod +x "$bin/docker" "$bin/curl" "$bin/git"
    printf '%s\n' "$1" > "$FAKE_GIT_HEAD"
    export PATH="${bin}:${PATH}"
    export POOLED_STACK="t040-${SHA_A:0:8}" POOLED_ENV_DIR="${BATS_TEST_TMPDIR}/env" PROOF_OUT="${BATS_TEST_TMPDIR}/out"
    printf 'GREMION_ROOT=%s\nPLATFORM_DOMAIN=proof.example.org\nPROOF_HEAD_SHA=%s\n' "${BATS_TEST_TMPDIR}/root" "$SHA_A" > "${POOLED_ENV_DIR}/state.env"
    unset PROOF_STACK PROOF_OPERATOR_ID
}

# kcadm stand-in: logs every call; `get users -r platform -q email=...` lists
# the users in $SKC_USERS (a file of ids), `create users` adds $OP_ID to it,
# `get users/<id>` succeeds only for a listed id.
fake_skc='skc() {
    printf "%s\n" "$*" >> "$SKC_LOG"
    case "$1 $2" in
        "get realms/platform") echo "{\"realm\":\"platform\"}" ;;
        "get users")
            jq -Rn "[inputs | select(length > 0) | {id: .}]" < "$SKC_USERS" ;;
        "create users") echo "$OP_ID" >> "$SKC_USERS" ;;
        "add-roles -r") : ;;
        "get users/"*) [[ "${SKC_OUTAGE:-}" != 1 ]] || { echo "Failed to send request - Connect to 127.0.0.1:8080 failed: Connection refused" >&2; return 1; }; grep -qx "${2#users/}" "$SKC_USERS" || { echo "Resource not found for url" >&2; return 1; }; echo "{\"id\":\"${2#users/}\",\"enabled\":true}" ;;
        *) echo "fake skc: unhandled: $*" >&2; return 1 ;;
    esac
}
q() { case "$2" in *pg_database*) echo 1 ;; *module_version*) echo 3 ;; *) echo "fake q: $2" >&2; return 1 ;; esac; }'

run_cp() { # <bash code run after sourcing the proof and the fakes>
    export SKC_LOG="${BATS_TEST_TMPDIR}/skc.log" SKC_USERS="${BATS_TEST_TMPDIR}/skc-users" OP_ID
    touch "$SKC_USERS"
    run bash -c 'set -euo pipefail; . "$1"; eval "$2"; eval "$3"' _ "$PROOF" "$fake_skc" "$1"
}

@test "the customer STACK follows the pooled stack's recorded sha, not a moved HEAD (no renamed ledger)" {
    cp_unit_setup "$SHA_B"
    run_cp 'echo "STACK=$STACK"'
    [ "$status" -eq 0 ]
    [[ "$output" == *"STACK=t043-${SHA_A:0:8}"* ]]
}

@test "need_pooled refuses after a HEAD move since the pooled prepare, naming both shas (ISOLATION_STALE_TIP otherwise)" {
    cp_unit_setup "$SHA_B"
    run_cp 'need_pooled no-operator; echo reached'
    [ "$status" -eq 2 ]
    [[ "$output" == *"FATAL: HEAD moved"*"${SHA_A:0:12}"*"${SHA_B:0:12}"* ]]
    [[ "$output" != *reached* ]]
}

@test "need_pooled at the pinned HEAD passes (positive control for the HEAD guard)" {
    cp_unit_setup "$SHA_A"
    run_cp 'need_pooled no-operator; echo reached'
    [ "$status" -eq 0 ]
    [[ "$output" == *reached* ]]
}

@test "need_pooled takes the operator customer-init recorded when PROOF_OPERATOR_ID is unset" {
    cp_unit_setup "$SHA_A"
    mkdir -p "${PROOF_OUT}/secrets"; echo "$OP_ID" > "${PROOF_OUT}/secrets/operator-id"
    run_cp 'need_pooled; echo "op=$PROOF_OPERATOR_ID"'
    [ "$status" -eq 0 ]
    [[ "$output" == *"op=${OP_ID}"* ]]
}

@test "need_pooled with no operator at all is a FATAL that names customer-init" {
    cp_unit_setup "$SHA_A"
    run_cp 'need_pooled; echo reached'
    [ "$status" -eq 2 ]
    [[ "$output" == *"FATAL: "*"customer-init"* ]]
    [[ "$output" != *reached* ]]
}

@test "customer-init creates the proof operator in the CURRENT ops realm and records its id (#50 item 6)" {
    cp_unit_setup "$SHA_A"
    run_cp 'phase_customer_init'
    [ "$status" -eq 0 ] || { echo "$output" >&2; return 1; }
    [ "$(cat "${PROOF_OUT}/secrets/operator-id")" = "$OP_ID" ]
    grep -q '^create users -r platform ' "$SKC_LOG"
    grep -q "^add-roles -r platform --uid ${OP_ID} --rolename operator" "$SKC_LOG"
    [[ "$output" == *"ok   customer-init: "*"${OP_ID}"* ]]
}

@test "customer-init reuses an operator the realm already has (a rerun creates none)" {
    cp_unit_setup "$SHA_A"
    echo "$OP_ID" > "${BATS_TEST_TMPDIR}/skc-users"
    run_cp 'phase_customer_init'
    [ "$status" -eq 0 ]
    [ "$(cat "${PROOF_OUT}/secrets/operator-id")" = "$OP_ID" ]
    ! grep -q '^create users' "$SKC_LOG"
}

@test "customer-init refuses a PROOF_OPERATOR_ID that is not in the current ops realm (a stale id)" {
    cp_unit_setup "$SHA_A"
    export PROOF_OPERATOR_ID=11111111-2222-4333-8444-555555555555
    run_cp 'phase_customer_init; echo "RED=$RED"'
    [[ "$output" == *"PROOF_OPERATOR_ID 11111111-2222-4333-8444-555555555555 does not exist in the current ops realm"* ]]
    [ "$status" -eq 0 ]
    [[ "$output" == *"RED=1"* ]]
    [ ! -e "${PROOF_OUT}/secrets/operator-id" ]
}

@test "customer-init: a kcadm outage while checking PROOF_OPERATOR_ID is reported as such, never as a stale id" {
    cp_unit_setup "$SHA_A"
    export PROOF_OPERATOR_ID="$OP_ID" SKC_OUTAGE=1
    run_cp 'phase_customer_init; echo "RED=$RED"'
    [ "$status" -eq 0 ]
    [[ "$output" == *"kcadm could not look PROOF_OPERATOR_ID ${OP_ID} up: Failed to send request"* ]]
    [[ "$output" == *"RED=1"* ]]
    [[ "$output" != *"does not exist in the current ops realm"* ]]
}

@test "customer-init on a host (PROOF_GREMION_ROOT) creates no user in the operators' realm: it needs PROOF_OPERATOR_ID" {
    cp_unit_setup "$SHA_A"
    export PROOF_GREMION_ROOT="${BATS_TEST_TMPDIR}/host-root"
    run_cp 'phase_customer_init; echo "RED=$RED"'
    [ "$status" -eq 0 ]
    [[ "$output" == *"on a host set PROOF_OPERATOR_ID"* ]]
    [[ "$output" == *"RED=1"* ]]
    ! grep -q '^create users' "$SKC_LOG"
}

@test "customer-before needs no operator yet (it runs before customer-init creates one)" {
    local body; body="$(sed -n '/^phase_customer_before() {/,/^}/p' "$PROOF")"
    grep -q 'need_pooled no-operator' <<< "$body"
}

# ── TASK-084-a: the ninth ledger kind and the governance database ────────────
# The unit writes nine step kinds per customer (governance_database_created), so
# the proof expects 9/9 done rows, has a phase for A3-A7 and fingerprints the
# governance database. Static guards: a live run needs a pooled stack.

@test "the create-check expects nine done ledger rows, one per kind, and no stale 8/8 (TASK-084-a)" {
    local body; body="$(sed -n '/^phase_customer_create_check() {/,/^}/p' "$PROOF")"
    grep -qF '== "9/9"' <<< "$body"
    grep -q 'nine done ledger rows' <<< "$body"
    # Last on purpose (see above): no done-row count of eight is left anywhere in the proof.
    ! grep -qE '"8/8"|eight done ledger rows' "$PROOF"
}

@test "customer-governance-db is a phase: run_phase dispatches it, the header documents it, and it is defined (A3-A7)" {
    grep -qE '^        customer-governance-db\) phase_customer_governance_db ;;$' "$PROOF"
    grep -qE '^#   customer-governance-db ' "$PROOF"
    grep -q '^phase_customer_governance_db() {' "$PROOF"
}

@test "customer-governance-db asserts A3 to A7 from the running system (database list, binding, ledger sha256, FORCE RLS, datacl, cross-credential refusals, RLS matrix, rerun, credential placement)" {
    local body; body="$(sed -n '/^phase_customer_governance_db() {/,/^}/p;/^gov_a[3-7]() {/,/^}/p' "$PROOF")"
    [ -n "$body" ]
    # A3: the two databases on governance-postgres, one binding row each, the lock's sha256, FORCE RLS, datacl
    grep -qF "LIKE 't\\\\_%\\\\_\\\\_governance'" <<< "$body"
    grep -q 'gov.database_binding' <<< "$body"
    grep -q 'gov.schema_migration' <<< "$body"
    grep -q 'applied.lock.json' <<< "$body"
    grep -q 'relforcerowsecurity' <<< "$body"
    grep -q 'aclexplode' <<< "$body"
    # A4: both cross-credential refusals, the kernel credential, no CONNECT for the group roles
    grep -q 'permission denied for database' <<< "$body"
    grep -q 'tenant_.*_db' <<< "$body"
    grep -q 'gov_app' <<< "$body"
    # A5: the RLS matrix as the customer's app role
    grep -q 'gremion.customer_id' <<< "$body"
    # A6: a second create request changes nothing
    grep -q 'panel_create' <<< "$body"
    # A7: credential placement
    grep -q 'etc/secrets/governance' <<< "$body"
    grep -q 'docker inspect' <<< "$body"
}

@test "customer-governance-db never prints a credential: the password rides a name-only -e, never an argv" {
    local body; body="$(sed -n '/^phase_customer_governance_db() {/,/^}/p;/^gov_login() {/,/^}/p;/^gov_cred() {/,/^}/p;/^gov_a[3-7]() {/,/^}/p' "$PROOF")"
    [ -n "$body" ]
    grep -q 'docker exec -e PGPASSWORD' "$PROOF"
    # Last on purpose: no inline PGPASSWORD= assignment in the phase or its helpers.
    ! grep -qE -- '-e PGPASSWORD=|PGPASSWORD=[^"]*$' <<< "$body"
}

@test "the stored-data fingerprint covers the governance database of the customer (TASK-084-a, PRD-OPS-004)" {
    local body; body="$(sed -n '/^data_fingerprint() {/,/^}/p' "$PROOF")"
    grep -q 'governance-postgres' <<< "$body"
    grep -q '__governance' <<< "$body"
}

# The A3 checks run against fake q / qg readers: a database that reads as the brief
# says is GREEN, and each deviation (foreign binding, wrong lock sha256, an unforced
# table, a PUBLIC CONNECT) goes RED on its own.
gov_world='
GOV_ID=01927f00-0000-7000-8000-000000000001; GOV_HEX=01927f00000070008000000000000001
GOV_SHA="$(jq -r ".chains.governance.files[\"0001_gov_setup.sql\"]" "$ROOT/scripts/migrations/applied.lock.json")"
: "${G_BINDING:=1:${GOV_ID}:proof_x:gov}" "${G_SHA:=$GOV_SHA}" "${G_FORCE:=19/0}" "${G_ACL:=g_${GOV_HEX}_app,g_${GOV_HEX}_owner,g_${GOV_HEX}_purger}"
q() { case "$2" in *governance_database_created*) echo 1 ;; *) echo "fake q: $2" >&2; return 1 ;; esac; }
qg() { case "$2" in
    *"count(*) FROM pg_database WHERE datname"*) echo 1 ;;
    *"FROM gov.database_binding"*) echo "$G_BINDING" ;;
    *"FROM gov.schema_migration"*) echo "0001_gov_setup.sql ${G_SHA}" ;;
    *relforcerowsecurity*) echo "$G_FORCE" ;;
    *aclexplode*) echo "$G_ACL" ;;
    *) echo "fake qg: $2" >&2; return 1 ;; esac; }'

@test "A3 on a database that reads as the brief says is GREEN (positive control for the drill below)" {
    cp_unit_setup "$SHA_A"
    run_cp "$gov_world"'; gov_a3 proof-x "$GOV_ID"; echo "RED=$RED"'
    [ "$status" -eq 0 ]
    [[ "$output" == *"RED=0"* ]]
    [[ "$output" == *"datacl grants CONNECT to its own owner, app and purger roles only"* ]]
    [[ "$output" == *"sha256 of applied.lock.json"* ]]
}

@test "A3 goes RED on each deviation alone: another customer's binding, a stale sha256, an unforced table, a PUBLIC CONNECT" {
    cp_unit_setup "$SHA_A"
    local d want
    while IFS='|' read -r d want; do
        run_cp "$d"'; '"$gov_world"'; gov_a3 proof-x "$GOV_ID"; echo "RED=$RED"'
        [ "$status" -eq 0 ]
        [[ "$output" == *"RED=1"* ]] || { echo "not RED for ${d}: ${output}" >&2; return 1; }
        [[ "$output" == *"$want"* ]] || { echo "no '${want}' for ${d}: ${output}" >&2; return 1; }
    done <<'EOF'
G_BINDING=1:01927f00-0000-7000-8000-0000000000ff:proof_x:gov|gov.database_binding reads '1:01927f00-0000-7000-8000-0000000000ff
G_SHA=0000000000000000000000000000000000000000000000000000000000000000|differs from applied.lock.json
G_FORCE=19/1|without FORCE row level security: 19/1
G_ACL=PUBLIC,g_01927f00000070008000000000000001_app|CONNECT grantees on t_01927f00000070008000000000000001__governance are 'PUBLIC,g_
EOF
}

@test "gov_cred reads one field of a postgres URL credential file and refuses anything else" {
    cp_unit_setup "$SHA_A"
    local f="${BATS_TEST_TMPDIR}/cred"
    printf 'postgresql://g_abc_app:S3cretValue@governance-postgres:5432/t_abc__governance?sslmode=disable\n' > "$f"
    run_cp "gov_cred '$f' user; echo; gov_cred '$f' database; echo; gov_cred '$f' password; echo"
    [ "$status" -eq 0 ]
    [ "${lines[0]}" = g_abc_app ]
    [ "${lines[1]}" = t_abc__governance ]
    [ "${lines[2]}" = S3cretValue ]
    printf 'not a url\n' > "$f"
    run_cp "gov_cred '$f' user && echo parsed || echo refused; gov_cred '${BATS_TEST_TMPDIR}/absent' user && echo parsed || echo refused"
    [ "${lines[0]}" = refused ]
    [ "${lines[1]}" = refused ]
}

@test "the shim's phase A line names the governance step (the fixture mirrors the nine kinds)" {
    grep -qF 'ran [realm_created, database_created, governance_database_created]' "$REPO_ROOT/test/host/fixtures/executor/docker-shim"
}
