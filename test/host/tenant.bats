#!/usr/bin/env bats
# Tests for infra/host/bin/gremion-tenant (TASK-043 TDD 13), the host half of
# the customer lifecycle. Unit only: docker is a recording shim that plays the
# tenant-create one-shot, and the sibling gremion-vendor-mail is a recording
# stub. The release is laid out the way <root>/current is on a host.
# Run: bats test/host/tenant.bats

load 'test_helper/host'

OP='8d6b9c7e-1f2a-4b3c-9d4e-5f6a7b8c9d0e'

setup() {
    setup_host_root
    REL="${GREMION_ROOT}/current"
    mkdir -p "${REL}/infra/host/bin" "${REL}/infra/host/lib/executor" "${REL}/docker/keycloak"
    cp "${HOST_SRC}/lib/customer-ops.sh" "${REL}/infra/host/lib/"
    cp "${HOST_SRC}/lib/executor/db.sh" "${REL}/infra/host/lib/executor/"
    # TRD-092: the host verbs record the access first (lib/access-log.sh -> oac.record_access)
    cp "${HOST_SRC}/lib/access-log.sh" "${REL}/infra/host/lib/"
    export GREMION_EXECUTOR_PG_CONTAINER=t092-pg-fixture
    cp "${HOST_SRC}/bin/gremion-tenant" "${REL}/infra/host/bin/"
    cp "${HOST_SRC}/lib/common.sh" "${REL}/infra/host/lib/"
    cp "${KERNEL_ROOT}/docker/keycloak/realm-export.ops.json" "${REL}/docker/keycloak/"
    LAUNCHER="${REL}/infra/host/bin/gremion-tenant"
    ORDER="${GREMION_ROOT}/order.log"
    : > "$ORDER"
    export ORDER
    # The sibling vendor-mail launcher: records its arguments in the step order.
    cat > "${REL}/infra/host/bin/gremion-vendor-mail" <<'STUB'
#!/usr/bin/env bash
printf 'vendor-mail %s\n' "$*" >> "$ORDER"
[ -f "${GREMION_ROOT}/vendor-mail-fails" ] && exit 1
# a ledger-like stub (the real launcher lists first and issues only when absent, G2): it
# creates the principal on its first call and records that; created.log is append-only
grep -qx principal "${GREMION_ROOT}/done.ledger" 2>/dev/null || { echo principal >> "${GREMION_ROOT}/created.log"; echo principal >> "${GREMION_ROOT}/done.ledger"; }
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
BOARD_PG_PASSWORD=unit-board-secret
CALENDAR_PG_PASSWORD=unit-calendar-secret
CONTENT_PG_PASSWORD=unit-content-secret
FINANCE_PG_PASSWORD=unit-finance-secret
NEWSLETTER_PG_PASSWORD=unit-newsletter-secret
VAULT_PG_PASSWORD=unit-vault-secret
KEYCLOAK_ADMIN=admin
KEYCLOAK_ADMIN_PASSWORD=unit-kc-admin-state-secret
TRAEFIK_CERT_RESOLVER=le-http
EDGE_BIND_IP=192.0.2.10
EDGE_BIND_IP6=2001:db8::a
ENV
    printf 'STACK=guardstack\nCOLOUR=blue\nTENANT_SECRETS_DIR=%s/tenant-secrets\n' "$GREMION_ROOT" > "${GREMION_ROOT}/etc/env/app-blue.env"
    printf '{"brand":{"product":"Rat","org_short":"MS"}}\n' > "${GREMION_ROOT}/tenant-config.json"
    shim_docker
}

teardown() {
    teardown_host_root
}

# shim_docker — `docker compose ... run ... tenant-create <verb> ...` appends
# `tc <verb> <slug>` to the step order and answers as the container would;
# `ps -q` and `compose config --services` are stable unless a test says not.
shim_docker() {
    shim docker '
case " $* " in
  *" exec "*" psql "*)
    # oac.record_access (TRD-092): the record id
    cat > /dev/null; echo "0192f0c4-0000-7000-8000-0000000000ac"; exit 0 ;;
  *" run "*" tenant-create "*)
    all="$*"
    # the bootstrap-provisioner scratch mount (TASK-043b F1), before the args go
    od=""; for a in "$@"; do case "$a" in *:/run/secrets/provisioner-out) od="${a%:/run/secrets/provisioner-out}" ;; esac; done
    rest="${all##* tenant-create }"
    set -- $rest
    verb="$1"; slug="${2:-}"
    printf "tc %s %s\n" "$verb" "$slug" >> "$ORDER"
    [ -f "$GREMION_ROOT/fail-$verb" ] && exit 1
    case "$verb" in
      phase-a|phase-b)
        # a stand-in for runPhase: done.ledger lists the steps already done; a step is
        # created (appended to created.log, unconditionally) only when absent from it,
        # and phase B / activate refuse to run out of order like the real ledger does
        if [ "$verb" = phase-b ]; then
          for r in realm database broker mail_principal_issued; do
            grep -qx "$r" "$GREMION_ROOT/done.ledger" 2>/dev/null || { echo "STEP_OUT_OF_ORDER: $r not done" >&2; exit 1; }
          done
        fi
        for r in $([ "$verb" = phase-a ] && echo "realm database broker" || echo accounts); do
          grep -qx "$r" "$GREMION_ROOT/done.ledger" 2>/dev/null && continue
          echo "$r" >> "$GREMION_ROOT/created.log"; echo "$r" >> "$GREMION_ROOT/done.ledger"
        done
        # phase B activates unless the host defers it to after the router (H3)
        if [ "$verb" = phase-b ]; then case " $all " in *" --defer-activation "*) ;; *) touch "$GREMION_ROOT/active" ;; esac; fi ;;
      record-step) grep -qx mail_principal_issued "$GREMION_ROOT/done.ledger" 2>/dev/null || echo mail_principal_issued >> "$GREMION_ROOT/done.ledger" ;;
      activate)
        grep -qx accounts "$GREMION_ROOT/done.ledger" 2>/dev/null || { echo "STEP_OUT_OF_ORDER: accounts not done" >&2; exit 1; }
        touch "$GREMION_ROOT/active" ;;
      bootstrap-provisioner)
        # docker copies a name-only -e from its caller: the admin credential
        # must be in THIS process environment, and the one-shot writes the SA
        # secret where TENANT_PROVISIONER_SECRET_FILE points (the scratch mount).
        case " $all " in *" -e KEYCLOAK_ADMIN_PASSWORD "*) ;; *) echo "no name-only -e KEYCLOAK_ADMIN_PASSWORD" >&2; exit 1 ;; esac
        case " $all " in *" -e TENANT_PROVISIONER_SECRET_FILE=/run/secrets/provisioner-out/tenant_provisioner "*) ;; *) echo "no scratch TENANT_PROVISIONER_SECRET_FILE" >&2; exit 1 ;; esac
        [ -n "${KEYCLOAK_ADMIN:-}" ] && [ -n "${KEYCLOAK_ADMIN_PASSWORD:-}" ] || { echo "no admin credential in the environment" >&2; exit 1; }
        printf "%s" "$KEYCLOAK_ADMIN_PASSWORD" > "$GREMION_ROOT/kc-pw-seen"
        [ -n "$od" ] && [ -d "$od" ] || { echo "no scratch mount" >&2; exit 1; }
        [ -f "$GREMION_ROOT/bootstrap-writes-nothing" ] || printf "unit-provisioner-sa-secret\n" > "$od/tenant_provisioner"
        # an operator interrupt DURING the one-shot: the secret is already in the
        # scratch directory when the launcher receives the signal (r2 verifier)
        if [ -f "$GREMION_ROOT/bootstrap-signal" ]; then
          i=0; while [ ! -s "$GREMION_ROOT/launcher.pid" ] && [ "$i" -lt 100 ]; do sleep 0.1; i=$((i + 1)); done
          kill -s "$(cat "$GREMION_ROOT/bootstrap-signal")" "$(cat "$GREMION_ROOT/launcher.pid")"
        fi ;;
      render-router)
        printf "# tenant-%s.yml\nhttp:\n  routers:\n    tenant-%s:\n      rule: \"Host(\`x\`)\"\n    tenant-%s.kc:\n      rule: \"x\"\n" "$slug" "$slug" "$slug" ;;
      init)
        # the container writes the ops client secret beside the tenant secrets (first run only)
        mkdir -p "$GREMION_ROOT/tenant-secrets"
        [ -s "$GREMION_ROOT/etc/secrets/control-panel/client_secret" ] || [ -f "$GREMION_ROOT/no-ops-secret" ] \
          || echo unit-ops-client-secret > "$GREMION_ROOT/tenant-secrets/platform_client_control-panel" ;;
      export)
        # the container writes into the bind source (the host dir behind -v <dir>:/export)
        xd=""; for a in $all; do case "$a" in *:/export) xd="${a%:/export}" ;; esac; done
        printf "%s\n" "$all" > "$GREMION_ROOT/export-argv"
        if [ -n "$xd" ] && [ -f "$GREMION_ROOT/export-badmode" ]; then : > "$xd/manifest.json"; chmod 644 "$xd/manifest.json"; fi ;;
      reconcile)
        if [ -f "$GREMION_ROOT/smtp-drift" ] && [ "$2" != --verify-only ]; then echo "{\"repairHost\":[\"smtp-server\"]}"; else echo "{\"repairHost\":[]}"; fi ;;
    esac
    exit 0 ;;
  *" ps -q "*)
    n=3; [ -f "$GREMION_ROOT/extra-container" ] && [ -f "$GREMION_ROOT/after" ] && n=4
    i=0; while [ "$i" -lt "$n" ]; do echo "c$i"; i=$((i + 1)); done; exit 0 ;;
  *" config --services "*) echo gremion-ui; echo control-panel; exit 0 ;;
