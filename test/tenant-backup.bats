#!/usr/bin/env bats
# Tests for scripts/tenant-backup.sh: atomic dated generations.
# Run: bats test/tenant-backup.bats
#
# The script is copied into a throw-away tree (it cd's to its own repo root, so
# the copy gets its own ./backups and no .env) and run with recording shims for
# psql, docker, curl, python3, jq and openssl (same I/O contract as the real
# `openssl enc`; see the shim). "Byte-identical" below is a sha256 comparison.
#
# What these guard (post-conditions, never exit codes alone):
#   * a failing pg_dump must not touch the previous good backup, and every run
#     must leave its own dated generation instead of overwriting.
#     `pg_dump | openssl > artifact` opens (truncates) the artifact BEFORE the
#     producer runs, so a failed dump used to destroy last night's copy and
#     leave a 32-byte ciphertext of nothing in its place.
#   * retention never prunes the newest generations, however old they are.
#   * registry values that become a path segment or an indirect expansion
#     (residency_zone, backup key env name) are validated first.
#
# TENANT_BACKUP_UNDER_TEST=<path> runs the suite against another copy of the
# script (e.g. the pre-change one) to prove the guards go RED.

load 'test_helper/common'

PROJECT_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"

TENANT_ID="01927f00-0000-7000-8000-000000000001"
TENANT_DB="t_01927f00000070008000000000000001__kernel"

setup() {
    setup_temp_dir
    TREE="${TEST_TEMP_DIR}/tree"
    FAKE_BIN="${TEST_TEMP_DIR}/bin"
    FAKE_LOG="${TEST_TEMP_DIR}/calls.log"
    mkdir -p "${TREE}/scripts" "$FAKE_BIN"
    cp "${TENANT_BACKUP_UNDER_TEST:-${PROJECT_ROOT}/scripts/tenant-backup.sh}" "${TREE}/scripts/tenant-backup.sh"
    : > "$FAKE_LOG"

    # control-DB registry row: tenant id, realm, status, residency zone, key ref
    cat > "${FAKE_BIN}/psql" <<'SHIM'
#!/usr/bin/env bash
printf '01927f00-0000-7000-8000-000000000001\trealm-x\tactive\t%s\t%s\n' \
    "${FAKE_ZONE-eu}" "${FAKE_KEY_REF:-env:TB_KEY}"
SHIM
    # docker compose exec -T postgres pg_dump ...
    cat > "${FAKE_BIN}/docker" <<'SHIM'
#!/usr/bin/env bash
echo "docker $*" >> "$FAKE_LOG"
case " $* " in
    *" pg_dump "*)
        if [ -n "${FAKE_PGDUMP_FAIL:-}" ]; then printf 'PARTIAL-DUMP-BYTES'; exit 1; fi
        if [ -n "${FAKE_PGDUMP_EMPTY:-}" ]; then exit 0; fi
        printf 'PGDUMP-OUTPUT db=%s n=%s' "${@: -1}" "$RANDOM"
        exit 0 ;;
    *) exit 0 ;;
esac
SHIM
    cat > "${FAKE_BIN}/curl" <<'SHIM'
#!/usr/bin/env bash
case "$*" in
    *openid-connect/token*) printf '{"access_token":"tok"}' ;;
    *) printf '{"realm":"realm-x","pad":"0123456789"}' ;;
esac
SHIM
    # openssl shim: some Windows openssl builds reject `-pass fd:N`, which the
    # script relies on. Same I/O contract as `openssl enc -aes-256-cbc -salt`:
    # a 16-byte "Salted__<salt>" header, the (here: base64-encoded) payload, and
    # a 16-byte final block -- so ciphertext of nothing is exactly 32 bytes, as
    # with the real one. The key is read from fd 3 like the real call.
    cat > "${FAKE_BIN}/openssl" <<'SHIM'
