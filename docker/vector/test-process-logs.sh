#!/bin/bash
# Test that security paths are processed and non-security paths are dropped.
set -e

TMP_DIR=$(mktemp -d)
export RAW_LOG_PATH="$TMP_DIR/raw.log"
export PROCESSED_LOG_PATH="$TMP_DIR/processed.log"
# ipcrypt requires a key that decodes to EXACTLY 16 bytes (32 hex digits).
# The previous value here ("test-key-1234abcd") did not, so `ipcrypt nd-encrypt`
# failed on every line, process-logs.sh's `|| continue` swallowed it, the
# processed log was never even created — and this test still reported PASS on
# zero collected events. Test fixture, not a real secret.
export IPCRYPT_KEY="00112233445566778899aabbccddeeff"
export IPCRYPT_KEY_EPOCH="0"

# Write test log lines
# The 4th line carries a synthetic query-string credential (#258-F2) to verify
# the query is redacted before persistence.
cat > "$RAW_LOG_PATH" <<'EOF'
{"RequestPath":"/api/users","ClientHost":"192.168.1.100","RequestMethod":"GET"}
{"RequestPath":"/files/document.pdf","ClientHost":"10.0.0.1","RequestMethod":"GET"}
{"RequestPath":"/auth/realms/tenant-a","ClientHost":"172.16.0.5","RequestMethod":"POST"}
{"RequestPath":"/auth/callback/keycloak?code=SECRETCODE&state=xyz","ClientHost":"172.16.0.6","RequestMethod":"GET"}
EOF

# Run for a moment then kill (uses tail -F so will block otherwise)
timeout 3 bash "$(dirname "$0")/process-logs.sh" 2>/dev/null || true

# A missing processed log is a FAILURE, not "zero matches". Assert the
# post-condition explicitly — the old code let a never-created file fall
# through `grep -c ... || echo 0` (which emits "0\n0", making `[ -ne ]` error
# out with "integer expression expected" and the PASS branch print anyway).
if [ ! -f "$TMP_DIR/processed.log" ]; then
    echo "FAIL: processed log was never created — process-logs.sh dropped every line"
    rm -rf "$TMP_DIR"
    exit 1
fi

# Should have 3 lines (api + auth/realms + auth/callback), not the /files line
COUNT=$(grep -c '"RequestPath"' "$TMP_DIR/processed.log" || true)
COUNT=${COUNT:-0}
if [ "$COUNT" -ne 3 ]; then
    echo "FAIL: expected 3 processed lines, got $COUNT"
    rm -rf "$TMP_DIR"
    exit 1
fi
echo "PASS: routing test"

# Raw IPs should not appear in processed log
if grep -q "192.168.1.100" "$TMP_DIR/processed.log" 2>/dev/null; then
    echo "FAIL: raw IP written to processed log"
    rm -rf "$TMP_DIR"
    exit 1
fi
echo "PASS: no raw IPs in processed log"

# #258-F2: query-string credentials must be redacted, not persisted verbatim
if grep -q "SECRETCODE" "$TMP_DIR/processed.log" 2>/dev/null; then
    echo "FAIL: query-string credential written to processed log"
    rm -rf "$TMP_DIR"
    exit 1
fi
if ! grep -q '"/auth/callback/keycloak?<redacted>"' "$TMP_DIR/processed.log" 2>/dev/null; then
    echo "FAIL: query string not redacted on RequestPath"
    rm -rf "$TMP_DIR"
    exit 1
fi
echo "PASS: query string redacted on RequestPath"

# --- NDJSON framing -------------------------------------------------------
# The processed log is consumed by Vector's `file` source, which is strictly
# line-oriented: one physical line == one event. If process-logs.sh emits
# pretty-printed (multi-line) JSON, every brace/field line becomes its own
# Vector event, `parse_json!(.message)` aborts with "EOF while parsing an
# object", and the retained log fills with line fragments instead of events.
#
# The pre-existing checks above CANNOT see this: they grep for substrings,
# and a pretty-printed object still contains exactly one `"RequestPath"` line.
# These assert the post-condition the consumer actually depends on — that each
# physical line is a COMPLETE, independently parseable event object.

LINE_TOTAL=$(wc -l < "$TMP_DIR/processed.log")
if [ "$LINE_TOTAL" -ne 3 ]; then
    echo "FAIL: expected 3 physical lines (NDJSON, one event per line), got $LINE_TOTAL"
    echo "      first 5 lines of processed.log:"
    head -5 "$TMP_DIR/processed.log" | sed 's/^/        /'
    rm -rf "$TMP_DIR"
    exit 1
fi
echo "PASS: processed log is one physical line per event ($LINE_TOTAL)"

# Every individual line must parse standalone as a JSON *object* and carry a
# pseudonymised ClientHost — this is exactly what Vector's parse_json does.
LINE_NO=0
while IFS= read -r pline; do
    LINE_NO=$((LINE_NO + 1))
    if ! printf '%s' "$pline" | jq -e 'type == "object"' >/dev/null 2>&1; then
        echo "FAIL: processed log line $LINE_NO is not a complete JSON object"
        echo "      line $LINE_NO: $pline"
        rm -rf "$TMP_DIR"
        exit 1
    fi
    CH=$(printf '%s' "$pline" | jq -r '.ClientHost // empty' 2>/dev/null || echo "")
    if [ -z "$CH" ]; then
        echo "FAIL: processed log line $LINE_NO has no ClientHost"
        echo "      line $LINE_NO: $pline"
        rm -rf "$TMP_DIR"
        exit 1
    fi
    # Pseudonymised, not a dotted-quad IPv4 literal
    if printf '%s' "$CH" | grep -qE '^[0-9]{1,3}(\.[0-9]{1,3}){3}$'; then
        echo "FAIL: processed log line $LINE_NO has an un-pseudonymised ClientHost: $CH"
        rm -rf "$TMP_DIR"
        exit 1
    fi
done < "$TMP_DIR/processed.log"
echo "PASS: every line parses standalone as an object with a pseudonymised ClientHost ($LINE_NO lines)"

rm -rf "$TMP_DIR"