esac
exit 0'
}

steps() { cat "$ORDER"; }

refute_state_secrets() {
    local v
    for v in unit-pg-root-secret unit-board-secret unit-calendar-secret unit-vault-secret \
             unit-kc-admin-state-secret unit-provisioner-sa-secret; do
        ! grep -qF -- "$v" "$SHIM_LOG" || { echo "secret ${v} on a docker argv"; cat "$SHIM_LOG"; return 1; }
        [[ "$output" != *"$v"* ]] || { echo "secret ${v} printed"; return 1; }
    done
}

# TASK-043d-1 (D10): the create path is customer_create in lib/customer-ops.sh,
# the function the executor's handler calls; the verb `gremion-tenant create`
# is decommissioned (A7 below). These cases drive the library function itself.
lib_create() {   # <customer_create args...>
    run bash -c 'set -euo pipefail; . "$1/common.sh"; . "$1/customer-ops.sh"; shift; setup_paths; customer_create "$@"' _ \
        "${REL}/infra/host/lib" "$@"
}
create() {
    lib_create alpha-rat --host rat.alpha.example --config "${GREMION_ROOT}/tenant-config.json" \
        --it-admin it@alpha.example --council-admin rat@alpha.example --enable calendar,vault --operator "$OP"
}

@test "A7: gremion-tenant create is refused with exit 2 before anything runs: no docker call, no row, no ledger step" {
    run "$LAUNCHER" create alpha-rat --host rat.alpha.example --config "${GREMION_ROOT}/tenant-config.json" \
        --it-admin it@alpha.example --council-admin rat@alpha.example --operator "$OP"
    [ "$status" -eq 2 ] || { echo "status=$status $output"; return 1; }
    [[ "$output" == *"decommissioned"* ]]
    [ ! -s "$SHIM_LOG" ] || { cat "$SHIM_LOG"; return 1; }
    [ ! -s "$ORDER" ]
}

@test "gremion-tenant exists and is executable" {
    [ -x "${HOST_SRC}/bin/gremion-tenant" ]
}

@test "create runs phase A, the host mail step, record-step, phase B, then the router, in that order" {
    create
    [ "$status" -eq 0 ] || { echo "status=$status $output"; steps; return 1; }
    run steps
    [ "${lines[0]}" = "tc phase-a alpha-rat" ]
    [ "${lines[1]}" = "vendor-mail realm-smtp --realm alpha-rat --tenant alpha_rat" ]
    [ "${lines[2]}" = "tc record-step alpha-rat" ]
    [ "${lines[3]}" = "tc phase-b alpha-rat" ]
    [ "${lines[4]}" = "tc render-router alpha-rat" ]
    [ "${lines[5]}" = "tc activate alpha-rat" ]
    [ "${#lines[@]}" -eq 6 ]
    grep -qF '    tenant-alpha-rat.kc:' "${GREMION_ROOT}/etc/edge/tenant-alpha-rat.yml"
    assert_recorded docker '--operator 8d6b9c7e-1f2a-4b3c-9d4e-5f6a7b8c9d0e'
    assert_recorded docker '--enable calendar,vault'
    assert_recorded docker ':/run/gremion/tenant-config.json:ro'
}

# PLAN-mail-transport M2: relay mode. gremion-mail is a recording stub here (its
# own behaviour is test/host/mail-transport.bats); these cases prove the WIRING:
# no vendor-mail call at all, the same 8-step order, and the relay descriptor on
# the container calls that read the stamp back.
relay_front() {
    cat > "${REL}/infra/host/bin/gremion-mail" <<'STUB'
#!/usr/bin/env bash
case "$1" in
  transport) echo relay ;;
  sender-json) echo '{"mode":"relay","host":"relay.example.net","port":587,"fromAddress":"no-reply@example.org","user":"u@example.org"}' ;;
  realm-smtp) printf 'mail %s
' "$*" >> "$ORDER"; [ -f "${GREMION_ROOT}/mail-fails" ] && exit 1 ;;
esac
exit 0
STUB
    chmod +x "${REL}/infra/host/bin/gremion-mail"
}

@test "relay create: phase A, the shared relay sender, record-step, phase B -- the same order, no vendor-mail call, the descriptor on record-step and phase B" {
    relay_front
    create
    [ "$status" -eq 0 ] || { echo "status=$status $output"; steps; return 1; }
    run steps
    [ "${lines[0]}" = "tc phase-a alpha-rat" ]
    [ "${lines[1]}" = "mail realm-smtp --realm alpha-rat --tenant alpha_rat" ]
    [ "${lines[2]}" = "tc record-step alpha-rat" ]
    [ "${lines[3]}" = "tc phase-b alpha-rat" ]
    [ "${lines[4]}" = "tc render-router alpha-rat" ]
    [ "${lines[5]}" = "tc activate alpha-rat" ]
    [ "${#lines[@]}" -eq 6 ]
    [[ "$output" != *"vendor-mail"* ]]
    # the descriptor rides record-step and phase B (the container reads no mail.env) -- and ONLY those
    [ "$(grep -c -- '--sender-json' "$SHIM_LOG")" -eq 2 ] || { cat "$SHIM_LOG"; return 1; }
    grep -E 'record-step.*--sender-json' "$SHIM_LOG" >/dev/null
    grep -E 'phase-b.*--sender-json' "$SHIM_LOG" >/dev/null
}

@test "H3: a router failure leaves the customer NOT active: activate runs only after the router is written" {
    touch "${GREMION_ROOT}/fail-render-router"
    create
    [ "$status" -ne 0 ] || { echo "$output"; return 1; }
    run steps
    [[ "$output" == *"tc phase-b alpha-rat"* ]] || { steps; return 1; }
    assert_absent 'tc activate' "$ORDER" "activate must not run when the router failed"
    [ ! -e "${GREMION_ROOT}/active" ] || { echo "customer marked active without a route"; return 1; }
    [ ! -e "${GREMION_ROOT}/etc/edge/tenant-alpha-rat.yml" ]
}

