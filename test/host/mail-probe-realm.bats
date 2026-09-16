#!/usr/bin/env bats
# B-01 (spec B §T.4): with no boot-imported realm, the only realm that exists on
# a freshly started Keycloak is `master`. gremion-mail-bringup assert 6b probes
# KEYCLOAK_PROBE_REALM; a probe pointed at a realm nobody creates reports
# "user ... not found in realm ..." and returns 1 on every run.

ROOT="${BATS_TEST_DIRNAME}/../.."

@test "mail.env.tmpl probes the master realm" {
    run grep -n '^KEYCLOAK_PROBE_REALM=' "${ROOT}/infra/host/templates/env/mail.env.tmpl"
    [ "$status" -eq 0 ]
    [[ "$output" == *"KEYCLOAK_PROBE_REALM=master"* ]]
}

@test "mail.env.tmpl declares no realm that only a tenant-create can produce" {
    run grep -c 'KEYCLOAK_PROBE_REALM=platform' "${ROOT}/infra/host/templates/env/mail.env.tmpl"
    [ "$output" = "0" ]
}

@test "gremion-mail-bringup still reads KEYCLOAK_PROBE_REALM at each probe site" {
    run grep -c 'KEYCLOAK_PROBE_REALM' "${ROOT}/infra/host/bin/gremion-mail-bringup"
    [ "$status" -eq 0 ]
    [ "$output" -ge 3 ]
}

@test "gremion-mail-bringup assert 6b still searches the release tree for smtpServer" {
    run grep -n '"smtpServer"' "${ROOT}/infra/host/bin/gremion-mail-bringup"
    [ "$status" -eq 0 ]
    [[ "$output" == *'current/docker/keycloak'* ]] || \
      grep -q 'kcdir=.*current/docker/keycloak' "${ROOT}/infra/host/bin/gremion-mail-bringup"
}
