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
    REAL_JQ="$(command -v jq)"
    export REAL_OPENSSL REAL_JQ
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
    # jq is recorded too (it is a program the secrets could reach on an argv); the real one does the work
    shim jq 'exec "$REAL_JQ" "$@"'
    export GREMION_ISOLATION_HTTP_TIMEOUT=5
}

teardown() {
    teardown_host_root
}

sw_on() { : > "${FAKE_DIR}/sw/$1"; }

probe() { run bash "$PROBE" "$@"; }

# section_is <name> <verdict> -- the report line of a section, as a positive grep
section_is() {
    grep -qE "^$1 +$2( |\$)" <<< "$output" && return 0
    echo "section $1 is not $2; the program said:" >&2
    echo "$output" >&2
    return 1
}

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
    [ "$status" -eq 3 ]
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
        "$REAL_JQ" -e --arg id "isoprobe-${CLIENT_SUFFIX}" '.clientId == $id and .directAccessGrantsEnabled == true and .publicClient == true and .standardFlowEnabled == false and .serviceAccountsEnabled == false' "${FAKE_DIR}/cap-client-${s}" >/dev/null
        "$REAL_JQ" -e '[.protocolMappers[] | select(.protocolMapper == "oidc-audience-mapper") | .config["included.client.audience"]] | (index("gremion-ui") != null) and (index("nextcloud") != null)' "${FAKE_DIR}/cap-client-${s}" >/dev/null
        "$REAL_JQ" -e '.protocolMappers | map(.name) | index("sub") != null' "${FAKE_DIR}/cap-client-${s}" >/dev/null
        grep -qx "${s} isoprobe-${CLIENT_SUFFIX}" "${FAKE_DIR}/deleted.log"
        [ ! -e "${FAKE_DIR}/clients/${s}/isoprobe-${CLIENT_SUFFIX}" ]
    done
}

