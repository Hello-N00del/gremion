#!/usr/bin/env bats
# Tests for infra/host/bin/gremion-services (the pilot's wiring verb: `wire <slug>`).
# Unit only: docker and curl are recording shims that play the running stack, the release is a
# fixture, and a fake secrets directory stands in for the one tenant-create fills.
# Run: bats test/host/services.bats
#
# What is asserted is what the program TRIED to do (the order of the compose calls, the argv of every
# external command) and what it left on disk, plus the post-conditions it reads back from the stack:
# never an exit code alone.

load 'test_helper/host'

SLUG='alpha-rat'
TOKEN='syt_TESTBOTTOKENvalueABCDEF'
SYN_SECRET='synapse-client-secret-value-1234'
NC_SECRET='nextcloud-client-secret-value-5678'

setup() {
    setup_host_root
    REL="${GREMION_ROOT}/current"
    mkdir -p "${REL}/infra/host/bin" "${REL}/infra/host/lib" "${GREMION_ROOT}/tenant-secrets"
    cp "${HOST_SRC}/lib/customer-ops.sh" "${HOST_SRC}/lib/common.sh" "${REL}/infra/host/lib/"
    cp "${HOST_SRC}/bin/gremion-services" "${REL}/infra/host/bin/" 2>/dev/null || true
    cp "${HOST_SRC}/module-profiles.json" "${REL}/infra/host/"
    SVC="${REL}/infra/host/bin/gremion-services"
    ORDER="${GREMION_ROOT}/order.log"
    : > "$ORDER"
    export ORDER
    echo blue > "${GREMION_ROOT}/runtime/active-colour"
    cat > "${GREMION_ROOT}/etc/env/state.env" <<'ENV'
STACK=guardstack
PLATFORM_DOMAIN=guard.example.org
PILOT_TENANT_HOST=pilot.guard.example.org
EDGE_BIND_IP=203.0.113.10
EDGE_HTTPS_PORT=443
COMPOSE_PROJECT_NAME=guardstack-state
COMPOSE_FILE=docker-compose.yml:docker-compose.prod.yml
COMPOSE_PROFILES=production,calendar,collabora,content,newsletter,nextcloud,video
SYNAPSE_KEYCLOAK_ISSUER_URL=
SYNAPSE_KEYCLOAK_FETCH_URL=
SYNAPSE_REGISTRATION_SHARED_SECRET=reg-secret-fixture
SYNAPSE_ADMIN_TOKEN=placeholder-not-the-token
ENV
    local c
    for c in blue green; do
        printf 'STACK=guardstack\nCOLOUR=%s\nTENANT_SECRETS_DIR=%s/tenant-secrets\nSYNAPSE_ADMIN_TOKEN=placeholder-not-the-token\nPILOT_TENANT_HOST=pilot.guard.example.org\n' "$c" "$GREMION_ROOT" > "${GREMION_ROOT}/etc/env/app-${c}.env"
    done
    # the name scheme of customer-adapters.ts (tenant_<slug>_client_<client>) keeps the slug's dashes
    printf '%s' "$SYN_SECRET" > "${GREMION_ROOT}/tenant-secrets/tenant_${SLUG}_client_synapse"
    printf '%s' "$NC_SECRET" > "${GREMION_ROOT}/tenant-secrets/tenant_${SLUG}_client_nextcloud"
    chmod 600 "${GREMION_ROOT}"/tenant-secrets/*
    export GREMION_SERVICES_WAIT_S=3
    shim_stack
}

teardown() {
    teardown_host_root
}

# shim_stack — docker and curl play the running stack. Switches (files under $GREMION_ROOT) steer the
# answers a test needs to change; every call is ALSO in $SHIM_LOG (the argv the program really used).
shim_stack() {
    shim docker '
case " $* " in
  *" ps "*"service=matrix"*)        echo c-matrix; exit 0 ;;
  *" ps "*"service=nextcloud"*)     echo c-nextcloud; exit 0 ;;
  *" ps "*"service=gremion-ui"*)    echo c-ui; exit 0 ;;
  *" inspect "*)                    echo healthy; exit 0 ;;
  *" compose "*)
    # the bootstrap-mode value the shell handed this compose call, in call order
    printf "compose bootstrap=%s :: %s\n" "${SYNAPSE_BOOTSTRAP_MODE-unset}" "$*" >> "$ORDER"
    exit 0 ;;
  *" exec "*"/bootstrap.sh"*)
    printf "bootstrap\n" >> "$ORDER"
    if [ -f "$GREMION_ROOT/bootstrap-fails" ]; then echo "bootstrap.sh: homeserver database unreachable" >&2; exit 1; fi
    printf "==> Bootstrap complete.\n    Add the following to your .env file:\n\n    SYNAPSE_ADMIN_TOKEN=%s\n    SYNAPSE_ADMIN_BOT_USER_ID=@gremion-admin-bot:guard.example.org\n" "'"$TOKEN"'"
    exit 0 ;;
  *" exec "*"whoami"*)
    printf "whoami\n" >> "$ORDER"
    # recorded when the switch file says so, and only for the token the env file holds
    [ -f "$GREMION_ROOT/token-recorded" ] || exit 22
    echo "{\"user_id\":\"@gremion-admin-bot:guard.example.org\"}"; exit 0 ;;
  *" exec "*"printenv SYNAPSE_KEYCLOAK_ISSUER_URL"*) echo "https://pilot.guard.example.org/auth/realms/'"$SLUG"'"; exit 0 ;;
  *" exec "*"printenv BOOTSTRAP_MODE"*)              echo 0; exit 0 ;;
  *" exec "*"printenv SYNAPSE_OIDC_CLIENT_SECRET_FILE"*) echo /run/secrets/synapse/oidc_client_secret; exit 0 ;;
  *" exec "*"printenv SYNAPSE_ADMIN_TOKEN"*)
    if [ -f "$GREMION_ROOT/ui-stale-token" ]; then echo placeholder-not-the-token; else printf "%s\n" "'"$TOKEN"'"; fi; exit 0 ;;
  *" exec "*"app:list"*)
    printf "occ app:list\n" >> "$ORDER"
    if [ -f "$GREMION_ROOT/polls-missing" ]; then
      echo "{\"enabled\":{\"user_oidc\":\"8.0\",\"richdocuments\":\"9.0\",\"groupfolders\":\"20.0\"},\"disabled\":{\"polls\":\"8.0\"}}"
    else
      echo "{\"enabled\":{\"user_oidc\":\"8.0\",\"richdocuments\":\"9.0\",\"groupfolders\":\"20.0\",\"polls\":\"8.0\"},\"disabled\":{}}"
    fi
    exit 0 ;;
  *" exec "*"user_oidc:provider Keycloak"*"--clientid"*) printf "occ provider-set\n" >> "$ORDER"; exit 0 ;;
  *" exec "*"user_oidc:provider Keycloak"*)
    # The real command prints the provider with its settings nested under .settings.
    if [ -f "$GREMION_ROOT/bearer-off" ]; then echo "{\"id\":1,\"identifier\":\"Keycloak\",\"clientId\":\"nextcloud\",\"settings\":{\"checkBearer\":false}}"; else echo "{\"id\":1,\"identifier\":\"Keycloak\",\"clientId\":\"nextcloud\",\"settings\":{\"checkBearer\":true}}"; fi
    exit 0 ;;
  *" exec "*"config:app:get richdocuments public_wopi_url"*)
    if [ -f "$GREMION_ROOT/wopi-missing" ]; then exit 1; fi
    echo "https://pilot.guard.example.org/office"; exit 0 ;;
  *" exec "*"config:app:get richdocuments wopi_url"*) echo "http://collabora:9980/office"; exit 0 ;;
  *" exec "*"richdocuments:activate-config"*) printf "occ activate-config\n" >> "$ORDER"; exit 0 ;;
  *" exec "*"curl "*) exit 0 ;;
  *" exec "*) exit 0 ;;
esac
exit 0'
    shim curl '
url=""; for a in "$@"; do case "$a" in https://*) url="$a" ;; esac; done
case "$url" in
  */.well-known/openid-configuration)
    if [ -f "$GREMION_ROOT/issuer-wrong" ]; then echo "{\"issuer\":\"https://elsewhere.example.org/auth/realms/x\"}"; else echo "{\"issuer\":\"https://pilot.guard.example.org/auth/realms/'"$SLUG"'\"}"; fi
    exit 0 ;;
  */_matrix/client/versions) echo "{\"versions\":[\"v1.5\"]}"; exit 0 ;;
  */_matrix/client/v3/login)
    if [ -f "$GREMION_ROOT/no-jwt" ]; then echo "{\"flows\":[{\"type\":\"m.login.sso\"}]}"; else echo "{\"flows\":[{\"type\":\"m.login.sso\"},{\"type\":\"org.matrix.login.jwt\"}]}"; fi
    exit 0 ;;