@test "H6: a create whose phase B failed re-runs to success and creates nothing twice" {
    touch "${GREMION_ROOT}/fail-phase-b"
    create
    [ "$status" -eq 1 ] || { echo "status=$status $output"; return 1; }
    [ ! -e "${GREMION_ROOT}/active" ]
    rm -f "${GREMION_ROOT}/fail-phase-b"
    create
    [ "$status" -eq 0 ] || { echo "status=$status $output"; steps; return 1; }
    [ -e "${GREMION_ROOT}/active" ]
    grep -qF '    tenant-alpha-rat.kc:' "${GREMION_ROOT}/etc/edge/tenant-alpha-rat.yml"
    # the host re-ran the WHOLE sequence in order (phase B refuses to run otherwise)...
    [ "$(grep -c '^tc phase-a ' "$ORDER")" -eq 2 ] && [ "$(grep -c '^tc phase-b ' "$ORDER")" -eq 2 ] || { steps; return 1; }
    # ...and keycloak realm, kernel database, broker account, mail principal, first accounts exist once each
    [ "$(sort "${GREMION_ROOT}/created.log" | uniq -c | awk '$1 != 1' | wc -l)" -eq 0 ] || { cat "${GREMION_ROOT}/created.log"; return 1; }
    [ "$(sort "${GREMION_ROOT}/created.log" | tr '\n' ' ')" = "accounts broker database principal realm " ] || { cat "${GREMION_ROOT}/created.log"; return 1; }
    # the router already in place is replaced, not duplicated, and no temp file is left
    create
    [ "$status" -eq 0 ] || { echo "status=$status $output"; return 1; }
    [ "$(find "${GREMION_ROOT}/etc/edge" -name '*tenant-alpha-rat*' | wc -l)" -eq 1 ]
}

@test "stalwart create: the container calls carry NO --sender-json (byte-identical to before)" {
    create
    [ "$status" -eq 0 ] || { echo "status=$status $output"; return 1; }
    assert_absent '--sender-json' "$SHIM_LOG" "stalwart mode must not pass --sender-json"
    run steps
    [ "${lines[1]}" = "vendor-mail realm-smtp --realm alpha-rat --tenant alpha_rat" ]
}

@test "an unresolved MAIL_TRANSPORT fails create at the mail step: phase B does not run (the real front, no default)" {
    unset MAIL_TRANSPORT
    create
    [ "$status" -ne 0 ] || { echo "$output"; return 1; }
    run steps
    [ "${lines[0]}" = "tc phase-a alpha-rat" ]
    [[ "$output" != *"vendor-mail"* && "$output" != *"phase-b"* && "$output" != *"record-step"* ]] || { steps; return 1; }
}

