#!/usr/bin/env bats
# Tests for infra/host/bin/gremion-isolation-live: the live two-customer isolation probe.
# Unit only: docker, curl and openssl are recording shims; test/host/fixtures/isolation-live/fake-stack.sh
# plays the running stack (two customers on one Keycloak, one Synapse, one Nextcloud), steered by switch
# files. This file proves the PROGRAM (its verdict rules, its exit codes, where it keeps secrets, that it
# cleans up after itself). It proves nothing about a real install: the evidence is the host run.
# Run: bats test/host/isolation-live.bats

load 'test_helper/host'

A='alpha-rat'
B='beta-fox'
PW_SENTINEL='PWSENTINEL0123456789abcdef0123456789abcdef01'
CLIENT_SUFFIX='cafe0001'

setup() {
    REAL_OPENSSL="$(command -v openssl)"
    export REAL_OPENSSL
    setup_host_root
    PROBE="${HOST_SRC}/bin/gremion-isolation-live"
    FAKE_DIR="${GREMION_ROOT}/fake"
    FAKE_STACK="${KERNEL_ROOT}/test/host/fixtures/isolation-live/fake-stack.sh"
    mkdir -p "${FAKE_DIR}/sw" "${GREMION_ROOT}/tenant-secrets"
    export FAKE_DIR FAKE_STACK
    echo blue > "${GREMION_ROOT}/runtime/active-colour"
    cat > "${GREMION_ROOT}/etc/env/state.env" <<'ENV'
STACK=guardstack
PLATFORM_DOMAIN=plat.example.org
EDGE_BIND_IP=203.0.113.10
EDGE_HTTPS_PORT=443
ENV
    printf 'STACK=guardstack\nCOLOUR=blue\nTENANT_SECRETS_DIR=%s/tenant-secrets\n' "$GREMION_ROOT" > "${GREMION_ROOT}/etc/env/app-blue.env"
    local s h
    for s in "$A" "$B"; do
        h="${s%%-*}.example.org"
        # the router file the host writes for a customer: the app router and the realm router
        # shellcheck disable=SC2016  # the backticks are Traefik rule syntax
        printf 'http:\n  routers:\n    tenant-%s:\n      rule: "Host(`%s`)"\n    tenant-%s.kc:\n      rule: "Host(`%s`) && (Path(`/auth/realms/%s`) || PathPrefix(`/auth/realms/%s/`))"\n    tenant-%s.office:\n      rule: "Host(`%s`) && PathPrefix(`/office`)"\n' \
            "$s" "$h" "$s" "$h" "$s" "$s" "$s" "$h" > "${GREMION_ROOT}/etc/edge/tenant-${s}.yml"
        printf 'SECRET-%s' "$s" > "${GREMION_ROOT}/tenant-secrets/tenant_${s}_client_gremion-admin"
        chmod 600 "${GREMION_ROOT}/tenant-secrets/tenant_${s}_client_gremion-admin"
    done
    shim docker 'exec bash "$FAKE_STACK" docker "$@"'
    shim curl 'exec bash "$FAKE_STACK" curl "$@"'
    # the random source: the password and the client suffix are known to the test, the program never prints them
    shim openssl 'case "$*" in
  "rand -hex 24") echo '"$PW_SENTINEL"' ;;
  "rand -hex 4") echo '"$CLIENT_SUFFIX"' ;;
  *) exec "$REAL_OPENSSL" "$@" ;;
esac'
    export GREMION_ISOLATION_HTTP_TIMEOUT=5
}

teardown() {
    teardown_host_root
}

sw_on() { : > "${FAKE_DIR}/sw/$1"; }

probe() { run bash "$PROBE" "$@"; }

# section_is <name> <verdict> -- the report line of a section, as a positive grep
section_is() { grep -qE "^$1 +$2( |\$)" <<< "$output"; }

all_sections_pass() {
    local s
    for s in chat files office calendar polls call cross-host; do
        section_is "$s" PASS || { echo "section $s is not PASS" >&2; echo "$output" >&2; return 1; }
    done
}

# ---------------------------------------------------------------- arguments

@test "no arguments and a missing second slug are usage errors (exit 2)" {
    probe
    [ "$status" -eq 2 ]
    probe "$A"
    [ "$status" -eq 2 ]
}