esac
exit 0'
}

wire() { run "$SVC" wire "${1:-$SLUG}"; }

# ---------------------------------------------------------------------------

@test "gremion-services exists, is executable, has strict mode and the three-line preamble" {
    [ -x "${HOST_SRC}/bin/gremion-services" ]
    grep -q 'set -euo pipefail' "${HOST_SRC}/bin/gremion-services"
    grep -q '\. "\$SCRIPT_DIR/\.\./lib/common\.sh"' "${HOST_SRC}/bin/gremion-services"
    grep -q '^# shellcheck source=\.\./lib/common\.sh$' "${HOST_SRC}/bin/gremion-services"
}

@test "no slug, an invalid slug and an unknown verb are usage errors (exit 2) and touch nothing" {
    run "$SVC"
    [ "$status" -eq 2 ]
    run "$SVC" wire
    [ "$status" -eq 2 ]
    run "$SVC" wire 'Not A Slug'
    [ "$status" -eq 2 ]
    run "$SVC" frobnicate "$SLUG"
    [ "$status" -eq 2 ]
    [ ! -s "$ORDER" ]
}

@test "PILOT_TENANT_HOST still the operator placeholder, a missing tenant secret and a mismatching issuer each refuse before anything is written" {
    sed -i 's/^PILOT_TENANT_HOST=.*/PILOT_TENANT_HOST=CHANGE_ME_OPERATOR_pilot_tenant_host/' "${GREMION_ROOT}/etc/env/state.env"
    wire
    [ "$status" -eq 2 ]
    [[ "$output" == *"PILOT_TENANT_HOST"* ]]
    sed -i 's/^PILOT_TENANT_HOST=.*/PILOT_TENANT_HOST=pilot.guard.example.org/' "${GREMION_ROOT}/etc/env/state.env"
    rm -f "${GREMION_ROOT}/tenant-secrets/tenant_${SLUG}_client_synapse"
    wire
    [ "$status" -eq 2 ]
    [[ "$output" == *"tenant_${SLUG}_client_synapse"* ]]
    printf '%s' "$SYN_SECRET" > "${GREMION_ROOT}/tenant-secrets/tenant_${SLUG}_client_synapse"
    : > "${GREMION_ROOT}/issuer-wrong"
    wire
    [ "$status" -eq 1 ]
    [[ "$output" == *"issuer"* ]]
    # nothing was written or started
    [ -z "$(sed -n 's/^SYNAPSE_KEYCLOAK_ISSUER_URL=//p' "${GREMION_ROOT}/etc/env/state.env")" ]
    [ ! -e "${GREMION_ROOT}/etc/secrets/synapse" ]
    ! grep -q compose "$ORDER"
}