@test "relay suspend, resume and reconcile go through the front and hand the container the descriptor" {
    relay_front
    run "$LAUNCHER" suspend alpha-rat --operator "$OP" --reason "unit-test reason text"
    [ "$status" -eq 0 ] || { echo "status=$status $output"; return 1; }
    run "$LAUNCHER" resume alpha-rat --operator "$OP" --reason "unit-test reason text"
    [ "$status" -eq 0 ] || { echo "status=$status $output"; return 1; }
    run "$LAUNCHER" reconcile alpha-rat
    [ "$status" -eq 0 ] || { echo "status=$status $output"; return 1; }
    run steps
    [[ "$output" == *"mail realm-smtp --realm alpha-rat --tenant alpha_rat --revoke"* ]]
    [[ "$output" == *"mail realm-smtp --realm alpha-rat --tenant alpha_rat"$'
'* || "$output" == *"mail realm-smtp --realm alpha-rat --tenant alpha_rat" ]]
    [[ "$output" != *"vendor-mail"* ]]
    grep -E 'resume.*--sender-json' "$SHIM_LOG" >/dev/null
    grep -E 'reconcile.*--sender-json' "$SHIM_LOG" >/dev/null
}

@test "a failed host mail step stops before phase B and writes no router" {
    touch "${GREMION_ROOT}/vendor-mail-fails"
    create
    [ "$status" -eq 1 ] || { echo "status=$status $output"; return 1; }
    run steps
    [ "${lines[0]}" = "tc phase-a alpha-rat" ]
    [[ "$output" != *"phase-b"* && "$output" != *"record-step"* && "$output" != *"render-router"* ]] || { steps; return 1; }
    [ ! -e "${GREMION_ROOT}/etc/edge/tenant-alpha-rat.yml" ]
}

@test "a failed phase A stops everything after it" {
    touch "${GREMION_ROOT}/fail-phase-a"
    create
    [ "$status" -eq 1 ]
    run steps
    [ "$output" = "tc phase-a alpha-rat" ]
}

@test "a kill between the temp file and the rename leaves no tenant-*.yml (and no temp file)" {
    shim mv 'exit 137'
    create
    [ "$status" -ne 0 ]
    run find "${GREMION_ROOT}/etc/edge" -name 'tenant-*.yml'
    [ -z "$output" ] || { echo "left: $output"; return 1; }
    run find "${GREMION_ROOT}/etc/edge" -name '.tenant-*'
    [ -z "$output" ] || { echo "temp left: $output"; return 1; }
}

@test "TRD-440: a container that appears during create fails it" {
    shim_docker
    # the fingerprint after phase B sees one more container
    shim mv 'touch "$GREMION_ROOT/after"; touch "$GREMION_ROOT/extra-container"; exec /bin/mv "$@"'
    create
    [ "$status" -eq 1 ] || { echo "status=$status $output"; return 1; }
    [[ "$output" == *"TRD-440"* ]]
}

@test "no secret reaches an argv or the output" {
    create
    [ "$status" -eq 0 ]
    refute_state_secrets
}

@test "suspend: the container first, then the principal revoked" {
    run "$LAUNCHER" suspend alpha-rat --operator "$OP" --reason "unit-test reason text"
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    run steps
    [ "${lines[0]}" = "tc suspend alpha-rat" ]
    [ "${lines[1]}" = "vendor-mail realm-smtp --realm alpha-rat --tenant alpha_rat --revoke" ]
}

@test "resume: a fresh principal first (never --rotate), then the container" {
    run "$LAUNCHER" resume alpha-rat --operator "$OP" --reason "unit-test reason text"
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    run steps
    [ "${lines[0]}" = "vendor-mail realm-smtp --realm alpha-rat --tenant alpha_rat" ]
    [ "${lines[1]}" = "tc resume alpha-rat" ]
}

@test "suspend and resume take runtime/hostd.lock: busy host -> exit 3, nothing runs (TRD-044)" {
    command -v flock >/dev/null || skip "flock not installed"
    exec 8>>"${GREMION_ROOT}/runtime/hostd.lock"
    flock -n 8
    run "$LAUNCHER" suspend alpha-rat --operator "$OP" --reason "unit-test reason text"
    [ "$status" -eq 3 ] || { echo "$status $output"; return 1; }
    [[ "$output" == *"busy"* ]]
    run "$LAUNCHER" resume alpha-rat --operator "$OP" --reason "unit-test reason text"
    [ "$status" -eq 3 ]
    exec 8>&-
    run steps
    [ -z "$output" ]
}

@test "suspend and resume skip the lock when gremion-hostd already holds it" {
    command -v flock >/dev/null || skip "flock not installed"
    exec 8>>"${GREMION_ROOT}/runtime/hostd.lock"
    flock -n 8
    GREMION_HOST_LOCK_HELD=1 run "$LAUNCHER" suspend alpha-rat --operator "$OP" --reason "unit-test reason text"
    exec 8>&-
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
}

@test "a failed revoke fails suspend, and the failure names the rerun that converges (TASK-043c)" {
    touch "${GREMION_ROOT}/vendor-mail-fails"
    run "$LAUNCHER" suspend alpha-rat --operator "$OP" --reason "unit-test reason text"
    [ "$status" -eq 1 ]
    [[ "$output" == *"could not be revoked"* ]] || { echo "$output"; return 1; }
    [[ "$output" == *"rerun gremion-tenant suspend alpha-rat"* ]] || { echo "$output"; return 1; }
}

@test "suspend rerun after a failed host step: the container step runs again harmlessly and the rerun exits 0 (TASK-043c)" {
    touch "${GREMION_ROOT}/vendor-mail-fails"
    run "$LAUNCHER" suspend alpha-rat --operator "$OP" --reason "unit-test reason text"
    [ "$status" -eq 1 ]
    rm -f "${GREMION_ROOT}/vendor-mail-fails"
    run "$LAUNCHER" suspend alpha-rat --operator "$OP" --reason "unit-test reason text"
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    run steps
    [ "${lines[0]}" = "tc suspend alpha-rat" ]
    [ "${lines[1]}" = "vendor-mail realm-smtp --realm alpha-rat --tenant alpha_rat --revoke" ]
    [ "${lines[2]}" = "tc suspend alpha-rat" ]
    [ "${lines[3]}" = "vendor-mail realm-smtp --realm alpha-rat --tenant alpha_rat --revoke" ]
    [ "${#lines[@]}" -eq 4 ]
}

@test "resume after a half suspend (host step failed): a fresh issue, never --rotate, then the container (TASK-043c)" {
    touch "${GREMION_ROOT}/vendor-mail-fails"
    run "$LAUNCHER" suspend alpha-rat --operator "$OP" --reason "unit-test reason text"
    [ "$status" -eq 1 ]
    rm -f "${GREMION_ROOT}/vendor-mail-fails"
    : > "$ORDER"
    run "$LAUNCHER" resume alpha-rat --operator "$OP" --reason "unit-test reason text"
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    run steps
    [ "${lines[0]}" = "vendor-mail realm-smtp --realm alpha-rat --tenant alpha_rat" ]
    [ "${lines[1]}" = "tc resume alpha-rat" ]
    [[ "$output" != *"--rotate"* && "$output" != *"--revoke"* ]]
}

@test "suspend and resume put no app password and no secret on an argv or in the output (TASK-043c)" {
    run "$LAUNCHER" suspend alpha-rat --operator "$OP" --reason "unit-test reason text"
    [ "$status" -eq 0 ]
    refute_state_secrets
    [[ "$output" != *"APP-PASSWORD"* ]]
    run "$LAUNCHER" resume alpha-rat --operator "$OP" --reason "unit-test reason text"
    [ "$status" -eq 0 ]
    refute_state_secrets
    [[ "$output" != *"APP-PASSWORD"* ]]
    ! grep -q 'APP-PASSWORD' "$SHIM_LOG"
}

@test "reconcile --apply rotates on the host when smtp-server is repair: host, then re-verifies" {
    touch "${GREMION_ROOT}/smtp-drift"
    run "$LAUNCHER" reconcile alpha-rat --apply --reason "unit-test reason text"
    [ "$status" -eq 0 ] || { echo "$output"; steps; return 1; }
    run steps
    [ "${lines[0]}" = "tc reconcile alpha-rat" ]
    [ "${lines[1]}" = "vendor-mail realm-smtp --realm alpha-rat --tenant alpha_rat --rotate" ]
    [ "${lines[2]}" = "tc reconcile --verify-only" ]
}

@test "reconcile without --apply only verifies, and never rotates" {
    touch "${GREMION_ROOT}/smtp-drift"
    run "$LAUNCHER" reconcile alpha-rat
    [ "$status" -eq 0 ] || { echo "status=$status $output"; return 1; }
    run steps
    [ "$output" = "tc reconcile --verify-only" ] || { echo "$output"; return 1; }
    [[ "$output" != *"vendor-mail"* ]]
}

@test "reconcile --apply: a crashed apply (no report) fails loudly and never rotates (review C, r2)" {
    touch "${GREMION_ROOT}/smtp-drift" "${GREMION_ROOT}/fail-reconcile"
    run "$LAUNCHER" reconcile alpha-rat --apply --reason "unit-test reason text"
    [ "$status" -eq 1 ] || { echo "status=$status $output"; return 1; }
    [[ "$output" == *"no parseable report"* ]] || { echo "$output"; return 1; }
    run steps
    [[ "$output" != *"vendor-mail"* ]]
}

@test "usage: no operator, a bad slug, platform, and no active colour are exit 2" {
    run "$LAUNCHER" suspend alpha-rat
    [ "$status" -eq 2 ]
    run "$LAUNCHER" suspend 1ab --operator "$OP" --reason "unit-test reason text"
    [ "$status" -eq 2 ]
    run "$LAUNCHER" suspend platform --operator "$OP" --reason "unit-test reason text"
    [ "$status" -eq 2 ]
    rm -f "${GREMION_ROOT}/runtime/active-colour"
    run "$LAUNCHER" suspend alpha-rat --operator "$OP" --reason "unit-test reason text"
    [ "$status" -eq 2 ]
    run steps
    [ -z "$output" ]
}

@test "operator add --no-mail is refused on a host with vendor mail (Q23)" {
    : > "${GREMION_ROOT}/etc/env/mail.env"
    run "$LAUNCHER" operator add ops@platform.example --no-mail
    [ "$status" -eq 2 ] || { echo "$output"; return 1; }
    run steps
    [ -z "$output" ]
}

@test "init renders the tenant-create credential files 0600 without an argv secret, then runs the container init" {
    run "$LAUNCHER" init
    [ "$status" -eq 0 ] || { echo "status=$status $output"; steps; return 1; }
    local d="${GREMION_ROOT}/etc/secrets/tenant-create" f
    for f in kernel_pg_admin module_pg_admin_calendar module_pg_admin_newsletter module_app_password_vault; do
        [ -s "${d}/${f}" ] || { echo "missing ${f}"; return 1; }
    done
    grep -qx 'postgresql://postgres:unit-pg-root-secret@postgres-guardstack:5432/postgres' "${d}/kernel_pg_admin"
    grep -qx 'postgresql://calendar:unit-calendar-secret@calendar-postgres:5432/postgres' "${d}/module_pg_admin_calendar"
    assert_mode_600 "${d}/kernel_pg_admin"
    run steps
    [ "${lines[0]}" = "tc bootstrap-provisioner " ] || { steps; return 1; }
    [ "${lines[1]}" = "tc init --panel-origin" ]
    refute_state_secrets
    # the ops client secret moved into the panel's directory, 0600, and left the tenant secrets
    [ "$(cat "${GREMION_ROOT}/etc/secrets/control-panel/client_secret")" = unit-ops-client-secret ]
    [ ! -e "${GREMION_ROOT}/tenant-secrets/platform_client_control-panel" ]
}

# TASK-043b F1: every tenant-create verb reads the provisioner credential from
# the read-only etc/secrets/tenant-create mount; init is what puts it there.
@test "init bootstraps the provisioner ONCE: the SA secret lands in etc/secrets/tenant-create/tenant_provisioner 0600, the admin password only by a name-only -e (TASK-043b F1)" {
    run "$LAUNCHER" init
    [ "$status" -eq 0 ] || { echo "status=$status $output"; steps; cat "$SHIM_LOG"; return 1; }
    local f="${GREMION_ROOT}/etc/secrets/tenant-create/tenant_provisioner"
    [ "$(cat "$f")" = unit-provisioner-sa-secret ] || { echo "credential: $(cat "$f" 2>&1)"; return 1; }
    assert_mode_600 "$f"
    # the admin credential came from state.env and reached the one-shot's environment, never an argv
    [ "$(cat "${GREMION_ROOT}/kc-pw-seen")" = unit-kc-admin-state-secret ]
    assert_recorded docker '-e KEYCLOAK_ADMIN_PASSWORD tenant-create bootstrap-provisioner'
    refute_state_secrets
    # the scratch directory is gone, and nothing but the credential was moved
    run find "${GREMION_ROOT}/etc/secrets" -maxdepth 1 -name '.tenant-provisioner.*'
    [ -z "$output" ] || { echo "scratch left: $output"; return 1; }
    # a rerun keeps the credential and never bootstraps again
    : > "$ORDER"
    run "$LAUNCHER" init
    [ "$status" -eq 0 ] || { echo "status=$status $output"; return 1; }
    run steps
    [ "$output" = "tc init --panel-origin" ] || { echo "$output"; return 1; }
    [ "$(cat "$f")" = unit-provisioner-sa-secret ]
}

@test "init --realm-only on a pooled host bootstraps the provisioner too, before the container init (TASK-043b F1)" {
    run "$LAUNCHER" init --realm-only
    [ "$status" -eq 0 ] || { echo "status=$status $output"; steps; return 1; }
    run steps
    [ "${lines[0]}" = "tc bootstrap-provisioner " ] || { steps; return 1; }
    [ "${lines[1]}" = "tc init --panel-origin" ]
    [ -s "${GREMION_ROOT}/etc/secrets/tenant-create/tenant_provisioner" ]
}

@test "init without the provisioner credential and without a Keycloak admin credential is exit 2, named, before any container (TASK-043b F1)" {
    sed -i '/^KEYCLOAK_ADMIN/d' "${GREMION_ROOT}/etc/env/state.env"
    run env -u KEYCLOAK_ADMIN -u KEYCLOAK_ADMIN_PASSWORD "$LAUNCHER" init
    [ "$status" -eq 2 ] || { echo "status=$status $output"; return 1; }
    [[ "$output" == *"KEYCLOAK_ADMIN"* && "$output" == *"bootstrap-provisioner"* ]] || { echo "$output"; return 1; }
    run steps
    [ -z "$output" ] || { echo "a container ran: $output"; return 1; }
}

@test "a failed or empty bootstrap-provisioner fails init (exit 1) before the container init, and leaves no credential and no scratch (TASK-043b F1)" {
    touch "${GREMION_ROOT}/fail-bootstrap-provisioner"
    run "$LAUNCHER" init
    [ "$status" -eq 1 ] || { echo "status=$status $output"; return 1; }
    run steps
    [ "$output" = "tc bootstrap-provisioner " ] || { echo "$output"; return 1; }
    [ ! -e "${GREMION_ROOT}/etc/secrets/tenant-create/tenant_provisioner" ]
    rm -f "${GREMION_ROOT}/fail-bootstrap-provisioner"
    touch "${GREMION_ROOT}/bootstrap-writes-nothing"
    : > "$ORDER"
    run "$LAUNCHER" init
    [ "$status" -eq 1 ] || { echo "status=$status $output"; return 1; }
    [[ "$output" == *"wrote no credential"* ]] || { echo "$output"; return 1; }
    run steps
    [ "$output" = "tc bootstrap-provisioner " ] || { echo "$output"; return 1; }
    [ ! -e "${GREMION_ROOT}/etc/secrets/tenant-create/tenant_provisioner" ]
    run find "${GREMION_ROOT}/etc/secrets" -maxdepth 1 -name '.tenant-provisioner.*'
    [ -z "$output" ] || { echo "scratch left: $output"; return 1; }
}

# TASK-043b r2 (verifier LOW): a SIGTERM while the one-shot runs -- the SA
# secret already sits in the scratch directory -- must not leave that directory
# behind. (SIGINT takes the same trap; a background job of a non-interactive
# shell starts with SIGINT ignored, so only TERM is deliverable from here.)
@test "a SIGTERM during bootstrap-provisioner fails init and leaves no scratch directory holding the SA secret, and no credential (TASK-043b r2)" {
    printf 'TERM' > "${GREMION_ROOT}/bootstrap-signal"
    local rc=0 pid
    "$LAUNCHER" init > "${GREMION_ROOT}/bg.out" 2>&1 &
    pid=$!
    echo "$pid" > "${GREMION_ROOT}/launcher.pid"
    wait "$pid" || rc=$?
    [ "$rc" -ne 0 ] || { echo "init exited 0 after SIGTERM"; cat "${GREMION_ROOT}/bg.out"; return 1; }
    run steps
    [ "$output" = "tc bootstrap-provisioner " ] || { echo "steps: $output"; return 1; }
    [ ! -e "${GREMION_ROOT}/etc/secrets/tenant-create/tenant_provisioner" ]
    run find "${GREMION_ROOT}/etc/secrets" -maxdepth 1 -name '.tenant-provisioner.*'
    [ -z "$output" ] || { echo "scratch left after SIGTERM (rc=${rc}): $output"; return 1; }
}

@test "a failing mktemp for the bootstrap scratch directory fails init by name, before any container (TASK-043b r2)" {
    local real
    real="$(command -v mktemp)"
    shim mktemp "case \"\$*\" in *.tenant-provisioner.*) exit 1 ;; esac; exec '${real}' \"\$@\""
    run "$LAUNCHER" init
    [ "$status" -ne 0 ] || { echo "status=$status $output"; return 1; }
    [[ "$output" == *"scratch directory"* ]] || { echo "unnamed failure: $output"; return 1; }
    run steps
    [ -z "$output" ] || { echo "a container ran: $output"; return 1; }
}

# TASK-043b F5: init reads <ID>_PG_PASSWORD for every module server from
# state.env. Proven against a state.env RENDERED from the shipped template by
# gremion-init-secrets (the host's own path), never a hand-written fixture.
@test "init passes its own credential check on a state.env rendered from the shipped template: all six <ID>_PG_PASSWORD keys exist (TASK-043b F5)" {
    rm -f "${GREMION_ROOT}/etc/env/"*.env
    run "${HOST_SRC}/bin/gremion-init-secrets" --root "$GREMION_ROOT" --stack guardstack
    [ "$status" -eq 0 ] || { echo "render: status=$status $output"; return 1; }
    printf 'TENANT_SECRETS_DIR=%s/tenant-secrets\n' "$GREMION_ROOT" >> "${GREMION_ROOT}/etc/env/app-blue.env"
    # init's own check first: it dies "<ID>_PG_PASSWORD is empty in state.env".
    run "$LAUNCHER" init
    [ "$status" -eq 0 ] || { echo "status=$status $output"; return 1; }
    [[ "$output" == *"kernel and 6 module server credential file(s)"* ]] || { echo "$output"; return 1; }
    local id up
    for id in board calendar content finance newsletter vault; do
        up="$(printf '%s' "$id" | tr '[:lower:]' '[:upper:]')"
        grep -qE "^${up}_PG_PASSWORD=[A-Za-z0-9]{32}$" "${GREMION_ROOT}/etc/env/state.env" \
            || { echo "state.env carries no generated ${up}_PG_PASSWORD"; return 1; }
        grep -qx "${up}_PG_USER=${id}" "${GREMION_ROOT}/etc/env/state.env" \
            || { echo "state.env carries no ${up}_PG_USER=${id}"; return 1; }
        [ -s "${GREMION_ROOT}/etc/secrets/tenant-create/module_pg_admin_${id}" ] || { echo "no module_pg_admin_${id}"; return 1; }
    done
    # TASK-198: Synapse's own PostgreSQL server adds MESSAGING_PG_PASSWORD (generated, no tenant-create admin file).
    grep -qE '^MESSAGING_PG_PASSWORD=[A-Za-z0-9]{32}$' "${GREMION_ROOT}/etc/env/state.env" \n        || { echo "state.env carries no generated MESSAGING_PG_PASSWORD"; return 1; }
    # Every <ID>_PG_PASSWORD DISTINCT: one server's credential never opens another (7 servers since TASK-198).
    local keys distinct
    keys="$(grep -cE '^[A-Z]+_PG_PASSWORD=' "${GREMION_ROOT}/etc/env/state.env")"
    distinct="$(grep -E '^[A-Z]+_PG_PASSWORD=' "${GREMION_ROOT}/etc/env/state.env" | cut -d= -f2 | sort -u | wc -l)"
    [ "$keys" -ge 7 ] && [ "$distinct" -eq "$keys" ] || { echo "keys=$keys distinct=$distinct"; return 1; }
}

@test "init fails loudly when the ops client secret never arrives (review C, r2)" {
    touch "${GREMION_ROOT}/no-ops-secret"
    run "$LAUNCHER" init
    [ "$status" -eq 1 ] || { echo "status=$status $output"; return 1; }
    [[ "$output" == *"control-panel client secret"* ]]
}

# shim_kcadm — `docker exec [-i] <kc> kcadm.sh ...` against a fake Keycloak
# whose state is files under GREMION_ROOT; stdin of a create is kept.
shim_kcadm() {
    shim docker '
case " $* " in
  *" config credentials "*) exit 0 ;;
  *" get realms/platform --fields attributes(*) "*)
    [ -f "$GREMION_ROOT/kc-500" ] && { echo "HTTP error - 500 Internal Server Error" >&2; exit 1; }
    [ -f "$GREMION_ROOT/realm.json" ] || { echo "Resource not found for url: http://127.0.0.1:8080/auth/admin/realms/platform" >&2; exit 1; }
    jq "{attributes}" "$GREMION_ROOT/realm.json"; exit 0 ;;
  *" get realms/platform --fields attributes "*)
    # Keycloak 26.6: a bare --fields attributes answers the map EMPTY.
    [ -f "$GREMION_ROOT/realm.json" ] || exit 1
    echo "{\"attributes\":{}}"; exit 0 ;;
  *" get realms/platform "*)
    [ -f "$GREMION_ROOT/realm.json" ] || [ -f "$GREMION_ROOT/realm-present" ] || exit 1
    echo "{\"realm\":\"platform\"}"; exit 0 ;;
  *" create realms -f - "*) cat > "$GREMION_ROOT/realm.json"; exit 0 ;;
  *" get users -r platform "*)
    if [ -f "$GREMION_ROOT/user.json" ]; then echo "[{\"id\":\"4f1c2a9e-0000-4000-8000-000000000001\"}]"; else echo "[]"; fi; exit 0 ;;
  *" create users -r platform -f - "*) cat > "$GREMION_ROOT/user.json"; exit 0 ;;
  *" add-roles "*) printf "%s\n" "$*" >> "$GREMION_ROOT/roles.log"; exit 0 ;;
