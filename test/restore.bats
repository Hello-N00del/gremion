#!/usr/bin/env bats
# Tests for scripts/restore.sh
# Run: ./test/bats/bin/bats test/restore.bats

load 'test_helper/common'

PROJECT_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
RESTORE_SCRIPT="${PROJECT_ROOT}/scripts/restore.sh"

setup() {
    setup_temp_dir
}

teardown() {
    teardown_temp_dir
}

# ---------------------------------------------------------------------------
# Script structure
# ---------------------------------------------------------------------------

@test "restore.sh exists" {
    [[ -f "$RESTORE_SCRIPT" ]]
}

@test "restore.sh is executable" {
    [[ -x "$RESTORE_SCRIPT" ]]
}

@test "restore.sh has strict mode set" {
    grep -q "set -euo pipefail" "$RESTORE_SCRIPT"
}

# ---------------------------------------------------------------------------
# Argument validation (static analysis)
# ---------------------------------------------------------------------------

@test "restore.sh validates input arguments" {
    grep -qE 'usage|Usage|\$#|argc|argument' "$RESTORE_SCRIPT"
}

@test "restore.sh does not reference the carved-out nextcloud target" {
    # nextcloud was carved out with its service; the restore arm (and its
    # maintenance-mode/repair handling) must be gone.
    assert_file_not_contains "$RESTORE_SCRIPT" "nextcloud"
}

@test "restore.sh supports keycloak restore target" {
    grep -q "keycloak" "$RESTORE_SCRIPT"
}

@test "restore.sh supports gremion restore target" {
    grep -q "gremion" "$RESTORE_SCRIPT"
}

@test "restore.sh restores keycloak, gremion and control via a shared arm" {
    grep -qF 'keycloak|gremion|control)' "$RESTORE_SCRIPT"
}

@test "restore.sh derives the keycloak and control DB roles on restore" {
    grep -qE 'KEYCLOAK_DB_USER' "$RESTORE_SCRIPT"
    grep -qE 'CONTROL_DB_USER' "$RESTORE_SCRIPT"
    # helios was carved out — its role derivation must be gone.
    assert_file_not_contains "$RESTORE_SCRIPT" "HELIOS_DB_USER"
}

@test "restore.sh lists only the kernel targets in its usage string" {
    grep -qF 'keycloak|gremion|control' "$RESTORE_SCRIPT"
    assert_file_not_contains "$RESTORE_SCRIPT" "helios"
}

@test "restore.sh checks backup file exists before restoring" {
    grep -qE '\-f \$|test -f|file.*exist|\[\[ -f' "$RESTORE_SCRIPT"
}

@test "restore.sh handles gzip-compressed backups" {
    grep -qE "gunzip|gzip|\.gz" "$RESTORE_SCRIPT"
}

# ---------------------------------------------------------------------------
# Safety checks
# ---------------------------------------------------------------------------

@test "restore.sh does not silently overwrite without confirmation or force flag" {
    # Should either prompt or require explicit --force / DB target argument
    grep -qE 'confirm|force|TARGET|target|database.*name' "$RESTORE_SCRIPT"
}

@test "restore.sh does not hardcode passwords" {
    ! grep -qE "password=['\"][^'\"]" "$RESTORE_SCRIPT"
}

# ---------------------------------------------------------------------------
# Behaviour: a restore that did not restore must not report success
# (F1-FIX-09, K6#3 / S5#2). The drop/create and the load both ran plain `psql`,
# which keeps going after an error and exits 0, so a dump that failed halfway
# still ended in "Restore complete". These cases run the REAL script against a
# `docker` shim that models psql's own exit-status contract: an error in the
# input is exit 3 ONLY when ON_ERROR_STOP is set, and exit 0 otherwise.
# ---------------------------------------------------------------------------

# $TREE is a copy of the script in its own repo-root-shaped directory, because
# restore.sh cd's to its parent and reads ./.env from there.
restore_tree() {
    TREE="${TEST_TEMP_DIR}/tree"
    mkdir -p "${TREE}/scripts" "${TREE}/bin"
    cp "$RESTORE_SCRIPT" "${TREE}/scripts/restore.sh"
    chmod +x "${TREE}/scripts/restore.sh"
    printf 'POSTGRES_USER=postgres\n' > "${TREE}/.env"
    CALLS="${TEST_TEMP_DIR}/docker-calls.log"
    : > "$CALLS"
    export CALLS
    cat > "${TREE}/bin/docker" <<'SHIM'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$CALLS"
input="$(cat)"
case "$*" in
    *"count(*)"*) printf '%s\n' "${FAKE_TABLE_COUNT:-3}"; exit 0 ;;
esac
if [[ "$input" == *BOOM* ]]; then
    echo "ERROR:  boom" >&2
    # psql: exit 3 on a script error only under ON_ERROR_STOP, else it carries on and exits 0.
    if [[ "$*" == *ON_ERROR_STOP=1* ]]; then exit 3; fi
fi
exit 0
SHIM
    chmod +x "${TREE}/bin/docker"
    export PATH="${TREE}/bin:${PATH}"
}

good_dump() {   # <path>
    printf 'CREATE TABLE a (x int);\nCOPY a FROM stdin;\n1\n\\.\n' | gzip > "$1"
}

bad_dump() {   # <path> -- an error halfway through the load
    printf 'CREATE TABLE a (x int);\nBOOM;\nCREATE TABLE b (y int);\n' | gzip > "$1"
}

@test "restore.sh reports success for a dump that loads and leaves tables behind" {
    restore_tree
    good_dump "${TEST_TEMP_DIR}/ok.sql.gz"
    run bash -c 'printf "yes\n" | "$1" control "$2"' _ "${TREE}/scripts/restore.sh" "${TEST_TEMP_DIR}/ok.sql.gz"
    [ "$status" -eq 0 ]
    [[ "$output" == *"Restore complete for 'control'"* ]]
}

