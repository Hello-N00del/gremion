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