@test "wire: the order is realm check, matrix in bootstrap mode, the bot bootstrap, matrix again WITHOUT bootstrap mode, the provider, gremion-ui recreated" {
    wire
    [ "$status" -eq 0 ] || { echo "status=$status $output"; return 1; }
    local seq
    seq="$(sed -e 's/ :: .*//' "$ORDER" | tr '\n' ' ')"
    # matrix up in bootstrap mode, the recorded token asked about (and found wanting), the bot registered,
    # matrix recreated with the mode unset
    [[ "$seq" == "compose bootstrap=1 whoami bootstrap compose bootstrap=unset "* ]] || { echo "order: ${seq}"; return 1; }
    grep -q 'compose bootstrap=1 :: .*up -d matrix' "$ORDER"
    grep -q 'compose bootstrap=unset :: .*up -d --force-recreate matrix' "$ORDER"
    # gremion-ui last, in the ACTIVE colour's project, force-recreated
    tail -n 1 "$ORDER" | grep -q 'app-blue.env up -d --force-recreate gremion-ui'
    # the provider is registered before gremion-ui is recreated
    local p u
    p="$(grep -n 'occ provider-set' "$ORDER" | head -1 | cut -d: -f1)"
    u="$(grep -n 'force-recreate gremion-ui' "$ORDER" | head -1 | cut -d: -f1)"
    [ "$p" -lt "$u" ]
    [[ "$output" == *"WIRE: ok ${SLUG}"* ]]
}