@test "the same customer twice is refused (exit 2): the probe needs two customers" {
    probe "$A" "$A"
    [ "$status" -eq 2 ]
    grep -q 'two different customers' <<< "$output"
    refute_recorded docker 'exec'
}

@test "an invalid slug and an unknown flag are usage errors before any call" {
    probe 'Not_A_Slug' "$B"
    [ "$status" -eq 2 ]
    probe "$A" "$B" --frobnicate
    [ "$status" -eq 2 ]
    refute_recorded docker 'exec'
    refute_recorded curl 'https'
}

@test "a user that does not start with isoprobe is refused before any call (never a real person)" {
    probe "$A" "$B" --user alice
    [ "$status" -eq 2 ]
    grep -q 'isoprobe' <<< "$output"
    refute_recorded docker 'exec'
    refute_recorded curl 'https'
}

@test "a user lookup that answers a DIFFERENT name than isoprobe is refused: nothing is reset" {
    FAKE_RET_USER='alice-real'
    export FAKE_RET_USER
    probe "$A" "$B"
    [ "$status" -eq 2 ]
    grep -q 'NOT-READY' <<< "$output"
    refute_recorded docker 'reset-password'
    refute_recorded docker 'clients'
}

# ---------------------------------------------------------------- the happy run

@test "two isolated customers: every section PASSES and the run exits 0" {
    probe "$A" "$B"
    [ "$status" -eq 0 ]
    all_sections_pass
    grep -q 'RESULT: PASS' <<< "$output"
}

@test "the run is symmetric: both directions are probed, both customers' fixtures are read" {
    probe "$A" "$B"
    [ "$status" -eq 0 ]
    # A's token on B's host and B's token on A's host (the cross-host section, both ways)
    grep -q 'alpha-rat -> beta-fox' <<< "$output"
    grep -q 'beta-fox -> alpha-rat' <<< "$output"
    assert_recorded curl 'https://beta.example.org/api/polls/101'
    assert_recorded curl 'https://alpha.example.org/api/polls/202'
    assert_recorded curl 'https://beta.example.org/api/calendar/events/ev-alpha-rat'
    assert_recorded curl 'https://alpha.example.org/api/calendar/events/ev-beta-fox'
}

@test "the temporary client is created per realm with direct grant and both audience mappers, then deleted" {
    probe "$A" "$B"
    [ "$status" -eq 0 ]
    local s
    for s in "$A" "$B"; do
        jq -e --arg id "isoprobe-${CLIENT_SUFFIX}" '.clientId == $id and .directAccessGrantsEnabled == true and .publicClient == true and .standardFlowEnabled == false and .serviceAccountsEnabled == false' "${FAKE_DIR}/cap-client-${s}" >/dev/null
        jq -e '[.protocolMappers[] | select(.protocolMapper == "oidc-audience-mapper") | .config["included.client.audience"]] | (index("gremion-ui") != null) and (index("nextcloud") != null)' "${FAKE_DIR}/cap-client-${s}" >/dev/null
        jq -e '.protocolMappers | map(.name) | index("sub") != null' "${FAKE_DIR}/cap-client-${s}" >/dev/null
        grep -qx "${s} isoprobe-${CLIENT_SUFFIX}" "${FAKE_DIR}/deleted.log"
        [ ! -e "${FAKE_DIR}/clients/${s}/isoprobe-${CLIENT_SUFFIX}" ]
    done
}

@test "the run is clean on exit: the isoprobe user's password was set in both realms, not temporary" {
    probe "$A" "$B"
    [ "$status" -eq 0 ]
    local s
    for s in "$A" "$B"; do
        jq -e --arg pw "$PW_SENTINEL" '.type == "password" and .value == $pw and .temporary == false' "${FAKE_DIR}/cap-reset-${s}" >/dev/null
    done
}

# ---------------------------------------------------------------- secrets

