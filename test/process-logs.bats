#!/usr/bin/env bats
# docker/vector/process-logs.sh writes NDJSON: one complete JSON object per
# physical line.
#
# WHY THIS IS A GUARD AND NOT A NICETY. The processed log is consumed by
# Vector's `file` source, which is line-oriented (one line == one event). A
# pretty-printed object becomes one event per brace, `parse_json!(.message)`
# aborts on each fragment, and the retention filter then reads a null
# .RequestReceivedAt, falls back to now() and keeps the fragment for ever.
# The substring checks in docker/vector/test-process-logs.sh cannot see that
# (a pretty-printed object still contains exactly one "RequestPath" line), and
# that script also needs the compiled `ipcrypt` binary, which exists only
# inside the vector image, so before this file nothing under verify exercised
# the framing at all (scripts/verify/suites/unit.mjs collects test/*.bats).
#
# So the behavioural cases here put a STUB `ipcrypt` first in PATH. The stub
# only has to turn an IP into a non-IP token; the pseudonymisation itself is
# ipcrypt's job and is covered by the real-binary case, which runs
# docker/vector/test-process-logs.sh when a real `ipcrypt` is installed.
#
# The last case is the guard-efficacy proof: the same assertions run against a
# scratch copy of process-logs.sh with `-c` removed and MUST fail.
#
# Run: bats test/process-logs.bats

PROJECT_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
VEC="${PROJECT_ROOT}/docker/vector"

setup() {
    command -v jq >/dev/null 2>&1 || skip "jq not installed"
    STUBS="${BATS_TEST_TMPDIR}/stubs"
    RAW="${BATS_TEST_TMPDIR}/raw.log"
    PROCESSED="${BATS_TEST_TMPDIR}/processed.log"
    mkdir -p "$STUBS"
    # A stand-in for the compiled ipcrypt: stdin in, "pseudo-<cksum>" out. Never
    # a dotted quad, never the input.
    cat >"$STUBS/ipcrypt" <<'STUB'
#!/bin/sh
printf 'pseudo-%s\n' "$(cat | cksum | cut -d' ' -f1)"
STUB
    chmod +x "$STUBS/ipcrypt"
    # Four lines, three of them security paths; the last carries a synthetic
    # query-string credential that must be redacted.
    cat >"$RAW" <<'EOF'
{"RequestPath":"/api/users","ClientHost":"192.168.1.100","RequestMethod":"GET"}
{"RequestPath":"/files/document.pdf","ClientHost":"10.0.0.1","RequestMethod":"GET"}
{"RequestPath":"/auth/realms/tenant-a","ClientHost":"172.16.0.5","RequestMethod":"POST"}
{"RequestPath":"/auth/callback/keycloak?code=SECRETCODE&state=xyz","ClientHost":"172.16.0.6","RequestMethod":"GET"}
EOF
}

# reap_tail: process-logs.sh ends in `tail -F | while`; killing the script leaves
# the tail behind. Kill it by its unique raw-log path so no test leaks a process.
reap_tail() {
    local p
    for p in /proc/[0-9]*; do
        if { tr '\0' ' ' <"$p/cmdline" | grep -qF -- "tail -F $RAW"; } 2>/dev/null; then
            kill "${p#/proc/}" 2>/dev/null || true
        fi
    done
}

teardown() {
    [ -n "${RAW:-}" ] && reap_tail
    return 0
}

# collect SCRIPT: run SCRIPT against $RAW with the stub ipcrypt first in PATH and
# stop it once the LAST security record (the redacted callback) has been written.
# Output goes to files so no orphan holds bats' capture pipe open.
collect() {
    local script="$1" pid i
    PATH="$STUBS:$PATH" RAW_LOG_PATH="$RAW" PROCESSED_LOG_PATH="$PROCESSED" \
        IPCRYPT_KEY="00112233445566778899aabbccddeeff" IPCRYPT_KEY_EPOCH=0 \
        timeout 20 bash "$script" >"${BATS_TEST_TMPDIR}/pl.out" 2>"${BATS_TEST_TMPDIR}/pl.err" &
    pid=$!
    for i in $(seq 1 150); do
        grep -q '<redacted>' "$PROCESSED" 2>/dev/null && break
        sleep 0.1
    done
    sleep 0.3
    kill "$pid" 2>/dev/null || true
    reap_tail
    wait "$pid" 2>/dev/null || true
    return 0
}