@test "wire: the realm's issuer and fetch URL, the messaging profile (once) and the synapse client secret (0600) are on disk" {
    wire
    [ "$status" -eq 0 ] || { echo "status=$status $output"; return 1; }
    local st="${GREMION_ROOT}/etc/env/state.env"
    [ "$(sed -n 's/^SYNAPSE_KEYCLOAK_ISSUER_URL=//p' "$st")" = "https://pilot.guard.example.org/auth/realms/${SLUG}" ]
    [ "$(sed -n 's/^SYNAPSE_KEYCLOAK_FETCH_URL=//p' "$st")" = "https://pilot.guard.example.org/auth/realms/${SLUG}" ]
    [ "$(sed -n 's/^COMPOSE_PROFILES=//p' "$st")" = "production,calendar,collabora,content,newsletter,nextcloud,video,messaging" ]
    local f="${GREMION_ROOT}/etc/secrets/synapse/oidc_client_secret"
    [ -s "$f" ]
    [ "$(cat "$f")" = "$SYN_SECRET" ]
    if fs_carries_modes "${GREMION_ROOT}/etc/secrets"; then
        [ "$(stat -c %a "$f")" = 600 ]
        [ "$(stat -c %a "${GREMION_ROOT}/etc/secrets/synapse")" = 700 ]
    fi
}

@test "wire: the bot's real token replaces the placeholder in state.env and BOTH colours, and is on no argv and no output line" {
    wire
    [ "$status" -eq 0 ] || { echo "status=$status $output"; return 1; }
    local f
    for f in state.env app-blue.env app-green.env; do
        [ "$(sed -n 's/^SYNAPSE_ADMIN_TOKEN=//p' "${GREMION_ROOT}/etc/env/${f}")" = "$TOKEN" ] || { echo "${f}: token not recorded"; return 1; }
    done
    ! grep -qF -- "$TOKEN" "$SHIM_LOG" || { echo "the token reached an argv"; return 1; }
    ! grep -qF -- "$TOKEN" <<< "$output" || { echo "the token reached the output"; return 1; }
    ! grep -qF -- "$SYN_SECRET" "$SHIM_LOG" || { echo "the synapse client secret reached an argv"; return 1; }
    ! grep -qF -- "$NC_SECRET" "$SHIM_LOG" || { echo "the nextcloud client secret reached an argv"; return 1; }
    ! grep -qF -- "$NC_SECRET" <<< "$output"
}