esac
exit 0'
}

@test "init --realm-only --keycloak-container: the ops realm by kcadm on stdin, the client exact to --panel-origin, its secret 0600, never on an argv (R29-I3, R29-I11)" {
    shim_kcadm
    KEYCLOAK_ADMIN=admin KEYCLOAK_ADMIN_PASSWORD=unit-kc-admin-secret \
        run "$LAUNCHER" init --realm-only --keycloak-container kc-fixture --panel-origin https://panel.fixture.example
    [ "$status" -eq 0 ] || { echo "status=$status $output"; cat "$SHIM_LOG"; return 1; }
    local f="${GREMION_ROOT}/etc/secrets/control-panel/client_secret" secret
    [ -s "$f" ]
    assert_mode_600 "$f"
    secret="$(tr -d '\n' < "$f")"
    run jq -r '.clients[] | select(.clientId == "control-panel") | [.secret == $s, (.redirectUris | tostring), (.webOrigins | tostring)] | @tsv' --arg s "$secret" "${GREMION_ROOT}/realm.json"
    [ "$output" = $'true\t["https://panel.fixture.example/*"]\t["https://panel.fixture.example"]' ] || { echo "$output"; return 1; }
    ! grep -qF -- "$secret" "$SHIM_LOG" || { echo "client secret on an argv"; return 1; }
    ! grep -qF -- unit-kc-admin-secret "$SHIM_LOG" || { echo "admin password on an argv"; return 1; }
    # A rerun finds the realm equal and creates nothing.
    : > "$SHIM_LOG"
    KEYCLOAK_ADMIN=admin KEYCLOAK_ADMIN_PASSWORD=unit-kc-admin-secret \
        run "$LAUNCHER" init --realm-only --keycloak-container kc-fixture --panel-origin https://panel.fixture.example
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    ! grep -q 'create realms' "$SHIM_LOG" || { echo "a realm was created"; return 1; }
    # Another origin is a DIFFERENT realm: refused, never overwritten.
    KEYCLOAK_ADMIN=admin KEYCLOAK_ADMIN_PASSWORD=unit-kc-admin-secret \
        run "$LAUNCHER" init --realm-only --keycloak-container kc-fixture --panel-origin https://other.fixture.example
    [ "$status" -eq 1 ]
    [[ "$output" == *"differs"* ]]
}