#!/usr/bin/env bash
cat <&3 > /dev/null 2>&1 || true
printf 'Salted__%08d' "$RANDOM"
base64 -w0
printf '................'
SHIM
    printf '#!/usr/bin/env bash\ncat > /dev/null; echo tok\n' > "${FAKE_BIN}/python3"
    printf '#!/usr/bin/env bash\ncat\n' > "${FAKE_BIN}/jq"
    chmod +x "${FAKE_BIN}"/*
}

teardown() {
    teardown_temp_dir
}

# _backup <slug> [extra KEY=VAL env words...]
_backup() {
    local slug="$1"; shift
    run env PATH="${FAKE_BIN}:${PATH}" \
        FAKE_LOG="$FAKE_LOG" \
        CONTROL_DATABASE_URL="postgres://x/x" POSTGRES_USER=postgres \
        KEYCLOAK_ADMIN=a KEYCLOAK_ADMIN_PASSWORD=b TB_KEY=top-secret-key \
        "$@" \
        bash "${TREE}/scripts/tenant-backup.sh" "$slug"
}

_out_dir() { echo "${TREE}/backups/tenants/${1:-eu}/${2:-tenant-a}"; }

# Every file under the tenant dir with its hash: a change, a new file or a
# vanished file all show up in a diff of two snapshots.
_snapshot() {
    ( cd "$1" && find . -type f | LC_ALL=C sort | while IFS= read -r f; do
        printf '%s  %s\n' "$(sha256sum < "$f" | cut -d' ' -f1)" "$f"
    done )
}

@test "a failing pg_dump leaves the previous backup byte-identical and no partial files" {
    _backup tenant-a
    [[ "$status" -eq 0 ]] || { echo "first (good) run failed:"; echo "$output"; return 1; }
    local out; out="$(_out_dir eu tenant-a)"
    local before; before="$(_snapshot "$out")"
    [[ -n "$before" ]] || { echo "the good run wrote nothing under ${out}"; return 1; }

    _backup tenant-a FAKE_PGDUMP_FAIL=1
    [[ "$status" -ne 0 ]] || { echo "a failing pg_dump exited 0"; echo "$output"; return 1; }

    local after; after="$(_snapshot "$out")"
    [[ "$before" == "$after" ]] \
        || { echo "the previous backup changed after a FAILED run"; diff <(echo "$before") <(echo "$after") || true; return 1; }
    [[ -z "$(find "$out" -name '.partial-*' 2>/dev/null)" ]] \
        || { echo "a staging dir was left behind:"; find "$out"; return 1; }
}

@test "the dump targets the tenant-id keyed kernel database" {
    _backup tenant-a
    [[ "$status" -eq 0 ]] || { echo "$output"; return 1; }
    grep -qE "pg_dump -Fc -U postgres ${TENANT_DB}\$" "$FAKE_LOG" \
        || { echo "pg_dump was not called against ${TENANT_DB}:"; cat "$FAKE_LOG"; return 1; }
}

@test "two successful runs keep two generations, and the first is not overwritten" {
    _backup tenant-a
    [[ "$status" -eq 0 ]] || { echo "$output"; return 1; }
    local out; out="$(_out_dir eu tenant-a)"
    # the .last-backup marker is meant to move to the newest run; everything else
    # of generation 1 must stay exactly as it was
    local first; first="$(_snapshot "$out" | grep -v '\.last-backup' || true)"
    [[ -n "$first" ]] || { echo "the first run wrote no artifacts"; return 1; }

    _backup tenant-a
    [[ "$status" -eq 0 ]] || { echo "$output"; return 1; }

    local n; n=$(find "$out" -type f -name 'tenant-a.dump.age' | wc -l)
    [[ "$n" -eq 2 ]] || { echo "expected 2 generations of tenant-a.dump.age, found ${n}"; find "$out"; return 1; }
    local snap2; snap2="$(_snapshot "$out")"
    local line
    while IFS= read -r line; do
        grep -qF -- "$line" <<< "$snap2" \
            || { echo "generation 1 file changed or vanished: ${line}"; return 1; }
    done <<< "$first"
}

@test ".last-backup names the newest generation, which holds both artifacts" {
    _backup tenant-a
    [[ "$status" -eq 0 ]] || { echo "$output"; return 1; }
    local out; out="$(_out_dir eu tenant-a)"
    local gen; gen="$(<"${out}/.last-backup")"
    [[ -f "${out}/${gen}/tenant-a.dump.age" && -f "${out}/${gen}/realm.json.age" ]] \
        || { echo "the generation named by .last-backup (${gen}) is incomplete:"; find "$out"; return 1; }
    [[ ! -e "${out}/.last-backup.tmp" ]]
}

@test "retention prunes old generations but never the newest two" {
    local out; out="$(_out_dir eu tenant-a)"
    local g
    for g in 20200101-000000-1 20200102-000000-1; do
        mkdir -p "${out}/${g}"
        printf 'old-good-backup' > "${out}/${g}/tenant-a.dump.age"
        touch -d '90 days ago' "${out}/${g}" "${out}/${g}/tenant-a.dump.age"
    done
    _backup tenant-a TENANT_BACKUP_RETENTION_DAYS=30
    [[ "$status" -eq 0 ]] || { echo "$output"; return 1; }
    # newest two survive: the new run and the newer of the two old ones
    [[ -f "${out}/20200102-000000-1/tenant-a.dump.age" ]] \
        || { echo "the second-newest generation was pruned although only one newer exists"; find "$out"; return 1; }
    [[ ! -e "${out}/20200101-000000-1" ]] \
        || { echo "a third-newest generation older than retention was not pruned"; find "$out"; return 1; }
}

@test "retention keeps the configured number of newest generations, however old" {
    local out; out="$(_out_dir eu tenant-a)"
    local g
    for g in 20200101-000000-1 20200102-000000-1 20200103-000000-1; do
        mkdir -p "${out}/${g}"
        printf 'old-good-backup' > "${out}/${g}/tenant-a.dump.age"
        touch -d '90 days ago' "${out}/${g}" "${out}/${g}/tenant-a.dump.age"
    done
    _backup tenant-a TENANT_BACKUP_RETENTION_DAYS=30 TENANT_BACKUP_KEEP_GENERATIONS=4
    [[ "$status" -eq 0 ]] || { echo "$output"; return 1; }
    local n; n=$(find "$out" -mindepth 1 -maxdepth 1 -type d | wc -l)
    [[ "$n" -eq 4 ]] || { echo "expected the 4 newest generations to survive, found ${n}"; find "$out"; return 1; }
}

@test "a pg_dump that succeeds but writes nothing fails the run and creates no generation" {
    _backup tenant-a FAKE_PGDUMP_EMPTY=1
    [[ "$status" -ne 0 ]] || { echo "an empty dump was accepted as a backup"; echo "$output"; return 1; }
    local out; out="$(_out_dir eu tenant-a)"
    local n; n=$(find "$out" -type f -name '*.age' 2>/dev/null | wc -l)
    [[ "$n" -eq 0 ]] || { echo "artifacts were left behind:"; find "$out"; return 1; }
}

@test "a registry residency_zone that is not a plain label is refused before anything is written" {
    _backup tenant-a FAKE_ZONE=../../escape
    [[ "$status" -ne 0 ]] || { echo "path-traversing residency_zone accepted"; echo "$output"; return 1; }
    [[ ! -e "${TREE}/escape" && ! -e "${TREE}/backups/tenants/../../escape" ]]
    [[ -z "$(find "${TREE}/backups" -type f 2>/dev/null)" ]] \
        || { echo "files were written:"; find "${TREE}/backups"; return 1; }
    [[ -z "$(find "${TREE}/backups" -mindepth 1 2>/dev/null)" ]] \
        || { echo "directories were created before the zone was validated:"; find "${TREE}/backups"; return 1; }
}

@test "a backup key env reference that is not a plain variable name is refused" {
    _backup tenant-a 'FAKE_KEY_REF=env:TB_KEY;echo'
    [[ "$status" -ne 0 ]] || { echo "a malformed env key reference was accepted"; echo "$output"; return 1; }
    [[ "$output" == *"invalid env var"* ]] || { echo "unexpected failure:"; echo "$output"; return 1; }
}

@test "TENANT_BACKUP_RETENTION_DAYS and TENANT_BACKUP_KEEP_GENERATIONS are validated" {
    _backup tenant-a TENANT_BACKUP_RETENTION_DAYS=abc
    [[ "$status" -eq 2 ]] || { echo "non-numeric retention accepted (status ${status})"; echo "$output"; return 1; }
    _backup tenant-a TENANT_BACKUP_KEEP_GENERATIONS=0
    [[ "$status" -eq 2 ]] || { echo "keep=0 accepted (status ${status})"; echo "$output"; return 1; }
}