@test "the run is clean on exit: the isoprobe user's password was set in both realms, not temporary" {
    probe "$A" "$B"
    [ "$status" -eq 0 ]
    local s
    for s in "$A" "$B"; do
        "$REAL_JQ" -e --arg pw "$PW_SENTINEL" '.type == "password" and .value == $pw and .temporary == false' "${FAKE_DIR}/cap-reset-${s}" >/dev/null
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
    assert_absent 'OID\.' "$SHIM_LOG" "a Matrix OpenID token is on an argv"
    # not vacuous: the secrets really were handed over, on the stdin config
    assert_present "$PW_SENTINEL" "${FAKE_DIR}/stdin.log" "the password never reached the stdin config"
    assert_present 'SECRET-alpha-rat' "${FAKE_DIR}/stdin.log" "the client secret never reached the stdin config"
    assert_present 'OID\.alpha-rat' "${FAKE_DIR}/stdin.log" "the OpenID token never reached the stdin config"
    # not vacuous either: jq is in the argv log (the secrets are built into JSON bodies with it)
    assert_recorded jq 'isoprobe-alpha-rat'
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
    [ "$status" -eq 3 ]
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

@test "a realm admin client secret that is absent is NOT-READY (exit 3), nothing is created" {
    rm -f "${GREMION_ROOT}/tenant-secrets/tenant_${B}_client_gremion-admin"
    probe "$A" "$B"
    [ "$status" -eq 3 ]
    grep -q 'NOT-READY' <<< "$output"
    refute_recorded docker 'clients'
}

@test "a customer without a router file (no host) is NOT-READY (exit 3)" {
    rm -f "${GREMION_ROOT}/etc/edge/tenant-${B}.yml"
    probe "$A" "$B"
    [ "$status" -eq 3 ]
    grep -q 'NOT-READY' <<< "$output"
}

@test "an isoprobe user with a required action is NOT-READY and is left untouched (no password reset)" {
    sw_on required-actions
    probe "$A" "$B"
    [ "$status" -eq 3 ]
    grep -q 'NOT-READY' <<< "$output"
    refute_recorded docker 'reset-password'
}

@test "a missing isoprobe user is NOT-READY (exit 3)" {
    sw_on no-user
    probe "$A" "$B"
    [ "$status" -eq 3 ]
    grep -q 'NOT-READY' <<< "$output"
    refute_recorded docker 'reset-password'
}

@test "a realm admin client that may not reset a password is NOT-READY, and nothing is created" {
    sw_on reset-forbidden
    probe "$A" "$B"
    [ "$status" -eq 3 ]
    grep -q 'NOT-READY' <<< "$output"
    refute_recorded docker '/clients'
}

@test "a realm password policy that rejects the password is NOT-READY and says so, not 'may not reset'" {
    sw_on reset-policy
    probe "$A" "$B"
    [ "$status" -eq 3 ]
    grep -q 'password policy' <<< "$output"
    refute_recorded docker '/clients'
}

@test "a token without the nextcloud audience is NOT-READY before any section runs" {
    sw_on aud-missing
    probe "$A" "$B"
    [ "$status" -eq 3 ]
    grep -q 'audience' <<< "$output"
    refute_recorded curl '/api/'
}

@test "a token without the member role is NOT-READY before any section runs" {
    sw_on no-member
    probe "$A" "$B"
    [ "$status" -eq 3 ]
    grep -q 'member' <<< "$output"
    refute_recorded curl '/api/'
}

@test "a calendar event that the operator did not make is NOT-READY (exit 3), not a pass" {
    sw_on no-event
    probe "$A" "$B"
    [ "$status" -eq 3 ]
    section_is calendar NOT-READY
    section_is polls PASS
}

@test "a missing poll fixture is NOT-READY, a missing file fixture makes files and office NOT-READY" {
    sw_on no-poll
    sw_on no-file
    probe "$A" "$B"
    [ "$status" -eq 3 ]
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

@test "a customer without messaging reads chat and call as NOT-ENABLED (exit 3), asked through the module-gated route first" {
    sw_on moddis-messages
    probe "$A" "$B"
    [ "$status" -eq 3 ]
    section_is chat NOT-ENABLED
    section_is call NOT-ENABLED
    section_is files PASS
    refute_recorded curl '/api/auth/matrix-token'
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

@test "calendar and polls: a slug that is a prefix of the other slug is not mistaken for a leak" {
    printf 'SECRET-alpha' > "${GREMION_ROOT}/tenant-secrets/tenant_alpha_client_gremion-admin"
    # shellcheck disable=SC2016  # the backticks are Traefik rule syntax
    printf 'http:
  routers:
    tenant-alpha:
      rule: "Host(`alpha.example.org`)"
' > "${GREMION_ROOT}/etc/edge/tenant-alpha.yml"
    # shellcheck disable=SC2016
    printf 'http:
  routers:
    tenant-alpha-rat:
      rule: "Host(`alpharat.example.org`)"
' > "${GREMION_ROOT}/etc/edge/tenant-alpha-rat.yml"
    export FAKE_A=alpha FAKE_B=alpha-rat FAKE_HOST_A=alpha.example.org FAKE_HOST_B=alpharat.example.org
    probe alpha alpha-rat
    [ "$status" -eq 0 ]
    section_is calendar PASS
    section_is polls PASS
}

@test "polls: the fixture is found by configuration.title, the title the real NcPoll listing carries" {
    probe "$A" "$B"
    [ "$status" -eq 0 ]
    section_is polls PASS
    assert_recorded curl 'https://alpha.example.org/api/polls/101'
}

@test "polls: the other customer's poll listed on this host FAILS" {
    sw_on polls-listing-leak
    probe "$A" "$B"
    [ "$status" -eq 1 ]
    section_is polls FAIL
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

@test "files: ONE folder id for both customers FAILS on its own, with the app API and WebDAV still refusing" {
    sw_on shared-folder-id
    probe "$A" "$B"
    [ "$status" -eq 1 ]
    section_is files FAIL
    grep -q 'both customers resolve to one folder id (11)' <<< "$output"
    # the folder identity is the ONLY failing check: nothing else in the section answered FAIL
    [ "$(grep -c 'FAIL:' <<< "$output")" -eq 1 ]
    section_is office PASS
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

@test "files: the own folder not answering over WebDAV is no positive control, so the section FAILS" {
    sw_on dav-own-fail
    probe "$A" "$B"
    [ "$status" -eq 1 ]
    section_is files FAIL
    grep -q 'positive control failed' <<< "$output"
}

@test "files: a probe user whose groups carry both customers' folders FAILS, though the folder ids differ" {
    sw_on user-in-both-groups
    probe "$A" "$B"
    [ "$status" -eq 1 ]
    section_is files FAIL
    grep -q "groups carry 2 folders" <<< "$output"
}

@test "files: an isoprobe user that is in no folder group is NOT-READY, not a pass" {
    sw_on user-in-no-group
    probe "$A" "$B"
    [ "$status" -eq 3 ]
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

@test "office: the refusal the edit-token route really gives for a file the own root lacks is 404, and PASSES" {
    probe "$A" "$B"
    [ "$status" -eq 0 ]
    section_is office PASS
    grep -q 'refused (404)' <<< "$output"
}

# ---------------------------------------------------------------- chat and call

@test "chat: the same unit name gives different room ids and different Matrix user ids" {
    probe "$A" "$B"
    [ "$status" -eq 0 ]
    section_is chat PASS
    # jq 1.6 leaves the '!' of a room id as it is in @uri, jq 1.7 and later write %21: match what both write
    assert_recorded curl '/_matrix/client/v3/rooms/'
    assert_recorded curl 'room-beta-fox%3Aplat.example.org/messages'
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

@test "chat: the own room refused too is no positive control, so the section FAILS and nothing is sent" {
    sw_on matrix-own-fail
    probe "$A" "$B"
    [ "$status" -eq 1 ]
    section_is chat FAIL
    grep -q 'positive control failed' <<< "$output"
    [ ! -e "${FAKE_DIR}/sent-${A}" ]
    [ ! -e "${FAKE_DIR}/sent-${B}" ]
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

# ---------------------------------------------------------------- exit codes

@test "exit codes: NOT-READY with no FAIL exits 3, a FAIL beside it exits 1" {
    sw_on no-event
    probe "$A" "$B"
    [ "$status" -eq 3 ]
    section_is calendar NOT-READY
    grep -q 'RESULT: NOT-READY (exit 3)' <<< "$output"
    sw_on polls-open
    probe "$A" "$B"
    [ "$status" -eq 1 ]
    section_is calendar NOT-READY
    section_is polls FAIL
    grep -q 'RESULT: FAIL (exit 1)' <<< "$output"
}

@test "exit codes: NOT-READY and NOT-ENABLED together, with no FAIL, exit 3" {
    sw_on no-event
    sw_on moddis-polls
    probe "$A" "$B"
    [ "$status" -eq 3 ]
    section_is calendar NOT-READY
    section_is polls NOT-ENABLED
}

@test "exit codes: a precondition that dies in a library function exits 3, never 1 (a finding)" {
    sw_on no-nextcloud
    probe "$A" "$B"
    [ "$status" -eq 3 ]
    grep -q 'nextcloud' <<< "$output"
    refute_recorded docker 'reset-password'
    refute_recorded docker '/clients'
}

@test "exit codes: an unreadable host configuration exits 3, and only usage exits 2" {
    rm -f "${GREMION_ROOT}/etc/env/app-blue.env"
    probe "$A" "$B"
    [ "$status" -eq 3 ]
    refute_recorded docker 'exec'
}

@test "exit codes: a run that stops before it has a verdict exits 3 and says so, never 1" {
    shim date 'exit 1'
    probe "$A" "$B"
    [ "$status" -eq 3 ]
    grep -q 'no verdict' <<< "$output"
}

@test "exit codes: any other stop before the verdict (here exit 4) exits 3 with a RESULT line, never that code" {
    shim date 'exit 4'
    probe "$A" "$B"
    [ "$status" -eq 3 ]
    grep -q 'RESULT: ABORTED (exit 3)' <<< "$output"
    grep -q 'no verdict' <<< "$output"
}

@test "exit codes: an own editor answer that is no JSON FAILS the office section (exit 1) and is cleaned up, never exit 4" {
    sw_on editor-html
    probe "$A" "$B"
    [ "$status" -eq 1 ]
    section_is office FAIL
    grep -q 'RESULT: FAIL (exit 1)' <<< "$output"
    grep -qx "${A} isoprobe-${CLIENT_SUFFIX}" "${FAKE_DIR}/deleted.log"
    grep -qx "${B} isoprobe-${CLIENT_SUFFIX}" "${FAKE_DIR}/deleted.log"
}

@test "exit codes: a missing active colour is a host precondition (exit 3), not usage (exit 2)" {
    rm -f "${GREMION_ROOT}/runtime/active-colour"
    probe "$A" "$B"
    [ "$status" -eq 3 ]
    grep -q 'active-colour' <<< "$output"
    grep -q 'RESULT: ABORTED (exit 3)' <<< "$output"
    refute_recorded docker 'exec'
}

@test "exit codes: a duplicate key in the state file is a host precondition (exit 3), not usage (exit 2)" {
    printf 'STACK=guardstack
' >> "${GREMION_ROOT}/etc/env/state.env"
    probe "$A" "$B"
    [ "$status" -eq 3 ]
    grep -q 'duplicate key STACK' <<< "$output"
    refute_recorded docker 'exec'
}

@test "exit codes: a host lock that cannot be opened is a host precondition (exit 3), not usage (exit 2)" {
    rm -f "${GREMION_ROOT}/runtime/hostd.lock"
    mkdir "${GREMION_ROOT}/runtime/hostd.lock"
    probe "$A" "$B"
    [ "$status" -eq 3 ]
    grep -q 'cannot open the host lock' <<< "$output"
    refute_recorded docker 'exec'
}

@test "exit codes: all sections PASS but the temporary client cannot be confirmed deleted exits 3 and says so, never 1" {
    sw_on client-delete-fail
    probe "$A" "$B"
    [ "$status" -eq 3 ]
    all_sections_pass
    grep -q 'WARNING: could not confirm the deletion' <<< "$output"
    grep -q 'RESULT: CLEANUP-FAILED (exit 3)' <<< "$output"
}

@test "exit codes: a FAIL stays exit 1 when the clean-up fails too" {
    sw_on all401
    sw_on client-delete-fail
    probe "$A" "$B"
    [ "$status" -eq 1 ]
    grep -q 'WARNING: could not confirm the deletion' <<< "$output"
}

@test "files: an occ folder list that is no array FAILS the section" {
    sw_on groupfolders-notarray
    probe "$A" "$B"
    [ "$status" -eq 1 ]
    section_is files FAIL
}

@test "files: a folder list whose entries are unreadable is NOT-READY (exit 3), never PASS" {
    sw_on groupfolders-garbled
    probe "$A" "$B"
    [ "$status" -eq 3 ]
    section_is files NOT-READY
}

# ---------------------------------------------------------------- preconditions the program cannot assume

@test "a Nextcloud image without curl is NOT-READY (exit 3) before anything is created" {
    sw_on no-curl
    probe "$A" "$B"
    [ "$status" -eq 3 ]
    grep -q 'curl' <<< "$output"
    grep -q 'NOT-READY' <<< "$output"
    refute_recorded docker 'reset-password'
    refute_recorded docker '/clients'
}

@test "a platform host whose /_matrix is not routed at the edge makes chat and call NOT-ENABLED (exit 3), never PASS" {
    sw_on matrix-unrouted
    probe "$A" "$B"
    [ "$status" -eq 3 ]
    section_is chat NOT-ENABLED
    section_is call NOT-ENABLED
    section_is files PASS
    grep -q '/_matrix' <<< "$output"
    [ ! -e "${FAKE_DIR}/sent-${A}" ]
    [ ! -e "${FAKE_DIR}/sent-${B}" ]
}

@test "files: an answer other than 403 or 404 for the other user's root (here 401) FAILS, it is never read as a denial" {
    sw_on dav-401
    probe "$A" "$B"
    [ "$status" -eq 1 ]
    section_is files FAIL
    grep -q 'answered 401, expected 403 404' <<< "$output"
}

@test "office: a 500 for the other customer's file FAILS and names the missing error mapping of the route" {
    sw_on editor-500
    probe "$A" "$B"
    [ "$status" -eq 1 ]
    section_is office FAIL
    grep -q 'error mapping' <<< "$output"
}

@test "office: a 502 for the other customer's file FAILS and names the missing error mapping of the route" {
    sw_on editor-502
    probe "$A" "$B"
    [ "$status" -eq 1 ]
    section_is office FAIL
    grep -q 'error mapping' <<< "$output"
}

# ---------------------------------------------------------------- secrets on a failing run

@test "no secret is on any argv, jq included, on a failing run either" {
    sw_on all401
    probe "$A" "$B"
    [ "$status" -eq 1 ]
    assert_absent "$PW_SENTINEL" "$SHIM_LOG" "the random password is on an argv"
    assert_absent 'SECRET-' "$SHIM_LOG" "a realm admin client secret is on an argv"
    assert_absent 'TOKMARK' "$SHIM_LOG" "a token is on an argv"
    assert_absent 'OID\.' "$SHIM_LOG" "a Matrix OpenID token is on an argv"
    assert_present "$PW_SENTINEL" "${FAKE_DIR}/stdin.log" "the password never reached the stdin config"
    assert_recorded jq "isoprobe-${CLIENT_SUFFIX}"
}

# ---------------------------------------------------------------- the header

@test "the header says what is unchecked, and no longer promises a separate shared-group check" {
    assert_present 'UNCHECKED' "$PROBE" "the unchecked list is not in the header"
    assert_present 'Nextcloud image' "$PROBE" "whether the Nextcloud image has curl is not recorded"
    assert_present 'WebDAV refusal code' "$PROBE" "the exact WebDAV refusal code is not recorded as unchecked"
    assert_present '_matrix on PLATFORM_DOMAIN' "$PROBE" "the edge routing of /_matrix is not recorded as unchecked"
    assert_absent 'no shared group' "$PROBE" "the header still promises a separate shared-group check"
    assert_present 'error mapping' "$PROBE" "the office section's need of the route's error mapping is not recorded"
}

@test "the header states the exit codes, what a garbled folder list does, and what the WebDAV denial proves" {
    assert_present 'CLEANUP-FAILED' "$PROBE" "the clean-up exit is not in the header"
    assert_present 'RESULT: ABORTED' "$PROBE" "the abort line is not in the header"
    assert_present 'is NOT-READY' "$PROBE" "a garbled folder list is not described"
    assert_present 'user-root isolation' "$PROBE" "what the WebDAV denial proves is not stated"
    assert_absent 'a shape the' "$PROBE" "the header still overstates what a garbled folder list does"
}

@test "the header records the first-step reads and what the files section decides" {
    assert_present 'verifyBearerJwt' "$PROBE" "the Bearer verification is not recorded"
    assert_present 'bearerTenantMatches' "$PROBE" "the issuer match is not recorded"
    assert_present 'azp' "$PROBE" "the unchecked azp is not recorded"
    assert_present 'one folder id' "$PROBE" "the files decision rule is not recorded"
    assert_present 'save and close' "$PROBE" "the unproven part of office is not recorded"
}