@test "init --realm-only --keycloak-container: the grafana client's secret goes to etc/secrets/grafana/client_secret 0600, never on an argv; an equal realm without it is refused (TASK-039 G11)" {
    shim_kcadm
    KEYCLOAK_ADMIN=admin KEYCLOAK_ADMIN_PASSWORD=unit-kc-admin-secret \
        run "$LAUNCHER" init --realm-only --keycloak-container kc-fixture --panel-origin https://panel.fixture.example
    [ "$status" -eq 0 ] || { echo "status=$status $output"; cat "$SHIM_LOG"; return 1; }
    local f="${GREMION_ROOT}/etc/secrets/grafana/client_secret" secret panel
    [ -s "$f" ]
    assert_mode_600 "$f"
    secret="$(tr -d '\n' < "$f")"
    panel="$(tr -d '\n' < "${GREMION_ROOT}/etc/secrets/control-panel/client_secret")"
    [ "${#secret}" -ge 32 ] && [ "$secret" != "$panel" ]
    run jq -r --arg s "$secret" '.clients[] | select(.clientId == "grafana") | [.secret == $s, (.redirectUris | tostring)] | @tsv' "${GREMION_ROOT}/realm.json"
    [ "$output" = $'true\t["http://127.0.0.1:3000/login/generic_oauth"]' ] || { echo "$output"; return 1; }
    ! grep -qF -- "$secret" "$SHIM_LOG" || { echo "grafana client secret on an argv"; return 1; }
    [[ "$output" != *"$secret"* ]]
    # The committed template carries no grafana secret at all.
    run jq -e '.clients[] | select(.clientId == "grafana") | has("secret") | not' "${REL}/docker/keycloak/realm-export.ops.json"
    [ "$status" -eq 0 ]
    # Equal realm, grafana secret gone: refused, naming the file.
    rm -f "$f"
    KEYCLOAK_ADMIN=admin KEYCLOAK_ADMIN_PASSWORD=unit-kc-admin-secret \
        run "$LAUNCHER" init --realm-only --keycloak-container kc-fixture --panel-origin https://panel.fixture.example
    [ "$status" -eq 1 ] || { echo "status=$status $output"; return 1; }
    [[ "$output" == *"etc/secrets/grafana/client_secret is missing"* ]]
}