@test "no password, client secret or token is on any argv: they travel on stdin (curl -K -)" {
    probe "$A" "$B"
    [ "$status" -eq 0 ]
    assert_absent "$PW_SENTINEL" "$SHIM_LOG" "the random password is on an argv"
    assert_absent 'SECRET-alpha-rat' "$SHIM_LOG" "a realm admin client secret is on an argv"
    assert_absent 'SECRET-beta-fox' "$SHIM_LOG" "a realm admin client secret is on an argv"
    assert_absent 'TOKMARK' "$SHIM_LOG" "a token is on an argv"
    # not vacuous: the secrets really were handed over, on the stdin config
    assert_present "$PW_SENTINEL" "${FAKE_DIR}/stdin.log" "the password never reached the stdin config"
    assert_present 'SECRET-alpha-rat' "${FAKE_DIR}/stdin.log" "the client secret never reached the stdin config"
}

@test "the password and the tokens are never printed" {
    probe "$A" "$B"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" > "${GREMION_ROOT}/out.txt"
    assert_absent "$PW_SENTINEL" "${GREMION_ROOT}/out.txt" "the password is in the output"
    assert_absent 'TOKMARK' "${GREMION_ROOT}/out.txt" "a token is in the output"
    assert_absent 'SECRET-' "${GREMION_ROOT}/out.txt" "a client secret is in the output"
}

# ---------------------------------------------------------------- the trap

@test "the trap deletes the temporary client of BOTH realms when a later step fails" {
    sw_on "grant-fail-${B}"
    probe "$A" "$B"
    [ "$status" -eq 2 ]
    grep -q 'NOT-READY' <<< "$output"
    grep -qx "${A} isoprobe-${CLIENT_SUFFIX}" "${FAKE_DIR}/deleted.log"
    grep -qx "${B} isoprobe-${CLIENT_SUFFIX}" "${FAKE_DIR}/deleted.log"
    [ ! -e "${FAKE_DIR}/clients/${A}/isoprobe-${CLIENT_SUFFIX}" ]
    [ ! -e "${FAKE_DIR}/clients/${B}/isoprobe-${CLIENT_SUFFIX}" ]
}

@test "the trap deletes the clients when the program is terminated in the middle of a section" {
    sw_on kill-at-polls
    run bash -c 'echo $$ > "$FAKE_DIR/prog.pid"; exec bash "$0" "$@"' "$PROBE" "$A" "$B"
    [ "$status" -ne 0 ]
    [ "$status" -ne 2 ]
    grep -qx "${A} isoprobe-${CLIENT_SUFFIX}" "${FAKE_DIR}/deleted.log"
    grep -qx "${B} isoprobe-${CLIENT_SUFFIX}" "${FAKE_DIR}/deleted.log"
    [ ! -e "${FAKE_DIR}/clients/${A}/isoprobe-${CLIENT_SUFFIX}" ]
    [ ! -e "${FAKE_DIR}/clients/${B}/isoprobe-${CLIENT_SUFFIX}" ]
}

# ---------------------------------------------------------------- NOT-READY (fixture and token preconditions)

@test "a realm admin client secret that is absent is NOT-READY (exit 2), nothing is created" {
    rm -f "${GREMION_ROOT}/tenant-secrets/tenant_${B}_client_gremion-admin"
    probe "$A" "$B"
    [ "$status" -eq 2 ]
    grep -q 'NOT-READY' <<< "$output"
    refute_recorded docker 'clients'
}

@test "a customer without a router file (no host) is NOT-READY (exit 2)" {
    rm -f "${GREMION_ROOT}/etc/edge/tenant-${B}.yml"
    probe "$A" "$B"
    [ "$status" -eq 2 ]
    grep -q 'NOT-READY' <<< "$output"
}

@test "an isoprobe user with a required action is NOT-READY and is left untouched (no password reset)" {
    sw_on required-actions
    probe "$A" "$B"
    [ "$status" -eq 2 ]
    grep -q 'NOT-READY' <<< "$output"
    refute_recorded docker 'reset-password'
}

@test "a missing isoprobe user is NOT-READY (exit 2)" {
    sw_on no-user
    probe "$A" "$B"
    [ "$status" -eq 2 ]
    grep -q 'NOT-READY' <<< "$output"
    refute_recorded docker 'reset-password'
}

@test "a realm admin client that may not reset a password is NOT-READY, and nothing is created" {
    sw_on reset-forbidden
    probe "$A" "$B"
    [ "$status" -eq 2 ]
    grep -q 'NOT-READY' <<< "$output"
    refute_recorded docker 'POST'
}

