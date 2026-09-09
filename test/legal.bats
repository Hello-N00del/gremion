#!/usr/bin/env bats
# Unit tests for the legal page rendering logic (envsubst two-pass strategy).
# No Docker required — tests entrypoint.sh rendering directly using real templates.
#
# Run: make test-unit  (or: bats test/legal.bats)

load 'test_helper/common'

TEMPLATES_DIR="${PROJECT_ROOT}/docker/legal/templates"

setup() {
    setup_temp_dir
    export ORG_NAME="Test Studierendenrat"
    export ORG_ADDRESS="Teststraße 1, 12345 Teststadt"
    export ORG_EMAIL="test@example.com"
    export RESPONSIBLE_PERSON="Erika Mustermann"
    export RESPONSIBLE_PERSON_EMAIL="datenschutz@example.com"
    export DATA_RETENTION_FILES="2 Jahre"
    export DATA_RETENTION_FINANCIAL="10 Jahre"
    export DATA_RETENTION_KEYCLOAK_SESSIONS="90 Tage"
    export ACCESSIBILITY_STATUS="teilweise konform"
    export ACCESSIBILITY_DATE="2026-01-01"
    export DOMAIN="test.example.com"
    export YEAR="2026"
}

teardown() {
    teardown_temp_dir
    unset ORG_NAME ORG_ADDRESS ORG_EMAIL RESPONSIBLE_PERSON RESPONSIBLE_PERSON_EMAIL \
          DATA_RETENTION_FILES DATA_RETENTION_FINANCIAL DATA_RETENTION_KEYCLOAK_SESSIONS \
          ACCESSIBILITY_STATUS ACCESSIBILITY_DATE DOMAIN YEAR FOOTER
}

# Runs the same rendering loop as entrypoint.sh against real templates.
render_pages() {
    FOOTER=$(envsubst < "${TEMPLATES_DIR}/_footer.html")
    export FOOTER
    for tmpl in "${TEMPLATES_DIR}"/*.html; do
        name=$(basename "$tmpl")
        case "$name" in _*) continue ;; esac
        envsubst '$FOOTER' < "$tmpl" | envsubst > "${TEST_TEMP_DIR}/${name%.html}"
    done
}

@test "rendering loop exits without error" {
    run bash -c "
        export ORG_NAME='$ORG_NAME' ORG_ADDRESS='$ORG_ADDRESS' ORG_EMAIL='$ORG_EMAIL'
        export RESPONSIBLE_PERSON='$RESPONSIBLE_PERSON' RESPONSIBLE_PERSON_EMAIL='$RESPONSIBLE_PERSON_EMAIL'
        export DATA_RETENTION_FILES='$DATA_RETENTION_FILES' DATA_RETENTION_FINANCIAL='$DATA_RETENTION_FINANCIAL'
        export DATA_RETENTION_KEYCLOAK_SESSIONS='$DATA_RETENTION_KEYCLOAK_SESSIONS'
        export ACCESSIBILITY_STATUS='$ACCESSIBILITY_STATUS' ACCESSIBILITY_DATE='$ACCESSIBILITY_DATE'
        export DOMAIN='$DOMAIN' YEAR='$YEAR'
        FOOTER=\$(envsubst < '${TEMPLATES_DIR}/_footer.html')
        export FOOTER
        for tmpl in '${TEMPLATES_DIR}'/*.html; do
            name=\$(basename \"\$tmpl\")
            case \"\$name\" in _*) continue ;; esac
            envsubst '\$FOOTER' < \"\$tmpl\" | envsubst > '${TEST_TEMP_DIR}/'\"\${name%.html}\"
        done
    "
    [ "$status" -eq 0 ]
}

@test "all five pages are rendered" {
    render_pages
    [ -f "${TEST_TEMP_DIR}/index" ]
    [ -f "${TEST_TEMP_DIR}/datenschutz" ]
    [ -f "${TEST_TEMP_DIR}/impressum" ]
    [ -f "${TEST_TEMP_DIR}/barrierefreiheit" ]
    [ -f "${TEST_TEMP_DIR}/nutzungsbedingungen" ]
}

@test "partial templates (_footer) are not rendered as pages" {
    render_pages
    [ ! -f "${TEST_TEMP_DIR}/_footer" ]
}

@test "rendered pages contain no unresolved envsubst placeholders" {
    render_pages
    for outfile in "${TEST_TEMP_DIR}"/*; do
        assert_file_not_contains "$outfile" '${'
    done
}

@test "datenschutz page contains ORG_NAME value" {
    render_pages
    assert_file_contains "${TEST_TEMP_DIR}/datenschutz" "Test Studierendenrat"
}

@test "impressum page contains RESPONSIBLE_PERSON value" {
    render_pages
    assert_file_contains "${TEST_TEMP_DIR}/impressum" "Erika Mustermann"
}

@test "all pages contain all four footer links" {
    render_pages
    for page in index datenschutz impressum barrierefreiheit nutzungsbedingungen; do
        assert_file_contains "${TEST_TEMP_DIR}/${page}" "/datenschutz"
        assert_file_contains "${TEST_TEMP_DIR}/${page}" "/impressum"
        assert_file_contains "${TEST_TEMP_DIR}/${page}" "/barrierefreiheit"
        assert_file_contains "${TEST_TEMP_DIR}/${page}" "/nutzungsbedingungen"
    done
}

@test "footer copyright contains YEAR value" {
    render_pages
    assert_file_contains "${TEST_TEMP_DIR}/impressum" "2026"
}
