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
    mkdir -p "${REL}/infra/host/bin" "${REL}/infra/host/lib" "${REL}/docker/keycloak"
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
exit 0
STUB
    chmod +x "${REL}/infra/host/bin/gremion-vendor-mail"
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
  *" run "*" tenant-create "*)
    all="$*"
    rest="${all##* tenant-create }"
    set -- $rest
    verb="$1"; slug="${2:-}"
    printf "tc %s %s\n" "$verb" "$slug" >> "$ORDER"
    [ -f "$GREMION_ROOT/fail-$verb" ] && exit 1
    case "$verb" in
      render-router)
        printf "# tenant-%s.yml\nhttp:\n  routers:\n    tenant-%s:\n      rule: \"Host(\`x\`)\"\n    tenant-%s.kc:\n      rule: \"x\"\n" "$slug" "$slug" "$slug" ;;
      init)
        # the container writes the ops client secret beside the tenant secrets (first run only)
        mkdir -p "$GREMION_ROOT/tenant-secrets"
        [ -s "$GREMION_ROOT/etc/secrets/control-panel/client_secret" ] || [ -f "$GREMION_ROOT/no-ops-secret" ] \
          || echo unit-ops-client-secret > "$GREMION_ROOT/tenant-secrets/platform_client_control-panel" ;;
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
    for v in unit-pg-root-secret unit-board-secret unit-calendar-secret unit-vault-secret; do
        ! grep -qF -- "$v" "$SHIM_LOG" || { echo "secret ${v} on a docker argv"; cat "$SHIM_LOG"; return 1; }
        [[ "$output" != *"$v"* ]] || { echo "secret ${v} printed"; return 1; }
    done
}

create() {
    run "$LAUNCHER" create alpha-rat --host rat.alpha.example --config "${GREMION_ROOT}/tenant-config.json" \
        --it-admin it@alpha.example --council-admin rat@alpha.example --enable calendar,vault --operator "$OP"
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
    [ "${#lines[@]}" -eq 5 ]
    grep -qF '    tenant-alpha-rat.kc:' "${GREMION_ROOT}/etc/edge/tenant-alpha-rat.yml"
    assert_recorded docker '--operator 8d6b9c7e-1f2a-4b3c-9d4e-5f6a7b8c9d0e'
    assert_recorded docker '--enable calendar,vault'
    assert_recorded docker ':/run/gremion/tenant-config.json:ro'
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
    run "$LAUNCHER" suspend alpha-rat --operator "$OP"
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    run steps
    [ "${lines[0]}" = "tc suspend alpha-rat" ]
    [ "${lines[1]}" = "vendor-mail realm-smtp --realm alpha-rat --tenant alpha_rat --revoke" ]
}

@test "resume: a fresh principal first (never --rotate), then the container" {
    run "$LAUNCHER" resume alpha-rat --operator "$OP"
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    run steps
    [ "${lines[0]}" = "vendor-mail realm-smtp --realm alpha-rat --tenant alpha_rat" ]
    [ "${lines[1]}" = "tc resume alpha-rat" ]
}

@test "a failed revoke fails suspend" {
    touch "${GREMION_ROOT}/vendor-mail-fails"
    run "$LAUNCHER" suspend alpha-rat --operator "$OP"
    [ "$status" -eq 1 ]
}

@test "reconcile --apply rotates on the host when smtp-server is repair: host, then re-verifies" {
    touch "${GREMION_ROOT}/smtp-drift"
    run "$LAUNCHER" reconcile alpha-rat --apply
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
    run "$LAUNCHER" reconcile alpha-rat --apply
    [ "$status" -eq 1 ] || { echo "status=$status $output"; return 1; }
    [[ "$output" == *"no parseable report"* ]] || { echo "$output"; return 1; }
    run steps
    [[ "$output" != *"vendor-mail"* ]]
}

@test "usage: no operator, a bad slug, platform, and no active colour are exit 2" {
    run "$LAUNCHER" suspend alpha-rat
    [ "$status" -eq 2 ]
    run "$LAUNCHER" suspend 1ab --operator "$OP"
    [ "$status" -eq 2 ]
    run "$LAUNCHER" suspend platform --operator "$OP"
    [ "$status" -eq 2 ]
    rm -f "${GREMION_ROOT}/runtime/active-colour"
    run "$LAUNCHER" suspend alpha-rat --operator "$OP"
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
    if [ "$(stat -c %a "${d}/kernel_pg_admin" 2>/dev/null)" != "" ]; then
        [ "$(stat -c %a "${d}/kernel_pg_admin")" = 600 ]
    fi
    run steps
    [ "${lines[0]}" = "tc init --panel-origin" ]
    refute_state_secrets
    # the ops client secret moved into the panel's directory, 0600, and left the tenant secrets
    [ "$(cat "${GREMION_ROOT}/etc/secrets/control-panel/client_secret")" = unit-ops-client-secret ]
    [ ! -e "${GREMION_ROOT}/tenant-secrets/platform_client_control-panel" ]
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
    # Six DISTINCT generated passwords: one server's credential never opens another.
    [ "$(grep -E '^[A-Z]+_PG_PASSWORD=' "${GREMION_ROOT}/etc/env/state.env" | cut -d= -f2 | sort -u | wc -l)" -eq 6 ]
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
    if [ "$(stat -c %a "$f" 2>/dev/null)" != "" ]; then [ "$(stat -c %a "$f")" = 600 ]; fi
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
    ! grep -q 'create realms' "$SHIM_LOG"
    # Another origin is a DIFFERENT realm: refused, never overwritten.
    KEYCLOAK_ADMIN=admin KEYCLOAK_ADMIN_PASSWORD=unit-kc-admin-secret \
        run "$LAUNCHER" init --realm-only --keycloak-container kc-fixture --panel-origin https://other.fixture.example
    [ "$status" -eq 1 ]
    [[ "$output" == *"differs"* ]]
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
    ! grep -q 'create realms' "$SHIM_LOG"
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