@test "a token without the nextcloud audience is NOT-READY before any section runs" {
    sw_on aud-missing
    probe "$A" "$B"
    [ "$status" -eq 2 ]
    grep -q 'audience' <<< "$output"
    refute_recorded curl '/api/'
}

@test "a token without the member role is NOT-READY before any section runs" {
    sw_on no-member
    probe "$A" "$B"
    [ "$status" -eq 2 ]
    grep -q 'member' <<< "$output"
    refute_recorded curl '/api/'
}

@test "a calendar event that the operator did not make is NOT-READY (exit 2), not a pass" {
    sw_on no-event
    probe "$A" "$B"
    [ "$status" -eq 2 ]
    section_is calendar NOT-READY
    section_is polls PASS
}

@test "a missing poll fixture is NOT-READY, a missing file fixture makes files and office NOT-READY" {
    sw_on no-poll
    sw_on no-file
    probe "$A" "$B"
    [ "$status" -eq 2 ]
    section_is polls NOT-READY
    section_is files NOT-READY
    section_is office NOT-READY
}

# ---------------------------------------------------------------- 401 everywhere, NOT-ENABLED, FAIL precedence

@test "a run where every API route answers 401 FAILS every section (exit 1): a 401 is not a denial" {
    sw_on all401
    probe "$A" "$B"
    [ "$status" -eq 1 ]
    local s
    for s in chat files office calendar polls call cross-host; do
        section_is "$s" FAIL
    done
    grep -q 'RESULT: FAIL' <<< "$output"
}

@test "a disabled module is NOT-ENABLED (exit 3), never PASS" {
    sw_on moddis-polls
    probe "$A" "$B"
    [ "$status" -eq 3 ]
    section_is polls NOT-ENABLED
    section_is calendar PASS
    grep -q 'RESULT: NOT-ENABLED' <<< "$output"
}

@test "a section whose route takes no Bearer is NOT-ENABLED without being probed" {
    GREMION_ISOLATION_NO_BEARER='calendar'
    export GREMION_ISOLATION_NO_BEARER
    probe "$A" "$B"
    [ "$status" -eq 3 ]
    section_is calendar NOT-ENABLED
    refute_recorded curl '/api/calendar/'
}

@test "a FAIL outranks a NOT-ENABLED: both present exit 1" {
    sw_on moddis-polls
    sw_on calendar-open
    probe "$A" "$B"
    [ "$status" -eq 1 ]
    section_is polls NOT-ENABLED
    section_is calendar FAIL
}

# ---------------------------------------------------------------- calendar and polls

@test "calendar: the other customer's event id answering 200 on this host FAILS" {
    sw_on calendar-open
    probe "$A" "$B"
    [ "$status" -eq 1 ]
    section_is calendar FAIL
    section_is polls PASS
}

@test "calendar: the other customer's event listed on this host FAILS" {
    sw_on calendar-listing-leak
    probe "$A" "$B"
    [ "$status" -eq 1 ]
    section_is calendar FAIL
}

@test "calendar: a denial is not credited when the own event does not answer 200 (positive control)" {
    sw_on calendar-own-500
    probe "$A" "$B"
    [ "$status" -eq 1 ]
    section_is calendar FAIL
}

@test "polls: the other customer's poll answering 200 FAILS" {
    sw_on polls-open
    probe "$A" "$B"
    [ "$status" -eq 1 ]
    section_is polls FAIL
}

@test "polls: a 500 where the denial is 404 FAILS (an error is not a refusal)" {
    sw_on polls-500
    probe "$A" "$B"
    [ "$status" -eq 1 ]
    section_is polls FAIL
}

@test "polls: a 404 on the OWN poll means no positive control, so the section FAILS" {
    sw_on polls-own-404
    probe "$A" "$B"
    [ "$status" -eq 1 ]
    section_is polls FAIL
}

# ---------------------------------------------------------------- files

@test "files: two different folder ids PASS, each found through its own group, not by the mount name" {
    probe "$A" "$B"
    [ "$status" -eq 0 ]
    section_is files PASS
    grep -q 'folder 11' <<< "$output"
    grep -q 'folder 12' <<< "$output"
    assert_recorded docker 'groupfolders:list'
    assert_recorded docker 'user:info sub-alpha-rat'
    assert_recorded docker 'user:info sub-beta-fox'
}

