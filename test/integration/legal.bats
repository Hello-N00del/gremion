#!/usr/bin/env bats
# Integration tests for the legal service.
# Requires running stack: make up (with legal service)
#
# Run: make test-integration

load '../test_helper/common'

LEGAL_URL="http://localhost:8083"

setup() {
    if [[ -f "${PROJECT_ROOT}/legal/legal.env" ]]; then
        ORG_NAME_VALUE=$(grep "^ORG_NAME=" "${PROJECT_ROOT}/legal/legal.env" | cut -d'=' -f2-)
        export ORG_NAME_VALUE
    fi
}

@test "legal service is reachable on port 8083" {
    run curl -sf --max-time 5 "${LEGAL_URL}/"
    [ "$status" -eq 0 ]
}

@test "landing page returns HTTP 200" {
    run curl -s -o /dev/null -w "%{http_code}" "${LEGAL_URL}/"
    [ "$output" = "200" ]
}

@test "datenschutz returns HTTP 200 at clean URL" {
    run curl -s -o /dev/null -w "%{http_code}" "${LEGAL_URL}/datenschutz"
    [ "$output" = "200" ]
}

@test "impressum returns HTTP 200 at clean URL" {
    run curl -s -o /dev/null -w "%{http_code}" "${LEGAL_URL}/impressum"
    [ "$output" = "200" ]
}

@test "barrierefreiheit returns HTTP 200 at clean URL" {
    run curl -s -o /dev/null -w "%{http_code}" "${LEGAL_URL}/barrierefreiheit"
    [ "$output" = "200" ]
}

@test "nutzungsbedingungen returns HTTP 200 at clean URL" {
    run curl -s -o /dev/null -w "%{http_code}" "${LEGAL_URL}/nutzungsbedingungen"
    [ "$output" = "200" ]
}

@test "datenschutz page contains ORG_NAME from config" {
    [[ -n "${ORG_NAME_VALUE}" ]] || skip "legal/legal.env not found"
    run curl -sf "${LEGAL_URL}/datenschutz"
    [[ "$output" == *"${ORG_NAME_VALUE}"* ]]
}

@test "no unresolved envsubst placeholders in any served page" {
    for path in / /datenschutz /impressum /barrierefreiheit /nutzungsbedingungen; do
        run curl -sf "${LEGAL_URL}${path}"
        [[ "$output" != *'${'* ]]
    done
}

@test "all pages contain all four footer links" {
    for path in / /datenschutz /impressum /barrierefreiheit /nutzungsbedingungen; do
        run curl -sf "${LEGAL_URL}${path}"
        [[ "$output" == *"/datenschutz"* ]]
        [[ "$output" == *"/impressum"* ]]
        [[ "$output" == *"/barrierefreiheit"* ]]
        [[ "$output" == *"/nutzungsbedingungen"* ]]
    done
}

@test "unknown path returns 404" {
    run curl -s -o /dev/null -w "%{http_code}" "${LEGAL_URL}/nonexistent"
    [ "$output" = "404" ]
}