@test "wire: the Nextcloud provider is registered with the secret by NAME (docker exec -e), check-bearer and the public discovery URI" {
    wire
    [ "$status" -eq 0 ] || { echo "status=$status $output"; return 1; }
    local call
    call="$(grep '^docker .*user_oidc:provider Keycloak' "$SHIM_LOG" | grep -- '--clientid' | head -1)"
    [[ "$call" == *"exec -u www-data -e NEXTCLOUD_OIDC_CLIENT_SECRET c-nextcloud"* ]] || { echo "$call"; return 1; }
    [[ "$call" == *'--clientsecret="$NEXTCLOUD_OIDC_CLIENT_SECRET"'* ]] || { echo "$call"; return 1; }
    [[ "$call" == *"--discoveryuri=https://pilot.guard.example.org/auth/realms/${SLUG}/.well-known/openid-configuration"* ]]
    [[ "$call" == *"--check-bearer=1"* && "$call" == *"--bearer-provisioning=1"* && "$call" == *"--unique-uid=0"* ]]
    # activate-config runs, and the callback URL that it resets is put back
    grep -q 'occ activate-config' "$ORDER"
    grep -q 'config:app:set richdocuments wopi_callback_url' "$SHIM_LOG"
}

@test "wire is idempotent: a token already recorded and verified skips the bot bootstrap, the profile is not appended twice, the ui is recreated again" {
    wire
    [ "$status" -eq 0 ] || { echo "status=$status $output"; return 1; }
    : > "${GREMION_ROOT}/token-recorded"
    : > "$ORDER"
    wire
    [ "$status" -eq 0 ] || { echo "status=$status $output"; return 1; }
    ! grep -q '^bootstrap$' "$ORDER" || { echo "the bot was bootstrapped again"; return 1; }
    grep -q '^whoami$' "$ORDER"
    # the bearer header reaches curl over its stdin config, never as an argument inside the container
    local who
    who="$(grep '^docker .*whoami' "$SHIM_LOG" | tail -n 1)"
    [[ "$who" == *"-K -"* ]] || { echo "$who"; return 1; }
    [[ "$who" != *"-H "* ]] || { echo "$who"; return 1; }
    [ "$(sed -n 's/^COMPOSE_PROFILES=//p' "${GREMION_ROOT}/etc/env/state.env")" = "production,calendar,collabora,content,newsletter,nextcloud,video,messaging" ]
    [ "$(grep -c '^COMPOSE_PROFILES=' "${GREMION_ROOT}/etc/env/state.env")" = 1 ]
    grep -q 'force-recreate gremion-ui' "$ORDER"
}

@test "a failed bot bootstrap stops the wire (exit 1): no token is recorded and gremion-ui is not recreated" {
    : > "${GREMION_ROOT}/bootstrap-fails"
    wire
    [ "$status" -eq 1 ]
    [[ "$output" == *"bootstrap"* ]]
    [ "$(sed -n 's/^SYNAPSE_ADMIN_TOKEN=//p' "${GREMION_ROOT}/etc/env/state.env")" = "placeholder-not-the-token" ]
    ! grep -q 'force-recreate gremion-ui' "$ORDER"
}

@test "a failed bot bootstrap shows the bootstrap's own error and closes the shared-secret registration again (matrix recreated without bootstrap mode on the way out)" {
    : > "${GREMION_ROOT}/bootstrap-fails"
    wire
    [ "$status" -eq 1 ]
    [[ "$output" == *"homeserver database unreachable"* ]] || { echo "the cause was discarded: ${output}"; return 1; }
    # the last compose call is the recreate without the mode, after the failed bootstrap
    local last
    last="$(grep '^compose bootstrap=' "$ORDER" | tail -n 1)"
    [[ "$last" == "compose bootstrap=unset :: "*"up -d --force-recreate matrix" ]] || { echo "last compose call: ${last}"; return 1; }
    ! grep -q 'force-recreate gremion-ui' "$ORDER"
}