@test "files: both customers resolving to ONE folder id FAILS (the folder is shared)" {
    sw_on shared-folder
    probe "$A" "$B"
    [ "$status" -eq 1 ]
    section_is files FAIL
    grep -q 'one folder' <<< "$output"
}

@test "files: the other customer's user root answering on this bearer FAILS" {
    sw_on dav-open
    probe "$A" "$B"
    [ "$status" -eq 1 ]
    section_is files FAIL
}

@test "files: the other customer's file reachable through the app API FAILS" {
    sw_on files-open
    probe "$A" "$B"
    [ "$status" -eq 1 ]
    section_is files FAIL
}

@test "files: an isoprobe user that is in no folder group is NOT-READY, not a pass" {
    sw_on user-in-no-group
    probe "$A" "$B"
    [ "$status" -eq 2 ]
    section_is files NOT-READY
}

# ---------------------------------------------------------------- office

@test "office: own editor URL on this host and the other customer's file refused PASS, save and close stay unproven" {
    probe "$A" "$B"
    [ "$status" -eq 0 ]
    section_is office PASS
    grep -q 'save and close' <<< "$output"
}

@test "office: an own editor URL on ANOTHER host FAILS" {
    sw_on editor-origin-wrong
    probe "$A" "$B"
    [ "$status" -eq 1 ]
    section_is office FAIL
}

@test "office: an editor URL issued for the other customer's file FAILS" {
    sw_on editor-open
    probe "$A" "$B"
    [ "$status" -eq 1 ]
    section_is office FAIL
}

@test "office: a 502 for the other customer's file is not a refusal and FAILS" {
    sw_on editor-502
    probe "$A" "$B"
    [ "$status" -eq 1 ]
    section_is office FAIL
}

# ---------------------------------------------------------------- chat and call

@test "chat: the same unit name gives different room ids and different Matrix user ids" {
    probe "$A" "$B"
    [ "$status" -eq 0 ]
    section_is chat PASS
    assert_recorded curl '/_matrix/client/v3/rooms/%21room-beta-fox'
    assert_recorded curl '/send/'
}

@test "chat: one Matrix user id for both customers FAILS" {
    sw_on same-mxid
    probe "$A" "$B"
    [ "$status" -eq 1 ]
    section_is chat FAIL
}

@test "chat: one room id for both customers FAILS" {
    sw_on same-room
    probe "$A" "$B"
    [ "$status" -eq 1 ]
    section_is chat FAIL
}

@test "chat: a Matrix token that can read the other customer's room FAILS, and nothing is sent into it" {
    sw_on matrix-open
    probe "$A" "$B"
    [ "$status" -eq 1 ]
    section_is chat FAIL
    [ ! -e "${FAKE_DIR}/sent-${A}" ]
    [ ! -e "${FAKE_DIR}/sent-${B}" ]
}

@test "call: a LiveKit JWT for the other customer's room refused (403) and the own room under t.<slug>. PASS" {
    probe "$A" "$B"
    [ "$status" -eq 0 ]
    section_is call PASS
}

@test "call: a LiveKit JWT minted for the other customer's room FAILS" {
    sw_on livekit-open
    probe "$A" "$B"
    [ "$status" -eq 1 ]
    section_is call FAIL
}

@test "call: an own room outside the t.<slug>. namespace FAILS" {
    sw_on livekit-badprefix
    probe "$A" "$B"
    [ "$status" -eq 1 ]
    section_is call FAIL
}

# ---------------------------------------------------------------- cross-host

@test "cross-host: a token of one customer accepted on the other's host FAILS" {
    sw_on crosshost-open
    probe "$A" "$B"
    [ "$status" -eq 1 ]
    section_is cross-host FAIL
}

# ---------------------------------------------------------------- the header

@test "the header records the first-step reads and what the files section decides" {
    assert_present 'verifyBearerJwt' "$PROBE" "the Bearer verification is not recorded"
    assert_present 'bearerTenantMatches' "$PROBE" "the issuer match is not recorded"
    assert_present 'azp' "$PROBE" "the unchecked azp is not recorded"
    assert_present 'one folder id' "$PROBE" "the files decision rule is not recorded"
    assert_present 'save and close' "$PROBE" "the unproven part of office is not recorded"
}