@test "restore.sh exits non-zero and never says Restore complete when the dump errors mid-load" {
    restore_tree
    bad_dump "${TEST_TEMP_DIR}/bad.sql.gz"
    run bash -c 'printf "yes\n" | "$1" control "$2"' _ "${TREE}/scripts/restore.sh" "${TEST_TEMP_DIR}/bad.sql.gz"
    [ "$status" -ne 0 ]
    [[ "$output" != *"Restore complete"* ]]
}

@test "restore.sh runs both psql calls with ON_ERROR_STOP and loads in ONE transaction" {
    restore_tree
    good_dump "${TEST_TEMP_DIR}/ok.sql.gz"
    run bash -c 'printf "yes\n" | "$1" gremion "$2"' _ "${TREE}/scripts/restore.sh" "${TEST_TEMP_DIR}/ok.sql.gz"
    [ "$status" -eq 0 ]
    # the drop/create call (it carries the _target variable) ...
    grep -E '_target=gremion' "$CALLS" | grep -qF 'ON_ERROR_STOP=1'
    # ... and the load (the call that names the database positionally)
    local load
    load="$(grep -E 'psql -U postgres .*gremion$' "$CALLS" | grep -v '_target=' || true)"
    [[ "$load" == *"ON_ERROR_STOP=1"* ]]
    [[ "$load" == *"--single-transaction"* ]]
}

@test "restore.sh fails when the restored database holds no tables (post-condition)" {
    restore_tree
    good_dump "${TEST_TEMP_DIR}/ok.sql.gz"
    run bash -c 'printf "yes\n" | FAKE_TABLE_COUNT=0 "$1" control "$2"' _ "${TREE}/scripts/restore.sh" "${TEST_TEMP_DIR}/ok.sql.gz"
    [ "$status" -ne 0 ]
    [[ "$output" == *"no tables"* ]]
    [[ "$output" != *"Restore complete"* ]]
}

@test "restore.sh exits non-zero when the dump is not valid gzip" {
    restore_tree
    printf 'this is not gzip' > "${TEST_TEMP_DIR}/corrupt.sql.gz"
    run bash -c 'printf "yes\n" | "$1" control "$2"' _ "${TREE}/scripts/restore.sh" "${TEST_TEMP_DIR}/corrupt.sql.gz"
    [ "$status" -ne 0 ]
    [[ "$output" != *"Restore complete"* ]]
}

# ---------------------------------------------------------------------------
# Snapshot tag: read the neutral tag AND the legacy one (existing snapshots)
# ---------------------------------------------------------------------------

# A restic shim over a repo holding ONE snapshot carrying $SNAP_TAG. Like real
# restic, repeated --tag flags are OR'd: the snapshot is selected when any given
# tag matches (or none is given).
restic_shim() {
    cat > "${TREE}/bin/restic" <<'SHIM'
#!/usr/bin/env bash
echo "restic $*" >> "$CALLS"
tags=() ; args=() ; target=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --tag) tags+=("$2"); shift 2 ;;
        --target) target="$2"; shift 2 ;;
        *) args+=("$1"); shift ;;
    esac
done
match=0
if [[ ${#tags[@]} -eq 0 ]]; then match=1; fi
for t in "${tags[@]}"; do [[ "$t" == "$SNAP_TAG" ]] && match=1; done
case "${args[0]}" in
    snapshots) [[ $match -eq 1 ]] && echo "abc123  snapshot-tagged-$SNAP_TAG" ; exit 0 ;;
    restore)
        [[ $match -eq 1 ]] || { echo "Fatal: no matching snapshot" >&2; exit 1; }
        mkdir -p "${target}/backups/current"
        printf 'x' | gzip > "${target}/backups/current/gremion.sql.gz"
        exit 0 ;;
esac
SHIM
    chmod +x "${TREE}/bin/restic"
    export RESTIC_PASSWORD=fixture
}

@test "restore.sh --list-snapshots finds a snapshot written under the legacy tag" {
    restore_tree; restic_shim
    SNAP_TAG=stura-os run "${TREE}/scripts/restore.sh" --list-snapshots
    [ "$status" -eq 0 ]
    [[ "$output" == *"abc123"* ]]
}

@test "restore.sh --list-snapshots finds a snapshot written under the neutral tag" {
    restore_tree; restic_shim
    SNAP_TAG=gremion run "${TREE}/scripts/restore.sh" --list-snapshots
    [ "$status" -eq 0 ]
    [[ "$output" == *"abc123"* ]]
}

@test "restore.sh --snapshot latest restores a legacy-tagged snapshot" {
    restore_tree; restic_shim
    SNAP_TAG=stura-os run bash -c "echo no | '${TREE}/scripts/restore.sh' --snapshot latest gremion"
    [ "$status" -eq 0 ]
    [[ "$output" == *"Found dump"* ]]
}

@test "restore.sh --snapshot latest restores a neutral-tagged snapshot" {
    restore_tree; restic_shim
    SNAP_TAG=gremion run bash -c "echo no | '${TREE}/scripts/restore.sh' --snapshot latest gremion"
    [ "$status" -eq 0 ]
    [[ "$output" == *"Found dump"* ]]
}

@test "restore.sh BACKUP_LEGACY_TAG is configurable" {
    restore_tree; restic_shim
    BACKUP_LEGACY_TAG=oldname SNAP_TAG=oldname run "${TREE}/scripts/restore.sh" --list-snapshots
    [ "$status" -eq 0 ]
    [[ "$output" == *"abc123"* ]]
}