@test "init --realm-only --keycloak-container: a transient kcadm error is never 'absent' -- no create, the client secret untouched (review C, r2)" {
    shim_kcadm
    mkdir -p "${GREMION_ROOT}/etc/secrets/control-panel"
    printf 'the-working-secret\n' > "${GREMION_ROOT}/etc/secrets/control-panel/client_secret"
    touch "${GREMION_ROOT}/kc-500"
    KEYCLOAK_ADMIN=admin KEYCLOAK_ADMIN_PASSWORD=unit-kc-admin-secret \
        run "$LAUNCHER" init --realm-only --keycloak-container kc-fixture --panel-origin https://panel.fixture.example
    [ "$status" -eq 1 ] || { echo "status=$status $output"; return 1; }
    [[ "$output" == *"not known to be absent"* ]] || { echo "$output"; return 1; }
    ! grep -q 'create realms' "$SHIM_LOG" || { echo "a realm was created"; return 1; }
    [ "$(cat "${GREMION_ROOT}/etc/secrets/control-panel/client_secret")" = the-working-secret ]
}

@test "operator add --no-mail --keycloak-container: a platform user with a temporary password on stdin only, the operator role, printed once (Q23, R29-I3)" {
    shim_kcadm
    touch "${GREMION_ROOT}/realm-present"
    rm -f "${GREMION_ROOT}/runtime/active-colour"   # the test env has no colours
    KEYCLOAK_ADMIN=admin KEYCLOAK_ADMIN_PASSWORD=unit-kc-admin-secret \
        run --separate-stderr "$LAUNCHER" operator add ops@platform.example --no-mail --keycloak-container kc-fixture
    [ "$status" -eq 0 ] || { echo "status=$status $output $stderr"; cat "$SHIM_LOG"; return 1; }
    local pw
    pw="$(jq -r '.credentials[0] | select(.type == "password" and .temporary == true) | .value' "${GREMION_ROOT}/user.json")"
    [ -n "$pw" ] && [ "${#pw}" -ge 20 ]
    run jq -c '[.username, .email, .enabled, (.requiredActions | sort)]' "${GREMION_ROOT}/user.json"
    [ "$output" = '["ops@platform.example","ops@platform.example",true,["CONFIGURE_TOTP","UPDATE_PASSWORD"]]' ] || { echo "$output"; return 1; }
    grep -q -- '--rolename operator' "${GREMION_ROOT}/roles.log"
    ! grep -qF -- "$pw" "$SHIM_LOG" || { echo "temporary password on an argv"; return 1; }
    ! grep -qF -- unit-kc-admin-secret "$SHIM_LOG" || { echo "admin password on an argv"; return 1; }
    KEYCLOAK_ADMIN=admin KEYCLOAK_ADMIN_PASSWORD=unit-kc-admin-secret \
        run --separate-stderr "$LAUNCHER" operator add ops@platform.example --no-mail --keycloak-container kc-fixture
    # A second run: the user exists, no password is set or printed.
    [ "$status" -eq 0 ]
    [[ "$output" != *"TEMPORARY-PASSWORD"* ]]
    [ "$(grep -c 'create users' "$SHIM_LOG")" -eq 1 ]
}

@test "operator add --no-mail --keycloak-container prints the temporary password exactly once, on stdout" {
    shim_kcadm
    touch "${GREMION_ROOT}/realm-present"
    KEYCLOAK_ADMIN=admin KEYCLOAK_ADMIN_PASSWORD=unit-kc-admin-secret \
        run --separate-stderr "$LAUNCHER" operator add ops@platform.example --no-mail --keycloak-container kc-fixture
    [ "$status" -eq 0 ]
    local pw
    pw="$(jq -r '.credentials[0].value' "${GREMION_ROOT}/user.json")"
    [ "$(grep -c "^TEMPORARY-PASSWORD: ${pw}$" <<< "$output")" -eq 1 ]
    [[ "$stderr" != *"$pw"* ]]
}

@test "operator add --keycloak-container without --no-mail, or without the ops realm, is refused before any user" {
    shim_kcadm
    KEYCLOAK_ADMIN=admin KEYCLOAK_ADMIN_PASSWORD=x run "$LAUNCHER" operator add ops@platform.example --keycloak-container kc-fixture
    [ "$status" -eq 2 ] || { echo "$output"; return 1; }
    KEYCLOAK_ADMIN=admin KEYCLOAK_ADMIN_PASSWORD=x run "$LAUNCHER" operator add ops@platform.example --no-mail --keycloak-container kc-fixture
    [ "$status" -eq 2 ] || { echo "$output"; return 1; }
    [[ "$output" == *"init --realm-only"* ]]
    [ ! -e "${GREMION_ROOT}/user.json" ]
}

@test "init keeps an app password it already wrote (a rerun never rotates a module role)" {
    run "$LAUNCHER" init
    local before; before="$(cat "${GREMION_ROOT}/etc/secrets/tenant-create/module_app_password_calendar")"
    run "$LAUNCHER" init
    [ "$status" -eq 0 ]
    [ "$(cat "${GREMION_ROOT}/etc/secrets/tenant-create/module_app_password_calendar")" = "$before" ]
}

# ── TASK-044 (lane note D4, A5): the release tip reaches tenant-create ────────
# The level-1 gate compares isolation evidence with GREMION_RELEASE_TIP, the
# HEAD of the release tree gremion-deploy authenticated (H10). tc() derives it
# and passes it on EVERY one-shot; it is never typed by the operator.

# release_repo — make the release dir a git checkout with one commit; prints HEAD.
release_repo() {
    git -C "$REL" init -q
    git -C "$REL" -c user.email=t044@example.invalid -c user.name=t044 -c commit.gpgsign=false commit -q --allow-empty -m release
    git -C "$REL" rev-parse HEAD
}

@test "TASK-044: tc passes GREMION_RELEASE_TIP = the release tree's HEAD on every one-shot of create" {
    local tip; tip="$(release_repo)"
    [[ "$tip" =~ ^[0-9a-f]{40}$ ]] || { echo "no commit: $tip"; return 1; }
    create
    [ "$status" -eq 0 ] || { echo "status=$status $output"; return 1; }
    local runs with
    runs="$(grep -c ' run .* tenant-create ' "$SHIM_LOG" || true)"
    with="$(grep ' run .* tenant-create ' "$SHIM_LOG" | grep -cF -- "-e GREMION_RELEASE_TIP=${tip} " || true)"
    [ "$runs" -ge 4 ] && [ "$runs" -eq "$with" ] || { echo "runs=$runs with-tip=$with"; cat "$SHIM_LOG"; return 1; }
}

@test "TASK-044: a release dir that is no git checkout passes an EMPTY tip (even inside another repo), and status and suspend still run" {
    git -C "$GREMION_ROOT" init -q    # a parent repository must never lend its HEAD
    git -C "$GREMION_ROOT" -c user.email=t044@example.invalid -c user.name=t044 -c commit.gpgsign=false commit -q --allow-empty -m parent
    run "$LAUNCHER" status alpha-rat
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    assert_recorded docker '-e GREMION_RELEASE_TIP= -e TRAEFIK_CERT_RESOLVER'
    run "$LAUNCHER" suspend alpha-rat --operator "$OP" --reason "unit-test reason text"
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    ! grep -E -- '-e GREMION_RELEASE_TIP=[0-9a-f]' "$SHIM_LOG" || { echo "a tip was derived from a tree that is no release checkout"; return 1; }
}

@test "TASK-044: the tip is not an operator input -- a GREMION_RELEASE_TIP in the caller's environment is ignored" {
    local tip; tip="$(release_repo)"
    GREMION_RELEASE_TIP="$(printf 'f%.0s' {1..40})" run "$LAUNCHER" status alpha-rat
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    assert_recorded docker "-e GREMION_RELEASE_TIP=${tip} "
    ! grep -qF -- "GREMION_RELEASE_TIP=ffffffffffffffffffffffffffffffffffffffff" "$SHIM_LOG" || { echo "the caller's tip reached the one-shot"; return 1; }
}

# ── TASK-044 (D2, section 9): create carries the operator's DPIA decisions ────
# The level-1 gate wants a written DPIA decision per --enable module BEFORE the
# customer exists; --dpia-json is the only way a create request carries them.

