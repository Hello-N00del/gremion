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
    ! grep -q 'PROOF_TENANT_SECRETS_DIR:-$ROOT/secrets/tenants' "$PROOF"
    # pooled-stack-proof is what renders that variable into app-<colour>.env
    grep -q '^TENANT_SECRETS_DIR=\${SROOT_H}/secrets/tenants' "$REPO_ROOT/test/host/integration/pooled-stack-proof.sh"
}