@test "a successful wire does not recreate matrix a third time (the exit guard is disarmed once the mode is off)" {
    wire
    [ "$status" -eq 0 ] || { echo "status=$status $output"; return 1; }
    [ "$(grep -c 'force-recreate matrix' "$ORDER")" = 1 ]
}

@test "an EDGE_HTTPS_PORT other than 443 is honoured by every edge request (--resolve and the URL carry the port)" {
    sed -i 's/^EDGE_HTTPS_PORT=.*/EDGE_HTTPS_PORT=8443/' "${GREMION_ROOT}/etc/env/state.env"
    wire
    [ "$status" -eq 0 ] || { echo "status=$status $output"; return 1; }
    local calls
    calls="$(grep '^curl ' "$SHIM_LOG" | grep -- '--resolve')"
    [ -n "$calls" ]
    ! grep -vE -- '--resolve pilot\.guard\.example\.org:8443:|--resolve guard\.example\.org:8443:' <<< "$calls" || { echo "a request without the pinned port"; return 1; }
    ! grep -E 'https://(pilot\.)?guard\.example\.org/' <<< "$calls" || { echo "a URL without the port: ${calls}"; return 1; }
}

# The post-conditions are read back from the running stack; each failure is its own named exit 1.
@test "a login flow list without the JWT arm fails the wire naming it (a failed key fetch boots Synapse without it)" {
    : > "${GREMION_ROOT}/no-jwt"
    wire
    [ "$status" -eq 1 ]
    [[ "$output" == *"org.matrix.login.jwt"* ]]
}

@test "a Nextcloud without Polls enabled (the hooks end in a warning) fails the wire naming the app" {
    : > "${GREMION_ROOT}/polls-missing"
    wire
    [ "$status" -eq 1 ]
    [[ "$output" == *"polls"* ]]
}

@test "a Nextcloud whose richdocuments public_wopi_url is unset fails the wire naming the key (the install hook's occ calls are not guaranteed)" {
    : > "${GREMION_ROOT}/wopi-missing"
    wire
    [ "$status" -eq 1 ]
    [[ "$output" == *"public_wopi_url"* ]]
    ! grep -q 'force-recreate gremion-ui' "$ORDER"
}

@test "a provider read back without bearer validation fails the wire" {
    : > "${GREMION_ROOT}/bearer-off"
    wire
    [ "$status" -eq 1 ]
    [[ "$output" == *"checkBearer"* || "$output" == *"bearer"* ]]
}

@test "a gremion-ui that still holds the placeholder token after the recreate fails the wire (the env is read from the running container)" {
    : > "${GREMION_ROOT}/ui-stale-token"
    wire
    [ "$status" -eq 1 ]
    [[ "$output" == *"SYNAPSE_ADMIN_TOKEN"* ]]
}

@test "the program never passes -e NAME=value, --env-file contents or a secret value on a docker argv" {
    wire
    [ "$status" -eq 0 ] || { echo "status=$status $output"; return 1; }
    ! grep -E '^docker .* -e [A-Z_]+=' "$SHIM_LOG" || { echo "a value-carrying -e"; return 1; }
    # every -e names a variable and nothing else (the value travels in the client's environment)
    local names
    names="$(grep -oE '^docker exec .*' "$SHIM_LOG" | grep -oE ' -e [A-Z_]+' | sort -u | tr -d '\n')"
    [ "$names" = " -e NEXTCLOUD_OIDC_CLIENT_SECRET -e SYNAPSE_ADMIN_TOKEN" ] || { echo "-e names: ${names}"; return 1; }
    # no env file content is dumped: nothing runs `env`, `printenv` without a name, or cats an env file through docker
    ! grep -E '^docker exec [^ ]+ (env|printenv)$' "$SHIM_LOG" || { echo "an unnamed environment dump"; return 1; }
}