# framing_ok: the post-condition the consumer depends on. Exactly three physical
# lines, each a complete JSON object with a pseudonymised ClientHost.
framing_ok() {
    [ -f "$PROCESSED" ] || { echo "no processed log was created" >&2; return 1; }
    local total n=0 line host
    total="$(wc -l <"$PROCESSED" | tr -d ' ')"
    [ "$total" = "3" ] || { echo "expected 3 physical lines, got $total" >&2; return 1; }
    while IFS= read -r line; do
        n=$((n + 1))
        printf '%s' "$line" | jq -e 'type == "object"' >/dev/null 2>&1 \
            || { echo "line $n is not a complete JSON object: $line" >&2; return 1; }
        host="$(printf '%s' "$line" | jq -r '.ClientHost // empty')"
        [ -n "$host" ] || { echo "line $n has no ClientHost" >&2; return 1; }
        if printf '%s' "$host" | grep -qE '^[0-9]{1,3}(\.[0-9]{1,3}){3}$'; then
            echo "line $n has an un-pseudonymised ClientHost: $host" >&2
            return 1
        fi
    done <"$PROCESSED"
    [ "$n" -eq 3 ]
}

@test "process-logs.sh: the processed log is NDJSON, exactly 3 physical lines for 3 security events" {
    collect "$VEC/process-logs.sh"
    [ -f "$PROCESSED" ]
    [ "$(wc -l <"$PROCESSED" | tr -d ' ')" = "3" ]
}

@test "process-logs.sh: every processed line parses on its own as an object with a pseudonymised ClientHost" {
    collect "$VEC/process-logs.sh"
    run framing_ok
    [ "$status" -eq 0 ]
}

@test "process-logs.sh: no raw client IP, no query-string credential, query marked ?<redacted>, key_epoch set" {
    collect "$VEC/process-logs.sh"
    [ -f "$PROCESSED" ]
    run grep -c -e '192\.168\.1\.100' -e '172\.16\.0\.5' -e '172\.16\.0\.6' "$PROCESSED"
    [ "$output" = "0" ]
    run grep -c 'SECRETCODE' "$PROCESSED"
    [ "$output" = "0" ]
    grep -qF '"/auth/callback/keycloak?<redacted>"' "$PROCESSED"
    [ "$(jq -s 'map(select(.key_epoch == 0)) | length' "$PROCESSED")" = "3" ]
}

@test "process-logs.sh: non-security paths are dropped" {
    collect "$VEC/process-logs.sh"
    [ -f "$PROCESSED" ]
    run grep -c '/files/document.pdf' "$PROCESSED"
    [ "$output" = "0" ]
}

# The real-ipcrypt path is not tested here: ipcrypt exists only inside the vector
# image, and a skip on the CI runner is an unaccounted skip. docker/vector/
# test-process-logs.sh covers it when run in that image.

@test "guard efficacy: process-logs.sh with jq -c removed fails the framing assertion" {
    local mut="${BATS_TEST_TMPDIR}/process-logs.mut.sh"
    sed 's/| jq -c --arg pip/| jq --arg pip/' "$VEC/process-logs.sh" >"$mut"
    # The mutation must actually have changed the script, or this proves nothing.
    if cmp -s "$mut" "$VEC/process-logs.sh"; then
        echo "mutation was a no-op: process-logs.sh has no 'jq -c --arg pip' to remove" >&2
        false
    fi
    collect "$mut"
    run framing_ok
    [ "$status" -ne 0 ]
    [[ "$output" == *"expected 3 physical lines"* ]]
}