@test "TASK-044: create --dpia-json mounts the file read-only and passes it to phase A and phase B" {
    printf '{"calendar":{"requiresDpia":"no","reasonCodes":["x"],"documentRef":"TOM-1"}}' > "${GREMION_ROOT}/dpia.json"
    lib_create alpha-rat --host rat.alpha.example --config "${GREMION_ROOT}/tenant-config.json" \
        --it-admin it@alpha.example --council-admin rat@alpha.example --enable calendar --dpia-json "${GREMION_ROOT}/dpia.json" --operator "$OP"
    [ "$status" -eq 0 ] || { echo "status=$status $output"; return 1; }
    local mounted passed
    mounted="$(grep -c -- ':/run/gremion/dpia.json:ro' "$SHIM_LOG" || true)"
    passed="$(grep -c -- '--dpia-json /run/gremion/dpia.json' "$SHIM_LOG" || true)"
    [ "$mounted" -eq 2 ] && [ "$passed" -eq 2 ] || { echo "mounted=$mounted passed=$passed"; cat "$SHIM_LOG"; return 1; }
}

@test "TASK-044: create without --dpia-json mounts and passes no decision file; a missing file is a usage error" {
    create
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    ! grep -q 'dpia.json' "$SHIM_LOG" || { cat "$SHIM_LOG"; return 1; }
    lib_create alpha-rat --host rat.alpha.example --config "${GREMION_ROOT}/tenant-config.json" \
        --it-admin it@alpha.example --council-admin rat@alpha.example --enable calendar --dpia-json "${GREMION_ROOT}/absent.json" --operator "$OP"
    [ "$status" -eq 2 ] || { echo "status=$status $output"; return 1; }
}

@test "TASK-044: every tenant-create one-shot forwards GREMION_SCRATCH_FIXTURES by name only (never a value)" {
    GREMION_SCRATCH_FIXTURES=t043-0123abcd run "$LAUNCHER" status alpha-rat
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    assert_recorded docker '-e GREMION_SCRATCH_FIXTURES '
    assert_recorded docker '-e GREMION_PRODUCTION_STACK '
    ! grep -qF -- 'GREMION_SCRATCH_FIXTURES=' "$SHIM_LOG" || { echo "a value was inlined"; return 1; }
}

# ── TRD-149/150/151: gremion-tenant export <slug> <dir> ──────────────────────

@test "export: arguments are validated before any container (exit 2, no tc call)" {
    run "$LAUNCHER" export
    [ "$status" -eq 2 ]
    run "$LAUNCHER" export alpha-rat
    [ "$status" -eq 2 ]
    run "$LAUNCHER" export alpha-rat "${GREMION_ROOT}/o" extra
    [ "$status" -eq 2 ]
    run "$LAUNCHER" export 1ab "${GREMION_ROOT}/o"
    [ "$status" -eq 2 ]
    run "$LAUNCHER" export platform "${GREMION_ROOT}/o"
    [ "$status" -eq 2 ]
    run "$LAUNCHER" export alpha-rat relative/dir
    [ "$status" -eq 2 ]
    run "$LAUNCHER" export alpha-rat "${GREMION_ROOT}/a:b"
    [ "$status" -eq 2 ]
    run "$LAUNCHER" export alpha-rat "${GREMION_ROOT}/../escape"
    [ "$status" -eq 2 ]
    run "$LAUNCHER" export alpha-rat "${GREMION_ROOT}/no-parent/out"
    [ "$status" -eq 2 ]
    run steps
    [ -z "$output" ]
    [ ! -e "${GREMION_ROOT}/o" ]
}

@test "export: a non-empty directory, a file and a symlink are refused (exit 2), nothing is run or touched" {
    mkdir "${GREMION_ROOT}/full"; echo keep > "${GREMION_ROOT}/full/old.csv"
    run "$LAUNCHER" export alpha-rat "${GREMION_ROOT}/full"
    [ "$status" -eq 2 ]
    [[ "$output" == *"not empty"* ]]
    [ "$(cat "${GREMION_ROOT}/full/old.csv")" = keep ]
    : > "${GREMION_ROOT}/afile"
    run "$LAUNCHER" export alpha-rat "${GREMION_ROOT}/afile"
    [ "$status" -eq 2 ]
    mkdir "${GREMION_ROOT}/real"; ln -s "${GREMION_ROOT}/real" "${GREMION_ROOT}/link"
    run "$LAUNCHER" export alpha-rat "${GREMION_ROOT}/link"
    [ "$status" -eq 2 ]
    run steps
    [ -z "$output" ]
}

@test "export: a symlink anywhere in the parent path is refused (exit 2), nothing is created behind it" {
    mkdir "${GREMION_ROOT}/elsewhere"; ln -s "${GREMION_ROOT}/elsewhere" "${GREMION_ROOT}/plink"
    run "$LAUNCHER" export alpha-rat "${GREMION_ROOT}/plink/out"
    [ "$status" -eq 2 ]
    [[ "$output" == *"symlink"* ]]
    [ ! -e "${GREMION_ROOT}/elsewhere/out" ]
    mkdir -p "${GREMION_ROOT}/elsewhere/deep"
    run "$LAUNCHER" export alpha-rat "${GREMION_ROOT}/plink/deep/out"
    [ "$status" -eq 2 ]
    [ ! -e "${GREMION_ROOT}/elsewhere/deep/out" ]
    run steps
    [ -z "$output" ]
}

@test "export: creates the directory 0700, runs export then a SEPARATE export-verify, bind-mounted, as the invoking user" {
    run "$LAUNCHER" export alpha-rat "${GREMION_ROOT}/out"
    [ "$status" -eq 0 ]
    [ "$(stat -c %a "${GREMION_ROOT}/out")" = 700 ]
    run steps
    [ "${lines[0]}" = "tc export alpha-rat" ]
    [ "${lines[1]}" = "tc export-verify /export" ]
    [ "${#lines[@]}" -eq 2 ]
    grep -q -- "--out /export" "${GREMION_ROOT}/export-argv"
    grep -q -- "--user $(id -u):$(id -g)" "${GREMION_ROOT}/export-argv"
}

@test "export: an empty existing directory is accepted and tightened to 0700" {
    mkdir -m 755 "${GREMION_ROOT}/empty"
    run "$LAUNCHER" export alpha-rat "${GREMION_ROOT}/empty"
    [ "$status" -eq 0 ]
    [ "$(stat -c %a "${GREMION_ROOT}/empty")" = 700 ]
}

@test "export: a failed export exits 1 and says the directory is incomplete; the check does not run" {
    : > "${GREMION_ROOT}/fail-export"
    run "$LAUNCHER" export alpha-rat "${GREMION_ROOT}/out"
    [ "$status" -eq 1 ]
    [[ "$output" == *INCOMPLETE* ]]
    run steps
    [ "${#lines[@]}" -eq 1 ]
}

@test "export: a failed completeness check exits 1 and says the export is incomplete" {
    : > "${GREMION_ROOT}/fail-export-verify"
    run "$LAUNCHER" export alpha-rat "${GREMION_ROOT}/out"
    [ "$status" -eq 1 ]
    [[ "$output" == *INCOMPLETE* ]]
}

@test "export: a file with a mode other than 0600 fails the export" {
    : > "${GREMION_ROOT}/export-badmode"
    run "$LAUNCHER" export alpha-rat "${GREMION_ROOT}/out"
    [ "$status" -eq 1 ]
    [[ "$output" == *"unexpected modes"* ]]
}

@test "export: no active colour is exit 2 and runs nothing" {
    rm -f "${GREMION_ROOT}/runtime/active-colour"
    run "$LAUNCHER" export alpha-rat "${GREMION_ROOT}/out"
    [ "$status" -eq 2 ]
    run steps
    [ -z "$output" ]
}
